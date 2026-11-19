// Test-only stand-in for the Anthropic API, so the live simulation can be exercised without a key or network.
// Dream calls are answered by the CLI's test model (cli/test/mock-llm.mjs); chat calls recall once, then answer.
//   node mock-upstream.mjs            -> listens on 127.0.0.1:5299
// Run the site against it:  ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:5299 node server.mjs
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { makeMockFetch } from "../cli/test/mock-llm.mjs";

const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const t = m.content.find((b) => b.type === "text");
    if (t) return t.text;
  }
  return "";
};

function chatReply(body) {
  const names = (body.tools || []).map((t) => t.name);
  const last = body.messages.at(-1);
  const answered = Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result");
  if (names.includes("recall") && !answered) {
    const q = lastUserText(body.messages).slice(0, 60);
    return { content: [{ type: "tool_use", id: `tu_${Date.now()}`, name: /remember/i.test(q) ? "remember" : "recall", input: /remember/i.test(q) ? { content: q.replace(/^.*?remember( that)?/i, "").trim() || q } : { query: q } }], stop_reason: "tool_use" };
  }
  return { content: [{ type: "text", text: "Mock model: I checked my memory and answered from it." }], stop_reason: "end_turn" };
}

export function startMockUpstream(port = 0, opts = {}) {
  const { fetch: mock, stats } = makeMockFetch(opts);
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url, "http://x");
      if (req.method !== "POST" || url.pathname !== "/v1/messages") { res.writeHead(404); return res.end(); }
      const body = JSON.parse(raw);
      stats.lastBody = body;
      const sys = Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : String(body.system || "");
      let out;
      if (/Your job: (analyzer|organizer)/.test(sys)) {
        const r = await mock("http://mock/v1/messages", { body: JSON.stringify({ ...body, system: Array.isArray(body.system) ? body.system : [{ type: "text", text: sys }] }), headers: {} });
        res.writeHead(r.status, { "content-type": "application/json" });
        return res.end(await r.text());
      }
      const c = chatReply(body);
      out = { id: "msg_chat", type: "message", role: "assistant", model: body.model, content: c.content, stop_reason: c.stop_reason, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 50 } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r({ server: srv, port: srv.address().port, stats })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port } = await startMockUpstream(Number(process.env.PORT || 5299));
  console.log(`mock Anthropic API on http://127.0.0.1:${port}`);
}
