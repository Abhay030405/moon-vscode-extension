// The Moon panel: header (project, model, TrueForge session link, New chat), the chat, the composer.

import { useEffect, useReducer } from "react";
import { ChatView } from "./chat/ChatView";
import { Composer } from "./chat/Composer";
import { chatReducer, initialState, isRunning, newChatId } from "./chat/chat-state";
import { onExtensionMessage, postToExtension } from "./vscode-api";

export function App() {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialState);
  const running = isRunning(state);

  useEffect(() => {
    const unsubscribe = onExtensionMessage((message) => {
      if (message.type === "state") dispatch({ type: "project", projectName: message.projectName });
      else dispatch({ type: "event", chatId: message.chatId, event: message.event });
    });
    postToExtension({ type: "ready" });
    return unsubscribe;
  }, []);

  const send = (text: string) => {
    dispatch({ type: "sent", text });
    postToExtension({ type: "send", chatId: state.chatId, text });
  };

  const newChat = () => {
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
        <span>
          {state.projectName ?? "No folder open"}
          {state.model ? ` · ${state.model}` : ""}
          {state.sessionUrl && (
            <>
              {" · "}
              <button className="link" onClick={openSession}>
                TrueForge session
              </button>
            </>
          )}
        </span>
        <button className="secondary" onClick={newChat} disabled={state.entries.length === 0}>
          New chat
        </button>
      </header>
      <ChatView entries={state.entries} />
      <Composer
        running={running}
        disabled={state.projectName === undefined}
        onSend={send}
        onStop={() => postToExtension({ type: "stop", chatId: state.chatId })}
      />
    </div>
  );
}
