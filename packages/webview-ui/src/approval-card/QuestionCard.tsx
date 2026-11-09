// The card shown when the agent is unsure what the user wants (TrueForge's ask_user_question):
// the question, the agent's options (it is asked for 3, the recommended one first), and a box
// for the user's own answer when none of the options fits. TrueForge holds the turn until the
// answer is sent; it goes back to the agent as the tool's result.

import { useEffect, useRef, useState } from "react";
import type { QuestionView } from "../protocol/messages";

interface Props {
  question: QuestionView;
  onAnswer(answer: string): void;
}

/** TrueForge's convention for the option the agent recommends. */
const RECOMMENDED_SUFFIX = " (Recommended)";

export function QuestionCard({ question, onAnswer }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const [own, setOwn] = useState("");
  const [sent, setSent] = useState(false);
  // Braces: an effect must not return scrollIntoView's result (see CommandApproval).
  useEffect(() => {
    card.current?.scrollIntoView({ block: "end" });
    setOwn("");
    setSent(false);
  }, [question.requestId]);

  const answer = (text: string) => {
    if (sent || !text.trim()) return;
    setSent(true);
    onAnswer(text.trim());
  };

  return (
    <div className="moon-card" role="group" aria-label="Question from Moon" ref={card}>
      <div className="moon-card-title">{question.question}</div>
      {question.options.length > 0 && (
        <div className="moon-question-options">
          {question.options.map((option) => {
            const recommended = option.endsWith(RECOMMENDED_SUFFIX);
            const label = recommended ? option.slice(0, -RECOMMENDED_SUFFIX.length) : option;
            return (
              <button key={option} className="moon-question-option" disabled={sent} onClick={() => answer(label)}>
                <span>{label}</span>
                {recommended && <span className="moon-question-tag">Recommended</span>}
              </button>
            );
          })}
        </div>
      )}
      <form
        className="moon-question-own"
        onSubmit={(e) => {
          e.preventDefault();
          answer(own);
        }}
      >
        <input
          className="moon-question-input"
          value={own}
          disabled={sent}
          placeholder={question.options.length > 0 ? "Something else? Type your own answer" : "Type your answer"}
          aria-label="Your own answer"
          onChange={(e) => setOwn(e.target.value)}
        />
        <button className="moon-button primary" type="submit" disabled={sent || !own.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
