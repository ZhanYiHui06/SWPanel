import { StatusBadge } from "@swpanel/ui";

import { runStatusBadge, runStatusLabel } from "../status.js";

export interface RunStatusBadgeProps {
  readonly status: string;
  readonly size?: "sm" | "md" | "lg";
}

/** Renders a Modeling Run status as the canonical badge pill. */
export function RunStatusBadge({ status, size = "md" }: RunStatusBadgeProps): React.JSX.Element {
  return (
    <StatusBadge variant={runStatusBadge(status)} size={size}>
      {runStatusLabel(status)}
    </StatusBadge>
  );
}
