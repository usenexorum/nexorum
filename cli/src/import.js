// `nexorum import omp`: omp (oh-my-pi) session files become transcripts, idempotently (the omp session id is the
// transcript id, so a grown session updates the same transcript and makes it pending again).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ompJsonlToEvents, scrubSecrets, sha256Hex } from "./core/index.js";
import { UsageError, selfCommand } from "./args.js";
import { Store, isSafeId, nexorumRoot, sanitizeSpace } from "./store.js";

const out = (s = "") => process.stdout.write(`${s}\n`);
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;

/** --dir, else $OMP_SESSIONS_DIR, else ~/.omp/agent/sessions. */
export function ompSessionsDir(flags, env) {
  if (flags.dir) return path.resolve(flags.dir);
  if (env.OMP_SESSIONS_DIR) return path.resolve(env.OMP_SESSIONS_DIR);
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), ".omp", "agent", "sessions");
}

function sameDir(a, b) {
  const norm = (p) => {
    let r = path.resolve(String(p));
    try {
      r = fs.realpathSync.native(r);
    } catch {}
    return r.replace(/[\\/]+$/, "");
  };
  const [x, y] = [norm(a), norm(b)];
  return process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The `session` header line, read from the first 64 KiB only. */
function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.includes('"type":"session"')) continue;
      try {
        const o = JSON.parse(line);
        if (o?.type === "session" && typeof o.id === "string") {
          return { id: o.id, cwd: typeof o.cwd === "string" ? o.cwd : null, timestamp: typeof o.timestamp === "string" ? o.timestamp : null };
        }
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

/** *.jsonl in the folder and in its direct subfolders. */
function sessionFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    throw new UsageError(`Cannot read the omp sessions folder ${root}: ${e.code ?? e.message}. Use --dir to point at it.`);
  }
  const files = [];
  const take = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".jsonl")) files.push(path.join(dir, f.name));
  };
  take(root);
  for (const d of entries) if (d.isDirectory()) take(path.join(root, d.name));
  return files;
}

/**
 * nexorum import omp [--dir D] [--session FILE] [--all] [--since ISO] [--space S]
 * Default: the sessions whose working directory is the current one. --all: every session, each into the space
 * named after its own working directory. --session: one file.
 */
export async function importCommand(positionals, flags, env) {
  const [kind, ...extra] = positionals;
  if (kind !== "omp" || extra.length) throw new UsageError("Usage: nexorum import omp [--dir D] [--session FILE] [--all] [--since ISO] [--space S]");
  let since = null;
  if (flags.since !== undefined) {
    since = Date.parse(flags.since);
    if (Number.isNaN(since)) throw new UsageError("--since must be an ISO date, for example 2026-11-01.");
  }
  let candidates;
  if (flags.session) {
    const file = path.resolve(flags.session);
    if (!fs.existsSync(file)) throw new UsageError(`No such file: ${file}`);
    candidates = [file];
  } else {
    candidates = sessionFiles(ompSessionsDir(flags, env));
  }

  const cwd = process.cwd();
  const root = nexorumRoot(env);
  let imported = 0;
  let unchanged = 0;
  let skipped = 0;
  const spaces = new Set();
  for (const file of candidates.sort()) {
    let header = null;
    try {
      header = readHeader(file);
    } catch {}
    if (!header) {
      skipped++;
      continue;
    }
    if (!flags.session && !flags.all && !(header.cwd && sameDir(header.cwd, cwd))) continue;
    if (since !== null && header.timestamp && Date.parse(header.timestamp) < since) continue;
    if (fs.statSync(file).size > MAX_SESSION_BYTES) {
      out(`skipped ${path.basename(file)}: larger than ${MAX_SESSION_BYTES} bytes`);
      skipped++;
      continue;
    }
    const { events, meta } = ompJsonlToEvents(fs.readFileSync(file, "utf8"));
    if (!events.length) {
      skipped++;
      continue;
    }
    const clean = events.map((e) => ({ ...e, content: scrubSecrets(String(e.content ?? "")).text }));
    const sessionId = meta.id ?? header.id;
    const id = isSafeId(`omp_${sessionId}`) ? `omp_${sessionId}` : `omp_${sha256Hex(sessionId).slice(0, 32)}`;
    const space = sanitizeSpace(flags.space ?? env.NEXORUM_SPACE ?? path.basename(path.resolve(header.cwd ?? cwd)));
    const { transcript, changed } = new Store(root, space).upsertTranscript({ id, source: "omp", externalId: sessionId, events: clean });
    spaces.add(space);
    if (changed) {
      imported++;
      out(`imported ${transcript.id} (${clean.length} events) into space "${space}"${meta.title ? `: ${meta.title}` : ""}`);
    } else unchanged++;
  }
  out(`Done: ${imported} imported, ${unchanged} unchanged, ${skipped} skipped${spaces.size ? `. Spaces: ${[...spaces].join(", ")}` : ""}.`);
  if (!imported && !unchanged && !skipped) {
    out("No omp sessions matched. Sessions are matched by working directory; use --all to import every session, or --dir to point at another sessions folder.");
  }
  if (imported) out(`Next: ${selfCommand()} dream   (reads pending transcripts; needs your LLM settings, see "${selfCommand()} --help"), or ask your agent to run a Nexorum dream (no key needed)`);
  return 0;
}
