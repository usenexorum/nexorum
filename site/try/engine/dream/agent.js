// One agent conversation: call the model, run every tool call of the turn, answer with one user message of
// tool_result blocks, repeat until submit. Messages use the Anthropic block format; providers translate.
import { normalizeUsage, zeroUsage } from "../providers/http.js";

export class AgentError extends Error {}

const DOC_TOOLS = new Set(["list_docs", "read_doc", "grep_docs", "write_doc", "edit_doc", "delete_doc", "rename_doc", "submit"]);
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const MAX_NUDGES = 2;

/**
 * Shared token counter. The cap is checked BEFORE each call starts, so a run overshoots by at most the calls
 * already in flight. `onThreshold(pct, used, cap)` fires once each at 50, 80 and 100 percent.
 */
export class BudgetTracker {
  constructor(cap, onThreshold) {
    this.cap = cap;
    this.usage = zeroUsage();
    this.onThreshold = onThreshold;
    this.fired = new Set();
  }
  get used() {
    return this.usage.total_tokens;
  }
  get exhausted() {
    return this.used >= this.cap;
  }
  add(raw) {
    const u = normalizeUsage(raw);
    for (const k of Object.keys(this.usage)) this.usage[k] += u[k];
    for (const pct of [50, 80, 100]) {
      if (!this.fired.has(pct) && this.used * 100 >= this.cap * pct) {
        this.fired.add(pct);
        this.onThreshold?.(pct, this.used, this.cap);
      }
    }
  }
}

/** @returns {Promise<{summary:string, submission:object}>} */
export async function runAgent({ client, model, system, toolbox, firstContent, maxTurns, maxTokens, agent, emit }) {
  const messages = [{ role: "user", content: firstContent }];
  let nudges = 0;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const resp = await client.send({ model, maxTokens, system, tools: toolbox.definitions, messages });
    const content = resp.content;
    const said = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (said) emit("agent_text", clip(said.replace(/\s+/g, " "), 400), { agent });

    if (resp.stopReason === "refusal") throw new AgentError("The model declined to continue (refusal).");
    if (resp.stopReason === "max_tokens") {
      // A cut-off response may end in a half-written tool call, so none of its calls run.
      const kept = content.filter((b) => b.type !== "tool_use");
      messages.push({ role: "assistant", content: kept.length ? kept : [{ type: "text", text: "(cut off)" }] });
      messages.push({ role: "user", content: [{ type: "text", text: "Your last response hit the output limit and was cut off; no tool call in it was executed. Continue in smaller steps: fewer or shorter documents per turn." }] });
      continue;
    }

    const calls = content.filter((b) => b.type === "tool_use");
    if (!calls.length) {
      // Stopping without submit (or tool calls written as text through a gateway) means the job is not done.
      if (++nudges > MAX_NUDGES) throw new AgentError("The model stopped without calling submit; it may not support tool calls through this endpoint.");
      messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no output)" }] });
      messages.push({ role: "user", content: [{ type: "text", text: "You have not called a tool. Work only through the provided tools. If you are finished, call submit with your summary now; otherwise continue with the next tool call." }] });
      continue;
    }
    messages.push({ role: "assistant", content });

    const results = new Array(calls.length);
    const exec = (i) =>
      calls[i].parse_error
        ? { isError: true, text: `The arguments of this ${calls[i].name} call were not valid JSON (${calls[i].parse_error}). Call it again with a JSON object that matches the tool schema.` }
        : toolbox.execute(calls[i].name, calls[i].input);
    const report = (i) => {
      const call = calls[i];
      if (!DOC_TOOLS.has(call.name)) return;
      const input = call.input && typeof call.input === "object" ? call.input : {};
      const p = [input.path, input.from, input.prefix].find((v) => typeof v === "string");
      emit("tool", clip(results[i].text.split("\n")[0], 200), { agent, tool: call.name, ...(p ? { path: p } : {}), ok: !results[i].isError });
    };

    // Other tools first; submit last, and only when nothing else in the turn failed.
    const submitAt = [];
    let failed = false;
    calls.forEach((call, i) => {
      if (call.name === "submit") return submitAt.push(i);
      results[i] = exec(i);
      if (results[i].isError) failed = true;
      report(i);
    });
    let submission = null;
    for (const i of submitAt) {
      if (failed) results[i] = { isError: true, text: "Not accepted: another tool call in this turn failed. Fix it, check the result, then call submit again." };
      else if (submission) results[i] = { isError: true, text: "Only one submit per turn." };
      else {
        results[i] = exec(i);
        if (!results[i].isError) submission = results[i].submission;
      }
      report(i);
    }
    if (submission) return { summary: submission.summary, submission };

    messages.push({
      role: "user",
      content: calls.map((call, i) => ({ type: "tool_result", tool_use_id: call.id, content: results[i].text, ...(results[i].isError ? { is_error: true } : {}) })),
    });
  }
  throw new AgentError(`Reached the limit of ${maxTurns} turns without calling submit.`);
}
