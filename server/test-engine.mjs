// End to end without a key: the browser copy of the engine (site/try/engine) runs a full dream through this
// server's proxy, which talks to a mock Anthropic API. Run tools/build-engine.cjs first.
import { startMockUpstream } from "./mock-upstream.mjs";

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("ok  ", n); } catch (e) { fail++; console.log("FAIL", n, e.message); } };
const eq = (a, b) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const up = await startMockUpstream(0);
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${up.port}`;
process.env.NEXORUM_SIM_RPM = "1000";
const { server } = await import("./server.mjs");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const E = await import("../site/try/engine/index.js");

await t("status is on with a key", async () => { const j = await (await fetch(base + "/api/sim/status")).json(); eq(j.enabled, true); });

let result, wiki, events = [];
await t("a full dream (2 analyzers + organizer) completes through the proxy", async () => {
  wiki = new E.MemoryWiki({});
  const notes = E.renderNotes([{ id: "n1", ts: "2026-11-19T10:00:00Z", content: "tests run with pnpm test:unit" }]);
  result = await E.runDream({
    llm: { provider: "anthropic", apiKey: "sim", baseUrl: base + "/api/sim" },
    models: { analyzer: "server", organizer: "server" },
    docs: wiki,
    transcripts: [
      { id: "S3", source: "try", text: E.renderTranscript({ id: "S3", source: "try", events: [{ role: "user", content: "we moved to pnpm" }, { role: "assistant", content: "noted" }] }) },
      { id: "notes", source: "notes", text: notes },
    ],
    budgetTokens: 90_000,
    maxTokensPerCall: 2048,
    onEvent: (e) => events.push(e),
  });
  eq(result.status, "completed");
});
await t("analyzers wrote their pages and the organizer wrote the index", () => {
  const paths = wiki.list().map((d) => d.path).sort();
  eq(paths.join(","), "/_index.md,/notes.md,/s3.md");
});
await t("events report analyzers, organizer and usage", () => {
  for (const k of ["analyzer_started", "analyzer_done", "organizer_started", "organizer_done", "tool"]) if (!events.some((e) => e.type === k)) throw new Error("missing " + k);
});
await t("the proxy forwarded the engine's system blocks and tools", () => {
  const b = up.stats.lastBody;
  eq(Array.isArray(b.system), true);
  eq(b.tools.some((x) => x.name === "rename_doc"), true);
  eq(b.max_tokens, 2048);
});
await t("token use is counted against the daily budget", async () => {
  const j = await (await fetch(base + "/api/sim/status")).json();
  eq(j.limits.tokens_left_today < j.limits.daily_tokens, true);
  eq(result.usage.input_tokens > 0, true);
});
await t("a chat turn with tools works", async () => {
  const r = await fetch(base + "/api/sim/v1/messages", { method: "POST", body: JSON.stringify({ system: "x", messages: [{ role: "user", content: "How do I run tests?" }], tools: [{ name: "recall", description: "d", input_schema: { type: "object" } }] }) });
  const j = await r.json();
  eq(r.status, 200); eq(j.content[0].name, "recall");
});

server.close(); up.server.close();
console.log(`\n${pass}/${pass + fail} ok`);
process.exitCode = fail ? 1 : 0;
