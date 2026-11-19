import fs from "node:fs";
import { parseArgs, intFlag, CliError, UsageError } from "./args.js";
import { Store, userHome, assertDocPath, isSafeId } from "./store.js";
import { newId } from "./core/index.js";
import { contextFor, formatResults, recallResults, rememberChecked } from "./memory.js";
import { normalizeEvents } from "./transcript.js";
import { applyProposal, formatHistory, proposalChanges, rejectProposal, renderProposalDiff, restorePath, runRetention } from "./proposals.js";
import { VERSION } from "./version.js";

export const USAGE = `nexorum ${VERSION}: local-first memory for AI agents

Usage: nexorum <command> [options]

Setup
  init [--claude-code] [--codex] [--hermes] [--cursor] [--claude-desktop] [--all] [--dry-run] [--home DIR] [--dir DIR] [--no-agents-md] [--prompt-recall]
  mcp                       run the MCP server on stdio
  hook session-start|user-prompt|stop   Claude Code hook (JSON on stdin)

Memory
  remember "text"           save a note
  recall "query" [--limit N] [--kind note|wiki] [--since DATE]
  context [--max-chars N]
  status
  log [--file F | -] [--source S] [--id ID]   store a transcript (JSON events)
  import omp [--dir D] [--session FILE] [--all] [--since DATE]   store omp sessions as transcripts

Dreaming
  dream [--budget TOKENS] [--instructions "..."] [--yes] [--dry-run] [--apply]
        [--since DATE] [--max-inputs N]   only transcripts updated since DATE; at most N (1-200, default 50)
  dream --if-due [--min-pending N] [--idle-minutes M] [--cooldown-hours H]   for schedulers: dream only when
        at least N (3) transcripts are pending, the newest is M (10) minutes old and the last dream H (6) hours old
  doctor [--json]           read-only health check (PASS/WARN/FAIL per line; exit 1 on FAIL)
  proposals
  diff [id]
  apply [id] [--force]
  reject [id]
  restore <path> [--version N]
  history [path]
  retention [--days N]

Global: --space NAME (default: $NEXORUM_SPACE or the current folder name), --help, --version
Environment: NEXORUM_HOME (default ~/.nexorum), NEXORUM_LLM_PROVIDER, NEXORUM_LLM_API_KEY,
  NEXORUM_LLM_BASE_URL, NEXORUM_ANALYZER_MODEL, NEXORUM_ORGANIZER_MODEL
Exit codes: 0 ok, 1 runtime error, 2 usage or configuration error`;

const out = (s = "") => process.stdout.write(`${s}\n`);
const withSpace = (spec = {}) => ({ ...spec, string: [...(spec.string ?? []), "space"] });

const SPEC = {
  init: { bool: ["claude-code", "codex", "hermes", "cursor", "claude-desktop", "all", "dry-run", "no-agents-md", "prompt-recall"], string: ["home", "dir"] },
  mcp: withSpace(),
  hook: withSpace(),
  log: withSpace({ string: ["file", "source", "id"] }),
  remember: withSpace(),
  recall: withSpace({ string: ["limit", "kind", "since"] }),
  context: withSpace({ string: ["max-chars"] }),
  status: withSpace(),
  dream: withSpace({
    bool: ["yes", "dry-run", "apply", "if-due"],
    string: ["budget", "instructions", "since", "max-inputs", "min-pending", "idle-minutes", "cooldown-hours"],
    alias: { y: "yes" },
  }),
  doctor: withSpace({ bool: ["json"] }),
  proposals: withSpace(),
  diff: withSpace(),
  apply: withSpace({ bool: ["force"] }),
  reject: withSpace(),
  restore: withSpace({ string: ["version"] }),
  import: withSpace({ bool: ["all"], string: ["dir", "session", "since"] }),
  history: withSpace(),
  retention: withSpace({ string: ["days"] }),
};

function readInput(file) {
  if (file === undefined || file === "-") return fs.readFileSync(0, "utf8");
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new UsageError(`Cannot read ${file}: ${e.code ?? e.message}`);
  }
}

function logCommand(store, flags) {
  let data;
  try {
    data = JSON.parse(readInput(flags.file));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new UsageError("Input is not valid JSON.");
  }
  const events = normalizeEvents(Array.isArray(data) ? data : data?.events);
  const id = flags.id ?? newId("trn");
  if (!isSafeId(id)) throw new UsageError("--id may only contain letters, digits, _ . - (up to 128 characters).");
  const source = flags.source ?? (typeof data?.source === "string" ? data.source : "cli");
  const { transcript, changed } = store.upsertTranscript({ id, source, externalId: flags.id ?? null, events });
  out(changed ? `Logged transcript ${transcript.id} (${events.length} events, status ${transcript.status}).` : `Transcript ${transcript.id} unchanged.`);
}

function statusCommand(store) {
  const transcripts = store.listTranscripts();
  const proposals = store.listProposals();
  const count = (s) => transcripts.filter((t) => t.status === s).length;
  out(`Home:        ${store.root}`);
  out(`Space:       ${store.space}`);
  out(`Notes:       ${store.readNotes().length}`);
  out(`Wiki docs:   ${store.wikiCount()}`);
  out(`Transcripts: ${count("pending")} pending, ${count("dreamed")} dreamed`);
  out(`Proposals:   ${proposals.filter((p) => p.status === "review").length} awaiting review, ${proposals.length} total`);
}

function proposalsCommand(store) {
  const list = store.listProposals();
  if (!list.length) return out("No proposals. Run: nexorum dream");
  for (const p of list) {
    let n = "?";
    try {
      n = String(proposalChanges(store, p.id).length);
    } catch {}
    const what = p.status === "review" ? `${n} change(s)` : `${(p.applied_paths ?? []).length} applied`;
    out(`${p.id}  ${p.status.padEnd(8)}${p.partial ? " PARTIAL" : ""}  ${p.created_at}  ${what}`);
  }
}

async function dispatch(cmd, rest, env) {
  const spec = SPEC[cmd];
  if (!spec) throw new UsageError(`Unknown command "${cmd}". Run: nexorum --help`);
  const { flags, positionals } = parseArgs(rest, spec);
  const openStore = () => Store.open({ space: flags.space, env });
  const atMostOne = (what) => {
    if (positionals.length > 1) throw new UsageError(`Too many arguments for ${what}.`);
    return positionals[0];
  };
  switch (cmd) {
    case "init": {
      const { initCommand } = await import("./init.js");
      return initCommand(flags, env, flags.home ?? userHome(env));
    }
    case "mcp": {
      const { mcpCommand } = await import("./mcp.js");
      return mcpCommand(openStore());
    }
    case "hook": {
      const sub = positionals[0];
      if (!["session-start", "user-prompt", "stop"].includes(sub)) throw new UsageError("Usage: nexorum hook session-start|user-prompt|stop");
      const { hookCommand } = await import("./hook.js");
      return hookCommand(sub, flags, env);
    }
    case "log":
      logCommand(openStore(), flags);
      return 0;
    case "import": {
      const { importCommand } = await import("./import.js");
      return importCommand(positionals, flags, env);
    }
    case "remember": {
      const r = rememberChecked(openStore(), positionals.join(" "));
      if (r.duplicateOf) out(`Already remembered as ${r.duplicateOf.id}; nothing saved.`);
      else {
        out(`Saved note ${r.note.id}.`);
        if (r.similarTo) {
          out(`Note: very similar to ${r.similarTo.id} ("${r.similarTo.content.replace(/\s+/g, " ").slice(0, 80)}"). If it replaces it, remove the old one with the MCP forget tool (or update_note).`);
        }
      }
      return 0;
    }
    case "recall": {
      if (!positionals.length) throw new UsageError('Usage: nexorum recall "query" [--limit N]');
      const kind = flags.kind;
      if (kind !== undefined && kind !== "note" && kind !== "wiki") throw new UsageError("--kind must be note or wiki.");
      out(formatResults(recallResults(openStore(), positionals.join(" "), intFlag(flags, "limit", { max: 50, fallback: 5 }), { kind, since: flags.since })));
      return 0;
    }
    case "context": {
      const c = contextFor(openStore(), intFlag(flags, "max-chars", { min: 100, max: 100_000, fallback: 4096 }));
      if (c.content) out(c.content);
      else process.stderr.write("Memory is empty for this space.\n");
      return 0;
    }
    case "status":
      statusCommand(openStore());
      return 0;
    case "dream": {
      const { dreamCommand } = await import("./dream.js");
      return dreamCommand(openStore(), flags, env);
    }
    case "doctor": {
      const { doctorCommand } = await import("./doctor.js");
      return doctorCommand(openStore(), flags, env);
    }
    case "proposals":
      proposalsCommand(openStore());
      return 0;
    case "diff": {
      const store = openStore();
      out(renderProposalDiff(store, store.pickProposal(atMostOne("diff"))));
      return 0;
    }
    case "apply": {
      const store = openStore();
      const p = store.pickProposal(atMostOne("apply"));
      const r = applyProposal(store, p, { force: Boolean(flags.force) });
      out(`Applied ${r.applied.length} path(s) from ${p.id}.`);
      for (const a of r.applied) out(`  wrote ${a}`);
      for (const s of r.skipped) out(`  skipped ${s.path}: ${s.reason}`);
      if (r.status !== "applied") {
        out("Nothing was applied and the proposal stays under review. Use --force to overwrite the changed live files, or run a new dream.");
        return 1;
      }
      const removed = runRetention(store);
      if (removed) out(`Retention: removed ${removed} old transcript(s).`);
      return 0;
    }
    case "reject": {
      const store = openStore();
      const p = store.pickProposal(atMostOne("reject"));
      rejectProposal(store, p);
      out(`Rejected ${p.id}. Its inputs stay pending.`);
      return 0;
    }
    case "restore": {
      const p = positionals[0];
      if (!p || positionals.length > 1) throw new UsageError("Usage: nexorum restore <path> [--version N]");
      assertDocPath(p);
      const t = restorePath(openStore(), p, flags.version === undefined ? undefined : intFlag(flags, "version"));
      out(`Restored ${p} to version ${t.version} (${t.ts}).`);
      return 0;
    }
    case "history":
      out(formatHistory(openStore(), atMostOne("history")));
      return 0;
    case "retention": {
      const days = intFlag(flags, "days", { min: 0, fallback: 30 });
      out(`Removed ${runRetention(openStore(), days)} transcript(s) dreamed more than ${days} day(s) ago.`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${cmd}".`);
  }
}

/** `nexorum --space X dream` works like `nexorum dream --space X`: leading --space/--home pairs move behind the command. */
function hoistGlobalFlags(argv) {
  const lead = [];
  let i = 0;
  while (i < argv.length && (argv[i] === "--space" || argv[i] === "--home") && i + 1 < argv.length) {
    lead.push(argv[i], argv[i + 1]);
    i += 2;
  }
  if (!lead.length || i >= argv.length) return argv;
  return [argv[i], ...lead, ...argv.slice(i + 1)];
}

export async function main(rawArgv, env = process.env) {
  const [cmd, ...rest] = hoistGlobalFlags(rawArgv);
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(USAGE);
    return cmd === undefined ? 2 : 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    out(VERSION);
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    out(USAGE);
    return 0;
  }
  try {
    return (await dispatch(cmd, rest, env)) ?? 0;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`nexorum: ${e.message}\n`);
      return cmd === "hook" ? 0 : e.exitCode; // a hook never fails a session, not even on a mistyped sub-command
    }
    if (cmd === "hook") return 0;
    process.stderr.write(`nexorum: ${env.NEXORUM_DEBUG === "1" ? (e?.stack ?? e) : (e?.message ?? e)}\n`);
    return 1;
  }
}
