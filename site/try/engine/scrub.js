// Pattern-based secret scrubber. It runs on every transcript and note before it is stored and on every document a
// dream writes. Specific formats come before generic ones (sk-ant- before sk-, JWT before Bearer). The replacement
// "[REDACTED:<kind>]" matches no pattern, so scrubbing twice changes nothing.

// PEM private keys are scanned by hand: a lazy BEGIN...END regex rescans the remaining text for every BEGIN without
// an END, which is quadratic on hostile input.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_LINES = /(?:\r?\n[A-Za-z0-9+/=]{16,})+/y;

function scrubPem(text, label) {
  let out = "";
  let from = 0;
  let hits = 0;
  let endMissing = false;
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(text); m; m = PEM_BEGIN.exec(text)) {
    const bodyAt = m.index + m[0].length;
    let stop = -1;
    if (!endMissing) {
      PEM_END.lastIndex = bodyAt;
      const e = PEM_END.exec(text);
      if (e) stop = e.index + e[0].length;
      else endMissing = true;
    }
    if (stop < 0) {
      // Truncated key: take the base64 lines that follow the header.
      PEM_LINES.lastIndex = bodyAt;
      const b = PEM_LINES.exec(text);
      if (!b) continue;
      stop = bodyAt + b[0].length;
    }
    out += text.slice(from, m.index) + label;
    from = stop;
    hits++;
    PEM_BEGIN.lastIndex = stop;
  }
  return hits ? { text: out + text.slice(from), hits } : { text, hits: 0 };
}

const RULES = [
  ["private_key", null],
  ["anthropic_key", /sk-ant-[\w-]{20,}/g],
  ["openai_key", /sk-[A-Za-z0-9_-]{20,}/g],
  ["nexorum_key", /\bnxr_[A-Za-z0-9_-]{32,}/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16,}/g],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ["npm_token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g],
];

/**
 * @param {string} text
 * @returns {{text:string, count:number, kinds:string[]}}
 */
export function scrubSecrets(text) {
  let out = String(text);
  let count = 0;
  const kinds = [];
  for (const [kind, re] of RULES) {
    const label = `[REDACTED:${kind}]`;
    let hits = 0;
    if (re === null) {
      const r = scrubPem(out, label);
      out = r.text;
      hits = r.hits;
    } else {
      out = out.replace(re, () => {
        hits++;
        return label;
      });
    }
    if (hits) {
      count += hits;
      kinds.push(kind);
    }
  }
  return { text: out, count, kinds };
}
