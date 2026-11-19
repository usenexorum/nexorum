// BM25 keyword search over notes and wiki pages. No embeddings: agents navigate through /_index.md, [[links]] and
// this search. Deterministic for the same input.
import { parseFrontmatter } from "./basics.js";

const K1 = 1.5;
const B = 0.75;
const TITLE_WEIGHT = 3;
const STOP_WORDS = new Set("a an and are as at be but by for from has have i in is it its of on or that the this to was were will with you".split(" "));

const dropDouble = (w) => (/([^aeiou])\1$/.test(w) && w.length > 3 ? w.slice(0, -1) : w);

/** Light suffix stemming, the same for documents and queries. */
export function stem(word) {
  const w = word;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("ing")) return dropDouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith("ed")) return dropDouble(w.slice(0, -2));
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lower-cased, NFKC-normalised, stop-word-free, stemmed unicode letter/digit runs. */
export function tokenize(text) {
  const out = [];
  for (const [w] of String(text ?? "").normalize("NFKC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!STOP_WORDS.has(w)) out.push(stem(w));
  }
  return out;
}

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** The line with the most query terms (first line when none match), clipped to 240 characters. */
function snippet(text, terms) {
  const lines = String(text).split("\n").map((l) => l.trim()).filter((l) => l && l !== "---");
  let best = null;
  let bestHits = 0;
  for (const line of lines) {
    const set = new Set(tokenize(line));
    const hits = terms.reduce((n, t) => n + (set.has(t) ? 1 : 0), 0);
    if (hits > bestHits) {
      bestHits = hits;
      best = line;
    }
  }
  return clip(best ?? lines[0] ?? "", 240);
}

/**
 * Notes are titled by their first line; wiki pages by frontmatter name (else the slug), and their text is the
 * description plus the body.
 * @returns {{id:string, kind:"note"|"wiki", title:string, text:string}[]}
 */
export function buildCorpus({ notes = [], wiki = {} } = {}) {
  const docs = [];
  for (const n of Array.isArray(notes) ? notes : []) {
    if (!n || typeof n.content !== "string") continue;
    docs.push({ id: n.id, kind: "note", title: clip(n.content.trim().split("\n")[0] ?? "", 80), text: n.content });
  }
  const snap = wiki && typeof wiki.snapshot === "function" ? wiki.snapshot() : (wiki ?? {}); // a MemoryWiki works too
  for (const [p, content] of Object.entries(snap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const fm = parseFrontmatter(content);
    const slug = p.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
    docs.push({ id: p, kind: "wiki", title: fm.name ?? slug, text: `${fm.description ? `${fm.description}\n` : ""}${fm.body}` });
  }
  return docs;
}

/**
 * BM25 (k1 1.5, b 0.75); title tokens count three times in term frequency and length.
 * @returns {{id:string, kind:string, score:number, title:string, snippet:string}[]} best first, ties by id
 */
export function searchCorpus(docs, query, { topK = 5 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !Array.isArray(docs) || !docs.length) return [];
  const rows = docs.map((d) => {
    const tf = new Map();
    let len = 0;
    for (const t of tokenize(d.text)) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      len++;
    }
    for (const t of tokenize(d.title)) {
      tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
      len += TITLE_WEIGHT;
    }
    return { d, tf, len };
  });
  const N = rows.length;
  const avg = rows.reduce((s, r) => s + r.len, 0) / N || 1;
  const idf = new Map(terms.map((t) => {
    const df = rows.filter((r) => r.tf.has(t)).length;
    return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))];
  }));
  const hits = [];
  for (const r of rows) {
    let score = 0;
    for (const t of terms) {
      const f = r.tf.get(t);
      if (f) score += idf.get(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (r.len / avg))));
    }
    if (score > 0) hits.push({ id: r.d.id, kind: r.d.kind, score, title: r.d.title, snippet: snippet(r.d.text, terms) });
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, Math.max(0, topK));
}
