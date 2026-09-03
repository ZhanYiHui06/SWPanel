import type { RunStatus } from "../runs/status.js";

/**
 * Generic decision of a guarded deletion: `canDelete` plus a stable
 * machine-readable `reason` when the deletion is blocked. `reason` is never
 * present on successful deletions.
 */
export interface DeletionDecision {
  canDelete: boolean;
  reason?: string;
}

/**
 * Canonical dependency kinds that block deleting a Drawing Revision. Kept as a
 * stable ordering so a caller can present the blockers to the user verbatim.
 */
export const REVISION_DELETION_BLOCKERS = [
  "CURRENT_REVISION",
  "RUNS",
  "MODELS",
  "COST_REPORTS"
] as const;
export type RevisionDeletionBlocker = (typeof REVISION_DELETION_BLOCKERS)[number];

export interface CanDeleteRevisionInput {
  /** True when this Revision is the Drawing's `current_revision_id`. */
  isCurrentRevision: boolean;
  /** True when at least one Modeling Run references this Revision. */
  hasRuns: boolean;
  /** True when at least one Model was generated from this Revision. */
  hasModels: boolean;
  /** True when at least one Cost Estimate Report references this Revision. */
  hasCostReports: boolean;
  /**
   * `true` bypasses every guard. The caller (repo/app-surface) decides when a
   * forced delete is legitimate: e.g. a destructive "delete anyway" flow the
   * user confirmed. Never defaults to true.
   */
  force?: boolean;
}

export interface CanDeleteRevisionResult extends DeletionDecision {
  /**
   * Only present when `canDelete` is false; lists every blocking dependency in
   * canonical order. The caller surfaces these to the user before a forced
   * delete.
   */
  blockingDependencies?: RevisionDeletionBlocker[];
}

/**
 * A Drawing Revision may be deleted only when it is not the Drawing's current
 * revision and nothing still depends on it (no Runs, Models or Cost Reports).
 * The current revision is the Drawing's live pointer: deleting it would strand
 * the Drawing. `force` bypasses all guards.
 */
export function canDeleteRevision(input: CanDeleteRevisionInput): CanDeleteRevisionResult {
  if (input.force === true) {
    return { canDelete: true };
  }
  const blockingDependencies: RevisionDeletionBlocker[] = [];
  if (input.isCurrentRevision) blockingDependencies.push("CURRENT_REVISION");
  if (input.hasRuns) blockingDependencies.push("RUNS");
  if (input.hasModels) blockingDependencies.push("MODELS");
  if (input.hasCostReports) blockingDependencies.push("COST_REPORTS");
  if (blockingDependencies.length > 0) {
    return {
      canDelete: false,
      reason: "REVISION_HAS_DEPENDENCIES",
      blockingDependencies
    };
  }
  return { canDelete: true };
}

/**
 * The only Run statuses a user may delete outright. QUEUED and RUNNING are
 * active work and must be cancelled first; CLARIFICATION_REQUIRED is terminal
 * but the outstanding clarification session is still the user's responsibility,
 * so its history is not deleted either.
 */
export const DELETABLE_RUN_STATUSES: readonly RunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

export function canDeleteRun(runStatus: RunStatus): DeletionDecision {
  if (DELETABLE_RUN_STATUSES.includes(runStatus)) {
    return { canDelete: true };
  }
  if (runStatus === "CLARIFICATION_REQUIRED") {
    return { canDelete: false, reason: "RUN_HAS_PENDING_CLARIFICATION" };
  }
  return { canDelete: false, reason: "RUN_NOT_TERMINAL" };
}

/**
 * A Cost Estimate Report is persisted only once its deterministic estimate is
 * complete — there is no DRAFT/FINALIZED state machine — so any existing report
 * is deletable. The optional `reportStatus` keeps the guard signature uniform
 * for a future day a status appears; today it never blocks.
 */
export function canDeleteCostReport(reportStatus?: string): DeletionDecision {
  void reportStatus;
  return { canDelete: true };
}
