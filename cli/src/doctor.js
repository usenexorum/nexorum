// `nexorum doctor [--json]`: read-only health check. One PASS/WARN/FAIL line per check; exit 1 when any check fails.
// No network call; the API key is only ever reported as set or missing.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nexorumRoot, userHome, isSafeId } from "./store.js";
import { findBinary, hasHook } from "./init.js";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_BASE_URL } from "./dream.js";

const out = (s = "") => process.stdout.write(`${s}\n`);
const check = (name, status, detail, hint = "") => ({ name, status, detail, hint });

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22 ? check("node", "PASS", `Node ${process.versions.node}`) : check("node", "FAIL", `Node ${process.versions.node} is too old`, "Install Node 22 or newer.");
}

function checkHome(env) {
  const root = nexorumRoot(env);
  let probe = root;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const exists = probe === root;
  try {
    if (!fs.statSync(probe).isDirectory()) throw new Error("not a directory");
    fs.accessSync(probe, fs.constants.W_OK);
  } catch {
    const why = exists ? "is not a writable directory" : `cannot be created (${probe} is not a writable directory)`;
    return check("home", "FAIL", `${root} ${why}`, "Set NEXORUM_HOME to a writable folder or fix its permissions.");
  }
  return exists
    ? check("home", "PASS", `${root} exists and is writable`)
    : check("home", "PASS", `${root} does not exist yet but can be created`, "It is created on first use.");
}

/** Parses every file of the space and counts what cannot be read. Never writes. */
function checkSpaceFiles(store) {
  if (!fs.existsSync(store.dir)) return check("space files", "PASS", `space "${store.space}" has no data yet`, 'Run: nexorum remember "..." or nexorum log.');
  let total = 0;
  const bad = [];
  const rel = (f) => path.relative(store.dir, f);
  const list = (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  const tryJson = (file, valid) => {
    total++;
    try {
      if (!valid(JSON.parse(fs.readFileSync(file, "utf8")))) throw new Error("unexpected shape");
    } catch {
      bad.push(rel(file));
    }
  };
  const tryLines = (file) => {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return;
      total++;
      bad.push(rel(file));
      return;
    }
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      n++;
      total++;
      try {
        JSON.parse(line);
      } catch {
        bad.push(`${rel(file)} line ${n}`);
      }
    }
  };
  const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
  for (const n of list(store.transcriptsDir)) if (n.endsWith(".json")) tryJson(path.join(store.transcriptsDir, n), (t) => t && typeof t.id === "string" && Array.isArray(t.events));
  tryLines(store.notesFile);
  if (fs.existsSync(store.stateFile)) tryJson(store.stateFile, isObject);
  tryLines(store.historyLog);
  for (const n of list(store.proposalsDir)) {
    const f = path.join(store.proposalsDir, n, "proposal.json");
    if (isSafeId(n) && fs.existsSync(f)) tryJson(f, isObject);
  }
  if (!bad.length) return check("space files", "PASS", `${total} file(s)/record(s) parse cleanly in space "${store.space}"`);
  const shown = bad.slice(0, 5).join(", ") + (bad.length > 5 ? `, and ${bad.length - 5} more` : "");
  return check("space files", "FAIL", `${bad.length} unreadable of ${total} in space "${store.space}": ${shown}`, "Restore the file from a backup or delete it; nexorum skips unreadable records but cannot repair them.");
}

function checkClaudeHooks(env) {
  const dir = path.join(userHome(env), ".claude");
  if (!fs.existsSync(dir)) return check("claude hooks", "PASS", "~/.claude not found; Claude Code not in use", "Run `nexorum init --claude-code` if you use Claude Code.");
  const file = path.join(dir, "settings.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return e.code === "ENOENT"
      ? check("claude hooks", "WARN", `${file} does not exist`, "Run: nexorum init --claude-code")
      : check("claude hooks", "WARN", `${file} is not valid JSON`, "Fix the JSON by hand, then run: nexorum init --claude-code");
  }
  const hooks = settings && typeof settings === "object" ? settings.hooks : undefined;
  const missing = ["SessionStart", "Stop"].filter((ev) => !hasHook(hooks?.[ev], /nexorum hook/));
  if (!missing.length) return check("claude hooks", "PASS", "SessionStart and Stop hooks call `nexorum hook`");
  return check("claude hooks", "WARN", `missing ${missing.join(" and ")} hook(s) in ${file}`, "Run: nexorum init --claude-code");
}

function checkMcp(bin, env) {
  const name = `mcp (${bin})`;
  if (!findBinary(bin, env)) return check(name, "PASS", `\`${bin}\` not found on PATH; skipped`);
  // Windows needs a shell for .cmd shims; the arguments are fixed constants, so pass one command string.
  const win = process.platform === "win32";
  const r = win ? spawnSync(`${bin} mcp list`, { encoding: "utf8", env, shell: true, timeout: 5000 }) : spawnSync(bin, ["mcp", "list"], { encoding: "utf8", env, timeout: 5000 });
  const hint = `Register it: ${bin} mcp add nexorum -- npx -y nexorum mcp (or run: nexorum init)`;
  if (r.error || r.status !== 0) {
    const why = r.error?.code === "ETIMEDOUT" ? "timed out after 5 s" : r.error ? r.error.message : `exit ${r.status}`;
    return check(name, "WARN", `\`${bin} mcp list\` failed (${why})`, hint);
  }
  return /nexorum/i.test(`${r.stdout}${r.stderr}`) ? check(name, "PASS", `nexorum is registered in ${bin}`) : check(name, "WARN", `nexorum is not listed by \`${bin} mcp list\``, hint);
}

function checkLlm(env) {
  const provider = (env.NEXORUM_LLM_PROVIDER || "anthropic").toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") return check("llm config", "FAIL", `NEXORUM_LLM_PROVIDER "${provider}" is not valid`, 'Use "anthropic" or "openai".');
  const fallbackKey = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const key = env.NEXORUM_LLM_API_KEY || env[fallbackKey];
  const parts = [`provider ${provider}`, `api key ${key ? "set" : "missing"}`];
  const problems = key ? [] : [`Set NEXORUM_LLM_API_KEY (or ${fallbackKey}).`];
  if (env.NEXORUM_LLM_BASE_URL) parts.push("base URL set");
  else parts.push(provider === "openai" ? `base URL default ${DEFAULT_OPENAI_BASE_URL}` : "base URL default (Anthropic API)");
  const fallback = provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : undefined;
  for (const [role, varName] of [["analyzer", "NEXORUM_ANALYZER_MODEL"], ["organizer", "NEXORUM_ORGANIZER_MODEL"]]) {
    const model = env[varName] || fallback;
    parts.push(`${role} model ${model ?? "missing"}${!env[varName] && fallback ? " (default)" : ""}`);
    if (!model) problems.push(`Set ${varName}.`);
  }
  return problems.length
    ? check("llm config", "WARN", parts.join("; "), `${problems.join(" ")} Needed only for \`nexorum dream\`.`)
    : check("llm config", "PASS", parts.join("; "), "Not tested against the network.");
}

function checkPending(store) {
  let pending = 0;
  let review = 0;
  try {
    pending = store.listTranscripts().filter((t) => t.status === "pending" && t.events.length > 0).length;
    review = store.listProposals().filter((p) => p.status === "review").length;
  } catch {}
  const hint = review ? "Run: nexorum proposals, then nexorum diff / apply / reject." : pending ? "Run: nexorum dream" : "";
  return check("pending work", "PASS", `${pending} pending transcript(s), ${review} proposal(s) awaiting review`, hint);
}

export function runChecks(store, env) {
  return [checkNode(), checkHome(env), checkSpaceFiles(store), checkClaudeHooks(env), checkMcp("claude", env), checkMcp("codex", env), checkLlm(env), checkPending(store)];
}

export function doctorCommand(store, flags, env) {
  const results = runChecks(store, env);
  const failed = results.some((r) => r.status === "FAIL");
  if (flags.json) out(JSON.stringify(results, null, 2));
  else {
    out(`nexorum doctor (space "${store.space}")`);
    for (const r of results) {
      out(`${r.status.padEnd(4)}  ${r.name}: ${r.detail}`);
      if (r.hint) out(`      hint: ${r.hint}`);
    }
    const warns = results.filter((r) => r.status === "WARN").length;
    out(failed ? "Result: FAIL" : warns ? `Result: OK with ${warns} warning(s)` : "Result: OK");
  }
  return failed ? 1 : 0;
}
