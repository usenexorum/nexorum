// CLI behavior tests in child processes: exit codes, printed text, init/doctor with fake client binaries on a temp
// PATH, every dream outcome with a mocked LLM, import edge cases. Nothing outside the temp folder is touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmp, baseEnv, runCli, suite, page, fakeBin, shellEnv } from "./harness.js";
import { Store } from "../src/store.js";
import { claudeDesktopConfigPath } from "../src/init.js";
import { VERSION } from "../src/version.js";

const tmp = makeTmp("nexorum-cli-");
const ENV = baseEnv(tmp);
const NX = ENV.NEXORUM_HOME;
const S = (space) => new Store(NX, space);
const cli = (args, opts) => runCli(ENV, args, opts);
const { t, done } = suite("cli-behaviors");
const KEY = { NEXORUM_LLM_API_KEY: "mock-key-not-real", MOCK_LLM: "1" };
const logEvents = (space, id, text) => cli(["log", "--space", space, "--id", id, "-"], { input: JSON.stringify([{ role: "user", content: text }, { role: "assistant", content: "ok" }]) });
const mkdir = (...p) => {
  const d = path.join(tmp, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// ================================================================================================ general CLI
await t("cli: help/-v, --home hoisting, extra arguments, number bounds, error prefix and exit codes", () => {
  assert.equal(cli(["help"]).code, 0);
  assert.equal(cli(["-v"]).out.trim(), VERSION);
  const H = mkdir("hoist-home", ".claude");
  assert.match(cli(["--home", path.dirname(H), "init", "--dry-run"]).out, /^Dry run: nothing will be changed\.\nClaude Code:/);
  assert.equal(cli(["history", "a", "b"]).code, 2);
  assert.match(cli(["history", "a", "b"]).err, /^nexorum: Too many arguments for history\.\n$/);
  assert.equal(cli(["context", "--max-chars", "99"]).code, 2);
  assert.equal(cli(["context", "--max-chars", "100001"]).code, 2);
  assert.match(cli(["recall", "x", "--limit", "abc"]).err, /^nexorum: --limit must be a whole number\n$/);
  const s = S("corrupt");
  s.writeDoc("/a.md", "a");
  fs.writeFileSync(s.stateFile, "{oops");
  const r = cli(["recall", "--space", "corrupt", "anything"]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `nexorum: ${s.stateFile} is not valid JSON.\n`);
  const bad = S("notdir");
  fs.mkdirSync(bad.dir, { recursive: true });
  fs.writeFileSync(bad.transcriptsDir, "a file where a folder belongs");
  const g = cli(["status", "--space", "notdir"]);
  assert.equal(g.code, 1);
  assert.match(g.err, /^nexorum: ENOTDIR/);
  assert.match(cli(["status", "--space", "notdir"], { extraEnv: { NEXORUM_DEBUG: "1" } }).err, /\n\s+at /, "stack only with NEXORUM_DEBUG=1");
});

await t("cli: remember near-duplicate hint points at the MCP tools (there is no forget command)", () => {
  cli(["remember", "--space", "hint", "alpha beta gamma delta epsilon"]);
  const r = cli(["remember", "--space", "hint", "alpha beta gamma delta epsilon zeta"]);
  assert.match(r.out, /^Saved note note_\S+\.\nNote: very similar to note_\S+ \("alpha beta gamma delta epsilon"\)\. If it replaces it, remove the old one with the MCP forget tool \(or update_note\)\.\n$/);
  assert.equal(cli(["forget", "x"]).code, 2);
});

await t("cli: log accepts {events, source} or a bare array; --source wins; ts and name kept", () => {
  const f = path.join(tmp, "obj.json");
  fs.writeFileSync(f, JSON.stringify({ source: "from-file", events: [{ role: "tool", name: "Bash", content: "ls", ts: "2026-11-01T00:00:00Z" }] }));
  cli(["log", "--space", "logx", "--file", f, "--id", "a1"]);
  assert.deepEqual(S("logx").getTranscript("a1").events, [{ role: "tool", content: "ls", name: "Bash", ts: "2026-11-01T00:00:00Z" }]);
  assert.equal(S("logx").getTranscript("a1").source, "from-file");
  cli(["log", "--space", "logx", "--file", f, "--id", "a2", "--source", "override"]);
  assert.equal(S("logx").getTranscript("a2").source, "override");
  assert.equal(cli(["log", "--space", "logx", "-"], { input: JSON.stringify({ events: [] }) }).code, 2);
});

await t("cli hooks: no sub-command and debug output never fail a session; empty memory prints nothing", () => {
  const none = cli(["hook"]);
  assert.equal(none.code, 0);
  assert.equal(none.err, "nexorum: Usage: nexorum hook session-start|user-prompt|stop\n");
  const missing = JSON.stringify({ session_id: "s", transcript_path: path.join(tmp, "nope.jsonl"), cwd: tmp });
  assert.equal(cli(["hook", "stop"], { input: missing }).err, "");
  const dbg = cli(["hook", "stop"], { input: missing, extraEnv: { NEXORUM_DEBUG: "1" } });
  assert.equal(dbg.code, 0);
  assert.match(dbg.err, /^nexorum hook stop: Error: ENOENT/);
  const ss = cli(["hook", "session-start", "--space", "nothing-yet"], { input: "{}" });
  assert.deepEqual([ss.code, ss.out], [0, ""]);
});

await t("cli apply: runs retention afterwards and reports it", () => {
  const s = S("applyret");
  s.saveTranscript({ id: "ancient", source: "cli", events: [{ role: "user", content: "x" }], status: "dreamed", created_at: "x", updated_at: "x", dreamed_at: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  s.writeBase("dream-r", {});
  s.writeProposalWiki("dream-r", { "/n.md": page("n", "N.", "x") });
  s.writeProposal({ id: "dream-r", status: "review", created_at: new Date().toISOString(), transcripts: [] });
  const r = cli(["apply", "--space", "applyret"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "Applied 1 path(s) from dream-r.\n  wrote /n.md\nRetention: removed 1 old transcript(s).\n");
});

// ================================================================================================ dream outcomes (mocked LLM)
await t("dream: organizer failure after analyzers wrote = PARTIAL proposal, exit 1, --apply not honoured", () => {
  logEvents("partial", "p1", "we deploy with make ship");
  const r = cli(["dream", "--space", "partial", "--yes", "--apply"], { mock: true, extraEnv: { ...KEY, MOCK_LLM_MODE: "organizer-fail" } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /\* \[organizer\] Organizer did not finish\./);
  assert.match(r.out, /Proposal dream-\S+ \(review, PARTIAL\): 1 added, 0 modified, 0 removed\n  added    \/p1\.md\n/);
  assert.match(r.out, /WARNING: the dream did not finish cleanly \(status failed: Organizer failed: Anthropic API error 400 \(invalid_request_error\): mock bad request\)\. Review the diff carefully/);
  assert.match(r.out, /--apply was not honoured because the run was partial\.\nNext steps:/);
  assert.equal(S("partial").wikiCount(), 0);
  assert.match(cli(["proposals", "--space", "partial"]).out, /^dream-\S+  review   PARTIAL  \S+  1 change\(s\)\n$/);
  assert.equal(S("partial").getTranscript("p1").status, "pending");
});

await t("dream: a clean run with no changes marks inputs dreamed (proposal applied, no_changes) and runs retention", () => {
  logEvents("quiet", "q1", "hello there");
  S("quiet").saveTranscript({ id: "old", source: "cli", events: [{ role: "user", content: "o" }], status: "dreamed", created_at: "x", updated_at: "x", dreamed_at: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  const r = cli(["dream", "--space", "quiet", "--yes"], { mock: true, extraEnv: { ...KEY, MOCK_LLM_MODE: "quiet" } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /The dream made no changes to the wiki; inputs are marked as dreamed\.\n$/);
  const s = S("quiet");
  assert.equal(s.getTranscript("q1").status, "dreamed");
  assert.equal(s.getTranscript("old"), null, "retention ran after the dream");
  const [p] = s.listProposals();
  assert.deepEqual([p.status, p.no_changes, p.partial], ["applied", true, false]);
});

await t("dream: a run that fails and writes nothing leaves no proposal, keeps inputs pending, exit 1", () => {
  logEvents("broken", "b1", "anything");
  const r = cli(["dream", "--space", "broken", "--yes"], { mock: true, extraEnv: { ...KEY, MOCK_LLM_MODE: "fail" } });
  assert.equal(r.code, 1);
  assert.match(r.out, /! error: Analyzer b1 failed: Anthropic API error 400 \(invalid_request_error\): mock bad request/);
  assert.match(r.out, /The dream ended with status "failed" and wrote nothing: All 1 analyzer\(s\) failed\. First error: Anthropic API error 400 \(invalid_request_error\): mock bad request\. Inputs stay pending\.\n$/);
  const s = S("broken");
  assert.deepEqual(s.listProposals(), []);
  assert.deepEqual(fs.existsSync(s.proposalsDir) ? fs.readdirSync(s.proposalsDir) : [], []);
  assert.equal(s.getTranscript("b1").status, "pending");
});

await t("dream: secrets written by the agents are redacted and counted", () => {
  logEvents("secret", "s1", "the token is in the vault");
  const r = cli(["dream", "--space", "secret", "--yes"], { mock: true, extraEnv: { ...KEY, MOCK_LLM_MODE: "secret" } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /\n  \(1 secret-like value\(s\) were redacted from the written documents\)\n/);
  const s = S("secret");
  const [p] = s.listProposals();
  assert.equal(p.redactions, 1);
  assert.match(s.readProposalWiki(p.id)["/s1.md"], /Deploy token: \[REDACTED:github_token\]/);
});

await t("dream --if-due: runs when due, then the cooldown holds the next one back", () => {
  logEvents("due", "d1", "first session");
  const r = cli(["dream", "--space", "due", "--if-due", "--min-pending", "1", "--idle-minutes", "0", "--cooldown-hours", "0", "--yes"], { mock: true, extraEnv: KEY });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Proposal dream-\S+ \(review\)/);
  assert.match(cli(["dream", "--space", "due", "--if-due", "--min-pending", "1", "--idle-minutes", "0"]).out, /^not due: last dream was 0\.0 hour\(s\) ago, cooldown is 6 hour\(s\)\n$/);
});

// ================================================================================================ import omp
await t("import omp: root and direct subfolders only, header-less and empty sessions skipped, NEXORUM_SPACE, unsafe ids hashed", () => {
  const dir = mkdir("omp2");
  mkdir("omp2", "sub", "deeper");
  const msg = (text) => JSON.stringify({ type: "message", message: { role: "user", content: text } });
  const sess = (id) => JSON.stringify({ type: "session", id, cwd: path.join(tmp, "anywhere"), timestamp: "2026-11-10T00:00:00Z" });
  fs.writeFileSync(path.join(dir, "a.jsonl"), [sess("a"), msg("from root")].join("\n"));
  fs.writeFileSync(path.join(dir, "sub", "b.jsonl"), [sess("b"), msg("from sub")].join("\n"));
  fs.writeFileSync(path.join(dir, "sub", "deeper", "c.jsonl"), [sess("c"), msg("too deep")].join("\n"));
  fs.writeFileSync(path.join(dir, "headerless.jsonl"), msg("no header"));
  fs.writeFileSync(path.join(dir, "empty.jsonl"), sess("e"));
  fs.writeFileSync(path.join(dir, "unsafe.jsonl"), [sess("id with spaces/x"), msg("odd id")].join("\n"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
  const r = cli(["import", "omp", "--dir", dir, "--all"], { extraEnv: { NEXORUM_SPACE: "envspace" } });
  assert.match(r.out, /Done: 3 imported, 0 unchanged, 2 skipped\. Spaces: envspace\.\nNext: nexorum dream/);
  const ids = S("envspace").listTranscripts().map((x) => x.id).sort();
  assert.deepEqual(ids.filter((i) => !i.startsWith("omp_") || i.length < 30), ["omp_a", "omp_b"]);
  assert.ok(ids.some((i) => /^omp_[0-9a-f]{32}$/.test(i)));
  const viaEnvDir = cli(["import", "omp", "--all"], { extraEnv: { NEXORUM_SPACE: "envspace", OMP_SESSIONS_DIR: dir } });
  assert.match(viaEnvDir.out, /Done: 0 imported, 3 unchanged, 2 skipped/);
  assert.match(cli(["import", "omp", "--since", "soon"]).err, /--since must be an ISO date, for example 2026-11-01\./);
  assert.match(cli(["import", "omp", "--session", path.join(tmp, "none.jsonl")]).err, /No such file: /);
});

// ================================================================================================ init
await t("init --all on an empty home: dry run lists every client and writes nothing; real run creates files without backups", () => {
  const H = mkdir("init-empty");
  const P = mkdir("init-empty-project");
  const dry = cli(["init", "--all", "--dry-run", "--home", H, "--dir", P]);
  assert.equal(dry.code, 0);
  for (const re of [
    /Claude Code:\n  would add SessionStart and Stop hook\(s\) to .*settings\.json \(new file\)/,
    /Codex:\n  `codex` was not found on PATH/,
    new RegExp(`  would create ${P.replace(/\\/g, "\\\\")}[\\\\/]AGENTS\\.md\n`),
    /Hermes:\n  would add the nexorum MCP server to .*config\.yaml \(new file\)/,
    /Cursor:\n  would add the nexorum MCP server to .*mcp\.json \(new file\)/,
    /Claude Desktop:\n  would add the nexorum MCP server to .*claude_desktop_config\.json \(new file\)/,
  ]) assert.match(dry.out, re);
  assert.doesNotMatch(dry.out, /Done\./);
  assert.deepEqual(fs.readdirSync(H), []);
  assert.deepEqual(fs.readdirSync(P), []);
  const r = cli(["init", "--all", "--home", H, "--dir", P]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /backed up|backup:/);
  assert.match(r.out, /  added SessionStart and Stop hook\(s\) to /);
  assert.match(r.out, /  created .*AGENTS\.md\n  Why: Codex has no session hooks/);
  assert.ok(fs.existsSync(path.join(H, ".claude", "settings.json")));
  assert.ok(fs.existsSync(path.join(H, ".cursor", "mcp.json")));
  assert.ok(fs.existsSync(claudeDesktopConfigPath(H)));
  assert.equal(fs.existsSync(path.join(P, "AGENTS.md.nexorum-bak")), false);
  assert.equal(cli(["init", "--all", "--home", H, "--dir", P]).out.includes("added"), false, "second run changes nothing");
});

await t("init AGENTS.md: block updated in place with a one-time backup; empty file gets the block without backup; home refused case-insensitively", () => {
  const H = mkdir("init-agents-home");
  const P = mkdir("init-agents");
  const file = path.join(P, "AGENTS.md");
  const original = "# Top\n\n<!-- nexorum:begin old -->\nold rules\n<!-- nexorum:end -->\n\n# Bottom\n";
  fs.writeFileSync(file, original);
  const r = cli(["init", "--codex", "--home", H, "--dir", P]);
  assert.match(r.out, new RegExp(`  updated the Nexorum block in .*AGENTS\\.md \\(backup: .*AGENTS\\.md\\.nexorum-bak\\)`));
  assert.match(fs.readFileSync(file, "utf8"), /^# Top\n\n<!-- nexorum:begin \(managed by `nexorum init`[\s\S]*<!-- nexorum:end -->\n\n# Bottom\n$/);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## Project memory", "## Changed by hand"));
  const again = cli(["init", "--codex", "--home", H, "--dir", P]);
  assert.match(again.out, /  updated the Nexorum block in .*AGENTS\.md\n/);
  assert.equal(fs.readFileSync(`${file}.nexorum-bak`, "utf8"), original, "an existing backup is never overwritten");
  const E = mkdir("init-agents-empty");
  fs.writeFileSync(path.join(E, "AGENTS.md"), "");
  assert.match(cli(["init", "--codex", "--home", H, "--dir", E]).out, /  added the Nexorum block to .*AGENTS\.md\n/);
  assert.equal(fs.existsSync(path.join(E, "AGENTS.md.nexorum-bak")), false);
  if (process.platform === "win32") {
    assert.match(cli(["init", "--codex", "--home", H, "--dir", H.toUpperCase()]).out, /AGENTS\.md not written: this is your home folder/);
  }
});

await t("init refuses broken configs: hooks not an object, settings not an object, mcpServers not an object; empty settings is {}", () => {
  const H = mkdir("init-bad");
  const settings = path.join(mkdir("init-bad", ".claude"), "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ hooks: [] }));
  const a = cli(["init", "--claude-code", "--home", H]);
  assert.equal(a.code, 1);
  assert.equal(a.err, 'nexorum: settings.json has a "hooks" value that is not an object; fix it by hand and run init again.\n');
  fs.writeFileSync(settings, "[]");
  assert.match(cli(["init", "--claude-code", "--home", H]).err, /settings\.json is not a JSON object; refusing to touch it\./);
  fs.writeFileSync(settings, "");
  const e = cli(["init", "--claude-code", "--home", H]);
  assert.equal(e.code, 0);
  assert.match(e.out, /backed up .*settings\.json -> .*settings\.json\.nexorum-bak/);
  assert.equal(fs.readFileSync(`${settings}.nexorum-bak`, "utf8"), "");
  fs.mkdirSync(path.join(H, ".cursor"));
  fs.writeFileSync(path.join(H, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: [] }));
  const c = cli(["init", "--cursor", "--home", H]);
  assert.equal(c.code, 1);
  assert.match(c.err, /The config has an "mcpServers" value that is not an object/);
});

const BIN = mkdir("fakebin");
const CLAUDE_LOG = path.join(tmp, "claude-args.log");
fakeBin(BIN, "claude", {
  win: [`echo %* >> "${CLAUDE_LOG}"`, `if "%1 %2"=="mcp list" echo nexorum: npx -y nexorum mcp - Connected`, "exit /b 0"],
  sh: [`echo "$@" >> "${CLAUDE_LOG}"`, `[ "$1 $2" = "mcp list" ] && echo "nexorum: npx -y nexorum mcp - Connected"`, "exit 0"],
});
fakeBin(BIN, "codex", { win: ["echo already exists 1>&2", "exit /b 1"], sh: ["echo already exists >&2", "exit 1"] });
fakeBin(BIN, "hermes", { win: ["exit /b 0"], sh: ["exit 0"] });
fakeBin(BIN, "nexorum", { win: ["exit /b 0"], sh: ["exit 0"] });
const WITH_BINS = shellEnv(BIN);

await t("init with client binaries on PATH: runs `mcp add`, reports failures, dry run says would run, prompt hook installed", () => {
  const H = mkdir("init-bins");
  const P = mkdir("init-bins-project");
  const dry = cli(["init", "--claude-code", "--dry-run", "--home", H], { extraEnv: WITH_BINS });
  assert.match(dry.out, /  would run: claude mcp add nexorum -- npx -y nexorum mcp\n/);
  assert.equal(fs.existsSync(CLAUDE_LOG), false, "a dry run starts no process");
  const r = cli(["init", "--all", "--prompt-recall", "--home", H, "--dir", P], { extraEnv: WITH_BINS });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /  added SessionStart and Stop and UserPromptSubmit hook\(s\) to /);
  assert.match(r.out, /  ran: claude mcp add nexorum -- npx -y nexorum mcp\n/);
  assert.match(r.out, /  `codex mcp add nexorum -- npx -y nexorum mcp` did not succeed \(already exists\)\. If nexorum is already registered this is fine; otherwise run it yourself\.\n/);
  assert.match(r.out, /Hermes:\n  added the nexorum MCP server to .*config\.yaml\n  Check it with: hermes mcp test nexorum/);
  assert.match(fs.readFileSync(CLAUDE_LOG, "utf8"), /^mcp add nexorum -- npx -y nexorum mcp\s*$/);
  const s = JSON.parse(fs.readFileSync(path.join(H, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: "nexorum hook user-prompt" }] }]);
  const only = mkdir("only-codex-bin");
  fakeBin(only, "codex", { win: ["exit /b 0"], sh: ["exit 0"] });
  const detected = cli(["init", "--dry-run", "--home", mkdir("init-detect"), "--dir", P], { extraEnv: shellEnv(only) });
  assert.match(detected.out, /^Dry run: nothing will be changed\.\nCodex:\n  would run: codex mcp add nexorum -- npx -y nexorum mcp\n/);
  assert.doesNotMatch(detected.out, /Claude Code:|Cursor:|Hermes:/);
});

// ================================================================================================ doctor
await t("doctor: hooks and MCP registration found, a failing `mcp list` warns; missing/invalid settings warn", () => {
  const H = path.join(tmp, "init-bins");
  const r = cli(["doctor", "--space", "doc"], { extraEnv: { ...WITH_BINS, HOME: H, USERPROFILE: H } });
  assert.match(r.out, /PASS  claude hooks: SessionStart and Stop hooks call `nexorum hook`\n/);
  assert.match(r.out, /PASS  mcp \(claude\): nexorum is registered in claude\n/);
  assert.match(r.out, /WARN  mcp \(codex\): `codex mcp list` failed \(exit 1\)\n      hint: Register it: codex mcp add nexorum -- npx -y nexorum mcp \(or run: nexorum init\)\n/);
  assert.equal(r.code, 0);
  const H2 = mkdir("doc-home");
  const settings = path.join(mkdir("doc-home", ".claude"), "settings.json");
  const doc = () => cli(["doctor", "--space", "doc"], { extraEnv: { HOME: H2, USERPROFILE: H2 } }).out;
  assert.match(doc(), /WARN  claude hooks: .*settings\.json does not exist\n      hint: Run: nexorum init --claude-code/);
  fs.writeFileSync(settings, "{bad");
  assert.match(doc(), /WARN  claude hooks: .*settings\.json is not valid JSON\n      hint: Fix the JSON by hand, then run: nexorum init --claude-code/);
  fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "npx -y nexorum hook session-start" }] }] } }));
  assert.match(doc(), /WARN  claude hooks: missing Stop hook\(s\) in /);
});

await t("doctor: home that is a file fails, a home not yet created passes, many bad files summarised, openai config, review hint", () => {
  const f = path.join(tmp, "home-is-a-file");
  fs.writeFileSync(f, "x");
  const bad = cli(["doctor", "--space", "x"], { extraEnv: { NEXORUM_HOME: f } });
  assert.equal(bad.code, 1);
  assert.match(bad.out, new RegExp(`FAIL  home: ${f.replace(/\\/g, "\\\\")} is not a writable directory\n      hint: Set NEXORUM_HOME to a writable folder`));
  const fresh = path.join(tmp, "not", "yet");
  const nf = cli(["doctor", "--space", "x"], { extraEnv: { NEXORUM_HOME: fresh } });
  assert.match(nf.out, /PASS  home: .* does not exist yet but can be created\n      hint: It is created on first use\.\n/);
  assert.equal(fs.existsSync(fresh), false, "doctor never writes");
  const s = S("manybad");
  fs.mkdirSync(s.transcriptsDir, { recursive: true });
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(s.transcriptsDir, `b${i}.json`), i % 2 ? "{" : JSON.stringify({ id: 5 }));
  fs.mkdirSync(path.join(s.proposalsDir, "dream-x"), { recursive: true });
  fs.writeFileSync(path.join(s.proposalsDir, "dream-x", "proposal.json"), "[]");
  assert.match(cli(["doctor", "--space", "manybad"]).out, /FAIL  space files: 8 unreadable of 8 in space "manybad": .*, and 3 more\n/);
  const oai = cli(["doctor", "--space", "x"], { extraEnv: { NEXORUM_LLM_PROVIDER: "openai" } }).out;
  assert.match(oai, /WARN  llm config: provider openai; api key missing; base URL default http:\/\/localhost:20128\/v1; analyzer model missing; organizer model missing\n      hint: Set NEXORUM_LLM_API_KEY \(or OPENAI_API_KEY\)\. Set NEXORUM_ANALYZER_MODEL\. Set NEXORUM_ORGANIZER_MODEL\. Needed only for `nexorum dream`\./);
  const ok = cli(["doctor", "--space", "x"], { extraEnv: { NEXORUM_LLM_API_KEY: "k", NEXORUM_LLM_BASE_URL: "http://x" } }).out;
  assert.match(ok, /PASS  llm config: provider anthropic; api key set; base URL set; analyzer model claude-haiku-5-5 \(default\); organizer model claude-haiku-5-5 \(default\)\n      hint: Not tested against the network\./);
  assert.match(cli(["doctor", "--space", "partial"]).out, /PASS  pending work: 1 pending transcript\(s\), 1 proposal\(s\) awaiting review\n      hint: Run: nexorum proposals, then nexorum diff \/ apply \/ reject\./);
});

await t("cli: a closed output pipe (| head) ends quietly instead of crashing with EPIPE", async () => {
  const { spawn } = await import("node:child_process");
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "bin", "nexorum.js");
  const env = { ...baseEnv(tmp), NEXORUM_HOME: path.join(tmp, "epipe-home") };
  const child = spawn(process.execPath, [bin, "init", "--all", "--dry-run", "--home", path.join(tmp, "epipe-fh")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  child.stdout.once("data", () => child.stdout.destroy()); // the reader goes away after the first chunk
  const code = await new Promise((r) => child.on("close", r));
  assert.doesNotMatch(err, /EPIPE|Unhandled/);
  assert.equal(code, 0);
});

done(() => fs.rmSync(tmp, { recursive: true, force: true }));
