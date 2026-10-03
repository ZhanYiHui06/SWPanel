/**
 * Phase 6 async Model Review repository surface.
 *
 * This is the runtime data contract behind the Model pages (Drawing Workspace ·
 * 模型, Model Detail and the review actions on PENDING_REVIEW models). It is
 * deliberately asynchronous so the SAME surfaces run against:
 *
 * - the real `window.swpanel.models` bridge (`BridgeModelRepository`) in the
 *   packaged/desktop product runtime — data comes from the real Runner
 *   (persisted Models + Reviews), never from Phase 1 fixtures;
 * - an explicit `MockModelRepository` adapter in browser dev/tests — this is
 *   the ONLY place the Phase 1 `MockRepository` may serve Model pages, and it
 *   is an explicit, documented adapter, never a silent product fallback;
 * - `UnavailableModelRepository` when the product renderer has no bridge (an
 *   error state, never fixture data).
 *
 * The review command (Phase 6 Approved/Rejected gates) is a one-way domain
 * transition: a PENDING_REVIEW model becomes APPROVED or REJECTED and never
 * resumes business flow — fixing a rejected model requires a new Modeling Run.
 */

import type { ModelDetailView } from "@swpanel/contracts";
import type { MockRepository } from "../mock-repository/mock-repository.js";
import type { BusinessDeletionCapability } from "../deletion/BusinessDeletionDialog.js";

/** Structured repository error carrying the stable bridge/runner error code. */
export class ModelRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRepositoryError";
    this.code = code;
  }
}

/** Converts any thrown value into a structured model repository error. */
export function toModelRepositoryError(error: unknown): ModelRepositoryError {
  if (error instanceof ModelRepositoryError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return new ModelRepositoryError((error as { code: string }).code, error.message);
  }
  return new ModelRepositoryError("UNKNOWN", error instanceof Error ? error.message : String(error));
}

/** True when the error is the structured NOT_FOUND business failure. */
export function isModelNotFoundError(error: unknown): boolean {
  return error instanceof ModelRepositoryError && error.code === "NOT_FOUND";
}

export interface ReviewModelInput {
  readonly modelId: string;
  readonly result: "APPROVED" | "REJECTED";
  /** Required when `result` is REJECTED (written into the revision feedback). */
  readonly comment?: string;
  readonly reviewerId: string;
  /**
   * Ignored by the Web server (its clock stamps the review); only the legacy
   * bridge / mock adapters still need an instant, and generate one if absent.
   */
  readonly reviewedAt?: string;
}

/**
 * Async data + command surface consumed by the Model pages. Implementations:
 * `BridgeModelRepository` (product), `MockModelRepository` (explicit dev/test
 * adapter), `UnavailableModelRepository` (error state).
 */
export interface ModelRepository extends BusinessDeletionCapability {
  /** Which runtime the adapter represents (documented separation). */
  readonly mode: "bridge" | "mock" | "unavailable";
  /** The Phase 1 MockRepository backing this adapter, or null. */
  readonly mock: MockRepository | null;

  /** Aggregated Model detail: model facts, artifacts and review records. */
  getModelDetail(modelId: string): Promise<ModelDetailView>;

  /** Browser-safe artifact endpoint; absent when file access is unavailable. */
  artifactUrl?(modelId: string, artifactId: string, download?: boolean): string;

  /**
   * Applies the APPROVE / REJECT decision for a PENDING_REVIEW model and
   * resolves the refreshed detail. An APPROVED model becomes the revision's
   * current approved model; a REJECTED model never resumes business flow.
   */
  reviewModel(input: ReviewModelInput): Promise<ModelDetailView>;
}
