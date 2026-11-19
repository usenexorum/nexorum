// Transcripts from agents without hooks: `nexorum log` and the save_transcript MCP tool.
import { scrubSecrets, newId } from "./core/index.js";
import { UsageError } from "./args.js";
import { isSafeId } from "./store.js";

export const ROLES = new Set(["user", "assistant", "system", "tool"]);
export const MAX_EVENTS = 5000;
export const MAX_TRANSCRIPT_CHARS = 2_000_000;

/** Validates {role, content, name?, ts?} events and redacts secrets. Throws UsageError. */
export function normalizeEvents(list) {
  if (!Array.isArray(list) || list.length === 0) throw new UsageError("Expected a non-empty array of events ({role, content}).");
  if (list.length > MAX_EVENTS) throw new UsageError(`At most ${MAX_EVENTS} events per transcript (got ${list.length}); split it or send the most recent ones.`);
  let chars = 0;
  const events = list.map((e, i) => {
    if (!e || typeof e !== "object" || !ROLES.has(e.role)) throw new UsageError(`Event ${i}: role must be one of user, assistant, system, tool.`);
    const content = typeof e.content === "string" ? e.content : JSON.stringify(e.content ?? "");
    chars += content.length;
    const ev = { role: e.role, content: scrubSecrets(content).text };
    if (typeof e.name === "string") ev.name = e.name;
    if (typeof e.ts === "string" || typeof e.ts === "number") ev.ts = e.ts;
    return ev;
  });
  if (chars > MAX_TRANSCRIPT_CHARS) throw new UsageError(`Transcript is ${chars} characters; the limit is ${MAX_TRANSCRIPT_CHARS}. Send the most recent part.`);
  return events;
}

/**
 * Stores a session. The same id replaces it, and it becomes pending again only when the events changed, so an
 * agent can re-send a growing session.
 * @returns {{id:string, count:number, changed:boolean, status:string}}
 */
export function saveTranscript(store, { events, id, source }) {
  const clean = normalizeEvents(events);
  const tid = id ?? newId("trn");
  if (!isSafeId(tid)) throw new UsageError("id may only contain letters, digits, _ . - (up to 128 characters).");
  const src = typeof source === "string" && source ? source.slice(0, 64) : "mcp";
  const { transcript, changed } = store.upsertTranscript({ id: tid, source: src, externalId: id ?? null, events: clean });
  return { id: transcript.id, count: clean.length, changed, status: transcript.status };
}
