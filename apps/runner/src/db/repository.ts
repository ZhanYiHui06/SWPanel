import type {
  AllowanceDefinition,
  AllowanceValue,
  Artifact,
  ClarificationRequest,
  CostBasis,
  CostDataDefinition,
  CostDataSnapshot,
  CostEstimateReport,
  CostEstimateSnapshot,
  CustomCostField,
  Drawing,
  DrawingRevision,
  FixedCostValue,
  MaterialCostValue,
  ModelingFeedback,
  ModelingRun,
  ModelReview,
  Model,
  RevisionFact,
  RevisionSourceFile,
  RunEvent,
  StockType,
  StorageSettings
} from "@swpanel/domain";
import {
  revisionLabel,
  STORAGE_CONSTRAINTS,
  type DrawingFileFormat
} from "@swpanel/domain";
import type {
  CostReportDetailView,
  CostReportListItemView,
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  RevisionDetailView,
  RevisionHistoryView,
  RevisionListItemView,
  StorageSettingsView,
  WorkspaceDashboardView
} from "@swpanel/contracts";
import type { RepositoryReader, RepositoryWriter } from "@swpanel/contracts";

import { NotFoundError, UnsupportedPhaseOperationError } from "../errors.js";
import type { SqliteDatabase } from "./database.js";
import { SETTING_KEYS } from "./schema.js";

/** Detects a SQLite UNIQUE constraint violation from any error. */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

/** Structured payload read back from `cost_data_values.payload_json`. */
interface CostDataPayload {
  purchasePrice?: number;
  priceUnit?: string;
  density?: number;
  densityUnit?: string;
  effectiveFrom?: string;
  stockType?: StockType;
  allowances?: readonly AllowanceValue[];
  amount?: number;
  currency?: string;
  basis?: CostBasis;
  defaultEnabled?: boolean;
  value?: string;
  unit?: string;
}

/** Storage settings default used on first open of a data root. */
export interface StorageSettingsDefaults {
  dataRoot: string;
  workspaceRoot: string;
  updatedAt: string;
}

interface DrawingRow {
  id: string;
  drawing_number: string;
  name: string;
  current_revision_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RevisionFileRow {
  id: string;
  file_name: string;
  format: DrawingFileFormat;
  size_bytes: number;
  sha256: string;
  mime_type: string | null;
  relative_path: string;
  uploaded_at: string;
}

interface RevisionRow {
  id: string;
  drawing_id: string;
  sequence: number;
  source_file_id: string;
  current_approved_model_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RevisionFactRow {
  id: string;
  revision_id: string;
  field: string;
  value: string;
  unit: string | null;
  source: RevisionFact["source"];
  source_run_id: string | null;
  created_at: string;
  created_by: string | null;
}

interface ModelingFeedbackRow {
  id: string;
  revision_id: string;
  model_id: string | null;
  review_id: string | null;
  content: string;
  source: ModelingFeedback["source"];
  created_at: string;
}

interface CostDataDefinitionRow {
  id: string;
  key: string;
  name: string;
  kind: CostDataDefinition["kind"];
  semantics: CostDataDefinition["semantics"];
  updated_at: string;
}

interface CostDataValueRow {
  id: string;
  definition_id: string;
  payload_json: string;
  updated_at: string;
}

interface CostReportRow {
  id: string;
  label: string;
  drawing_id: string;
  revision_id: string;
  model_id: string;
  quantity: number;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
}

const CLEANUP_QUEUE_KEY = "business_deletion_cleanup";

/**
 * SQLite-backed implementation of the `RepositoryReader` / `RepositoryWriter`
 * ports plus the low-level persistence primitives the Drawing workflow service
 * composes inside transactions. Aggregate data this phase does not yet own
 * (Run / Model / Review / Cost) is never faked: reads throw `NotFoundError`
 * and writes throw `UnsupportedPhaseOperationError`.
 */
export class SqliteRepository implements RepositoryReader, RepositoryWriter {
  constructor(private readonly db: SqliteDatabase) {}

  /** Runs `work` inside a database transaction (see `SqliteDatabase.transaction`). */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  // ---------------------------------------------------------------------------
  // RepositoryReader
  // ---------------------------------------------------------------------------

  /** Returns persisted Drawing ids so the Runner can verify all ledger files before listing. */
  listDrawingIds(): readonly string[] {
    return (this.db.prepare("SELECT id FROM drawings ORDER BY updated_at DESC, id ASC").all() as Array<{ id: string }>).map((row) => row.id);
  }

  /** Returns persisted Revisions so the Runner can verify their immutable ledger files. */
  listDrawingRevisions(drawingId: string): readonly DrawingRevision[] {
    if (this.getDrawing(drawingId) === undefined) this.throwNotFound("Drawing", drawingId);
    return this.listRevisions(drawingId);
  }

  getDrawingDetail(drawingId: string): DrawingDetailView {
    const drawing = this.getDrawing(drawingId) ?? this.throwNotFound("Drawing", drawingId);
    const revisions = this.listRevisions(drawingId);
    return {
      drawing: {
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        name: drawing.name,
        currentRevisionId: drawing.currentRevisionId,
        createdAt: drawing.createdAt,
        updatedAt: drawing.updatedAt
      },
      revisions: revisions.map((revision) => this.toRevisionListItem(drawing, revision))
    };
  }

  getDrawingHistory(drawingId: string): DrawingHistoryView {
    const drawing = this.getDrawing(drawingId) ?? this.throwNotFound("Drawing", drawingId);
    const revisions = this.listRevisions(drawingId);
    return {
      drawingId: drawing.id,
      drawingNumber: drawing.drawingNumber,
      name: drawing.name,
      currentRevisionId: drawing.currentRevisionId,
      revisions: revisions.map((revision) => ({
        revisionId: revision.id,
        revisionLabel: revisionLabel(revision.sequence),
        isCurrent: drawing.currentRevisionId === revision.id,
        sourceFile: {
          fileName: revision.sourceFile.fileName,
          format: revision.sourceFile.format,
          sizeBytes: revision.sourceFile.sizeBytes,
          sha256: revision.sourceFile.sha256,
          uploadedAt: revision.sourceFile.uploadedAt
        },
        createdAt: revision.createdAt
      }))
    };
  }

  getRevisionDetail(drawingId: string, revisionId: string): RevisionDetailView {
    const drawing = this.getDrawing(drawingId) ?? this.throwNotFound("Drawing", drawingId);
    const revision = this.getRevision(revisionId) ?? this.throwNotFound("Revision", revisionId);
    if (revision.drawingId !== drawing.id) {
      this.throwNotFound("Revision", revisionId);
    }
    return {
      revision: {
        revisionId: revision.id,
        revisionLabel: revisionLabel(revision.sequence),
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        drawingName: drawing.name,
        isCurrent: drawing.currentRevisionId === revision.id,
        currentApprovedModelId: revision.currentApprovedModelId,
        sourceFile: {
          fileName: revision.sourceFile.fileName,
          format: revision.sourceFile.format,
          sizeBytes: revision.sourceFile.sizeBytes,
          uploadedAt: revision.sourceFile.uploadedAt
        },
        createdAt: revision.createdAt
      },
      // Runs, Models and Cost Reports belong to later phases; truthfully empty.
      runs: [],
      models: [],
      costReports: this.listCostReportsByRevision(drawing.id, revisionId),
      facts: this.listRevisionFacts(revisionId),
      modelingFeedback: this.listModelingFeedback(revisionId)
    };
  }

  getRevisionHistory(drawingId: string, revisionId: string): RevisionHistoryView {
    const drawing = this.getDrawing(drawingId) ?? this.throwNotFound("Drawing", drawingId);
    const revision = this.getRevision(revisionId) ?? this.throwNotFound("Revision", revisionId);
    if (revision.drawingId !== drawing.id) {
      this.throwNotFound("Revision", revisionId);
    }
    return {
      revisionId: revision.id,
      revisionLabel: revisionLabel(revision.sequence),
      drawingId: drawing.id,
      drawingNumber: drawing.drawingNumber,
      isCurrent: drawing.currentRevisionId === revision.id,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt,
      // Facts oldest first, Modeling Feedback newest first (contract ordering).
      facts: this.listRevisionFacts(revisionId),
      modelingFeedback: this.listModelingFeedback(revisionId)
    };
  }

  getRunDetail(): never {
    // Run aggregate reads are served by `RunRepository` (Phase 3); this port
    // surface is never reached by the Runner facade.
    throw new NotFoundError("No Modeling Run exists yet in this data root");
  }

  getModelDetail(): never {
    throw new NotFoundError("No Model exists yet in this data root");
  }

  getClarification(): never {
    throw new NotFoundError("No Clarification request exists yet in this data root");
  }

  getCostReportDetail(costReportId?: string): CostReportDetailView {
    if (costReportId === undefined) {
      throw new NotFoundError("No Cost Estimate Report exists yet in this data root");
    }
    const row = this.db
      .prepare("SELECT * FROM cost_reports WHERE id = ?")
      .get(costReportId) as unknown as CostReportRow | undefined;
    if (!row) {
      throw new NotFoundError(`Cost Estimate Report ${costReportId} was not found`);
    }
    return this.mapCostReportDetail(row);
  }

  listCostReportsByRevision(drawingId: string, revisionId: string): readonly CostReportListItemView[] {
    const rows = this.db
      .prepare("SELECT * FROM cost_reports WHERE drawing_id = ? AND revision_id = ? ORDER BY created_at ASC, id ASC")
      .all(drawingId, revisionId) as unknown as CostReportRow[];
    return rows.map((row) => this.toCostReportListItem(row));
  }

  getWorkspaceDashboard(): WorkspaceDashboardView {
    return {
      // No Run lifecycle exists before Phase 3; every run-backed field is empty.
      currentRun: null,
      queuedRunLabels: [],
      pendingReviews: [],
      pendingClarifications: [],
      recentDrawings: this.listDrawingListItems()
    };
  }

  getEffectiveCostData(): CostDataSnapshot {
    const definitions = this.db
      .prepare("SELECT * FROM cost_data_definitions ORDER BY id ASC")
      .all() as unknown as CostDataDefinitionRow[];
    
    if (definitions.length === 0) {
      // Seed default canonical cost data if empty
      this.seedDefaultCostData();
      return this.getEffectiveCostData();
    }

    const valueRows = this.db
      .prepare("SELECT * FROM cost_data_values")
      .all() as unknown as CostDataValueRow[];

    const valuesByDefId = new Map(valueRows.map((r) => [r.definition_id, r]));

    const materials: MaterialCostValue[] = [];
    const allowances: AllowanceDefinition[] = [];
    const fixedCosts: FixedCostValue[] = [];
    const customFields: CustomCostField[] = [];
    let maxUpdated = "1970-01-01T00:00:00.000Z";

    for (const def of definitions) {
      if (def.updated_at > maxUpdated) maxUpdated = def.updated_at;
      const valRow = valuesByDefId.get(def.id);
      if (!valRow) continue;
      if (valRow.updated_at > maxUpdated) maxUpdated = valRow.updated_at;
      const payload = JSON.parse(valRow.payload_json) as unknown as CostDataPayload;

      if (def.kind === "MATERIAL") {
        materials.push({
          id: def.id,
          name: def.name,
          purchasePrice: payload.purchasePrice ?? 0,
          priceUnit: payload.priceUnit ?? "元/吨",
          ...(payload.density === undefined ? {} : { density: payload.density }),
          ...(payload.densityUnit === undefined ? {} : { densityUnit: payload.densityUnit }),
          effectiveFrom: payload.effectiveFrom ?? def.updated_at,
          updatedAt: valRow.updated_at
        });
      } else if (def.kind === "ALLOWANCE") {
        allowances.push({
          id: def.id,
          stockType: payload.stockType ?? "CYLINDER",
          allowances: payload.allowances ?? [],
          updatedAt: valRow.updated_at
        });
      } else if (def.kind === "FIXED_COST") {
        fixedCosts.push({
          id: def.id,
          name: def.name,
          amount: payload.amount ?? 0,
          currency: payload.currency ?? "CNY",
          basis: payload.basis ?? "PER_PIECE",
          defaultEnabled: payload.defaultEnabled ?? true,
          updatedAt: valRow.updated_at
        });
      } else if (def.kind === "CUSTOM") {
        customFields.push({
          id: def.id,
          key: def.key,
          name: def.name,
          value: payload.value ?? "",
          ...(payload.unit === undefined ? {} : { unit: payload.unit }),
          semantics: "DISPLAY_ONLY",
          updatedAt: valRow.updated_at
        });
      }
    }

    return {
      materials,
      allowances,
      fixedCosts,
      customFields,
      capturedAt: maxUpdated
    };
  }

  getStorageSettings(): StorageSettingsView {
    const settings = this.readStorageSettings();
    if (settings === null) {
      throw new NotFoundError("Storage settings have not been initialized");
    }
    return { settings };
  }

  // ---------------------------------------------------------------------------
  // RepositoryWriter
  // ---------------------------------------------------------------------------

  saveDrawing(drawing: Drawing): void {
    this.insertDrawing(drawing);
  }

  saveRevision(revision: DrawingRevision): void {
    this.insertRevision(revision);
  }

  saveRun(run: ModelingRun): never {
    throw new UnsupportedPhaseOperationError(
      "Modeling Run persistence arrives with the Phase 3 Run orchestrator",
      { runId: run.id }
    );
  }

  appendRunEvent(event: RunEvent): never {
    throw new UnsupportedPhaseOperationError(
      "Run event persistence arrives with the Phase 3 Run orchestrator",
      { runId: event.runId }
    );
  }

  saveClarification(request: ClarificationRequest): never {
    throw new UnsupportedPhaseOperationError(
      "Clarification persistence arrives with the Phase 3 Run orchestrator",
      { clarificationRequestId: request.id }
    );
  }

  saveModel(model: Model): never {
    throw new UnsupportedPhaseOperationError(
      "Model persistence arrives with the Phase 3 Run orchestrator",
      { modelId: model.id }
    );
  }

  saveModelReview(review: ModelReview): never {
    throw new UnsupportedPhaseOperationError(
      "Model Review persistence arrives with the Phase 3 Run orchestrator",
      { reviewId: review.id }
    );
  }

  addRevisionFact(fact: RevisionFact): void {
    this.insertRevisionFact(fact);
  }

  addModelingFeedback(feedback: ModelingFeedback): void {
    this.insertModelingFeedback(feedback);
  }

  saveArtifact(artifact: Artifact): never {
    throw new UnsupportedPhaseOperationError(
      "Artifact persistence arrives with the Phase 3 Run orchestrator",
      { artifactId: artifact.id }
    );
  }

  saveCostEstimateReport(report: CostEstimateReport): void {
    const insert = this.db.prepare(
      "INSERT INTO cost_reports (id, label, drawing_id, revision_id, model_id, quantity, snapshot_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "label = excluded.label, quantity = excluded.quantity, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at"
    );
    insert.run(
      report.id,
      report.label,
      report.drawingId,
      report.revisionId,
      report.modelId,
      report.quantity,
      JSON.stringify(report.snapshot),
      report.createdAt,
      report.updatedAt
    );
  }

  saveCostDataSnapshot(snapshot: CostDataSnapshot): void {
    const now = snapshot.capturedAt;

    // Remove existing records to allow clean replacement of snapshot
    this.db.exec("DELETE FROM cost_data_values; DELETE FROM cost_data_definitions;");

    const upsertDef = this.db.prepare(
      "INSERT INTO cost_data_definitions (id, key, name, kind, semantics, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    );
    const upsertVal = this.db.prepare(
      "INSERT INTO cost_data_values (id, definition_id, payload_json, updated_at) " +
        "VALUES (?, ?, ?, ?)"
    );

    // Save materials
    for (const mat of snapshot.materials) {
      upsertDef.run(mat.id, `material.${mat.id}`, mat.name, "MATERIAL", "CALCULABLE", mat.updatedAt ?? now);
      upsertVal.run(
        `val-${mat.id}`,
        mat.id,
        JSON.stringify({
          purchasePrice: mat.purchasePrice,
          priceUnit: mat.priceUnit,
          density: mat.density,
          densityUnit: mat.densityUnit,
          effectiveFrom: mat.effectiveFrom
        }),
        mat.updatedAt ?? now
      );
    }

    // Save allowances
    for (const allow of snapshot.allowances) {
      upsertDef.run(allow.id, `allowance.${allow.stockType.toLowerCase()}`, `余量 (${allow.stockType})`, "ALLOWANCE", "CALCULABLE", allow.updatedAt ?? now);
      upsertVal.run(
        `val-${allow.id}`,
        allow.id,
        JSON.stringify({
          stockType: allow.stockType,
          allowances: allow.allowances
        }),
        allow.updatedAt ?? now
      );
    }

    // Save fixed costs
    for (const fixed of snapshot.fixedCosts) {
      upsertDef.run(fixed.id, `fixedCost.${fixed.id}`, fixed.name, "FIXED_COST", "CALCULABLE", fixed.updatedAt ?? now);
      upsertVal.run(
        `val-${fixed.id}`,
        fixed.id,
        JSON.stringify({
          amount: fixed.amount,
          currency: fixed.currency,
          basis: fixed.basis,
          defaultEnabled: fixed.defaultEnabled
        }),
        fixed.updatedAt ?? now
      );
    }

    // Save custom fields
    for (const custom of snapshot.customFields) {
      upsertDef.run(custom.id, custom.key, custom.name, "CUSTOM", "DISPLAY_ONLY", custom.updatedAt ?? now);
      upsertVal.run(
        `val-${custom.id}`,
        custom.id,
        JSON.stringify({
          value: custom.value,
          unit: custom.unit
        }),
        custom.updatedAt ?? now
      );
    }
  }

  saveStorageSettings(settings: StorageSettings): void {
    if (!STORAGE_CONSTRAINTS.includes(settings.constraint)) {
      throw new UnsupportedPhaseOperationError(
        `Unsupported storage constraint: ${settings.constraint}`,
        { constraint: settings.constraint }
      );
    }
    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    );
    upsert.run(SETTING_KEYS.dataRoot, settings.dataRoot, now);
    upsert.run(SETTING_KEYS.workspaceRoot, settings.workspaceRoot, now);
    upsert.run(SETTING_KEYS.constraint, settings.constraint, now);
    upsert.run(SETTING_KEYS.updatedAt, settings.updatedAt, now);
  }

  // ---------------------------------------------------------------------------
  // Low-level persistence primitives (composed by the workflow service)
  // ---------------------------------------------------------------------------

  insertDrawing(drawing: Drawing): void {
    this.db
      .prepare(
        "INSERT INTO drawings (id, drawing_number, name, current_revision_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        drawing.id,
        drawing.drawingNumber,
        drawing.name,
        drawing.currentRevisionId,
        drawing.createdAt,
        drawing.updatedAt
      );
  }

  insertRevisionFile(file: RevisionSourceFile): void {
    this.db
      .prepare(
        "INSERT INTO revision_files (id, file_name, format, size_bytes, sha256, mime_type, relative_path, uploaded_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        file.id,
        file.fileName,
        file.format,
        file.sizeBytes,
        file.sha256,
        file.mimeType ?? null,
        file.relativePath,
        file.uploadedAt
      );
  }

  insertRevision(revision: DrawingRevision): void {
    this.db
      .prepare(
        "INSERT INTO drawing_revisions (id, drawing_id, sequence, source_file_id, current_approved_model_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        revision.id,
        revision.drawingId,
        revision.sequence,
        revision.sourceFile.id,
        revision.currentApprovedModelId,
        revision.createdAt,
        revision.updatedAt
      );
  }

  /** Atomically repoints the Drawing's current Revision pointer. */
  setCurrentRevisionPointer(drawingId: string, revisionId: string, updatedAt: string): void {
    this.db
      .prepare(
        "UPDATE drawings SET current_revision_id = ?, updated_at = ? WHERE id = ?"
      )
      .run(revisionId, updatedAt, drawingId);
  }

  /**
   * Atomically repoints a Revision's current-approved-Model pointer (Phase 6).
   * `modelId` is the approved Model, or `null` to clear the pointer; the write
   * also bumps the Revision's `updated_at` like the Drawing pointer transition.
   */
  updateCurrentApprovedModelPointer(
    revisionId: string,
    modelId: string | null,
    updatedAt: string
  ): void {
    this.db
      .prepare(
        "UPDATE drawing_revisions SET current_approved_model_id = ?, updated_at = ? " +
          "WHERE id = ?"
      )
      .run(modelId, updatedAt, revisionId);
  }

  /** Bumps `updated_at` when the Drawing's library changes (new Revision). */
  touchDrawing(drawingId: string, updatedAt: string): void {
    this.db
      .prepare("UPDATE drawings SET updated_at = ? WHERE id = ?")
      .run(updatedAt, drawingId);
  }

  /**
   * Deletes the DB rows owned by one Revision (facts, feedback, the revision
   * and its source-file metadata). Callers compose these inside one transaction
   * together with the ledger file deletion; the FK graph (facts/feedback ->
   * revision -> file) is satisfied by deleting children before parents.
   */
  deleteRevisionRecords(revisionId: string, sourceFileId: string): void {
    this.db.prepare("DELETE FROM revision_facts WHERE revision_id = ?").run(revisionId);
    this.db.prepare("DELETE FROM modeling_feedback WHERE revision_id = ?").run(revisionId);
    this.db.prepare("DELETE FROM drawing_revisions WHERE id = ?").run(revisionId);
    this.db.prepare("DELETE FROM revision_files WHERE id = ?").run(sourceFileId);
  }

  /**
   * Durable file-cleanup queue shared with `BusinessDeletionService` (same
   * `settings` key and JSON shape). A source-file cleanup intent is recorded
   * inside the deleting transaction so a committed deletion never leaves an
   * untracked orphan file behind.
   */
  enqueueSourceCleanup(relativePath: string, now: string): void {
    const jobs = this.readCleanupQueue();
    if (jobs.some((job) => job.kind === "source" && job.relativePath === relativePath)) return;
    jobs.push({ kind: "source", relativePath });
    this.db
      .prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) " +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"
      )
      .run(CLEANUP_QUEUE_KEY, JSON.stringify(jobs), now);
  }

  /** Removes a satisfied source-file cleanup intent (no-op when absent). */
  dequeueSourceCleanup(relativePath: string, now: string): void {
    const jobs = this.readCleanupQueue();
    const remaining = jobs.filter((job) => !(job.kind === "source" && job.relativePath === relativePath));
    if (remaining.length === jobs.length) return;
    this.db
      .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
      .run(JSON.stringify(remaining), now, CLEANUP_QUEUE_KEY);
  }

  private readCleanupQueue(): Array<{ kind: string; relativePath?: string }> {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CLEANUP_QUEUE_KEY) as
      | { value: string }
      | undefined;
    return row === undefined ? [] : (JSON.parse(row.value) as Array<{ kind: string; relativePath?: string }>);
  }

  /**
   * Deletes the ONE Cost Estimate Report row that matches both the report id
   * and its owning Revision. Returns `true` when a row was deleted, `false`
   * when no row matched (unknown report, or the pair mismatched). Callers
   * compose this inside a transaction and surface their own structured error
   * when the deletion did not match.
   */
  deleteCostReport(costReportId: string, revisionId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM cost_reports WHERE id = ? AND revision_id = ?")
      .run(costReportId, revisionId);
    return Number(result.changes) > 0;
  }

  insertRevisionFact(fact: RevisionFact): void {
    this.db
      .prepare(
        "INSERT INTO revision_facts (id, revision_id, field, value, unit, source, source_run_id, created_at, created_by) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        fact.id,
        fact.revisionId,
        fact.field,
        fact.value,
        fact.unit ?? null,
        fact.source,
        fact.sourceRunId ?? null,
        fact.createdAt,
        fact.createdBy ?? null
      );
  }

  insertModelingFeedback(feedback: ModelingFeedback): void {
    this.db
      .prepare(
        "INSERT INTO modeling_feedback (id, revision_id, model_id, review_id, content, source, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        feedback.id,
        feedback.revisionId,
        feedback.modelId ?? null,
        feedback.reviewId ?? null,
        feedback.content,
        feedback.source,
        feedback.createdAt
      );
  }

  // ---------------------------------------------------------------------------
  // Queries used by the service and the reader surface
  // ---------------------------------------------------------------------------

  getDrawing(drawingId: string): Drawing | null {
    const row = this.db.prepare("SELECT * FROM drawings WHERE id = ?").get(drawingId) as
      | DrawingRow
      | undefined;
    return row === undefined ? null : this.mapDrawing(row);
  }

  getDrawingByNumber(drawingNumber: string): Drawing | null {
    const row = this.db.prepare("SELECT * FROM drawings WHERE drawing_number = ?").get(drawingNumber) as
      | DrawingRow
      | undefined;
    return row === undefined ? null : this.mapDrawing(row);
  }

  getRevision(revisionId: string): DrawingRevision | null {
    const row = this.db
      .prepare(
        "SELECT r.*, f.file_name, f.format, f.size_bytes, f.sha256, f.mime_type, f.relative_path, f.uploaded_at " +
          "FROM drawing_revisions r JOIN revision_files f ON f.id = r.source_file_id WHERE r.id = ?"
      )
      .get(revisionId) as (RevisionRow & RevisionFileRow) | undefined;
    return row === undefined ? null : this.mapRevision(row);
  }

  listRevisions(drawingId: string): DrawingRevision[] {
    const rows = this.db
      .prepare(
        "SELECT r.*, f.file_name, f.format, f.size_bytes, f.sha256, f.mime_type, f.relative_path, f.uploaded_at " +
          "FROM drawing_revisions r JOIN revision_files f ON f.id = r.source_file_id " +
          "WHERE r.drawing_id = ? ORDER BY r.sequence ASC"
      )
      .all(drawingId) as unknown as Array<RevisionRow & RevisionFileRow>;
    return rows.map((row) => this.mapRevision(row));
  }

  getRevisionSequences(drawingId: string): number[] {
    const rows = this.db
      .prepare("SELECT sequence FROM drawing_revisions WHERE drawing_id = ? ORDER BY sequence ASC")
      .all(drawingId) as unknown as Array<{ sequence: number }>;
    return rows.map((row) => row.sequence);
  }

  listRevisionFacts(revisionId: string): RevisionFact[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM revision_facts WHERE revision_id = ? ORDER BY created_at ASC, id ASC"
      )
      .all(revisionId) as unknown as RevisionFactRow[];
    return rows.map((row) => this.mapRevisionFact(row));
  }

  listModelingFeedback(revisionId: string): ModelingFeedback[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM modeling_feedback WHERE revision_id = ? ORDER BY created_at DESC, id DESC"
      )
      .all(revisionId) as unknown as ModelingFeedbackRow[];
    return rows.map((row) => this.mapModelingFeedback(row));
  }

  countRuns(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number };
    return row.count;
  }

  readStorageSettings(): StorageSettings | null {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as unknown as Array<{
      key: string;
      value: string;
    }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const dataRoot = values.get(SETTING_KEYS.dataRoot);
    const workspaceRoot = values.get(SETTING_KEYS.workspaceRoot);
    const constraint = values.get(SETTING_KEYS.constraint);
    const updatedAt = values.get(SETTING_KEYS.updatedAt);
    if (dataRoot === undefined || workspaceRoot === undefined || constraint === undefined || updatedAt === undefined) {
      return null;
    }
    return {
      dataRoot,
      workspaceRoot,
      constraint: constraint as StorageSettings["constraint"],
      updatedAt
    };
  }

  /** Inserts default storage settings on first open; never overwrites existing rows. */
  seedStorageSettings(defaults: StorageSettingsDefaults): void {
    const existing = this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(SETTING_KEYS.dataRoot);
    if (existing !== undefined) return;
    const insert = this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run(SETTING_KEYS.dataRoot, defaults.dataRoot, defaults.updatedAt);
    insert.run(SETTING_KEYS.workspaceRoot, defaults.workspaceRoot, defaults.updatedAt);
    insert.run(SETTING_KEYS.constraint, "LOCAL_FIXED_NTFS", defaults.updatedAt);
    insert.run(SETTING_KEYS.updatedAt, defaults.updatedAt, defaults.updatedAt);
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  /**
   * Library list read model. Status fields are derived in ONE aggregate
   * query (no per-drawing round trips): the current Revision's current
   * approved Model, the newest Run status of the current Revision, whether the
   * current Revision has a PENDING_REVIEW Model and whether it has an OPEN
   * Clarification Request. Drawing files are never touched here.
   */
  private listDrawingListItems(): DrawingListItemView[] {
    const rows = this.db
      .prepare(
        "SELECT d.id AS id, d.drawing_number AS drawing_number, d.name AS name, " +
          "d.current_revision_id AS current_revision_id, d.updated_at AS updated_at, " +
          "cur.sequence AS current_sequence, " +
          "cur.current_approved_model_id AS approved_model_id, " +
          "(SELECT COUNT(*) FROM drawing_revisions x WHERE x.drawing_id = d.id) AS revision_count, " +
          "(SELECT MAX(x.sequence) FROM drawing_revisions x WHERE x.drawing_id = d.id) AS latest_sequence, " +
          "(SELECT r.status FROM runs r WHERE r.revision_id = d.current_revision_id " +
          "ORDER BY r.created_at DESC, r.id ASC LIMIT 1) AS run_status, " +
          "EXISTS (SELECT 1 FROM models m WHERE m.revision_id = d.current_revision_id " +
          "AND m.review_status = 'PENDING_REVIEW') AS has_pending_review, " +
          "EXISTS (SELECT 1 FROM clarification_requests c WHERE c.revision_id = d.current_revision_id " +
          "AND c.status = 'OPEN') AS has_open_clarification " +
          "FROM drawings d LEFT JOIN drawing_revisions cur ON cur.id = d.current_revision_id " +
          "ORDER BY d.updated_at DESC, d.id ASC"
      )
      .all() as unknown as Array<{
      id: string;
      drawing_number: string;
      name: string;
      current_revision_id: string | null;
      updated_at: string;
      current_sequence: number | null;
      approved_model_id: string | null;
      revision_count: number;
      latest_sequence: number | null;
      run_status: string | null;
      has_pending_review: number;
      has_open_clarification: number;
    }>;
    return rows.map((row) => ({
      drawingId: row.id,
      drawingNumber: row.drawing_number,
      name: row.name,
      currentRevisionId: row.current_revision_id,
      currentRevisionLabel: row.current_sequence === null ? null : revisionLabel(row.current_sequence),
      currentApprovedModelId: row.approved_model_id,
      runStatus: row.run_status,
      updatedAt: row.updated_at,
      totalRevisionCount: row.revision_count,
      latestRevisionLabel: row.latest_sequence === null ? null : revisionLabel(row.latest_sequence),
      hasOpenClarification: row.has_open_clarification === 1,
      hasPendingReview: row.has_pending_review === 1
    }));
  }

  private toRevisionListItem(drawing: Drawing, revision: DrawingRevision): RevisionListItemView {
    const isCurrent = drawing.currentRevisionId === revision.id;
    return {
      revisionId: revision.id,
      revisionLabel: revisionLabel(revision.sequence),
      isCurrent,
      currentApprovedModelId: revision.currentApprovedModelId,
      isCurrentApprovedModel: isCurrent && revision.currentApprovedModelId !== null,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt
    };
  }

  private mapDrawing(row: DrawingRow): Drawing {
    return {
      id: row.id,
      drawingNumber: row.drawing_number,
      name: row.name,
      currentRevisionId: row.current_revision_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapRevision(row: RevisionRow & RevisionFileRow): DrawingRevision {
    return {
      id: row.id,
      drawingId: row.drawing_id,
      sequence: row.sequence,
      sourceFile: {
        id: row.source_file_id,
        fileName: row.file_name,
        format: row.format,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
        relativePath: row.relative_path,
        uploadedAt: row.uploaded_at
      },
      currentApprovedModelId: row.current_approved_model_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapRevisionFact(row: RevisionFactRow): RevisionFact {
    return {
      id: row.id,
      revisionId: row.revision_id,
      field: row.field,
      value: row.value,
      ...(row.unit === null ? {} : { unit: row.unit }),
      source: row.source,
      ...(row.source_run_id === null ? {} : { sourceRunId: row.source_run_id }),
      createdAt: row.created_at,
      ...(row.created_by === null ? {} : { createdBy: row.created_by })
    };
  }

  private mapModelingFeedback(row: ModelingFeedbackRow): ModelingFeedback {
    return {
      id: row.id,
      revisionId: row.revision_id,
      ...(row.model_id === null ? {} : { modelId: row.model_id }),
      ...(row.review_id === null ? {} : { reviewId: row.review_id }),
      content: row.content,
      source: row.source,
      createdAt: row.created_at
    };
  }

  private toCostReportListItem(row: CostReportRow): CostReportListItemView {
    const snapshot = JSON.parse(row.snapshot_json) as unknown as CostEstimateSnapshot;
    return {
      costReportId: row.id,
      label: row.label,
      quantity: row.quantity,
      perPieceCost: snapshot.result.perPieceCost,
      totalCost: snapshot.result.totalCost,
      currency: snapshot.result.currency,
      createdAt: row.created_at
    };
  }

  private mapCostReportDetail(row: CostReportRow): CostReportDetailView {
    const snapshot = JSON.parse(row.snapshot_json) as unknown as CostEstimateSnapshot;
    return {
      costReportId: row.id,
      label: row.label,
      drawingId: row.drawing_id,
      revisionId: row.revision_id,
      modelId: row.model_id,
      quantity: row.quantity,
      createdAt: row.created_at,
      snapshot,
      result: {
        rawStockVolume: snapshot.result.rawStockVolume,
        materialCost: snapshot.result.materialCost,
        fixedCostLines: snapshot.result.fixedCostLines,
        perPieceCost: snapshot.result.perPieceCost,
        totalCost: snapshot.result.totalCost,
        currency: snapshot.result.currency
      }
    };
  }

  private seedDefaultCostData(): void {
    const now = "2026-08-10T08:00:00.000Z";
    const defaultSnapshot: CostDataSnapshot = {
      materials: [
        {
          id: "material-42crmo",
          name: "42CrMo",
          purchasePrice: 5200,
          priceUnit: "元/吨",
          density: 7.85,
          densityUnit: "g/cm³",
          effectiveFrom: now,
          updatedAt: now
        },
        {
          id: "material-45steel",
          name: "45#钢",
          purchasePrice: 4800,
          priceUnit: "元/吨",
          density: 7.85,
          densityUnit: "g/cm³",
          effectiveFrom: now,
          updatedAt: now
        },
        {
          id: "material-40cr",
          name: "40Cr",
          purchasePrice: 5000,
          priceUnit: "元/吨",
          density: 7.85,
          densityUnit: "g/cm³",
          effectiveFrom: now,
          updatedAt: now
        }
      ],
      allowances: [
        {
          id: "allowance-cylinder",
          stockType: "CYLINDER",
          allowances: [
            { name: "直径方向默认余量", valueMm: 20 },
            { name: "长度方向默认余量", valueMm: 20 }
          ],
          updatedAt: now
        },
        {
          id: "allowance-rectangular-bar",
          stockType: "RECTANGULAR_BAR",
          allowances: [
            { name: "长度方向默认余量", valueMm: 20 },
            { name: "宽度方向默认余量", valueMm: 20 },
            { name: "高度方向默认余量", valueMm: 20 }
          ],
          updatedAt: now
        }
      ],
      fixedCosts: [
        {
          id: "fixed-basic-processing",
          name: "基础加工成本",
          amount: 500,
          currency: "CNY",
          basis: "PER_PIECE",
          defaultEnabled: true,
          updatedAt: now
        },
        {
          id: "fixed-inspection",
          name: "检测成本",
          amount: 100,
          currency: "CNY",
          basis: "PER_PIECE",
          defaultEnabled: true,
          updatedAt: now
        },
        {
          id: "fixed-packaging",
          name: "包装成本",
          amount: 80,
          currency: "CNY",
          basis: "PER_BATCH",
          defaultEnabled: true,
          updatedAt: now
        }
      ],
      customFields: [
        {
          id: "custom-note",
          key: "note.general",
          name: "备注",
          value: "常规加工工艺，不含热处理",
          semantics: "DISPLAY_ONLY",
          updatedAt: now
        }
      ],
      capturedAt: now
    };
    this.saveCostDataSnapshot(defaultSnapshot);
  }

  private throwNotFound(kind: "Drawing" | "Revision", id: string): never {
    throw new NotFoundError(`${kind} ${id} was not found`, { [kind.toLowerCase()]: id });
  }
}
