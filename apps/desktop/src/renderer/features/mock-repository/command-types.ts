import type {
  ClarificationAnswer,
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  CostEstimateResult,
  RevisionFact,
  StorageSettings
} from "@swpanel/domain";

/** User-selected source file before the repository mints its stable identity. */
export interface NewSourceFileInput {
  fileName: string;
  format: "PDF" | "DWG" | "DXF";
  sizeBytes: number;
  sha256: string;
}

/** Input to create a Drawing together with its first Revision (canonical `drawing.create`). */
export interface CreateDrawingInput {
  drawingNumber: string;
  name: string;
  sourceFile: NewSourceFileInput;
  createdAt: string;
  createdBy?: string;
}

/** Input to append a new Revision to an existing Drawing (canonical `drawing.createRevision`). */
export interface CreateRevisionInput {
  drawingId: string;
  sourceFile: NewSourceFileInput;
  createdAt: string;
}

/** Input to atomically repoint the Drawing's current Revision (canonical `drawing.setCurrentRevision`). */
export interface SetCurrentRevisionInput {
  drawingId: string;
  revisionId: string;
  updatedAt: string;
}

/** Input to conservatively delete a NON-current Revision (canonical `drawing.deleteRevision`). */
export interface DeleteRevisionInput {
  drawingId: string;
  revisionId: string;
  updatedAt: string;
}

/** Input to append an authoritative Revision Fact (canonical `drawing.addRevisionFact`). */
export interface AddRevisionFactInput {
  drawingId: string;
  revisionId: string;
  field: string;
  value: string;
  unit?: string;
  source: RevisionFact["source"];
  sourceRunId?: string;
  createdAt: string;
  createdBy?: string;
}

/** Input to append Modeling Feedback (canonical `drawing.addModelingFeedback`). */
export interface AddModelingFeedbackInput {
  drawingId: string;
  revisionId: string;
  content: string;
  createdAt: string;
}

/** Input to create a new Modeling Run for a Drawing Revision (canonical
 * `@swpanel/contracts` command `run.create`). The caller submits ONLY the
 * identity pair; the repository (standing in for the Runner) freezes the
 * immutable execution input from its own memory, exactly like the Runner
 * transaction. */
export interface CreateRunInput {
  drawingId: string;
  revisionId: string;
}

/** Input to actively cancel a QUEUED or RUNNING Run. */
export interface CancelRunInput {
  runId: string;
  reason?: string;
}

/**
 * Input to submit answers to an open Clarification Request. Answers are
 * already-constructed `ClarificationAnswer` records (canonical `clarification.submit`).
 */
export interface SubmitClarificationInput {
  clarificationRequestId: string;
  answers: readonly ClarificationAnswer[];
  answeredAt: string;
  answeredBy: string;
}

/** Unified approve/reject review input (canonical `model.review`). */
export interface ReviewModelInput {
  modelId: string;
  result: "APPROVED" | "REJECTED";
  /** Required when `result` is REJECTED. */
  comment?: string;
  reviewerId: string;
  reviewedAt: string;
}

/** Full replacement of the effective Cost Data snapshot (canonical `costData.update`). */
export interface UpdateCostDataInput {
  snapshot: CostDataSnapshot;
  updatedAt: string;
}

/** Immutable input + result captured for one report generation (canonical `costReport.create`). */
export interface CreateCostReportInput {
  drawingId: string;
  revisionId: string;
  modelId: string;
  inputSnapshot: CostEstimateInputSnapshot;
  result: CostEstimateResult;
  createdAt: string;
}

/** Full replacement of the persisted storage settings (canonical `storage.updateSettings`). */
export interface UpdateStorageSettingsInput {
  settings: StorageSettings;
}

/**
 * Input to delete ONE terminal Modeling Run (canonical `run.delete`). The Run
 * plus its owning drawing/revision identity pair are named so the deletion stays
 * scoped to the exact owning revision. Mock-side status guard: only COMPLETED /
 * FAILED / CANCELLED runs are deletable (mirrors the product UI + Runner guard).
 */
export interface DeleteRunInput {
  runId: string;
  drawingId: string;
  revisionId: string;
}

/** Input to delete ONE Cost Estimate Report of its owning Revision (canonical `costReport.delete`). */
export interface DeleteCostReportInput {
  costReportId: string;
  revisionId: string;
}

/** Discriminated union of every command accepted by the Mock Repository. */
export type MockCommand =
  | { kind: "createDrawing"; input: CreateDrawingInput }
  | { kind: "createRevision"; input: CreateRevisionInput }
  | { kind: "setCurrentRevision"; input: SetCurrentRevisionInput }
  | { kind: "deleteRevision"; input: DeleteRevisionInput }
  | { kind: "addRevisionFact"; input: AddRevisionFactInput }
  | { kind: "addModelingFeedback"; input: AddModelingFeedbackInput }
  | { kind: "createRun"; input: CreateRunInput }
  | { kind: "cancelRun"; input: CancelRunInput }
  | { kind: "deleteRun"; input: DeleteRunInput }
  | { kind: "submitClarification"; input: SubmitClarificationInput }
  | { kind: "reviewModel"; input: ReviewModelInput }
  | { kind: "updateCostData"; input: UpdateCostDataInput }
  | { kind: "createCostReport"; input: CreateCostReportInput }
  | { kind: "deleteCostReport"; input: DeleteCostReportInput }
  | { kind: "updateStorageSettings"; input: UpdateStorageSettingsInput };

/** Result of command preparation: either field-level problems or a clean command. */
export type PrepareResult =
  | { problems: readonly string[] }
  | { command: MockCommand };
