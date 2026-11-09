// The conversation: user messages, and for each agent turn its steps and answer.
// With no messages yet it shows a short welcome with a few starter questions.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoonMark } from "../brand/MoonMark";
import { ContextCard } from "../context-card/ContextCard";
import { ModelSwitchNotice } from "../notices/ModelSwitchNotice";
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
  onOpenFile(path: string): void;
  /** Sends the last question again (shown on a failed last turn). */
  onRetry?(): void;
  /** Shown after the conversation: the command approval card, the apply notice. */
  footer?: ReactNode;
}

export function ChatView({ entries, typing, projectName, canSend, onSend, onOpenFile, onRetry, footer }: Props) {
  // Keep the newest text in view by scrolling only the message list (never the whole page),
  // but only while the user is at the bottom: once they scroll up to read, the list stays put
  // (a "Jump to latest" button brings them back). Sending a new message follows again.
  const list = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const scrollToEnd = () => {
    const el = list.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  };
  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    const slack = parseFloat(getComputedStyle(el).getPropertyValue("--moon-follow-slack")) || 0;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
    setShowJump(!following.current);
  };
  const jumpToLatest = () => {
    following.current = true;
    setShowJump(false);
    scrollToEnd();
  };
  // A new user message: follow the answer to it.
  const userCount = entries.filter((e) => e.kind === "user").length;
  useEffect(() => {
    following.current = true;
    setShowJump(false);
  }, [userCount]);
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
    <div className="moon-messages" aria-live="polite" ref={list} onScroll={onScroll}>
      {entries.map((entry, i) =>
        entry.kind === "user" ? (
          <div key={i} className="moon-message-user">
            {entry.text}
          </div>
        ) : (
          <div key={i} className="moon-message-agent">
            {entry.parts.map((part, j) =>
              part.kind === "context" ? (
                <ContextCard
                  key={j}
                  summary={part.summary}
                  files={part.files}
                  working={entry.status === "running"}
                  onOpenFile={onOpenFile}
                />
              ) : part.kind === "switch" ? (
                <ModelSwitchNotice key={j} {...part} />
              ) : part.kind === "text" ? (
                <AnswerText
                  key={j}
                  text={part.text}
                  // Typing effect only while the answer arrives; a stopped or failed turn shows everything at once.
                  typing={!entry.restored && (entry.status === "running" || entry.status === "waiting" || entry.status === "done") ? typing : undefined}
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
            {entry.status === "waiting" && <div className="moon-working">Waiting for your answer…</div>}
            <TurnNotice status={entry.status} error={entry.error} onRetry={i === entries.length - 1 && canSend ? onRetry : undefined} />
          </div>
        ),
      )}
      {footer}
      {showJump && (
        <button className="moon-jump-latest" onClick={jumpToLatest}>
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
