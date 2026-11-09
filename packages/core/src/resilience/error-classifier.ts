// What went wrong, and should Moon switch to the backup model?
// TrueForge reports failures as text. Checked against real TrueForge (Phase 6 probe):
//   wrong key        "[Model Error] Request failed (401): Access denied due to invalid ..."
//   dead address     "[Model Error] Cannot connect to API: ..."
//   unknown model    session create fails: "Status code: 422 ... Unknown model "x/y" — provider not configured"
//   Moon's MCP down  "[MCP Error] Failed to connect to remote MCP server 'moon-editor': ..."
//   no reply         nothing at all: Moon's watchdog ends the turn with NO_REPLY_MESSAGE
// Rule (docs/design-decisions.md section 6): anything that is the model's or its provider's
// fault switches to the backup (unknown text too); 429 waits and retries first; problems the
// backup would hit the same way (Moon's tools, TrueForge itself not running) do not switch.

/** Text of the turn error Moon's own watchdog reports (classified as "no-reply"). */
export const NO_REPLY_PREFIX = "[Moon] No reply from the model";

export type FailureKind =
  | "auth" // 401 / 403: wrong or expired key
  | "not-found" // 404, unknown model or provider
  | "rate-limit" // 429
  | "server" // 5xx
  | "unreachable" // cannot connect to the provider
  | "no-reply" // Moon's watchdog: the model never answered
  | "tools" // Moon's MCP tools unreachable: same for every model
  | "trueforge" // TrueForge itself not reachable: same for every model
  | "unknown";

export interface Failure {
  kind: FailureKind;
  /** Short words for the notice: "Main model failed (invalid key)". */
  label: string;
  /** Switching to the backup can help. */
  switchModel: boolean;
  /** Wait and try the same model again first (429). */
  retryFirst: boolean;
  /** The original text, for the log. */
  message: string;
}

const LABELS: Record<FailureKind, string> = {
  auth: "invalid key",
  "not-found": "model not found",
  "rate-limit": "too many requests",
  server: "provider error",
  unreachable: "cannot connect",
  "no-reply": "no reply",
  tools: "Moon's tools are not reachable",
  trueforge: "TrueForge is not reachable",
  unknown: "unexpected error",
};

export function classifyFailure(message: string): Failure {
  const kind = kindOf(message);
  return {
    kind,
    label: LABELS[kind],
    switchModel: kind !== "tools" && kind !== "trueforge",
    retryFirst: kind === "rate-limit",
    message,
  };
}

function kindOf(text: string): FailureKind {
  if (text.startsWith(NO_REPLY_PREFIX)) return "no-reply";
  if (text.includes("[MCP Error]")) return "tools";
  if (/Unknown model|provider not configured/i.test(text)) return "not-found";
  const status = statusOf(text);
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limit";
  if (status !== undefined && status >= 500) return "server";
  if (text.includes("[Model Error]")) {
    if (/cannot connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|network/i.test(text)) return "unreachable";
    return "unknown";
  }
  // Not a model error and no HTTP answer: Moon could not talk to TrueForge at all.
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|connect ETIMEDOUT/i.test(text)) return "trueforge";
  return "unknown";
}

/** The provider's HTTP status in TrueForge's text: "Request failed (401)" or "Status code: 422". */
function statusOf(text: string): number | undefined {
  const match = /Request failed \((\d{3})\)/.exec(text) ?? /\((\d{3})\)/.exec(text);
  return match ? Number(match[1]) : undefined;
}
