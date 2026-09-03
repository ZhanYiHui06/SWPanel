import type { ModelingFeedback } from "./feedback.js";
import type { RevisionFact } from "./facts.js";

/**
 * The long-lived, per-Revision context used as input for Modeling Runs.
 * Each Drawing Revision owns an isolated Revision Memory; new Revisions do not
 * inherit the memory of older ones. Facts and Feedback are logically separated
 * because facts are authoritative while feedback is accumulated modeling
 * experience.
 */
export interface RevisionMemory {
  revisionId: string;
  facts: readonly RevisionFact[];
  modelingFeedback: readonly ModelingFeedback[];
}
