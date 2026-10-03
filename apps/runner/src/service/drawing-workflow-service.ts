import type {
  Drawing,
  DrawingRevision,
  ModelingFeedback,
  RevisionFact,
  RevisionSourceFile
} from "@swpanel/domain";
import { canSetCurrentRevision, canDeleteRevision, nextRevisionSequence } from "@swpanel/domain";
import type { DrawingHistoryView, RevisionHistoryView } from "@swpanel/contracts";
import { existsSync } from "node:fs";

import { generateId } from "../ids.js";
import {
  EntityConflictError,
  InvalidArgumentError,
  NotFoundError,
  RunnerInvariantError
} from "../errors.js";
import { DrawingFileLedger } from "../ledger/drawing-file-ledger.js";
import { SqliteRepository } from "../db/repository.js";
import { RunRepository } from "../db/run-repository.js";

/** File-library input shared by Drawing import and new Revision creation. */
export interface SourceFileImport {
  /** Absolute path of the file on the user's machine to copy into the ledger. */
  sourcePath: string;
  /** Display file name preserved in metadata (may be a Unicode name). */
  fileName: string;
  format: "PDF" | "DWG" | "DXF";
  /** Optional precomputed digest; when absent the ledger computes it from bytes. */
  sha256?: string;
  /** Optional precomputed size; when absent the ledger reads it from bytes. */
  sizeBytes?: number;
  mimeType?: string;
  uploadedAt: string;
}

export interface ImportDrawingInput {
  drawingNumber: string;
  name: string;
  sourceFile: SourceFileImport;
  createdAt: string;
  createdBy?: string;
}

export interface AddRevisionInput {
  drawingId: string;
  sourceFile: SourceFileImport;
  createdAt: string;
}

export interface SetCurrentRevisionInput {
  drawingId: string;
  revisionId: string;
  updatedAt: string;
}

export interface DeleteRevisionInput {
  drawingId: string;
  revisionId: string;
  updatedAt: string;
}

export interface DeleteRevisionResult {
  drawing: Drawing;
  deletedRevisionId: string;
  /** Present only when the source file could not be removed yet (retried later). */
  cleanupWarnings?: string[];
}

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

export interface AddModelingFeedbackInput {
  drawingId: string;
  revisionId: string;
  content: string;
  createdAt: string;
}

export interface ImportDrawingResult {
  drawing: Drawing;
  revision: DrawingRevision;
  sourceFile: RevisionSourceFile;
}

export interface AddRevisionResult {
  revision: DrawingRevision;
  sourceFile: RevisionSourceFile;
}

/**
 * Phase 2 Drawing workflow application service (WP3). Implements the full
 * user-managed drawing workflow without any Agent involvement:
 *
 * 1. import a new Drawing with its first Revision and an atomic current pointer,
 * 2. add a Revision,
 * 3. atomically switch the current Revision,
 * 4. append Revision Facts and USER_SUPPLEMENT Modeling Feedback,
 * 5. read Drawing / Revision history.
 *
 * Uploading or creating a Drawing never creates a Modeling Run (that is the
 * explicit `run.create` path of Phase 3). Every mutation is transactional; when
 * the database commit fails, the ledger file written in the same use case is
 * removed as compensation.
 */
export class DrawingWorkflowService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly ledger: DrawingFileLedger,
    private readonly runs: RunRepository,
    /** Server clock (injectable for tests). */
    private readonly now: () => Date = () => new Date()
  ) {}

  // -------------------------------------------------------------------------
  // Drawing workflow use cases
  // -------------------------------------------------------------------------

  /** Imports a new Drawing with its first Revision and current pointer atomically. */
  importDrawing(input: ImportDrawingInput): ImportDrawingResult {
    if (typeof input.drawingNumber !== "string" || input.drawingNumber.trim().length === 0) {
      throw new InvalidArgumentError("drawingNumber must be a non-empty string");
    }
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new InvalidArgumentError("name must be a non-empty string");
    }
    const stored = this.storeFile(input.sourceFile);
    try {
      return this.repository.transaction(() => {
        const existing = this.repository.getDrawingByNumber(input.drawingNumber);
        if (existing !== null) {
          throw new EntityConflictError(
            `A Drawing with number ${input.drawingNumber} already exists`,
            { drawingNumber: input.drawingNumber }
          );
        }
        const now = input.createdAt;
        const drawingId = generateId();
        const revisionId = generateId();
        const sourceFile = this.ledger.toRevisionSourceFile(stored, input.sourceFile);
        // `current_revision_id` references drawing_revisions and the revision
        // references drawings: the pointer is written after both rows, inside
        // the same transaction, so the Drawing is never observable without a
        // current Revision.
        const drawing: Drawing = {
          id: drawingId,
          drawingNumber: input.drawingNumber,
          name: input.name,
          currentRevisionId: null,
          createdAt: now,
          updatedAt: now
        };
        const revision: DrawingRevision = {
          id: revisionId,
          drawingId,
          sequence: 1,
          sourceFile,
          currentApprovedModelId: null,
          createdAt: now,
          updatedAt: now
        };
        this.repository.insertDrawing(drawing);
        this.repository.insertRevisionFile(sourceFile);
        this.repository.insertRevision(revision);
        // The first Revision is the current one; the pointer is written in the
        // same transaction so the Drawing is never observable without a current.
        this.repository.setCurrentRevisionPointer(drawingId, revisionId, now);
        return {
          drawing: { ...drawing, currentRevisionId: revisionId },
          revision,
          sourceFile
        };
      });
    } catch (error) {
      // DB failure (duplicate number, I/O, invariant): compensate the file.
      this.compensateStoredFile(stored.relativePath);
      throw error;
    }
  }

  /** Adds a new Revision to an existing Drawing without touching the current pointer. */
  addRevision(input: AddRevisionInput): AddRevisionResult {
    const stored = this.storeFile(input.sourceFile);
    try {
      return this.repository.transaction(() => {
        const drawing = this.repository.getDrawing(input.drawingId);
        if (drawing === null) {
          throw new NotFoundError(`Drawing ${input.drawingId} was not found`, {
            drawingId: input.drawingId
          });
        }
        const sequences = this.repository.getRevisionSequences(drawing.id);
        const sequence = nextRevisionSequence(sequences.map((sequence) => ({ sequence })));
        const sourceFile = this.ledger.toRevisionSourceFile(stored, input.sourceFile);
        const revisionId = generateId();
        const revision: DrawingRevision = {
          id: revisionId,
          drawingId: drawing.id,
          sequence,
          sourceFile,
          currentApprovedModelId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt
        };
        this.repository.insertRevisionFile(sourceFile);
        this.repository.insertRevision(revision);
        this.repository.touchDrawing(drawing.id, input.createdAt);
        return { revision, sourceFile };
      });
    } catch (error) {
      this.compensateStoredFile(stored.relativePath);
      throw error;
    }
  }

  /** Atomically repoints the Drawing's current Revision (metadata-only transition). */
  setCurrentRevision(input: SetCurrentRevisionInput): Drawing {
    return this.repository.transaction(() => {
      const drawing = this.repository.getDrawing(input.drawingId);
      if (drawing === null) {
        throw new NotFoundError(`Drawing ${input.drawingId} was not found`, {
          drawingId: input.drawingId
        });
      }
      const revision = this.repository.getRevision(input.revisionId);
      if (revision === null) {
        throw new NotFoundError(`Revision ${input.revisionId} was not found`, {
          revisionId: input.revisionId
        });
      }
      if (!canSetCurrentRevision(drawing, revision)) {
        throw new RunnerInvariantError(
          `Revision ${input.revisionId} does not belong to Drawing ${input.drawingId}`
        );
      }
      this.repository.setCurrentRevisionPointer(drawing.id, revision.id, input.updatedAt);
      return { ...drawing, currentRevisionId: revision.id, updatedAt: input.updatedAt };
    });
  }

  /**
   * Conservative Revision deletion policy (Phase 2 review fix, Phase 8 cascade
   * guard):
   *
   * - the CURRENT Revision is never deletable (the current pointer is a
   *   domain invariant; the caller must repoint it first);
   * - a non-current Revision is deletable only when NOTHING still depends on
   *   it — no Modeling Runs, no Models and no Cost Estimate Reports. The
   *   `canDeleteRevision` domain guard is consulted inside the transaction and
   *   the deletion is rejected with a structured `DOMAIN_INVARIANT` error (and
   *   the canonical blocking dependency list) when any dependency exists;
   * - the DB metadata (facts, feedback, revision, source-file row) is removed
   *   inside ONE transaction, so the Revision disappears atomically;
   * - afterwards only the OWNED allowlisted ledger file is removed (via the
   *   conservative single-file `deleteOwnedFile` helper — never a broad
   *   recursive deletion);
   * - an already-missing ledger file is treated as "already gone"; any other
   *   ledger failure is NOT surfaced (the DB is committed): the cleanup intent
   *   is persisted in the shared `business_deletion_cleanup` queue, retried
   *   later, and a `cleanupWarnings` entry is returned.
   *
   * Whole-Drawing deletion is deliberately NOT implemented in this phase.
   */
  deleteRevision(input: DeleteRevisionInput): DeleteRevisionResult {
    const deleted = this.repository.transaction(() => {
      const drawing = this.repository.getDrawing(input.drawingId);
      if (drawing === null) {
        throw new NotFoundError(`Drawing ${input.drawingId} was not found`, {
          drawingId: input.drawingId
        });
      }
      const revision = this.repository.getRevision(input.revisionId);
      if (revision === null) {
        throw new NotFoundError(`Revision ${input.revisionId} was not found`, {
          revisionId: input.revisionId
        });
      }
      if (revision.drawingId !== drawing.id) {
        throw new RunnerInvariantError(
          `Revision ${input.revisionId} does not belong to Drawing ${input.drawingId}`
        );
      }
      // Cascade protection: the domain guard blocks the deletion when Runs,
      // Models or Cost Reports still depend on this Revision (and when the
      // Revision is the current pointer). The blockers are surfaced verbatim
      // so the caller can present them ahead of a forced delete.
      const decision = canDeleteRevision({
        isCurrentRevision: drawing.currentRevisionId === revision.id,
        hasRuns: this.runs.listRunItemsByRevision(revision.id).length > 0,
        hasModels: this.runs.listModelsByRevision(revision.id).length > 0,
        hasCostReports: this.repository.listCostReportsByRevision(drawing.id, revision.id).length > 0
      });
      if (!decision.canDelete) {
        const blockers = decision.blockingDependencies ?? [];
        const hint = blockers.includes("CURRENT_REVISION")
          ? "switch the current Revision first"
          : "delete or resolve the dependent Runs, Models or Cost Reports first";
        throw new RunnerInvariantError(
          `Revision ${input.revisionId} of Drawing ${input.drawingId} cannot be deleted: ` +
            `${decision.reason ?? "REVISION_HAS_DEPENDENCIES"} (${blockers.join(", ")}) — ${hint}`,
          {
            drawingId: input.drawingId,
            revisionId: input.revisionId,
            reason: decision.reason,
            blockingDependencies: blockers
          }
        );
      }
      this.repository.deleteRevisionRecords(revision.id, revision.sourceFile.id);
      this.repository.touchDrawing(drawing.id, input.updatedAt);
      // Durable cleanup intent, committed atomically with the deletion.
      this.repository.enqueueSourceCleanup(revision.sourceFile.relativePath, this.now().toISOString());
      return {
        drawing: { ...drawing, updatedAt: input.updatedAt },
        deletedRevisionId: revision.id,
        sourceFileRelativePath: revision.sourceFile.relativePath
      };
    });
    // The DB deletion is already committed: a file failure must never turn it
    // into a client-visible error. The intent stays queued and is retried by
    // the business-deletion cleanup (on open and on later deletions).
    try {
      this.deleteOwnedSourceFileIfPresent(deleted.sourceFileRelativePath);
      this.repository.dequeueSourceCleanup(deleted.sourceFileRelativePath, this.now().toISOString());
    } catch {
      return {
        drawing: deleted.drawing,
        deletedRevisionId: deleted.deletedRevisionId,
        cleanupWarnings: ["原文件清理稍后重试；版本记录已删除。"]
      };
    }
    return { drawing: deleted.drawing, deletedRevisionId: deleted.deletedRevisionId };
  }

  /** Appends an authoritative engineering Fact to a Revision's memory. */
  addRevisionFact(input: AddRevisionFactInput): RevisionFact {
    if (typeof input.field !== "string" || input.field.trim().length === 0) {
      throw new InvalidArgumentError("field must be a non-empty string");
    }
    if (typeof input.value !== "string" || input.value.trim().length === 0) {
      throw new InvalidArgumentError("value must be a non-empty string");
    }
    return this.repository.transaction(() => {
      this.assertRevisionOwnedByDrawing(input.drawingId, input.revisionId);
      const fact: RevisionFact = {
        id: generateId(),
        revisionId: input.revisionId,
        field: input.field,
        value: input.value,
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        source: input.source,
        ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
        // BE-03: the server clock is authoritative; a client value is ignored.
        createdAt: this.now().toISOString(),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy })
      };
      this.repository.insertRevisionFact(fact);
      return fact;
    });
  }

  /** Appends reviewer-typed modeling experience; always `USER_SUPPLEMENT`. */
  addModelingFeedback(input: AddModelingFeedbackInput): ModelingFeedback {
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      throw new InvalidArgumentError("content must be a non-empty string");
    }
    return this.repository.transaction(() => {
      this.assertRevisionOwnedByDrawing(input.drawingId, input.revisionId);
      const feedback: ModelingFeedback = {
        id: generateId(),
        revisionId: input.revisionId,
        content: input.content,
        source: "USER_SUPPLEMENT",
        createdAt: this.now().toISOString()
      };
      this.repository.insertModelingFeedback(feedback);
      return feedback;
    });
  }

  // -------------------------------------------------------------------------
  // History reads (delegated to the reader surface)
  // -------------------------------------------------------------------------

  getDrawingHistory(drawingId: string): DrawingHistoryView {
    return this.repository.getDrawingHistory(drawingId);
  }

  getRevisionHistory(drawingId: string, revisionId: string): RevisionHistoryView {
    return this.repository.getRevisionHistory(drawingId, revisionId);
  }

  /** Number of Modeling Runs persisted; must stay 0 for this workflow slice. */
  getRunCount(): number {
    return this.repository.countRuns();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private storeFile(input: SourceFileImport): ReturnType<DrawingFileLedger["storeSourceFile"]> {
    return this.ledger.storeSourceFile({
      fileName: input.fileName,
      format: input.format,
      ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      uploadedAt: input.uploadedAt,
      sourcePath: input.sourcePath
    });
  }

  private compensateStoredFile(relativePath: string): void {
    try {
      this.ledger.deleteOwnedFile(relativePath);
    } catch {
      // Best-effort compensation: the DB is the source of truth, the ledger
      // file must never become an orphan. Failures here are surfaced by the
      // original DB error already being rethrown.
    }
  }

  /**
   * Deletes the single owned allowlisted source file of a deleted Revision.
   * A file that is already missing is "already gone" (the deletion intent is
   * satisfied); any other ledger failure is rethrown as a structured error.
   */
  private deleteOwnedSourceFileIfPresent(relativePath: string): void {
    const absolutePath = this.ledger.toAbsolute(relativePath);
    if (!existsSync(absolutePath)) return;
    this.ledger.deleteOwnedFile(relativePath);
  }

  private assertRevisionOwnedByDrawing(drawingId: string, revisionId: string): void {
    const drawing = this.repository.getDrawing(drawingId);
    if (drawing === null) {
      throw new NotFoundError(`Drawing ${drawingId} was not found`, { drawingId });
    }
    const revision = this.repository.getRevision(revisionId);
    if (revision === null) {
      throw new NotFoundError(`Revision ${revisionId} was not found`, { revisionId });
    }
    if (revision.drawingId !== drawing.id) {
      throw new RunnerInvariantError(
        `Revision ${revisionId} does not belong to Drawing ${drawingId}`
      );
    }
  }
}
