// Shared helpers for the behavior and end-to-end test files. Every test works in a fresh temp folder; the real
// ~/.nexorum, ~/.claude, ~/.codex, ~/.cursor and Claude Desktop config are never touched, and no real LLM is called.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BIN = path.join(ROOT, "bin", "nexorum.js");
export const MOCK = pathToFileURL(path.join(ROOT, "test", "mock-llm.mjs")).href;

export function makeTmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Minimal env for child processes: everything points into `tmp`, PATH is empty unless given. */
export function baseEnv(tmp, extra = {}) {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  return Object.fromEntries(
    Object.entries({ NEXORUM_HOME: path.join(tmp, "nx"), HOME: home, USERPROFILE: home, PATH: "", SystemRoot: process.env.SystemRoot, TEMP: tmp, TMP: tmp, ...extra }).filter(
      ([, v]) => v !== undefined,
    ),
  );
}

/** Runs the real CLI in a child process. */
export function runCli(env, args, { input, cwd, mock = false, extraEnv = {} } = {}) {
  const r = spawnSync(process.execPath, [...(mock ? ["--import", MOCK] : []), BIN, ...args], {
    cwd: cwd ?? env.TEMP,
    input: input ?? "",
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function suite(name) {
  let pass = 0;
  let fail = 0;
  const t = async (title, fn) => {
    try {
      await fn();
      pass++;
      console.log(`ok   ${title}`);
    } catch (e) {
      fail++;
      console.log(`FAIL ${title}\n     ${String(e?.stack ?? e).split("\n").slice(0, 8).join("\n     ")}`);
    }
  };
  const done = (cleanup) => {
    try {
      cleanup?.();
    } catch {}
    console.log(`\n${name}: ${pass}/${pass + fail} tests passed`);
    process.exitCode = fail ? 1 : 0;
  };
  return { t, done };
}

export const page = (name, desc, body) => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;
export const text = (r) => r.content[0].text;

/** A fake executable on PATH (a .cmd on Windows, a shell script elsewhere). `script` gets the platform's body. */
export function fakeBin(dir, name, { win, sh }) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n${win.join("\r\n")}\r\n`);
  else {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!/bin/sh\n${sh.join("\n")}\n`);
    fs.chmodSync(f, 0o755);
  }
}

/** Env additions a child needs to run fake .cmd binaries through a shell. */
export function shellEnv(binDir) {
  return process.platform === "win32"
    ? { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" }
    : { PATH: `${binDir}:/bin:/usr/bin` };
}
