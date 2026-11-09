// The line under a finished turn when it did not end normally.

import type { TurnStatus } from "../chat/chat-state";

export function TurnNotice({ status, error, onRetry }: { status: TurnStatus; error?: string; onRetry?: () => void }) {
  if (status === "cancelled") return <div className="moon-notice">Stopped.</div>;
  if (status === "error") {
    return (
      <div className="moon-notice error">
        <span>{error ?? "The run failed."}</span>
        {onRetry && (
          <button className="moon-button" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  return null;
}
