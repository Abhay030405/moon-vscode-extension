// Shown on an approval card when the agent read content from outside the project in this task
// (a web page, a GitHub result, an earlier conversation). Planted instructions in that content
// could be behind this request, so the user is told, and "Always" is not offered.

export function TaintNotice({ source }: { source: string }) {
  return (
    <div className="moon-card-taint" role="note">
      The agent read outside content in this task (<code>{source}</code>). Check that this is what you asked for: text from
      outside can carry hidden instructions.
    </div>
  );
}
