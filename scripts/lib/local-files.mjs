// Helpers shared by the scripts in scripts/: read Moon's local JSON config and .env.
// (Moon's own code reads config only through packages/core/src/shared/config.ts;
// these helpers are for setup scripts, which also need .env.)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class SetupError extends Error {}

// Throw instead of process.exit(): exiting while fetch handles are open crashes Node on Windows.
export function fail(message) {
  throw new SetupError(message);
}

/** Reads a JSON file relative to the repo root; `hint` says how to create it if missing. */
export function readJson(relPath, hint) {
  const path = join(ROOT, relPath);
  if (!existsSync(path)) fail(`${relPath} not found. ${hint}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${relPath} is not valid JSON: ${err.message}`);
  }
}

/** Minimal .env parser: KEY=value, optional "export", optional quotes, # comments. */
export function readEnvFile() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) fail(".env not found. Create it: copy .env.example to .env and fill it in.");
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return env;
}

/** Runs main(), printing a SetupError as a clean one-line error with exit code 1. */
export async function runMain(main) {
  try {
    await main();
  } catch (err) {
    if (!(err instanceof SetupError)) throw err;
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
