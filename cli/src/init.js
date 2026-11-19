// `nexorum init`: wires Nexorum into the clients it finds (or the ones named by flags).
//   Claude Code     hooks merged into ~/.claude/settings.json (backup first) + `claude mcp add`
//   Codex           `codex mcp add` + a marked block in the project's AGENTS.md
//   Hermes          mcp_servers entry in $HERMES_HOME/config.yaml (backup first; `hermes mcp add` is interactive)
//   Cursor          mcpServers entry in ~/.cursor/mcp.json (backup first)
//   Claude Desktop  mcpServers entry in claude_desktop_config.json (backup first)
// Every path is derived from --home, so nothing outside it is touched (except AGENTS.md in --dir).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CliError } from "./args.js";
import { atomicWrite } from "./store.js";
import { setupAgentsMd } from "./agents-md.js";

const MARK = (sub) => new RegExp(`nexorum hook ${sub}`);
const HOOKS = [
  ["SessionStart", "npx -y nexorum hook session-start", MARK("session-start")],
  ["Stop", "npx -y nexorum hook stop", MARK("stop")],
];
// Runs before EVERY prompt, so it must not go through npx (seconds per call, against a fraction of a second for the
// installed command) and must be the version that ran init. It needs `nexorum` on PATH.
const PROMPT_HOOK = ["UserPromptSubmit", "nexorum hook user-prompt", MARK("user-prompt")];
const MCP_ARGS = ["mcp", "add", "nexorum", "--", "npx", "-y", "nexorum", "mcp"];
const MCP_ENTRY = { command: "npx", args: ["-y", "nexorum", "mcp"] };
const CODEX_TOML = `[mcp_servers.nexorum]\ncommand = "npx"\nargs = ["-y", "nexorum", "mcp"]`;
const HERMES_ENTRY = ["nexorum:", '  command: "npx"', '  args: ["-y", "nexorum", "mcp"]', "  enabled: true"];
const HERMES_CMD = "hermes mcp add nexorum --command npx --args -y nexorum mcp";
const BACKUP = ".nexorum-bak";

const out = (s = "") => process.stdout.write(`${s}\n`);
const mcpCommand = (bin) => `${bin} ${MCP_ARGS.join(" ")}`;

/** An executable on PATH (PATHEXT on Windows), or null. */
export function findBinary(name, env = process.env) {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

export function claudeDesktopConfigPath(home, platform = process.platform) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

export function hasHook(list, marker) {
  return Array.isArray(list) && list.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && marker.test(h.command)));
}

/** Adds the Nexorum hooks to a parsed settings object, keeping every existing hook. Returns the events added. */
export function mergeClaudeSettings(settings, { promptRecall = false } = {}) {
  if (settings.hooks === undefined) settings.hooks = {};
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new CliError('settings.json has a "hooks" value that is not an object; fix it by hand and run init again.');
  }
  const added = [];
  for (const [event, command, marker] of promptRecall ? [...HOOKS, PROMPT_HOOK] : HOOKS) {
    if (settings.hooks[event] === undefined) settings.hooks[event] = [];
    if (!Array.isArray(settings.hooks[event])) throw new CliError(`settings.json hooks.${event} is not an array; fix it by hand and run init again.`);
    if (hasHook(settings.hooks[event], marker)) continue;
    settings.hooks[event].push({ hooks: [{ type: "command", command }] });
    added.push(event);
  }
  return added;
}

/** Adds the mcpServers.nexorum entry unless one exists. Returns true when it was added. */
export function mergeMcpServers(config) {
  if (config.mcpServers === undefined) config.mcpServers = {};
  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
    throw new CliError('The config has an "mcpServers" value that is not an object; fix it by hand and run init again.');
  }
  if (config.mcpServers.nexorum) return false;
  config.mcpServers.nexorum = { ...MCP_ENTRY, args: [...MCP_ENTRY.args] };
  return true;
}

/** Reads a JSON object file; refuses (CliError) to touch invalid JSON. Returns {raw, data}; raw null when missing. */
function readJsonObject(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (raw === null || raw.trim() === "") return { raw, data: {} };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CliError(`${file} is not valid JSON; refusing to touch it. Fix it and run init again.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new CliError(`${file} is not a JSON object; refusing to touch it.`);
  return { raw, data };
}

/** Backs the file up once (never overwriting an older backup), then writes it atomically. */
function writeWithBackup(file, raw, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}${BACKUP}`;
  if (raw !== null && !fs.existsSync(backup)) {
    fs.writeFileSync(backup, raw);
    out(`  backed up ${file} -> ${backup}`);
  }
  atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
}

function setupMcp(client, bin, { dryRun, env }) {
  if (!findBinary(bin, env)) {
    out(`  \`${bin}\` was not found on PATH. Register the MCP server yourself:`);
    out(`    ${mcpCommand(bin)}`);
    if (client === "Codex") {
      out("  or add this to ~/.codex/config.toml:");
      for (const l of CODEX_TOML.split("\n")) out(`    ${l}`);
    }
    return;
  }
  if (dryRun) return out(`  would run: ${mcpCommand(bin)}`);
  // Windows needs a shell for .cmd shims; MCP_ARGS are fixed constants, so pass one command string.
  const win = process.platform === "win32";
  const r = win ? spawnSync([bin, ...MCP_ARGS].join(" "), { encoding: "utf8", env, shell: true, timeout: 60_000 }) : spawnSync(bin, MCP_ARGS, { encoding: "utf8", env, timeout: 60_000 });
  if (r.status === 0 && !r.error) return out(`  ran: ${mcpCommand(bin)}`);
  const why = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0];
  out(`  \`${mcpCommand(bin)}\` did not succeed${why ? ` (${why})` : ""}. If nexorum is already registered this is fine; otherwise run it yourself.`);
}

function setupClaudeCode(home, { dryRun, env, promptRecall }) {
  out("Claude Code:");
  if (promptRecall && !findBinary("nexorum", env)) {
    out("  --prompt-recall skipped: `nexorum` is not on your PATH, and this hook runs before every prompt, so it cannot go through npx");
    out("  (npx takes seconds per call, the installed command a fraction of a second). Run:");
    out("    npm install -g nexorum");
    out("  then run `nexorum init --claude-code --prompt-recall` again. The other hooks are installed below as usual.");
    promptRecall = false;
  }
  const file = path.join(home, ".claude", "settings.json");
  const { raw, data } = readJsonObject(file);
  const added = mergeClaudeSettings(data, { promptRecall });
  if (!added.length) out(`  hooks already present in ${file}`);
  else if (dryRun) out(`  would add ${added.join(" and ")} hook(s) to ${file}${raw !== null ? ` (backup: ${file}${BACKUP})` : " (new file)"}`);
  else {
    writeWithBackup(file, raw, data);
    out(`  added ${added.join(" and ")} hook(s) to ${file}`);
  }
  setupMcp("Claude Code", "claude", { dryRun, env });
}

function setupCodex({ dryRun, env, dir, home, agentsMd }) {
  out("Codex:");
  setupMcp("Codex", "codex", { dryRun, env });
  if (!agentsMd) out("  AGENTS.md left alone (--no-agents-md). Without instructions Codex may never call Nexorum on its own.");
  else {
    const r = setupAgentsMd(dir, { dryRun, home });
    if (r.skipped) out(`  AGENTS.md not written: ${r.skipped}.`);
    else if (r.action === "unchanged") out(`  ${r.file} already has the Nexorum block.`);
    else if (dryRun) out(`  would ${{ created: "create", added: "add the Nexorum block to", updated: "update the Nexorum block in" }[r.action]} ${r.file}`);
    else out(`  ${{ created: "created", added: "added the Nexorum block to", updated: "updated the Nexorum block in" }[r.action]} ${r.file}${r.backup ? ` (backup: ${r.backup})` : ""}`);
    if (!dryRun && r.action !== "skipped") out("  Why: Codex has no session hooks, and it uses a memory server reliably only once its project instructions tell it to.");
  }
  out("  Codex has no session hooks: store a session with the `save_transcript` tool or `nexorum log` if you want it dreamed.");
}

/** Hermes keeps its config in $HERMES_HOME (default ~/.hermes, or %LOCALAPPDATA%\hermes on Windows). */
export function hermesHome(home, env = process.env, { useEnv = true, platform = process.platform } = {}) {
  if (useEnv && env.HERMES_HOME) return env.HERMES_HOME;
  const posix = path.join(home, ".hermes");
  if (platform !== "win32" || fs.existsSync(posix)) return posix;
  return path.join(home, "AppData", "Local", "hermes");
}

/**
 * Adds the nexorum entry under mcp_servers in a Hermes config.yaml, keeping every other line as it was.
 * Returns the new text, or null when nexorum is already there. Handles no file, no mcp_servers key, an empty
 * `mcp_servers: {}`, and an existing block (the entry takes the indentation of its siblings).
 */
export function mergeHermesYaml(text) {
  const src = text ?? "";
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  const top = lines.findIndex((l) => /^mcp_servers:\s*(\{\s*\})?\s*(#.*)?$/.test(l));
  const entry = (indent) => HERMES_ENTRY.map((l) => indent + l);
  if (top === -1) {
    const head = src === "" || src.endsWith("\n") ? src : src + nl;
    return `${head}${src.trim() ? nl : ""}mcp_servers:${nl}${entry("  ").join(nl)}${nl}`;
  }
  let end = top + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) end++;
  const block = lines.slice(top + 1, end);
  if (block.some((l) => /^\s+(nexorum|"nexorum"|'nexorum'):\s*(#.*)?$/.test(l))) return null;
  const sibling = block.find((l) => /^\s+\S/.test(l));
  const indent = sibling ? /^(\s+)/.exec(sibling)[1] : "  ";
  lines[top] = "mcp_servers:";
  let at = end;
  while (at > top + 1 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, ...entry(indent));
  return lines.join(nl);
}

function setupHermes(home, { dryRun, env, useEnv }) {
  out("Hermes:");
  const file = path.join(hermesHome(home, env, { useEnv }), "config.yaml");
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const next = mergeHermesYaml(raw);
  if (next === null) return out(`  nexorum is already in ${file}`);
  if (dryRun) return out(`  would add the nexorum MCP server to ${file}${raw !== null ? ` (backup: ${file}${BACKUP})` : " (new file)"}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}${BACKUP}`;
  if (raw !== null && !fs.existsSync(backup)) {
    fs.writeFileSync(backup, raw);
    out(`  backed up ${file} -> ${backup}`);
  }
  atomicWrite(file, next);
  out(`  added the nexorum MCP server to ${file}`);
  out(`  Check it with: hermes mcp test nexorum   (by hand instead: ${HERMES_CMD})`);
}

function setupJsonClient(label, file, { dryRun }) {
  out(`${label}:`);
  const { raw, data } = readJsonObject(file);
  if (!mergeMcpServers(data)) return out(`  nexorum is already in ${file}`);
  if (dryRun) return out(`  would add the nexorum MCP server to ${file}${raw !== null ? ` (backup: ${file}${BACKUP})` : " (new file)"}`);
  writeWithBackup(file, raw, data);
  out(`  added the nexorum MCP server to ${file}`);
}

export function initCommand(flags, env, home) {
  const all = Boolean(flags.all);
  const named = ["claude-code", "codex", "hermes", "cursor", "claude-desktop"].some((k) => flags[k]);
  const desktopFile = claudeDesktopConfigPath(home);
  const want = {
    claude: all || flags["claude-code"],
    codex: all || flags.codex,
    hermes: all || flags.hermes,
    cursor: all || flags.cursor,
    desktop: all || flags["claude-desktop"],
  };
  if (!all && !named) {
    want.claude = fs.existsSync(path.join(home, ".claude"));
    want.codex = fs.existsSync(path.join(home, ".codex")) || findBinary("codex", env) !== null;
    want.hermes = fs.existsSync(hermesHome(home, env, { useEnv: !flags.home })) || findBinary("hermes", env) !== null;
    want.cursor = fs.existsSync(path.join(home, ".cursor"));
    want.desktop = fs.existsSync(path.dirname(desktopFile));
    if (!Object.values(want).some(Boolean)) {
      out("No supported client detected (looked for ~/.claude, ~/.codex, the Hermes home, ~/.cursor, the Claude Desktop config folder, and `codex` / `hermes` on PATH).");
      out("Run with --claude-code, --codex, --hermes, --cursor, --claude-desktop or --all to set one up anyway.");
      return 0;
    }
  }
  const dryRun = Boolean(flags["dry-run"]);
  if (dryRun) out("Dry run: nothing will be changed.");
  if (want.claude) setupClaudeCode(home, { dryRun, env, promptRecall: Boolean(flags["prompt-recall"]) });
  if (want.codex) setupCodex({ dryRun, env, dir: path.resolve(flags.dir ?? process.cwd()), home, agentsMd: !flags["no-agents-md"] });
  if (want.hermes) setupHermes(home, { dryRun, env, useEnv: !flags.home });
  if (want.cursor) setupJsonClient("Cursor", path.join(home, ".cursor", "mcp.json"), { dryRun });
  if (want.desktop) setupJsonClient("Claude Desktop", desktopFile, { dryRun });
  if (!dryRun) out("Done. Memory lives in ~/.nexorum (or $NEXORUM_HOME). Next: `nexorum status`.");
  return 0;
}
