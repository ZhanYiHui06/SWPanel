import { useEffect, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { type StatusTone } from "../lib/types.js";
import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from "../icons/index.js";

/**
 * Toast tone. Reuses the shared `StatusTone` surface (info / success / warning /
 * error / neutral) so toast styling matches InlineNotice and the token palette.
 */
export type ToastTone = StatusTone;

/** Default auto-dismiss duration for a toast with no explicit value. */
export const DEFAULT_TOAST_DURATION_MS = 4000;

/** One transient toast message. */
export interface ToastData {
  readonly id: string;
  readonly title: string;
  readonly message?: string;
  readonly tone?: ToastTone;
  /** Auto-dismiss after this many ms; a value <= 0 keeps the toast until closed. */
  readonly durationMs?: number;
}

export interface ToastMessageProps {
  readonly toast: ToastData;
  readonly onDismiss: (id: string) => void;
}

const toneIcon: Record<ToastTone, ReactNode> = {
  info: <InfoIcon className="toast-icon" />,
  success: <SuccessIcon className="toast-icon" />,
  warning: <WarningIcon className="toast-icon" />,
  error: <ErrorIcon className="toast-icon" />,
  neutral: <InfoIcon className="toast-icon" />
};

/**
 * ToastMessage — one tone-colored toast with icon, title, optional message and a
 * close button. Auto-dismisses via `durationMs` (default 4000ms) unless disabled
 * with a non-positive duration. Ownership of the timer lives here so the toast
 * is self-contained and directly testable (fake timers).
 */
export function ToastMessage({ toast, onDismiss }: ToastMessageProps): React.JSX.Element {
  const { id, title, message, tone = "neutral", durationMs = DEFAULT_TOAST_DURATION_MS } = toast;

  useEffect(() => {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => onDismiss(id), durationMs);
    return () => window.clearTimeout(timer);
  }, [id, durationMs, onDismiss]);

  return (
    <div className={cx("toast", tone !== "neutral" && `toast-${tone}`)} role="status" aria-live="polite" data-tone={tone}>
      {toneIcon[tone]}
      <div className="toast-content">
        <div className="toast-title">{title}</div>
        {message !== undefined && <div className="toast-message">{message}</div>}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭通知"
        onClick={() => onDismiss(id)}
      >
        <CloseIcon aria-hidden="true" />
      </button>
    </div>
  );
}

export interface ToastContainerProps {
  readonly toasts: readonly ToastData[];
  readonly onDismiss: (id: string) => void;
  readonly className?: string;
}

/**
 * ToastContainer — fixed stack of active toasts. Renders nothing when there are
 * no toasts so the mount point adds no visual/structural noise.
 */
export function ToastContainer({
  toasts,
  onDismiss,
  className
}: ToastContainerProps): React.JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div className={cx("toast-container", className)} role="region" aria-label="通知">
      {toasts.map((toast) => (
        <ToastMessage key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
