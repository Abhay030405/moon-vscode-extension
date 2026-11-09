// "5 min ago", "yesterday", "3 days ago", or the date for anything older than a week.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_DAYS = 7;

export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const ago = Math.max(0, now - at);
  if (ago < MINUTE_MS) return "just now";
  if (ago < HOUR_MS) return `${Math.floor(ago / MINUTE_MS)} min ago`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)} h ago`;
  const days = Math.floor(ago / DAY_MS);
  if (days === 1) return "yesterday";
  if (days < WEEK_DAYS) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}
