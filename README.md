# Nexorum

Long-term memory for AI coding agents. Notes, transcripts and a small markdown wiki live as plain files on your
machine; a **dream** pass reviews and corrects them, and you approve every change before it goes live.
Works with Claude Code, Codex, Cursor, Hermes, Claude Desktop and any MCP client. Free, MIT, zero dependencies.

```bash
npx nexorum init
```

| Folder | What it is |
|---|---|
| [`cli/`](cli/) | The `nexorum` npm package: CLI, MCP server (17 tools), Claude Code hooks, dream engine. [README](cli/README.md) |
| [`site/`](site/) | The website (static, generated). `/try` runs the same engine in the browser. |
| [`server/`](server/) | Serves `site/` and the capped proxy behind the live simulation (needs `ANTHROPIC_API_KEY` only for Live mode). |
| [`tools/`](tools/) | Site generators, QA and browser tests. |

## Develop

```bash
cd cli && npm test                      # engine and CLI tests
node tools/build-site.cjs && node tools/build-pages.cjs   # rebuild the site
cd server && npm install && npm start   # http://127.0.0.1:5210/
```

CI (`.github/workflows/ci.yml`) runs the tests and an install smoke test on Linux, macOS and Windows.

## License

MIT
