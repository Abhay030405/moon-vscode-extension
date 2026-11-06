// Text from the user's files is DATA, never instructions. A file could contain
// "ignore your rules and ..." (prompt injection), so every tool result that carries file
// content is wrapped in a clearly labelled block. The agent's safety rules
// (agents/prompts/safety-rules.md) tell the model what this block means.

const TAG = "untrusted_project_content";

/** Wraps file-derived text; `source` says where it came from (e.g. a path or "search results"). */
export function wrapUntrusted(source: string, text: string): string {
  // A file must not be able to close the block early and "escape" into instructions.
  const safe = text.replaceAll(`</${TAG}`, `<\\/${TAG}`);
  const label = source.replaceAll('"', "'");
  return `<${TAG} source="${label}">\n${safe}\n</${TAG}>`;
}
