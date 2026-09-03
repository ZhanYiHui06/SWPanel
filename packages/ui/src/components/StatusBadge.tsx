import { cx } from "../lib/cx.js";
import { badgeTone, type BadgeVariant } from "../lib/types.js";

/**
 * StatusBadge — pill with a leading dot. The palette is driven entirely by the
 * variant CSS class (`.status-badge.{variantClass}`) exactly as in the prototype.
 */
export interface StatusBadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClass: Record<NonNullable<StatusBadgeProps["size"]>, string | null> = {
  sm: "status-badge-sm",
  md: null,
  lg: "status-badge-lg"
};

const variantClass: Readonly<Record<BadgeVariant, string>> = Object.freeze({
  running: "running",
  queued: "queued",
  completed: "completed",
  approved: "approved",
  "pending-review": "pending-review",
  clarification: "clarification",
  failed: "failed",
  rejected: "rejected",
  cancelled: "cancelled",
  "no-model": "no-model",
  current: "current-rev"
});

export function StatusBadge({ variant, children, size = "md", className }: StatusBadgeProps) {
  return (
    <span
      className={cx("status-badge", variantClass[variant], sizeClass[size], className)}
      data-variant={variant}
      data-tone={badgeTone[variant]}
    >
      {children}
    </span>
  );
}
