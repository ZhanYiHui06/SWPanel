export const ARTIFACT_KINDS = [
  "SOURCE_DRAWING",
  "SLDPRT",
  "PREVIEW",
  "DIMENSION_LEDGER",
  "FEATURE_PLAN",
  "BUILD_VALIDATION_LOG",
  "BUILDER_SOURCE",
  "PROCESS_MP4"
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const HARD_MODEL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "SLDPRT",
  "PREVIEW",
  "DIMENSION_LEDGER",
  "FEATURE_PLAN",
  "BUILD_VALIDATION_LOG"
] as const;

export const ADAPTER_MODEL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "SLDPRT",
  "PREVIEW",
  "DIMENSION_LEDGER",
  "FEATURE_PLAN",
  "BUILD_VALIDATION_LOG",
  "BUILDER_SOURCE"
] as const;

export interface Artifact {
  id: string;
  runId: string;
  modelId?: string;
  kind: ArtifactKind;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  mimeType?: string;
  createdAt: string;
}
