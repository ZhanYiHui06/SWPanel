/**
 * Status tone used by StatusBadge and InlineNotice, mapping to the semantic
 * CSS classes confirmed in the prototype.
 */
export type StatusTone =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "neutral";

/**
 * StatusBadge variant. Each variant is a dedicated CSS class whose exact
 * palette (subtle background, border, text) is defined in the token/component
 * CSS. `current` renders the primary "当前版本" pill without a dot.
 */
export type BadgeVariant =
  | "running"
  | "queued"
  | "completed"
  | "approved"
  | "pending-review"
  | "clarification"
  | "failed"
  | "rejected"
  | "cancelled"
  | "no-model"
  | "current";

/** Built-in semantic tone for each badge variant (used for icons/labels). */
export const badgeTone: Readonly<Record<BadgeVariant, StatusTone>> = Object.freeze({
  running: "info",
  queued: "info",
  completed: "success",
  approved: "success",
  "pending-review": "warning",
  clarification: "warning",
  failed: "error",
  rejected: "error",
  cancelled: "neutral",
  "no-model": "neutral",
  current: "neutral"
});
