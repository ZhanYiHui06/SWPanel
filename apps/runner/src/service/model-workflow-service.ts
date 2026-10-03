import type { ClarificationView, ModelDetailView, ModelListItemView } from "@swpanel/contracts";
import type { ClarificationAnswer, ModelReviewResult } from "@swpanel/domain";

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
    private readonly runs: RunRepository,
    /** Server clock (injectable for tests). */
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Human review. `reviewedAt` is stamped by the SERVER clock (FE-05): the
   * browser-supplied value is ignored. `reviewerId` is still client-supplied
   * until an authentication system exists and is NOT a trusted identity.
   */
  reviewModel(input: ReviewModelInput): ModelDetailView {
    const reviewedAt = this.now().toISOString();
    return this.repository.transaction(() => this.runs.reviewModel({ ...input, reviewedAt }));
  }

  /**
   * Clarification answers; `answeredAt` is stamped by the SERVER clock (FE-05).
   * `answeredBy` is client-supplied and not a trusted identity.
   */
  submitClarificationAnswers(input: {
    clarificationRequestId: string;
    answers: readonly ClarificationAnswer[];
    answeredAt?: string;
    answeredBy: string;
  }): ClarificationView {
    const answeredAt = this.now().toISOString();
    return this.runs.submitClarificationAnswers({
      clarificationRequestId: input.clarificationRequestId,
      answers: input.answers.map((answer) => ({ ...answer, answeredAt })),
      answeredAt,
      answeredBy: input.answeredBy
    });
  }

  getModelDetail(modelId: string): ModelDetailView {
    return this.runs.getModelDetail(modelId);
  }

  listModelsByRevision(revisionId: string): readonly ModelListItemView[] {
    return this.runs.listModelsByRevision(revisionId);
  }
}