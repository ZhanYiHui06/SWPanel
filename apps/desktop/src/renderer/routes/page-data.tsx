/**
 * Page-level presentation shims over the Drawing status view models.
 *
 * The status derivation and mock library projection moved to
 * `features/drawing-status.ts` so the WP6 adapters can share them without
 * importing route modules. Mock-only pages (Workbench, Run/Model/Cost pages)
 * keep importing `listDrawingItems` / `drawingBusinessStatus` from here.
 */

import { StatusBadge } from "@swpanel/ui";

import {
  DRAWING_STATUS,
  drawingStatusFromListItem,
  listDrawingItems,
  mockDrawingBusinessStatus as drawingBusinessStatus,
  type DrawingBusinessStatus,
  type DrawingStatusPresentation
} from "../features/drawing-status.js";

export {
  DRAWING_STATUS as STATUS,
  drawingStatusFromListItem,
  listDrawingItems,
  drawingBusinessStatus,
  type DrawingBusinessStatus,
  type DrawingStatusPresentation
};

export function DrawingStatusBadge({ status }: { readonly status: DrawingStatusPresentation }): React.JSX.Element {
  return <StatusBadge variant={status.badge}>{status.label}</StatusBadge>;
}
