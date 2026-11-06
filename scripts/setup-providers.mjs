// setup-providers.mjs: register Moon's model providers in TrueForge, using
// config/trueforge.json (which providers and models) and .env (keys, endpoint, model ids).
//
// - Talks ONLY to the local TrueForge HTTP API (trueforge.baseUrl in config/moon.json).
//   It never calls a model provider.
// - Create-or-replace (PUT), so running it again is safe. Other providers are left alone.
// - Never prints secret values: only variable names and "set" / "missing".
//
// Usage (TrueForge must be running):  node scripts/setup-providers.mjs
// or the wrappers: scripts/setup-providers.ps1 / scripts/setup-providers.sh

import { fail, readEnvFile, readJson, runMain } from "./lib/local-files.mjs";

const PROVIDERS_ROUTE = "/api/v1/settings/model-providers";
const CATALOG_ROUTE = "/api/v1/catalogs/model-providers";
// TrueForge names: lowercase letters, digits and hyphens (its ResourceName rule).
const NAME_RE = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

// "DeepSeek-V4.1-Flash-2" -> "deepseek-v4-1-flash-2"
function toResourceName(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function api(baseUrl, method, route, body) {
  let res;
  try {
    res = await fetch(new URL(route, baseUrl), {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    fail(`Cannot reach TrueForge at ${baseUrl} (${err.cause?.code ?? err.message}). Start it first with scripts/start-trueforge.`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    // TrueForge redacts keys in responses; print its error message only.
    const raw = json.error?.message ?? json.message ?? json.raw ?? text;
    const message = typeof raw === "string" ? raw : JSON.stringify(raw);
    const blocked = message.match(/Outbound URL blocked for host "([^"]+)"/);
    const hint = blocked
      ? `\nTrueForge's network guard refused that host. A common cause: your DNS also returns a NAT64 "64:ff9b::" IPv6 address, which the guard treats as private.` +
        `\nFix: restart TrueForge with scripts/start-trueforge (it allows the hosts of the endpoints in config/trueforge.json), then run this again. Or add \"${blocked[1]}\" to trueforge.allowedOutboundHosts in config/moon.json.`
      : "";
    fail(`${method} ${route} failed with HTTP ${res.status}: ${message}${hint}`);
  }
  return json;
}

async function main() {
  const moon = readJson("config/moon.json", "Create it: copy config/moon.example.json to config/moon.json.");
  const tfConfig = readJson("config/trueforge.json", "Create it: copy config/trueforge.example.json to config/trueforge.json.");
  const env = readEnvFile();
  const baseUrl = moon.trueforge?.baseUrl;
  if (!baseUrl) fail("config/moon.json has no trueforge.baseUrl.");

  // 1. Check every .env variable the providers need, without printing values.
  const needed = new Set();
  for (const p of tfConfig.providers) {
    if (p.apiKeyEnv) needed.add(p.apiKeyEnv);
    if (p.baseUrlEnv) needed.add(p.baseUrlEnv);
    for (const m of p.models) if (m.idEnv) needed.add(m.idEnv);
  }
  console.log("Variables from .env:");
  const missing = [];
  for (const name of needed) {
    const set = Boolean(env[name]);
    console.log(`  ${name}: ${set ? "set" : "missing"}`);
    if (!set) missing.push(name);
  }
  if (missing.length) fail(`Fill in ${missing.join(", ")} in .env and run again.`);

  // 2. TrueForge's shipped catalog gives window sizes for well-known models.
  const catalog = (await api(baseUrl, "GET", CATALOG_ROUTE)).data ?? [];

  // 3. Build and PUT each provider.
  for (const p of tfConfig.providers) {
    const preset = catalog.find((c) => c.type === p.type);
    const models = p.models.map((m) => {
      const modelId = m.id ?? env[m.idEnv];
      const name = m.name ?? toResourceName(modelId);
      if (!NAME_RE.test(name)) fail(`Model name "${name}" (provider ${p.name}) must be lowercase letters, digits and hyphens.`);
      const known = preset?.models?.find((pm) => pm.model_id === modelId)?.properties ?? {};
      const properties = { ...known };
      if (m.contextLength) properties.context_length = m.contextLength;
      if (m.maxOutputTokens) properties.max_output_tokens = m.maxOutputTokens;
      return { model_id: modelId, name, properties };
    });

    const manifest = { type: p.type, auth: { api_key: env[p.apiKeyEnv] }, models };
    if (p.type === "custom") manifest.name = p.name;
    else if (p.name !== p.type) fail(`Provider "${p.name}": TrueForge names well-known providers by their type, so name must be "${p.type}".`);
    if (p.baseUrlEnv) manifest.base_url = env[p.baseUrlEnv];
    else if (p.baseUrl) manifest.base_url = p.baseUrl;

    await api(baseUrl, "PUT", PROVIDERS_ROUTE, { manifest });
    console.log(`\nRegistered provider "${p.name}" (${p.type})`);
  }

  // 4. Verify: list what TrueForge now has (keys are redacted by TrueForge and not printed here).
  const configured = (await api(baseUrl, "GET", PROVIDERS_ROUTE)).data ?? [];
  console.log("\nProviders now in TrueForge:");
  for (const c of configured) {
    const ours = tfConfig.providers.some((p) => p.name === c.name) ? "" : "  (not managed by Moon)";
    const list = (c.manifest?.models ?? []).map((m) => `${c.name}/${m.name} -> ${m.model_id}`).join(", ");
    console.log(`  ${c.name} [${c.manifest?.type}]: ${list}${ours}`);
  }
  const absent = tfConfig.providers.filter((p) => !configured.some((c) => c.name === p.name));
  if (absent.length) fail(`Not found after registering: ${absent.map((p) => p.name).join(", ")}`);

  console.log("\nUse these provider/model names in config/moon.json (models.main / models.backup).");
}

await runMain(main);
