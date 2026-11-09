// The ONE place that reads Moon's settings (config/moon.json).
// Every other file gets its settings from here, never from a literal value.
// Provider API keys are not part of this config: they live in .env and go to TrueForge only.

import { readFileSync } from "node:fs";
import { z } from "zod";

// Zod's speed-up (JIT) probes the browser-only `navigator` global, which VS Code's extension
// host reports as a deprecation warning. Our config is tiny, so turn the speed-up off.
z.config({ jitless: true });

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
      /** Give up on a single TrueForge API request (not a model turn) after this long. */
      requestTimeoutMs: positiveInt,
      /** How often the extension re-checks that TrueForge is reachable (status bar). */
      statusCheckIntervalMs: positiveInt,
      /** Local hosts TrueForge may still call (needed to reach Moon's MCP server). */
      allowedOutboundHosts: z.array(z.string().min(1)).min(1),
      /** Link to a session in TrueForge's UI; {baseUrl} and {sessionId} are filled in. */
      sessionUrlTemplate: z.string().min(1),
    }),
    models: z.strictObject({
      main: ModelRefSchema,
      backup: ModelRefSchema,
    }),
    mcp: z.strictObject({
      /** Moon's MCP server (the editor's tools) listens here; TrueForge calls it. */
      host: z.string().min(1),
      /** 0 = pick any free port at start-up (Moon registers the real address with TrueForge). */
      port: z.number().int().min(0).max(65535),
      path: z.string().startsWith("/"),
      /** Name the server is registered under in TrueForge (lowercase, digits, hyphens). */
      serverName: z.string().regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
    }),
    agent: z.strictObject({
      /** Agent definition for agent mode, relative to the Moon repo root. */
      definitionFile: z.string().min(1),
      /** Agent definition for inline edit (Ctrl+I), relative to the Moon repo root. */
      inlineDefinitionFile: z.string().min(1),
    }),
    inline: z.strictObject({
      /** Lines of the file sent with an inline edit, before and after the selection. */
      contextLines: positiveInt,
      /** Most editor problems (errors, warnings) sent with an inline edit. */
      maxProblems: z.number().int().min(0),
    }),
    agentRun: z.strictObject({
      /** The hidden copy refuses projects with more files than this (after skipping ignored folders). */
      maxCopyFiles: positiveInt,
      /** ...or more bytes than this. */
      maxCopyBytes: positiveInt,
      /** A command the agent runs is stopped after this long. */
      commandTimeoutMs: positiveInt,
      /** Only the last this-many characters of a command's output go to the agent. */
      commandOutputMaxChars: positiveInt,
      /** On Stop or timeout: ask the command to end, then force-kill after this long (macOS/Linux). */
      killGraceMs: positiveInt,
      /**
       * Extra environment variables for commands run in the hidden copy. Placeholders:
       * {copy} = the copy's folder, {project} = the real project folder,
       * {pathSep} = ";" on Windows, ":" elsewhere, {env:NAME} = the current value of NAME.
       */
      commandEnv: z.record(z.string(), z.string()),
      /** Unchanged lines shown above and below each change in the review screen. */
      reviewContextLines: z.number().int().min(0),
      /** Characters of each command's output (its end) shown with the test results in the review. */
      reviewOutputChars: positiveInt,
    }),
    resilience: z.strictObject({
      /** No model output within this time after sending: cancel and switch to backup. */
      watchdogMs: positiveInt,
      /** Later in a turn (after a tool ran), no model output for this long: same. Longer, since big contexts reply slower. */
      stallMs: positiveInt,
      /** How many times to wait and retry on "too many requests" before switching. */
      rateLimitRetries: z.number().int().min(0),
      /** Wait before the first retry after "too many requests" (doubles each time). */
      rateLimitWaitMs: positiveInt,
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
      /** TrueForge compacts the conversation when its input reaches this share of the window. */
      compactionRatio: z.number().gt(0).lte(1),
      /** The map parses at most this many files (largest projects are mapped partly). */
      mapMaxFiles: positiveInt,
      /** Most tokens of the project's AGENTS.md / CLAUDE.md given to the agent. */
      rulesMaxTokens: positiveInt,
      /** An @file larger than this is given as its outline instead of its full text. */
      mentionMaxTokens: positiveInt,
      /** An @symbol is given as at most this many lines of its definition. */
      symbolMaxLines: positiveInt,
      /** Most entries the @ picker shows. */
      pickerMaxResults: positiveInt,
    }),
    tools: z.strictObject({
      /** Most matches search_text / find_usages / find_definition return. */
      searchMaxResults: positiveInt,
      /** Most paths list_files returns. */
      listFilesMaxResults: positiveInt,
      /** Most lines one read_file call returns. */
      readFileMaxLines: positiveInt,
      /** Files bigger than this are skipped by search and refused by read_file. */
      maxFileBytes: positiveInt,
      /** Hard cap on the text of any single tool result. */
      maxOutputChars: positiveInt,
      /** Folder names never listed or searched (anywhere in the tree). */
      ignoredDirs: z.array(z.string().min(1)),
    }),
    safety: z.strictObject({
      /** Files the tools never read, list or search (globs, relative to the project root). */
      secretFileGlobs: z.array(z.string().min(1)),
      /** Files matching a secret glob that are still allowed (e.g. .env.example). */
      secretFileExceptions: z.array(z.string().min(1)),
    }),
    ui: z.strictObject({
      /** Steady speed the panel reveals streamed answer text at (characters per second). */
      typingCharsPerSecond: positiveInt,
      /** The panel speeds up so it is never more than this far behind the real stream. */
      typingMaxLagMs: positiveInt,
      /** The approval card for a tool Moon has no card of its own for shows at most this much of its arguments. */
      approvalArgsMaxChars: positiveInt,
    }),
    memory: z.strictObject({
      /** Most tokens of the work record the work_log tool returns. */
      workLogMaxTokens: positiveInt,
      /** Most tokens one read_past_session call returns. */
      readPastMaxTokens: positiveInt,
      /** At most this many files are checked for changes on disk before each message. */
      staleCheckMaxFiles: positiveInt,
      /** The end of a command's output kept in the work record (characters). */
      commandTailChars: positiveInt,
      /** Conversations the /resume list loads at a time. */
      historyPageSize: positiveInt,
      /** Hidden copies kept for unfinished reviews (older ones are deleted at start). */
      maxKeptCopies: positiveInt,
    }),
    extras: z.strictObject({
      /** TrueForge's built-in web search and fetch (needs a provider key set in TrueForge). Off by default. */
      webSearch: z.boolean(),
      /** GitHub's MCP server, as registered in TrueForge (Settings, Connectors). Off by default. */
      github: z.strictObject({
        enabled: z.boolean(),
        serverName: z.string().min(1),
      }),
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
