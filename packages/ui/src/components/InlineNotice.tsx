import { cx } from "../lib/cx.js";
import { ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from "../icons/index.js";
import type { StatusTone } from "../lib/types.js";
import type { ReactNode } from "react";

/**
 * InlineNotice — tone-colored callout with optional icon/title.
 * Mirrors `.inline-notice.{tone}` from the prototype.
 */
export interface InlineNoticeProps {
  tone?: StatusTone;
  /** Defaults to a tone-appropriate icon; pass `null` to hide. */
  icon?: ReactNode | null;
  title?: string;
  children: ReactNode;
  className?: string;
  /**
   * Optional live-region role. Omitted by default so static notices are not
   * announced; pass "alert" for dynamic errors and "status" for dynamic results.
   */
  role?: "alert" | "status";
}

const toneIcon: Record<StatusTone, ReactNode> = {
  info: <InfoIcon className="inline-notice-icon" />,
  success: <SuccessIcon className="inline-notice-icon" />,
  warning: <WarningIcon className="inline-notice-icon" />,
  error: <ErrorIcon className="inline-notice-icon" />,
  neutral: <InfoIcon className="inline-notice-icon" />
};

export function InlineNotice({
  tone = "neutral",
  icon = toneIcon[tone],
  title,
  children,
  className,
  role
}: InlineNoticeProps) {
  return (
    <div className={cx("inline-notice", tone !== "neutral" && tone, className)} data-tone={tone} role={role}>
      {icon}
      <div className="inline-notice-content">
        {title !== undefined && <div className="inline-notice-title">{title}</div>}
        <div className="inline-notice-text">{children}</div>
      </div>
    </div>
  );
}
