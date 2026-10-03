import type {
  ClarificationAnswer,
  ClarificationQuestion,
  ClarificationQuestionType,
  ClarificationRequest,
  ClarificationStatus,
  InputAdapterSourceRef,
  Model,
  ModelReviewStatus,
  ModelValidationSummary,
  ModelingRun,
  RevisionFact,
  RunEvent,
  RunEventPayload,
  RunFailureCode,
  RunInputSnapshot,
  RunStage,
  RunStatus
} from "@swpanel/domain";
import {
  CLARIFICATION_STATUSES,
  canDeleteRun,
  canReviewModel,
  DELETABLE_RUN_STATUSES,
  DomainInvariantError,
  MODEL_REVIEW_RESULTS,
  MODEL_REVIEW_STATUSES,
  revisionLabel,
  RUN_EVENT_CONTRACT_VERSION,
  RUN_EVENT_TYPES,
  RUN_FAILURE_CODES,
  RUN_STAGES,
  transitionModelStatus,
  isCancellationRunEventType,
  isRunTerminal,
  isTerminalRunEventType,
  runLabel,
  transitionRunStatus,
  type ModelReviewResult
} from "@swpanel/domain";
import type {
  ClarificationView,
  ModelDetailView,
  ModelListItemView,
  RunDetailView,
  RunListItemView,
  WorkspaceDashboardView
} from "@swpanel/contracts";

import {
  EntityConflictError,
  InvalidArgumentError,
  NotFoundError,
  RunnerInvariantError
} from "../errors.js";
import { assertSafeIdToken, generateId } from "../ids.js";
import type { SqliteDatabase } from "./database.js";
import { isUniqueConstraintError, type SqliteRepository } from "./repository.js";

/**
 * Runner-owned configuration values pinned into every frozen Input Snapshot
 * (prompt template version, Skill identity + hash, agent/model config id).
 * They come from Runner construction config — never from the client.
 */
export interface RunProfile {
  promptTemplateVersion: string;
  skill: {
    name: string;
    sha256: string;
  };
  agentConfigId: string;
}

export interface CreateRunInput {
  drawingId: string;
  revisionId: string;
  profile: RunProfile;
  createdAt: string;
}

/** One event of a batch append; `occurredAt` is per event. */
export interface RunEventEntry {
  payload: RunEventPayload;
  occurredAt: string;
}

export interface AppendRunEventsInput {
  runId: string;
  /** Attempt that produced the events; the attempt row is minted by the claim (P3-2). */
  attemptId: string;
  entries: readonly RunEventEntry[];
}

/** Outcome of one terminal Run deletion (DB surface). */
export interface DeleteRunResult {
  runId: string;
  /**
   * Every attempt sequence ever recorded for the Run, oldest first. The
   * facade uses these to remove each attempt's isolated workspace subtree
   * AFTER the DB transaction committed.
   */
  attemptSequences: readonly number[];
}

/** Read-model projection state accumulated while a batch of events is applied. */
interface RunProjection {
  status: RunStatus;
  stage: RunStage | null;
  activity: string | null;
  progressPercent: number | null;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: RunFailureCode | null;
  failureMessage: string | null;
  clarificationRequestId: string | null;
  modelId: string | null;
  cancellationRequestedAt: string | null;
  cancellationRequestedReason: string | null;
  cancellationConfirmedAt: string | null;
}

interface RunRow {
  id: string;
  number: string;
  drawing_id: string;
  revision_id: string;
  status: string;
  stage: string | null;
  activity: string | null;
  progress_percent: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  clarification_request_id: string | null;
  model_id: string | null;
  cancellation_requested_at: string | null;
  cancellation_requested_reason: string | null;
  cancellation_confirmed_at: string | null;
}

interface RunEventRow {
  id: number;
  run_id: string;
  sequence: number;
  contract_version: number;
  attempt_id: string | null;
  payload_json: string;
  occurred_at: string;
}

interface ModelRow {
  id: string;
  number: string;
  drawing_id: string;
  revision_id: string;
  run_id: string;
  review_status: string;
  generated_at: string;
  validation_summary_json: string | null;
  build_report_summary: string | null;
  production_verified: number;
}

/**
 * Phase 3 Run persistence (Batch P3-1). The Runner is the only Run writer:
 *
 * - `createRun` atomically persists a QUEUED Run plus its immutable Input
 *   Snapshot. The snapshot is built INSIDE the transaction from the persisted
 *   Revision, its Facts and Modeling Feedback plus the Runner's own profile
 *   config — a client-supplied snapshot is never trusted.
 * - reads serve the Run detail/list/dashboard surfaces and the frozen snapshot;
 * - `appendRunEvents` allocates strictly monotonic per-Run sequences inside the
 *   transaction and projects stage/activity/progress/status/timestamps/
 *   failure/clarification/model/cancellation read-model fields in the same
 *   transaction, so events and their projection are never observable apart.
 *
 * There is intentionally NO public QUEUED -> RUNNING transition primitive
 * here: the atomic claim (P3-2, `RunOrchestrator.claimNextQueuedRun`) is the
 * only path to RUNNING and mints the persisted ACTIVE attempt in the same
 * transaction, so a RUNNING Run can never exist without a live attempt and the
 * queue can never be wedged by an attempt-less RUNNING Run.
 *
 * The Fake Executor's COMPLETED path publishes no modelId, and no `models` row
 * is ever created here: when a Completed event DOES carry a modelId it must
 * already resolve to a persisted Model (Phase 5 publishes Models).
 */
export class RunRepository {
  private readonly commitListeners = new Set<(events: readonly RunEvent[]) => void>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly store: SqliteRepository
  ) {}

  /**
   * Registers a listener that receives every appended event batch ONLY after
   * the enclosing write transaction committed (Phase 3, P3-4 event stream).
   * The listener is never invoked for a batch whose transaction rolled back.
   * Returns an unsubscribe function.
   */
  addRunEventsCommittedListener(listener: (events: readonly RunEvent[]) => void): () => void {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  }

  /** Fires the after-commit listeners with one committed batch, isolated. */
  private notifyCommitted(events: readonly RunEvent[]): void {
    for (const listener of this.commitListeners) {
      try {
        listener(events);
      } catch {
        // A stream listener must never break the committing writer.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /** Atomically creates a QUEUED Run with its immutable Runner-built snapshot. */
  createRun(input: CreateRunInput): ModelingRun {
    // Run paths store canonical UTC ISO-8601 timestamps, so lexicographic SQL
    // ordering equals chronological ordering.
    const createdAt = this.toCanonicalIso(input.createdAt, "createdAt");
    const createdAtMs = Date.parse(createdAt);
    return this.db.transaction(() => {
      const revision = this.store.getRevision(input.revisionId);
      if (revision === null) {
        throw new NotFoundError(`Revision ${input.revisionId} was not found`, {
          revisionId: input.revisionId
        });
      }
      if (revision.drawingId !== input.drawingId) {
        throw new RunnerInvariantError(
          `Revision ${input.revisionId} does not belong to Drawing ${input.drawingId}`
        );
      }
      const sequence = this.nextRunSequence(input.revisionId);
      // The snapshot freezes the Memory visible at the creation moment: Facts
      // and Feedback recorded strictly after the snapshot instant are
      // excluded. Causality compares NUMERIC epochs (legacy Memory rows may
      // store non-canonical timestamps), never raw string ordering. A row whose
      // timestamp cannot be parsed is never PROVEN to be later, so it is kept:
      // silently dropping memory is worse than including it (BE-03).
      const snapshot: RunInputSnapshot = {
        drawingId: revision.drawingId,
        revisionId: revision.id,
        originalFileRef: revision.sourceFile.relativePath,
        revisionFacts: this.store
          .listRevisionFacts(input.revisionId)
          .filter((fact) => !(Date.parse(fact.createdAt) > createdAtMs)),
        modelingFeedback: this.store
          .listModelingFeedback(input.revisionId)
          .filter((feedback) => !(Date.parse(feedback.createdAt) > createdAtMs)),
        promptTemplateVersion: input.profile.promptTemplateVersion,
        skill: { name: input.profile.skill.name, sha256: input.profile.skill.sha256 },
        agentConfigId: input.profile.agentConfigId,
        createdAt
      };
      const id = generateId();
      const number = runLabel(sequence);
      try {
        this.db
          .prepare(
            "INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(id, number, revision.drawingId, revision.id, "QUEUED", createdAt);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new EntityConflictError(
            `A Run with number ${number} already exists for Revision ${input.revisionId}`,
            { revisionId: input.revisionId, number }
          );
        }
        throw error;
      }
      this.db
        .prepare("INSERT INTO run_input_snapshots (run_id, payload_json) VALUES (?, ?)")
        .run(id, JSON.stringify(snapshot));
      return {
        id,
        number,
        drawingId: revision.drawingId,
        revisionId: revision.id,
        status: "QUEUED",
        stage: null,
        inputSnapshot: snapshot,
        createdAt
      };
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getRun(runId: string): ModelingRun | null {
    const row = this.getRunRow(runId);
    if (row === null) return null;
    return this.mapRun(row, this.readSnapshotFor(runId));
  }

  /** The frozen Input Snapshot persisted at creation (fresh objects per read). */
  getRunSnapshot(runId: string): RunInputSnapshot {
    const run = this.getRun(runId);
    if (run === null) {
      throw new NotFoundError(`Run ${runId} was not found`, { runId });
    }
    return run.inputSnapshot;
  }

  // -------------------------------------------------------------------------
  // Model reads (Phase 5, P5-2)
  // -------------------------------------------------------------------------

  /**
   * The persisted Model with its published artifact ids, or null. Maps the
   * stored review status strictly (an unknown status fails truthfully instead
   * of being silently relabeled), parses the persisted validation summary
   * through a shape validator (unparsable or malformed JSON fails truthfully)
   * and surfaces the persisted production-verification claim (P5 truthfulness
   * hardening) as the domain boolean. Phase 6 review APIs are intentionally
   * NOT implemented here.
   */
  getModel(modelId: string): Model | null {
    assertSafeIdToken("modelId", modelId);
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(modelId) as
      | ModelRow
      | undefined;
    if (row === undefined) return null;
    if (!MODEL_REVIEW_STATUSES.includes(row.review_status as ModelReviewStatus)) {
      throw new RunnerInvariantError(
        `Stored model ${row.id} has an unknown review status ${row.review_status}`,
        { modelId: row.id, reviewStatus: row.review_status }
      );
    }
    if (row.production_verified !== 0 && row.production_verified !== 1) {
      throw new RunnerInvariantError(
        `Stored model ${row.id} has an invalid production_verified value ${row.production_verified}`,
        { modelId: row.id, productionVerified: row.production_verified }
      );
    }
    const validationSummary =
      row.validation_summary_json === null
        ? undefined
        : this.parseValidationSummary(row.validation_summary_json, row.id);
    const artifactRows = this.db
      .prepare("SELECT id FROM artifacts WHERE model_id = ? ORDER BY rowid ASC")
      .all(modelId) as unknown as Array<{ id: string }>;
    return {
      id: row.id,
      number: row.number,
      drawingId: row.drawing_id,
      revisionId: row.revision_id,
      runId: row.run_id,
      reviewStatus: row.review_status as ModelReviewStatus,
      generatedAt: row.generated_at,
      productionVerified: row.production_verified === 1,
      ...(validationSummary === undefined ? {} : { validationSummary }),
      ...(row.build_report_summary === null ? {} : { buildReportSummary: row.build_report_summary }),
      artifactIds: artifactRows.map((artifact) => artifact.id)
    };
  }

  /** Identity-bound file metadata; paths are never accepted from the client. */
  getModelArtifact(modelId: string, artifactId: string): {
    id: string; runId: string; kind: string; fileName: string;
    relativePath: string; sizeBytes: number; sha256: string;
  } | null {
    assertSafeIdToken("modelId", modelId);
    assertSafeIdToken("artifactId", artifactId);
    const row = this.db.prepare(
      "SELECT a.id, a.run_id AS runId, a.kind, a.file_name AS fileName, " +
      "a.relative_path AS relativePath, a.size_bytes AS sizeBytes, a.sha256 " +
      "FROM artifacts a JOIN models m ON m.id = a.model_id AND m.run_id = a.run_id " +
      "WHERE a.model_id = ? AND a.id = ?"
    ).get(modelId, artifactId);
    return row === undefined ? null : row as {
      id: string; runId: string; kind: string; fileName: string;
      relativePath: string; sizeBytes: number; sha256: string;
    };
  }

  // -------------------------------------------------------------------------
  // Model review (Phase 6, P6-*)
  // -------------------------------------------------------------------------

  /**
   * Performs a human review of one PENDING_REVIEW Model atomically: mints the
   * Review row, transitions the Model's persisted review status, and either
   * repoints the Revision's current-approved-Model pointer (APPROVED) or writes
   * the review comment into the Revision's Modeling Feedback (REJECTED). The
   * whole decision — review + status + pointer/feedback — is one transaction so
   * no intermediate state is ever observable. A Model can be reviewed exactly
   * once: after the transition `canReviewModel` refuses any further review and
   * the `idx_model_reviews_model_id` unique index defends the same fact.
   */
  reviewModel(input: {
    modelId: string;
    result: ModelReviewResult;
    comment?: string;
    reviewerId: string;
    reviewedAt: string;
  }): ModelDetailView {
    if (!MODEL_REVIEW_RESULTS.includes(input.result)) {
      throw new InvalidArgumentError(
        `model.review result must be one of ${MODEL_REVIEW_RESULTS.join(", ")}`,
        { result: input.result }
      );
    }
    return this.db.transaction(() => {
      const model = this.getModel(input.modelId);
      if (model === null) {
        throw new NotFoundError(`Model ${input.modelId} was not found`, {
          modelId: input.modelId
        });
      }
      if (!canReviewModel(model.reviewStatus)) {
        throw new RunnerInvariantError(
          `Model ${model.id} is ${model.reviewStatus}; only a PENDING_REVIEW model can be reviewed`,
          { modelId: model.id, reviewStatus: model.reviewStatus }
        );
      }
      const nextStatus = transitionModelStatus(model.reviewStatus, input.result);
      const reviewedAt = this.toCanonicalIso(input.reviewedAt, "review reviewedAt");
      if (input.result === "REJECTED") {
        if (typeof input.comment !== "string" || input.comment.trim().length === 0) {
          throw new InvalidArgumentError(
            "A REJECTED model review requires a non-empty comment",
            { modelId: input.modelId }
          );
        }
      } else if (input.comment !== undefined && typeof input.comment !== "string") {
        throw new InvalidArgumentError(
          "An APPROVED model review comment must be a non-empty string when present",
          { modelId: input.modelId }
        );
      }
      const reviewId = generateId();
      this.db
        .prepare(
          "INSERT INTO model_reviews (id, model_id, result, reviewer_id, comment, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(reviewId, model.id, input.result, input.reviewerId, input.comment ?? null, reviewedAt);
      this.db
        .prepare("UPDATE models SET review_status = ? WHERE id = ?")
        .run(nextStatus, model.id);
      if (input.result === "APPROVED") {
        this.store.updateCurrentApprovedModelPointer(model.revisionId, model.id, reviewedAt);
      } else {
        this.store.insertModelingFeedback({
          id: generateId(),
          revisionId: model.revisionId,
          modelId: model.id,
          reviewId,
          content: input.comment as string,
          source: "MODEL_REVIEW_REJECTED",
          createdAt: reviewedAt
        });
      }
      return this.getModelDetail(model.id);
    });
  }

  /**
   * Aggregate read of one Model per the `ModelDetailView` contract: the model
   * head (with the Revision's current-approved pointer resolved to
   * `isCurrentApproved`), its published artifact metadata rows (oldest first)
   * and its review history (oldest first). A stored Model whose status or
   * production-verification claim is corrupt fails truthfully through
   * {@link getModel}.
   */
  getModelDetail(modelId: string): ModelDetailView {
    const model = this.getModel(modelId);
    if (model === null) {
      throw new NotFoundError(`Model ${modelId} was not found`, { modelId });
    }
    const artifactRows = this.db
      .prepare(
        "SELECT id, kind, file_name, size_bytes, sha256 FROM artifacts " +
          "WHERE model_id = ? ORDER BY created_at ASC, rowid ASC"
      )
      .all(modelId) as unknown as Array<{
      id: string;
      kind: string;
      file_name: string;
      size_bytes: number;
      sha256: string;
    }>;
    const reviewRows = this.db
      .prepare(
        "SELECT id, result, reviewer_id, comment, created_at FROM model_reviews " +
          "WHERE model_id = ? ORDER BY created_at ASC, rowid ASC"
      )
      .all(modelId) as unknown as Array<{
      id: string;
      result: string;
      reviewer_id: string;
      comment: string | null;
      created_at: string;
    }>;
    const revision = this.db
      .prepare("SELECT current_approved_model_id FROM drawing_revisions WHERE id = ?")
      .get(model.revisionId) as { current_approved_model_id: string | null } | undefined;
    const isCurrentApproved = revision !== undefined && revision.current_approved_model_id === model.id;
    return {
      model: {
        modelId: model.id,
        modelLabel: model.number,
        drawingId: model.drawingId,
        revisionId: model.revisionId,
        runId: model.runId,
        reviewStatus: model.reviewStatus,
        isCurrentApproved,
        generatedAt: model.generatedAt,
        productionVerified: model.productionVerified,
        validationSummary:
          model.validationSummary === undefined
            ? null
            : {
                solidWorksVersion: model.validationSummary.solidWorksVersion,
                featureCount: model.validationSummary.featureCount,
                bodyCount: model.validationSummary.bodyCount,
                rebuildStatus: model.validationSummary.rebuildStatus
              },
        buildReportSummary: model.buildReportSummary ?? null
      },
      artifacts: artifactRows.map((row) => ({
        artifactId: row.id,
        kind: row.kind,
        fileName: row.file_name,
        sizeBytes: row.size_bytes,
        sha256: row.sha256
      })),
      reviews: reviewRows.map((row) => ({
        reviewId: row.id,
        result: row.result,
        reviewerId: row.reviewer_id,
        comment: row.comment,
        createdAt: row.created_at
      }))
    };
  }

  /** Model list items of one Revision, oldest first (the Revision detail list). */
  listModelsByRevision(revisionId: string): readonly ModelListItemView[] {
    const rows = this.db
      .prepare("SELECT * FROM models WHERE revision_id = ? ORDER BY generated_at ASC, id ASC")
      .all(revisionId) as unknown as ModelRow[];
    const revision = this.db
      .prepare("SELECT current_approved_model_id FROM drawing_revisions WHERE id = ?")
      .get(revisionId) as { current_approved_model_id: string | null } | undefined;
    const currentApprovedModelId = revision?.current_approved_model_id ?? null;
    return rows.map((row) => ({
      modelId: row.id,
      modelLabel: row.number,
      reviewStatus: row.review_status,
      isCurrentApproved: row.id === currentApprovedModelId,
      generatedAt: row.generated_at,
      runId: row.run_id
    }));
  }

  /**
   * Dashboard pending-review items: every PENDING_REVIEW Model joined with its
   * Drawing and Revision, ordered by `models.generated_at` ascending (the
   * review queue). Each item carries the resolved drawing number and the
   * Revision label so the UI can render the queue without extra lookups.
   */
  listPendingReviewItems(): WorkspaceDashboardView["pendingReviews"][number][] {
    const rows = this.db
      .prepare(
        "SELECT m.id AS model_id, m.number AS model_number, " +
          "d.id AS drawing_id, d.drawing_number AS drawing_number, " +
          "r.id AS revision_id, r.sequence AS revision_sequence " +
          "FROM models m " +
          "JOIN drawings d ON d.id = m.drawing_id " +
          "JOIN drawing_revisions r ON r.id = m.revision_id " +
          "WHERE m.review_status = 'PENDING_REVIEW' " +
          "ORDER BY m.generated_at ASC"
      )
      .all() as unknown as Array<{
      model_id: string;
      model_number: string;
      drawing_id: string;
      drawing_number: string;
      revision_id: string;
      revision_sequence: number;
    }>;
    return rows.map((row) => ({
      drawingId: row.drawing_id,
      drawingNumber: row.drawing_number,
      revisionLabel: revisionLabel(row.revision_sequence),
      revisionId: row.revision_id,
      modelId: row.model_id,
      modelLabel: row.model_number
    }));
  }

  /**
   * Dashboard pending-clarification items: every OPEN Clarification Request
   * with its Drawing, Revision, Run and open question count, oldest first.
   * Never truncated; the UI decides how many to show.
   */
  listPendingClarificationItems(): WorkspaceDashboardView["pendingClarifications"][number][] {
    const rows = this.db
      .prepare(
        "SELECT c.id AS request_id, run.id AS run_id, run.number AS run_number, " +
          "d.id AS drawing_id, d.drawing_number AS drawing_number, " +
          "rev.sequence AS revision_sequence, " +
          "(SELECT COUNT(*) FROM clarification_questions q WHERE q.request_id = c.id) AS question_count " +
          "FROM clarification_requests c " +
          "JOIN runs run ON run.id = c.run_id " +
          "JOIN drawings d ON d.id = run.drawing_id " +
          "JOIN drawing_revisions rev ON rev.id = c.revision_id " +
          "WHERE c.status = 'OPEN' " +
          "ORDER BY c.created_at ASC, c.id ASC"
      )
      .all() as unknown as Array<{
      run_id: string;
      run_number: string;
      drawing_id: string;
      drawing_number: string;
      revision_sequence: number;
      question_count: number;
    }>;
    return rows.map((row) => ({
      drawingId: row.drawing_id,
      drawingNumber: row.drawing_number,
      revisionLabel: revisionLabel(row.revision_sequence),
      runId: row.run_id,
      runLabel: row.run_number,
      openQuestionCount: row.question_count
    }));
  }

  /**
   * Small runtime validator of the persisted validation summary (P5
   * truthfulness hardening): the stored JSON was written from the STRICTLY
   * validated Result Manifest, so a row whose summary is unparsable or does
   * not match the domain shape is corrupt and fails truthfully instead of
   * surfacing an unvalidated structure. Mirrors the strictness of the manifest
   * contract: non-empty strings, positive safe integers, a legal rebuild
   * status and an array of non-empty assumption strings.
   */
  private parseValidationSummary(json: string, modelId: string): ModelValidationSummary {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new RunnerInvariantError(
        `Stored model ${modelId} has an unparsable validation summary`,
        { modelId }
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new RunnerInvariantError(
        `Stored model ${modelId} has a validation summary that is not a JSON object`,
        { modelId }
      );
    }
    const value = parsed as Record<string, unknown>;
    const assertNonEmpty = (field: string): string => {
      const candidate = value[field];
      if (typeof candidate !== "string" || candidate.length === 0) {
        throw new RunnerInvariantError(
          `Stored model ${modelId} has an invalid validation summary field ${field}`,
          { modelId, field }
        );
      }
      return candidate;
    };
    const assertPositiveInteger = (field: string): number => {
      const candidate = value[field];
      if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) {
        throw new RunnerInvariantError(
          `Stored model ${modelId} has an invalid validation summary field ${field}`,
          { modelId, field }
        );
      }
      return candidate;
    };
    const solidWorksVersion = assertNonEmpty("solidWorksVersion");
    const units = assertNonEmpty("units");
    const projectionDecision = assertNonEmpty("projectionDecision");
    const featureCount = assertPositiveInteger("featureCount");
    const bodyCount = assertPositiveInteger("bodyCount");
    const rebuildStatus = value.rebuildStatus;
    if (rebuildStatus !== "PASSED" && rebuildStatus !== "FAILED") {
      throw new RunnerInvariantError(
        `Stored model ${modelId} has an invalid validation summary rebuildStatus`,
        { modelId, rebuildStatus }
      );
    }
    const unresolvedAssumptions = value.unresolvedAssumptions;
    if (!Array.isArray(unresolvedAssumptions)) {
      throw new RunnerInvariantError(
        `Stored model ${modelId} has an invalid validation summary unresolvedAssumptions`,
        { modelId }
      );
    }
    for (const assumption of unresolvedAssumptions) {
      if (typeof assumption !== "string" || assumption.length === 0) {
        throw new RunnerInvariantError(
          `Stored model ${modelId} has an invalid validation summary unresolvedAssumptions item`,
          { modelId }
        );
      }
    }
    return {
      solidWorksVersion,
      units,
      projectionDecision,
      featureCount,
      bodyCount,
      rebuildStatus,
      unresolvedAssumptions: unresolvedAssumptions as readonly string[]
    };
  }

  /**
   * The immutable original source file the frozen snapshot references (Phase 4,
   * P4-1): revision source-file metadata + the ledger-relative path. Returns
   * `null` when the Revision no longer exists (a deleted Revision leaves the
   * Run's input unresolvable — the adapter fails closed at PREPARING).
   */
  getRunInputSource(
    runId: string
  ): (InputAdapterSourceRef & { relativePath: string }) | null {
    const snapshot = this.getRunSnapshot(runId);
    const revision = this.store.getRevision(snapshot.revisionId);
    if (revision === null) return null;
    const file = revision.sourceFile;
    return {
      fileName: file.fileName,
      format: file.format,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      relativePath: file.relativePath
    };
  }

  getRunDetail(runId: string): RunDetailView {
    const row = this.getRunRow(runId);
    if (row === null) {
      throw new NotFoundError(`Run ${runId} was not found`, { runId });
    }
    const events = this.listRunEvents(runId);
    return {
      run: this.toRunDetailRun(row),
      events,
      lastEventSequence: events.reduce((max, event) => Math.max(max, event.sequence), 0)
    };
  }

  /** Run list items of one Revision, newest first. */
  listRunItemsByRevision(revisionId: string): RunListItemView[] {
    return this.listRunItems("revision_id = ?", revisionId);
  }

  /** Run list items of one Drawing, newest first. */
  listRunItemsByDrawing(drawingId: string): RunListItemView[] {
    return this.listRunItems("drawing_id = ?", drawingId);
  }

  /** Every persisted Run, newest first (the workspace-wide Run list). */
  listAllRunItems(): RunListItemView[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC, id ASC")
      .all() as unknown as RunRow[];
    return rows.map((row) => this.toRunListItem(row));
  }

  /**
   * Ordered event backlog of one Run starting at `fromSequence` (inclusive).
   * Throws `NotFoundError` when the Run does not exist, so a subscription can
   * never silently attach to a phantom Run.
   */
  listRunEventsFrom(runId: string, fromSequence: number): readonly RunEvent[] {
    assertSafeIdToken("runId", runId);
    const row = this.getRunRow(runId);
    if (row === null) {
      throw new NotFoundError(`Run ${runId} was not found`, { runId });
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM run_events WHERE run_id = ? AND sequence >= ? ORDER BY sequence ASC"
      )
      .all(runId, fromSequence) as unknown as RunEventRow[];
    return rows.map((event) => this.mapRunEvent(event));
  }

  /** Dashboard current-Run read: the single RUNNING Run, or null. */
  getCurrentRunDetail(): RunDetailView["run"] | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE status = 'RUNNING' LIMIT 1")
      .get() as RunRow | undefined;
    return row === undefined ? null : this.toRunDetailRun(row);
  }

  /** Dashboard queue read: labels of QUEUED Runs in claim order. */
  getQueuedRunLabels(): readonly string[] {
    const rows = this.db
      .prepare("SELECT number FROM runs WHERE status = 'QUEUED' ORDER BY created_at ASC, id ASC")
      .all() as unknown as Array<{ number: string }>;
    return rows.map((row) => row.number);
  }

  /** Ordered event stream of one Run (ascending sequence). */
  listRunEvents(runId: string): RunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC")
      .all(runId) as unknown as RunEventRow[];
    return rows.map((row) => this.mapRunEvent(row));
  }

  // -------------------------------------------------------------------------
  // Event append with transactional projection
  // -------------------------------------------------------------------------

  /**
   * Appends a batch of events inside one transaction. The per-Run `sequence`
   * is allocated by the database (max + 1 under the transaction's write lock,
   * backed by the `run_events(run_id, sequence)` unique constraint), so
   * sequences are strictly monotonic without gaps or duplicates. The read-model
   * projection (stage/activity/progress/status/timestamps/failure/clarification/
   * model/cancellation) is updated in the SAME transaction — an event and its
   * projection are never observable apart, and any failure rolls back both.
   *
   * Invariants enforced per batch: the attempt must be a persisted attempt of
   * this Run; a QUEUED Run accepts only cancellation events (execution events
   * require RUNNING); a terminal event must be the single last event of the
   * batch; timestamps are canonicalized to UTC ISO on write.
   */
  appendRunEvents(input: AppendRunEventsInput): readonly RunEvent[] {
    assertSafeIdToken("attemptId", input.attemptId);
    if (input.entries.length === 0) {
      throw new InvalidArgumentError("appendRunEvents requires at least one event entry");
    }
    return this.db.transaction(() => {
      const row = this.getRunRow(input.runId);
      if (row === null) {
        throw new NotFoundError(`Run ${input.runId} was not found`, { runId: input.runId });
      }
      const status = row.status as RunStatus;
      if (isRunTerminal(status)) {
        throw new RunnerInvariantError(
          `Run ${input.runId} is ${status}; terminal Runs accept no further events`,
          { runId: input.runId, status }
        );
      }
      // The event envelope always references a PERSISTED attempt of this Run
      // (the claim mints the attempt row before the executor emits events).
      const attempt = this.db
        .prepare("SELECT run_id, status FROM run_attempts WHERE id = ?")
        .get(input.attemptId) as { run_id: string; status: string | null } | undefined;
      if (attempt === undefined) {
        throw new NotFoundError(`Attempt ${input.attemptId} was not found`, {
          attemptId: input.attemptId
        });
      }
      if (attempt.run_id !== input.runId) {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} belongs to run ${attempt.run_id}, not ${input.runId}`
        );
      }
      // P3-3 review fix: NON-TERMINAL execution events (stage / activity /
      // progress / clarification / turn / metadata / manifest / artifact
      // validation) may only be appended while the referenced attempt is
      // ACTIVE — a finished or cancelled attempt must never keep emitting
      // execution events. Terminal events (Completed / Failed /
      // ClarificationRequired / CancellationConfirmed) are exempt: the
      // recovery scan legitimately appends a Failed interruption event while
      // repairing a historical wedge whose attempt is already terminal.
      for (const entry of input.entries) {
        if (isTerminalRunEventType(entry.payload.type)) continue;
        if (attempt.status !== "ACTIVE") {
          throw new RunnerInvariantError(
            `Run ${input.runId} is ${status}; appending ${entry.payload.type} requires the ACTIVE attempt ${input.attemptId}, which is ${attempt.status ?? "unset"}`,
            { runId: input.runId, attemptId: input.attemptId, attemptStatus: attempt.status }
          );
        }
      }
      // QUEUED Runs only accept the cancellation pair: execution events require
      // the Run to have been claimed (RUNNING).
      if (status === "QUEUED") {
        for (const entry of input.entries) {
          if (!isCancellationRunEventType(entry.payload.type)) {
            throw new RunnerInvariantError(
              `Run ${input.runId} is QUEUED; only cancellation events may be appended before it is RUNNING (got ${entry.payload.type})`,
              { runId: input.runId, eventType: entry.payload.type }
            );
          }
        }
      }

      const base = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS seq, MAX(occurred_at) AS last_occurred " +
            "FROM run_events WHERE run_id = ?"
        )
        .get(input.runId) as { seq: number; last_occurred: string | null };

      // Validate the whole batch (payload shape, canonical timestamps with
      // non-decreasing numeric order, terminal-event position) before any row
      // is written.
      let floorMs = base.last_occurred === null ? -Infinity : Date.parse(base.last_occurred);
      const validated: Array<{ payload: RunEventPayload; occurredAt: string }> = [];
      for (const entry of input.entries) {
        const occurredAt = this.toCanonicalIso(entry.occurredAt, "event occurredAt");
        const occurredMs = Date.parse(occurredAt);
        if (occurredMs < floorMs) {
          throw new RunnerInvariantError(
            `Event occurredAt ${entry.occurredAt} is earlier than the previous event time on run ${input.runId}`,
            { runId: input.runId, occurredAt: entry.occurredAt }
          );
        }
        floorMs = occurredMs;
        validated.push({ payload: this.validatePayload(entry.payload), occurredAt });
      }
      validated.forEach((entry, index) => {
        if (isTerminalRunEventType(entry.payload.type) && index !== validated.length - 1) {
          throw new RunnerInvariantError(
            `Terminal run event ${entry.payload.type} must be the single last event of an append batch on run ${input.runId}`,
            { runId: input.runId, eventType: entry.payload.type }
          );
        }
      });

      const state: RunProjection = {
        status: row.status as RunStatus,
        stage: row.stage as RunStage | null,
        activity: row.activity,
        progressPercent: row.progress_percent,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        failureCode: row.failure_code as RunFailureCode | null,
        failureMessage: row.failure_message,
        clarificationRequestId: row.clarification_request_id,
        modelId: row.model_id,
        cancellationRequestedAt: row.cancellation_requested_at,
        cancellationRequestedReason: row.cancellation_requested_reason,
        cancellationConfirmedAt: row.cancellation_confirmed_at
      };

      const insert = this.db.prepare(
        "INSERT INTO run_events (run_id, sequence, contract_version, attempt_id, payload_json, occurred_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      );
      const events: RunEvent[] = [];
      validated.forEach((entry, index) => {
        const sequence = base.seq + index + 1;
        this.projectEvent(state, entry.payload, entry.occurredAt, input.runId);
        insert.run(
          input.runId,
          sequence,
          RUN_EVENT_CONTRACT_VERSION,
          input.attemptId,
          JSON.stringify(entry.payload),
          entry.occurredAt
        );
        events.push({
          contractVersion: RUN_EVENT_CONTRACT_VERSION,
          runId: input.runId,
          attemptId: input.attemptId,
          sequence,
          occurredAt: entry.occurredAt,
          ...entry.payload
        });
      });
      this.persistProjection(input.runId, state);
      // The event stream notification fires ONLY after this batch's enclosing
      // transaction commits (the DB commit hook runs after the outermost
      // COMMIT; a later outer rollback silently drops the hook). Subscribers
      // therefore never observe events that were not durably written.
      this.db.onCommit(() => this.notifyCommitted(events));
      return events;
    });
  }

  // -------------------------------------------------------------------------
  // Clarification persistence (Phase 3, P3-3)
  // -------------------------------------------------------------------------

  /**
   * Persists an OPEN Clarification Request with its question rows in ONE
   * transaction and returns the freshly minted request (request id and every
   * question/option id are generated here — the caller's ids are never
   * trusted as primary keys). `ClarificationRequired` is terminal: answers
   * arrive in a later batch and never resume the old Run.
   */
  persistClarificationRequest(input: {
    runId: string;
    questions: readonly ClarificationQuestion[];
    createdAt: string;
  }): ClarificationRequest {
    assertSafeIdToken("runId", input.runId);
    const createdAt = this.toCanonicalIso(input.createdAt, "clarification createdAt");
    return this.db.transaction(() => {
      const run = this.getRunRow(input.runId);
      if (run === null) {
        throw new NotFoundError(`Run ${input.runId} was not found`, { runId: input.runId });
      }
      const id = generateId();
      const questions = input.questions.map((question) => ({
        ...question,
        id: generateId(),
        ...(question.options === undefined
          ? {}
          : { options: question.options.map((option) => ({ ...option, id: generateId() })) })
      }));
      this.db
        .prepare(
          "INSERT INTO clarification_requests (id, run_id, revision_id, status, created_at) " +
            "VALUES (?, ?, ?, 'OPEN', ?)"
        )
        .run(id, input.runId, run.revision_id, createdAt);
      const insert = this.db.prepare(
        "INSERT INTO clarification_questions (id, request_id, sort_order, payload_json) " +
          "VALUES (?, ?, ?, ?)"
      );
      questions.forEach((question, index) => {
        insert.run(question.id, id, index + 1, JSON.stringify(question));
      });
      return {
        id,
        runId: input.runId,
        revisionId: run.revision_id,
        status: "OPEN",
        questions,
        answers: [],
        createdAt
      };
    });
  }

  /** The persisted Clarification Request with its ordered questions and answers, or null. */
  getClarificationRequest(requestId: string): ClarificationRequest | null {
    assertSafeIdToken("requestId", requestId);
    const row = this.db
      .prepare("SELECT * FROM clarification_requests WHERE id = ?")
      .get(requestId) as
      | {
          id: string;
          run_id: string;
          revision_id: string;
          status: string;
          created_at: string;
        }
      | undefined;
    if (row === undefined) return null;
    if (!CLARIFICATION_STATUSES.includes(row.status as ClarificationStatus)) {
      throw new RunnerInvariantError(
        `Stored clarification request ${row.id} has an unknown status ${row.status}`,
        { clarificationRequestId: row.id, status: row.status }
      );
    }
    const questionRows = this.db
      .prepare(
        "SELECT payload_json FROM clarification_questions WHERE request_id = ? ORDER BY sort_order ASC"
      )
      .all(requestId) as unknown as Array<{ payload_json: string }>;
    const answerRows = this.db
      .prepare(
        "SELECT id, question_id, value_json, answered_at, answered_by " +
          "FROM clarification_answers WHERE request_id = ? ORDER BY rowid ASC"
      )
      .all(requestId) as unknown as Array<{
      id: string;
      question_id: string;
      value_json: string;
      answered_at: string;
      answered_by: string;
    }>;
    return {
      id: row.id,
      runId: row.run_id,
      revisionId: row.revision_id,
      status: row.status as ClarificationStatus,
      questions: questionRows.map((question) => JSON.parse(question.payload_json) as ClarificationQuestion),
      // Phase 3 (P3-4): persisted answers are loaded back with the request; a
      // submitted request is ANSWERED and its Run stays terminal.
      answers: answerRows.map((answer) => ({
        id: answer.id,
        questionId: answer.question_id,
        value: JSON.parse(answer.value_json) as ClarificationAnswer["value"],
        answeredAt: answer.answered_at,
        answeredBy: answer.answered_by
      })),
      createdAt: row.created_at
    };
  }

  /** Aggregate read of one Clarification Request, or a structured NOT_FOUND. */
  getClarificationView(clarificationRequestId: string): ClarificationView {
    const request = this.getClarificationRequest(clarificationRequestId);
    if (request === null) {
      throw new NotFoundError(
        `Clarification request ${clarificationRequestId} was not found`,
        { clarificationRequestId }
      );
    }
    return this.toClarificationView(request);
  }

  /**
   * Persists submitted answers of an OPEN Clarification Request in ONE
   * transaction: every answer row is inserted (answer ids are minted here —
   * caller-supplied ids are never trusted as primary keys), the answers are
   * converted into deterministic Revision Facts (source CLARIFICATION,
   * `sourceRunId` = the answering Run, P4-4), the request is marked ANSWERED
   * and the aggregate view is returned. The RUN is never touched: a
   * CLARIFICATION_REQUIRED Run stays terminal and is never resumed — a new
   * Run is created manually for any follow-up modeling and freezes the
   * clarified facts into its Input Snapshot.
   */
  submitClarificationAnswers(input: {
    clarificationRequestId: string;
    answers: readonly ClarificationAnswer[];
    answeredAt: string;
    answeredBy: string;
  }): ClarificationView {
    assertSafeIdToken("clarificationRequestId", input.clarificationRequestId);
    if (input.answers.length === 0) {
      throw new InvalidArgumentError("submitClarificationAnswers requires at least one answer");
    }
    const answeredAt = this.toCanonicalIso(input.answeredAt, "answer answeredAt");
    return this.db.transaction(() => {
      const request = this.getClarificationRequest(input.clarificationRequestId);
      if (request === null) {
        throw new NotFoundError(
          `Clarification request ${input.clarificationRequestId} was not found`,
          { clarificationRequestId: input.clarificationRequestId }
        );
      }
      if (request.status !== "OPEN") {
        throw new RunnerInvariantError(
          `Clarification request ${request.id} is ${request.status}; only an OPEN request can be answered`,
          { clarificationRequestId: request.id, status: request.status }
        );
      }
      const questionsById = new Map(
        request.questions.map((question) => [question.id, question] as const)
      );
      // Every answer is validated (question membership, duplicate question,
      // value shape against the question type/options) BEFORE any row is
      // written, so a malformed batch can never partially commit.
      const seenQuestions = new Set<string>();
      const answers = input.answers.map((answer) => {
        const question = questionsById.get(answer.questionId);
        if (question === undefined) {
          throw new InvalidArgumentError(
            `Question ${answer.questionId} does not belong to Clarification request ${request.id}`,
            { clarificationRequestId: request.id, questionId: answer.questionId }
          );
        }
        if (seenQuestions.has(answer.questionId)) {
          throw new InvalidArgumentError(
            `Question ${answer.questionId} is answered more than once on Clarification request ${request.id}`,
            { clarificationRequestId: request.id, questionId: answer.questionId }
          );
        }
        seenQuestions.add(answer.questionId);
        this.assertAnswerValue(answer.value, question);
        return { ...answer, id: generateId() };
      });
      const insert = this.db.prepare(
        "INSERT INTO clarification_answers " +
          "(id, request_id, question_id, value_json, answered_at, answered_by) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const answer of answers) {
        insert.run(
          answer.id,
          request.id,
          answer.questionId,
          JSON.stringify(answer.value),
          answeredAt,
          input.answeredBy
        );
      }
      // P4-4: the same transaction also materializes the answers as Revision
      // Facts. Each fact is deterministic (stable id derived from the revision
      // and the question text, value formatted per answer kind) and replaces
      // any previous fact of the same (revision, field) — a repeated or
      // re-asked clarification can never leave two contradictory facts behind.
      const deleteFact = this.db.prepare(
        "DELETE FROM revision_facts WHERE revision_id = ? AND field = ?"
      );
      for (const fact of this.deriveClarificationFacts(request, answers, answeredAt)) {
        deleteFact.run(fact.revisionId, fact.field);
        this.store.insertRevisionFact(fact);
      }
      this.db
        .prepare("UPDATE clarification_requests SET status = 'ANSWERED' WHERE id = ?")
        .run(request.id);
      return this.toClarificationView({
        ...request,
        status: "ANSWERED",
        answers,
        answeredAt
      });
    });
  }

  /**
   * Deterministic Revision Facts produced by one validated answer batch
   * (P4-4). Mirrors the product convention of the Mock Repository
   * (`factsFromAnswers`), so the Runner persists exactly the records the UI
   * fixture would produce:
   *
   * - one fact per answered question, field = the persisted question text;
   * - value formatted per answer kind: dimension `"12 mm"`, text verbatim,
   *   choice resolved to the option label (optionId fallback);
   * - stable id `fact-{revisionId}-{field}` — re-answering the same question
   *   always targets the same record, so the upsert in
   *   `submitClarificationAnswers` replaces instead of duplicating;
   * - source `CLARIFICATION` with `sourceRunId` = the answering Run and
   *   `createdAt` = the batch answeredAt.
   */
  private deriveClarificationFacts(
    request: ClarificationRequest,
    answers: readonly ClarificationAnswer[],
    answeredAt: string
  ): RevisionFact[] {
    const questionsById = new Map(
      request.questions.map((question) => [question.id, question] as const)
    );
    return answers.map((answer) => {
      const question = questionsById.get(answer.questionId) as ClarificationQuestion;
      const field = question.question;
      let value: string;
      switch (answer.value.kind) {
        case "dimension":
          value = `${answer.value.value} ${answer.value.unit}`;
          break;
        case "text":
          value = answer.value.value;
          break;
        case "choice": {
          const optionId = answer.value.optionId;
          value =
            question.options?.find((option) => option.id === optionId)?.label ?? optionId;
          break;
        }
        default:
          // Unreachable after `assertAnswerValue`; never persist an unknown
          // answer kind.
          throw new RunnerInvariantError(
            `Clarification answer on question ${question.id} has an unsupported kind`,
            { clarificationRequestId: request.id, questionId: question.id }
          );
      }
      return {
        id: `fact-${request.revisionId}-${field}`,
        revisionId: request.revisionId,
        field,
        value,
        source: "CLARIFICATION",
        sourceRunId: request.runId,
        createdAt: answeredAt
      };
    });
  }

  /** Shape-checks one answer value against the persisted question it answers. */
  private assertAnswerValue(
    value: ClarificationAnswer["value"],
    question: ClarificationQuestion
  ): void {
    const expectedKind: Record<ClarificationQuestionType, ClarificationAnswer["value"]["kind"]> = {
      dimension: "dimension",
      text: "text",
      choice: "choice"
    };
    if (value.kind !== expectedKind[question.type]) {
      throw new InvalidArgumentError(
        `Question ${question.id} expects a ${question.type} answer, got ${value.kind}`,
        { questionId: question.id, questionType: question.type, answerKind: value.kind }
      );
    }
    switch (value.kind) {
      case "dimension":
        if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
          throw new InvalidArgumentError(
            `Question ${question.id} dimension answer must be a finite number`
          );
        }
        if (typeof value.unit !== "string" || value.unit.length === 0) {
          throw new InvalidArgumentError(
            `Question ${question.id} dimension answer unit must be a non-empty string`
          );
        }
        return;
      case "text":
        if (typeof value.value !== "string" || value.value.length === 0) {
          throw new InvalidArgumentError(
            `Question ${question.id} text answer must be a non-empty string`
          );
        }
        return;
      case "choice":
        if (
          !(question.options ?? []).some((option) => option.id === value.optionId)
        ) {
          throw new InvalidArgumentError(
            `Option ${value.optionId} is not a valid option of question ${question.id}`,
            { questionId: question.id, optionId: value.optionId }
          );
        }
        return;
    }
  }

  /** Maps a persisted request to the aggregate ClarificationView shape. */
  private toClarificationView(request: ClarificationRequest): ClarificationView {
    return {
      clarificationRequestId: request.id,
      runId: request.runId,
      revisionId: request.revisionId,
      status: request.status,
      questions: request.questions.map((question) => ({
        questionId: question.id,
        type: question.type,
        question: question.question,
        hint: question.hint ?? null,
        unit: question.unit ?? null,
        options: (question.options ?? []).map((option) => ({ id: option.id, label: option.label }))
      })),
      answers: request.answers.map((answer) => ({
        answerId: answer.id,
        questionId: answer.questionId,
        value: answer.value,
        answeredAt: answer.answeredAt
      })),
      createdAt: request.createdAt
    };
  }

  /**
   * Timestamp of the persisted CancellationRequested event projection, or null.
   * The cancel coordinator uses it so a concurrent / retried RUNNING cancel
   * persists exactly ONE request event.
   */
  getCancellationRequestedAt(runId: string): string | null {
    assertSafeIdToken("runId", runId);
    const row = this.db
      .prepare("SELECT cancellation_requested_at AS requested_at FROM runs WHERE id = ?")
      .get(runId) as { requested_at: string | null } | undefined;
    return row === undefined ? null : row.requested_at;
  }

  // -------------------------------------------------------------------------
  // Run deletion (Phase 8)
  // -------------------------------------------------------------------------

  /**
   * Deletes ONE Run and every row it owns in ONE transaction:
   *
   * - the Run must exist and belong to the exact drawing/revision identity
   *   pair (a mismatched pair is an invariant error, never a silent no-op);
   * - only COMPLETED / FAILED / CANCELLED Runs delete (the `canDeleteRun`
   *   domain guard): QUEUED and RUNNING Runs are active work and reject with
   *   `RUN_NOT_TERMINAL`, and a CLARIFICATION_REQUIRED Run keeps its
   *   outstanding clarification session (`RUN_HAS_PENDING_CLARIFICATION`);
   * - child rows are removed in FK order inside the same transaction:
   *   clarification answers/questions/requests, run events, run attempts, the
   *   frozen input snapshot, artifact metadata, model reviews and Models the
   *   Run published, then the Run row. A Model that was the Revision's
   *   current-approved model has its pointer cleared first (the reference is
   *   handled, never left dangling);
   * - the returned `attemptSequences` lets the facade remove each attempt's
   *   isolated workspace subtree only after the transaction committed.
   */
  deleteRun(runId: string, drawingId: string, revisionId: string): DeleteRunResult {
    assertSafeIdToken("runId", runId);
    return this.db.transaction(() => {
      const row = this.getRunRow(runId);
      if (row === null) {
        throw new NotFoundError(`Run ${runId} was not found`, { runId });
      }
      if (row.drawing_id !== drawingId || row.revision_id !== revisionId) {
        throw new RunnerInvariantError(
          `Run ${runId} belongs to Drawing ${row.drawing_id} / Revision ${row.revision_id}, ` +
            `not Drawing ${drawingId} / Revision ${revisionId}`,
          {
            runId,
            drawingId,
            revisionId,
            runDrawingId: row.drawing_id,
            runRevisionId: row.revision_id
          }
        );
      }
      const decision = canDeleteRun(row.status as RunStatus);
      if (!decision.canDelete) {
        throw new RunnerInvariantError(
          `Run ${runId} is ${row.status}; only ${DELETABLE_RUN_STATUSES.join(", ")} Runs can be ` +
            `deleted (${decision.reason ?? "RUN_NOT_TERMINAL"})`,
          { runId, status: row.status, reason: decision.reason }
        );
      }
      // Collect every attempt sequence so the facade can clean up each
      // attempt's isolated workspace subtree after the transaction commits.
      const attemptRows = this.db
        .prepare(
          "SELECT attempt_sequence FROM run_attempts WHERE run_id = ? ORDER BY attempt_sequence ASC"
        )
        .all(runId) as Array<{ attempt_sequence: number }>;
      const attemptSequences = attemptRows.map((attempt) => attempt.attempt_sequence);

      // Clarification items chain: answers -> questions -> request -> Run.
      const requests = this.db
        .prepare("SELECT id FROM clarification_requests WHERE run_id = ?")
        .all(runId) as Array<{ id: string }>;
      for (const request of requests) {
        this.db.prepare("DELETE FROM clarification_answers WHERE request_id = ?").run(request.id);
        this.db.prepare("DELETE FROM clarification_questions WHERE request_id = ?").run(request.id);
      }
      this.db.prepare("DELETE FROM clarification_requests WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM run_attempts WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM run_input_snapshots WHERE run_id = ?").run(runId);

      // Every Model the Run published (with its reviews and artifact metadata)
      // is removed. A Model that is the Revision's current-approved model has
      // its reference handled first: the pointer is cleared so the Revision
      // never points at a deleted Model.
      const models = this.db
        .prepare("SELECT id FROM models WHERE run_id = ?")
        .all(runId) as Array<{ id: string }>;
      for (const model of models) {
        const revision = this.db
          .prepare("SELECT current_approved_model_id FROM drawing_revisions WHERE id = ?")
          .get(revisionId) as { current_approved_model_id: string | null } | undefined;
        if (revision !== undefined && revision.current_approved_model_id === model.id) {
          this.store.updateCurrentApprovedModelPointer(revisionId, null, new Date().toISOString());
        }
        this.db.prepare("DELETE FROM model_reviews WHERE model_id = ?").run(model.id);
        this.db.prepare("DELETE FROM cost_reports WHERE model_id = ?").run(model.id);
        this.db.prepare("UPDATE modeling_feedback SET model_id=NULL,review_id=NULL WHERE model_id=?").run(model.id);
      }
      // Artifact rows are not FK-bound to the model, so the run-scoped delete
      // is a safety net for rows recorded without a model of their own.
      this.db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM models WHERE run_id = ?").run(runId);

      this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
      return { runId, attemptSequences };
    });
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  private projectEvent(
    state: RunProjection,
    payload: RunEventPayload,
    occurredAt: string,
    runId: string
  ): void {
    switch (payload.type) {
      case "StageChanged":
        state.stage = payload.stage;
        if (payload.activity !== undefined) state.activity = payload.activity;
        this.markExecutionStart(state, occurredAt);
        break;
      case "ActivityUpdated":
        state.activity = payload.activity;
        this.markExecutionStart(state, occurredAt);
        break;
      case "ProgressUpdated":
        state.progressPercent = payload.progressPercent;
        if (payload.activity !== undefined) state.activity = payload.activity;
        this.markExecutionStart(state, occurredAt);
        break;
      case "ClarificationRequired":
        // A business outcome, never a failure: no failure fields are written.
        state.status = this.assertTransition(state.status, "CLARIFICATION_REQUIRED", runId);
        state.clarificationRequestId = payload.clarificationRequestId;
        this.finishExecution(state, occurredAt);
        break;
      case "Completed": {
        // Fake COMPLETED carries no modelId and creates no models row. A
        // provided modelId must already resolve to a persisted Model.
        if (payload.modelId !== undefined) {
          const model = this.db.prepare("SELECT id FROM models WHERE id = ?").get(payload.modelId);
          if (model === undefined) {
            throw new RunnerInvariantError(
              `Completed event of run ${runId} publishes model ${payload.modelId} which does not exist`,
              { runId, modelId: payload.modelId }
            );
          }
        }
        state.status = this.assertTransition(state.status, "COMPLETED", runId);
        state.modelId = payload.modelId ?? null;
        this.finishExecution(state, occurredAt);
        break;
      }
      case "Failed":
        state.status = this.assertTransition(state.status, "FAILED", runId);
        state.failureCode = payload.failureCode;
        state.failureMessage = payload.failureMessage ?? null;
        this.finishExecution(state, occurredAt);
        break;
      case "CancellationRequested":
        // Request alone never ends the Run; only the confirmed event does.
        state.cancellationRequestedAt = occurredAt;
        state.cancellationRequestedReason = payload.reason ?? null;
        break;
      case "CancellationConfirmed":
        state.status = this.assertTransition(state.status, "CANCELLED", runId);
        state.cancellationConfirmedAt = occurredAt;
        this.finishExecution(state, occurredAt);
        break;
      case "AgentTurnCompleted":
      case "RuntimeMetadataUpdated":
      case "ResultManifestReceived":
      case "ArtifactValidationFailed":
        // Structured execution records without read-model columns of their own.
        this.markExecutionStart(state, occurredAt);
        break;
    }
  }

  /** First observed execution event of a RUNNING Run records `started_at`. */
  private markExecutionStart(state: RunProjection, occurredAt: string): void {
    if (state.status === "RUNNING" && state.startedAt === null) {
      state.startedAt = occurredAt;
    }
  }

  /**
   * Terminal events record `completed_at` and clear the live execution fields
   * (stage/activity/progress — execution ended; the walked history lives in
   * the event log).
   */
  private finishExecution(state: RunProjection, occurredAt: string): void {
    state.completedAt = occurredAt;
    state.stage = null;
    state.activity = null;
    state.progressPercent = null;
  }

  private persistProjection(runId: string, state: RunProjection): void {
    this.db
      .prepare(
        "UPDATE runs SET " +
          "status = ?, stage = ?, activity = ?, progress_percent = ?, " +
          "started_at = ?, completed_at = ?, " +
          "failure_code = ?, failure_message = ?, " +
          "clarification_request_id = ?, model_id = ?, " +
          "cancellation_requested_at = ?, cancellation_requested_reason = ?, " +
          "cancellation_confirmed_at = ? " +
          "WHERE id = ?"
      )
      .run(
        state.status,
        state.stage,
        state.activity,
        state.progressPercent,
        state.startedAt,
        state.completedAt,
        state.failureCode,
        state.failureMessage,
        state.clarificationRequestId,
        state.modelId,
        state.cancellationRequestedAt,
        state.cancellationRequestedReason,
        state.cancellationConfirmedAt,
        runId
      );
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** Deep-clones and shape-checks one event payload. */
  private validatePayload(payload: RunEventPayload): RunEventPayload {
    const clone: RunEventPayload = structuredClone(payload);
    // Runtime defense for callers that bypass the TypeScript union: any event
    // type outside the structured contract is rejected before persistence.
    if (!RUN_EVENT_TYPES.includes(clone.type)) {
      throw new InvalidArgumentError(`Unknown run event type: ${String(clone.type)}`, {
        eventType: clone.type
      });
    }
    switch (clone.type) {
      case "StageChanged":
        if (!RUN_STAGES.includes(clone.stage)) {
          throw new InvalidArgumentError(`Unsupported run stage: ${String(clone.stage)}`, {
            stage: clone.stage
          });
        }
        if (clone.activity !== undefined && !this.isNonEmpty(clone.activity)) {
          throw new InvalidArgumentError("StageChanged activity must be a non-empty string");
        }
        break;
      case "ActivityUpdated":
        if (!this.isNonEmpty(clone.activity)) {
          throw new InvalidArgumentError("ActivityUpdated activity must be a non-empty string");
        }
        break;
      case "ProgressUpdated":
        if (!Number.isInteger(clone.progressPercent) || clone.progressPercent < 0 || clone.progressPercent > 100) {
          throw new InvalidArgumentError(
            `ProgressUpdated progressPercent must be an integer within 0..100, got ${clone.progressPercent}`
          );
        }
        if (clone.activity !== undefined && !this.isNonEmpty(clone.activity)) {
          throw new InvalidArgumentError("ProgressUpdated activity must be a non-empty string");
        }
        break;
      case "ClarificationRequired":
        if (!this.isNonEmpty(clone.clarificationRequestId)) {
          throw new InvalidArgumentError(
            "ClarificationRequired clarificationRequestId must be a non-empty string"
          );
        }
        break;
      case "AgentTurnCompleted":
        if (!this.isNonEmpty(clone.turnId)) {
          throw new InvalidArgumentError("AgentTurnCompleted turnId must be a non-empty string");
        }
        break;
      case "RuntimeMetadataUpdated":
        if (typeof clone.metadata !== "object" || clone.metadata === null || Array.isArray(clone.metadata)) {
          throw new InvalidArgumentError("RuntimeMetadataUpdated metadata must be an object");
        }
        break;
      case "ResultManifestReceived":
        if (!this.isNonEmpty(clone.manifestRef)) {
          throw new InvalidArgumentError(
            "ResultManifestReceived manifestRef must be a non-empty string"
          );
        }
        break;
      case "ArtifactValidationFailed":
        if (!RUN_FAILURE_CODES.includes(clone.failureCode)) {
          throw new InvalidArgumentError(
            `ArtifactValidationFailed failureCode is not a valid run failure code: ${String(clone.failureCode)}`
          );
        }
        break;
      case "Completed":
        if (clone.modelId !== undefined && !this.isNonEmpty(clone.modelId)) {
          throw new InvalidArgumentError("Completed modelId must be a non-empty string");
        }
        break;
      case "Failed":
        if (!RUN_FAILURE_CODES.includes(clone.failureCode)) {
          throw new InvalidArgumentError(
            `Failed failureCode is not a valid run failure code: ${String(clone.failureCode)}`
          );
        }
        if (clone.failureMessage !== undefined && !this.isNonEmpty(clone.failureMessage)) {
          throw new InvalidArgumentError("Failed failureMessage must be a non-empty string");
        }
        break;
      case "CancellationRequested":
        if (clone.reason !== undefined && !this.isNonEmpty(clone.reason)) {
          throw new InvalidArgumentError("CancellationRequested reason must be a non-empty string");
        }
        break;
      case "CancellationConfirmed":
        break;
    }
    return clone;
  }

  private assertTransition(current: RunStatus, next: RunStatus, runId: string): RunStatus {
    try {
      return transitionRunStatus(current, next);
    } catch (error) {
      if (error instanceof DomainInvariantError) {
        throw new RunnerInvariantError(
          `Illegal run status transition for ${runId}: ${current} -> ${next}`
        );
      }
      throw error;
    }
  }

  private assertTimestamp(value: string, label: string): number {
    if (typeof value !== "string" || value.length === 0) {
      throw new InvalidArgumentError(`${label} must be a non-empty ISO timestamp`);
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw new InvalidArgumentError(`${label} must be a valid ISO timestamp: ${value}`);
    }
    return parsed;
  }

  /**
   * Canonicalizes a timestamp to UTC ISO-8601 (`...sssZ`). All Run-path writes
   * store the canonical form, so SQL lexicographic ordering equals
   * chronological ordering and persisted values never mix timezone offsets.
   */
  private toCanonicalIso(value: string, label: string): string {
    const parsed = this.assertTimestamp(value, label);
    return new Date(parsed).toISOString();
  }

  private isNonEmpty(value: string): boolean {
    return typeof value === "string" && value.length > 0;
  }

  // -------------------------------------------------------------------------
  // Row access and mapping
  // -------------------------------------------------------------------------

  private nextRunSequence(revisionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(CAST(SUBSTR(number, 2) AS INTEGER)), 0) AS max " +
          "FROM runs WHERE revision_id = ? AND number LIKE 'R%'"
      )
      .get(revisionId) as { max: number };
    return row.max + 1;
  }

  private getRunRow(runId: string): RunRow | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    return row ?? null;
  }

  private readSnapshotFor(runId: string): RunInputSnapshot {
    const snapshotRow = this.db
      .prepare("SELECT payload_json FROM run_input_snapshots WHERE run_id = ?")
      .get(runId) as { payload_json: string } | undefined;
    if (snapshotRow === undefined) {
      throw new RunnerInvariantError(`Run ${runId} has no input snapshot row`, { runId });
    }
    // JSON.parse produces fresh object graphs on every read: mutating a returned
    // snapshot can never corrupt the persisted one.
    return JSON.parse(snapshotRow.payload_json) as RunInputSnapshot;
  }

  private mapRun(row: RunRow, snapshot: RunInputSnapshot): ModelingRun {
    return {
      id: row.id,
      number: row.number,
      drawingId: row.drawing_id,
      revisionId: row.revision_id,
      status: row.status as RunStatus,
      stage: row.stage as RunStage | null,
      inputSnapshot: snapshot,
      createdAt: row.created_at,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code as RunFailureCode }),
      ...(row.failure_message === null ? {} : { failureMessage: row.failure_message }),
      ...(row.clarification_request_id === null
        ? {}
        : { clarificationRequestId: row.clarification_request_id }),
      ...(row.model_id === null ? {} : { modelId: row.model_id })
    };
  }

  private mapRunEvent(row: RunEventRow): RunEvent {
    if (row.attempt_id === null) {
      throw new RunnerInvariantError(
        `Stored run event ${row.run_id}#${row.sequence} has no attempt_id`,
        { runId: row.run_id, sequence: row.sequence }
      );
    }
    // The envelope carries the PERSISTED contract version; a stored row from
    // an unknown/unsupported version is surfaced truthfully instead of being
    // silently relabeled as the current contract.
    if (row.contract_version !== RUN_EVENT_CONTRACT_VERSION) {
      throw new RunnerInvariantError(
        `Stored run event ${row.run_id}#${row.sequence} uses unsupported contract version ${row.contract_version}`,
        { runId: row.run_id, sequence: row.sequence, contractVersion: row.contract_version }
      );
    }
    const payload = JSON.parse(row.payload_json) as RunEventPayload;
    return {
      contractVersion: row.contract_version,
      runId: row.run_id,
      attemptId: row.attempt_id,
      sequence: row.sequence,
      occurredAt: row.occurred_at,
      ...payload
    };
  }

  private toRunDetailRun(row: RunRow): RunDetailView["run"] {
    return {
      runId: row.id,
      runLabel: row.number,
      drawingId: row.drawing_id,
      revisionId: row.revision_id,
      status: row.status,
      stage: row.stage,
      activity: row.activity,
      progressPercent: row.progress_percent,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      failureCode: row.failure_code,
      failureMessage: row.failure_message,
      modelId: row.model_id,
      clarificationRequestId: row.clarification_request_id
    };
  }

  private listRunItems(where: string, id: string): RunListItemView[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE ${where} ORDER BY created_at DESC, id ASC`)
      .all(id) as unknown as RunRow[];
    return rows.map((row) => this.toRunListItem(row));
  }

  private toRunListItem(row: RunRow): RunListItemView {
    return {
      runId: row.id,
      runLabel: row.number,
      status: row.status,
      stage: row.stage,
      createdAt: row.created_at,
      modelId: row.model_id,
      clarificationRequestId: row.clarification_request_id,
      failureCode: row.failure_code
    };
  }
}
