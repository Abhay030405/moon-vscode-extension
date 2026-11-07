// Agent text rendered as Markdown (GitHub style: lists, tables, code blocks).
// react-markdown builds React elements and never inserts raw HTML, so text quoted from the
// user's files can't inject anything into the panel. Links open through the extension.

import { useEffect, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TypingSettings } from "../protocol/messages";
import { postToExtension } from "../vscode-api";
import { useTypewriter } from "./use-typewriter";

const CURSOR = "▍";

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) postToExtension({ type: "open-link", url: href });
      }}
    >
      {children}
    </a>
  ),
  // Images are never loaded (the panel's security policy blocks them); show the alt text.
  img: ({ alt }) => <span>{alt}</span>,
};

interface Props {
  text: string;
  typing: TypingSettings | undefined;
  /** Called as more text appears, so the chat can keep the newest line in view. */
  onGrow?(): void;
}

export function AnswerText({ text, typing, onGrow }: Props): ReactNode {
  const shown = useTypewriter(text, typing);
  const typingNow = shown < text.length;
  useEffect(() => {
    onGrow?.();
  }, [shown, onGrow]);

  return (
    <div className="moon-answer">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text.slice(0, shown) + (typingNow ? CURSOR : "")}
      </Markdown>
    </div>
  );
}
