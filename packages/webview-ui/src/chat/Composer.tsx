// The input box: text area, then a toolbar with the project and model, and Send / Stop.
// Enter sends, Shift+Enter adds a new line.

import { useState, type KeyboardEvent } from "react";
import { FolderIcon, SendIcon, StopIcon } from "../brand/icons";

interface Props {
  running: boolean;
  projectName: string | undefined;
  model: string | undefined;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer({ running, projectName, model, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const disabled = projectName === undefined;
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
      <div className="moon-composer-box">
        <textarea
          aria-label="Message Moon"
          placeholder={disabled ? "Open a folder to use Moon" : "Ask Moon about this project"}
          value={text}
          disabled={disabled}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="moon-composer-toolbar">
          <span className="moon-meta" title="Moon's tools work on this folder">
            <FolderIcon />
            <span className="moon-meta-text">{projectName ?? "No folder"}</span>
          </span>
          {model && (
            <span className="moon-meta" title="Model used through TrueForge">
              <span className="moon-meta-text">{model}</span>
            </span>
          )}
          <span className="moon-toolbar-spacer" />
          {running ? (
            <button className="moon-send-button stop" onClick={onStop} title="Stop" aria-label="Stop">
              <StopIcon />
            </button>
          ) : (
            <button className="moon-send-button" onClick={send} disabled={!canSend} title="Send (Enter)" aria-label="Send">
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
