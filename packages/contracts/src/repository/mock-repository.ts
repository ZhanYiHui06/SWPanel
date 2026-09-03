import type {
  ClarificationAnswer,
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  CostEstimateResult,
  Drawing,
  DrawingRevision,
  ModelingRun,
  Model,
  ModelReview,
  RevisionFact,
  StorageSettings
} from "@swpanel/domain";
import type { RepositoryReader, RepositoryWriter } from "./ports.js";

/**
 * Contract of the Phase 1 in-memory Mock Repository. It extends the reader and
 * writer ports and adds the high-level domain transitions the UI exercises:
 * the Drawing management workflow (create Drawing/Revision, atomically switch
 * the current Revision, append Revision Facts and Modeling Feedback), create
 * run, cancel run, submit clarification, review model, update cost data,
 * generate a cost estimate report and update the storage settings.
 *
 * Every mutation enforces the domain invariants from `@swpanel/domain`
 * (illegal transitions, cost eligibility, terminal clarification, rejected
 * model irreversibility, current-Revision ownership) and throws
 * `DomainInvariantError` on violation.
 *
 * Creating a Drawing or Revision never creates a Modeling Run: only the
 * explicit `createRun` command starts a Run, so uploading drawings stays a pure
 * file-library/metadata workflow without any implicit Agent execution.
 */
export interface MockRepository extends RepositoryReader, RepositoryWriter {
  createDrawing(input: {
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
  }): { drawing: Drawing; revision: DrawingRevision };
  createRevision(input: {
    drawingId: string;
    sourceFile: {
      fileName: string;
      format: "PDF" | "DWG" | "DXF";
      sizeBytes: number;
      sha256: string;
    };
    createdAt: string;
  }): DrawingRevision;
  setCurrentRevision(input: { drawingId: string; revisionId: string; updatedAt: string }): Drawing;
  createRevisionFact(input: {
    drawingId: string;
    revisionId: string;
    field: string;
    value: string;
    unit?: string;
    source: RevisionFact["source"];
    sourceRunId?: string;
    createdAt: string;
    createdBy?: string;
  }): RevisionFact;
  createModelingFeedback(input: {
    drawingId: string;
    revisionId: string;
    content: string;
    createdAt: string;
  }): void;
  createRun(input: {
    drawingId: string;
    revisionId: string;
  }): ModelingRun;
  cancelRun(runId: string, reason?: string): ModelingRun;
  submitClarification(input: {
    clarificationRequestId: string;
    answers: readonly ClarificationAnswer[];
    answeredAt: string;
    answeredBy: string;
  }): void;
  reviewModel(input: {
    modelId: string;
    result: ModelReview["result"];
    comment?: string;
    reviewerId: string;
    reviewedAt: string;
  }): Model;
  updateCostData(snapshot: CostDataSnapshot, updatedAt: string): void;
  createCostReport(input: {
    drawingId: string;
    revisionId: string;
    modelId: string;
    inputSnapshot: CostEstimateInputSnapshot;
    result: CostEstimateResult;
    createdAt: string;
  }): string;
  updateStorageSettings(settings: StorageSettings): void;
}
