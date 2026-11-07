// Highlights risky commands on the approval card (deleting files, network, git history,
// paths outside the project, secrets). It never blocks: the user decides.

import { RISKY_COMMAND_PATTERNS } from "../shared/constants.js";

const CHECKS = RISKY_COMMAND_PATTERNS.map((p) => ({ test: new RegExp(p.pattern, "i"), reason: p.reason }));

/** Why a command looks risky; empty when nothing stands out. */
export function commandRisks(command: string): string[] {
  return [...new Set(CHECKS.filter((c) => c.test.test(command)).map((c) => c.reason))];
}
