// One block of live-log lines: what the agent is doing (tool calls, subagents, compaction).

import type { LogLine } from "../chat/chat-state";

export function LiveLog({ lines }: { lines: LogLine[] }) {
  return (
    <ul className="moon-log" aria-label="Agent activity">
      {lines.map((line) => (
        <li key={line.id}>
          <span className={line.done ? "done" : "running"} aria-hidden="true">
            {line.done ? "✓" : "…"}
          </span>
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}
