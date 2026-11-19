// `nexorum hook session-start|user-prompt|stop`: Claude Code hooks (hook JSON on stdin). They never fail a session:
// always exit 0, and errors go to stderr only with NEXORUM_DEBUG=1.
import fs from "node:fs";
import path from "node:path";
import { claudeCodeJsonlToEvents, scrubSecrets, sha256Hex } from "./core/index.js";
import { Store, atomicWrite, isSafeId, nexorumRoot, sanitizeSpace } from "./store.js";
import { contextFor, formatPromptRecall, promptRecall } from "./memory.js";

export const MAX_CONTEXT_CHARS = 10_000;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const SEEN_FILE = "hook-seen.json";
const SEEN_SESSIONS = 20;
const SEEN_IDS = 200;

async function readStdin(input) {
  if (input.isTTY) return "";
  const chunks = [];
  for await (const c of input) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

/** The space is --space, else NEXORUM_SPACE, else the name of the hook's cwd. */
function hookStore(input, flags, env) {
  const space = flags.space ?? (env.NEXORUM_SPACE || undefined);
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  return new Store(nexorumRoot(env), sanitizeSpace(space ?? path.basename(path.resolve(cwd))));
}

const hookJson = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text.slice(0, MAX_CONTEXT_CHARS) } });

/** SessionStart: the digest as additionalContext, or "" when memory is empty. */
export function sessionStartOutput(store) {
  const { content } = contextFor(store, 4096);
  return content ? hookJson("SessionStart", `Nexorum memory (space "${store.space}"):\n${content}`) : "";
}

function readSeen(store) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(store.dir, SEEN_FILE), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** UserPromptSubmit: matching memory not yet shown in this session, or "" (also when NEXORUM_PROMPT_RECALL=0). */
export function userPromptOutput(store, input, env = process.env) {
  if (env.NEXORUM_PROMPT_RECALL === "0") return "";
  const session = String(input.session_id ?? "");
  const seen = readSeen(store);
  const shown = new Set(Array.isArray(seen[session]) ? seen[session] : []);
  const items = promptRecall(store, input.prompt, shown);
  const text = formatPromptRecall(store.space, items);
  if (!text) return "";
  if (session) {
    delete seen[session]; // re-inserted last, so the most recent sessions are the ones kept
    seen[session] = [...shown, ...items.map((i) => i.id)].slice(-SEEN_IDS);
    const keep = Object.keys(seen).slice(-SEEN_SESSIONS);
    try {
      fs.mkdirSync(store.dir, { recursive: true });
      atomicWrite(path.join(store.dir, SEEN_FILE), `${JSON.stringify(Object.fromEntries(keep.map((k) => [k, seen[k]])))}\n`);
    } catch {}
  }
  return hookJson("UserPromptSubmit", text);
}

/** Stop: stores the session JSONL at transcript_path as a pending transcript (id = session id). */
export function recordStop(store, input) {
  const sessionId = String(input.session_id ?? "");
  const file = input.transcript_path;
  if (!sessionId || typeof file !== "string" || !file) return false;
  if (fs.statSync(file).size > MAX_READ_BYTES) throw new Error(`transcript is larger than ${MAX_READ_BYTES} bytes`);
  const { events } = claudeCodeJsonlToEvents(fs.readFileSync(file, "utf8"));
  if (!events.length) return false;
  const clean = events.map((e) => ({ ...e, content: scrubSecrets(String(e.content ?? "")).text }));
  const id = isSafeId(sessionId) ? sessionId : `cc_${sha256Hex(sessionId).slice(0, 32)}`;
  store.upsertTranscript({ id, source: "claude-code", externalId: sessionId, events: clean });
  return true;
}

export async function hookCommand(sub, flags, env, { input = process.stdin, output = process.stdout } = {}) {
  try {
    let data = {};
    const raw = (await readStdin(input)).trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") data = parsed;
      } catch {}
    }
    const store = hookStore(data, flags, env);
    let text = "";
    if (sub === "session-start") text = sessionStartOutput(store);
    else if (sub === "user-prompt") text = userPromptOutput(store, data, env);
    else if (sub === "stop") recordStop(store, data);
    if (text) output.write(`${text}\n`);
  } catch (e) {
    if (env.NEXORUM_DEBUG === "1") process.stderr.write(`nexorum hook ${sub}: ${e?.stack ?? e}\n`);
  }
  return 0;
}
