// Document tools for the dream agents. One toolbox per agent conversation. It remembers the hash of every document
// the agent has read completely: replacing an existing document with write_doc requires such a read, and that hash
// is the write's precondition, so an agent never overwrites a parallel agent's change unseen.
// All handlers are synchronous, so a check and the write after it cannot interleave with another agent.
import { INDEX_PATH } from "../text.js";
import { MAX_DOC_BYTES } from "../wiki.js";

export const MAX_TOOL_OUTPUT_CHARS = 30_000;
export const MAX_READ_CHARS = 28_000;
export const MAX_GREP_RESULTS = 200;
export const DEFAULT_GREP_RESULTS = 40;
export const INDEX_MAX_CHARS = 4_096;
const GREP_SCAN_LIMIT = 5_000_000;
const GREP_LINE_LIMIT = 2_000;
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[+*{]/;
const MAX_INDEX_REJECTIONS = 2;

const pathProp = { type: "string", description: 'Document path such as "/deploys.md". Must start with "/".' };
const schema = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });

const DEFS = {
  list_docs: {
    name: "list_docs",
    description: "List documents: path, size, short sha and the frontmatter name and description. Optional path prefix (a prefix ending in / selects a folder).",
    input_schema: schema({ prefix: { type: "string", description: 'Optional path prefix starting with "/".' } }),
  },
  read_doc: {
    name: "read_doc",
    description: `Read one document, up to ${MAX_READ_CHARS} characters per call; page through longer ones with offset. Only a complete read in this conversation allows write_doc to replace an existing document.`,
    input_schema: schema({ path: pathProp, offset: { type: "integer", minimum: 0, description: "Character offset (default 0)." } }, ["path"]),
  },
  grep_docs: {
    name: "grep_docs",
    description: `Search every document line by line with a JavaScript regular expression (case-insensitive unless ignore_case is false). Returns "path:line: text", at most ${MAX_GREP_RESULTS} matches.`,
    input_schema: schema(
      {
        pattern: { type: "string", description: "Regular expression source, without slashes or flags." },
        prefix: { type: "string", description: 'Only paths with this prefix (starting with "/").' },
        ignore_case: { type: "boolean", description: "Default true." },
        max_results: { type: "integer", minimum: 1, maximum: MAX_GREP_RESULTS, description: `Default ${DEFAULT_GREP_RESULTS}.` },
      },
      ["pattern"],
    ),
  },
  write_doc: {
    name: "write_doc",
    description:
      "Create a document, or replace the whole content of one. Replacing needs a complete read_doc of it earlier in this conversation; if it changed since, the write fails with a conflict: re-read, merge, write again. Prefer edit_doc for small changes.",
    input_schema: schema({ path: pathProp, content: { type: "string", description: "The complete new content." } }, ["path", "content"]),
  },
  edit_doc: {
    name: "edit_doc",
    description:
      "Replace exactly one occurrence of old_string with new_string in the document's CURRENT content. Fails when old_string is missing or occurs more than once (add context to make it unique). Best for shared files such as /_index.md.",
    input_schema: schema(
      {
        path: pathProp,
        old_string: { type: "string", description: "The exact text to replace, whitespace included." },
        new_string: { type: "string", description: "The replacement (empty deletes)." },
      },
      ["path", "old_string", "new_string"],
    ),
  },
  delete_doc: {
    name: "delete_doc",
    description: "Delete a document, only once its content lives elsewhere or it is an exact duplicate. Every change is versioned and reviewed.",
    input_schema: schema({ path: pathProp }, ["path"]),
  },
  rename_doc: {
    name: "rename_doc",
    description: "Rename or move a document. Fails when the destination exists. Fix [[links]] and /_index.md yourself afterwards.",
    input_schema: schema({ from: pathProp, to: pathProp }, ["from", "to"]),
  },
};

const SUBMIT = {
  analyzer: {
    name: "submit",
    description: "Finish. Call it exactly once, after your last write has been confirmed; never in the same turn as writes whose results you have not seen.",
    input_schema: schema(
      {
        summary: { type: "string", description: "What you verified, corrected and added, and what is contradictory or uncertain for the organizer." },
        touched: { type: "array", items: { type: "string" }, description: "Paths you created or changed." },
      },
      ["summary"],
    ),
  },
  organizer: {
    name: "submit",
    description: `Finish. Call it exactly once, when the wiki is consistent. ${INDEX_PATH} must exist.`,
    input_schema: schema(
      {
        summary: { type: "string", description: "What you merged, fixed and found, in a few sentences." },
        changes: { type: "array", items: { type: "string" }, description: "One short line per notable change (merged, split, deleted, conflict marked, link fixed ...)." },
      },
      ["summary", "changes"],
    ),
  },
};

const ANALYZER_TOOLS = ["list_docs", "read_doc", "grep_docs", "write_doc", "edit_doc"];
const ORGANIZER_TOOLS = [...ANALYZER_TOOLS, "delete_doc", "rename_doc"];

export function toolDefinitions(role) {
  if (role === "analyzer") return [...ANALYZER_TOOLS.map((n) => DEFS[n]), SUBMIT.analyzer];
  if (role === "organizer") return [...ORGANIZER_TOOLS.map((n) => DEFS[n]), SUBMIT.organizer];
  throw new Error(`unknown role ${role}`);
}

export function clip(text, max = MAX_TOOL_OUTPUT_CHARS) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}\n[output truncated: ${s.length - max} more characters]`;
}
const short = (s, n = 80) => clip(String(s), n).replace(/\n\[output truncated.*$/s, "...");
const fail = (text) => ({ text: clip(text), isError: true });
const done = (text) => ({ text: clip(text), isError: false });
const bytesOf = (s) => new TextEncoder().encode(String(s)).length;

function explain(e, p) {
  switch (e?.code) {
    case "conflict":
      return `Conflict: ${p} changed since you last read it (another agent updated it, or it already exists or was moved). Re-read it with read_doc, merge your change into the current content and write again, or use edit_doc.`;
    case "not_found":
      return `Not found: ${e.message}`;
    case "invalid_path":
      return e.message;
    case "too_large":
      return `Too large: ${e.message} Split the content into smaller linked files (the hard limit is ${MAX_DOC_BYTES} bytes; aim far lower).`;
    case "quota":
      return `Document quota reached: ${e.message} Merge or delete documents before creating more.`;
    default:
      return `Document error: ${e?.message ?? e}`;
  }
}

/**
 * @param {{docs:object, role:"analyzer"|"organizer", scrub:(s:string)=>{text:string,count:number,kinds:string[]}, stats:{mutations:number, redactions:number}}} o
 */
export function createToolbox({ docs, role, scrub, stats }) {
  const seen = new Map(); // path -> sha256 of the content this agent has read completely
  let indexRejections = 0;
  const definitions = toolDefinitions(role);
  const allowed = new Set(definitions.map((d) => d.name));

  const clean = (content) => {
    const r = scrub(content);
    stats.redactions += r.count;
    const note = r.count
      ? `\nNote: ${r.count} secret-looking value(s) (${r.kinds.join(", ")}) were replaced with [REDACTED:...]. Never write secrets; record only the credential's name and where it is kept.`
      : "";
    return { text: r.text, note };
  };
  const lookup = (p) => {
    try {
      return { doc: docs.get(p) };
    } catch (e) {
      return { error: fail(explain(e, p)) };
    }
  };

  const handlers = {
    list_docs({ prefix }) {
      if (prefix !== undefined && typeof prefix !== "string") return fail("prefix must be a string.");
      if (prefix && !prefix.startsWith("/")) return fail('prefix must start with "/".');
      const items = docs.list(prefix ? { prefix } : {});
      if (!items.length) return done(prefix ? `No documents under ${prefix}.` : "No documents yet.");
      const lines = items.map((d) => {
        const label = [d.name, d.description].filter(Boolean).join(": ");
        return `- ${d.path} (${d.bytes} bytes, sha ${d.sha256.slice(0, 8)})${label ? ` ${short(label, 160)}` : ""}`;
      });
      return done(`${items.length} document(s):\n${lines.join("\n")}`);
    },

    read_doc({ path: p, offset = 0 }) {
      if (typeof p !== "string") return fail("path must be a string.");
      if (!Number.isInteger(offset) || offset < 0) return fail("offset must be a non-negative integer.");
      const { doc, error } = lookup(p);
      if (error) return error;
      if (!doc) return fail(`Not found: ${p} does not exist.`);
      const total = doc.content.length;
      if (total === 0) {
        seen.set(p, doc.sha256);
        return done("[document is empty]");
      }
      if (offset >= total) return fail(`offset ${offset} is past the end of the document (${total} characters).`);
      const end = Math.min(total, offset + MAX_READ_CHARS);
      const part = doc.content.slice(offset, end);
      if (offset === 0 && end === total) {
        seen.set(p, doc.sha256);
        return done(part);
      }
      const next = end < total ? ` Call read_doc with offset=${end} for the next part.` : "";
      return done(`${part}\n[partial read: characters ${offset}-${end} of ${total}.${next} A partial read does not allow write_doc to overwrite this document; use edit_doc for targeted changes.]`);
    },

    grep_docs({ pattern, prefix, ignore_case, max_results }) {
      if (typeof pattern !== "string" || pattern === "") return fail("pattern must be a non-empty string.");
      if (pattern.length > 300) return fail("pattern is too long (max 300 characters).");
      if (NESTED_QUANTIFIER.test(pattern)) return fail("pattern rejected: nested quantifiers like (a+)+ can run catastrophically slow. Simplify it.");
      if (prefix !== undefined && (typeof prefix !== "string" || !prefix.startsWith("/"))) return fail('prefix must be a string starting with "/".');
      let max = max_results === undefined ? DEFAULT_GREP_RESULTS : max_results;
      if (!Number.isInteger(max) || max < 1) return fail("max_results must be a positive integer.");
      max = Math.min(max, MAX_GREP_RESULTS);
      let re;
      try {
        re = new RegExp(pattern, ignore_case === false ? "" : "i");
      } catch (e) {
        return fail(`Invalid regular expression: ${e.message}`);
      }
      const hits = [];
      let scanned = 0;
      let stop = null;
      scan: for (const entry of docs.list(prefix ? { prefix } : {})) {
        const doc = docs.get(entry.path);
        if (!doc) continue;
        scanned += doc.content.length;
        if (scanned > GREP_SCAN_LIMIT) {
          stop = "scan limit reached; narrow the search with prefix";
          break;
        }
        const lines = doc.content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i].slice(0, GREP_LINE_LIMIT))) continue;
          if (hits.length >= max) {
            stop = `more matches exist; showing the first ${max}`;
            break scan;
          }
          hits.push(`${doc.path}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
      }
      if (!hits.length) return done(stop ? `No matches (${stop}).` : "No matches.");
      return done(`${hits.join("\n")}${stop ? `\n[${stop}]` : ""}`);
    },

    write_doc({ path: p, content }) {
      if (typeof p !== "string") return fail("path must be a string.");
      if (typeof content !== "string") return fail("content must be a string.");
      if (content.trim() === "") return fail("content is empty. Write the document's content, or use delete_doc (organizer only) to remove a document.");
      const { doc: existing, error } = lookup(p);
      if (error) return error;
      const { text, note } = clean(content);
      try {
        if (existing) {
          const known = seen.get(p);
          if (!known) {
            return fail(`${p} already exists and you have not read it completely in this session. Read it with read_doc first, then write the merged result (or use edit_doc for a targeted change).`);
          }
          if (existing.content === text) return done(`No change: ${p} already has exactly this content.`);
          seen.set(p, docs.write(p, text, { expectSha256: known }).sha256);
          stats.mutations++;
          return done(`Updated ${p} (${bytesOf(text)} bytes).${note}`);
        }
        seen.set(p, docs.write(p, text).sha256);
        stats.mutations++;
        return done(`Created ${p} (${bytesOf(text)} bytes).${note}`);
      } catch (e) {
        return fail(explain(e, p));
      }
    },

    edit_doc(input) {
      for (const k of ["path", "old_string", "new_string"]) if (typeof input[k] !== "string") return fail(`${k} must be a string.`);
      const { path: p, old_string: from, new_string: to } = input;
      if (from === "") return fail("old_string must not be empty.");
      const { doc, error } = lookup(p);
      if (error) return error;
      if (!doc) return fail(`Not found: ${p} does not exist. Create it with write_doc.`);
      const at = doc.content.indexOf(from);
      if (at === -1) return fail(`old_string was not found in ${p}. It must match the current content exactly, including whitespace and newlines. Re-read the document with read_doc and try again.`);
      let count = 1;
      for (let i = doc.content.indexOf(from, at + 1); i !== -1; i = doc.content.indexOf(from, i + 1)) count++;
      if (count > 1) return fail(`old_string matches ${count} places in ${p}. Include more surrounding text so that it matches exactly one place.`);
      const { text, note } = clean(doc.content.slice(0, at) + to + doc.content.slice(at + from.length));
      if (text === doc.content) return done(`No change: ${p} is already as requested.`);
      if (text.trim() === "") return fail("The edit would leave the document empty. Use delete_doc (organizer only) or keep some content.");
      try {
        const res = docs.write(p, text, { expectSha256: doc.sha256 });
        // The agent has seen the whole new content only if its earlier complete read matched what it edited.
        if (seen.get(p) === doc.sha256) seen.set(p, res.sha256);
        else seen.delete(p);
        stats.mutations++;
        return done(`Edited ${p} (${bytesOf(text)} bytes).${note}`);
      } catch (e) {
        return fail(explain(e, p));
      }
    },

    delete_doc({ path: p }) {
      if (typeof p !== "string") return fail("path must be a string.");
      try {
        docs.delete(p);
      } catch (e) {
        return fail(explain(e, p));
      }
      seen.delete(p);
      stats.mutations++;
      return done(`Deleted ${p}.`);
    },

    rename_doc({ from, to }) {
      if (typeof from !== "string" || typeof to !== "string") return fail("from and to must be strings.");
      try {
        docs.rename(from, to);
      } catch (e) {
        return fail(explain(e, e?.code === "conflict" ? to : from));
      }
      seen.delete(from);
      seen.delete(to);
      stats.mutations++;
      return done(`Renamed ${from} to ${to}. Update [[links]] and ${INDEX_PATH} that referenced the old name.`);
    },

    submit(input) {
      if (typeof input.summary !== "string" || input.summary.trim() === "") return fail("summary must be a non-empty string.");
      const summary = clip(input.summary.trim(), 4_000);
      if (role === "analyzer") {
        const touched = Array.isArray(input.touched) ? input.touched.filter((p) => typeof p === "string").slice(0, 100) : [];
        return { text: "Submitted.", isError: false, submission: { summary, touched } };
      }
      if (!Array.isArray(input.changes) || input.changes.some((c) => typeof c !== "string")) return fail("changes must be an array of strings.");
      if (docs.list().length > 0) {
        const index = docs.get(INDEX_PATH);
        if (!index) return fail(`${INDEX_PATH} does not exist. Write the index (one "[[slug]] - one sentence" line per document, grouped under ## domain headings), then submit.`);
        // Refused twice at most: a model that cannot shorten it must still be able to finish.
        if (index.content.length > INDEX_MAX_CHARS && indexRejections++ < MAX_INDEX_REJECTIONS) {
          return fail(`${INDEX_PATH} is ${index.content.length} characters; it is injected into every session and must stay under ${INDEX_MAX_CHARS}. Shorten entries, group or drop low-value ones, then submit again.`);
        }
      }
      return { text: "Submitted.", isError: false, submission: { summary, changes: input.changes.slice(0, 100).map((c) => clip(c.trim(), 300)) } };
    },
  };

  return {
    definitions,
    /** @returns {{text:string, isError:boolean, submission?:object}} */
    execute(name, input) {
      if (typeof name !== "string" || !allowed.has(name)) {
        return fail(`Unknown tool "${short(name, 64)}". Available tools: ${definitions.map((d) => d.name).join(", ")}. There is no shell, network or file access.`);
      }
      const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      try {
        return handlers[name](args);
      } catch (e) {
        return fail(`Tool ${name} failed: ${e?.message ?? e}`);
      }
    },
  };
}
