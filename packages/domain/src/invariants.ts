import type { Drawing } from "./drawings/drawing.js";
import type { ModelReviewStatus } from "./models/model.js";
import type { DrawingRevision } from "./revisions/revision.js";
import type { RunStatus } from "./runs/status.js";

export function isCurrentRevision(drawing: Drawing, revisionId: string): boolean {
  return drawing.currentRevisionId === revisionId;
}

export function hasCurrentApprovedModel(revision: DrawingRevision): boolean {
  return revision.currentApprovedModelId !== null;
}

/**
 * Only the current Drawing Revision's current Approved Model may generate a new
 * Cost Estimate Report. Stale Revisions and models without approval never qualify.
 */
export function canCreateCostEstimateReport(drawing: Drawing, revision: DrawingRevision): boolean {
  return isCurrentRevision(drawing, revision.id) && hasCurrentApprovedModel(revision);
}

/** Only PENDING_REVIEW models may be reviewed. */
export function canReviewModel(status: ModelReviewStatus): boolean {
  return status === "PENDING_REVIEW";
}

/** Users may only cancel QUEUED or RUNNING Runs. */
export function canCancelRun(status: RunStatus): boolean {
  return status === "QUEUED" || status === "RUNNING";
}

/**
 * A Drawing may only point its current revision pointer at a Revision it owns.
 * Switching the current revision is an atomic metadata transition: it never
 * creates, mutates or reorders a Modeling Run, and it never affects the Run
 * input snapshot already frozen by an existing Run.
 */
export function canSetCurrentRevision(drawing: Drawing, revision: DrawingRevision): boolean {
  return revision.drawingId === drawing.id;
}
