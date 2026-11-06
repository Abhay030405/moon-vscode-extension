// Small line icons for the panel, drawn in currentColor so CSS decides their colour.

const common = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  className: "moon-icon",
};

export const NewChatIcon = () => (
  <svg {...common}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5.5v5M5.5 8h5" />
  </svg>
);

export const ExternalIcon = () => (
  <svg {...common}>
    <path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  </svg>
);

export const SendIcon = () => (
  <svg {...common}>
    <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
  </svg>
);

export const StopIcon = () => (
  <svg {...common}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const FolderIcon = () => (
  <svg {...common}>
    <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  </svg>
);
