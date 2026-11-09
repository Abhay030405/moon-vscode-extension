// The plan card: before a big task the agent shows its plan (propose_plan) and TrueForge holds
// the call until the user answers. Approve = the agent carries it out. Edit = the user's
// requested changes go back to the agent, which revises and proposes again.

import { useEffect, useRef, useState } from "react";
import type { PlanView } from "../protocol/messages";

interface Props {
  plan: PlanView;
  onDecide(approve: boolean, changes?: string): void;
}

export function PlanCard({ plan, onDecide }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [changes, setChanges] = useState("");
  useEffect(() => {
    card.current?.scrollIntoView({ block: "end" });
  }, [plan.requestId]);
  return (
    <div className="moon-card" role="group" aria-label="Plan approval" ref={card}>
      <div className="moon-card-title">Plan: {plan.title}</div>
      <ol className="moon-plan-steps">
        {plan.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {plan.files.length > 0 && (
        <div className="moon-card-meta">
          Files: <span className="moon-plan-files">{plan.files.join(", ")}</span>
        </div>
      )}
      {plan.risks.length > 0 && (
        <ul className="moon-card-risks">
          {plan.risks.map((risk) => (
            <li key={risk}>Risk: {risk}</li>
          ))}
        </ul>
      )}
      {editing ? (
        <form
          className="moon-plan-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (changes.trim()) onDecide(false, changes.trim());
          }}
        >
          <textarea
            className="moon-plan-input"
            placeholder="What should change in the plan?"
            value={changes}
            onChange={(e) => setChanges(e.target.value)}
            autoFocus
          />
          <div className="moon-card-actions">
            <button className="moon-button primary" type="submit" disabled={!changes.trim()}>
              Send changes
            </button>
            <button className="moon-button" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="moon-card-actions">
          <button className="moon-button primary" onClick={() => onDecide(true)}>
            Approve
          </button>
          <button className="moon-button" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      )}
    </div>
  );
}
