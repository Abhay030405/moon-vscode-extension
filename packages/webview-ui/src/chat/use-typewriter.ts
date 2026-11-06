// Reveals streamed text at a steady pace, so the answer reads like typing even though the
// model's text arrives in bursts. It speeds up when it falls behind: it never lags the real
// stream by more than `maxLagMs`. Without settings it shows the text at once.

import { useEffect, useRef, useState } from "react";
import type { TypingSettings } from "../protocol/messages";

/** Returns how many characters of `text` to show now. */
export function useTypewriter(text: string, typing: TypingSettings | undefined): number {
  const position = useRef(typing ? 0 : text.length); // fractional, so slow speeds still advance
  const [shown, setShown] = useState(position.current);

  useEffect(() => {
    if (!typing) {
      position.current = text.length;
      setShown(text.length);
      return;
    }
    if (position.current >= text.length) return;

    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const elapsedMs = now - last;
      last = now;
      const backlog = text.length - position.current;
      const steady = (typing.charsPerSecond * elapsedMs) / 1000;
      const catchUp = (backlog * elapsedMs) / typing.maxLagMs;
      position.current = Math.min(text.length, position.current + Math.max(steady, catchUp));
      setShown(Math.floor(position.current));
      if (position.current < text.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, typing]);

  return Math.min(shown, text.length);
}
