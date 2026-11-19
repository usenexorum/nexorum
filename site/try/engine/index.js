// The core library: no CLI concerns, no reads or writes of the memory folder. The CLI imports it from here.
export { sha256Hex, newId, parseFrontmatter, splitText, MAX_PART_CHARS } from "./basics.js";
export { scrubSecrets } from "./scrub.js";
export { MemoryWiki, validatePath, docError, MAX_DOC_BYTES, MAX_DOCS, MAX_PATH_CHARS } from "./wiki.js";
export { diffDocs, lineDiff } from "./diff.js";
export { buildContext, renderTranscript, renderNotes, INDEX_PATH } from "./text.js";
export { buildCorpus, searchCorpus, tokenize, stem } from "./search.js";
export { claudeCodeJsonlToEvents, ompJsonlToEvents } from "./sessions.js";
export { estimateDream } from "./estimate.js";
export { runDream, DEFAULT_CONCURRENCY, DEFAULT_MAX_TURNS, DEFAULT_MAX_TOKENS_PER_CALL } from "./dream/engine.js";
export { BudgetTracker } from "./dream/agent.js";
export { createToolbox, toolDefinitions, INDEX_MAX_CHARS } from "./dream/tools.js";
export { createProvider, createAnthropicProvider, createOpenAIProvider, LlmError, BudgetExhaustedError, AbortedError, normalizeUsage, zeroUsage } from "./providers/index.js";
