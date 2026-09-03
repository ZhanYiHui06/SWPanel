import { cx } from "../lib/cx.js";
import type { ReactNode } from "react";

/**
 * Card — quiet, border-driven surface (`.card`).
 * Composable with Card.Header / Card.Body / Card.Footer.
 */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("card", className)}>{children}</div>;
}

export function CardHeader({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("card-header", className)}>{children}</div>;
}

export function CardTitle({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return <span className={cx("card-title", className)}>{children}</span>;
}

export interface CardBodyProps {
  /** `compact` matches `.card-body.compact`; `flush` removes padding entirely. */
  padding?: "default" | "compact" | "flush";
  className?: string;
  children: ReactNode;
}

export function CardBody({ padding = "default", className, children }: CardBodyProps) {
  const padClass =
    padding === "compact"
      ? "compact"
      : padding === "flush"
        ? "card-body-flush"
        : null;
  return <div className={cx("card-body", padClass, className)}>{children}</div>;
}

export function CardFooter({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("card-footer", className)}>{children}</div>;
}

/** Card description block (`.card-desc`). */
export function CardDescription({
  className,
  children
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("card-desc", className)}>{children}</div>;
}

Card.Header = CardHeader;
Card.Title = CardTitle;
Card.Body = CardBody;
Card.Footer = CardFooter;
Card.Description = CardDescription;

export default Card;
