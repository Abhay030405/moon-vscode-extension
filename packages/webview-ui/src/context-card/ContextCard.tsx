// The context card at the top of an agent turn:
// - the files the agent chose and why (its report_context call: the reasons are the agent's);
// - what Moon gave it up front: the project map (tokens used of the budget), the project's
//   rules file, and what the user attached with @.
// Meant to be read in a couple of seconds.

import type { ChosenFile } from "../chat/chat-state";
import type { ContextSummary } from "../protocol/messages";

interface Props {
  summary?: ContextSummary;
  files?: ChosenFile[];
  /** The turn is still running (the agent has not reported its files yet). */
  working: boolean;
  onOpenFile(path: string): void;
}

const MENTION_MODE: Record<ContextSummary["mentions"][number]["mode"], string> = {
  full: "whole file",
  outline: "outline (large file)",
  definition: "definition",
  missing: "not found",
};

export function ContextCard({ summary, files, working, onOpenFile }: Props) {
  return (
    <section className="moon-context" aria-label="Context">
      <div className="moon-context-title">Context</div>
      {files && files.length > 0 ? (
        <ul className="moon-context-files">
          {files.map((file) => (
            <li key={file.path}>
              <button className="moon-context-file" onClick={() => onOpenFile(file.path)} title="Open file">
                {file.path}
              </button>
              <span className="moon-context-reason">{file.reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        working && <div className="moon-context-note">Finding the files that matter…</div>
      )}
      {summary && (
        <div className="moon-context-budget">
          <div className="moon-context-budget-line">
            <span>
              Project map {kTokens(summary.map.tokens)} / {kTokens(summary.map.budgetTokens)} tokens
            </span>
            <span className="moon-context-dim">
              {summary.map.shownFiles} of {summary.map.totalFiles} files · window {kTokens(summary.windowTokens)}
            </span>
          </div>
          <progress className="moon-context-bar" value={summary.map.tokens} max={summary.map.budgetTokens} />
          {summary.rules && (
            <div className="moon-context-dim">
              Rules: {summary.rules.file} ({kTokens(summary.rules.tokens)} tokens{summary.rules.cut ? ", cut to fit" : ""})
            </div>
          )}
          {summary.mentions.map((m) => (
            <div key={m.label} className="moon-context-dim">
              {m.label}: {MENTION_MODE[m.mode]}
              {m.tokens > 0 ? ` (${kTokens(m.tokens)} tokens)` : ""}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** 1834 -> "1.8k", 200000 -> "200k", 1000000 -> "1M". */
function kTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}
