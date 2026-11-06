// The Moon panel: a slim header (mark, chat title, TrueForge session link, New chat),
// the chat, and the input box.

import { useEffect, useReducer } from "react";
import { ExternalIcon, NewChatIcon } from "./brand/icons";
import { MoonMark } from "./brand/MoonMark";
import { ChatView } from "./chat/ChatView";
import { Composer } from "./chat/Composer";
import { chatReducer, initialState, isRunning, newChatId } from "./chat/chat-state";
import { onExtensionMessage, postToExtension } from "./vscode-api";

export function App() {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialState);
  const running = isRunning(state);
  const canSend = state.projectName !== undefined && !running;
  const firstQuestion = state.entries.find((e) => e.kind === "user")?.text;

  useEffect(() => {
    const unsubscribe = onExtensionMessage((message) => {
      if (message.type === "state") dispatch({ type: "settings", settings: message });
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
          onClick={newChat}
          disabled={state.entries.length === 0}
          title="New chat"
          aria-label="New chat"
        >
          <NewChatIcon />
        </button>
      </header>
      <ChatView
        entries={state.entries}
        typing={state.typing}
        projectName={state.projectName}
        canSend={canSend}
        onSend={send}
      />
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
