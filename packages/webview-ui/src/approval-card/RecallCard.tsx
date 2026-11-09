// The recall card: the agent wants to read an earlier conversation (read_past_session). Old
// text could carry planted instructions, so the user decides, and can open it first.

import { useEffect, useRef } from "react";
import type { RecallView } from "../protocol/messages";
import { relativeTime } from "../history/relative-time";

interface Props {
  recall: RecallView;
  onDecide(allow: boolean): void;
  onOpen(conversationId: string): void;
}

const PART_WORDS: Record<string, string> = {
  summary: "its summary",
  work: "what was done (files, commands, applies)",
  transcript: "its messages",
};

export function RecallCard({ recall, onDecide, onOpen }: Props) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.scrollIntoView({ block: "end" });
  }, [recall.requestId]);
  return (
    <div className="moon-card" role="group" aria-label="Use an earlier conversation" ref={card}>
      <div className="moon-card-title">
        Use the earlier conversation <q>{recall.title}</q> ({relativeTime(recall.updatedAt)}) as reference?
      </div>
      {recall.summary.filter(Boolean).map((line) => (
        <div className="moon-card-meta" key={line}>
          {line}
        </div>
      ))}
      <div className="moon-card-meta">The agent will read {PART_WORDS[recall.part] ?? recall.part}.</div>
      <div className="moon-card-actions">
        <button className="moon-button primary" onClick={() => onDecide(true)}>
          Allow
        </button>
        <button className="moon-button" onClick={() => onDecide(false)}>
          Deny
        </button>
        <button className="moon-button" onClick={() => onOpen(recall.conversationId)}>
          Open session
        </button>
      </div>
    </div>
  );
}
