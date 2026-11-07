// The list the @ picker shows above the input box: files and names (functions, classes...).

import type { MentionCandidate } from "../protocol/messages";

interface Props {
  items: MentionCandidate[];
  active: number;
  onPick(item: MentionCandidate): void;
  onHover(index: number): void;
}

export function MentionPicker({ items, active, onPick, onHover }: Props) {
  if (items.length === 0) return null;
  return (
    <ul className="moon-picker" role="listbox" aria-label="Files and symbols">
      {items.map((item, i) => (
        <li
          key={`${item.detail}:${item.label}`}
          role="option"
          aria-selected={i === active}
          className={`moon-picker-item ${i === active ? "active" : ""}`}
          // mousedown, not click: keeps the focus in the text box.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className={`moon-picker-kind ${item.mention.kind}`}>{item.mention.kind === "file" ? "file" : "symbol"}</span>
          <span className="moon-picker-label">{item.label}</span>
          <span className="moon-picker-detail">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}
