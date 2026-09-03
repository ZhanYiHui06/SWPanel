import type {
  IpcRequestEnvelope,
  IpcResponseEnvelope,
  QueryName
} from "@swpanel/contracts";
import { IPC_PROTOCOL_VERSION } from "@swpanel/contracts";
import type {
  ClarificationAnswer,
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  ModelReviewResult
} from "@swpanel/domain";

import {
  RunnerError,
  UnsupportedPhaseOperationError
} from "../errors.js";
import type { Runner } from "../runner.js";

  /**
   * Maps validated IPC requests to the Runner application service and repository
   * reads. Queries resolve to aggregate views; commands mutate through the
   * DrawingWorkflowService and the Run application surface. There is no generic
   * command endpoint: every operation is dispatched explicitly and unknown/
   * later-phase operations fail with a structured `UNSUPPORTED_PHASE_OPERATION`
   * error. Command payloads referencing a source file resolve the sha256 through
   * the Runner's registered-file table (absolute paths never travel over the
   * wire).
   *
   * Phase 3 (P3-4) adds the real Run surface: `run.create` (Runner-owned frozen
   * snapshot, then the serial Fake Executor queue is woken), `run.cancel`,
   * `run.getDetail`, `run.list`, the Drawing/dashboard Run reads that already
   * exist in the query contract, and `clarification.get` / `clarification.submit`
   * (answers persist on the terminal CLARIFICATION_REQUIRED Run; the Run is never
   * resumed). Phase 6 adds the real Model surface: `model.review` and
   * `model.getDetail`. Phase 8 adds the deletion surface: `run.delete`
   * (guarded terminal Run deletion with workspace cleanup), `costReport.delete`
   * and `system.getRecoveryStatus` (the latest recovery-scan summary). Only
   * `model.openInSolidWorks` stays unsupported.
   */

export interface IpcRequestHandler {
  handle(request: IpcRequestEnvelope): Promise<IpcResponseEnvelope>;
}

/** Discriminated-union payload of a validated command envelope. */
type CommandPayload = Record<string, unknown>;

/** Structured error code used when a handler fails outside the Runner error surface. */
const INTERNAL_ERROR_CODE = "INTERNAL_ERROR" as const;

export class RunnerRequestHandler implements IpcRequestHandler {
  constructor(private readonly runner: Runner) {}

  /**
   * Dispatches one validated envelope. Queries resolve to aggregate views and
   * commands mutate through the application service; commands that await the
   * async cancel coordination resolve asynchronously. All failures (including
   * the Runner's structured error surface) map to a stable
   * `{ code, message }` pair on the response envelope.
   */
  async handle(request: IpcRequestEnvelope): Promise<IpcResponseEnvelope> {
    try {
      const data =
        request.channel === "query" ? this.handleQuery(request) : this.handleCommand(request);
      return {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        data: await data
      };
    } catch (error) {
      return {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: this.toStructuredError(error)
      };
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private handleQuery(request: IpcRequestEnvelope): unknown {
    const operation = request.operation as QueryName;
    const payload = request.payload as Record<string, unknown>;
    switch (operation) {
      case "drawing.getDetail":
        return this.runner.getDrawingDetail(payload.drawingId as string);
      case "drawing.getHistory":
        return this.runner.getDrawingHistory(payload.drawingId as string);
      case "revision.getDetail":
        return this.runner.getRevisionDetail(
          payload.drawingId as string,
          payload.revisionId as string
        );
      case "revision.getHistory":
        return this.runner.getRevisionHistory(
          payload.drawingId as string,
          payload.revisionId as string
        );
      case "run.getDetail":
        return this.runner.getRunDetail(payload.runId as string);
      case "run.list":
        // Workspace-wide Run list (newest first); Drawing-scoped Run lists are
        // served by `revision.getDetail` and the dashboard by
        // `workspace.getDashboard`, exactly as the existing query contract
        // defines them.
        return this.runner.getRunList();
      case "model.getDetail":
        // Phase 6: real Model reads are served through the Model workflow
        // service (aggregate head, published artifacts, review history).
        return this.runner.getModelDetail(payload.modelId as string);
      case "clarification.get":
        return this.runner.getClarificationView(payload.clarificationRequestId as string);
      case "costReport.getDetail":
        return this.runner.getCostReportDetail(payload.costReportId as string);
      case "costReport.listByRevision":
        return this.runner.listCostReportsByRevision(payload.drawingId as string, payload.revisionId as string);
      case "workspace.getDashboard":
        return {
          ...this.runner.getWorkspaceDashboard(),
          recentDrawings: this.runner.getDrawingList()
        };
      case "costData.get":
        return this.runner.getEffectiveCostData();
      case "storage.getSettings":
        return this.runner.getStorageSettings();
      default:
        throw new UnsupportedPhaseOperationError(
          `Query ${String(operation)} is not implemented by the Runner in this phase`
        );
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private handleCommand(request: IpcRequestEnvelope): unknown {
    const operation = request.operation;
    const payload = request.payload as CommandPayload;
    switch (operation) {
      case "drawing.create": {
        const source = payload.sourceFile as {
          fileName: string;
          format: "PDF" | "DWG" | "DXF";
          sizeBytes: number;
          sha256: string;
        };
        const sourcePath = this.runner.assertRegisteredSourceFile(source.sha256);
        return this.runner.importDrawing({
          drawingNumber: payload.drawingNumber as string,
          name: payload.name as string,
          sourceFile: {
            sourcePath,
            fileName: source.fileName,
            format: source.format,
            sizeBytes: source.sizeBytes,
            sha256: source.sha256,
            uploadedAt: payload.createdAt as string
          },
          createdAt: payload.createdAt as string,
          ...(payload.createdBy === undefined
            ? {}
            : { createdBy: payload.createdBy as string })
        });
      }
      case "drawing.createRevision": {
        const source = payload.sourceFile as {
          fileName: string;
          format: "PDF" | "DWG" | "DXF";
          sizeBytes: number;
          sha256: string;
        };
        const sourcePath = this.runner.assertRegisteredSourceFile(source.sha256);
        return this.runner.addRevision({
          drawingId: payload.drawingId as string,
          sourceFile: {
            sourcePath,
            fileName: source.fileName,
            format: source.format,
            sizeBytes: source.sizeBytes,
            sha256: source.sha256,
            uploadedAt: payload.createdAt as string
          },
          createdAt: payload.createdAt as string
        });
      }
      case "drawing.setCurrentRevision":
        return this.runner.setCurrentRevision({
          drawingId: payload.drawingId as string,
          revisionId: payload.revisionId as string,
          updatedAt: payload.updatedAt as string
        });
      case "drawing.deleteRevision":
        return this.runner.deleteRevision({
          drawingId: payload.drawingId as string,
          revisionId: payload.revisionId as string,
          updatedAt: payload.updatedAt as string
        });
      case "drawing.addRevisionFact":
        return this.runner.addRevisionFact({
          drawingId: payload.drawingId as string,
          revisionId: payload.revisionId as string,
          field: payload.field as string,
          value: payload.value as string,
          ...(payload.unit === undefined ? {} : { unit: payload.unit as string }),
          source: payload.source as "USER_SUPPLEMENT" | "DRAWING_CONFIRMED" | "CLARIFICATION",
          ...(payload.sourceRunId === undefined
            ? {}
            : { sourceRunId: payload.sourceRunId as string }),
          createdAt: payload.createdAt as string,
          ...(payload.createdBy === undefined
            ? {}
            : { createdBy: payload.createdBy as string })
        });
      case "drawing.addModelingFeedback":
        return this.runner.addModelingFeedback({
          drawingId: payload.drawingId as string,
          revisionId: payload.revisionId as string,
          content: payload.content as string,
          createdAt: payload.createdAt as string
        });
      case "storage.updateSettings": {
        const settings = payload.settings as {
          dataRoot: string;
          workspaceRoot: string;
          constraint: "LOCAL_FIXED_NTFS";
          updatedAt: string;
        };
        this.runner.updateStorageSettings({
          dataRoot: settings.dataRoot,
          workspaceRoot: settings.workspaceRoot,
          constraint: settings.constraint,
          updatedAt: settings.updatedAt
        });
        return { settings: this.runner.getStorageSettings().settings };
      }
      case "run.create": {
        // The Renderer submitted ONLY the drawing/revision identity pair (the
        // envelope validator rejects any other field); the Runner freezes the
        // Input Snapshot inside the repository transaction.
        const run = this.runner.createRun({
          drawingId: payload.drawingId as string,
          revisionId: payload.revisionId as string
        });
        // P3-4: wake the serial Fake Executor queue so the freshly QUEUED Run
        // executes. `runQueue` is re-entrant (a running loop is reused), so
        // this is a safe wake-up; a queue-loop failure never fails the create
        // response — the Run is already durably persisted and recovery owns
        // the aftermath.
        void this.runner.runQueue().catch((error: unknown) => {
          void error;
        });
        return run;
      }
      case "run.cancel":
        // Asynchronous cancel coordination; resolves the structured
        // CancelRunResult (CANCELLED / CANCEL_CLEANUP_PENDING / CANCEL_PENDING).
        return this.runner.cancelRun(payload.runId as string, payload.reason as string | undefined);
      case "model.review":
        // Phase 6: human review of a PENDING_REVIEW Model (approve repoints the
        // Revision's approved-Model pointer; reject writes the comment into the
        // Revision's Modeling Feedback). The envelope validator already checked
        // the payload shape (result enum, canonical reviewedAt, required
        // comment on REJECTED, no unknown keys).
        return this.runner.reviewModel({
          modelId: payload.modelId as string,
          result: payload.result as ModelReviewResult,
          ...(payload.comment === undefined ? {} : { comment: payload.comment as string }),
          reviewerId: payload.reviewerId as string,
          reviewedAt: payload.reviewedAt as string
        });
      case "clarification.submit": {
        const answers = payload.answers as readonly ClarificationAnswer[];
        return this.runner.submitClarificationAnswers({
          clarificationRequestId: payload.clarificationRequestId as string,
          answers,
          answeredAt: payload.answeredAt as string,
          answeredBy: payload.answeredBy as string
        });
      }
      case "costData.update":
        return this.runner.updateCostData(payload.snapshot as CostDataSnapshot);
      case "costReport.create":
        return this.runner.createCostReport(
          payload.input as CostEstimateInputSnapshot,
          payload.createdAt as string
        );
      case "run.delete":
        // Phase 8: guarded terminal Run deletion. The payload names the Run
        // plus its owning drawing/revision identity pair (the envelope
        // validator already checked the shape).
        return this.runner.deleteRun(
          payload.runId as string,
          payload.drawingId as string,
          payload.revisionId as string
        );
      case "costReport.delete":
        // Phase 8: deletes ONE Cost Estimate Report of its owning Revision.
        return this.runner.deleteCostReport(
          payload.costReportId as string,
          payload.revisionId as string
        );
      case "system.getRecoveryStatus":
        // Phase 8: the summary of the most recent recovery scan (null when no
        // scan has run yet).
        return this.runner.getRecoveryStatus();
      default:
        // model.openInSolidWorks lands with its phase; the Runner never
        // executes it silently.
        throw new UnsupportedPhaseOperationError(
          `Command ${String(operation)} is not implemented by the Runner in this phase`,
          { operation }
        );
    }
  }

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  private toStructuredError(error: unknown): { code: string; message: string } {
    if (error instanceof RunnerError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof Error) {
      return { code: INTERNAL_ERROR_CODE, message: error.message };
    }
    return { code: INTERNAL_ERROR_CODE, message: String(error) };
  }
}
