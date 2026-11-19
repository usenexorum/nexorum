# Nexorum: what is left before launch

Everything below needs your own login, signature or payment.

1. GitHub + npm: double-click `PUBLISH.cmd` (creates github.com/usenexorum/nexorum, pushes, runs the tests, publishes to npm).
2. npm: inside `cli/`, run `npm login` then `npm publish` (package name `nexorum` was free on 2026-11-18).
3. Domain: buy one (nexorum.dev was free on 2026-11-18).
4. X: register the handle.
5. Fill `tools/site-config.cjs` (ca, x, github, npm, site), then rebuild:
   node tools/build-site.cjs && node tools/build-pages.cjs && node tools/make-og.cjs
6. Host it: copy `site/` and `server/` to the server, `cd server && npm install --omit=dev`,
   run `node server.mjs` behind nginx (PORT=5210 HOST=127.0.0.1 TRUST_PROXY=1).

## Live mode on /try (optional, costs money)
Off by default. To switch it on, set on the server only (never in the page):
  ANTHROPIC_API_KEY=...            your key, billed to you
  NEXORUM_SIM_MODEL=claude-opus-5-5 (default; any current model id)
  NEXORUM_SIM_DAILY_TOKENS=2000000  daily cap for the whole site (resets midnight UTC)
  NEXORUM_SIM_RPM=60                requests per visitor per minute (one live dream makes ~20 calls)
  NEXORUM_SIM_MAX_TOKENS=2048       max output tokens per call
When the daily cap is used up, the page switches visitors back to the recorded example.

## Local preview
  cd server && node server.mjs   ->  http://127.0.0.1:5210/
Tests: `cd cli && npm test` (26) · `cd server && npm test` (11)

## After pushing to GitHub
`.github/workflows/ci.yml` runs on every push: the CLI tests, a real `npm pack` + `npm install -g` smoke test, and the server tests,
on Linux, macOS and Windows with Node 22 and 24. Check the Actions tab once; green there is the macOS/Linux confirmation.
