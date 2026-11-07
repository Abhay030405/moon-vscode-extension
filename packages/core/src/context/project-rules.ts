// The project's own instructions for AI agents (AGENTS.md or CLAUDE.md), if it has one.
// Given to the agent at the start of agent mode, cut to a token budget.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PROJECT_RULE_FILES } from "../shared/constants.js";
import { cutToTokens, estimateTokens } from "./budget.js";

export interface ProjectRules {
  /** Which file it came from, e.g. "AGENTS.md". */
  file: string;
  text: string;
  tokens: number;
  cut: boolean;
}

export function readProjectRules(root: string, maxTokens: number): ProjectRules | undefined {
  for (const file of PROJECT_RULE_FILES) {
    let raw: string;
    try {
      raw = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    if (!raw.trim()) continue;
    const { text, cut } = cutToTokens(raw.trim(), maxTokens);
    return { file, text, tokens: estimateTokens(text), cut };
  }
  return undefined;
}
