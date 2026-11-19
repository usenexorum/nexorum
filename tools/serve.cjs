// Tiny static server for previewing site/: node tools/serve.cjs [port]
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "site"), PORT = +process.argv[2] || 5210;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".webp": "image/webp" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, path.normalize(p).replace(/^[\\/]+/, ""));
  if (!f.startsWith(ROOT)) { res.writeHead(400); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { fs.readFile(path.join(f, "index.html"), (e2, d2) => { if (e2) { res.writeHead(404); res.end("not found"); } else { res.writeHead(200, { "content-type": TYPES[".html"] }); res.end(d2); } }); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); res.end(d);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`http://127.0.0.1:${PORT}/`));
