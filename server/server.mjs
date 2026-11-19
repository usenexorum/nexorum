// Nexorum site server: static files from ../site plus the capped proxy for the live simulation.
//   GET  /api/sim/status        -> { enabled, model, limits }
//   POST /api/sim/v1/messages   -> one Messages API call, model and limits forced server-side
// The browser runs the agent loop (tools execute in the page); the server only forwards capped model calls.
// Env: ANTHROPIC_API_KEY (no key = live mode off), NEXORUM_SIM_MODEL, NEXORUM_SIM_DAILY_TOKENS,
//      NEXORUM_SIM_MAX_TOKENS, NEXORUM_SIM_RPM, PORT, HOST, TRUST_PROXY=1 (behind nginx)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.SITE_DIR || path.join(HERE, "..", "site"));
const PORT = Number(process.env.PORT || 5210);
const HOST = process.env.HOST || "127.0.0.1";
const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.NEXORUM_SIM_MODEL || "claude-opus-5-5";
const DAILY = Number(process.env.NEXORUM_SIM_DAILY_TOKENS || 2_000_000);
const MAX_TOKENS = Math.min(Number(process.env.NEXORUM_SIM_MAX_TOKENS || 2048), 8192);
const RPM = Number(process.env.NEXORUM_SIM_RPM || 60); // requests per IP per minute
const MAX_BODY = 256 * 1024;
const MAX_MESSAGES = 60;
// The chat tools of /try plus the dream tools of the engine (the page runs the same engine as the CLI).
const ALLOWED_TOOLS = new Set(["remember", "recall", "read_document", "list_docs", "read_doc", "grep_docs", "write_doc", "edit_doc", "delete_doc", "rename_doc", "submit"]);
const MAX_SYSTEM_CHARS = 40_000;

const client = KEY ? new Anthropic({ apiKey: KEY, maxRetries: 2, timeout: 120_000 }) : null;

// ---------- budget + rate limit (in memory, resets at midnight UTC) ----------
const day = () => new Date().toISOString().slice(0, 10);
const budget = { day: day(), used: 0 };
function spend(n) { if (budget.day !== day()) { budget.day = day(); budget.used = 0; } budget.used += n; }
function left() { if (budget.day !== day()) { budget.day = day(); budget.used = 0; } return DAILY - budget.used; }
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  w.push(now); hits.set(ip, w);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return w.length > RPM;
}
const ipOf = (req) => (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";

// ---------- helpers ----------
const SEC = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
};
function json(res, status, body, extra = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SEC, ...extra });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A string, or text blocks as the engine sends them (with an optional ephemeral cache marker). */
function cleanSystem(system) {
  if (typeof system === "string") return system.slice(0, MAX_SYSTEM_CHARS) || undefined;
  if (!Array.isArray(system)) return undefined;
  if (system.length > 4) throw Object.assign(new Error("Too many system blocks."), { status: 400 });
  let room = MAX_SYSTEM_CHARS;
  const out = [];
  for (const b of system) {
    if (!b || b.type !== "text" || typeof b.text !== "string") throw Object.assign(new Error("System blocks must be text."), { status: 400 });
    const text = b.text.slice(0, room);
    room -= text.length;
    if (text) out.push({ type: "text", text, ...(b.cache_control ? { cache_control: { type: "ephemeral" } } : {}) });
  }
  return out.length ? out : undefined;
}

/** Keep only what the simulation needs; everything else is dropped or refused. */
export function sanitize(body) {
  if (!body || typeof body !== "object") throw Object.assign(new Error("Body must be a JSON object."), { status: 400 });
  const { system, messages, tools } = body;
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) throw Object.assign(new Error(`messages must be an array of 1 to ${MAX_MESSAGES} items.`), { status: 400 });
  for (const m of messages) if (!m || (m.role !== "user" && m.role !== "assistant")) throw Object.assign(new Error("Only user and assistant messages are allowed."), { status: 400 });
  const t = Array.isArray(tools) ? tools : [];
  if (t.length > 12) throw Object.assign(new Error("Too many tools."), { status: 400 });
  for (const x of t) if (!x || !ALLOWED_TOOLS.has(x.name) || typeof x.input_schema !== "object") throw Object.assign(new Error(`Tool not allowed: ${x?.name}`), { status: 400 });
  return {
    system: cleanSystem(system),
    messages,
    tools: t.map(({ name, description, input_schema }) => ({ name, description: String(description || "").slice(0, 2000), input_schema })),
  };
}

async function proxy(req, res) {
  if (!client) return json(res, 503, { error: { type: "disabled", message: "The live simulation is switched off on this site." } });
  if (limited(ipOf(req))) return json(res, 429, { error: { type: "rate_limited", message: "Too many requests. Wait a minute." } }, { "retry-after": "60" });
  if (left() <= 0) return json(res, 429, { error: { type: "sim_quota", message: "The live simulation has used up its daily budget. It resets at midnight UTC." } });
  let input;
  try { input = sanitize(JSON.parse(await readBody(req))); }
  catch (e) { return json(res, e.status || 400, { error: { type: "invalid", message: e.status ? e.message : "Body is not valid JSON." } }); }
  try {
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...(input.system ? { system: input.system } : {}),
      ...(input.tools.length ? { tools: input.tools, tool_choice: { type: "auto" } } : {}),
      messages: input.messages,
    });
    const used = (msg.usage?.input_tokens || 0) + (msg.usage?.output_tokens || 0) + (msg.usage?.cache_creation_input_tokens || 0) + (msg.usage?.cache_read_input_tokens || 0);
    spend(used);
    return json(res, 200, { id: msg.id, model: msg.model, content: msg.content, stop_reason: msg.stop_reason, usage: { ...msg.usage, total_tokens: used } });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json(res, 429, { error: { type: "rate_limited", message: "The model is busy. Try again shortly." } }, { "retry-after": "20" });
    if (e instanceof Anthropic.BadRequestError) return json(res, 400, { error: { type: "invalid", message: "The model rejected this request." } });
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return json(res, 503, { error: { type: "disabled", message: "The live simulation is not configured correctly." } });
    if (e instanceof Anthropic.APIError) return json(res, 502, { error: { type: "upstream", message: `The model service answered ${e.status ?? "with an error"}.` } });
    return json(res, 502, { error: { type: "upstream", message: "The model service cannot be reached." } });
  }
}

// ---------- static files ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2" };
// brotli / gzip for text files, cached in memory per file version
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg", ".xml", ".txt"]);
const zcache = new Map();
function pickEncoding(h = "") { return /\bbr\b/.test(h) ? "br" : /\bgzip\b/.test(h) ? "gzip" : null; }
function compressed(file, data, enc) {
  const key = `${enc}:${file}:${data.length}:${fs.statSync(file).mtimeMs}`;
  let out = zcache.get(key);
  if (!out) {
    out = enc === "br" ? zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(data, { level: 9 });
    if (zcache.size > 200) zcache.clear();
    zcache.set(key, out);
  }
  return out;
}

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.includes("\0")) { res.writeHead(400); return res.end(); }
  if (p.endsWith("/")) p += "index.html";
  let file = path.join(ROOT, path.normalize(p).replace(/^[\\/]+/, ""));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(400); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) {
      return fs.readFile(path.join(ROOT, "404.html"), (e2, d2) => {
        res.writeHead(404, { "content-type": TYPES[".html"], ...SEC });
        res.end(e2 ? "Not found" : d2);
      });
    }
    const ext = path.extname(file);
    const headers = { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : "public, max-age=86400", vary: "accept-encoding", ...SEC };
    const enc = COMPRESSIBLE.has(ext) && data.length > 1024 ? pickEncoding(req.headers["accept-encoding"]) : null;
    if (enc) { data = compressed(file, data, enc); headers["content-encoding"] = enc; }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  if (url.pathname === "/api/sim/status" && req.method === "GET") {
    return json(res, 200, { enabled: !!client && left() > 0, model: client ? MODEL : null, limits: { max_tokens_per_call: MAX_TOKENS, requests_per_minute: RPM, daily_tokens: DAILY, tokens_left_today: Math.max(0, left()) } });
  }
  if (url.pathname === "/api/sim/v1/messages") {
    if (req.method !== "POST") return json(res, 405, { error: { type: "invalid", message: "Use POST." } });
    return proxy(req, res);
  }
  if (url.pathname.startsWith("/api/")) return json(res, 404, { error: { type: "not_found", message: "Not found." } });
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => console.log(`nexorum site on http://${HOST}:${PORT}/  (live simulation ${client ? `on, model ${MODEL}` : "off: no ANTHROPIC_API_KEY"})`));
}
