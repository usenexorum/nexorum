// Reviewing dream proposals: changes, diff, apply (with the skip rule), reject, history, restore, retention.
import { sha256Hex, diffDocs, lineDiff } from "./core/index.js";
import { CliError, UsageError } from "./args.js";
import { assertDocPath } from "./store.js";

const DAY_MS = 86_400_000;

/**
 * What the proposal changes relative to the live wiki as it was when the dream started (base.json).
 * Each: {path, kind, before (live now), after (staged), baseSha, conflict (live differs from base)}.
 */
export function proposalChanges(store, id) {
  const base = store.readBase(id);
  const staged = store.readProposalWiki(id);
  const out = [];
  for (const p of [...new Set([...Object.keys(base), ...Object.keys(staged)])].sort()) {
    const baseSha = base[p] ?? null;
    const after = staged[p] ?? null;
    if ((after === null ? null : sha256Hex(after)) === baseSha) continue;
    const before = store.readDoc(p);
    out.push({
      path: p,
      kind: after === null ? "removed" : baseSha === null ? "added" : "modified",
      before,
      after,
      baseSha,
      conflict: (before === null ? null : sha256Hex(before)) !== baseSha,
    });
  }
  return out;
}

const splitLines = (s) => {
  const lines = s.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** Plain unified diff of one page, 3 lines of context, no colours. */
export function unifiedDiff(p, before, after, context = 3) {
  const header = [`--- ${before === null ? "/dev/null" : `live${p}`}`, `+++ ${after === null ? "/dev/null" : `proposed${p}`}`];
  let ops;
  if (before === null) ops = splitLines(after).map((text) => ({ type: "add", text }));
  else if (after === null) ops = splitLines(before).map((text) => ({ type: "del", text }));
  else {
    ops = lineDiff(before, after);
    while (ops.length && ops.at(-1).type === "same" && ops.at(-1).text === "") ops.pop();
  }
  // Line numbers in the old (o) and new (n) file at each op.
  let o = 1;
  let n = 1;
  const pos = ops.map((op) => {
    const at = { o, n };
    if (op.type !== "add") o++;
    if (op.type !== "del") n++;
    return at;
  });
  const changed = ops.flatMap((op, i) => (op.type === "same" ? [] : [i]));
  if (!changed.length) return [...header, "(no line changes)"].join("\n");
  const hunks = [];
  for (const i of changed) {
    const s = Math.max(0, i - context);
    const e = Math.min(ops.length - 1, i + context);
    const last = hunks.at(-1);
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else hunks.push([s, e]);
  }
  const lines = [...header];
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const oc = slice.filter((x) => x.type !== "add").length;
    const nc = slice.filter((x) => x.type !== "del").length;
    lines.push(`@@ -${oc === 0 ? pos[s].o - 1 : pos[s].o},${oc} +${nc === 0 ? pos[s].n - 1 : pos[s].n},${nc} @@`);
    for (const x of slice) lines.push(`${x.type === "add" ? "+" : x.type === "del" ? "-" : " "}${x.text}`);
  }
  return lines.join("\n");
}

export function renderProposalDiff(store, proposal) {
  const changes = proposalChanges(store, proposal.id);
  if (!changes.length) return `Proposal ${proposal.id} has no changes.`;
  // The kind shown is what the live wiki now looks like against the staged copy (a hand-deleted page reads "added").
  const kinds = new Map(
    diffDocs(
      Object.fromEntries(changes.filter((c) => c.before !== null).map((c) => [c.path, c.before])),
      Object.fromEntries(changes.filter((c) => c.after !== null).map((c) => [c.path, c.after])),
    ).map((d) => [d.path, d.kind]),
  );
  return changes
    .map((c) => {
      const note = c.conflict ? "  [live file changed since this proposal was made; apply skips it unless --force]" : "";
      return `=== ${c.path} (${kinds.get(c.path) ?? c.kind})${note}\n${unifiedDiff(c.path, c.before, c.after)}`;
    })
    .join("\n\n");
}

/**
 * Writes a proposal to the live wiki. A path is written only while the live page still equals what the dream
 * started from; otherwise it is skipped (unless `force`). When every change was skipped the proposal stays under
 * review and its inputs stay pending.
 * @returns {{applied:string[], skipped:{path:string, reason:string}[], status:string}}
 */
export function applyProposal(store, proposal, { force = false } = {}) {
  if (proposal.status === "applied") throw new CliError(`Proposal ${proposal.id} was already applied.`);
  if (proposal.status === "rejected") throw new CliError(`Proposal ${proposal.id} was rejected.`);
  const actor = `dream:${proposal.id}`;
  const applied = [];
  const skipped = [];
  for (const c of proposalChanges(store, proposal.id)) {
    if (c.conflict && !force) {
      skipped.push({ path: c.path, reason: "live file changed since the proposal was made" });
      continue;
    }
    if (c.after === null) store.deleteDoc(c.path, { actor });
    else store.writeDoc(c.path, c.after, { actor });
    applied.push(c.path);
  }
  const next = { ...proposal, applied_paths: applied, skipped_paths: skipped };
  if (!applied.length && skipped.length) {
    store.writeProposal(next);
    return { applied, skipped, status: proposal.status };
  }
  consumeInputs(store, proposal);
  store.writeProposal({ ...next, status: "applied", applied_at: new Date().toISOString() });
  return { applied, skipped, status: "applied" };
}

/** Marks the proposal's transcripts dreamed (unless they changed after the dream read them) and moves the notes marker. */
export function consumeInputs(store, proposal) {
  const ts = new Date().toISOString();
  const versions = proposal.transcript_versions ?? {};
  for (const id of proposal.transcripts ?? []) {
    const t = store.getTranscript(id);
    if (!t) continue;
    if (versions[id] && t.updated_at !== versions[id]) continue;
    store.saveTranscript({ ...t, status: "dreamed", dreamed_at: ts });
  }
  if (proposal.notes_through) {
    const state = store.readState();
    if (!state.notes_consolidated_through || state.notes_consolidated_through < proposal.notes_through) {
      store.writeState({ ...state, notes_consolidated_through: proposal.notes_through });
    }
  }
}

export function rejectProposal(store, proposal) {
  if (proposal.status !== "review") throw new CliError(`Proposal ${proposal.id} is ${proposal.status}, not under review.`);
  store.writeProposal({ ...proposal, status: "rejected", rejected_at: new Date().toISOString() });
}

/** Restores version N, or (without N) the newest version whose content differs from the live page. */
export function restorePath(store, p, version) {
  assertDocPath(p);
  const versions = store.versionsOf(p);
  if (!versions.length) throw new CliError(`No history for ${p}.`);
  const current = store.readDoc(p);
  let target;
  if (version !== undefined) {
    target = versions.find((v) => v.version === version);
    if (!target) throw new CliError(`${p} has no version ${version} (versions: 1-${versions.length}).`);
    if (!target.file) throw new CliError(`Version ${version} of ${p} is a deletion; pick a version that has content.`);
  } else {
    const curSha = current === null ? null : sha256Hex(current);
    target = [...versions].reverse().find((v) => v.file && v.sha256 !== curSha);
    if (!target) throw new CliError(`${p} has no earlier version to restore.`);
  }
  const content = store.readSnapshotFile(target.file);
  if (content === null) throw new CliError(`The snapshot file for ${p} version ${target.version} is missing.`);
  if (content === current) throw new CliError(`${p} already matches version ${target.version}.`);
  store.writeDoc(p, content, { actor: "restore", operation: "restore" });
  return target;
}

export function formatHistory(store, p) {
  let entries;
  if (p) {
    assertDocPath(p);
    entries = store.versionsOf(p);
  } else {
    const count = new Map();
    entries = store.readHistory().map((e) => {
      const v = (count.get(e.path) ?? 0) + 1;
      count.set(e.path, v);
      return { ...e, version: v };
    });
  }
  if (!entries.length) return p ? `No history for ${p}.` : "No history yet.";
  return entries.map((e) => `${p ? "" : `${e.path} `}v${e.version}  ${e.ts}  ${e.operation.padEnd(7)} ${e.actor}${e.sha256 ? `  ${e.sha256.slice(0, 8)}` : ""}`).join("\n");
}

/** Deletes transcripts dreamed more than `days` days ago. Pending ones are never touched. */
export function runRetention(store, days = 30, nowMs = Date.now()) {
  if (!Number.isFinite(days) || days < 0) throw new UsageError("--days must be a non-negative number");
  let removed = 0;
  for (const t of store.listTranscripts()) {
    if (t.status !== "dreamed" || !t.dreamed_at) continue;
    const at = Date.parse(t.dreamed_at);
    if (Number.isFinite(at) && nowMs - at > days * DAY_MS) {
      store.deleteTranscript(t.id);
      removed++;
    }
  }
  return removed;
}
