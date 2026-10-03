/**
 * Explicit Mock Model adapter (Phase 6).
 *
 * Serves the Model detail + review surface from the Phase 1 `MockRepository` in
 * browser dev/tests and canonical scenario tests. This is an EXPLICIT adapter
 * selected by `resolveModelRepository` — the product runtime never falls back to
 * it: production without `window.swpanel` resolves to
 * `UnavailableModelRepository` (an error state, never fixture data).
 *
 * All methods are asynchronous (resolved on the microtask queue) so pages
 * exercise the same loading/error paths as the real bridge. `reviewModel`
 * delegates to the mock repository's canonical `model.review` (same domain
 * transition the Runner applies) and then resolves the refreshed aggregated
 * Model detail.
 */

import { DomainInvariantError } from "@swpanel/domain";
import type { ModelDetailView } from "@swpanel/contracts";
import type { MockRepository } from "../mock-repository/mock-repository.js";
import {
  ModelRepositoryError,
  toModelRepositoryError,
  type ModelRepository,
  type ReviewModelInput
} from "./model-repository.js";

/** Maps mock failures into a structured repository error (never throws). */
function mapFailure(error: unknown): ModelRepositoryError {
  if (error instanceof DomainInvariantError) {
    return new ModelRepositoryError("INVALID_INPUT", error.message);
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: string }).code === "string"
  ) {
    return new ModelRepositoryError((error as { code: string }).code, error.message);
  }
  return toModelRepositoryError(error);
}

export class MockModelRepository implements ModelRepository {
  readonly mode = "mock" as const;

  constructor(readonly mock: MockRepository) {}

  getModelDetail(modelId: string): Promise<ModelDetailView> {
    try {
      return Promise.resolve(this.mock.getModelDetail(modelId));
    } catch (error) {
      return Promise.reject(mapFailure(error));
    }
  }

  reviewModel(input: ReviewModelInput): Promise<ModelDetailView> {
    try {
      this.mock.reviewModel({
        modelId: input.modelId,
        result: input.result,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
        reviewerId: input.reviewerId,
        reviewedAt: input.reviewedAt ?? new Date().toISOString()
      });
      return Promise.resolve(this.mock.getModelDetail(input.modelId));
    } catch (error) {
      return Promise.reject(mapFailure(error));
    }
  }
}