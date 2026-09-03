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
  className
}: InlineNoticeProps) {
  return (
    <div className={cx("inline-notice", tone !== "neutral" && tone, className)} data-tone={tone}>
      {icon}
      <div className="inline-notice-content">
        {title !== undefined && <div className="inline-notice-title">{title}</div>}
        <div className="inline-notice-text">{children}</div>
      </div>
    </div>
  );
}
