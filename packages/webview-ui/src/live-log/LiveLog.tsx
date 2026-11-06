// The agent's steps as a timeline: dots joined by a line, each step a bold action and its
// target ("Read  src/app.py:1-80"). A dot pulses while its step runs and turns green when done;
// plain notes (subagent started, compaction) get a grey dot.

import type { LogLine } from "../chat/chat-state";

export function LiveLog({ lines, working }: { lines: LogLine[]; working?: boolean }) {
  return (
    <ul className="moon-timeline" aria-label="Agent steps">
      {lines.map((line) => (
        <li key={line.id} className={`moon-step ${line.kind} ${line.done ? "done" : "running"}`}>
          <span className="moon-step-dot" aria-hidden="true" />
          <span className="moon-step-body">
            <span className="moon-step-action">{line.action}</span>
            {line.target && <span className="moon-step-target">{line.target}</span>}
          </span>
        </li>
      ))}
      {working && (
        <li className="moon-step note running">
          <span className="moon-step-dot" aria-hidden="true" />
          <span className="moon-step-body">
            <span className="moon-step-action">Thinking…</span>
          </span>
        </li>
      )}
    </ul>
  );
}
