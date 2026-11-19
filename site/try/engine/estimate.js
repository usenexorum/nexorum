// Rough planning estimate of a dream's token use (order of magnitude, can be off by 2x either way).
// Model: ~4 characters per token; an analyzer keeps its input in the conversation and re-reads it every turn
// (cache reads count against the budget); ~4 turns per analyzer, ~6 for the organizer; each turn appends ~1,000
// tokens of tool results and writes ~600 tokens. The real usage is reported once a dream has run.
import { MAX_PART_CHARS } from "./basics.js";

const CHARS_PER_TOKEN = 4;
const FIXED_PROMPT_TOKENS = 2_500;
const ANALYZER_TURNS = 4;
const ORGANIZER_TURNS = 6;
const APPEND_PER_TURN = 1_000;
const OUTPUT_PER_TURN = 600;
const DOCS_READ_BY_ANALYZER = 0.25;
const DOCS_GROWTH_PER_INPUT = 0.15;

const toTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
const triangle = (n) => (n * (n + 1)) / 2;

/**
 * @param {{transcripts:{chars:number}[], existingDocsBytes?:number}} args
 * @returns {{transcripts:number, chars:number, est_total_tokens:number, notes:string[]}}
 */
export function estimateDream({ transcripts, existingDocsBytes = 0 }) {
  const list = Array.isArray(transcripts) ? transcripts : [];
  const docTokens = toTokens(Math.max(0, existingDocsBytes));
  let chars = 0;
  let total = 0;
  for (const t of list) {
    const c = Math.max(0, Number(t?.chars) || 0);
    chars += c;
    const parts = Math.max(1, Math.ceil(c / MAX_PART_CHARS));
    const partTokens = toTokens(c / parts);
    const perPart =
      ANALYZER_TURNS * (FIXED_PROMPT_TOKENS + partTokens) +
      triangle(ANALYZER_TURNS) * APPEND_PER_TURN +
      docTokens * DOCS_READ_BY_ANALYZER * (ANALYZER_TURNS / 2) +
      ANALYZER_TURNS * OUTPUT_PER_TURN;
    total += parts * perPart;
  }
  if (list.length) {
    const docsAfter = docTokens + toTokens(chars) * DOCS_GROWTH_PER_INPUT;
    total +=
      ORGANIZER_TURNS * FIXED_PROMPT_TOKENS +
      docsAfter * ORGANIZER_TURNS * 0.7 +
      triangle(ORGANIZER_TURNS) * APPEND_PER_TURN * 0.5 +
      ORGANIZER_TURNS * OUTPUT_PER_TURN;
  }
  const notes = [
    "Rough estimate (order of magnitude, can be off by 2x): about 4 characters per token, ~4 turns per analyzer, ~6 for the organizer.",
    "Cache reads count against the budget, so large inputs cost more than their size: every turn re-reads the input.",
    "The real usage is reported on the dream once it has run.",
  ];
  if (list.some((t) => (Number(t?.chars) || 0) > MAX_PART_CHARS)) {
    notes.push(`Inputs over ${MAX_PART_CHARS.toLocaleString("en-US")} characters are split into parts that are analyzed one after another.`);
  }
  return { transcripts: list.length, chars, est_total_tokens: Math.round(total / 1000) * 1000, notes };
}
