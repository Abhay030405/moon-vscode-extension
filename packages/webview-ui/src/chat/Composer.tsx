// The input box: text area, then a toolbar with the project and model, and Send / Stop.
// Enter sends, Shift+Enter adds a new line.
// Typing "@" opens the picker: files (@src/app/cli.py) and names (@run_command). A picked
// entry is sent with the message, so Moon knows exactly which file or definition was meant.

import { useRef, useState, type KeyboardEvent } from "react";
import { FolderIcon, SendIcon, StopIcon } from "../brand/icons";
import type { Mention, MentionCandidate } from "../protocol/messages";
import { MentionPicker } from "./MentionPicker";
import { mentionAtCursor, useMentionPicker } from "./use-mention-picker";

interface Props {
  running: boolean;
  projectName: string | undefined;
  model: string | undefined;
  onSend(text: string, mentions: Mention[]): void;
  onStop(): void;
}

/** What a picked entry looks like in the text. */
const tokenFor = (item: MentionCandidate) => `@${item.mention.kind === "file" ? item.mention.rel : item.mention.name}`;

export function Composer({ running, projectName, model, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<{ token: string; mention: Mention }[]>([]);
  const [pickerClosed, setPickerClosed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const disabled = projectName === undefined;
  const canSend = !running && !disabled && text.trim().length > 0;

  const atMention = pickerClosed ? undefined : mentionAtCursor(text, cursor);
  const picker = useMentionPicker(atMention?.query);
  const pickerOpen = atMention !== undefined && picker.items.length > 0;

  const update = (value: string, caret: number) => {
    setText(value);
    setCursor(caret);
    setPickerClosed(false);
  };

  const pick = (item: MentionCandidate) => {
    if (!atMention) return;
    const token = tokenFor(item);
    const value = `${text.slice(0, atMention.start)}${token} ${text.slice(cursor)}`;
    const caret = atMention.start + token.length + 1;
    update(value, caret);
    setPicked((list) => [...list.filter((p) => p.token !== token), { token, mention: item.mention }]);
    requestAnimationFrame(() => box.current?.setSelectionRange(caret, caret));
  };

  const send = () => {
    if (!canSend) return;
    const message = text.trim();
    // Only picks still in the text count (the user may have deleted one).
    onSend(message, picked.filter((p) => message.includes(p.token)).map((p) => p.mention));
    setText("");
    setPicked([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      const count = picker.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        picker.setActive((picker.active + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        pick(picker.items[picker.active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPickerClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="moon-composer">
      {pickerOpen && (
        <MentionPicker items={picker.items} active={picker.active} onPick={pick} onHover={picker.setActive} />
      )}
      <div className="moon-composer-box">
        <textarea
          ref={box}
          aria-label="Message Moon"
          placeholder={disabled ? "Open a folder to use Moon" : "Ask Moon about this project (@ to add a file or symbol)"}
          value={text}
          disabled={disabled}
          rows={2}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={() => setPickerClosed(true)}
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
