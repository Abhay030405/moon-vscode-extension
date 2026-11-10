// The card shown when the agent wants to run a command in its working copy. TrueForge holds the
// tool call until the user answers here (TrueForge tool approval).

import { useEffect, useRef } from "react";
import type { CommandApprovalView, CommandDecision } from "../protocol/messages";
import { TaintNotice } from "./TaintNotice";

interface Props {
  approval: CommandApprovalView;
  onDecide(decision: CommandDecision): void;
}

export function CommandApproval({ approval, onDecide }: Props) {
  const card = useRef<HTMLDivElement>(null);
  // Braces: an effect must not return scrollIntoView's result (a Promise in newer Chromium),
  // or React calls it as a cleanup function when the card closes.
  useEffect(() => {
    card.current?.scrollIntoView({ block: "end" });
  }, [approval.requestId]);
  return (
    <div className="moon-card" role="group" aria-label="Command approval" ref={card}>
      <div className="moon-card-title">Run this command in Moon's working copy?</div>
      <pre className="moon-card-command">{approval.command}</pre>
      {approval.cwd && <div className="moon-card-meta">in {approval.cwd}</div>}
      {approval.tainted && <TaintNotice source={approval.tainted} />}
      {approval.risks.length > 0 && (
        <ul className="moon-card-risks">
          {approval.risks.map((risk) => (
            <li key={risk}>Careful: {risk}</li>
          ))}
        </ul>
      )}
      <div className="moon-card-actions">
        <button className="moon-button primary" onClick={() => onDecide("once")}>
          Allow once
        </button>
        {!approval.tainted && (
          <button
            className="moon-button"
            onClick={() => onDecide("always")}
            title="Allow this exact command again without asking, until this run ends"
          >
            Always for this run
          </button>
        )}
        <button className="moon-button" onClick={() => onDecide("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
