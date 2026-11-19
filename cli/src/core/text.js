// How inputs are shown to the dream agents (labelled plain text), and the context digest injected at session start.

export const INDEX_PATH = "/_index.md";

// A content line that looks like one of our labels gets a leading space, so data cannot fake a new turn.
const LOOKS_LIKE_LABEL = /^(?:USER:|ASSISTANT:|SYSTEM:|TOOL .*:|TRANSCRIPT\s|NOTES\s)/;
const LABEL = { user: "USER", assistant: "ASSISTANT", system: "SYSTEM" };

function body(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (LOOKS_LIKE_LABEL.test(line) ? ` ${line}` : line))
    .join("\n");
}

/** @param {{id:string, source:string, events:{role:string, content:string, name?:string}[]}} t */
export function renderTranscript({ id, source, events }) {
  const list = Array.isArray(events) ? events : [];
  const blocks = list.map((e) => {
    if (e?.role === "tool") {
      const name = String(e.name || "tool").replace(/[\r\n:]+/g, " ").trim() || "tool";
      return `TOOL ${name}:\n${body(e.content)}`;
    }
    return `${LABEL[e?.role] ?? "SYSTEM"}:\n${body(e?.content)}`;
  });
  return [`TRANSCRIPT ${id} source=${source} events=${list.length}`, ...blocks].join("\n\n");
}

/** @param {{id:string, ts:string, content:string}[]} notes */
export function renderNotes(notes) {
  const list = Array.isArray(notes) ? notes : [];
  const head = `NOTES source=notes count=${list.length}`;
  if (!list.length) return head;
  const lines = list.map((n) => `- [${n.ts}] (${n.id}) ${String(n.content ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").replace(/\n/g, "\n  ")}`);
  return `${head}\n\n${lines.join("\n")}`;
}

/**
 * The digest: /_index.md cut at the last whole line that fits, or else the newest notes ("Recent notes:\n- ...").
 * @param {Record<string,string>|{get:(p:string)=>({content:string}|null)}|null} wiki a snapshot or a document API such as
 *   MemoryWiki (only the index is read)
 * @returns {{content:string, source:"index"|"notes"|"empty", truncated:boolean}}
 */
export function buildContext(wiki, notes = [], { maxChars = 4096 } = {}) {
  let index = null;
  if (wiki && typeof wiki.get === "function") index = wiki.get(INDEX_PATH)?.content ?? null;
  else if (wiki && typeof wiki === "object" && Object.hasOwn(wiki, INDEX_PATH)) index = String(wiki[INDEX_PATH]);
  if (index !== null && index.trim() !== "") {
    if (index.length <= maxChars) return { content: index, source: "index", truncated: false };
    let cut = index.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = maxChars;
    return { content: index.slice(0, cut), source: "index", truncated: true };
  }
  const newest = (Array.isArray(notes) ? notes : [])
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n && typeof n.content === "string" && n.content.trim() !== "")
    .sort((a, b) => (a.n.ts === b.n.ts ? b.i - a.i : a.n.ts < b.n.ts ? 1 : -1))
    .map(({ n }) => n);
  if (!newest.length) return { content: "", source: "empty", truncated: false };
  let content = "Recent notes:";
  let used = 0;
  for (const n of newest) {
    const line = `\n- ${n.content.replace(/\s+/g, " ").trim()}`;
    if (content.length + line.length > maxChars) break;
    content += line;
    used++;
  }
  if (!used) return { content: "", source: "empty", truncated: true };
  return { content, source: "notes", truncated: used < newest.length };
}
