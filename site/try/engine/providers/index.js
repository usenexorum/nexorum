// LLM adapters. The engine speaks the Anthropic Messages block format internally (text, tool_use, tool_result);
// the OpenAI-compatible adapter converts to and from chat-completions with tool calling.
import { LlmError, makeRedactor, normalizeUsage, postJson } from "./http.js";

export { AbortedError, BudgetExhaustedError, LlmError, normalizeUsage, zeroUsage } from "./http.js";

const EPHEMERAL = { type: "ephemeral" };
export const ANTHROPIC_VERSION = "2023-06-01";
/** Tool errors travel in-band on the chat-completions side, because the "tool" role has no error flag. */
export const TOOL_ERROR_PREFIX = "ERROR: ";

const asBlocks = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : content);

/** Moves a cache breakpoint onto the last block of the latest message (without touching the stored history). */
function cacheTail(messages) {
  if (messages.length < 2) return messages;
  const last = messages.at(-1);
  if (!Array.isArray(last.content) || !last.content.length) return messages;
  const blocks = [...last.content];
  blocks[blocks.length - 1] = { ...blocks.at(-1), cache_control: EPHEMERAL };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

function anthropicStop(reason, content) {
  if (reason === "tool_use" || reason === "max_tokens" || reason === "refusal") return reason;
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return "end_turn";
  return content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
}

/** Anthropic Messages API: POST {baseUrl}/v1/messages. */
export function createAnthropicProvider(llm, { fetchImpl, retry } = {}) {
  const baseUrl = String(llm.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const redact = makeRedactor(llm.apiKey);
  return {
    name: "anthropic",
    redact,
    async callModel({ model, system, messages, tools, maxTokens, signal }) {
      const data = await postJson({
        url: `${baseUrl}/v1/messages`,
        headers: { "x-api-key": llm.apiKey, "anthropic-version": llm.anthropicVersion || ANTHROPIC_VERSION },
        body: {
          model,
          max_tokens: maxTokens,
          system: [{ type: "text", text: system, cache_control: EPHEMERAL }],
          tools,
          messages: cacheTail(messages.map((m) => ({ ...m, content: asBlocks(m.content) }))),
        },
        label: "Anthropic",
        describeError: (j, text) => ({ type: j?.error?.type ?? "error", message: j?.error?.message ?? text.slice(0, 300) }),
        isBadBody: (j) => j.type === "error",
        fetchImpl,
        signal,
        redact,
        retry,
      });
      if (!Array.isArray(data.content)) throw new LlmError("The Anthropic API returned a response without content.", { type: "bad_response", retryable: true });
      const content = data.content.filter(
        (b) => b && typeof b === "object" && ((b.type === "text" && typeof b.text === "string") || (b.type === "tool_use" && typeof b.name === "string")),
      );
      return { content, stopReason: anthropicStop(data.stop_reason, content), usage: normalizeUsage(data.usage) };
    },
  };
}

const textOfBlocks = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");

function toChat(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      const text = textOfBlocks(m.content);
      const calls = m.content
        .filter((b) => b?.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: "assistant", content: text || (calls.length ? null : "") };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      for (const b of m.content) {
        if (b?.type !== "tool_result") continue;
        const body = typeof b.content === "string" ? b.content : textOfBlocks(b.content);
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `${TOOL_ERROR_PREFIX}${body}` : body });
      }
      const text = textOfBlocks(m.content.filter((b) => b?.type === "text"));
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return { input: raw };
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { input: {} };
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? { input: v } : { input: {}, parse_error: "arguments must be a JSON object" };
  } catch (e) {
    return { input: {}, parse_error: e.message };
  }
}

function chatUsage(u) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const prompt = num(u?.prompt_tokens) ?? num(u?.input_tokens) ?? 0;
  const completion = num(u?.completion_tokens) ?? num(u?.output_tokens) ?? 0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0;
  const cacheRead = Number.isFinite(cached) && cached > 0 ? Math.min(cached, prompt) : 0;
  return normalizeUsage({
    input_tokens: Math.max(0, prompt - cacheRead),
    output_tokens: completion,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: num(u?.cache_creation_input_tokens) ?? 0,
  });
}

/** Any OpenAI-compatible endpoint: POST {baseUrl}/chat/completions (baseUrl includes the version, e.g. .../v1). */
export function createOpenAIProvider(llm, { fetchImpl, retry } = {}) {
  const baseUrl = String(llm.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const redact = makeRedactor(llm.apiKey);
  let generated = 0;
  return {
    name: "openai",
    redact,
    async callModel({ model, system, messages, tools, maxTokens, signal }) {
      const data = await postJson({
        url: `${baseUrl}/chat/completions`,
        headers: llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {},
        body: {
          model,
          max_tokens: maxTokens,
          messages: toChat(system, messages),
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
          stream: false,
        },
        label: "OpenAI-compatible",
        describeError: (j, text) => ({
          type: String(j?.error?.type ?? j?.error?.code ?? "error"),
          message: j?.error?.message ?? (typeof j?.error === "string" ? j.error : text.slice(0, 300)),
        }),
        isBadBody: (j) => !Array.isArray(j.choices) || j.choices.length === 0,
        fetchImpl,
        signal,
        redact,
        retry,
      });
      const choice = data.choices[0];
      if (!choice?.message) throw new LlmError("The OpenAI-compatible API returned a choice without a message.", { type: "bad_response", retryable: true });
      const msg = choice.message;
      const content = [];
      const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? textOfBlocks(msg.content) : "";
      if (text) content.push({ type: "text", text });
      for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        const fn = call?.function;
        if (!fn || typeof fn.name !== "string") continue;
        content.push({ type: "tool_use", id: typeof call.id === "string" && call.id ? call.id : `call_${++generated}`, name: fn.name, ...parseArgs(fn.arguments) });
      }
      const hasTools = content.some((b) => b.type === "tool_use");
      let stopReason = hasTools ? "tool_use" : "end_turn";
      if (choice.finish_reason === "length") stopReason = "max_tokens";
      else if (choice.finish_reason === "content_filter" && !hasTools) stopReason = "refusal";
      return { content, stopReason, usage: chatUsage(data.usage) };
    },
  };
}

export function createProvider(llm, env) {
  if (llm?.provider === "anthropic") return createAnthropicProvider(llm, env);
  if (llm?.provider === "openai") return createOpenAIProvider(llm, env);
  throw new Error(`Unknown LLM provider "${llm?.provider}". Use "anthropic" or "openai".`);
}
