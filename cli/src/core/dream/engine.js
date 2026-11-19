// The dream engine. No file system access: it works on a document API (the STAGING wiki). One analyzer agent per
// input runs in parallel (default 3 at a time), then one organizer, all sharing one token budget.
import { MAX_PART_CHARS, splitText } from "../basics.js";
import { createProvider } from "../providers/index.js";
import { AbortedError, BudgetExhaustedError, LlmError } from "../providers/http.js";
import { scrubSecrets } from "../scrub.js";
import { AgentError, BudgetTracker, runAgent } from "./agent.js";
import { analyzerFirstContent, analyzerSystem, organizerFirstContent, organizerSystem } from "./prompts.js";
import { createToolbox } from "./tools.js";

export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_MAX_TOKENS_PER_CALL = 16_000;
export const DEFAULT_CONCURRENCY = 3;

/**
 * Never rejects: problems come back as status "failed" with a message that never contains the API key.
 *
 * @param {object} o
 * @param {{provider:"anthropic"|"openai", apiKey?:string, baseUrl?:string}} o.llm
 * @param {{analyzer:string, organizer:string}} o.models
 * @param {object} o.docs staging wiki (list/get/write/delete/rename)
 * @param {{id:string, source:string, text:string}[]} o.transcripts inputs (a notes block counts as one input)
 * @param {number} o.budgetTokens
 * Optional: instructions, concurrency, signal, onEvent, fetch, maxTurns, maxTokensPerCall, retry, today.
 *
 * Events (each with type, ts, message): phase, analyzer_started, analyzer_done, organizer_started,
 * organizer_done, agent_text, tool, usage, budget, error.
 *
 * `redactions` counts the secret-like values the tools replaced in documents the agents wrote.
 * @returns {Promise<{status:"completed"|"budget_exhausted"|"canceled"|"failed", summary:string, usage:object, redactions:number,
 *   analyzed:{id:string, ok:boolean, summary:string|null, error:string|null}[],
 *   organizer:{ok:boolean, summary:string|null, changes:string[], error:string|null}, error:string|null}>}
 */
export async function runDream(o) {
  const {
    llm,
    models,
    docs,
    transcripts,
    instructions = null,
    budgetTokens,
    concurrency = DEFAULT_CONCURRENCY,
    signal: outer,
    onEvent,
    fetch: fetchImpl = globalThis.fetch,
    maxTurns = DEFAULT_MAX_TURNS,
    maxTokensPerCall = DEFAULT_MAX_TOKENS_PER_CALL,
    retry,
    today = new Date().toISOString().slice(0, 10),
  } = o ?? {};

  let redact = (s) => String(s);
  const emit = (type, message, extra = {}) => {
    if (typeof onEvent !== "function") return;
    try {
      onEvent({ type, ts: Date.now(), message: redact(message), ...extra });
    } catch {} // a listener can never break a run
  };
  const budget = new BudgetTracker(Number.isFinite(budgetTokens) ? budgetTokens : 0, (pct, used, cap) =>
    emit("budget", `Token budget ${pct}% used (${used} of ${cap}).`, { pct, used, cap }),
  );
  const stop = new AbortController();
  const relayAbort = () => stop.abort();
  const analyzed = [];
  let organizer = { ok: false, summary: null, changes: [], error: null };
  const stats = { mutations: 0, redactions: 0 }; // shared by every toolbox of the run
  const finish = (status, summary, error = null) => ({ status, summary, usage: { ...budget.usage }, analyzed, organizer, redactions: stats.redactions, error: error === null ? null : redact(error) });
  const canceled = () => outer?.aborted === true;

  try {
    const refuse = (why) => finish("failed", "The dream did not start.", why);
    if (llm?.provider !== "anthropic" && llm?.provider !== "openai") return refuse('llm.provider must be "anthropic" or "openai".');
    if (llm.provider === "anthropic" && (typeof llm.apiKey !== "string" || !llm.apiKey)) return refuse("No Anthropic API key was provided.");
    if (llm.apiKey != null && typeof llm.apiKey !== "string") return refuse("llm.apiKey must be a string.");
    if (!models?.analyzer || !models?.organizer) return refuse("Both an analyzer model and an organizer model are required.");
    if (!docs || typeof docs.list !== "function") return refuse("A document store is required.");
    if (!Array.isArray(transcripts) || !transcripts.length) return refuse("There is nothing to analyze.");
    if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return refuse("budgetTokens must be a positive number.");
    if (typeof fetchImpl !== "function") return refuse("No fetch implementation is available.");
    if (canceled()) return finish("canceled", "Canceled before it started.");
    outer?.addEventListener("abort", relayAbort, { once: true });

    const provider = createProvider(llm, { fetchImpl, retry });
    redact = provider.redact;
    const client = {
      async send(req) {
        if (stop.signal.aborted) throw new AbortedError();
        if (budget.exhausted) throw new BudgetExhaustedError(); // checked before every call
        const resp = await provider.callModel({ ...req, signal: stop.signal });
        budget.add(resp.usage);
        emit("usage", `Tokens used so far: ${budget.used} of ${budget.cap}.`, { usage: { ...budget.usage } });
        return resp;
      },
    };
    const common = { client, maxTurns, maxTokens: maxTokensPerCall, emit };
    const sys = { instructions, today };

    const classify = (e) => {
      if (e instanceof AbortedError) return { error: "Canceled.", kind: "aborted" };
      if (e instanceof BudgetExhaustedError) return { error: "Token budget exhausted before this agent finished.", kind: "budget" };
      if (e instanceof LlmError) return { error: redact(e.message), kind: e.fatal ? "fatal" : "agent" };
      if (e instanceof AgentError) return { error: redact(e.message), kind: "agent" };
      return { error: redact(`Unexpected error: ${e?.message ?? e}`), kind: "agent" };
    };

    // ---- analysis -----------------------------------------------------------------------------------------
    emit("phase", `Analyzing ${transcripts.length} input(s).`, { phase: "analysis" });
    let fatal = null;
    let budgetCut = false;

    async function analyze(input) {
      const parts = splitText(String(input.text ?? ""), MAX_PART_CHARS);
      const agent = `analyzer:${input.id}`;
      const summaries = [];
      emit("analyzer_started", `Analyzer started for ${input.id}${parts.length > 1 ? ` (${parts.length} parts)` : ""}.`, { agent, inputId: input.id, parts: parts.length });
      for (let p = 0; p < parts.length; p++) {
        try {
          const r = await runAgent({
            ...common,
            agent,
            model: models.analyzer,
            system: analyzerSystem(sys),
            toolbox: createToolbox({ docs, role: "analyzer", scrub: scrubSecrets, stats }),
            firstContent: analyzerFirstContent({ id: input.id, source: input.source ?? "transcript", part: p + 1, parts: parts.length, text: parts[p], earlierSummaries: summaries }),
          });
          summaries.push(r.summary);
        } catch (e) {
          if (parts.length > 1 && !(e instanceof AbortedError || e instanceof BudgetExhaustedError)) e.message = `part ${p + 1} of ${parts.length}: ${e.message}`;
          throw e;
        }
      }
      return parts.length > 1 ? summaries.map((s, i) => `Part ${i + 1}: ${s}`).join("\n") : summaries[0];
    }

    const slots = new Array(transcripts.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      while (cursor < transcripts.length) {
        const i = cursor++;
        const input = transcripts[i];
        const agent = `analyzer:${input.id}`;
        if (stop.signal.aborted || budget.exhausted) {
          slots[i] = { id: input.id, ok: false, summary: null, error: stop.signal.aborted ? "Not run: canceled." : "Not run: token budget exhausted." };
          if (!stop.signal.aborted) budgetCut = true;
          continue;
        }
        try {
          slots[i] = { id: input.id, ok: true, summary: await analyze(input), error: null };
          emit("analyzer_done", `Analyzer finished for ${input.id}.`, { agent, inputId: input.id, ok: true });
        } catch (e) {
          const { error, kind } = classify(e);
          slots[i] = { id: input.id, ok: false, summary: null, error };
          if (kind === "budget") budgetCut = true;
          if (kind === "fatal" && !fatal) {
            fatal = error;
            stop.abort(); // a bad key or model fails every agent; stop the others now
          }
          if (kind !== "aborted") emit("error", `Analyzer ${input.id} failed: ${error}`, { agent, inputId: input.id });
          emit("analyzer_done", `Analyzer ${input.id} did not finish.`, { agent, inputId: input.id, ok: false });
        }
      }
    };
    const width = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, transcripts.length));
    await Promise.all(Array.from({ length: width }, worker));
    analyzed.push(...slots);

    if (canceled()) return finish("canceled", "Canceled during analysis.");
    if (fatal) return finish("failed", "The dream stopped because the LLM API rejected the request.", fatal);
    if (!analyzed.some((a) => a.ok) && !budgetCut) {
      const first = analyzed.find((a) => a.error)?.error ?? "unknown error";
      return finish("failed", "Every analyzer failed.", `All ${analyzed.length} analyzer(s) failed. First error: ${first}`);
    }

    // ---- organizing ---------------------------------------------------------------------------------------
    if (budgetCut || budget.exhausted) {
      organizer = { ok: false, summary: null, changes: [], error: "Skipped: token budget exhausted before the organizer could run." };
      emit("budget", "Token budget exhausted; the organizer was skipped.", { used: budget.used, cap: budget.cap });
      return finish("budget_exhausted", summarize(analyzed, organizer, true));
    }
    const docCount = docs.list().length;
    if (docCount === 0 || stats.mutations === 0) {
      organizer = { ok: true, summary: docCount === 0 ? "Nothing to organize: there are no documents." : "Organizer skipped: the analyzers changed no documents.", changes: [], error: null };
      return finish("completed", summarize(analyzed, organizer, false));
    }
    emit("phase", "Organizing the wiki.", { phase: "organizer" });
    emit("organizer_started", `Organizer started over ${docCount} document(s).`, { agent: "organizer" });
    try {
      const r = await runAgent({
        ...common,
        agent: "organizer",
        model: models.organizer,
        system: organizerSystem(sys),
        toolbox: createToolbox({ docs, role: "organizer", scrub: scrubSecrets, stats }),
        firstContent: organizerFirstContent({ analyzed, docCount }),
      });
      organizer = { ok: true, summary: r.summary, changes: r.submission?.changes ?? [], error: null };
      emit("organizer_done", "Organizer finished.", { agent: "organizer", ok: true });
    } catch (e) {
      const { error, kind } = classify(e);
      organizer = { ok: false, summary: null, changes: [], error };
      emit("organizer_done", "Organizer did not finish.", { agent: "organizer", ok: false });
      if (kind === "aborted" && canceled()) return finish("canceled", "Canceled during organizing.");
      if (kind === "budget") return finish("budget_exhausted", summarize(analyzed, organizer, true));
      emit("error", `Organizer failed: ${error}`, { agent: "organizer" });
      return finish("failed", "The organizer failed.", `Organizer failed: ${error}`);
    }
    return finish("completed", summarize(analyzed, organizer, false));
  } catch (e) {
    if (canceled()) return finish("canceled", "Canceled.");
    return finish("failed", "The dream failed unexpectedly.", `Unexpected error: ${redact(e?.message ?? e)}`);
  } finally {
    outer?.removeEventListener("abort", relayAbort);
  }
}

function summarize(analyzed, organizer, partial) {
  const ok = analyzed.filter((a) => a.ok).length;
  const lines = [`Analyzed ${ok} of ${analyzed.length} input(s)${partial ? "; stopped early because the token budget ran out" : ""}.`];
  if (organizer.ok && organizer.summary) lines.push(`Organizer: ${organizer.summary}`);
  else if (organizer.error) lines.push(`Organizer: ${organizer.error}`);
  for (const a of analyzed) if (a.ok && a.summary) lines.push(`- ${a.id}: ${a.summary.replace(/\s+/g, " ").slice(0, 400)}`);
  return lines.join("\n");
}
