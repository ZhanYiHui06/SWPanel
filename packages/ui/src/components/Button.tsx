import { cx } from "../lib/cx.js";
import type { ReactNode } from "react";

/**
 * Button — SWPanel primary/secondary/ghost action.
 * Renders an `<a>` when `href` is provided, otherwise a `<button>`.
 * Mirrors `.btn` + variant/size classes from the prototype.
 */
export interface ButtonProps {
  variant?: "primary" | "secondary" | "ghost" | "ghost-muted" | "danger";
  size?: "sm" | "md" | "lg";
  /** When set, the button renders as an anchor styled identically. */
  href?: string;
  /** When href is set, target for the anchor (defaults to undefined). */
  target?: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  onClick?: React.MouseEventHandler<HTMLElement>;
  /** Passthrough props for the underlying element. */
  buttonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  anchorProps?: React.AnchorHTMLAttributes<HTMLAnchorElement>;
}

const variantClass: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  "ghost-muted": "btn-ghost-muted",
  danger: "btn-danger"
};

const sizeClass: Record<NonNullable<ButtonProps["size"]>, string | null> = {
  sm: "btn-sm",
  md: null,
  lg: "btn-lg"
};

export function Button({
  variant = "secondary",
  size = "md",
  href,
  target,
  disabled = false,
  className,
  children,
  onClick,
  buttonProps,
  anchorProps
}: ButtonProps) {
  const classes = cx("btn", variantClass[variant], sizeClass[size], className);

  if (href !== undefined) {
    return (
      <a
        href={href}
        target={target}
        className={classes}
        aria-disabled={disabled || undefined}
        onClick={onClick}
        {...anchorProps}
      >
        {children}
      </a>
    );
  }

  return (
    <button type="button" className={classes} disabled={disabled} onClick={onClick} {...buttonProps}>
      {children}
    </button>
  );
}
