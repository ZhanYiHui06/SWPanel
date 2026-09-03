import type { ModelDetailView, ModelListItemView } from "@swpanel/contracts";
import type { ModelReviewResult } from "@swpanel/domain";

import { RunRepository } from "../db/run-repository.js";
import { SqliteRepository } from "../db/repository.js";

/** Application input of a `model.review` use case (mirrors `ReviewModelCommand`). */
export interface ReviewModelInput {
  modelId: string;
  result: ModelReviewResult;
  /** Required when `result` is REJECTED. */
  comment?: string;
  reviewerId: string;
  reviewedAt: string;
}

/**
 * Phase 6 Model workflow application service. Human review of a generated
 * Model is atomic: the Review record, the Model's review-status transition and
 * the new Revision pointer (APPROVED) or the Modeling Feedback entry (REJECTED)
 * commit together, and the M-number labels, pending-review queue items and
 * aggregate reads come from the persisted store. The storage primitives live on
 * the `SqliteRepository`; the review/read aggregates live on the `RunRepository`
 * (which composes its own write transaction — the service wraps the review in
 * the repository transaction so the whole use case unit is the service's).
 */
export class ModelWorkflowService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly runs: RunRepository
  ) {}

  reviewModel(input: ReviewModelInput): ModelDetailView {
    return this.repository.transaction(() => this.runs.reviewModel(input));
  }

  getModelDetail(modelId: string): ModelDetailView {
    return this.runs.getModelDetail(modelId);
  }

  listModelsByRevision(revisionId: string): readonly ModelListItemView[] {
    return this.runs.listModelsByRevision(revisionId);
  }
}