// Test-only fake LLM. It answers Anthropic Messages and OpenAI chat-completions requests like a tiny, obedient model,
// deciding every reply from the request alone (role, input id, turn), so parallel analyzers stay deterministic.
//   analyzer:  turn 1 list_docs, turn 2 write_doc /<input-id>.md, turn 3 submit
//   organizer: turn 1 list_docs + read the pages, turn 2 write_doc /_index.md, turn 3 submit
// Loaded with `node --import <this file>` it replaces globalThis.fetch when MOCK_LLM=1 (and logs each call to
// MOCK_LLM_LOG). It never touches the network.
import fs from "node:fs";

export const USAGE_PER_CALL = { input_tokens: 1000, output_tokens: 100 };

const slug = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "input";

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((b) => (b?.type === "text" ? b.text : "")).join("\n");
}

/** Normalised view of a request: provider, system text, first user text, number of assistant turns so far. */
function readRequest(url, init) {
  const body = JSON.parse(init.body);
  if (url.endsWith("/v1/messages")) {
    return { provider: "anthropic", body, system: body.system.map((b) => b.text).join("\n"), first: textOf(body.messages[0].content), turn: body.messages.filter((m) => m.role === "assistant").length + 1, headers: init.headers };
  }
  const msgs = body.messages;
  return { provider: "openai", body, system: msgs[0].content, first: textOf(msgs[1].content), turn: msgs.filter((m) => m.role === "assistant").length + 1, headers: init.headers };
}

/** The tool calls the fake model makes for this request (canonical {name, input}), or [] to reply with text only. */
export function decide(req, mode = "") {
  const organizer = req.system.includes("Your job: organizer");
  if (mode === "quiet" && !organizer) return [{ name: "submit", input: { summary: "Nothing worth keeping." } }];
  if (!organizer) {
    const id = /Input id: (\S+)/.exec(req.first)?.[1] ?? "input";
    const first = /USER:\n([^\n]+)/.exec(req.first)?.[1] ?? /\) ([^\n]+)/.exec(req.first)?.[1] ?? "something";
    if (req.turn === 1) return [{ name: "list_docs", input: {} }];
    if (req.turn === 2) {
      const s = slug(id);
      const extra = mode === "secret" ? "\nDeploy token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" : "";
      return [{ name: "write_doc", input: { path: `/${s}.md`, content: `---\nname: ${s}\ndescription: What session ${id} established.\n---\n${first}${extra}\n` } }];
    }
    return [{ name: "submit", input: { summary: `Recorded ${id}.`, touched: [`/${slug(id)}.md`] } }];
  }
  if (req.turn === 1) return [{ name: "list_docs", input: {} }];
  if (req.turn === 2) {
    // The organizer's list_docs result is in the conversation; build the index from it.
    const all = JSON.stringify(req.body.messages);
    const paths = [...new Set([...all.matchAll(/- (\/[a-z0-9-]+\.md) \(/g)].map((m) => m[1]))].filter((p) => p !== "/_index.md");
    const lines = paths.map((p) => `- [[${p.slice(1, -3)}]] - notes from ${p.slice(1, -3)}`);
    return [{ name: "write_doc", input: { path: "/_index.md", content: `## Sessions\n${lines.join("\n")}\n` } }];
  }
  return [{ name: "submit", input: { summary: "Indexed every page.", changes: ["wrote /_index.md"] } }];
}

function respond(req, calls) {
  if (req.provider === "anthropic") {
    const content = [{ type: "text", text: `turn ${req.turn}` }, ...calls.map((c, i) => ({ type: "tool_use", id: `tu_${req.turn}_${i}`, name: c.name, input: c.input }))];
    return { id: "msg_mock", type: "message", role: "assistant", content, stop_reason: calls.length ? "tool_use" : "end_turn", usage: USAGE_PER_CALL };
  }
  const tool_calls = calls.map((c, i) => ({ id: `call_${req.turn}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }));
  return {
    choices: [{ index: 0, finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: `turn ${req.turn}`, ...(calls.length ? { tool_calls } : {}) } }],
    usage: { prompt_tokens: USAGE_PER_CALL.input_tokens, completion_tokens: USAGE_PER_CALL.output_tokens },
  };
}

const jsonResponse = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * @param {{log?:(entry:object)=>void, failFirst?:number, failStatus?:number, delayMs?:number, onCall?:(req)=>void, mode?:string}} [opts]
 *   mode: "" (obedient), "quiet" (analyzers write nothing), "secret" (analyzers write a token), "organizer-fail"
 *   (the organizer gets HTTP 400), "fail" (every call gets HTTP 400).
 */
export function makeMockFetch(opts = {}) {
  let calls = 0;
  let inFlight = 0;
  const stats = { calls: 0, maxInFlight: 0 };
  const fetchImpl = async (url, init) => {
    const n = ++calls;
    stats.calls = n;
    inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      const req = readRequest(String(url), init);
      opts.onCall?.(req);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.failFirst && n <= opts.failFirst) {
        const status = opts.failStatus ?? 529;
        return jsonResponse(status, { type: "error", error: { type: status === 401 ? "authentication_error" : "overloaded_error", message: `mock failure ${n}` } }, { "retry-after": "0" });
      }
      if (opts.mode === "fail" || (opts.mode === "organizer-fail" && req.system.includes("Your job: organizer"))) {
        return jsonResponse(400, { type: "error", error: { type: "invalid_request_error", message: "mock bad request" } });
      }
      const decided = decide(req, opts.mode);
      opts.log?.({ url: String(url), provider: req.provider, model: req.body.model, role: req.system.includes("Your job: organizer") ? "organizer" : "analyzer", turn: req.turn, tools: decided.map((c) => c.name), headers: req.headers });
      return jsonResponse(200, respond(req, decided));
    } finally {
      inFlight--;
    }
  };
  return { fetch: fetchImpl, stats };
}

if (process.env.MOCK_LLM === "1") {
  const logFile = process.env.MOCK_LLM_LOG;
  const { fetch: mock } = makeMockFetch({ mode: process.env.MOCK_LLM_MODE ?? "", log: logFile ? (e) => fs.appendFileSync(logFile, `${JSON.stringify(e)}\n`) : undefined });
  globalThis.fetch = mock;
}
