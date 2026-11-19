// Server tests without a key or network: status, validation, static, 404, traversal.
import { server, sanitize } from "./server.mjs";
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("ok  ", n); } catch (e) { fail++; console.log("FAIL", n, e.message); } };
const eq = (a, b) => { if (a !== b) throw new Error(`expected ${b}, got ${a}`); };
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
await t("status says off without a key", async () => { const j = await (await fetch(base + "/api/sim/status")).json(); eq(j.enabled, false); eq(j.model, null); });
await t("proxy returns 503 disabled without a key", async () => { const r = await fetch(base + "/api/sim/v1/messages", { method: "POST", body: "{}" }); eq(r.status, 503); eq((await r.json()).error.type, "disabled"); });
await t("proxy GET is 405", async () => eq((await fetch(base + "/api/sim/v1/messages")).status, 405));
await t("sanitize refuses unknown tools", () => { let ok = false; try { sanitize({ messages: [{ role: "user", content: "x" }], tools: [{ name: "bash", input_schema: {} }] }); } catch (e) { ok = e.status === 400; } eq(ok, true); });
await t("sanitize refuses system-role messages", () => { let ok = false; try { sanitize({ messages: [{ role: "system", content: "x" }] }); } catch (e) { ok = e.status === 400; } eq(ok, true); });
await t("sanitize keeps allowed tools only with their fields", () => { const s = sanitize({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "recall", description: "d", input_schema: { type: "object" }, extra: 1 }], model: "x", max_tokens: 99999 }); eq(Object.keys(s.tools[0]).join(), "name,description,input_schema"); eq(s.model, undefined); });
await t("home page is served", async () => { const r = await fetch(base + "/"); eq(r.status, 200); eq((await r.text()).includes("Nexorum"), true); });
await t("/try/ is served", async () => eq((await fetch(base + "/try/")).status, 200));
await t("unknown page is 404", async () => eq((await fetch(base + "/nope/")).status, 404));
await t("unknown api is 404 json", async () => eq((await fetch(base + "/api/x")).status, 404));
await t("html is served compressed", async () => {
  const http = await import("node:http");
  const enc = await new Promise((res, rej) => http.get(base + "/", { headers: { "accept-encoding": "br, gzip" } }, (r) => { r.resume(); res(r.headers["content-encoding"]); }).on("error", rej));
  eq(enc, "br");
});
await t("path traversal is blocked", async () => { const r = await fetch(base + "/..%2f..%2fserver%2fserver.mjs"); eq([400, 404].includes(r.status), true); });
server.close();
console.log(`\n${pass}/${pass + fail} ok`);
process.exitCode = fail ? 1 : 0;
