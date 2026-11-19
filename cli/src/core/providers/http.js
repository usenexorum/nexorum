// Shared plumbing for the LLM adapters: error types, usage accounting and a POST-JSON helper with bounded,
// abortable retries that honour retry-after.
import { scrubSecrets } from "../scrub.js";

export class LlmError extends Error {
  constructor(message, { status = 0, type = "error", retryable = false, requestId = null } = {}) {
    super(message);
    this.name = "LlmError";
    Object.assign(this, { status, type, retryable, requestId });
  }
  /** Bad key, no permission, unknown model or endpoint: no agent can succeed, so the whole dream stops. */
  get fatal() {
    return this.status === 401 || this.status === 403 || this.status === 404;
  }
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Token budget exhausted.");
    this.name = "BudgetExhaustedError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("Canceled.");
    this.name = "AbortError";
  }
}

const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

export function zeroUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 };
}

export function normalizeUsage(u) {
  const out = zeroUsage();
  for (const k of USAGE_KEYS) {
    const v = u?.[k];
    out[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    out.total_tokens += out[k];
  }
  return out;
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function retryAfterMs(header) {
  if (header == null || header === "") return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AbortedError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Removes the API key and anything key-shaped from text that may reach an error or an event. */
export function makeRedactor(apiKey) {
  return (text) => {
    let s = String(text);
    if (apiKey) s = s.split(apiKey).join("[REDACTED:api_key]");
    return scrubSecrets(s).text;
  };
}

/**
 * POST a JSON body and return the parsed JSON response, retrying transient failures with exponential backoff.
 * Defaults: 5 attempts, 1 s base, 30 s cap, retry-after honoured up to 60 s, 300 s per request.
 */
export async function postJson({ url, headers, body, label, describeError, isBadBody, fetchImpl, signal, redact, retry = {} }) {
  const { maxAttempts = 5, baseMs = 1000, maxMs = 30_000, maxRetryAfterMs = 60_000, requestTimeoutMs = 300_000 } = retry;
  const payload = JSON.stringify(body);

  async function once() {
    const ctl = new AbortController();
    const relay = () => ctl.abort();
    signal.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(() => ctl.abort(), requestTimeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: payload, signal: ctl.signal });
      text = await res.text();
    } catch (e) {
      if (signal.aborted) throw new AbortedError();
      throw new LlmError(redact(`Could not reach the ${label} API: ${e?.cause?.message ?? e?.message ?? e}`), { type: "network_error", retryable: true });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    const requestId = res.headers?.get?.("request-id") ?? res.headers?.get?.("x-request-id") ?? null;
    if (res.ok) {
      if (!data || typeof data !== "object" || isBadBody(data)) {
        throw new LlmError(`The ${label} API returned an unreadable response.`, { status: res.status, type: "bad_response", retryable: true, requestId });
      }
      return data;
    }
    const { type, message } = describeError(data, text ?? "");
    const err = new LlmError(redact(`${label} API error ${res.status} (${type}): ${message}${res.status === 401 ? " Check the API key." : ""}`), {
      status: res.status,
      type,
      retryable: RETRY_STATUS.has(res.status) || type === "overloaded_error",
      requestId,
    });
    err.retryAfterMs = retryAfterMs(res.headers?.get?.("retry-after"));
    throw err;
  }

  if (signal.aborted) throw new AbortedError();
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await once();
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retryable) throw e;
      last = e;
      if (attempt === maxAttempts) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
      await sleep(e.retryAfterMs != null ? Math.min(e.retryAfterMs, maxRetryAfterMs) : backoff, signal);
    }
  }
  last.message = `${last.message} (gave up after ${maxAttempts} attempts)`;
  throw last;
}
