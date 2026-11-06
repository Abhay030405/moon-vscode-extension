// Agent text, shown as written. `inline code` is styled; everything else is plain text
// (React escapes it, so file content can never inject HTML into the panel).

export function AnswerText({ text }: { text: string }) {
  const pieces = text.split(/(`[^`\n]+`)/g);
  return (
    <div className="moon-answer">
      {pieces.map((piece, i) =>
        piece.length > 2 && piece.startsWith("`") && piece.endsWith("`") ? <code key={i}>{piece.slice(1, -1)}</code> : piece,
      )}
    </div>
  );
}
