/**
 * Model Review is a record of an already-performed human engineering review.
 * It has no PENDING state machine: a Review records APPROVED or REJECTED at
 * creation time. A Rejected Review requires a comment, which is written into
 * the Revision's Modeling Feedback.
 */
export const MODEL_REVIEW_RESULTS = ["APPROVED", "REJECTED"] as const;
export type ModelReviewResult = (typeof MODEL_REVIEW_RESULTS)[number];

export interface ModelReview {
  id: string;
  modelId: string;
  result: ModelReviewResult;
  /** Reviewer identity snapshot (trusted current Windows user in MVP). */
  reviewerId: string;
  /** Required when `result` is REJECTED. */
  comment?: string;
  createdAt: string;
}
