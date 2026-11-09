// The approval card for a tool Moon has no card of its own for (for example a GitHub write
// tool). TrueForge holds the call until the user answers; nothing is ever allowed silently.

import { useEffect, useRef } from "react";
import type { ToolApprovalView } from "../protocol/messages";

interface Props {
  approval: ToolApprovalView;
  onDecide(allow: boolean): void;
}

export function ToolApproval({ approval, onDecide }: Props) {
  const card = useRef<HTMLDivElement>(null);
  // Braces: an effect must not return scrollIntoView's result (see CommandApproval).
  useEffect(() => {
    card.current?.scrollIntoView({ block: "end" });
  }, [approval.requestId]);
  return (
    <div className="moon-card" role="group" aria-label="Tool approval" ref={card}>
      <div className="moon-card-title">
        Allow the agent to use <code>{approval.tool}</code>?
      </div>
      <pre className="moon-card-command">{approval.args}</pre>
      {approval.truncated && <div className="moon-card-meta">The arguments are longer than shown.</div>}
      <div className="moon-card-actions">
        <button className="moon-button primary" onClick={() => onDecide(true)}>
          Allow
        </button>
        <button className="moon-button" onClick={() => onDecide(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
