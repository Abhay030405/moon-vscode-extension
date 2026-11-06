// The conversation: user messages, and for each agent turn its steps and answer.
// With no messages yet it shows a short welcome with a few starter questions.

import { useEffect, useRef } from "react";
import { MoonMark } from "../brand/MoonMark";
import { LiveLog } from "../live-log/LiveLog";
import { TurnNotice } from "../notices/TurnNotice";
import type { TypingSettings } from "../protocol/messages";
import { AnswerText } from "./AnswerText";
import type { Entry } from "./chat-state";

const STARTERS = [
  "Give me a quick tour of this project",
  "Where is the main entry point?",
  "How are the tests organised?",
];

interface Props {
  entries: Entry[];
  typing: TypingSettings | undefined;
  projectName: string | undefined;
  canSend: boolean;
  onSend(text: string): void;
}

export function ChatView({ entries, typing, projectName, canSend, onSend }: Props) {
  // Keep the newest text in view by scrolling only the message list (never the whole page).
  const list = useRef<HTMLDivElement>(null);
  const scrollToEnd = () => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(scrollToEnd, [entries]);

  if (entries.length === 0) {
    return (
      <div className="moon-messages moon-welcome">
        <MoonMark className="moon-welcome-mark" />
        <h1 className="moon-welcome-title">What should we look at?</h1>
        <p className="moon-welcome-text">
          {projectName
            ? `Ask anything about ${projectName}. Moon reads the code with its tools and shows each step.`
            : "Open a folder to start. Moon reads the code with its tools and shows each step."}
        </p>
        <div className="moon-starters">
          {STARTERS.map((text) => (
            <button key={text} className="moon-starter" disabled={!canSend} onClick={() => onSend(text)}>
              {text}
            </button>
          ))}
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
              part.kind === "text" ? (
                <AnswerText
                  key={j}
                  text={part.text}
                  // Typing effect only while the answer arrives; a stopped or failed turn shows everything at once.
                  typing={entry.status === "running" || entry.status === "done" ? typing : undefined}
                  onGrow={scrollToEnd}
                />
              ) : (
                <LiveLog
                  key={j}
                  lines={part.lines}
                  // Between steps (all done, nothing new yet) the timeline ends with "Thinking…".
                  working={
                    entry.status === "running" && j === entry.parts.length - 1 && part.lines.every((l) => l.done)
                  }
                />
              ),
            )}
            {entry.status === "running" && (
              <div className="moon-working">
                <MoonMark className="moon-working-mark" />
                Working…
              </div>
            )}
            <TurnNotice status={entry.status} error={entry.error} />
          </div>
        ),
      )}
    </div>
  );
}
