// The review of an agent run, shown when the agent calls apply_changes (TrueForge is holding
// that tool call for the user's approval). Every changed file is split into hunks; each hunk
// can be accepted or rejected. Apply writes only the accepted hunks; Discard throws the
// agent's changes away. Nothing reaches the user's files before Apply.

import { useState } from "react";
import type { ReviewFileView, ReviewView } from "../protocol/messages";
import { plural } from "./AppliedNotice";

interface Props {
  review: ReviewView;
  onApply(accepted: Record<string, number[]>): void;
  onDiscard(): void;
  onOpenDiff(rel: string): void;
}

/** Files that can be applied (a conflict or a binary file never is). */
const applicable = (file: ReviewFileView) => !file.conflict && !file.binary;

const KIND_LABEL: Record<ReviewFileView["kind"], string> = { added: "new", modified: "changed", deleted: "deleted" };

export function ReviewScreen({ review, onApply, onDiscard, onOpenDiff }: Props) {
  // Accepted hunk indexes by file. Everything that can be applied starts accepted.
  const [accepted, setAccepted] = useState<Record<string, number[]>>(() => allHunks(review, true));
  const total = review.files.filter(applicable).reduce((n, f) => n + f.hunks.length, 0);
  const chosen = Object.values(accepted).reduce((n, list) => n + list.length, 0);
  const failed = review.commands.filter((c) => c.exitCode !== 0);

  const toggleHunk = (rel: string, index: number) =>
    setAccepted((prev) => {
      const list = prev[rel] ?? [];
      return { ...prev, [rel]: list.includes(index) ? list.filter((i) => i !== index) : [...list, index] };
    });
  const toggleFile = (file: ReviewFileView) =>
    setAccepted((prev) => ({
      ...prev,
      [file.rel]: (prev[file.rel]?.length ?? 0) === file.hunks.length ? [] : file.hunks.map((h) => h.index),
    }));

  return (
    <div className="moon-review">
      <div className="moon-review-head">
        <div className="moon-review-title">Review Moon's changes</div>
        {review.summary && <div className="moon-review-summary">{review.summary}</div>}
        <div className="moon-review-bar">
          <span className="moon-review-count">
            {chosen} of {plural(total, "change")} accepted · {plural(review.files.length, "file")}
          </span>
          <span className="moon-toolbar-spacer" />
          <button className="moon-button" onClick={() => setAccepted(allHunks(review, true))}>
            Accept all
          </button>
          <button className="moon-button" onClick={() => setAccepted(allHunks(review, false))}>
            Reject all
          </button>
        </div>
      </div>

      <div className="moon-review-body">
        {review.files.map((file) => {
          const list = accepted[file.rel] ?? [];
          return (
            <section key={file.rel} className="moon-review-file">
              <div className="moon-review-file-head">
                <input
                  type="checkbox"
                  aria-label={`Accept every change in ${file.rel}`}
                  disabled={!applicable(file)}
                  checked={applicable(file) && list.length === file.hunks.length}
                  ref={(el) => {
                    if (el) el.indeterminate = list.length > 0 && list.length < file.hunks.length;
                  }}
                  onChange={() => toggleFile(file)}
                />
                <button className="moon-review-file-name" onClick={() => onOpenDiff(file.rel)} title="Open in the diff editor">
                  {file.rel}
                </button>
                <span className={`moon-badge ${file.kind}`}>{KIND_LABEL[file.kind]}</span>
              </div>
              {file.conflict && (
                <div className="moon-review-warning">
                  You changed this file after Moon started, so it will not be applied (your work is kept).
                </div>
              )}
              {file.binary && <div className="moon-review-warning">Binary file: shown for information, not applied.</div>}
              {applicable(file) &&
                file.hunks.map((hunk) => (
                  <div key={hunk.index} className={`moon-hunk ${list.includes(hunk.index) ? "" : "rejected"}`}>
                    <label className="moon-hunk-head">
                      <input type="checkbox" checked={list.includes(hunk.index)} onChange={() => toggleHunk(file.rel, hunk.index)} />
                      Line {hunk.line}
                    </label>
                    <pre className="moon-hunk-lines">
                      {hunk.lines.map((line, i) => (
                        <div key={i} className={`moon-hunk-line ${line.kind === "+" ? "added" : line.kind === "-" ? "removed" : ""}`}>
                          <span className="moon-hunk-sign">{line.kind}</span>
                          {line.text}
                        </div>
                      ))}
                    </pre>
                  </div>
                ))}
            </section>
          );
        })}

        {review.commands.length > 0 && (
          <section className="moon-review-file">
            <div className="moon-review-file-head">
              Checks Moon ran in its copy ({review.commands.length - failed.length} passed, {failed.length} failed)
            </div>
            {review.commands.map((c, i) => (
              <details key={i} className="moon-check">
                <summary className={c.exitCode === 0 ? "ok" : "failed"}>
                  {c.exitCode === 0 ? "✓" : "✗"} {c.command}
                  {c.timedOut ? " (timed out)" : c.cancelled ? " (stopped)" : ""}
                </summary>
                <pre className="moon-check-output">{c.outputTail}</pre>
              </details>
            ))}
            {chosen < total && (
              <div className="moon-review-warning">
                You rejected some changes, so these results (from Moon's full version) may not match what gets applied.
              </div>
            )}
          </section>
        )}
      </div>

      <div className="moon-review-foot">
        <button className="moon-button" onClick={onDiscard} title="Throw away every change Moon made in this run">
          Discard all
        </button>
        <span className="moon-toolbar-spacer" />
        <button className="moon-button primary" onClick={() => onApply(accepted)}>
          {chosen > 0 ? `Apply ${plural(chosen, "change")}` : "Apply nothing"}
        </button>
      </div>
    </div>
  );
}

function allHunks(review: ReviewView, accept: boolean): Record<string, number[]> {
  return Object.fromEntries(
    review.files.map((f) => [f.rel, accept && applicable(f) ? f.hunks.map((h) => h.index) : []]),
  );
}
