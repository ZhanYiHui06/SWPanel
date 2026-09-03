import { cx } from "../lib/cx.js";
import type { ReactNode } from "react";

/**
 * IconButton — square 32px icon-only action (topbar notifications, overflow
 * menus, drawers). Mirrors `.icon-button`.
 */
export interface IconButtonProps {
  label: string;
  children: ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  className?: string;
  /** Extra props for the button element. */
  buttonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
}

export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  className,
  buttonProps
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx("icon-button", className)}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      {...buttonProps}
    >
      {children}
    </button>
  );
}
