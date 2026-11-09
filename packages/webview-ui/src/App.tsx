// The Moon panel: a slim header (mark, chat title, TrueForge session link, History, New chat),
// the chat (or the history of this project's conversations), and the input box.
//
// The panel remembers its conversation (VS Code keeps the view's state), so after a reload
// the same conversation is continued: its messages come back and the agent gets the record.

import { useCallback, useEffect, useReducer, useState } from "react";
import { ExternalIcon, HistoryIcon, NewChatIcon } from "./brand/icons";
import { MoonMark } from "./brand/MoonMark";
import { ChatView } from "./chat/ChatView";
import { Composer } from "./chat/Composer";
import { chatReducer, initialState, isRunning, newChatId } from "./chat/chat-state";
import { CommandApproval } from "./approval-card/CommandApproval";
import { QuestionCard } from "./approval-card/QuestionCard";
import { ToolApproval } from "./approval-card/ToolApproval";
import { RecallCard } from "./approval-card/RecallCard";
import { PlanCard } from "./approval-card/PlanCard";
import { HistoryView, type PastConversation } from "./history/HistoryView";
import { AppliedNotice } from "./review/AppliedNotice";
import { ReviewScreen } from "./review/ReviewScreen";
import type { HistoryItemView, Mention } from "./protocol/messages";
import { onExtensionMessage, postToExtension, savedState, saveState } from "./vscode-api";

/** Typed in the input box: opens the history instead of sending. */
const RESUME_COMMAND = "/resume";

export function App() {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialState);
  const running = isRunning(state);
  const canSend = state.projectName !== undefined && !running;
  const firstQuestion = state.title ?? state.entries.find((e) => e.kind === "user")?.text;
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<{ items?: HistoryItemView[]; error?: string }>({});
  const [past, setPast] = useState<PastConversation | undefined>();

  useEffect(() => {
    const unsubscribe = onExtensionMessage((message) => {
      if (message.type === "state") dispatch({ type: "settings", settings: message });
      else if (message.type === "history") setHistory({ items: message.items, error: message.error });
      else if (message.type === "past-conversation") setPast(message);
      else if (message.type !== "mention-results") dispatch({ type: "message", message }); // picker answers go to the picker
    });
    postToExtension({ type: "ready" });
    // After a reload: continue the conversation that was on screen.
    const remembered = savedState().conversationId;
    if (remembered) postToExtension({ type: "history-continue", chatId: state.chatId, conversationId: remembered });
    return unsubscribe;
    // Only once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    saveState({ conversationId: state.conversationId });
  }, [state.conversationId]);

  const searchHistory = useCallback((query: string) => postToExtension({ type: "history-list", query }), []);

  const openHistory = () => {
    setHistory({});
    setPast(undefined);
    setShowHistory(true);
  };

  const continueConversation = (conversationId: string) => {
    const chatId = newChatId();
    dispatch({ type: "new-chat", chatId });
    postToExtension({ type: "history-continue", chatId, conversationId });
    setShowHistory(false);
    setPast(undefined);
  };

  const send = (text: string, mentions: Mention[] = []) => {
    if (text.trim() === RESUME_COMMAND) return openHistory();
    dispatch({ type: "sent", text });
    postToExtension({ type: "send", chatId: state.chatId, text, mentions });
  };

  const newChat = () => {
    setShowHistory(false);
    const chatId = newChatId();
    dispatch({ type: "new-chat", chatId });
    postToExtension({ type: "new-chat", chatId });
  };

  const openSession = () => {
    if (state.sessionUrl) postToExtension({ type: "open-session", url: state.sessionUrl });
  };

  return (
    <div className="moon-panel">
      <header className="moon-header">
        <MoonMark className="moon-header-mark" />
        <div className="moon-header-title" title={firstQuestion}>
          {firstQuestion ?? "New chat"}
        </div>
        <button
          className="moon-icon-button"
          onClick={openSession}
          disabled={!state.sessionUrl}
          title="Open this session in TrueForge"
          aria-label="Open this session in TrueForge"
        >
          <ExternalIcon />
        </button>
        <button
          className="moon-icon-button"
          onClick={() => (showHistory ? setShowHistory(false) : openHistory())}
          disabled={state.projectName === undefined}
          title="History of this project (/resume)"
          aria-label="History of this project"
        >
          <HistoryIcon />
        </button>
        <button
          className="moon-icon-button"
          onClick={newChat}
          disabled={state.entries.length === 0}
          title="New chat"
          aria-label="New chat"
        >
          <NewChatIcon />
        </button>
      </header>
      {showHistory ? (
        <HistoryView
          items={history.items}
          error={history.error}
          past={past}
          currentId={state.conversationId}
          onSearch={searchHistory}
          onOpen={(conversationId) => postToExtension({ type: "history-open", conversationId })}
          onClosePast={() => setPast(undefined)}
          onContinue={continueConversation}
          onDelete={(conversationId) => postToExtension({ type: "history-delete", conversationId })}
          onClose={() => setShowHistory(false)}
        />
      ) : state.review ? (
        <ReviewScreen
          key={JSON.stringify(state.review.files.map((f) => f.rel))}
          review={state.review}
          onApply={(accepted) => postToExtension({ type: "review-apply", chatId: state.chatId, accepted })}
          onDiscard={() => postToExtension({ type: "review-discard", chatId: state.chatId })}
          onOpenDiff={(rel) => postToExtension({ type: "open-diff", chatId: state.chatId, rel })}
        />
      ) : (
        <ChatView
          entries={state.entries}
          typing={state.typing}
          projectName={state.projectName}
          canSend={canSend}
          onSend={send}
          onOpenFile={(rel) => postToExtension({ type: "open-file", rel })}
          onRetry={() => {
            const last = [...state.entries].reverse().find((e) => e.kind === "user");
            if (last?.kind === "user") send(last.text);
          }}
          footer={
            <>
              {state.applyNotice && (
                <AppliedNotice
                  notice={state.applyNotice}
                  onUndo={() => {
                    dispatch({ type: "undo-sent" });
                    postToExtension({ type: "undo-run", chatId: state.chatId });
                  }}
                />
              )}
              {state.toolApproval && (
                <ToolApproval
                  approval={state.toolApproval}
                  onDecide={(allow) =>
                    postToExtension({ type: "tool-decision", chatId: state.chatId, requestId: state.toolApproval!.requestId, allow })
                  }
                />
              )}
              {state.plan && (
                <PlanCard
                  plan={state.plan}
                  onDecide={(approve, changes) => {
                    dispatch({ type: "answered", text: approve ? "You approved the plan" : `You asked for changes: ${changes ?? ""}` });
                    postToExtension({ type: "plan-decision", chatId: state.chatId, requestId: state.plan!.requestId, approve, changes });
                  }}
                />
              )}
              {state.recall && (
                <RecallCard
                  recall={state.recall}
                  onDecide={(allow) =>
                    postToExtension({ type: "recall-decision", chatId: state.chatId, requestId: state.recall!.requestId, allow })
                  }
                  onOpen={(conversationId) => {
                    openHistory();
                    postToExtension({ type: "history-open", conversationId });
                  }}
                />
              )}
              {state.question && (
                <QuestionCard
                  question={state.question}
                  onAnswer={(answer) => {
                    dispatch({ type: "answered", text: `You answered: ${answer}` });
                    postToExtension({ type: "question-answer", chatId: state.chatId, requestId: state.question!.requestId, answer });
                  }}
                />
              )}
              {state.approval && (
                <CommandApproval
                  approval={state.approval}
                  onDecide={(decision) =>
                    postToExtension({ type: "command-decision", chatId: state.chatId, requestId: state.approval!.requestId, decision })
                  }
                />
              )}
            </>
          }
        />
      )}
      <Composer
        running={running}
        projectName={state.projectName}
        model={state.model ?? state.configuredModel}
        onSend={send}
        onStop={() => postToExtension({ type: "stop", chatId: state.chatId })}
      />
    </div>
  );
}
