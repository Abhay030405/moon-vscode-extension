// The command policy (OWASP LLM03 #7, LLM01 #8 "Rule of Two"). Every command the agent asks to
// run gets a verdict BEFORE the user sees a card:
//   block - never runs, no card (encoded or piped-to-shell commands, git push, system changes);
//   warn  - the card shows why in red, the user decides;
//   ok    - an ordinary card.
// The command is split on && || ; | & newlines $( ) and backticks first, so a harmless start
// can't hide a bad end. Network commands are blocked outright while the turn is "tainted":
// the agent has read something from outside the project (a web page, a GitHub issue, an
// earlier conversation), so an injected instruction can't be one click from sending data out.
// The patterns are in config (security.blockedCommandPatterns / networkCommandPatterns).

import type { MoonConfig } from "../shared/config.js";
import { commandRisks } from "./command-check.js";
import { hasHidden } from "./unicode.js";

export interface CommandVerdict {
  /** Set when the command must not run; says why. */
  blocked?: string;
  /** Reasons to look twice, shown on the card. */
  warnings: string[];
  /** True when the command uses the network (shown so the user knows it may fail: network is blocked for commands). */
  network: boolean;
}

/** Splits a command line into the commands it chains (also the bodies of $( ) and backticks). */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  for (const sub of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) parts.push((sub[1] ?? sub[2] ?? "").trim());
  for (const piece of command.split(/&&|\|\||[;|&\n\r]/)) parts.push(piece.trim());
  return parts.filter((p) => p.length > 0);
}

export function checkCommand(command: string, security: MoonConfig["security"], tainted: boolean): CommandVerdict {
  const parts = [command, ...splitCommand(command)];
  const match = (list: readonly { pattern: string; reason: string }[]) =>
    list.find((rule) => parts.some((p) => new RegExp(rule.pattern, "i").test(p)))?.reason;

  if (hasHidden(command)) return { blocked: "the command contains hidden characters (what you would see is not what runs)", warnings: [], network: false };
  const blocked = match(security.blockedCommandPatterns);
  if (blocked) return { blocked, warnings: [], network: false };

  const network = match(security.networkCommandPatterns);
  if (network && tainted) {
    return {
      blocked: `${network}, right after the agent read content from outside the project (an injected instruction could be sending your data out)`,
      warnings: [],
      network: true,
    };
  }
  const warnings = [...new Set([...commandRisks(command), ...parts.slice(1).flatMap((p) => commandRisks(p))])];
  if (network && !warnings.includes(network)) warnings.push(network);
  if (network && security.blockCommandNetwork) warnings.push("network access is blocked for commands (security.blockCommandNetwork), so this may fail");
  return { warnings, network: network !== undefined };
}
