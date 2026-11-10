// Moon's security log (OWASP LLM03 #8, AISVS C12): approvals asked, allowed and denied,
// blocked commands, redactions, tainted turns, budget stops, refused MCP requests. One JSON
// line per event in security-log/<yyyy-mm-dd>.jsonl. Each line carries the SHA-256 of the line
// before it, so a deleted or edited line breaks the chain (verifyAuditFile shows where).
// Never written: file contents, secret values, the MCP token.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as path from "node:path";

export interface AuditEntry {
  /** e.g. "approval", "blocked", "redaction", "taint", "budget", "mcp-auth", "link". */
  kind: string;
  /** What happened, in a few words (no secrets, no file contents). */
  detail: string;
  /** Optional: the tool, a decision, counts. */
  [key: string]: string | number | boolean | undefined;
}

const GENESIS = "0".repeat(64);

export class AuditLog {
  private lastHash: string | undefined;
  private lastFile: string | undefined;

  constructor(
    private readonly dir: string,
    private readonly retentionDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true });
    this.prune();
  }

  /** The file for today. */
  get currentFile(): string {
    return path.join(this.dir, `${this.now().toISOString().slice(0, 10)}.jsonl`);
  }

  write(entry: AuditEntry): void {
    const file = this.currentFile;
    if (file !== this.lastFile) {
      this.lastFile = file;
      this.lastHash = lastLineHash(file);
    }
    const line = JSON.stringify({ time: this.now().toISOString(), ...entry, prev: this.lastHash });
    appendFileSync(file, line + "\n", "utf8");
    this.lastHash = sha256(line);
  }

  /** Deletes log files older than retentionDays. */
  private prune(): void {
    const oldest = this.now().getTime() - this.retentionDays * 86_400_000;
    for (const name of readdirSync(this.dir)) {
      const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      if (day && new Date(`${day}T23:59:59Z`).getTime() < oldest) rmSync(path.join(this.dir, name), { force: true });
    }
  }
}

/** Checks a log file's chain; returns the first broken line number (1-based), or undefined if intact. */
export function verifyAuditFile(file: string): number | undefined {
  let prev = GENESIS;
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    let parsed: { prev?: string };
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      return i + 1;
    }
    if (parsed.prev !== prev) return i + 1;
    prev = sha256(lines[i]!);
  }
  return undefined;
}

function lastLineHash(file: string): string {
  if (!existsSync(file)) return GENESIS;
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  return lines.length > 0 ? sha256(lines.at(-1)!) : GENESIS;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
