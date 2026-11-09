// The history of this project's conversations (/resume or the History button): search over
// titles and summaries, open one read-only, continue it, or delete it. Each conversation lives
// in TrueForge as one or more sessions; Moon only reads them.

import { useEffect, useState } from "react";
import { AnswerText } from "../chat/AnswerText";
import type { HistoryItemView, TranscriptItemView } from "../protocol/messages";
import { relativeTime } from "./relative-time";

export interface PastConversation {
  conversationId: string;
  title: string;
  items: TranscriptItemView[];
  error?: string;
}

interface Props {
  items: HistoryItemView[] | undefined;
  error?: string;
  /** The conversation open read-only, if any. */
  past: PastConversation | undefined;
  /** Moon's id of the chat on screen (marked, and not deletable here). */
  currentId: string | undefined;
  onSearch(query: string): void;
  onOpen(id: string): void;
  onClosePast(): void;
  onContinue(id: string): void;
  onDelete(id: string): void;
  onClose(): void;
}

const STATUS_WORDS: Record<HistoryItemView["status"], string> = {
  active: "in progress",
  done: "done",
  stopped: "stopped",
  failed: "failed",
  "review-pending": "review pending",
};

export function HistoryView(props: Props) {
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>();
  const { onSearch } = props;
  useEffect(() => {
    onSearch(query);
  }, [query, onSearch]);

  if (props.past) return <PastView past={props.past} onBack={props.onClosePast} onContinue={props.onContinue} />;

  return (
    <div className="moon-history" aria-label="Chat history">
      <div className="moon-history-head">
        <span className="moon-history-title">History of this project</span>
        <button className="moon-button" onClick={props.onClose}>
          Back to chat
        </button>
      </div>
      <input
        className="moon-history-search"
        placeholder="Search titles and summaries"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {props.error && <div className="moon-history-empty">Could not read the history from TrueForge: {props.error}</div>}
      {props.items === undefined && !props.error && <div className="moon-history-empty">Loading…</div>}
      {props.items?.length === 0 && <div className="moon-history-empty">{query ? "Nothing matches." : "No earlier conversations in this project."}</div>}
      <ul className="moon-history-list">
        {props.items?.map((item) => (
          <li key={item.id} className="moon-history-item">
            <button className="moon-history-open" onClick={() => props.onOpen(item.id)} title="Open read-only">
              <span className="moon-history-item-title">
                {item.title}
                {item.id === props.currentId && <span className="moon-history-tag">this chat</span>}
              </span>
              {item.summary.filter(Boolean).map((line) => (
                <span className="moon-history-summary" key={line}>
                  {line}
                </span>
              ))}
              <span className="moon-history-meta">
                {relativeTime(item.updatedAt)} · {STATUS_WORDS[item.status]}
                {item.model ? ` · ${item.model}` : ""}
              </span>
            </button>
            <div className="moon-history-actions">
              <button className="moon-button primary" onClick={() => props.onContinue(item.id)} disabled={item.id === props.currentId}>
                Continue
              </button>
              {confirmDelete === item.id ? (
                <>
                  <button className="moon-button" onClick={() => props.onDelete(item.id)}>
                    Delete for good
                  </button>
                  <button className="moon-button" onClick={() => setConfirmDelete(undefined)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="moon-button" onClick={() => setConfirmDelete(item.id)} disabled={item.id === props.currentId}>
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PastView({ past, onBack, onContinue }: { past: PastConversation; onBack(): void; onContinue(id: string): void }) {
  return (
    <div className="moon-history" aria-label="Earlier conversation">
      <div className="moon-history-head">
        <span className="moon-history-title">{past.title}</span>
        <button className="moon-button" onClick={onBack}>
          Back
        </button>
        <button className="moon-button primary" onClick={() => onContinue(past.conversationId)}>
          Continue
        </button>
      </div>
      {past.error && <div className="moon-history-empty">Could not read it from TrueForge: {past.error}</div>}
      <div className="moon-history-past">
        {past.items.map((item, i) =>
          item.role === "step" ? (
            <div className="moon-history-step" key={i}>
              {item.action} {item.target}
            </div>
          ) : (
            <div className={`moon-history-msg ${item.role}`} key={i}>
              {item.role === "user" ? item.text : <AnswerText text={item.text} typing={undefined} />}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
