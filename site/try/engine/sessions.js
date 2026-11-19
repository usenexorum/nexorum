// Converters from other agents' session files to Nexorum transcript events ({role, content, name?, ts?}).
// Both are tolerant: lines they cannot use are skipped. Thinking blocks are dropped, tool output is clipped
// (it dominates real sessions and rarely holds the lesson), and only the most recent `maxEvents` are kept.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function json(v) {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  } catch {
    return "";
  }
}

function blockText(content, { images = false } = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (!isObj(b)) return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (images && b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function collector({ maxContentChars, maxToolChars }) {
  const events = [];
  const push = (role, content, name, ts) => {
    if (typeof content !== "string" || content.trim() === "") return;
    const limit = role === "tool" ? Math.min(maxToolChars, maxContentChars) : maxContentChars;
    let text = content.length > limit ? content.slice(0, limit) : content;
    if (role === "tool" && text.length < content.length) text = `${text}\n… [clipped ${content.length - text.length} more characters]`;
    const ev = { role, content: text };
    if (name) ev.name = name.slice(0, 64);
    if (ts) ev.ts = ts;
    events.push(ev);
  };
  return { events, push };
}

const isoOf = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

/**
 * Claude Code session JSONL. Sidechain (subagent) and meta lines are skipped; tool_use becomes a "tool" event
 * "call: <json>", tool_result a "tool" event "result: ..." named after its call.
 * @returns {{events:object[], skipped:number}}
 */
export function claudeCodeJsonlToEvents(jsonl, { maxEvents = 5000, maxContentChars = 50_000, maxToolChars = 4_000 } = {}) {
  const { events, push } = collector({ maxContentChars, maxToolChars });
  const toolNames = new Map();
  let skipped = 0;
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    const before = events.length;
    readLine(line);
    if (events.length === before) skipped++;
  }
  return { events: events.length > maxEvents ? events.slice(events.length - maxEvents) : events, skipped };

  function readLine(line) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(entry) || entry.isSidechain === true || entry.isMeta === true) return;
    const msg = entry.message;
    if (!isObj(msg) || (msg.role !== "user" && msg.role !== "assistant")) return;
    const ts = isoOf(entry.timestamp);
    if (typeof msg.content === "string") return push(msg.role, msg.content, undefined, ts);
    if (!Array.isArray(msg.content)) return;
    let texts = [];
    const flush = () => {
      if (texts.length) push(msg.role, texts.join("\n"), undefined, ts);
      texts = [];
    };
    for (const b of msg.content) {
      if (typeof b === "string") texts.push(b);
      else if (!isObj(b)) continue;
      else if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "tool_use") {
        flush();
        const name = typeof b.name === "string" && b.name ? b.name : "tool";
        if (typeof b.id === "string") toolNames.set(b.id, name);
        push("tool", `call: ${json(b.input)}`, name, ts);
      } else if (b.type === "tool_result") {
        flush();
        push("tool", `result: ${blockText(b.content) || json(b.content)}`, toolNames.get(b.tool_use_id) ?? "tool_result", ts);
      }
    }
    flush();
  }
}

/**
 * omp (oh-my-pi) session JSONL: a `session` header line (id, cwd, timestamp), an optional `title` line and
 * `message` lines with roles user / assistant (text, thinking, toolCall blocks) / toolResult.
 * @returns {{events:object[], skipped:number, meta:{id:string|null, cwd:string|null, startedAt:string|null, title:string|null}}}
 */
export function ompJsonlToEvents(jsonl, { maxEvents = 5000, maxContentChars = 50_000, maxToolChars = 4_000 } = {}) {
  const { events, push } = collector({ maxContentChars, maxToolChars });
  const toolNames = new Map();
  const meta = { id: null, cwd: null, startedAt: null, title: null };
  let skipped = 0;
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    const before = events.length;
    if (!readLine(line) && events.length === before) skipped++;
  }
  return { events: events.length > maxEvents ? events.slice(events.length - maxEvents) : events, skipped, meta };

  function readLine(line) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (!isObj(entry)) return false;
    if (entry.type === "session") {
      if (typeof entry.id === "string") meta.id = entry.id;
      if (typeof entry.cwd === "string") meta.cwd = entry.cwd;
      if (typeof entry.timestamp === "string") meta.startedAt = entry.timestamp;
      return true;
    }
    if (entry.type === "title") {
      if (typeof entry.title === "string") meta.title = entry.title.trim();
      return true;
    }
    if (entry.type !== "message" || !isObj(entry.message)) return false;
    const msg = entry.message;
    const ts = isoOf(entry.timestamp);
    if (msg.role === "user") {
      push("user", blockText(msg.content, { images: true }), undefined, ts);
      return true;
    }
    if (msg.role === "toolResult") {
      const name = typeof msg.toolName === "string" && msg.toolName ? msg.toolName : (toolNames.get(msg.toolCallId) ?? "tool");
      push("tool", `${msg.isError === true ? "error" : "result"}: ${blockText(msg.content, { images: true }) || json(msg.content)}`, name, ts);
      return true;
    }
    if (msg.role !== "assistant") return false;
    if (typeof msg.content === "string") {
      push("assistant", msg.content, undefined, ts);
      return true;
    }
    if (!Array.isArray(msg.content)) return true;
    let texts = [];
    const flush = () => {
      if (texts.length) push("assistant", texts.join("\n"), undefined, ts);
      texts = [];
    };
    for (const b of msg.content) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "toolCall") {
        flush();
        const name = typeof b.name === "string" && b.name ? b.name : "tool";
        if (typeof b.id === "string") toolNames.set(b.id, name);
        push("tool", `call: ${json(b.arguments)}`, name, ts);
      }
    }
    flush();
    return true;
  }
}
