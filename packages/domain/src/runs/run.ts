import type { ModelingFeedback } from "../memory/feedback.js";
import type { RevisionFact } from "../memory/facts.js";
import type { RunStage, RunStatus } from "./status.js";

/** Immutable identity of the modeling Skill frozen into a Run. */
export interface SkillIdentity {
  name: string;
  sha256: string;
}

/**
 * Immutable execution input frozen at Run creation. A Run reads the Memory
 * snapshot from its creation moment, not from the moment execution starts;
 * the snapshot is never modified afterwards.
 */
export interface RunInputSnapshot {
  drawingId: string;
  revisionId: string;
  /** Stable reference to the original drawing file artifact. */
  originalFileRef: string;
  revisionFacts: readonly RevisionFact[];
  modelingFeedback: readonly ModelingFeedback[];
  promptTemplateVersion: string;
  skill: SkillIdentity;
  /** Identifier of the Agent runtime / model configuration used. */
  agentConfigId: string;
  createdAt: string;
}

/**
 * Structured failure classification for Runs. `CLARIFICATION_REQUIRED` is a
 * business outcome, not a failure, and therefore never appears here.
 */
export const RUN_FAILURE_CODES = [
  "INPUT_UNSUPPORTED",
  "INPUT_ADAPTER_FAILED",
  "PREFLIGHT_FAILED",
  "AGENT_RUNTIME_UNAVAILABLE",
  "AGENT_PROTOCOL_INCOMPATIBLE",
  "SKILL_NOT_FOUND",
  "SKILL_HASH_MISMATCH",
  "SKILL_DEPENDENCY_UNRESOLVED",
  "SOLIDWORKS_VERSION_UNSUPPORTED",
  "SOLIDWORKS_UNAVAILABLE",
  "CLARIFICATION_REQUIRED",
  "AGENT_INTERRUPTED",
  "AGENT_TIMEOUT",
  "ARTIFACT_MANIFEST_INVALID",
  "ARTIFACT_MISSING",
  "ARTIFACT_OUTSIDE_WORKSPACE",
  "VALIDATION_REJECTED",
  "CANCEL_CLEANUP_PENDING",
  "RECOVERY_UNSUPPORTED",
  "RECOVERY_FAILED"
] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

/**
 * A single automatic modeling attempt bound forever to the Drawing Revision
 * frozen in `inputSnapshot`. A Run is an execution record, not the model itself.
 */
export interface ModelingRun {
  id: string;
  /** Business sequence label, e.g. R01 / R02 / R03. */
  number: string;
  drawingId: string;
  revisionId: string;
  status: RunStatus;
  /** User-visible stage, null before execution starts or after it ends. */
  stage: RunStage | null;
  inputSnapshot: RunInputSnapshot;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failureCode?: RunFailureCode;
  failureMessage?: string;
  /** Set when the Run terminates with `CLARIFICATION_REQUIRED`. */
  clarificationRequestId?: string;
  /** Set when the Run completes and publishes a Model. */
  modelId?: string;
}
