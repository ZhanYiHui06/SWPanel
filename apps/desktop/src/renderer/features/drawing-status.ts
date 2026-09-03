/**
 * Drawing business status view models shared by the Drawing Library and the
 * Drawing-management adapters.
 *
 * `drawingStatusFromListItem` derives the status purely from the
 * bridge-compatible `DrawingListItemView` (product runtime: real Runner data).
 * `mockDrawingBusinessStatus` keeps the richer Phase 1 derivation (it can see
 * Models with PENDING_REVIEW) for the explicit mock adapter used by browser
 * dev/tests and the canonical scenario tests.
 */

import type { DrawingListItemView } from "@swpanel/contracts";
import { revisionLabel } from "@swpanel/domain";
import type { BadgeVariant } from "@swpanel/ui";

import type { MockRepository } from "./mock-repository/mock-repository.js";

export type DrawingBusinessStatus =
  | "pending-review"
  | "approved"
  | "running"
  | "clarification"
  | "no-model";

export interface DrawingStatusPresentation {
  readonly key: DrawingBusinessStatus;
  readonly label: string;
  readonly badge: BadgeVariant;
}

export const DRAWING_STATUS: Readonly<Record<DrawingBusinessStatus, DrawingStatusPresentation>> = {
  "pending-review": { key: "pending-review", label: "待审核", badge: "pending-review" },
  approved: { key: "approved", label: "正式模型", badge: "approved" },
  running: { key: "running", label: "建模中", badge: "running" },
  clarification: { key: "clarification", label: "需要补充信息", badge: "clarification" },
  "no-model": { key: "no-model", label: "尚未建模", badge: "no-model" }
};

/**
 * Status derived only from the bridge list view. In the Phase 2 product runtime
 * no Run/Model data exists yet, so real drawings render as 尚未建模 — which is
 * the truthful state, not a fixture.
 */
export function drawingStatusFromListItem(item: DrawingListItemView): DrawingStatusPresentation {
  if (item.currentRevisionId === null) return DRAWING_STATUS["no-model"];
  if (item.hasOpenClarification) return DRAWING_STATUS.clarification;
  if (item.runStatus === "RUNNING") return DRAWING_STATUS.running;
  if (item.runStatus === "CLARIFICATION_REQUIRED") return DRAWING_STATUS.clarification;
  if (item.currentApprovedModelId !== null) return DRAWING_STATUS.approved;
  return DRAWING_STATUS["no-model"];
}

/** Bridge-compatible library list derived from the Phase 1 MockRepository. */
export function listDrawingItems(mock: MockRepository): readonly DrawingListItemView[] {
  const uniqueDrawings = [...new Map(mock.listDrawings().map((drawing) => [drawing.id, drawing])).values()];
  return uniqueDrawings
    .map((drawing) => {
      const currentRevision = drawing.currentRevisionId === null
        ? undefined
        : mock.getRevision(drawing.currentRevisionId);
      const latestRun = currentRevision === undefined
        ? undefined
        : mock
            .listRuns()
            .filter((run) => run.revisionId === currentRevision.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const revisions = mock.listRevisions().filter((revision) => revision.drawingId === drawing.id);
      const newestRevision = revisions.reduce<typeof revisions[number] | undefined>(
        (newest, revision) => (newest === undefined || revision.sequence > newest.sequence ? revision : newest),
        undefined
      );
      const currentOpenClarification = currentRevision
        ? mock
            .listClarifications()
            .some((request) => request.revisionId === currentRevision.id && request.status === "OPEN")
        : false;
      return {
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        name: drawing.name,
        currentRevisionId: drawing.currentRevisionId,
        currentRevisionLabel: currentRevision === undefined ? null : revisionLabel(currentRevision.sequence),
        currentApprovedModelId: currentRevision?.currentApprovedModelId ?? null,
        runStatus: latestRun?.status ?? null,
        updatedAt: drawing.updatedAt,
        totalRevisionCount: revisions.length,
        latestRevisionLabel: newestRevision === undefined ? null : revisionLabel(newestRevision.sequence),
        hasOpenClarification: currentOpenClarification
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Phase 1 status derivation for mock mode: can see Models, so PENDING_REVIEW
 * renders as 待审核 exactly like the Phase 1 library.
 */
export function mockDrawingBusinessStatus(
  mock: MockRepository,
  drawing: DrawingListItemView
): DrawingStatusPresentation {
  if (drawing.currentRevisionId === null) return DRAWING_STATUS["no-model"];
  const models = mock.listModels().filter((model) => model.revisionId === drawing.currentRevisionId);
  if (models.some((model) => model.reviewStatus === "PENDING_REVIEW")) return DRAWING_STATUS["pending-review"];

  const latestRun = mock
    .listRuns()
    .filter((run) => run.revisionId === drawing.currentRevisionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latestRun?.status === "RUNNING") return DRAWING_STATUS.running;
  if (latestRun?.status === "CLARIFICATION_REQUIRED") return DRAWING_STATUS.clarification;
  if (drawing.currentApprovedModelId !== null) return DRAWING_STATUS.approved;
  return DRAWING_STATUS["no-model"];
}
