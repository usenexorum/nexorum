// In-memory wiki with the synchronous document API the dream engine works against (the staging wiki).
// Errors carry `.code`: "conflict" | "not_found" | "invalid_path" | "too_large" | "quota".
import { parseFrontmatter, sha256Hex } from "./basics.js";

export const MAX_PATH_CHARS = 200;
export const MAX_DOC_BYTES = 100_000;
export const MAX_DOCS = 2000;

const PATH_RE = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function docError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Same rule as the CLI's isDocPath: whatever a dream may write, `apply` must be able to write to disk. */
export function validatePath(p) {
  const okay = typeof p === "string" && p.length <= MAX_PATH_CHARS && PATH_RE.test(p) && !p.includes("..") && !p.split("/").includes(".");
  if (!okay) {
    throw docError(
      "invalid_path",
      `Invalid path: it must start with "/", use segments of letters, digits, ".", "_" or "-", contain no ".." and no "." segment, and be at most ${MAX_PATH_CHARS} characters.`,
    );
  }
  return p;
}

const bytesOf = (s) => new TextEncoder().encode(String(s)).length;
const byPath = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

export class MemoryWiki {
  constructor(initial = {}, { maxDocs = MAX_DOCS, maxBytes = MAX_DOC_BYTES } = {}) {
    this.maxDocs = maxDocs;
    this.maxBytes = maxBytes;
    this.docs = new Map();
    for (const [p, content] of Object.entries(initial ?? {})) this.#put(validatePath(p), String(content));
  }

  #put(p, content) {
    const sha256 = sha256Hex(content);
    this.docs.set(p, { content, sha256, bytes: bytesOf(content) });
    return { path: p, sha256 };
  }

  list({ prefix } = {}) {
    if (prefix && !String(prefix).startsWith("/")) throw docError("invalid_path", 'prefix must start with "/"');
    return [...this.docs.entries()]
      .filter(([p]) => !prefix || p.startsWith(prefix))
      .sort(byPath)
      .map(([p, d]) => {
        const fm = parseFrontmatter(d.content);
        return { path: p, bytes: d.bytes, sha256: d.sha256, name: fm.name, description: fm.description };
      });
  }

  get(p) {
    validatePath(p);
    const d = this.docs.get(p);
    return d ? { path: p, content: d.content, sha256: d.sha256 } : null;
  }

  has(p) {
    return this.docs.has(p);
  }

  /** Create or replace. With `expectSha256` the current content must have that hash (a missing doc never matches). */
  write(p, content, { expectSha256 } = {}) {
    validatePath(p);
    if (typeof content !== "string") throw docError("too_large", "content must be a string");
    if (bytesOf(content) > this.maxBytes) throw docError("too_large", `Document exceeds ${this.maxBytes} bytes.`);
    const cur = this.docs.get(p);
    if (expectSha256 != null && (cur?.sha256 ?? null) !== expectSha256) throw docError("conflict", `${p} changed since it was read.`);
    if (!cur && this.docs.size >= this.maxDocs) throw docError("quota", `Document limit of ${this.maxDocs} reached.`);
    return this.#put(p, content);
  }

  delete(p) {
    validatePath(p);
    if (!this.docs.delete(p)) throw docError("not_found", `${p} does not exist.`);
  }

  rename(from, to) {
    validatePath(from);
    validatePath(to);
    const d = this.docs.get(from);
    if (!d) throw docError("not_found", `${from} does not exist.`);
    if (this.docs.has(to)) throw docError("conflict", `${to} already exists.`);
    this.docs.delete(from);
    this.docs.set(to, d);
  }

  /** @returns {Record<string,string>} path -> content, sorted by path */
  snapshot() {
    return Object.fromEntries([...this.docs.entries()].sort(byPath).map(([p, d]) => [p, d.content]));
  }

  /** An independent copy with the same limits. */
  clone() {
    const c = new MemoryWiki({}, { maxDocs: this.maxDocs, maxBytes: this.maxBytes });
    for (const [p, d] of this.docs) c.docs.set(p, { ...d });
    return c;
  }
}
