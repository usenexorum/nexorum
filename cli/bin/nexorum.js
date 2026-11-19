#!/usr/bin/env node
// Old Node: say so plainly instead of failing somewhere deep with a confusing error.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`nexorum needs Node.js 22 or newer (you have ${process.version}). Get the LTS from https://nodejs.org and run the command again.\n`);
  process.exit(1);
}

// When the reader of our output goes away (`nexorum ... | head`), stop quietly instead of crashing with EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

const { main } = await import("../src/cli.js");
process.exitCode = await main(process.argv.slice(2), process.env);
