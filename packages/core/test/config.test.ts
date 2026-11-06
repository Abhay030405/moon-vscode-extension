import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIG_DIR,
  ConfigError,
  EXAMPLE_CONFIG_FILE_NAME,
  loadMoonConfig,
  parseMoonConfig,
} from "../src/index.js";

const examplePath = fileURLToPath(
  new URL(`../../../${CONFIG_DIR}/${EXAMPLE_CONFIG_FILE_NAME}`, import.meta.url),
);
const example = (): any => JSON.parse(readFileSync(examplePath, "utf8"));

describe("Moon config", () => {
  it("accepts the committed example config", () => {
    const config = loadMoonConfig(examplePath);
    expect(config.models.main.provider).toBe(example().models.main.provider);
  });

  it("names the field that is wrong", () => {
    const raw = example();
    raw.resilience.watchdogMs = -5;
    expect(() => parseMoonConfig(raw)).toThrow(/resilience\.watchdogMs/);
  });

  it("rejects unknown keys so typos are caught", () => {
    const raw = example();
    raw.models.mian = raw.models.main;
    expect(() => parseMoonConfig(raw)).toThrow(ConfigError);
  });

  it("rejects a map budget whose minimum is above its maximum", () => {
    const raw = example();
    raw.context.mapBudgetMinTokens = raw.context.mapBudgetMaxTokens + 1;
    expect(() => parseMoonConfig(raw)).toThrow(/mapBudgetMinTokens/);
  });

  it("gives a clear error when the file is missing", () => {
    expect(() => loadMoonConfig("does-not-exist.json")).toThrow(/Cannot read Moon config/);
  });
});
