// The conversation: user messages, and for each agent turn its text and live-log blocks.

import { useEffect, useRef } from "react";
import { LiveLog } from "../live-log/LiveLog";
import { TurnNotice } from "../notices/TurnNotice";
import { AnswerText } from "./AnswerText";
import type { Entry } from "./chat-state";

export function ChatView({ entries }: { entries: Entry[] }) {
  // Keep the newest text in view by scrolling only the message list (never the whole page).
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="moon-messages">
        <div className="moon-empty">
          Ask Moon about this project. It reads the code with its tools and shows what it looked at.
        </div>
      </div>
    );
  }
  return (
    <div className="moon-messages" aria-live="polite" ref={list}>
      {entries.map((entry, i) =>
        entry.kind === "user" ? (
          <div key={i} className="moon-message-user">
            {entry.text}
          </div>
        ) : (
          <div key={i} className="moon-message-agent">
            {entry.parts.map((part, j) =>
              part.kind === "text" ? <AnswerText key={j} text={part.text} /> : <LiveLog key={j} lines={part.lines} />,
            )}
            {entry.status === "running" && entry.parts.length === 0 && <div className="moon-notice">Starting…</div>}
            <TurnNotice status={entry.status} error={entry.error} />
          </div>
        ),
      )}
    </div>
  );
}
