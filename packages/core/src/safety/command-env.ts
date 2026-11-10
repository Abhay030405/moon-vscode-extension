// The environment a command the agent runs gets (OWASP LLM02 #2, LLM03 #4).
// VS Code's own environment can hold tokens and API keys (GITHUB_TOKEN, AWS_*, ...). A command
// the user approved, say `pytest`, can run any code the project contains, so it must not
// inherit them. Commands get only an allowed list of variables, never one whose NAME looks
// like a secret, plus Moon's own commandEnv. With security.blockCommandNetwork on, proxy
// variables point at a dead local port, so most tools (pip, npm, curl, Python, Node) can't
// reach the internet. That is a speed bump, not a sandbox: a program can ignore the proxy.

import type { MoonConfig } from "../shared/config.js";

/** Only the allowed variables of `base`, minus anything whose name looks like a secret. */
export function allowedEnv(base: NodeJS.ProcessEnv, security: MoonConfig["security"]): NodeJS.ProcessEnv {
  const allow = new Set(security.commandEnvAllow.map((n) => n.toUpperCase()));
  const secretName = new RegExp(security.secretEnvNamePattern, "i");
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!allow.has(name.toUpperCase())) continue;
    if (secretName.test(name)) continue;
    env[name] = value;
  }
  if (security.blockCommandNetwork) Object.assign(env, security.networkBlockEnv);
  return env;
}

/** Names of the variables `allowedEnv` removed (for tests and the audit log; never the values). */
export function droppedEnvNames(base: NodeJS.ProcessEnv, security: MoonConfig["security"]): string[] {
  const kept = allowedEnv(base, security);
  return Object.keys(base).filter((name) => !(name in kept));
}
