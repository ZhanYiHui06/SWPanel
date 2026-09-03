import { cx } from "../lib/cx.js";
import type { ReactNode } from "react";

/**
 * PropertyList — key/value display rows (`.property-list` / `.property-row`).
 * Used in cards, drawers and overview blocks.
 */
export interface PropertyItem {
  key: string;
  value: ReactNode;
  /** Mono value (`.property-value.mono`), e.g. drawing numbers, IDs, paths. */
  mono?: boolean;
}

export interface PropertyListProps {
  items: ReadonlyArray<PropertyItem>;
  className?: string;
}

export function PropertyList({ items, className }: PropertyListProps) {
  return (
    <dl className={cx("property-list", className)}>
      {items.map((item) => (
        <div className="property-row" key={item.key}>
          <dt className="property-key">{item.key}</dt>
          <dd className={cx("property-value", item.mono && "mono")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
