// A line in the agent's turn when Moon changes models:
// fallback: "Main model failed (invalid key). Switched to backup: azure-deepseek/..."
// back:     "Main model works again: back to anthropic/..."

interface Props {
  direction: "fallback" | "back";
  from: string;
  to: string;
  reason?: string;
}

export function ModelSwitchNotice({ direction, from, to, reason }: Props) {
  if (direction === "back") {
    return (
      <div className="moon-switch back" role="status">
        Main model works again: back to <span className="moon-switch-model">{to}</span>.
      </div>
    );
  }
  return (
    <div className="moon-switch" role="status">
      <span className="moon-switch-model">{from}</span> failed{reason ? ` (${reason})` : ""}. Switched to backup:{" "}
      <span className="moon-switch-model">{to}</span>. Starting the request again; your files were not changed.
    </div>
  );
}
