// allowed-hosts.mjs: print the JSON list for TrueForge's OUTBOUND_URL_ALLOWED_HOSTS.
//
// = trueforge.allowedOutboundHosts from config/moon.json (localhost, for Moon's MCP server)
// + the host of every provider endpoint in config/trueforge.json (baseUrl, or the .env
//   variable named by baseUrlEnv). Some networks resolve cloud endpoints such as Azure to an
//   address TrueForge's guard treats as private (e.g. NAT64 "64:ff9b::"), which blocks the
//   model calls; allowing our own configured endpoints avoids that.
//
// Used by scripts/start-trueforge.ps1 / .sh.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readEnvFile, readJson, runMain } from "./local-files.mjs";

await runMain(async () => {
  const moon = readJson("config/moon.json", "Create it: copy config/moon.example.json to config/moon.json.");
  const hosts = new Set(moon.trueforge.allowedOutboundHosts);

  if (existsSync(join(ROOT, "config/trueforge.json"))) {
    const tf = readJson("config/trueforge.json", "");
    const env = existsSync(join(ROOT, ".env")) ? readEnvFile() : {};
    for (const p of tf.providers ?? []) {
      const url = p.baseUrl ?? (p.baseUrlEnv ? env[p.baseUrlEnv] : undefined);
      if (!url) continue;
      try {
        hosts.add(new URL(url).hostname);
      } catch {
        // A malformed URL is reported by setup-providers; don't block TrueForge from starting.
      }
    }
  }

  console.log(JSON.stringify([...hosts]));
});
