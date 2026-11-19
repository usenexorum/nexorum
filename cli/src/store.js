// The memory folder of one space: notes, transcripts, the live wiki with versioned history, and dream proposals.
//
//   <home>/spaces/<space>/
//     notes.jsonl              one note per line
//     state.json               notes_consolidated_through (newest note a dream has folded into the wiki)
//     transcripts/<id>.json    sessions, status pending -> dreamed
//     wiki/                    live markdown pages (_index.md is the catalog)
//     history/log.jsonl        one entry per live write; files/<n>-<sha8> holds the content of entry n
//     proposals/<id>/          proposal.json, base.json (live hashes at dream start), wiki/ (staged copy)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { sha256Hex, newId } from "./core/index.js";
import { CliError, UsageError } from "./args.js";

const DOC_PATH_RE = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const TMP_NAME_RE = /\.tmp-\d+-[0-9a-f]+$/;

export function userHome(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function nexorumRoot(env = process.env) {
  return env.NEXORUM_HOME ? path.resolve(env.NEXORUM_HOME) : path.join(userHome(env), ".nexorum");
}

/** Characters outside A-Za-z0-9_.- become "-", at most 64 characters, "default" for nothing usable. */
export function sanitizeSpace(name) {
  const s = String(name ?? "").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
  return s === "" || s === "." || s === ".." || /^-+$/.test(s) ? "default" : s;
}

/** --space, else $NEXORUM_SPACE, else the name of the current folder. */
export function resolveSpace({ space, env = process.env, cwd = process.cwd() } = {}) {
  const chosen = space ?? (env.NEXORUM_SPACE || undefined);
  return sanitizeSpace(chosen !== undefined ? chosen : path.basename(path.resolve(cwd)));
}

export function isDocPath(p) {
  return typeof p === "string" && p.length <= 200 && DOC_PATH_RE.test(p) && !p.includes("..") && !p.split("/").includes(".");
}

export function assertDocPath(p) {
  if (!isDocPath(p)) throw new UsageError(`Invalid document path "${p}". Use something like /topic.md (letters, digits, . _ - and folders).`);
}

export function isSafeId(id) {
  return typeof id === "string" && ID_RE.test(id) && id !== "." && id !== "..";
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Temp file + rename. Windows can briefly refuse the rename while another process reads the file; retry a few times. */
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, data);
  let err;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      err = e;
      if (!["EPERM", "EACCES", "EBUSY"].includes(e.code)) break;
      pause(20 * attempt);
    }
  }
  fs.rmSync(tmp, { force: true });
  throw err;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function readJson(file, fallback) {
  const text = readText(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${file} is not valid JSON.`);
  }
}

/** Unparsable lines are skipped. */
function readJsonLines(file) {
  const text = readText(file);
  if (text === null) return [];
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Appends one JSON line. If a crash left the last line without "\n", one is added first so both records survive. */
function appendJsonLine(file, value) {
  let lead = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const { size } = fs.fstatSync(fd);
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) lead = "\n";
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.appendFileSync(file, `${lead}${JSON.stringify(value)}\n`);
}

/** Walks a wiki folder: valid document paths only, temp files skipped. `read` false counts without reading. */
function walkWiki(root, onFile) {
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && isDocPath(r) && !TMP_NAME_RE.test(e.name)) onFile(r, path.join(dir, e.name));
    }
  };
  walk(root, "");
}

function readTree(root) {
  const out = {};
  walkWiki(root, (rel, file) => (out[rel] = fs.readFileSync(file, "utf8")));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const now = () => new Date().toISOString();
const linesOf = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

export class Store {
  constructor(root, space) {
    this.root = root;
    this.space = space;
    this.dir = path.join(root, "spaces", space);
    this.wikiDir = path.join(this.dir, "wiki");
    this.transcriptsDir = path.join(this.dir, "transcripts");
    this.notesFile = path.join(this.dir, "notes.jsonl");
    this.stateFile = path.join(this.dir, "state.json");
    this.historyDir = path.join(this.dir, "history");
    this.historyLog = path.join(this.historyDir, "log.jsonl");
    this.historyFiles = path.join(this.historyDir, "files");
    this.proposalsDir = path.join(this.dir, "proposals");
  }

  static open({ space, env = process.env, cwd } = {}) {
    return new Store(nexorumRoot(env), resolveSpace({ space, env, cwd }));
  }

  // ---------------------------------------------------------------- notes
  readNotes() {
    return readJsonLines(this.notesFile).filter((n) => n && typeof n.id === "string" && typeof n.content === "string");
  }

  appendNote(content, metadata) {
    const note = { id: newId("note"), ts: now(), content };
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) note.metadata = metadata;
    fs.mkdirSync(this.dir, { recursive: true });
    appendJsonLine(this.notesFile, note);
    return note;
  }

  removeNote(id) {
    const notes = this.readNotes();
    const rest = notes.filter((n) => n.id !== id);
    if (rest.length === notes.length) return false;
    atomicWrite(this.notesFile, linesOf(rest));
    return true;
  }

  /** Same id and position; `ts` becomes now (so the next dream rereads it) and the first time stays in created_at. */
  updateNote(id, content, metadata) {
    const notes = this.readNotes();
    const i = notes.findIndex((n) => n.id === id);
    if (i < 0) return null;
    const old = notes[i];
    notes[i] = { ...old, content, ts: now(), created_at: old.created_at ?? old.ts, ...(metadata !== undefined ? { metadata } : {}) };
    atomicWrite(this.notesFile, linesOf(notes));
    return notes[i];
  }

  // ---------------------------------------------------------------- state
  readState() {
    const s = readJson(this.stateFile, {});
    return { notes_consolidated_through: typeof s?.notes_consolidated_through === "string" ? s.notes_consolidated_through : null };
  }

  writeState(state) {
    atomicWrite(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  // ---------------------------------------------------------------- transcripts
  transcriptFile(id) {
    if (!isSafeId(id)) throw new UsageError(`Invalid transcript id "${id}" (letters, digits, _ . - only, up to 128 chars).`);
    return path.join(this.transcriptsDir, `${id}.json`);
  }

  getTranscript(id) {
    return readJson(this.transcriptFile(id), null);
  }

  saveTranscript(t) {
    atomicWrite(this.transcriptFile(t.id), `${JSON.stringify(t)}\n`);
  }

  listTranscripts() {
    let names;
    try {
      names = fs.readdirSync(this.transcriptsDir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const out = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(this.transcriptsDir, n), "utf8"));
        if (t && typeof t.id === "string" && Array.isArray(t.events)) out.push(t);
      } catch {}
    }
    return out;
  }

  deleteTranscript(id) {
    fs.rmSync(this.transcriptFile(id), { force: true });
  }

  /** Create, or update in place. Changed events make it pending again; identical events change nothing. */
  upsertTranscript({ id, source, externalId = null, events, namespace }) {
    const existing = this.getTranscript(id);
    const ts = now();
    if (existing) {
      if (sha256Hex(JSON.stringify(existing.events)) === sha256Hex(JSON.stringify(events))) return { transcript: existing, changed: false };
      const t = { ...existing, source: source ?? existing.source, events, updated_at: ts, status: "pending", dreamed_at: null };
      this.saveTranscript(t);
      return { transcript: t, changed: true };
    }
    const t = { id, source, external_id: externalId, namespace: namespace ?? this.space, created_at: ts, updated_at: ts, status: "pending", dreamed_at: null, events };
    this.saveTranscript(t);
    return { transcript: t, changed: true };
  }

  // ---------------------------------------------------------------- live wiki
  docFile(p) {
    assertDocPath(p);
    return path.join(this.wikiDir, ...p.slice(1).split("/"));
  }

  readDoc(p) {
    try {
      return fs.readFileSync(this.docFile(p), "utf8");
    } catch (e) {
      if (["ENOENT", "EISDIR", "ENOTDIR"].includes(e.code)) return null;
      throw e;
    }
  }

  wikiSnapshot() {
    return readTree(this.wikiDir);
  }

  /** Number of wiki pages, without reading them. */
  wikiCount() {
    let n = 0;
    walkWiki(this.wikiDir, () => n++);
    return n;
  }

  // ---------------------------------------------------------------- history
  readHistory() {
    return readJsonLines(this.historyLog);
  }

  /** Entries of one path, oldest first, numbered from 1. */
  versionsOf(p) {
    return this.readHistory()
      .filter((e) => e.path === p)
      .map((e, i) => ({ ...e, version: i + 1 }));
  }

  readSnapshotFile(file) {
    if (!isSafeId(file)) return null; // names are "<n>-<sha8>"; nothing else may reach the file system
    return readText(path.join(this.historyFiles, file));
  }

  #record({ p, operation, actor, content }) {
    let sha = null;
    let file = null;
    if (content !== null) {
      sha = sha256Hex(content);
      file = `${this.readHistory().length + 1}-${sha.slice(0, 8)}`;
      atomicWrite(path.join(this.historyFiles, file), content);
    }
    const entry = { ts: now(), path: p, operation, actor, sha256: sha, file };
    fs.mkdirSync(this.historyDir, { recursive: true });
    appendJsonLine(this.historyLog, entry);
    return entry;
  }

  /** A page edited by hand since its last recorded version is recorded first (actor "user"), so it stays restorable. */
  #keepHandEdit(p, current) {
    if (current === null) return;
    const last = this.versionsOf(p).at(-1);
    if (last && last.sha256 === sha256Hex(current)) return;
    this.#record({ p, operation: last ? "update" : "create", actor: "user", content: current });
  }

  /** Writes one live page and records it. Returns the history entry, or null when the content is unchanged. */
  writeDoc(p, content, { actor = "user", operation } = {}) {
    const file = this.docFile(p);
    const current = this.readDoc(p);
    if (current === content) return null;
    this.#keepHandEdit(p, current);
    const entry = this.#record({ p, operation: operation ?? (current === null ? "create" : "update"), actor, content });
    atomicWrite(file, content);
    return entry;
  }

  deleteDoc(p, { actor = "user" } = {}) {
    const file = this.docFile(p);
    const current = this.readDoc(p);
    if (current === null) return null;
    this.#keepHandEdit(p, current);
    const entry = this.#record({ p, operation: "delete", actor, content: null });
    fs.rmSync(file, { force: true });
    // Remove folders the deletion left empty.
    for (let dir = path.dirname(file); dir !== this.wikiDir && dir.startsWith(this.wikiDir); dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
    }
    return entry;
  }

  // ---------------------------------------------------------------- proposals
  proposalDir(id) {
    if (!isSafeId(id)) throw new UsageError(`Invalid proposal id "${id}".`);
    return path.join(this.proposalsDir, id);
  }

  newProposalId() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    return `dream-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
  }

  readProposal(id) {
    return readJson(path.join(this.proposalDir(id), "proposal.json"), null);
  }

  writeProposal(p) {
    atomicWrite(path.join(this.proposalDir(p.id), "proposal.json"), `${JSON.stringify(p, null, 2)}\n`);
  }

  readBase(id) {
    return readJson(path.join(this.proposalDir(id), "base.json"), {});
  }

  writeBase(id, base) {
    atomicWrite(path.join(this.proposalDir(id), "base.json"), `${JSON.stringify(base, null, 2)}\n`);
  }

  proposalWikiDir(id) {
    return path.join(this.proposalDir(id), "wiki");
  }

  /** Replaces the staged copy with `snapshot` ({path: content}). */
  writeProposalWiki(id, snapshot) {
    const dir = this.proposalWikiDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [p, content] of Object.entries(snapshot)) {
      assertDocPath(p);
      atomicWrite(path.join(dir, ...p.slice(1).split("/")), content);
    }
  }

  readProposalWiki(id) {
    return readTree(this.proposalWikiDir(id));
  }

  /** Oldest first. Folders without a readable proposal.json (open agent-dream drafts) are left out. */
  listProposals() {
    let names;
    try {
      names = fs.readdirSync(this.proposalsDir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const out = [];
    for (const n of names) {
      if (!isSafeId(n)) continue;
      try {
        const p = this.readProposal(n);
        if (p && p.id === n) out.push(p);
      } catch {}
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  }

  /** By id or unique id prefix; without one, the newest proposal in `preferStatus`, else the newest of all. */
  pickProposal(id, preferStatus = "review") {
    const all = this.listProposals();
    if (id) {
      const exact = all.find((p) => p.id === id);
      if (exact) return exact;
      const hits = all.filter((p) => p.id.startsWith(id));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new UsageError(`"${id}" matches several proposals; use a longer id.`);
      throw new CliError(`No proposal "${id}" in space "${this.space}". Run: nexorum proposals`);
    }
    const chosen = all.filter((p) => p.status === preferStatus).at(-1) ?? all.at(-1);
    if (!chosen) throw new CliError(`No proposals in space "${this.space}". Run: nexorum dream`);
    return chosen;
  }
}
