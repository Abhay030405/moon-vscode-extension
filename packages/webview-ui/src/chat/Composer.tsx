// Message box with Send / Stop. Enter sends, Shift+Enter adds a new line.

import { useState, type KeyboardEvent } from "react";

interface Props {
  running: boolean;
  disabled: boolean;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ running, disabled, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const canSend = !running && !disabled && text.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="moon-composer">
      <textarea
        aria-label="Message Moon"
        placeholder={disabled ? "Open a folder to use Moon." : "Ask about this project…"}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="moon-composer-actions">
        <span>{running ? "Moon is working…" : "Enter to send, Shift+Enter for a new line"}</span>
        {running ? (
          <button onClick={onStop}>Stop</button>
        ) : (
          <button onClick={send} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
