// Copies the CLI's core library (cli/src/core) to site/try/engine/ so the /try page runs the SAME engine as the CLI:
// BM25 search, the digest, the secret scrubber, the line diff and the full dream (analyzers + organizer).
// Only the three Node-only spots are swapped for browser equivalents (sha256, random ids, UTF-8 byte length).
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "cli", "src", "core");
const OUT = path.join(__dirname, "..", "site", "try", "engine");

const SHA256 = `// Browser stand-in for the crypto module (sync SHA-256 and random ids), same outputs as the CLI.
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256Bytes(msg) {
  const len = msg.length, total = ((len + 9 + 63) >> 6) << 6, b = new Uint8Array(total);
  b.set(msg); b[len] = 0x80;
  const dv = new DataView(b.buffer);
  dv.setUint32(total - 8, Math.floor((len * 8) / 2 ** 32)); dv.setUint32(total - 4, (len * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), W = new Uint32Array(64);
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const s0 = r(W[i-15],7) ^ r(W[i-15],18) ^ (W[i-15] >>> 3), s1 = r(W[i-2],17) ^ r(W[i-2],19) ^ (W[i-2] >>> 10); W[i] = (W[i-16] + s0 + W[i-7] + s1) | 0; }
    let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = r(e,6) ^ r(e,11) ^ r(e,25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = r(a,2) ^ r(a,13) ^ r(a,22), mj = (a & bb) ^ (a & c) ^ (bb & c), t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}
const crypto = {
  createHash: () => { let s = ""; const h = { update: (t) => { s += t; return h; }, digest: () => sha256Bytes(new TextEncoder().encode(s)) }; return h; },
  randomBytes: (n) => { const a = crypto.getRandomValues(new Uint8Array(n)); return { toString: () => btoa(String.fromCharCode(...a)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "") }; },
  getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
};`;

const BYTES = "const bytesOf = (s) => new TextEncoder().encode(String(s)).length;";

function walk(dir, rel = "") {
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f), r = path.join(rel, f);
    if (fs.statSync(abs).isDirectory()) { walk(abs, r); continue; }
    if (!f.endsWith(".js")) continue;
    let s = fs.readFileSync(abs, "utf8");
    if (r === "basics.js") s = s.replace('import crypto from "node:crypto";', SHA256);
    s = s.replace('const bytesOf = (s) => Buffer.byteLength(s, "utf8");', BYTES);
    if (/node:|Buffer\.|process\./.test(s)) throw new Error(`build-engine: ${r} still uses a Node-only API`);
    const dest = path.join(OUT, r);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, s);
  }
}
fs.rmSync(OUT, { recursive: true, force: true });
walk(SRC);
console.log("site/try/engine/ (core library for the browser)");
