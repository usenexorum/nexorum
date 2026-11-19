// Document-level and line-level diffs.

/** @returns {{path:string, kind:"added"|"modified"|"removed", before:string|null, after:string|null}[]} sorted by path */
export function diffDocs(before = {}, after = {}) {
  const out = [];
  for (const p of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = Object.hasOwn(before, p) ? before[p] : null;
    const b = Object.hasOwn(after, p) ? after[p] : null;
    if (a === null) out.push({ path: p, kind: "added", before: null, after: b });
    else if (b === null) out.push({ path: p, kind: "removed", before: a, after: null });
    else if (a !== b) out.push({ path: p, kind: "modified", before: a, after: b });
  }
  return out;
}

const linesOf = (s) => (s === "" ? [] : (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n"));
const LCS_CELL_LIMIT = 16_000_000;

/**
 * LCS line diff. Every line of both sides appears once as same/del/add; one trailing newline is not a line.
 * Shared head and tail are trimmed first; a huge middle degrades to "all deleted, then all added".
 * @returns {{type:"same"|"add"|"del", text:string}[]}
 */
export function lineDiff(a, b) {
  const A = linesOf(String(a ?? ""));
  const B = linesOf(String(b ?? ""));
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;

  const out = A.slice(0, head).map((text) => ({ type: "same", text }));
  const x = A.slice(head, A.length - tail);
  const y = B.slice(head, B.length - tail);
  const n = x.length;
  const m = y.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > LCS_CELL_LIMIT) {
    for (const text of x) out.push({ type: "del", text });
    for (const text of y) out.push({ type: "add", text });
  } else {
    const w = m + 1;
    const len = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push({ type: "same", text: x[i] });
        i++;
        j++;
      } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) out.push({ type: "del", text: x[i++] });
      else out.push({ type: "add", text: y[j++] });
    }
    while (i < n) out.push({ type: "del", text: x[i++] });
    while (j < m) out.push({ type: "add", text: y[j++] });
  }
  for (let k = A.length - tail; k < A.length; k++) out.push({ type: "same", text: A[k] });
  return out;
}
