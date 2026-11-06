// The line under a finished turn when it did not end normally.

import type { TurnStatus } from "../chat/chat-state";

export function TurnNotice({ status, error }: { status: TurnStatus; error?: string }) {
  if (status === "cancelled") return <div className="moon-notice">Stopped.</div>;
  if (status === "error") return <div className="moon-notice error">{error ?? "The run failed."}</div>;
  return null;
}
