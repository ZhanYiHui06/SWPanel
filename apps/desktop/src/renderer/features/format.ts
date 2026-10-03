/**
 * Display formatting helpers for the renderer. Fixture timestamps are fixed
 * ISO-8601 UTC instants; they are rendered relative to a `now` baseline so the
 * "今天 / 昨天" vocabulary from the `.design` prototype stays deterministic.
 */

const pad = (value: number): string => String(value).padStart(2, "0");

export function clockTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Formats a run/model timestamp relative to `now`:
 * - same local day  -> `今天 HH:MM`
 * - previous day    -> `昨天 HH:MM`
 * - otherwise       -> `M月D日 HH:MM`
 * - a different calendar year than `now` additionally shows the year:
 *                       `YYYY年M月D日 HH:MM`
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = clockTime(date);
  if (isSameLocalDay(date, now)) return `今天 ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameLocalDay(date, yesterday)) return `昨天 ${time}`;
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** Compact machine label, e.g. `08-10 22:31`. */
export function formatIso(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clockTime(date)}`;
}

/** Human-readable byte size, e.g. `12.4 KB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${units[unitIndex]}`;
}
