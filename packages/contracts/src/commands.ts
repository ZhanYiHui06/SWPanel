import type {
  ClarificationAnswer,
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  ModelReviewResult,
  RecoveryStatusSummary,
  RevisionFact,
  StorageSettings
} from "@swpanel/domain";

/**
 * Canonical business commands understood by the Phase 1 Mock Repository and
 * later by the Runner IPC boundary. Names are stable identifiers, not free-form
 * method names, and there is no generic command execution endpoint.
 *
 * Uploading or creating a Drawing never creates a Modeling Run. Runs are only
 * ever created by the explicit `run.create` command; the drawing management
 * commands below stay pure metadata/file-library transitions.
 */
export const COMMAND_NAMES = [
  "drawing.create",
  "drawing.createRevision",
  "drawing.setCurrentRevision",
  "drawing.addRevisionFact",
  "drawing.addModelingFeedback",
  "drawing.deleteRevision",
  "run.create",
  "run.cancel",
  "run.delete",
  "clarification.submit",
  "model.review",
  "model.openInSolidWorks",
  "costData.update",
  "costReport.create",
  "costReport.delete",
  "storage.updateSettings",
  "secrets.setApiKey",
  "secrets.getApiKeyStatus",
  "secrets.clearApiKey",
  "system.getRecoveryStatus"
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/**
 * The source file picked by the user before the first Revision is created. The
 * full `RevisionSourceFile` (stable id and relative library path) is minted by
 * the repository during file registration.
 */
export interface CreateDrawingCommand {
  command: "drawing.create";
  drawingNumber: string;
  name: string;
  sourceFile: {
    fileName: string;
    format: "PDF" | "DWG" | "DXF";
    sizeBytes: number;
    sha256: string;
  };
  createdAt: string;
  createdBy?: string;
}

export interface CreateRevisionCommand {
  command: "drawing.createRevision";
  drawingId: string;
  sourceFile: {
    fileName: string;
    format: "PDF" | "DWG" | "DXF";
    sizeBytes: number;
    sha256: string;
  };
  createdAt: string;
}

/**
 * Atomically repoints the Drawing's `current_revision_id`. The transition is
 * pure metadata: it never creates a Modeling Run and never rewrites the Run
 * input snapshot already frozen by existing Runs.
 */
export interface SetCurrentRevisionCommand {
  command: "drawing.setCurrentRevision";
  drawingId: string;
  revisionId: string;
  updatedAt: string;
}

export interface AddRevisionFactCommand {
  command: "drawing.addRevisionFact";
  drawingId: string;
  revisionId: string;
  field: string;
  value: string;
  unit?: string;
  source: RevisionFact["source"];
  /** Run that produced the fact, when applicable. */
  sourceRunId?: string;
  createdAt: string;
  createdBy?: string;
}

export interface AddModelingFeedbackCommand {
  command: "drawing.addModelingFeedback";
  drawingId: string;
  revisionId: string;
  content: string;
  createdAt: string;
}

export interface DeleteRevisionCommand {
  command: "drawing.deleteRevision";
  drawingId: string;
  revisionId: string;
  /** When the deletion happened (bumps the Drawing's `updated_at`). */
  updatedAt: string;
}

/**
 * Canonical `run.create` command. The Renderer submits ONLY the
 * drawing/revision identity pair: the Runner owns snapshot freezing. Inside
 * one transaction the Runner reads the Revision, stabilizes the original file
 * reference, captures the Facts and Modeling Feedback visible at that moment
 * and pins the prompt template version, Skill identity+hash and agent/model
 * config id from its own configuration. A client-supplied snapshot is never
 * trusted, so the command shape cannot carry one.
 */
export interface CreateRunCommand {
  command: "run.create";
  drawingId: string;
  revisionId: string;
}

export interface CancelRunCommand {
  command: "run.cancel";
  runId: string;
  reason?: string;
}

export interface DeleteRunCommand {
  command: "run.delete";
  runId: string;
  drawingId: string;
  revisionId: string;
}

export interface SubmitClarificationCommand {
  command: "clarification.submit";
  clarificationRequestId: string;
  answers: readonly ClarificationAnswer[];
  answeredAt: string;
  answeredBy: string;
}

export interface ReviewModelCommand {
  command: "model.review";
  modelId: string;
  result: ModelReviewResult;
  /** Required when `result` is REJECTED. */
  comment?: string;
  reviewerId: string;
  reviewedAt: string;
}

export interface OpenModelInSolidWorksCommand {
  command: "model.openInSolidWorks";
  modelId: string;
}

export interface UpdateCostDataCommand {
  command: "costData.update";
  /**
   * Full replacement of the effective company-global Cost Data snapshot,
   * including the snapshot-level maintenance instant `updatedAt` (persisted as
   * the `updated_at` of the stored cost_data_snapshots version). The command
   * carries no other top-level metadata: the snapshot is the whole payload
   * besides the discriminator.
   */
  snapshot: CostDataSnapshot & { updatedAt: string };
}

export interface CreateCostReportCommand {
  command: "costReport.create";
  /**
   * Immutable deterministic input of the estimate: drawing/revision/model
   * identity, confirmed quantity and stock/material parameters, allowances,
   * effective Cost Data snapshot and formula version. The `result` is NEVER
   * carried over the wire: the Runner derives it with the pure deterministic
   * calculator inside its own transaction, so an untrusted result can never be
   * forged or smuggled in.
   */
  input: CostEstimateInputSnapshot;
  createdAt: string;
}

export interface DeleteCostReportCommand {
  command: "costReport.delete";
  costReportId: string;
  revisionId: string;
}

export interface UpdateStorageSettingsCommand {
  command: "storage.updateSettings";
  settings: StorageSettings;
}

/**
 * Persists (or replaces) the company-global automation API key. The key is
 * secret: it is never returned by any command or query, only its presence and a
 * short masked preview are.
 */
export interface SetApiKeyCommand {
  command: "secrets.setApiKey";
  apiKey: string;
}

/** Reads whether an API key is stored. Empty payload besides the discriminator. */
export interface GetApiKeyStatusCommand {
  command: "secrets.getApiKeyStatus";
}

/** Removes any stored API key. Empty payload besides the discriminator. */
export interface ClearApiKeyCommand {
  command: "secrets.clearApiKey";
}

/** Reads the latest startup Run-recovery scan result. Empty payload besides the discriminator. */
export interface GetRecoveryStatusCommand {
  command: "system.getRecoveryStatus";
}

/** Response data of `secrets.getApiKeyStatus`. The key itself never leaves the Runner. */
export interface SecretApiKeyStatus {
  hasApiKey: boolean;
  /** Short masked preview (e.g. `sk-****abcd`) when a key is stored, else null. */
  maskedApiKey: string | null;
}

/**
 * Response data of `system.getRecoveryStatus`: the summary of the most recent
 * startup recovery scan, or null when no scan has run yet.
 */
export type RecoveryStatusResult = RecoveryStatusSummary | null;

export type Command =
  | CreateDrawingCommand
  | CreateRevisionCommand
  | SetCurrentRevisionCommand
  | AddRevisionFactCommand
  | AddModelingFeedbackCommand
  | DeleteRevisionCommand
  | CreateRunCommand
  | CancelRunCommand
  | DeleteRunCommand
  | SubmitClarificationCommand
  | ReviewModelCommand
  | OpenModelInSolidWorksCommand
  | UpdateCostDataCommand
  | CreateCostReportCommand
  | DeleteCostReportCommand
  | UpdateStorageSettingsCommand
  | SetApiKeyCommand
  | GetApiKeyStatusCommand
  | ClearApiKeyCommand
  | GetRecoveryStatusCommand;
