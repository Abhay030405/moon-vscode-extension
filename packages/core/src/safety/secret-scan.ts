// Finds secrets inside ordinary text (OWASP LLM02): a key in settings.py, a token in a test
// fixture, a password in `git log -p` output. The secret-file guard only blocks files by name
// (.env, *.pem); this catches what slips through, before the text reaches TrueForge and so the
// model provider. Detection is deterministic (known key formats + entropy of assigned values):
// Moon never calls a model to classify (AGENTS.md section 1). It misses formats it doesn't
// know, which the write-up states.

import { REDACTION_PREFIX, SECRET_ASSIGNMENT, SECRET_MIN_ENTROPY, SECRET_PATTERNS } from "../shared/constants.js";

export interface Redaction {
  /** What kind of secret, e.g. "aws-access-key" (never the value). */
  kind: string;
}

const PATTERNS = SECRET_PATTERNS.map((p) => ({ kind: p.kind, re: new RegExp(p.pattern, "g") }));
const ASSIGNMENT = new RegExp(SECRET_ASSIGNMENT, "gi");

/** Replaces every secret in `text` with «secret redacted: kind». */
export function redactSecrets(text: string): { text: string; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, () => {
      redactions.push({ kind });
      return marker(kind);
    });
  }
  // key = "value" / password: value, with a random-looking value (not a placeholder like "changeme").
  out = out.replace(ASSIGNMENT, (whole: string, value: string) => {
    if (value.startsWith(REDACTION_PREFIX) || notASecretValue(value) || shannonEntropy(value) < SECRET_MIN_ENTROPY) return whole;
    redactions.push({ kind: "secret-assignment" });
    return whole.replace(value, marker("secret-assignment"));
  });
  return { text: out, redactions };
}

/** True when `text` contains a secret (for flagging added lines on the review screen). */
export function containsSecret(text: string): boolean {
  return redactSecrets(text).redactions.length > 0;
}

/** True when `text` carries one of Moon's redaction markers (edit_file must not write it back). */
export function hasRedactionMarker(text: string): boolean {
  return text.includes(REDACTION_PREFIX);
}

/** Values that only name a secret or describe one: a variable name (GITHUB_TOKEN) or a pattern (A|B). */
function notASecretValue(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value) || /[|^$(){}[\]\\]/.test(value);
}

function marker(kind: string): string {
  return `${REDACTION_PREFIX}${kind}»`;
}

/** Bits of randomness per character; real keys score high, words and placeholders low. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
