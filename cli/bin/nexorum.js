#!/usr/bin/env node
import { main } from "../src/cli.js";

// When the reader of our output goes away (`nexorum ... | head`), stop quietly instead of crashing with EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

process.exitCode = await main(process.argv.slice(2), process.env);
