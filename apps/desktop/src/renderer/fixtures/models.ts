import type { Model, ModelReview, ModelReviewResult, ModelValidationSummary } from "@swpanel/domain";
import { modelLabel } from "@swpanel/domain";
import { TIME } from "./timeline.js";

/** Stable fixture ids for every canonical Model. */
export const MODEL_IDS = {
  mainM01: "model-main-m01",
  mainM02: "model-main-m02",
  mainM03: "model-main-m03",
  aM01: "model-a-m01",
  cM01: "model-c-m01",
  dM01: "model-d-m01"
} as const;

/** Deterministic artifact ids referenced by a Model's `artifactIds`. */
export function modelArtifactIds(modelId: string): readonly string[] {
  return [
    "SLDPRT",
    "PREVIEW",
    "DIMENSION_LEDGER",
    "FEATURE_PLAN",
    "BUILD_VALIDATION_LOG",
    "BUILDER_SOURCE"
  ].map((kind) => `artifact-${modelId}-${kind.toLowerCase()}`);
}

export function validationSummary(
  featureCount: number,
  bodyCount: number
): ModelValidationSummary {
  return {
    // The recorded ACTUAL SolidWorks version (version-agnostic product path).
    solidWorksVersion: "SolidWorks 2025",
    units: "mm",
    projectionDecision: "主视图 → 轴类旋转特征",
    featureCount,
    bodyCount,
    rebuildStatus: "PASSED",
    unresolvedAssumptions: []
  };
}

export function buildReportSummaryText(): string {
  return (
    "模型基于当前 V3 图纸与版本记忆生成。主要结构采用旋转特征完成，已建立中心孔、" +
    "轴肩和局部圆角。模型完成强制 Rebuild，当前未发现阻塞性验证错误。"
  );
}

export function buildModel(input: {
  id: string;
  number: string;
  drawingId: string;
  revisionId: string;
  runId: string;
  reviewStatus: Model["reviewStatus"];
  generatedAt: string;
  /** Truthful production-verification claim; fixtures default to false (synthetic demo data). */
  productionVerified?: boolean;
  validationSummary?: ModelValidationSummary;
  buildReportSummary?: string;
  artifactIds?: readonly string[];
}): Model {
  return {
    id: input.id,
    number: input.number,
    drawingId: input.drawingId,
    revisionId: input.revisionId,
    runId: input.runId,
    reviewStatus: input.reviewStatus,
    generatedAt: input.generatedAt,
    productionVerified: input.productionVerified ?? false,
    artifactIds: input.artifactIds ?? [],
    ...(input.validationSummary !== undefined
      ? { validationSummary: input.validationSummary }
      : {}),
    ...(input.buildReportSummary !== undefined
      ? { buildReportSummary: input.buildReportSummary }
      : {})
  };
}

export function buildModelReview(input: {
  id: string;
  modelId: string;
  result: ModelReviewResult;
  reviewerId: string;
  createdAt: string;
  comment?: string;
}): ModelReview {
  return {
    id: input.id,
    modelId: input.modelId,
    result: input.result,
    reviewerId: input.reviewerId,
    createdAt: input.createdAt,
    ...(input.comment !== undefined ? { comment: input.comment } : {})
  };
}

/** Canonical fixture: the rejected M02 review comment. */
export const M02_REVIEW_COMMENT = "右侧台阶直径错误，应为 Ø120；同时遗漏图纸中的 R5 圆角。";

/** Canonical fixture: the rejected M03 review comment (model-rejected scenario). */
export const M03_REVIEW_COMMENT = "右侧台阶直径识别错误，应为 Ø120；同时遗漏图纸中的 R5 圆角。";

/** Convenience: canonical sequence label for a Model on a revision. */
export function nextModelLabel(sequence: number): string {
  return modelLabel(sequence);
}

/** Reference fixture anchor used when documents cite M03's generation time. */
export const M03_GENERATED_AT: string = TIME.r05Completed;
