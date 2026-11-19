// Errors with exit codes, and the hand-written argument parser.

export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = code;
  }
}

/** Bad command line or missing configuration: exit code 2. */
export class UsageError extends CliError {
  constructor(message) {
    super(message, 2);
    this.name = "UsageError";
  }
}

/**
 * spec: {bool: string[], string: string[], alias: {short: long}}
 * Accepts --flag, --flag=value, --flag value, -x aliases, `--` (everything after is positional), a bare `-` and
 * negative numbers as positionals. Unknown options are a UsageError.
 */
export function parseArgs(argv, { bool = [], string = [], alias = {} } = {}) {
  const bools = new Set(bool);
  const strings = new Set(string);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-" || !a.startsWith("-") || /^-\d/.test(a)) {
      positionals.push(a);
      continue;
    }
    let name;
    let inline;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      inline = eq < 0 ? undefined : a.slice(eq + 1);
    } else {
      name = alias[a.slice(1)];
      if (!name) throw new UsageError(`Unknown option ${a}`);
    }
    if (bools.has(name)) {
      if (inline !== undefined) throw new UsageError(`Option --${name} does not take a value`);
      flags[name] = true;
    } else if (strings.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`Option --${name} needs a value`);
      flags[name] = v;
    } else {
      throw new UsageError(`Unknown option --${name}`);
    }
  }
  return { flags, positionals };
}

/** A whole-number flag within [min, max], or `fallback` when absent. */
export function intFlag(flags, name, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(String(raw).trim())) throw new UsageError(`--${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return n;
}
