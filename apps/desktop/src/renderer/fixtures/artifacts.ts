import type { Artifact, ArtifactKind } from "@swpanel/domain";
import { ADAPTER_MODEL_ARTIFACT_KINDS } from "@swpanel/domain";
import { mockSha256 } from "./drawings.js";

const ARTIFACT_FILE_NAMES: Readonly<Record<ArtifactKind, (modelId: string) => string>> = {
  SOURCE_DRAWING: (modelId) => `source-${modelId}.pdf`,
  SLDPRT: (modelId) => `${modelId}.sldprt`,
  PREVIEW: (modelId) => `preview-${modelId}.png`,
  DIMENSION_LEDGER: (modelId) => `dimension-ledger-${modelId}.json`,
  FEATURE_PLAN: (modelId) => `feature-plan-${modelId}.json`,
  BUILD_VALIDATION_LOG: (modelId) => `validation-log-${modelId}.json`,
  BUILDER_SOURCE: (modelId) => `builder-source-${modelId}.json`,
  PROCESS_MP4: (modelId) => `process-${modelId}.mp4`
};

/**
 * Builds the six artifact records a completed Modeling Run publishes under a
 * Model: the five hard success artifacts plus the adapter-required Builder
 * Source. Only metadata is modeled; bytes live on NTFS (Phase 2).
 */
export function buildModelArtifacts(
  runId: string,
  modelId: string,
  createdAt: string
): Artifact[] {
  return ADAPTER_MODEL_ARTIFACT_KINDS.map((kind, index) => {
    const fileName = ARTIFACT_FILE_NAMES[kind](modelId);
    return {
      id: `artifact-${modelId}-${kind.toLowerCase()}`,
      runId,
      modelId,
      kind,
      fileName,
      relativePath: `models/${modelId}/${fileName}`,
      sizeBytes: 4096 * (index + 1),
      sha256: mockSha256(`${modelId}-${kind}`),
      createdAt
    };
  });
}
