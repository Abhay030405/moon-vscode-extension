// Moon's mark: a crescent moon with two outlined clouds. The same shape as the activity-bar
// icon (packages/extension/media/moon.svg), drawn in currentColor so CSS decides its colour.

import { useId } from "react";

const CLOUD = "M1.5 4.5A1.5 1.5 0 0 1 1.7 1.5A2 2 0 0 1 5.3 .3A1.7 1.7 0 0 1 8.2 1.7A1.45 1.45 0 0 1 8 4.5Z";
const CLOUD_LEFT = "translate(.6 5.6) scale(.92)";
const CLOUD_RIGHT = "translate(14.1 16) scale(.92)";

export function MoonMark({ className }: { className?: string }) {
  const mask = `moon-mark-${useId().replaceAll(":", "")}`;
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <mask id={mask}>
          <rect width="24" height="24" fill="white" />
          <circle cx="15.9" cy="8.9" r="6.5" fill="black" />
          <path d={CLOUD} transform={CLOUD_LEFT} fill="black" stroke="black" strokeWidth="2.8" />
          <path d={CLOUD} transform={CLOUD_RIGHT} fill="black" stroke="black" strokeWidth="2.8" />
        </mask>
      </defs>
      <circle cx="13.4" cy="11.4" r="8.5" fill="currentColor" mask={`url(#${mask})`} />
      <path d={CLOUD} transform={CLOUD_LEFT} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d={CLOUD} transform={CLOUD_RIGHT} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </svg>
  );
}
