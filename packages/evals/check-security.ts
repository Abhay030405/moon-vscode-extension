// Moon's supply-chain and repo-hygiene check (OWASP LLM04, AGENTS.md section 1).
//   1. pnpm audit of the production dependencies: fails on a high or critical advisory.
//   2. Secret scan of every file git tracks, with the same detectors Moon uses on tool
//      results (core/src/safety/secret-scan.ts). Files that hold fake keys on purpose (tests,
//      eval canaries) say so with the marker below in their first lines.
//   3. A CycloneDX 1.5 SBOM of the production dependencies, written to docs/sbom.cdx.json.
//   4. Licences of the production dependencies: strong copyleft (GPL/AGPL) is flagged.
// Nothing here prints a secret value: only the file and the kind of secret.
//
// Usage (from the repo root): pnpm check:security

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "@moon/core";
import { REPO_ROOT } from "./runner";

/** A file with this text in its first lines holds fake secrets on purpose (tests, canaries). */
const ALLOW_MARKER = "moon-secret-scan: fake secrets on purpose";
const MARKER_LINES = 15;
/** Files larger than this are not scanned (lockfiles and images are skipped by type anyway). */
const MAX_SCAN_BYTES = 2_000_000;
const SKIP_FILES = /(^|\/)(pnpm-lock\.yaml|.*\.(png|jpg|jpeg|gif|ico|woff2?|ttf|vsix|wasm))$/i;
const COPYLEFT = /\b(A?GPL|SSPL)\b/i;
const SBOM_FILE = path.join(REPO_ROOT, "docs", "sbom.cdx.json");

const isWindows = process.platform === "win32";

function run(cmd: string, args: string[]): string {
  try {
    // pnpm is a .cmd script on Windows, which needs a shell; the arguments are fixed strings.
    return isWindows
      ? execSync([cmd, ...args].join(" "), { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      : execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // pnpm audit exits non-zero when it finds advisories; its JSON is still on stdout.
    const out = (err as { stdout?: string }).stdout;
    if (typeof out === "string" && out.trim()) return out;
    throw err;
  }
}

function audit(): string[] {
  const report = JSON.parse(run("pnpm", ["audit", "--prod", "--json"])) as { metadata?: { vulnerabilities?: Record<string, number> } };
  const counts = report.metadata?.vulnerabilities ?? {};
  const bad = (counts.high ?? 0) + (counts.critical ?? 0);
  console.log(`audit: ${JSON.stringify(counts)}`);
  return bad > 0 ? [`pnpm audit: ${bad} high or critical advisories (run pnpm audit --prod)`] : [];
}

function secretScan(): string[] {
  const files = run("git", ["ls-files"]).split(/\r?\n/).filter((f) => f && !SKIP_FILES.test(f));
  const problems: string[] = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    let text: string;
    try {
      if (statSync(abs).size > MAX_SCAN_BYTES) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    if (text.split("\n").slice(0, MARKER_LINES).some((l) => l.includes(ALLOW_MARKER))) continue;
    scanned++;
    const { redactions } = redactSecrets(text);
    if (redactions.length) problems.push(`secret scan: ${rel} holds ${[...new Set(redactions.map((r) => r.kind))].join(", ")}`);
  }
  console.log(`secret scan: ${scanned} tracked files checked`);
  return problems;
}

interface PnpmDep {
  version?: string;
  dependencies?: Record<string, PnpmDep>;
}

function sbomAndLicences(): string[] {
  const projects = JSON.parse(run("pnpm", ["list", "-r", "--prod", "--json", "--depth", "Infinity"])) as { name: string; version?: string; dependencies?: Record<string, PnpmDep> }[];
  const components = new Map<string, { name: string; version: string }>();
  const walk = (deps: Record<string, PnpmDep> | undefined) => {
    for (const [name, dep] of Object.entries(deps ?? {})) {
      if (!dep.version || dep.version.startsWith("link:")) {
        walk(dep.dependencies);
        continue;
      }
      const key = `${name}@${dep.version}`;
      if (components.has(key)) continue;
      components.set(key, { name, version: dep.version });
      walk(dep.dependencies);
    }
  };
  for (const p of projects) walk(p.dependencies);

  // Licences: pnpm licenses groups packages by licence.
  const byLicence = JSON.parse(run("pnpm", ["licenses", "list", "-r", "--prod", "--json"])) as Record<string, { name: string; versions?: string[] }[]>;
  const licenceOf = new Map<string, string>();
  for (const [licence, pkgs] of Object.entries(byLicence)) for (const p of pkgs) licenceOf.set(p.name, licence);

  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { timestamp: new Date().toISOString(), component: { type: "application", name: "moon", version: "0.0.0" } },
    components: [...components.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        type: "library",
        name: c.name,
        version: c.version,
        purl: `pkg:npm/${c.name.replace("@", "%40")}@${c.version}`,
        ...(licenceOf.has(c.name) ? { licenses: [{ license: { name: licenceOf.get(c.name) } }] } : {}),
      })),
  };
  writeFileSync(SBOM_FILE, JSON.stringify(sbom, null, 2) + "\n");
  console.log(`sbom: ${components.size} production components -> ${path.relative(REPO_ROOT, SBOM_FILE)}`);

  const copyleft = [...licenceOf].filter(([, licence]) => COPYLEFT.test(licence)).map(([name, licence]) => `${name} (${licence})`);
  console.log(`licences: ${Object.keys(byLicence).join(", ")}`);
  return copyleft.length ? [`licences: copyleft dependencies to review: ${copyleft.join(", ")}`] : [];
}

function main(): void {
  const problems = [...audit(), ...secretScan(), ...sbomAndLicences()];
  if (problems.length === 0) {
    console.log("\nSecurity check passed.");
    return;
  }
  console.log(`\nSecurity check found ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exitCode = 1;
}

main();
