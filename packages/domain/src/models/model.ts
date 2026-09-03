import { DomainInvariantError } from "../errors.js";

/**
 * Canonical Model review statuses. `APPROVED` is a historical audit fact; the
 * "current approved model" identity lives on the Drawing Revision pointer.
 */
export const MODEL_REVIEW_STATUSES = ["PENDING_REVIEW", "APPROVED", "REJECTED"] as const;
export type ModelReviewStatus = (typeof MODEL_REVIEW_STATUSES)[number];

export const MODEL_REVIEW_STATUS_LABELS: Readonly<Record<ModelReviewStatus, string>> = {
  PENDING_REVIEW: "等待审核",
  APPROVED: "审核通过",
  REJECTED: "已退回"
};

/** Deterministic validation facts attached to a generated Model. */
export interface ModelValidationSummary {
  solidWorksVersion: string;
  units: string;
  projectionDecision: string;
  featureCount: number;
  bodyCount: number;
  rebuildStatus: "PASSED" | "FAILED";
  unresolvedAssumptions: readonly string[];
}

/**
 * A three-dimensional modeling result produced by a successful Modeling Run.
 * Being generated never makes a Model an official model; human review does.
 *
 * `productionVerified` is the truthful production-verification provenance of
 * the published Model, persisted by the atomic publisher directly from the
 * STRICTLY validated Result Manifest claim (P5 truthfulness hardening): a
 * synthetic Fake Agent / preflight path always persists `false`, and no other
 * provenance is invented — the publisher has no agent adapter id/version
 * identity of its own to record.
 */
export interface Model {
  id: string;
  /** Business sequence label, e.g. M01 / M02 / M03. */
  number: string;
  drawingId: string;
  revisionId: string;
  runId: string;
  reviewStatus: ModelReviewStatus;
  generatedAt: string;
  /** True only when the strictly validated Result Manifest claimed production verification. */
  productionVerified: boolean;
  validationSummary?: ModelValidationSummary;
  buildReportSummary?: string;
  artifactIds: readonly string[];
}

/**
 * The only legal Model transitions are PENDING_REVIEW -> APPROVED and
 * PENDING_REVIEW -> REJECTED. A REJECTED Model never resumes business flow:
 * fixing a model requires a new Modeling Run, not an in-place edit.
 */
export function transitionModelStatus(
  current: ModelReviewStatus,
  next: ModelReviewStatus
): ModelReviewStatus {
  if (current === next) return current;
  if (current === "PENDING_REVIEW" && (next === "APPROVED" || next === "REJECTED")) return next;
  throw new DomainInvariantError(`Illegal model review status transition: ${current} -> ${next}`);
}
