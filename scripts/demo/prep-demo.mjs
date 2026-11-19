// prep-demo.mjs: get everything ready for recording the demo video (Tasks A, B, C).
//
// 1. Checks that TrueForge answers and has the main and backup models from config/moon.json.
// 2. Clones the Flask repo from config/test-repos.json into a NEW folder named
//    <dir>-demo-<date-time>. Moon keys its chat history by folder path, so a new folder
//    starts with no history (the agent cannot offer an earlier "flask config" chat in Task B).
// 3. Hides the repo's localIgnores from git status and runs its setup commands (venv + deps).
// 4. Prints the folder to open in VS Code and the demo app path for `flask config`.
//
// Talks only to the local TrueForge API and git/python. Never calls a model provider.
// Usage: node scripts/demo/prep-demo.mjs   (or prep-demo.ps1 / prep-demo.sh)

import { execSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, fail, readJson, runMain } from "../lib/local-files.mjs";

const PROVIDERS_ROUTE = "/api/v1/settings/model-providers";
const DEMO_REPO_NAME = "flask";

function run(cmd, cwd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function checkTrueForge(moon) {
  const baseUrl = moon.trueforge?.baseUrl;
  let res;
  try {
    res = await fetch(new URL(PROVIDERS_ROUTE, baseUrl));
  } catch {
    fail(`TrueForge is not reachable at ${baseUrl}. Start it with scripts/start-trueforge first.`);
  }
  if (!res.ok) fail(`TrueForge answered HTTP ${res.status} on ${PROVIDERS_ROUTE}.`);
  const providers = (await res.json()).data ?? [];
  for (const role of ["main", "backup"]) {
    const want = moon.models?.[role];
    const provider = providers.find((p) => p.name === want?.provider);
    const ok = provider?.manifest?.models?.some((m) => m.name === want.model);
    console.log(`  ${role}: ${want?.provider}/${want?.model} ${ok ? "found" : "MISSING"}`);
    if (!ok) fail(`Register the ${role} model first: scripts/setup-providers.`);
  }
}

async function main() {
  const moon = readJson("config/moon.json", "Copy config/moon.example.json to config/moon.json.");
  const repo = readJson("config/test-repos.json", "").repos.find((r) => r.name === DEMO_REPO_NAME);
  if (!repo) fail(`No "${DEMO_REPO_NAME}" entry in config/test-repos.json.`);

  console.log("1. TrueForge and models");
  await checkTrueForge(moon);

  const dir = join(ROOT, `${repo.dir}-demo-${stamp()}`);
  console.log(`\n2. Fresh clone of ${repo.url} at ${repo.ref}`);
  if (existsSync(dir)) fail(`${dir} already exists. Wait a minute and run again.`);
  run(`git -c advice.detachedHead=false clone --quiet --depth 1 --branch ${repo.ref} ${repo.url} "${dir}"`, ROOT);
  const head = execSync("git rev-parse --short=8 HEAD", { cwd: dir }).toString().trim();
  if (!head.startsWith(repo.commit)) fail(`HEAD is ${head}, expected ${repo.commit}.`);
  console.log(`  HEAD ${head} (matches ${repo.commit})`);

  console.log("\n3. Local ignores and setup");
  appendFileSync(join(dir, ".git", "info", "exclude"), "\n" + (repo.localIgnores ?? []).join("\n") + "\n");
  const steps = process.platform === "win32" ? repo.setup?.windows : repo.setup?.unix;
  for (const cmd of steps ?? []) run(cmd, dir);
  const status = execSync("git status --porcelain", { cwd: dir }).toString().trim();
  if (status) fail(`git status is not clean after setup:\n${status}`);
  console.log("  git status: clean");

  const app = join(ROOT, "scripts", "demo", "demo_app.py");
  console.log("\nReady. Next:");
  console.log(`  - Open this folder in VS Code:  code "${dir}"`);
  console.log(`  - Demo app for Task B's check:  flask --app "${app}" config`);
  console.log("  - Follow docs/demo/video-script.md");
}

await runMain(main);
