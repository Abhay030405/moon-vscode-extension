// The ONE place that reads Moon's settings (config/moon.json).
// Every other file gets its settings from here, never from a literal value.
// Provider API keys are not part of this config: they live in .env and go to TrueForge only.

import { readFileSync } from "node:fs";
import { z } from "zod";

const positiveInt = z.number().int().positive();

const ModelRefSchema = z.strictObject({
  /** Provider name exactly as configured in TrueForge. */
  provider: z.string().min(1),
  /** Model id exactly as configured under that provider in TrueForge. */
  model: z.string().min(1),
});

export const MoonConfigSchema = z
  .strictObject({
    trueforge: z.strictObject({
      /** npm version of @truefoundry/trueforge to run, e.g. "latest" or "0.184.1". */
      version: z.string().min(1),
      baseUrl: z.string().url(),
      port: positiveInt,
      /** Local hosts TrueForge may still call (needed to reach Moon's MCP server). */
      allowedOutboundHosts: z.array(z.string().min(1)).min(1),
    }),
    models: z.strictObject({
      main: ModelRefSchema,
      backup: ModelRefSchema,
    }),
    resilience: z.strictObject({
      /** No streamed event within this time after sending: cancel and switch to backup. */
      watchdogMs: positiveInt,
      /** How many times to wait and retry on "too many requests" before switching. */
      rateLimitRetries: z.number().int().min(0),
      circuitBreaker: z.strictObject({
        /** First background check of the main model after switching to backup. */
        firstProbeMs: positiveInt,
        /** Each next check waits this many times longer. */
        backoffFactor: z.number().min(1),
        /** Longest wait between checks. */
        maxProbeMs: positiveInt,
      }),
    }),
    context: z.strictObject({
      /** Share of the model window used for the project map (0.1 = 10%). */
      mapBudgetRatio: z.number().gt(0).lte(1),
      mapBudgetMinTokens: positiveInt,
      mapBudgetMaxTokens: positiveInt,
      /** Window size to assume when TrueForge reports none for the model. */
      fallbackContextLength: positiveInt,
    }),
    tools: z.strictObject({
      searchMaxResults: positiveInt,
    }),
    flask: z.strictObject({
      repoUrl: z.string().url(),
      tag: z.string().min(1),
      /** Commit the tag must point to (a prefix is enough). */
      commit: z.string().min(7),
      /** Where to clone, relative to the Moon repo root. */
      dir: z.string().min(1),
      /** Python packages installed next to Flask so its tests run (Flask's "tests" group). */
      testRequirements: z.array(z.string().min(1)).min(1),
      /** Paths hidden from Flask's `git status` via .git/info/exclude (never committed). */
      localIgnores: z.array(z.string().min(1)),
    }),
  })
  .refine((c) => c.context.mapBudgetMinTokens <= c.context.mapBudgetMaxTokens, {
    message: "mapBudgetMinTokens must not be larger than mapBudgetMaxTokens",
    path: ["context", "mapBudgetMinTokens"],
  });

export type MoonConfig = z.infer<typeof MoonConfigSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Checks an already-parsed object and returns it typed, or throws a ConfigError listing every problem. */
export function parseMoonConfig(raw: unknown): MoonConfig {
  const result = MoonConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  - ${where}: ${issue.message}`;
  });
  throw new ConfigError(`Invalid Moon config:\n${problems.join("\n")}`);
}

/** Reads and checks a Moon config file. */
export function loadMoonConfig(filePath: string): MoonConfig {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read Moon config at ${filePath}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Moon config at ${filePath} is not valid JSON: ${(err as Error).message}`);
  }
  return parseMoonConfig(raw);
}
