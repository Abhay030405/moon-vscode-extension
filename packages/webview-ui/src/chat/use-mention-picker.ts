// The @ picker's state: while the word at the cursor starts with "@", ask the extension for
// matching files and names (mention-search) and show the answer. Late answers to an older
// query are ignored.

import { useEffect, useRef, useState } from "react";
import type { MentionCandidate } from "../protocol/messages";
import { onExtensionMessage, postToExtension } from "../vscode-api";

/** The "@word" right before the cursor, if any: where it starts and what follows the "@". */
export function mentionAtCursor(text: string, cursor: number): { start: number; query: string } | undefined {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  if (!match) return undefined;
  return { start: cursor - match[2]!.length - 1, query: match[2]! };
}

export function useMentionPicker(query: string | undefined) {
  const [items, setItems] = useState<MentionCandidate[]>([]);
  const [active, setActive] = useState(0);
  const lastRequest = useRef(0);

  useEffect(
    () =>
      onExtensionMessage((message) => {
        if (message.type === "mention-results" && message.requestId === lastRequest.current) {
          setItems(message.items);
          setActive(0);
        }
      }),
    [],
  );

  useEffect(() => {
    if (query === undefined) {
      lastRequest.current++;
      setItems([]);
      return;
    }
    const requestId = ++lastRequest.current;
    postToExtension({ type: "mention-search", requestId, query });
  }, [query]);

  return { items, active, setActive };
}
