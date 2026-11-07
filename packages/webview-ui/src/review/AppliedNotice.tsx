// The line under the conversation after an apply: what was applied, and "Undo this whole run".

import type { ApplyNotice } from "../chat/chat-state";

export function AppliedNotice({ notice, onUndo }: { notice: ApplyNotice; onUndo(): void }) {
  if (notice.kind === "undone") {
    return <div className="moon-applied">Undone: {plural(notice.files, "file")} put back as they were.</div>;
  }
  return (
    <div className="moon-applied">
      <span>
        Applied {plural(notice.hunks, "change")} in {plural(notice.files, "file")}.
      </span>
      {notice.undoable && (
        <button className="moon-button" onClick={onUndo}>
          Undo this whole run
        </button>
      )}
    </div>
  );
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
