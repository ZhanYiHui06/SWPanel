import type { ModelingFeedback, RevisionFact } from "@swpanel/domain";
import { REVISION_IDS } from "./drawings.js";
import { RUN_IDS } from "./runs.js";
import { MODEL_IDS } from "./models.js";
import { TIME } from "./timeline.js";

/** Stable fixture ids for the canonical Revision Facts / Modeling Feedback. */
export const FACT_IDS = {
  material: "fact-v3-material",
  centerHoleDepth: "fact-v3-center-hole-depth",
  r5Fillet: "fact-v3-r5-fillet"
} as const;

export const FEEDBACK_IDS = {
  m02: "feedback-v3-m02",
  m03: "feedback-v3-m03"
} as const;

/**
 * Confirmed material fact that predates every Run on V3. It is recorded at the
 * V3 upload instant so no fact on V3 predates the revision itself (the causal
 * chain `revision created <= fact created <= run created` stays intact).
 */
export function buildMaterialFact(): RevisionFact {
  return {
    id: FACT_IDS.material,
    revisionId: REVISION_IDS.mainV3,
    field: "材料",
    value: "42CrMo",
    source: "DRAWING_CONFIRMED",
    createdAt: TIME.v3Uploaded
  };
}

/** Modeling Feedback produced by the rejected M02 review. */
export function buildM02Feedback(reviewId: string): ModelingFeedback {
  return {
    id: FEEDBACK_IDS.m02,
    revisionId: REVISION_IDS.mainV3,
    modelId: MODEL_IDS.mainM02,
    reviewId,
    content: "右侧台阶直径错误，应为 Ø120；同时遗漏图纸中的 R5 圆角。",
    source: "MODEL_REVIEW_REJECTED",
    createdAt: TIME.m02Rejected
  };
}

/** Modeling Feedback produced by the rejected M03 review. */
export function buildM03Feedback(reviewId: string): ModelingFeedback {
  return {
    id: FEEDBACK_IDS.m03,
    revisionId: REVISION_IDS.mainV3,
    modelId: MODEL_IDS.mainM03,
    reviewId,
    content: "右侧台阶直径识别错误，应为 Ø120；同时遗漏图纸中的 R5 圆角。",
    source: "MODEL_REVIEW_REJECTED",
    createdAt: TIME.m03Rejected
  };
}

/** Convenience reference to the main Clarification Run (R04). */
export function clarificationSourceRunId(): string {
  return RUN_IDS.mainR04;
}
