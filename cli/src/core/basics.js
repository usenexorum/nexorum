// Small shared helpers of the core library: hashing, ids, frontmatter, input splitting.
import crypto from "node:crypto";

/** Lower-case hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** `<prefix>_` followed by 16 random bytes in base64url (22 characters). */
export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("base64url")}`;
}

const FRONT_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FIELD_RE = /^([A-Za-z_][\w-]*):[ \t]*([\s\S]*)$/;

/**
 * Reads a leading `---` block of `key: value` lines. Keys are lower-cased, surrounding quotes dropped, the first
 * occurrence of a key wins.
 * @returns {{name:string|null, description:string|null, metadata:string|null, fields:Record<string,string>, body:string, hasFrontmatter:boolean}}
 */
export function parseFrontmatter(content) {
  const text = String(content ?? "").replace(/^\uFEFF/, "");
  const m = FRONT_RE.exec(text);
  if (!m) return { name: null, description: null, metadata: null, fields: {}, body: text, hasFrontmatter: false };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = FIELD_RE.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.at(-1) === q) value = value.slice(1, -1);
    if (!(key in fields)) fields[key] = value;
  }
  return {
    name: fields.name || null,
    description: fields.description || null,
    metadata: fields.metadata || null,
    fields,
    body: text.slice(m[0].length),
    hasFrontmatter: true,
  };
}

/** Inputs longer than this are analyzed in consecutive parts. */
export const MAX_PART_CHARS = 120_000;

function cutLong(block, max) {
  const pieces = [];
  let rest = block;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    let skip = 1;
    if (cut < max / 2) {
      cut = max;
      skip = 0;
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--; // keep surrogate pairs together
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Splits text into parts of at most `max` characters, preferring blank lines (event boundaries), then line breaks.
 * @returns {string[]} at least one part
 */
export function splitText(text, max = MAX_PART_CHARS) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = "";
  for (const block of text.split("\n\n")) {
    for (const piece of block.length > max ? cutLong(block, max) : [block]) {
      if (cur === "") cur = piece;
      else if (cur.length + 2 + piece.length <= max) cur += `\n\n${piece}`;
      else {
        parts.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) parts.push(cur);
  return parts;
}
