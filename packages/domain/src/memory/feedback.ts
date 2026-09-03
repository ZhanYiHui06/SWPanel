/**
 * `Modeling Feedback` records reviewer-identified Agent modeling mistakes so
 * later Runs avoid repeating them. It is modeling experience and never overrides
 * the authoritative engineering facts in `Revision Facts`.
 *
 * Feedback is either derived from a rejected Model Review (`MODEL_REVIEW_REJECTED`,
 * which always carries the rejected `modelId`/`reviewId`) or entered directly by
 * an engineer on the Drawing workflow (`USER_SUPPLEMENT`, which carries neither).
 */
export const MODELING_FEEDBACK_SOURCES = [
  "MODEL_REVIEW_REJECTED",
  "USER_SUPPLEMENT"
] as const;
export type ModelingFeedbackSource = (typeof MODELING_FEEDBACK_SOURCES)[number];

export interface ModelingFeedback {
  id: string;
  revisionId: string;
  /** Model whose rejection produced this feedback (review-derived only). */
  modelId?: string;
  /** Model Review record that produced this feedback (review-derived only). */
  reviewId?: string;
  content: string;
  source: ModelingFeedbackSource;
  createdAt: string;
}
