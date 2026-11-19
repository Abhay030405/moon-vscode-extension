// task-c.mjs: break or restore the MAIN model's key in TrueForge, for Task C of the demo.
//
//   node scripts/demo/task-c.mjs break      give the main provider an invalid key (keeps its models)
//   node scripts/demo/task-c.mjs restore    re-register every provider from .env (scripts/setup-providers.mjs)
//   node scripts/demo/task-c.mjs break --dry-run   show what would change, change nothing
//
// The main provider name comes from config/moon.json (models.main.provider).
// Talks only to the local TrueForge API. Never calls a model provider and never prints a key.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, fail, readJson, runMain } from "../lib/local-files.mjs";

const PROVIDERS_ROUTE = "/api/v1/settings/model-providers";
const INVALID_KEY = "moon-demo-invalid-key";

async function api(baseUrl, method, body) {
  let res;
  try {
    res = await fetch(new URL(PROVIDERS_ROUTE, baseUrl), {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    fail(`TrueForge is not reachable at ${baseUrl}. Start it first.`);
  }
  const text = await res.text();
  if (!res.ok) fail(`${method} ${PROVIDERS_ROUTE} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function breakMain(moon, dryRun) {
  const name = moon.models?.main?.provider;
  const providers = (await api(moon.trueforge.baseUrl, "GET")).data ?? [];
  const current = providers.find((p) => p.name === name);
  if (!current) fail(`Provider "${name}" (models.main.provider) is not registered in TrueForge.`);
  const m = current.manifest;
  const manifest = {
    type: m.type,
    auth: { api_key: INVALID_KEY },
    models: (m.models ?? []).map(({ model_id, name, properties }) => ({ model_id, name, properties })),
  };
  if (m.type === "custom") manifest.name = name;
  if (m.base_url) manifest.base_url = m.base_url;
  if (dryRun) {
    console.log(`Would PUT provider "${name}" with an invalid key and models: ${manifest.models.map((x) => x.name).join(", ")}`);
    return;
  }
  await api(moon.trueforge.baseUrl, "PUT", { manifest });
  console.log(`Main provider "${name}" now has an invalid key. Repeat Task A: Moon should switch to the backup.`);
  console.log("Afterwards run:  node scripts/demo/task-c.mjs restore");
}

function restore() {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "setup-providers.mjs")], { stdio: "inherit" });
  if (r.status !== 0) fail("setup-providers failed; see above.");
  console.log("\nKeys restored from .env. Moon moves back to the main model at the start of the next task.");
}

async function main() {
  const [action, flag] = process.argv.slice(2);
  const moon = readJson("config/moon.json", "Copy config/moon.example.json to config/moon.json.");
  if (action === "break") await breakMain(moon, flag === "--dry-run");
  else if (action === "restore") restore();
  else fail("Usage: node scripts/demo/task-c.mjs break|restore [--dry-run]");
}

await runMain(main);
