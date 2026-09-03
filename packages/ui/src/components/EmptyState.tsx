import { cx } from "../lib/cx.js";
import { LayersIcon } from "../icons/index.js";
import type { ReactNode } from "react";

/**
 * EmptyState — centered placeholder with icon, title, description and an
 * optional action (`.empty-state`). Matches the prototype's model/run empties.
 */
export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon = <LayersIcon className="empty-state-icon" />,
  action,
  className
}: EmptyStateProps) {
  return (
    <div className={cx("empty-state", className)}>
      {icon}
      <div className="empty-state-title">{title}</div>
      {description !== undefined && <div className="empty-state-desc">{description}</div>}
      {action}
    </div>
  );
}
