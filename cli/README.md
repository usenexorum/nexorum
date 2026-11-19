# nexorum

**Long-term memory for AI agents. Plain files on your machine, and you review every change.**

The npm package and the command it installs are both **`nexorum`**.

```sh
npx nexorum init
```

Nexorum keeps what your agent learns as short notes, session transcripts and a small markdown wiki in `~/.nexorum`. A background pass called a **dream** reviews them, corrects stale facts and proposes better pages. Nothing changes until you approve the diff. No account, no server, no embeddings: search is BM25 over notes and wiki.

## Install

Requires Node 22+. One package, zero dependencies (the core library is inside it).

```sh
npx nexorum init
```

`init` finds Claude Code, Codex, Hermes, Cursor and Claude Desktop on your machine and sets up the MCP server and the hooks. Add `--dry-run` to preview; files it edits are backed up first.

MCP server only, any client:

```sh
claude mcp add nexorum -- npx -y nexorum mcp
codex mcp add nexorum -- npx -y nexorum mcp
```

Clients that take an `mcpServers` JSON block (Cursor, Claude Desktop, Hermes Agent, Antigravity, omp, OpenClaw ...):

```json
{ "mcpServers": { "nexorum": { "command": "npx", "args": ["-y", "nexorum", "mcp"] } } }
```

Optional, Claude Code: look memory up before every prompt (nothing is added when nothing matches).

```sh
npm install -g nexorum
nexorum init --claude-code --prompt-recall
```

This needs `nexorum` on your PATH, because it runs before every prompt and `npx` is too slow for that (seconds per call, against a fraction of a second installed).

## What you get

| Piece | Command | Who uses it |
| --- | --- | --- |
| CLI | `nexorum remember`, `recall`, `status`, `dream`, `apply`, ... | you |
| MCP server | `nexorum mcp`: 17 tools and a context resource | your agent |
| Claude Code hooks | `nexorum hook session-start\|user-prompt\|stop` | Claude Code |

## Dreaming

A dream writes a **proposal**, never the live wiki. Review it with `nexorum diff`, then `nexorum apply` or `nexorum reject`. Every applied write is a version you can `nexorum restore`.

**Two paths, and the second needs no API key.** Either `nexorum dream` with your own LLM key (below), or through the agent you already use: ask it to run a dream and it calls the `dream_prepare` and `dream_submit` tools, using its own model and your existing plan.

How `nexorum dream` runs:

1. **Select.** Pending transcripts (oldest first, at most 50 / 6,000,000 characters) and notes not yet consolidated (at most 300). It prints the counts and a rough token estimate, then asks `Proceed? [y/N]` (or takes `--yes`). It refuses when the estimate is above the budget.
2. **Stage.** The live wiki is copied into `proposals/<id>/wiki`, and the hashes of the live pages are kept in `base.json`.
3. **Analyze.** One analyzer agent per input (3 in parallel) verifies what the wiki claims against it, enriches it with exact details and writes small linked pages. Inputs over 120,000 characters are split into parts.
4. **Organize.** One organizer agent merges duplicates, marks conflicts, fixes links and keeps `/_index.md` (the catalog, under 4,096 characters) complete.
5. **Propose.** The result is saved as a proposal under review. If the run stopped early (budget, errors) after pages were written, the proposal is kept and marked partial.

All agents share one token budget, checked before every model call (it can overshoot by at most the calls already in flight; you see 50/80/100% messages). Transient API errors are retried with backoff.

### Dreaming with your own key

Only for `nexorum dream`. Through your agent none of this is needed.

| Variable | Meaning |
| --- | --- |
| `NEXORUM_LLM_PROVIDER` | `anthropic` (default) or `openai` (any OpenAI-compatible `/chat/completions` endpoint with tool calling, for example a local router) |
| `NEXORUM_LLM_API_KEY` | falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `NEXORUM_LLM_BASE_URL` | openai default `http://localhost:20128/v1` |
| `NEXORUM_ANALYZER_MODEL`, `NEXORUM_ORGANIZER_MODEL` | default `claude-haiku-5-5` for anthropic; required for openai |

It prints a token estimate and asks before spending; the default budget is 3,000,000 tokens and a dream that would exceed it is refused. Dream agents get document tools only (`list_docs`, `read_doc`, `grep_docs`, `write_doc`, `edit_doc`, and for the organizer `delete_doc`, `rename_doc`, then `submit`; no shell, no network) and treat transcripts as untrusted data. Quality depends on the model you use.

## Commands

| Command | What it does |
| --- | --- |
| `init [--claude-code] [--codex] [--hermes] [--cursor] [--claude-desktop] [--all] [--dry-run] [--home D] [--dir D] [--no-agents-md] [--prompt-recall]` | Merges the `SessionStart` and `Stop` hooks into `~/.claude/settings.json` (backup `settings.json.nexorum-bak`, your own hooks are kept, safe to run twice) and runs `claude mcp add` / `codex mcp add` / `hermes mcp add` (prints the command when the binary is missing). Adds an `mcpServers.nexorum` entry to Cursor's `~/.cursor/mcp.json` and Claude Desktop's `claude_desktop_config.json` (backup first). `--codex` also adds a short marked block to the project's `AGENTS.md` (backup first; refuses the home folder; `--no-agents-md` skips it), because Codex has no hooks and uses a memory server reliably only when its project instructions say so. `--prompt-recall` adds the `UserPromptSubmit` hook and needs `nexorum` on PATH. With no client flag it sets up every client it finds. |
| `mcp` | MCP server on stdio, 17 tools: `remember`, `update_note`, `recall` (filters `kind`, `since`), `forget`, `context`, `read_document`, `search_documents`, `list_documents`, `related_documents`, `document_history`, `list_notes`, `memory_status`, `save_transcript`, `list_proposals`, `show_proposal`, `dream_prepare`, `dream_submit`; resource `nexorum://context`. Near-duplicate notes are flagged, identical ones refused. Memory text is returned as data, never as instructions. There is no tool to start a paid dream or to apply a proposal. |
| `hook session-start\|user-prompt\|stop` | Claude Code hooks (JSON on stdin). Start injects the context digest; `user-prompt` adds up to 3 matching notes or pages (once per session) and stays silent when nothing matches (`NEXORUM_PROMPT_RECALL=0` turns it off); stop stores the session transcript. Always exits 0, so a hook can never block a prompt. |
| `log [--file F \| -] [--source S] [--id ID]` | Store a transcript (`{"events":[{role,content}]}` or an array) from any other agent. The same `--id` replaces it; it becomes pending again only when the events changed. |
| `import omp [--dir D] [--session FILE] [--all] [--since DATE]` | Store omp sessions as transcripts (default: sessions whose working directory is the current one; `--all`: every session, each into the space named after its folder). Idempotent. |
| `remember "text"`, `recall "query" [--limit N] [--kind note\|wiki] [--since DATE]`, `context [--max-chars N]`, `status` | Notes, search, digest, counts. |
| `dream [--budget TOKENS] [--instructions "..."] [--yes] [--dry-run] [--apply] [--since DATE] [--max-inputs N]` | Analyzes pending transcripts and notes against a staged copy of the wiki. Prints the estimate and asks `Proceed? [y/N]` (or needs `--yes`; required without a terminal). Writes a proposal; nothing touches the live wiki until you apply it (`--apply` applies only clean, non-partial runs). `--since` keeps transcripts updated at or after a date; `--max-inputs` caps how many (1 to 200, default 50). |
| `dream --if-due [--min-pending N=3] [--idle-minutes M=10] [--cooldown-hours H=6]` | For cron or Task Scheduler: does nothing (prints `not due: <reason>`, exit 0) unless enough transcripts are pending, the newest is old enough and the last proposal is past the cooldown. When due it is a normal dream. |
| `doctor [--json]` | Read-only health check: Node version, home folder writable, space files parse, Claude Code hooks, `claude` / `codex mcp list` (if on PATH), LLM config (the key is shown only as set or missing), pending work. One `PASS`/`WARN`/`FAIL` line each. Exit 0 unless a check fails. |
| `proposals`, `diff [id]`, `apply [id] [--force]`, `reject [id]` | Review. `apply` writes a path only if the live file still equals what the dream started from; others are skipped and listed (`--force` overrides). When every path was skipped, nothing is applied, the proposal stays under review and `apply` exits 1. Ids can be shortened to a unique prefix. |
| `restore <path> [--version N]`, `history [path]` | Every live write is a version (hand edits are kept as a version before they are overwritten). Restore any of them; without `--version`, the newest version that differs from the live page. |
| `retention [--days 30]` | Deletes transcripts dreamed more than N days ago (also done after `dream` and `apply`). |

Global: `--space NAME` (default `$NEXORUM_SPACE`, else the current folder's name), `--help`, `--version`.

Exit codes: `0` ok, `1` runtime error, `2` usage or configuration error.

### Scheduled dreams

`--if-due` is safe to run often. When it is due it spends your tokens (bounded by `--budget`) and writes a proposal for you to review; it never touches the live wiki unless you also pass `--apply`.

```sh
# Linux or macOS crontab, every 30 minutes, key read from a file only you can read
*/30 * * * * . ~/.nexorum-env && nexorum dream --if-due --yes --budget 500000 >> ~/.nexorum/dream.log 2>&1
```

```powershell
# Windows Task Scheduler (set NEXORUM_LLM_API_KEY as a user environment variable first)
schtasks /Create /SC MINUTE /MO 30 /TN "Nexorum dream" /TR "nexorum dream --if-due --yes --budget 500000"
```

## Where things live

`$NEXORUM_HOME` or `~/.nexorum`, one folder per *space* (`--space X`, else `$NEXORUM_SPACE`, else the current folder's name):

```
spaces/<space>/
  wiki/                  live markdown files (_index.md is the catalog); edit by hand or with git
  transcripts/<id>.json  session logs (pending, then dreamed)
  notes.jsonl            short notes, one per line
  state.json             notes already consolidated
  history/               log.jsonl + files/<n>-<sha8> snapshots of every live write
  proposals/<id>/        proposal.json, wiki/ (staged copy), base.json
```

All writes are atomic. Secrets (API keys, tokens, private keys, JWTs, bearer tokens) are scrubbed before anything is stored and on every page a dream writes; this is pattern-based, so it is not a guarantee.

## Privacy

Nothing leaves your machine except during `nexorum dream`, which sends the selected transcripts, notes and wiki pages to the LLM endpoint you configured. No telemetry, no accounts.

## Tests

```sh
npm test
```

The suite runs in a temporary folder (its own `NEXORUM_HOME`, `HOME` and empty `PATH`) with a mocked LLM; it never calls a real model.

MIT licence.
