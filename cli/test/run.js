// End-to-end tests. Everything runs in a fresh temp folder: NEXORUM_HOME, HOME/USERPROFILE and every --home point
// there, PATH is empty (so no real `claude`/`codex` is found or run), and the LLM is a mocked fetch. Nothing touches
// the real ~/.nexorum, ~/.claude, ~/.codex or ~/.cursor, and nothing reaches the network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, intFlag, UsageError } from "../src/args.js";
import { Store } from "../src/store.js";
import { callTool, TOOLS } from "../src/mcp.js";
import { USAGE } from "../src/cli.js";
import { claudeDesktopConfigPath } from "../src/init.js";
import { scrubSecrets, buildCorpus, searchCorpus, stem, tokenize, MemoryWiki, runDream, createToolbox, estimateDream, splitText, renderTranscript } from "../src/core/index.js";
import { makeMockFetch } from "./mock-llm.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin", "nexorum.js");
const MOCK = pathToFileURL(path.join(ROOT, "test", "mock-llm.mjs")).href;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexorum-test-")));
const HOME = path.join(tmp, "home");
const NHOME = path.join(tmp, "nx");
fs.mkdirSync(HOME, { recursive: true });
const BASE_ENV = Object.fromEntries(
  Object.entries({ NEXORUM_HOME: NHOME, HOME, USERPROFILE: HOME, PATH: "", SystemRoot: process.env.SystemRoot, TEMP: tmp, TMP: tmp }).filter(([, v]) => v !== undefined),
);

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${String(e?.stack ?? e).split("\n").slice(0, 6).join("\n     ")}`);
  }
}

/** Runs the real CLI in a child process. */
function cli(args, { input, env = {}, cwd = tmp, mock = false } = {}) {
  const r = spawnSync(process.execPath, [...(mock ? ["--import", MOCK] : []), BIN, ...args], {
    cwd,
    input: input ?? "",
    encoding: "utf8",
    env: { ...BASE_ENV, ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const store = (space) => new Store(NHOME, space);
const page = (name, desc, body) => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;
const jsonFile = (name, value) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, typeof value === "string" ? value : JSON.stringify(value));
  return f;
};
const text = (r) => r.content[0].text;

// ------------------------------------------------------------------------------------------------ basics
await t("args: --flag=value, --flag value, alias, --, bare -, negative numbers, unknown options", () => {
  const spec = { bool: ["yes"], string: ["budget"], alias: { y: "yes" } };
  assert.deepEqual(parseArgs(["--budget=5", "-y", "a", "-", "-3", "--", "--x"], spec), { flags: { budget: "5", yes: true }, positionals: ["a", "-", "-3", "--x"] });
  assert.deepEqual(parseArgs(["--budget", "7"], spec).flags, { budget: "7" });
  assert.throws(() => parseArgs(["--nope"], spec), UsageError);
  assert.throws(() => parseArgs(["-z"], spec), /Unknown option -z/);
  assert.throws(() => parseArgs(["--yes=1"], spec), /does not take a value/);
  assert.throws(() => parseArgs(["--budget"], spec), /needs a value/);
  assert.equal(intFlag({ n: "12" }, "n", { max: 50 }), 12);
  assert.throws(() => intFlag({ n: "1.5" }, "n"), /whole number/);
  assert.throws(() => intFlag({ n: "0" }, "n", { min: 1, max: 200 }), /between 1 and 200/);
});

await t("help, version, no command (exit 2), unknown command (exit 2), usage lists every command", () => {
  const h = cli(["--help"]);
  assert.equal(h.code, 0);
  assert.equal(h.out.trim(), USAGE);
  for (const c of ["init", "mcp", "hook", "remember", "recall", "context", "status", "log", "import omp", "dream", "doctor", "proposals", "diff", "apply", "reject", "restore", "history", "retention"]) assert.ok(USAGE.includes(`  ${c}`), c);
  assert.equal(cli(["--version"]).out.trim(), "0.2.0");
  assert.equal(cli([]).code, 2);
  const u = cli(["frobnicate"]);
  assert.equal(u.code, 2);
  assert.match(u.err, /Unknown command "frobnicate"/);
  assert.equal(cli(["status", "--bogus"]).code, 2);
  assert.equal(cli(["recall", "x", "--help"]).code, 0);
});

await t("scrubber: every pattern, PEM blocks (also truncated), idempotent", () => {
  const raw = [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
    "sk-proj-abcdefghijklmnopqrstuvwx",
    "nxr_abcdefghijklmnopqrstuvwxyzABCDEF012345",
    "AKIAABCDEFGHIJKLMNOP",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "xoxb-1234567890-abcdef",
    "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabcdefghijkl\nabcdefghijklmnopqrstuv==\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n",
  ].join("\n");
  const r = scrubSecrets(raw);
  for (const kind of ["anthropic_key", "openai_key", "nexorum_key", "aws_access_key", "github_token", "npm_token", "slack_token", "google_api_key", "jwt", "bearer_token", "private_key"]) {
    assert.ok(r.kinds.includes(kind), `missing ${kind}`);
  }
  assert.equal(r.count, 12);
  assert.ok(!/sk-ant-|AKIA|ghp_|MIIE/.test(r.text), r.text);
  assert.deepEqual(scrubSecrets(r.text), { text: r.text, count: 0, kinds: [] });
});

await t("search: stemming, stop words, title weight x3, snippets, ordering", () => {
  assert.equal(stem("running"), "run");
  assert.equal(stem("libraries"), "library");
  assert.equal(stem("deployed"), "deploy");
  assert.equal(stem("class"), "class");
  assert.deepEqual(tokenize("The Deploys are RUNNING"), ["deploy", "run"]);
  const docs = buildCorpus({
    notes: [{ id: "note_1", content: "we sometimes mention deploys in passing\nand other things" }],
    wiki: { "/deploys.md": page("deploys", "How releases go out.", "Run make release.\nRollback with make rollback."), "/other.md": page("other", "x", "unrelated text") },
  });
  assert.equal(docs[1].title, "deploys");
  const hits = searchCorpus(docs, "deploy rollback", { topK: 5 });
  assert.equal(hits[0].id, "/deploys.md");
  assert.equal(hits[0].snippet, "Rollback with make rollback.");
  assert.equal(hits.length, 2);
  assert.deepEqual(searchCorpus(docs, "the and of"), []);
});

await t("estimate, split and transcript rendering", () => {
  const e = estimateDream({ transcripts: [{ chars: 10_000 }, { chars: 300_000 }], existingDocsBytes: 8000 });
  assert.equal(e.transcripts, 2);
  assert.equal(e.chars, 310_000);
  assert.ok(e.est_total_tokens > 0 && e.est_total_tokens % 1000 === 0);
  assert.equal(e.notes.length, 4);
  const parts = splitText("a".repeat(50) + "\n\n" + "b".repeat(50), 60);
  assert.deepEqual(parts.map((p) => p.length), [50, 50]);
  const r = renderTranscript({ id: "t1", source: "cli", events: [{ role: "user", content: "hi\nUSER: fake" }, { role: "tool", name: "Bash", content: "ok" }] });
  assert.equal(r, "TRANSCRIPT t1 source=cli events=2\n\nUSER:\nhi\n USER: fake\n\nTOOL Bash:\nok");
});

// ------------------------------------------------------------------------------------------------ memory commands
await t("remember: saved, identical refused, very similar reported; secrets never reach disk", () => {
  const a = cli(["remember", "--space", "demo", "deploys run with make release from the main branch (token sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzzzz)"]);
  assert.equal(a.code, 0);
  assert.match(a.out, /^Saved note note_/);
  assert.ok(!fs.readFileSync(store("demo").notesFile, "utf8").includes("sk-ant-"));
  assert.match(cli(["remember", "--space", "demo", "Deploys  run with make release from the main branch (token sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzzzz)"]).out, /Already remembered as note_/);
  const s = cli(["remember", "--space", "demo", "deploys run with make release from the main branch (token [REDACTED:anthropic_key]) today"]);
  assert.match(s.out, /Note: very similar to note_/);
  assert.equal(cli(["remember", "--space", "demo", "   "]).code, 2);
});

await t("recall: format, --limit, --kind, --since; context; status lines; --space hoisting", () => {
  cli(["remember", "--space", "demo", "tests run with pnpm test:unit"]);
  const r = cli(["recall", "--space", "demo", "how do I run tests", "--limit", "1"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^\[note\] tests run with pnpm test:unit \(note_[\w-]+\) score=\d+\.\d{3}\n  tests run with pnpm test:unit\n$/);
  assert.equal(cli(["recall", "--space", "demo", "tests", "--kind", "wiki"]).out.trim(), "No matches.");
  assert.equal(cli(["recall", "--space", "demo", "tests", "--kind", "page"]).code, 2);
  assert.equal(cli(["recall", "--space", "demo", "tests", "--since", "2999-01-01"]).out.trim(), "No matches.");
  assert.equal(cli(["recall", "--space", "demo"]).code, 2);
  assert.equal(cli(["recall", "--space", "demo", "x", "--limit", "51"]).code, 2);
  const c = cli(["context", "--space", "demo"]);
  assert.match(c.out, /^Recent notes:\n- tests run with pnpm test:unit\n/);
  assert.equal(cli(["context", "--space", "empty"]).err, "Memory is empty for this space.\n");
  const st = cli(["--space", "demo", "status"]);
  assert.equal(st.code, 0);
  assert.deepEqual(st.out.trim().split("\n"), [
    `Home:        ${NHOME}`,
    "Space:       demo",
    "Notes:       3",
    "Wiki docs:   0",
    "Transcripts: 0 pending, 0 dreamed",
    "Proposals:   0 awaiting review, 0 total",
  ]);
});

await t("log: --file, stdin (-), --source/--id, unchanged on resend, invalid input exits 2", () => {
  const f = jsonFile("session.json", { source: "my-agent", events: [{ role: "user", content: "we deploy with make ship" }, { role: "assistant", content: "noted" }] });
  assert.equal(cli(["log", "--space", "logs", "--file", f, "--id", "session-42"]).out.trim(), "Logged transcript session-42 (2 events, status pending).");
  assert.equal(cli(["log", "--space", "logs", "--file", f, "--id", "session-42"]).out.trim(), "Transcript session-42 unchanged.");
  assert.equal(store("logs").getTranscript("session-42").source, "my-agent");
  const s = cli(["log", "--space", "logs", "-", "--source", "stdin-agent"], { input: JSON.stringify([{ role: "user", content: "hello there" }]) });
  assert.match(s.out, /^Logged transcript trn_[\w-]+ \(1 events, status pending\)\.\n$/);
  assert.equal(cli(["log", "--space", "logs", "-"], { input: "{nope" }).code, 2);
  assert.equal(cli(["log", "--space", "logs", "-"], { input: JSON.stringify([{ role: "robot", content: "x" }]) }).code, 2);
  assert.equal(cli(["log", "--space", "logs", "--file", path.join(tmp, "missing.json")]).code, 2);
  assert.equal(cli(["log", "--space", "logs", "--file", f, "--id", "../x"]).code, 2);
});

await t("import omp: by cwd, --all into each session's space, --session, idempotent, --since", () => {
  const dir = path.join(tmp, "omp");
  const projA = path.join(tmp, "projA");
  fs.mkdirSync(path.join(dir, "--projA--"), { recursive: true });
  fs.mkdirSync(projA, { recursive: true });
  const lines = [
    { type: "session", id: "s-1", cwd: projA, timestamp: "2026-11-10T10:00:00Z" },
    { type: "title", title: "Fix login" },
    { type: "message", timestamp: "2026-11-10T10:00:01Z", message: { role: "user", content: [{ type: "text", text: "why does login fail?" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Checking." }, { type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "c1", content: "x".repeat(5000) } },
  ];
  const file = path.join(dir, "--projA--", "s-1.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.match(cli(["import", "omp", "--dir", dir]).out, /No omp sessions matched/);
  const r = cli(["import", "omp", "--dir", dir], { cwd: projA });
  assert.match(r.out, /imported omp_s-1 \(4 events\) into space "projA": Fix login/);
  const t1 = store("projA").getTranscript("omp_s-1");
  assert.equal(t1.events[2].name, "bash");
  assert.match(t1.events[3].content, /clipped 1008 more characters/);
  assert.match(cli(["import", "omp", "--dir", dir, "--all"]).out, /Done: 0 imported, 1 unchanged, 0 skipped\. Spaces: projA\./);
  assert.match(cli(["import", "omp", "--session", file, "--space", "other"]).out, /into space "other"/);
  assert.match(cli(["import", "omp", "--dir", dir, "--all", "--since", "2026-12-01"]).out, /Done: 0 imported, 0 unchanged, 0 skipped/);
  assert.equal(cli(["import", "codex"]).code, 2);
  assert.equal(cli(["import", "omp", "--dir", path.join(tmp, "nope")]).code, 2);
});

// ------------------------------------------------------------------------------------------------ dream (CLI)
const KEY_ENV = { NEXORUM_LLM_API_KEY: "mock-key-not-real" };
await t("dream: refusals and checks before anything is sent (exit codes 0/2)", () => {
  cli(["remember", "--space", "dreamy", "the staging host is stage.example.internal"]);
  for (const id of ["t1", "t2"]) {
    cli(["log", "--space", "dreamy", "--id", id, "-"], { input: JSON.stringify([{ role: "user", content: `session ${id}: we use bun for tests` }, { role: "assistant", content: "ok" }]) });
  }
  const dry = cli(["dream", "--space", "dreamy", "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /Space: dreamy\nPending transcripts: 2\nUnconsolidated notes: 1\nInput size: [\d,]+ characters\nRough estimate: ~[\d,]+ tokens \(budget 3,000,000\)\./);
  assert.match(dry.out, /Dry run: nothing was sent\.\n$/);
  const over = cli(["dream", "--space", "dreamy", "--budget", "1000"], { env: KEY_ENV });
  assert.equal(over.code, 2);
  assert.match(over.err, /is above the budget \(1,000\)\. Dream less: pass --since DATE/);
  const nokey = cli(["dream", "--space", "dreamy", "--yes"]);
  assert.equal(nokey.code, 2);
  assert.match(nokey.err, /No API key for provider "anthropic"\. Set NEXORUM_LLM_API_KEY \(or ANTHROPIC_API_KEY\)\./);
  assert.match(cli(["dream", "--space", "dreamy"], { env: KEY_ENV }).err, /Not a terminal: pass --yes/);
  assert.equal(cli(["dream", "--space", "dreamy", "--yes"], { env: { ...KEY_ENV, NEXORUM_LLM_PROVIDER: "gemini" } }).code, 2);
  assert.match(cli(["dream", "--space", "dreamy", "--yes"], { env: { ...KEY_ENV, NEXORUM_LLM_PROVIDER: "openai" } }).err, /needs models: set NEXORUM_ANALYZER_MODEL/);
  assert.equal(cli(["dream", "--space", "dreamy", "--since", "2026-02-30"]).code, 2);
  assert.equal(cli(["dream", "--space", "dreamy", "--max-inputs", "201"]).code, 2);
  assert.match(cli(["dream", "--space", "dreamy", "--min-pending", "1"]).err, /--min-pending only applies together with --if-due/);
  assert.equal(cli(["dream", "--space", "dreamy", "--if-due"]).out.trim(), "not due: 2 pending transcript(s), need at least 3");
  assert.match(cli(["dream", "--space", "dreamy", "--if-due", "--min-pending", "1", "--idle-minutes", "60"]).out, /^not due: newest transcript changed 0 minute\(s\) ago, wait until it is 60 minute\(s\) idle/);
  assert.match(cli(["dream", "--space", "dreamy", "--if-due", "--min-pending", "1", "--idle-minutes", "0", "--dry-run"]).out, /Dry run: nothing was sent\./);
  assert.match(cli(["dream", "--space", "dreamy", "--dry-run", "--since", "2999-01-01"]).out, /Pending transcripts: 0/);
  assert.match(cli(["dream", "--space", "nothing-here", "--dry-run"]).out, /Nothing to dream about yet\./);
});

await t("dream with Anthropic (mocked): analyzers + organizer, proposal, proposals/diff/apply, inputs consumed", () => {
  const log = path.join(tmp, "anthropic.log");
  const r = cli(["dream", "--space", "dreamy", "--yes", "--instructions", "Focus on test commands"], { mock: true, env: { ...KEY_ENV, MOCK_LLM: "1", MOCK_LLM_LOG: log } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Dreaming \(proposal dream-\d{14}-[0-9a-f]{6}\) \.\.\./);
  assert.match(r.out, /\* Analyzing 3 input\(s\)\./);
  assert.match(r.out, /\* \[organizer\] Organizer finished\./);
  assert.match(r.out, /Tokens used: 13,200 \(input 12000, output 1200, cache read 0, cache write 0\)/);
  assert.match(r.out, /Proposal (dream-\S+) \(review\): 4 added, 0 modified, 0 removed/);
  assert.match(r.out, /  added    \/_index\.md\n  added    \/notes\.md\n  added    \/t1\.md\n  added    \/t2\.md/);
  assert.match(r.out, /Next steps:\n  nexorum diff dream-/);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 12);
  assert.ok(calls.every((c) => c.url === "https://api.anthropic.com/v1/messages" && c.model === "claude-haiku-5-5"));
  assert.equal(calls[0].headers["x-api-key"], "mock-key-not-real");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(calls.filter((c) => c.role === "organizer").length, 3);
  // live wiki untouched until apply
  assert.equal(store("dreamy").wikiCount(), 0);
  const list = cli(["proposals", "--space", "dreamy"]);
  assert.match(list.out, /^dream-\S+  review    \S+  4 change\(s\)\n$/);
  const d = cli(["diff", "--space", "dreamy"]);
  assert.match(d.out, /=== \/_index\.md \(added\)\n--- \/dev\/null\n\+\+\+ proposed\/_index\.md\n@@ -0,0 \+1,4 @@\n\+## Sessions\n\+- \[\[notes\]\] - notes from notes/);
  const a = cli(["apply", "--space", "dreamy"]);
  assert.equal(a.code, 0);
  assert.match(a.out, /^Applied 4 path\(s\) from dream-\S+\.\n  wrote \/_index\.md/);
  const st = cli(["status", "--space", "dreamy"]).out;
  assert.match(st, /Wiki docs:   4\nTranscripts: 0 pending, 2 dreamed\nProposals:   0 awaiting review, 1 total/);
  assert.equal(store("dreamy").readState().notes_consolidated_through !== null, true);
  assert.match(cli(["context", "--space", "dreamy"]).out, /^## Sessions\n- \[\[notes\]\]/);
  assert.match(cli(["apply", "--space", "dreamy"]).err, /was already applied/);
  assert.match(cli(["dream", "--space", "dreamy", "--dry-run"]).out, /Nothing to dream about yet/);
});

await t("dream with an OpenAI-compatible endpoint (mocked), --apply", () => {
  cli(["log", "--space", "oai", "--id", "o1", "-"], { input: JSON.stringify([{ role: "user", content: "the cache lives in redis" }]) });
  const log = path.join(tmp, "openai.log");
  const env = { ...KEY_ENV, MOCK_LLM: "1", MOCK_LLM_LOG: log, NEXORUM_LLM_PROVIDER: "openai", NEXORUM_LLM_BASE_URL: "http://mock.local/v1/", NEXORUM_ANALYZER_MODEL: "mock-analyzer", NEXORUM_ORGANIZER_MODEL: "mock-organizer" };
  const r = cli(["dream", "--space", "oai", "-y", "--apply"], { mock: true, env });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Applied: 2 path\(s\) written\./);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(calls.every((c) => c.url === "http://mock.local/v1/chat/completions"));
  assert.deepEqual([...new Set(calls.map((c) => `${c.role}:${c.model}`))], ["analyzer:mock-analyzer", "organizer:mock-organizer"]);
  assert.equal(calls[0].headers.authorization, "Bearer mock-key-not-real");
  assert.equal(store("oai").readDoc("/o1.md"), "---\nname: o1\ndescription: What session o1 established.\n---\nthe cache lives in redis\n");
  assert.equal(store("oai").getTranscript("o1").status, "dreamed");
});

// ------------------------------------------------------------------------------------------------ dream engine
const engineInputs = (n) => Array.from({ length: n }, (_, i) => ({ id: `in${i}`, source: "cli", text: renderTranscript({ id: `in${i}`, source: "cli", events: [{ role: "user", content: `fact number ${i}` }] }) }));
const anthropic = { provider: "anthropic", apiKey: "secret-test-key-123" };
const MODELS = { analyzer: "claude-haiku-5-5", organizer: "claude-haiku-5-5" };

await t("engine: one analyzer per input, 3 in parallel by default, then the organizer", async () => {
  const mock = makeMockFetch({ delayMs: 15 });
  const events = [];
  const docs = new MemoryWiki();
  const r = await runDream({ llm: anthropic, models: MODELS, docs, transcripts: engineInputs(5), budgetTokens: 1_000_000, fetch: mock.fetch, onEvent: (e) => events.push(e) });
  assert.equal(r.status, "completed", r.error);
  assert.equal(mock.stats.maxInFlight, 3);
  assert.equal(r.analyzed.length, 5);
  assert.ok(r.analyzed.every((a) => a.ok));
  assert.equal(r.organizer.ok, true);
  assert.deepEqual(r.organizer.changes, ["wrote /_index.md"]);
  assert.equal(r.usage.total_tokens, 18 * 1100);
  assert.deepEqual(Object.keys(docs.snapshot()), ["/_index.md", "/in0.md", "/in1.md", "/in2.md", "/in3.md", "/in4.md"]);
  for (const type of ["phase", "analyzer_started", "analyzer_done", "organizer_started", "organizer_done", "agent_text", "tool", "usage"]) assert.ok(events.some((e) => e.type === type), type);
  assert.ok(events.every((e) => typeof e.ts === "number" && typeof e.message === "string"));
});

await t("engine: shared budget checked before each call, 50/80/100% events, organizer skipped", async () => {
  const events = [];
  const r = await runDream({ llm: anthropic, models: MODELS, docs: new MemoryWiki(), transcripts: engineInputs(2), budgetTokens: 2000, fetch: makeMockFetch().fetch, onEvent: (e) => events.push(e) });
  assert.equal(r.status, "budget_exhausted");
  assert.equal(r.usage.total_tokens, 2200); // the two calls in flight finish, no third call starts
  assert.deepEqual(events.filter((e) => e.type === "budget" && e.pct).map((e) => e.pct), [50, 80, 100]);
  assert.match(r.organizer.error, /Skipped: token budget exhausted/);
  assert.ok(r.analyzed.every((a) => !a.ok && /budget/.test(a.error)));
  assert.match(r.summary, /stopped early because the token budget ran out/);
});

await t("engine: retries 529 with backoff; a 401 stops every agent and never leaks the key", async () => {
  const flaky = makeMockFetch({ failFirst: 2, failStatus: 529 });
  const ok = await runDream({ llm: anthropic, models: MODELS, docs: new MemoryWiki(), transcripts: engineInputs(1), budgetTokens: 1e6, fetch: flaky.fetch, retry: { baseMs: 1, maxMs: 2 } });
  assert.equal(ok.status, "completed", ok.error);
  assert.equal(flaky.stats.calls, 2 + 6);
  const bad = makeMockFetch({ failFirst: 1000, failStatus: 401 });
  const r = await runDream({ llm: anthropic, models: MODELS, docs: new MemoryWiki(), transcripts: engineInputs(4), budgetTokens: 1e6, fetch: bad.fetch, retry: { baseMs: 1 } });
  assert.equal(r.status, "failed");
  assert.match(r.error, /Anthropic API error 401 \(authentication_error\).*Check the API key\./);
  assert.ok(!JSON.stringify(r).includes("secret-test-key-123"));
  assert.ok(bad.stats.calls <= 3, `fatal error should stop the queue, got ${bad.stats.calls} calls`);
  const none = await runDream({ llm: { provider: "anthropic" }, models: MODELS, docs: new MemoryWiki(), transcripts: engineInputs(1), budgetTokens: 1 });
  assert.equal(none.status, "failed");
  assert.equal(none.error, "No Anthropic API key was provided.");
});

await t("engine: no-op dream when analyzers change nothing; a model that never submits fails cleanly", async () => {
  const quiet = async () => new Response(JSON.stringify({ content: [{ type: "tool_use", id: "s", name: "submit", input: { summary: "nothing worth keeping" } }], stop_reason: "tool_use", usage: { input_tokens: 5 } }), { status: 200 });
  const r = await runDream({ llm: anthropic, models: MODELS, docs: new MemoryWiki(), transcripts: engineInputs(1), budgetTokens: 1e6, fetch: quiet });
  assert.equal(r.status, "completed");
  assert.match(r.organizer.summary, /Nothing to organize/);
  const chatty = async () => new Response(JSON.stringify({ content: [{ type: "text", text: "done!" }], stop_reason: "end_turn", usage: {} }), { status: 200 });
  const f = await runDream({ llm: anthropic, models: MODELS, docs: new MemoryWiki(), transcripts: engineInputs(1), budgetTokens: 1e6, fetch: chatty });
  assert.equal(f.status, "failed");
  assert.match(f.error, /stopped without calling submit/);
});

await t("dream tools: read-before-write, conflicts, edit_doc, grep, delete/rename (organizer only), index limit", () => {
  const docs = new MemoryWiki({ "/a.md": page("a", "A.", "alpha line\nbeta line") });
  const stats = { mutations: 0, redactions: 0 };
  const an = createToolbox({ docs, role: "analyzer", scrub: scrubSecrets, stats });
  assert.deepEqual(an.definitions.map((d) => d.name), ["list_docs", "read_doc", "grep_docs", "write_doc", "edit_doc", "submit"]);
  assert.match(an.execute("write_doc", { path: "/a.md", content: "x" }).text, /have not read it completely/);
  assert.match(an.execute("read_doc", { path: "/a.md" }).text, /alpha line/);
  assert.match(an.execute("write_doc", { path: "/a.md", content: "new ghp_abcdefghijklmnopqrstuvwxyz0123456789" }).text, /^Updated \/a\.md .*\nNote: 1 secret-looking value/s);
  assert.equal(stats.redactions, 1);
  docs.write("/a.md", "changed by another agent");
  assert.match(an.execute("write_doc", { path: "/a.md", content: "mine" }).text, /^Conflict: \/a\.md changed/);
  assert.match(an.execute("edit_doc", { path: "/a.md", old_string: "another", new_string: "a second" }).text, /^Edited \/a\.md/);
  assert.match(an.execute("edit_doc", { path: "/a.md", old_string: "zzz", new_string: "" }).text, /was not found/);
  assert.equal(an.execute("grep_docs", { pattern: "SECOND" }).text, "/a.md:1: changed by a second agent");
  assert.match(an.execute("grep_docs", { pattern: "(a+)+" }).text, /nested quantifiers/);
  assert.match(an.execute("delete_doc", { path: "/a.md" }).text, /Unknown tool "delete_doc"/);
  assert.match(an.execute("read_doc", { path: "/../x" }).text, /Invalid path/);
  const org = createToolbox({ docs, role: "organizer", scrub: scrubSecrets, stats });
  assert.match(org.execute("submit", { summary: "s", changes: [] }).text, /\/_index\.md does not exist/);
  docs.write("/_index.md", "x".repeat(5000));
  assert.ok(org.execute("submit", { summary: "s", changes: [] }).isError);
  assert.ok(org.execute("submit", { summary: "s", changes: [] }).isError);
  assert.equal(org.execute("submit", { summary: "s", changes: [] }).text, "Submitted."); // refused twice at most
  assert.match(org.execute("rename_doc", { from: "/a.md", to: "/b.md" }).text, /^Renamed \/a\.md to \/b\.md/);
  assert.equal(org.execute("delete_doc", { path: "/b.md" }).text, "Deleted /b.md.");
});

// ------------------------------------------------------------------------------------------------ agent dream + review
let reviewFirst;
await t("agent dream over MCP tools: dream_prepare -> dream_submit -> proposal (no key)", () => {
  const s = store("review");
  callTool(s, "remember", { content: "releases deploy with make release from the main branch" });
  assert.match(text(callTool(s, "save_transcript", { id: "chat-1", source: "codex", events: [{ role: "user", content: "rollback uses make rollback" }] })), /^Stored transcript chat-1 \(1 events, pending\)/);
  const prep = text(callTool(s, "dream_prepare", {}));
  assert.match(prep, /Inputs: 1 transcript\(s\) and 1 note\(s\)/);
  assert.match(prep, /<current_wiki>\n\(the wiki is empty\)\n<\/current_wiki>/);
  const id = /Draft id: (\S+)/.exec(prep)[1];
  assert.equal(s.listProposals().length, 0, "a draft is not a proposal");
  const noIndex = callTool(s, "dream_submit", { id, documents: [{ path: "/deploys.md", content: "x" }] });
  assert.equal(noIndex.isError, true);
  assert.match(text(noIndex), /must exist after the dream/);
  const r = callTool(s, "dream_submit", {
    id,
    summary: "deploys and rollback",
    documents: [
      { path: "/_index.md", content: "## Ops\n- [[deploys]] - how releases are deployed and rolled back\n" },
      { path: "/deploys.md", content: page("deploys", "How releases are deployed.", "Releases deploy with make release from the main branch. Rollback: make rollback. See [[ghost]].") },
    ],
  });
  assert.match(text(r), /^Proposal dream-\S+ is ready for review \(2 change\(s\)\):\n  added    \/_index\.md\n  added    \/deploys\.md/);
  assert.match(text(r), /nexorum --space review apply dream-/);
  assert.match(text(r), /\/deploys\.md links to \[\[ghost\]\] which does not exist/);
  assert.match(text(callTool(s, "dream_submit", { id, documents: [{ path: "/_index.md", content: "x" }] })), /No open draft|already submitted/);
  reviewFirst = id;
  assert.equal(cli(["apply", "--space", "review", id.slice(0, 20)]).code, 0);
  assert.equal(s.getTranscript("chat-1").status, "dreamed");
});

await t("apply skip rule: hand-edited page is skipped (exit 1, stays in review); --force overwrites; reject", () => {
  const s = store("review");
  callTool(s, "remember", { content: "rollback now uses make revert" });
  const id = /Draft id: (\S+)/.exec(text(callTool(s, "dream_prepare", {})))[1];
  fs.writeFileSync(path.join(s.wikiDir, "deploys.md"), page("deploys", "How releases are deployed.", "Edited by hand: releases deploy with make release from main."));
  callTool(s, "dream_submit", { id, documents: [{ path: "/deploys.md", content: page("deploys", "How releases are deployed.", "Releases deploy with make release from the main branch. Rollback: make revert.") }] });
  assert.match(cli(["diff", "--space", "review", id]).out, /=== \/deploys\.md \(modified\)  \[live file changed since this proposal was made; apply skips it unless --force\]/);
  const a = cli(["apply", "--space", "review", id]);
  assert.equal(a.code, 1);
  assert.match(a.out, /Applied 0 path\(s\).*\n  skipped \/deploys\.md: live file changed since the proposal was made\nNothing was applied and the proposal stays under review\./s);
  assert.equal(s.readProposal(id).status, "review");
  assert.match(cli(["proposals", "--space", "review"]).out, new RegExp(`${id}  review    \\S+  1 change\\(s\\)`));
  const f = cli(["apply", "--space", "review", id, "--force"]);
  assert.equal(f.code, 0);
  assert.match(s.readDoc("/deploys.md"), /make revert/);
  // a third proposal, rejected
  callTool(s, "remember", { content: "the release train leaves on fridays" });
  const id3 = /Draft id: (\S+)/.exec(text(callTool(s, "dream_prepare", {})))[1];
  callTool(s, "dream_submit", { id: id3, documents: [{ path: "/train.md", content: page("train", "Release schedule.", "Fridays.") }] });
  assert.match(cli(["reject", "--space", "review"]).out, new RegExp(`^Rejected ${id3}\\. Its inputs stay pending\\.`));
  assert.match(cli(["reject", "--space", "review", id3]).err, /is rejected, not under review/);
  assert.match(cli(["apply", "--space", "review", id3]).err, /was rejected/);
  assert.equal(cli(["diff", "--space", "review", "dream-"]).code, 2); // ambiguous prefix
  assert.equal(cli(["diff", "--space", "review", "nope"]).code, 1);
  assert.equal(cli(["diff", "--space", "review", "a", "b"]).code, 2);
});

await t("history and restore --version N (hand edits are kept as versions)", () => {
  const h = cli(["history", "--space", "review", "/deploys.md"]);
  const lines = h.out.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^v1  \S+  create  dream:dream-\S+  [0-9a-f]{8}$/);
  assert.match(lines[1], /^v2  \S+  update  user  [0-9a-f]{8}$/);
  assert.match(lines[2], /^v3  \S+  update  dream:dream-/);
  assert.match(cli(["history", "--space", "review"]).out, /^\/_index\.md v1 /);
  const r = cli(["restore", "--space", "review", "/deploys.md", "--version", "2"]);
  assert.match(r.out, /^Restored \/deploys\.md to version 2 \(/);
  assert.match(store("review").readDoc("/deploys.md"), /Edited by hand/);
  assert.match(cli(["history", "--space", "review", "/deploys.md"]).out, /v4  \S+  restore restore/);
  assert.match(cli(["restore", "--space", "review", "/deploys.md", "--version", "9"]).err, /has no version 9 \(versions: 1-4\)/);
  assert.match(cli(["restore", "--space", "review", "/deploys.md", "--version", "2"]).err, /already matches version 2/);
  assert.equal(cli(["restore", "--space", "review", "/deploys.md"]).code, 0); // newest version that differs
  assert.match(store("review").readDoc("/deploys.md"), /make revert/);
  assert.equal(cli(["restore", "--space", "review", "../etc/passwd"]).code, 2);
  assert.equal(cli(["restore", "--space", "review"]).code, 2);
  assert.match(cli(["restore", "--space", "review", "/none.md"]).err, /No history for \/none\.md/);
});

await t("retention: removes only transcripts dreamed more than N days ago", () => {
  const s = store("ret");
  const mk = (id, status, daysAgo) => s.saveTranscript({ id, source: "cli", events: [{ role: "user", content: id }], status, created_at: "x", updated_at: "x", dreamed_at: daysAgo === null ? null : new Date(Date.now() - daysAgo * 86_400_000).toISOString() });
  mk("old", "dreamed", 40);
  mk("recent", "dreamed", 10);
  mk("waiting", "pending", null);
  assert.equal(cli(["retention", "--space", "ret"]).out.trim(), "Removed 1 transcript(s) dreamed more than 30 day(s) ago.");
  assert.equal(cli(["retention", "--space", "ret", "--days", "5"]).out.trim(), "Removed 1 transcript(s) dreamed more than 5 day(s) ago.");
  assert.deepEqual(s.listTranscripts().map((x) => x.id), ["waiting"]);
  assert.equal(cli(["retention", "--space", "ret", "--days", "-1"]).code, 2);
});

// ------------------------------------------------------------------------------------------------ MCP
await t("MCP over real stdio: protocol, 17 tools, calls, resource, errors, notifications", () => {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recall", arguments: { query: "how are releases deployed", kind: "wiki" } } },
    { jsonrpc: "2.0", id: 4, method: "resources/list" },
    { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "nexorum://context" } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } },
    { jsonrpc: "2.0", id: 7, method: "frobnicate" },
    { jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "x://y" } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "read_document", arguments: { path: "/../../etc/passwd" } } },
    { jsonrpc: "2.0", id: 10, method: "ping" },
  ];
  const r = cli(["mcp", "--space", "review"], { input: `${msgs.map((m) => JSON.stringify(m)).join("\n")}\nnot json\n` });
  assert.equal(r.code, 0);
  assert.match(r.err, /^nexorum mcp: space "review" at /);
  const res = r.out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(res.length, 11);
  const by = new Map(res.map((x) => [x.id, x]));
  assert.equal(by.get(1).result.protocolVersion, "2025-03-26");
  assert.deepEqual(by.get(1).result.serverInfo, { name: "nexorum", version: "0.2.0" });
  assert.deepEqual(
    by.get(2).result.tools.map((x) => x.name),
    ["remember", "update_note", "save_transcript", "recall", "forget", "context", "read_document", "search_documents", "list_documents", "memory_status", "list_notes", "related_documents", "document_history", "list_proposals", "show_proposal", "dream_prepare", "dream_submit"],
  );
  assert.match(by.get(3).result.content[0].text, /^\[wiki\] deploys \(\/deploys\.md\) score=/);
  assert.equal(by.get(4).result.resources[0].uri, "nexorum://context");
  assert.match(by.get(5).result.contents[0].text, /^## Ops/);
  assert.equal(by.get(6).error.code, -32602);
  assert.equal(by.get(7).error.code, -32601);
  assert.equal(by.get(8).error.code, -32002);
  assert.equal(by.get(9).result.isError, true);
  assert.deepEqual(by.get(10).result, {});
  assert.equal(by.get(null).error.code, -32700);
});

await t("MCP tools: notes, documents, graph, history, status, proposals (in-process)", () => {
  const s = store("review");
  assert.equal(TOOLS.length, 17);
  const n = /Saved note (\S+)\./.exec(text(callTool(s, "remember", { content: "ci runs on node 22", metadata: { source: "user" } })))[1];
  assert.match(text(callTool(s, "recall", { query: "ci node", kind: "note" })), /metadata: \{"source":"user"\}/);
  assert.equal(text(callTool(s, "update_note", { id: n, content: "ci runs on node 24" })), `Updated note ${n}.`);
  assert.match(text(callTool(s, "list_notes", { limit: 1 })), /ci runs on node 24/);
  assert.equal(text(callTool(s, "forget", { id: n })), `Forgot note ${n}.`);
  assert.equal(callTool(s, "forget", { id: n }).isError, true);
  assert.match(text(callTool(s, "list_documents", {})), /^\/_index\.md  \(\d+ bytes\)\n\/deploys\.md  \(\d+ bytes\)  How releases are deployed\./);
  assert.match(text(callTool(s, "document_history", { path: "/deploys.md" })), /^v1  \S+  create  \(by dream:dream-/);
  assert.match(text(callTool(s, "search_documents", { query: "rollback" })), /\[wiki\] deploys/);
  assert.match(text(callTool(s, "memory_status", {})), /^Notes: \d+ \(\d+ not yet folded into the wiki\)\nWiki documents: 2\nTranscripts: 0 pending, 1 dreamed\nProposals awaiting review: 0\nLast dream: \S+\nDream: /);
  assert.match(text(callTool(s, "list_proposals", {})), /applied  \S+  2 applied/);
  assert.match(text(callTool(s, "show_proposal", { id: reviewFirst })), /^Proposal dream-\S+ \(applied\), created /);
  assert.equal(callTool(s, "recall", { query: "" }).isError, true);
  assert.equal(callTool(s, "recall", null).isError, true);
  assert.equal(callTool(s, "context", { max_chars: 5 }).content[0].text.startsWith("## Ops"), true);
  assert.equal(callTool(s, "save_transcript", { events: [] }).isError, true);
  assert.equal(callTool(s, "nope", {}), null);
  s.writeDoc("/ops.md", page("ops", "Ops overview.", "See [[deploys]] and [[ghost|a ghost]]."));
  assert.equal(text(callTool(s, "related_documents", { path: "/ops.md" })), "Links to (2):\n/deploys.md\n[[ghost]] (no such document)\n\nLinked from (0):\n(none)");
  assert.equal(text(callTool(s, "related_documents", { path: "/deploys.md" })), "Links to (0):\n(none)\n\nLinked from (2):\n/_index.md\n/ops.md");
  assert.equal(callTool(s, "related_documents", { path: "/nope.md" }).isError, true);
});

// ------------------------------------------------------------------------------------------------ hooks
await t("hooks: session-start digest, user-prompt recall (once per session), stop stores the session, always exit 0", () => {
  const env = { NEXORUM_SPACE: "" };
  const ss = cli(["hook", "session-start"], { input: JSON.stringify({ cwd: path.join(tmp, "review") }), env });
  assert.equal(ss.code, 0);
  const o = JSON.parse(ss.out);
  assert.equal(o.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(o.hookSpecificOutput.additionalContext, /^Nexorum memory \(space "review"\):\n## Ops/);
  const ask = { cwd: path.join(tmp, "review"), session_id: "s1", prompt: "How do we deploy releases from main?" };
  const up = cli(["hook", "user-prompt"], { input: JSON.stringify(ask), env });
  const u = JSON.parse(up.out);
  assert.equal(u.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(u.hookSpecificOutput.additionalContext, /^Nexorum memory that may be relevant to this prompt \(space "review"\)\..*\n- \[wiki\] deploys: /s);
  assert.equal(cli(["hook", "user-prompt"], { input: JSON.stringify(ask), env }).out, "", "shown once per session");
  assert.equal(cli(["hook", "user-prompt"], { input: JSON.stringify({ ...ask, session_id: "s2", prompt: "write a fibonacci function in rust please" }), env }).out, "");
  assert.equal(cli(["hook", "user-prompt"], { input: JSON.stringify({ ...ask, session_id: "s3" }), env: { ...env, NEXORUM_PROMPT_RECALL: "0" } }).out, "");
  const jl = path.join(tmp, "cc.jsonl");
  fs.writeFileSync(jl, [
    { type: "user", message: { role: "user", content: "staging deploys use make stage (key AKIAABCDEFGHIJKLMNOP)" }, timestamp: "2026-11-19T10:00:00Z" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Noted." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "make stage" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
    { type: "user", isSidechain: true, message: { role: "user", content: "subagent noise" } },
  ].map((x) => JSON.stringify(x)).join("\n"));
  assert.equal(cli(["hook", "stop"], { input: JSON.stringify({ cwd: path.join(tmp, "hooked"), session_id: "cc-session-1", transcript_path: jl }), env }).code, 0);
  const tr = store("hooked").getTranscript("cc-session-1");
  assert.equal(tr.source, "claude-code");
  assert.equal(tr.status, "pending");
  assert.deepEqual(tr.events.map((e) => `${e.role}:${e.name ?? ""}`), ["user:", "assistant:", "tool:Bash", "tool:Bash"]);
  assert.ok(!JSON.stringify(tr).includes("AKIA"));
  assert.equal(cli(["hook", "bogus"]).code, 0);
  assert.equal(cli(["hook", "stop"], { input: "not json" }).code, 0);
  assert.equal(cli(["hook", "stop"], { input: JSON.stringify({ session_id: "x", transcript_path: path.join(tmp, "missing.jsonl") }) }).code, 0);
});

// ------------------------------------------------------------------------------------------------ doctor
await t("doctor: PASS/WARN/FAIL lines, --json, exit 1 on FAIL, key never printed", () => {
  const ok = cli(["doctor", "--space", "review"]);
  assert.equal(ok.code, 0);
  const lines = ok.out.trim().split("\n");
  assert.equal(lines[0], 'nexorum doctor (space "review")');
  assert.match(ok.out, /PASS  node: Node /);
  assert.match(ok.out, /PASS  home: .* exists and is writable/);
  assert.match(ok.out, /PASS  space files: \d+ file\(s\)\/record\(s\) parse cleanly in space "review"/);
  assert.match(ok.out, /PASS  claude hooks: ~\/\.claude not found/);
  assert.match(ok.out, /PASS  mcp \(claude\): `claude` not found on PATH; skipped/);
  assert.match(ok.out, /WARN  llm config: provider anthropic; api key missing; base URL default \(Anthropic API\); analyzer model claude-haiku-5-5 \(default\); organizer model claude-haiku-5-5 \(default\)/);
  assert.match(ok.out, /PASS  pending work: /);
  assert.equal(lines.at(-1), "Result: OK with 1 warning(s)");
  const withKey = cli(["doctor", "--space", "review", "--json"], { env: { NEXORUM_LLM_API_KEY: "very-secret-value" } });
  const checks = JSON.parse(withKey.out);
  assert.deepEqual(checks.map((c) => c.name), ["node", "home", "space files", "claude hooks", "mcp (claude)", "mcp (codex)", "llm config", "pending work"]);
  assert.ok(checks.every((c) => ["PASS", "WARN", "FAIL"].includes(c.status) && "detail" in c && "hint" in c));
  assert.ok(!withKey.out.includes("very-secret-value"));
  assert.equal(withKey.code, 0);
  assert.equal(cli(["doctor", "--space", "review"], { env: { NEXORUM_LLM_PROVIDER: "nope" } }).code, 1);
  fs.mkdirSync(store("broken").dir, { recursive: true });
  fs.writeFileSync(store("broken").notesFile, '{"id":"n","content":"x","ts":"t"}\n{broken\n');
  const b = cli(["doctor", "--space", "broken"]);
  assert.equal(b.code, 1);
  assert.match(b.out, /FAIL  space files: 1 unreadable of 2 in space "broken": notes\.jsonl line 2/);
  assert.match(b.out, /Result: FAIL\n$/);
});

// ------------------------------------------------------------------------------------------------ init
await t("init: Claude Code merge + backup, Codex AGENTS.md block, Cursor, Claude Desktop; idempotent; never outside --home", () => {
  const H = path.join(tmp, "inithome");
  const P = path.join(tmp, "project");
  fs.mkdirSync(path.join(H, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(H, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(H, ".cursor"), { recursive: true });
  fs.mkdirSync(path.dirname(claudeDesktopConfigPath(H)), { recursive: true });
  fs.mkdirSync(P, { recursive: true });
  const settings = path.join(H, ".claude", "settings.json");
  const original = JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } });
  fs.writeFileSync(settings, original);
  fs.writeFileSync(path.join(P, "AGENTS.md"), "# My project\n");
  fs.writeFileSync(path.join(H, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));

  const dry = cli(["init", "--home", H, "--dir", P, "--dry-run"]);
  assert.match(dry.out, /^Dry run: nothing will be changed\.\nClaude Code:\n  would add SessionStart and Stop hook\(s\) to .*settings\.json \(backup: .*settings\.json\.nexorum-bak\)/);
  assert.equal(fs.readFileSync(settings, "utf8"), original);
  assert.equal(fs.existsSync(path.join(P, "AGENTS.md.nexorum-bak")), false);

  const r = cli(["init", "--home", H, "--dir", P]);
  assert.equal(r.code, 0, r.err);
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.hooks.SessionStart, [{ hooks: [{ type: "command", command: "npx -y nexorum hook session-start" }] }]);
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(fs.readFileSync(`${settings}.nexorum-bak`, "utf8"), original);
  assert.match(r.out, /`claude` was not found on PATH\. Register the MCP server yourself:\n    claude mcp add nexorum -- npx -y nexorum mcp/);
  assert.match(r.out, /\[mcp_servers\.nexorum\]/);
  const agents = fs.readFileSync(path.join(P, "AGENTS.md"), "utf8");
  assert.match(agents, /^# My project\n\n<!-- nexorum:begin \(managed by `nexorum init`; edit outside this block\) -->\n## Project memory \(Nexorum\)/);
  assert.equal(fs.readFileSync(path.join(P, "AGENTS.md.nexorum-bak"), "utf8"), "# My project\n");
  const cursor = JSON.parse(fs.readFileSync(path.join(H, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cursor.mcpServers, { other: { command: "x" }, nexorum: { command: "npx", args: ["-y", "nexorum", "mcp"] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeDesktopConfigPath(H), "utf8")).mcpServers.nexorum.args, ["-y", "nexorum", "mcp"]);
  assert.match(r.out, /Done\. Memory lives in ~\/\.nexorum \(or \$NEXORUM_HOME\)\. Next: `nexorum status`\.\n$/);

  const again = cli(["init", "--home", H, "--dir", P, "--prompt-recall"]);
  assert.match(again.out, /--prompt-recall skipped: `nexorum` is not on your PATH/);
  assert.match(again.out, /hooks already present in /);
  assert.match(again.out, /already has the Nexorum block\./);
  assert.match(again.out, /nexorum is already in .*mcp\.json/);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).hooks.Stop.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).hooks.UserPromptSubmit, undefined);

  const home2 = path.join(tmp, "home2");
  fs.mkdirSync(home2);
  assert.match(cli(["init", "--home", home2]).out, /^No supported client detected/);
  assert.match(cli(["init", "--codex", "--home", home2, "--dir", home2]).out, /AGENTS\.md not written: this is your home folder/);
  assert.match(cli(["init", "--codex", "--no-agents-md", "--home", home2, "--dir", P]).out, /AGENTS\.md left alone \(--no-agents-md\)/);
  assert.deepEqual(fs.readdirSync(home2), [], "nothing written for flags that only print");

  // Hermes: the entry goes straight into $HERMES_HOME/config.yaml (its `mcp add` is interactive), other lines kept.
  const home3 = path.join(tmp, "home3");
  const hdir = process.platform === "win32" ? path.join(home3, "AppData", "Local", "hermes") : path.join(home3, ".hermes");
  fs.mkdirSync(hdir, { recursive: true });
  const yaml = "model: anthropic/claude-sonnet-5-5\nmcp_servers:\n    github:\n        command: \"npx\"\n        args: [\"-y\", \"@modelcontextprotocol/server-github\"]\n\nterminal:\n  backend: local\n";
  fs.writeFileSync(path.join(hdir, "config.yaml"), yaml);
  const hermes = cli(["init", "--hermes", "--home", home3]);
  assert.match(hermes.out, /Hermes:\n  backed up .*config\.yaml -> .*config\.yaml\.nexorum-bak\n  added the nexorum MCP server to .*config\.yaml\n  Check it with: hermes mcp test nexorum   \(by hand instead: hermes mcp add nexorum --command npx --args -y nexorum mcp\)/);
  assert.equal(
    fs.readFileSync(path.join(hdir, "config.yaml"), "utf8"),
    "model: anthropic/claude-sonnet-5-5\nmcp_servers:\n    github:\n        command: \"npx\"\n        args: [\"-y\", \"@modelcontextprotocol/server-github\"]\n    nexorum:\n      command: \"npx\"\n      args: [\"-y\", \"nexorum\", \"mcp\"]\n      enabled: true\n\nterminal:\n  backend: local\n",
  );
  assert.equal(fs.readFileSync(path.join(hdir, "config.yaml.nexorum-bak"), "utf8"), yaml);
  assert.match(cli(["init", "--hermes", "--home", home3]).out, /nexorum is already in .*config\.yaml/);
  assert.match(cli(["init", "--home", home3]).out, /^Hermes:/, "an existing Hermes home is detected");
  fs.writeFileSync(path.join(home2, "bad.json"), "");
  fs.mkdirSync(path.join(home2, ".claude"));
  fs.writeFileSync(path.join(home2, ".claude", "settings.json"), "{not json");
  const bad = cli(["init", "--claude-code", "--home", home2]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /is not valid JSON; refusing to touch it/);
  assert.equal(cli(["init", "--home", home2, "--space", "x"]).code, 2);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} tests passed`);
process.exitCode = fail ? 1 : 0;
