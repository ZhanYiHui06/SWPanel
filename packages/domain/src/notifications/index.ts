/**
 * Canonical notification tones. A tone drives the icon/accent color, never
 * the semantics: `neutral` is the deliberate absence of a tone value.
 */
export const NOTIFICATION_TONES = ["info", "success", "warning", "error", "neutral"] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

/** Domain area a notification belongs to; drives grouping/filtering. */
export const NOTIFICATION_CATEGORIES = ["run", "model", "cost", "system"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * One user-visible notification. Timestamps are canonical ISO-8601 UTC
 * instants; `actionRoute` is a UI-relative deep-link (e.g. `/drawings/d1/r/rev-3`)
 * navigated to when the user activates the notification.
 */
export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  tone: NotificationTone;
  timestamp: string;
  read: boolean;
  actionRoute?: string;
  category?: NotificationCategory;
}

/**
 * Summary of one startup recovery scan over previously active Modeling Runs.
 * The Runner checks each Run that was still QUEUED/RUNNING on a previous
 * crash/restart and either resumes, fails or skips it; `unsupportedCount`
 * counts Runs whose persisted attempt state has no supported recovery path.
 */
export interface RecoveryStatusSummary {
  /** When the recovery scan ran (canonical ISO-8601 UTC). */
  scanTime: string;
  /** Total number of active Runs checked by the scan. */
  totalActiveChecked: number;
  /** How many active Runs the scan successfully resumed. */
  resumedCount: number;
  /** How many active Runs the scan had to mark failed (fail-closed). */
  failedCount: number;
  /** How many active Runs had no supported recovery path. */
  unsupportedCount: number;
  /** How many active Runs the scan deliberately skipped (e.g. policy). */
  skippedCount: number;
}
