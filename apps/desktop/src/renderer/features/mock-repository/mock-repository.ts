import type {
  Artifact,
  ClarificationAnswer,
  ClarificationRequest,
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  CostEstimateReport,
  CostEstimateResult,
  Drawing,
  DrawingRevision,
  Model,
  ModelingFeedback,
  ModelingRun,
  ModelReview,
  RevisionFact,
  RevisionSourceFile,
  RunEvent,
  RunEventPayload,
  StockType,
  StorageSettings
} from "@swpanel/domain";
import {
  canAnswerClarification,
  canCancelRun,
  canCreateCostEstimateReport,
  canReviewModel,
  canSetCurrentRevision,
  COST_BASES,
  COST_CURRENCIES,
  DomainInvariantError,
  DRAWING_FILE_FORMATS,
  nextRevisionSequence,
  REVISION_FACT_SOURCES,
  revisionLabel,
  RUN_EVENT_CONTRACT_VERSION,
  STOCK_TYPES,
  STORAGE_CONSTRAINTS,
  transitionModelStatus,
  transitionRunStatus
} from "@swpanel/domain";
import type {
  ClarificationView,
  CostReportDetailView,
  CostReportListItemView,
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  ModelDetailView,
  ModelListItemView,
  RevisionDetailView,
  RevisionHistoryView,
  RevisionListItemView,
  RunDetailView,
  RunListItemView,
  RunSubscription,
  StorageSettingsView,
  WorkspaceDashboardView
} from "@swpanel/contracts";
import type { MockRepository as MockRepositoryContract } from "@swpanel/contracts";
import {
  buildAnswersFromInputs,
  buildInputSnapshot,
  computeSyntheticCostResult,
  deepClone,
  deepFreeze,
  factsFromAnswers,
  MOCK_ATTEMPT_ID,
  syntheticMaterialCostPerPiece,
  upsertFactsByField,
  type ClarificationAnswerInput,
  type MockWorld
} from "../../fixtures/index.js";
import { buildScenario, type MockScenario } from "../../fixtures/scenarios.js";
import type { CreateRunInput, MockCommand } from "./command-types.js";

/**
 * Normalized, deterministic, subscribable in-memory Mock Repository.
 *
 * The class implements the `MockRepository` contract from `@swpanel/contracts`
 * (RepositoryReader aggregate views + RepositoryWriter persistence primitives +
 * the canonical domain-transition commands), and additionally exposes a
 * `subscribe`/`dispatch` surface so React view models can observe every
 * applied command.
 *
 * - Deterministic: seeded from `buildScenario`; the same scenario always
 *   produces the same initial world.
 * - Normalized: commands validate against the current world first, then produce
 *   a brand-new world object. The repository never mutates an entity in place,
 *   so readers always observe one atomic snapshot.
 * - Invariants: all lifecycle rules come from `@swpanel/domain`
 *   (`canAnswerClarification`, `canReviewModel`, `canCancelRun`,
 *   `transitionModelStatus`, `transitionRunStatus`,
 *   `canCreateCostEstimateReport`); illegal transitions throw
 *   `DomainInvariantError` instead of corrupting the mock world.
 */
export class MockRepository implements MockRepositoryContract {
  private readonly seed: MockScenario;
  private world: MockWorld;
  private readonly listeners: Set<(world: MockWorld, command: MockCommand) => void>;

  private constructor(seed: MockScenario, world: MockWorld) {
    this.seed = seed;
    this.world = world;
    this.listeners = new Set();
  }

  /** Creates a repository seeded from a canonical scenario world. */
  static create(scenario: MockScenario): MockRepository {
    return new MockRepository(scenario, buildScenario(scenario));
  }

  /** The scenario this repository was seeded from. */
  get scenario(): MockScenario {
    return this.seed;
  }

  /** The immutable current world. Queries never observe partial mutations. */
  getSnapshot(): MockWorld {
    return this.world;
  }

  /** Subscribes to every applied command; returns a contract-style unsubscribe. */
  subscribe(listener: (world: MockWorld, command: MockCommand) => void): RunSubscription {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      }
    };
  }

  /**
   * Validates and applies a command. Returns `{ ok: false }` with field-level
   * problems when the command is invalid (the world is unchanged); otherwise
   * applies the command, notifies listeners and returns `{ ok: true }` with the
   * next world. Never throws for validation failures.
   */
  dispatch(command: MockCommand): MockCommandOutcome {
    const prepared = prepareCommand(this.world, command);
    if ("problems" in prepared) {
      return { ok: false, problems: prepared.problems, next: this.world };
    }
    const nextWorld = applyCommand(this.world, prepared.command);
    this.world = nextWorld;
    for (const listener of this.listeners) {
      listener(nextWorld, prepared.command);
    }
    return { ok: true, problems: [], next: nextWorld };
  }

  // ======================================================================
  // Canonical domain-transition commands (@swpanel/contracts MockRepository)
  // ======================================================================

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
  }): { drawing: Drawing; revision: DrawingRevision } {
    const outcome = this.dispatch({ kind: "createDrawing", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    const drawing = outcome.next.drawings[outcome.next.drawings.length - 1];
    const revision = outcome.next.revisions[outcome.next.revisions.length - 1];
    if (drawing === undefined || revision === undefined) {
      throw new DomainInvariantError("drawing was not created");
    }
    return { drawing, revision };
  }

  createRevision(input: {
    drawingId: string;
    sourceFile: {
      fileName: string;
      format: "PDF" | "DWG" | "DXF";
      sizeBytes: number;
      sha256: string;
    };
    createdAt: string;
  }): DrawingRevision {
    const outcome = this.dispatch({ kind: "createRevision", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    const revision = outcome.next.revisions[outcome.next.revisions.length - 1];
    if (revision === undefined) throw new DomainInvariantError("revision was not created");
    return revision;
  }

  setCurrentRevision(input: {
    drawingId: string;
    revisionId: string;
    updatedAt: string;
  }): Drawing {
    const outcome = this.dispatch({ kind: "setCurrentRevision", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    const drawing = outcome.next.drawings.find((candidate) => candidate.id === input.drawingId);
    if (drawing === undefined) throw new DomainInvariantError(`drawing ${input.drawingId} missing`);
    return drawing;
  }

  deleteRevision(input: {
    drawingId: string;
    revisionId: string;
    updatedAt: string;
  }): Drawing {
    const outcome = this.dispatch({ kind: "deleteRevision", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    const drawing = outcome.next.drawings.find((candidate) => candidate.id === input.drawingId);
    if (drawing === undefined) throw new DomainInvariantError(`drawing ${input.drawingId} missing`);
    return drawing;
  }

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
  }): RevisionFact {
    const outcome = this.dispatch({ kind: "addRevisionFact", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    // The upsert may have replaced an existing canonical fact in place, so the
    // created record is found by its stable (revisionId, field) identity —
    // the same identity used by clarification-derived facts.
    const factId = `fact-${input.revisionId}-${input.field}`;
    const fact = outcome.next.facts.find((candidate) => candidate.id === factId);
    if (fact === undefined) throw new DomainInvariantError("fact was not created");
    return fact;
  }

  createModelingFeedback(input: {
    drawingId: string;
    revisionId: string;
    content: string;
    createdAt: string;
  }): void {
    const outcome = this.dispatch({ kind: "addModelingFeedback", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
  }

  createRun(input: CreateRunInput): ModelingRun {
    const outcome = this.dispatch({ kind: "createRun", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    const run = outcome.next.runs[outcome.next.runs.length - 1];
    if (run === undefined) throw new DomainInvariantError("run was not created");
    return run;
  }

  cancelRun(runId: string, reason?: string): ModelingRun {
    const outcome = this.dispatch({
      kind: "cancelRun",
      input: { runId, ...(reason !== undefined ? { reason } : {}) }
    });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    const run = outcome.next.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new DomainInvariantError(`run ${runId} missing`);
    return run;
  }

  /**
   * Deletes ONE terminal Modeling Run (canonical `run.delete`). The Run plus its
   * owning drawing/revision pair are validated; only COMPLETED / FAILED /
   * CANCELLED runs are deletable. The Run's event history is removed with it.
   */
  deleteRun(input: {
    runId: string;
    drawingId: string;
    revisionId: string;
  }): { runId: string; attemptSequences: readonly number[] } {
    const outcome = this.dispatch({ kind: "deleteRun", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    return { runId: input.runId, attemptSequences: [] };
  }

  submitClarification(input: {
    clarificationRequestId: string;
    answers: readonly ClarificationAnswer[];
    answeredAt: string;
    answeredBy: string;
  }): void {
    const outcome = this.dispatch({ kind: "submitClarification", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
  }

  reviewModel(input: {
    modelId: string;
    result: ModelReview["result"];
    comment?: string;
    reviewerId: string;
    reviewedAt: string;
  }): Model {
    const outcome = this.dispatch({ kind: "reviewModel", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    const model = outcome.next.models.find((candidate) => candidate.id === input.modelId);
    if (model === undefined) throw new DomainInvariantError(`model ${input.modelId} missing`);
    return model;
  }

  updateCostData(snapshot: CostDataSnapshot, updatedAt: string): void {
    const outcome = this.dispatch({ kind: "updateCostData", input: { snapshot, updatedAt } });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
  }

  updateStorageSettings(settings: StorageSettings): void {
    const outcome = this.dispatch({ kind: "updateStorageSettings", input: { settings } });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
  }

  createCostReport(input: {
    drawingId: string;
    revisionId: string;
    modelId: string;
    inputSnapshot: CostEstimateInputSnapshot;
    result: CostEstimateResult;
    createdAt: string;
  }): string {
    const outcome = this.dispatch({ kind: "createCostReport", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    const report = outcome.next.reports[outcome.next.reports.length - 1];
    if (report === undefined) throw new DomainInvariantError("cost report was not created");
    return report.id;
  }

  /**
   * Deletes ONE Cost Estimate Report of its owning Revision (canonical
   * `costReport.delete`). Validated against the owning revision.
   */
  deleteCostReport(input: {
    costReportId: string;
    revisionId: string;
  }): { costReportId: string } {
    const outcome = this.dispatch({ kind: "deleteCostReport", input });
    if (!outcome.ok) throw new DomainInvariantError(outcome.problems.join("; "));
    return { costReportId: input.costReportId };
  }

  // ======================================================================
  // Convenience command wrappers (form-friendly, return structured outcomes)
  // ======================================================================

  approveModel(input: { modelId: string; reviewerId: string; reviewedAt: string }): MockCommandOutcome {
    return this.captureOutcome(() => {
      this.reviewModel({ modelId: input.modelId, result: "APPROVED", reviewerId: input.reviewerId, reviewedAt: input.reviewedAt });
    });
  }

  rejectModel(input: {
    modelId: string;
    reviewerId: string;
    reviewedAt: string;
    comment: string;
  }): MockCommandOutcome {
    return this.captureOutcome(() => {
      this.reviewModel({ modelId: input.modelId, result: "REJECTED", comment: input.comment, reviewerId: input.reviewerId, reviewedAt: input.reviewedAt });
    });
  }

  submitClarificationAnswers(input: {
    clarificationId: string;
    answers: readonly ClarificationAnswerInput[];
    answeredBy: string;
    answeredAt: string;
  }): MockCommandOutcome {
    return this.captureOutcome(() => {
      const request = this.requireClarification(input.clarificationId);
      const answers = buildAnswersFromInputs(request, input.answers, input.answeredAt, input.answeredBy);
      this.submitClarification({
        clarificationRequestId: input.clarificationId,
        answers,
        answeredAt: input.answeredAt,
        answeredBy: input.answeredBy
      });
    });
  }

  editCostData(input: {
    materials: readonly {
      id: string;
      name: string;
      purchasePrice: number;
      priceUnit: string;
      density: number;
      densityUnit: string;
    }[];
    fixedCosts: readonly {
      id: string;
      name: string;
      amount: number;
      currency: string;
      basis: string;
    }[];
    updatedAt: string;
  }): MockCommandOutcome {
    return this.captureOutcome(() => {
      const state = this.world.costData;
      const materials = state.materials.map((material) => {
        const edit = input.materials.find((candidate) => candidate.id === material.id);
        if (edit === undefined) return material;
        return {
          ...material,
          name: clean(edit.name),
          purchasePrice: edit.purchasePrice,
          priceUnit: clean(edit.priceUnit),
          density: edit.density,
          densityUnit: clean(edit.densityUnit),
          updatedAt: input.updatedAt
        };
      });
      const fixedCosts = state.fixedCosts.map((fixedCost) => {
        const edit = input.fixedCosts.find((candidate) => candidate.id === fixedCost.id);
        if (edit === undefined) return fixedCost;
        return {
          ...fixedCost,
          name: clean(edit.name),
          amount: edit.amount,
          currency: edit.currency as never,
          basis: edit.basis as never,
          updatedAt: input.updatedAt
        };
      });
      this.updateCostData(
        {
          materials,
          allowances: state.allowances,
          fixedCosts,
          customFields: state.customFields,
          capturedAt: input.updatedAt
        },
        input.updatedAt
      );
    });
  }

  generateCostReport(input: {
    drawingId: string;
    revisionId: string;
    modelId: string;
    quantity: number;
    materialId: string;
    stockType: StockType;
    stockSpec: string;
    finishedVolume: number;
    createdAt: string;
  }): MockCommandOutcome {
    return this.captureOutcome(() => {
      const state = this.world.costData;
      const material = state.materials.find((candidate) => candidate.id === input.materialId);
      if (material === undefined) {
        throw new DomainInvariantError(`unknown material ${input.materialId}`);
      }
      // The deterministic synthetic engine derives the material cost from the
      // finished-part volume and the effective material price, then derives the
      // fixed lines and totals so perPieceCost × quantity === totalCost.
      const inputSnapshot: CostEstimateInputSnapshot = {
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        modelId: input.modelId,
        quantity: input.quantity,
        materialId: input.materialId,
        stockType: input.stockType,
        stockSpec: clean(input.stockSpec),
        finishedVolume: input.finishedVolume,
        allowances: [],
        costData: {
          materials: state.materials,
          allowances: state.allowances,
          fixedCosts: state.fixedCosts,
          customFields: state.customFields,
          capturedAt: input.createdAt
        },
        formulaVersion: "visual-mock-1",
        capturedAt: input.createdAt
      };
      const result = computeSyntheticCostResult({
        quantity: input.quantity,
        materialCostPerPiece: syntheticMaterialCostPerPiece({
          finishedVolume: input.finishedVolume,
          material
        }),
        fixedCosts: state.fixedCosts
      });
      this.createCostReport({
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        modelId: input.modelId,
        inputSnapshot,
        result,
        createdAt: input.createdAt
      });
    });
  }

  private captureOutcome(action: () => unknown): MockCommandOutcome {
    try {
      action();
      return { ok: true, problems: [], next: this.world };
    } catch (error) {
      if (error instanceof DomainInvariantError) {
        return { ok: false, problems: [error.message], next: this.world };
      }
      throw error;
    }
  }

  // ======================================================================
  // Low-level queries (entity access over the immutable snapshot)
  // ======================================================================

  listDrawings(): readonly Drawing[] {
    return this.world.drawings;
  }

  getDrawing(drawingId: string): Drawing | undefined {
    return this.world.drawings.find((drawing) => drawing.id === drawingId);
  }

  listRevisions(): readonly DrawingRevision[] {
    return this.world.revisions;
  }

  getRevision(revisionId: string): DrawingRevision | undefined {
    return this.world.revisions.find((revision) => revision.id === revisionId);
  }

  listRuns(): readonly ModelingRun[] {
    return this.world.runs;
  }

  getRun(runId: string): ModelingRun | undefined {
    return this.world.runs.find((run) => run.id === runId);
  }

  getRunEvents(runId: string): readonly RunEvent[] {
    return this.world.runEvents[runId] ?? [];
  }

  listModels(): readonly Model[] {
    return this.world.models;
  }

  getModel(modelId: string): Model | undefined {
    return this.world.models.find((model) => model.id === modelId);
  }

  listReviews(): readonly ModelReview[] {
    return this.world.reviews;
  }

  /** Raw domain Clarification Request (contract query returns the view). */
  getClarificationRequest(clarificationRequestId: string): ClarificationRequest | undefined {
    return this.world.clarifications.find((candidate) => candidate.id === clarificationRequestId);
  }

  listClarifications(): readonly ClarificationRequest[] {
    return this.world.clarifications;
  }

  listFacts(): readonly RevisionFact[] {
    return this.world.facts;
  }

  listFeedback(): readonly ModelingFeedback[] {
    return this.world.feedback;
  }

  listArtifacts(): readonly Artifact[] {
    return this.world.artifacts;
  }

  listReports(): readonly CostEstimateReport[] {
    return this.world.reports;
  }

  getCostData(): MockWorld["costData"] {
    return this.world.costData;
  }

  // ======================================================================
  // RepositoryReader aggregate queries (@swpanel/contracts)
  // ======================================================================

  getDrawingDetail(drawingId: string): DrawingDetailView {
    const drawing = this.requireDrawing(drawingId);
    return {
      drawing: {
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        name: drawing.name,
        currentRevisionId: drawing.currentRevisionId,
        createdAt: drawing.createdAt,
        updatedAt: drawing.updatedAt
      },
      revisions: this.world.revisions
        .filter((revision) => revision.drawingId === drawingId)
        .sort((a, b) => a.sequence - b.sequence)
        .map((revision) => this.toRevisionListItem(drawing, revision))
    };
  }

  getDrawingHistory(drawingId: string): DrawingHistoryView {
    const drawing = this.requireDrawing(drawingId);
    return {
      drawingId: drawing.id,
      drawingNumber: drawing.drawingNumber,
      name: drawing.name,
      currentRevisionId: drawing.currentRevisionId,
      revisions: this.world.revisions
        .filter((revision) => revision.drawingId === drawingId)
        .sort((a, b) => a.sequence - b.sequence)
        .map((revision) => ({
          revisionId: revision.id,
          revisionLabel: revisionLabel(revision.sequence),
          isCurrent: revision.id === drawing.currentRevisionId,
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
    const drawing = this.requireDrawing(drawingId);
    const revision = this.requireRevision(revisionId);
    if (revision.drawingId !== drawingId) {
      throw new DomainInvariantError(`revision ${revisionId} does not belong to drawing ${drawingId}`);
    }
    return {
      revision: {
        revisionId: revision.id,
        revisionLabel: revisionLabel(revision.sequence),
        drawingId: revision.drawingId,
        drawingNumber: drawing.drawingNumber,
        drawingName: drawing.name,
        isCurrent: revision.id === drawing.currentRevisionId,
        currentApprovedModelId: revision.currentApprovedModelId,
        sourceFile: {
          fileName: revision.sourceFile.fileName,
          format: revision.sourceFile.format,
          sizeBytes: revision.sourceFile.sizeBytes,
          uploadedAt: revision.sourceFile.uploadedAt
        },
        createdAt: revision.createdAt
      },
      runs: this.chronologicalRuns(revisionId).map((run) => this.toRunListItem(run)),
      models: this.world.models
        .filter((model) => model.revisionId === revisionId)
        .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))
        .map((model) => this.toModelListItem(model, revision)),
      costReports: this.world.reports
        .filter((report) => report.revisionId === revisionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((report) => this.toCostReportListItem(report)),
      facts: [...this.world.facts]
        .filter((fact) => fact.revisionId === revisionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      modelingFeedback: [...this.world.feedback]
        .filter((entry) => entry.revisionId === revisionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    };
  }

  getRevisionHistory(drawingId: string, revisionId: string): RevisionHistoryView {
    const drawing = this.requireDrawing(drawingId);
    const revision = this.requireRevision(revisionId);
    if (revision.drawingId !== drawingId) {
      throw new DomainInvariantError(`revision ${revisionId} does not belong to drawing ${drawingId}`);
    }
    return {
      revisionId: revision.id,
      revisionLabel: revisionLabel(revision.sequence),
      drawingId: revision.drawingId,
      drawingNumber: drawing.drawingNumber,
      isCurrent: revision.id === drawing.currentRevisionId,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt,
      facts: [...this.world.facts]
        .filter((fact) => fact.revisionId === revisionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      modelingFeedback: [...this.world.feedback]
        .filter((entry) => entry.revisionId === revisionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    };
  }

  getRunDetail(runId: string): RunDetailView {
    const run = this.requireRun(runId);
    const events = this.world.runEvents[runId] ?? [];
    const { activity, progressPercent } = this.activityFromEvents(events);
    return {
      run: {
        runId: run.id,
        runLabel: run.number,
        drawingId: run.drawingId,
        revisionId: run.revisionId,
        status: run.status,
        stage: run.stage,
        activity,
        progressPercent,
        createdAt: run.createdAt,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        failureCode: run.failureCode ?? null,
        failureMessage: run.failureMessage ?? null,
        modelId: run.modelId ?? null,
        clarificationRequestId: run.clarificationRequestId ?? null
      },
      events: [...events],
      lastEventSequence: events.reduce((max, event) => Math.max(max, event.sequence), 0)
    };
  }

  getModelDetail(modelId: string): ModelDetailView {
    const model = this.requireModel(modelId);
    const revision = this.world.revisions.find((candidate) => candidate.id === model.revisionId);
    return {
      model: {
        modelId: model.id,
        modelLabel: model.number,
        drawingId: model.drawingId,
        revisionId: model.revisionId,
        runId: model.runId,
        reviewStatus: model.reviewStatus,
        isCurrentApproved: revision?.currentApprovedModelId === model.id,
        generatedAt: model.generatedAt,
        productionVerified: model.productionVerified,
        validationSummary: model.validationSummary
          ? {
              solidWorksVersion: model.validationSummary.solidWorksVersion,
              featureCount: model.validationSummary.featureCount,
              bodyCount: model.validationSummary.bodyCount,
              rebuildStatus: model.validationSummary.rebuildStatus
            }
          : null,
        buildReportSummary: model.buildReportSummary ?? null
      },
      artifacts: this.world.artifacts
        .filter((artifact) => artifact.modelId === model.id)
        .map((artifact) => ({
          artifactId: artifact.id,
          kind: artifact.kind,
          fileName: artifact.fileName,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256
        })),
      reviews: this.world.reviews
        .filter((review) => review.modelId === model.id)
        .map((review) => ({
          reviewId: review.id,
          result: review.result,
          reviewerId: review.reviewerId,
          comment: review.comment ?? null,
          createdAt: review.createdAt
        }))
    };
  }

  getClarification(clarificationRequestId: string): ClarificationView {
    const request = this.requireClarification(clarificationRequestId);
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
        options: question.options ?? []
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

  getCostReportDetail(costReportId: string): CostReportDetailView {
    const report = this.requireReport(costReportId);
    return {
      costReportId: report.id,
      label: report.label,
      drawingId: report.drawingId,
      revisionId: report.revisionId,
      modelId: report.modelId,
      quantity: report.quantity,
      createdAt: report.createdAt,
      snapshot: report.snapshot,
      result: {
        rawStockVolume: report.snapshot.result.rawStockVolume,
        materialCost: report.snapshot.result.materialCost,
        fixedCostLines: report.snapshot.result.fixedCostLines.map((line) => ({
          name: line.name,
          amount: line.amount,
          basis: line.basis,
          subtotal: line.subtotal
        })),
        perPieceCost: report.snapshot.result.perPieceCost,
        totalCost: report.snapshot.result.totalCost,
        currency: report.snapshot.result.currency
      }
    };
  }

  getWorkspaceDashboard(): WorkspaceDashboardView {
    const runningRun = this.world.runs.find((run) => run.status === "RUNNING");
    return {
      currentRun: runningRun === undefined ? null : this.toRunDetailRun(runningRun),
      queuedRunLabels: this.world.runs
        .filter((run) => run.status === "QUEUED")
        .map((run) => run.number),
      pendingReviews: this.world.models
        .filter((model) => model.reviewStatus === "PENDING_REVIEW")
        .map((model) => {
          const revision = this.requireRevision(model.revisionId);
          const drawing = this.requireDrawing(model.drawingId);
          return {
            drawingId: drawing.id,
            drawingNumber: drawing.drawingNumber,
            revisionLabel: revisionLabel(revision.sequence),
            modelId: model.id,
            modelLabel: model.number
          };
        }),
      pendingClarifications: this.world.clarifications
        .filter((request) => request.status === "OPEN")
        .map((request) => {
          const run = this.world.runs.find((candidate) => candidate.id === request.runId);
          const revision = this.requireRevision(request.revisionId);
          const drawing = this.requireDrawing(revision.drawingId);
          return {
            drawingId: drawing.id,
            drawingNumber: drawing.drawingNumber,
            revisionLabel: revisionLabel(revision.sequence),
            runId: request.runId,
            runLabel: run?.number ?? request.runId,
            openQuestionCount: request.questions.length
          };
        }),
      recentDrawings: [...this.world.drawings]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5)
        .map((drawing) => this.toDrawingListItem(drawing))
    };
  }

  getEffectiveCostData(): CostDataSnapshot {
    const state = this.world.costData;
    const allUpdated = [...state.materials, ...state.allowances, ...state.fixedCosts, ...state.customFields]
      .map((entry) => entry.updatedAt)
      .sort()
      .at(-1);
    return {
      materials: state.materials,
      allowances: state.allowances,
      fixedCosts: state.fixedCosts,
      customFields: state.customFields,
      capturedAt: allUpdated ?? "1970-01-01T00:00:00.000Z"
    };
  }

  getStorageSettings(): StorageSettingsView {
    return { settings: this.world.storageSettings };
  }

  // ======================================================================
  // RepositoryWriter primitives (@swpanel/contracts)
  // ======================================================================

  saveDrawing(drawing: Drawing): void {
    this.world = { ...this.world, drawings: upsert(this.world.drawings, drawing, (candidate) => candidate.id === drawing.id) };
  }

  saveRevision(revision: DrawingRevision): void {
    this.world = { ...this.world, revisions: upsert(this.world.revisions, revision, (candidate) => candidate.id === revision.id) };
  }

  saveRun(run: ModelingRun): void {
    // Single-RUNNING invariant: SWPanel executes Modeling Runs serially, so
    // at most one Run may be RUNNING at any time. This guard covers the public
    // writer primitive (used by the reconnect/agent adapter) and any future run
    // mutation path.
    if (run.status === "RUNNING") {
      const otherRunning = this.world.runs.some(
        (candidate) => candidate.status === "RUNNING" && candidate.id !== run.id
      );
      if (otherRunning) {
        throw new DomainInvariantError(
          `cannot save run ${run.id} as RUNNING: another run is already RUNNING`
        );
      }
    }
    this.world = {
      ...this.world,
      runs: upsert(this.world.runs, run, (candidate) => candidate.id === run.id),
      runEvents: { ...this.world.runEvents, [run.id]: this.world.runEvents[run.id] ?? [] }
    };
  }

  appendRunEvent(event: RunEvent): void {
    const current = this.world.runEvents[event.runId] ?? [];
    const next = [...current, event].sort((a, b) => a.sequence - b.sequence);
    this.world = { ...this.world, runEvents: { ...this.world.runEvents, [event.runId]: next } };
  }

  saveClarification(request: ClarificationRequest): void {
    this.world = { ...this.world, clarifications: upsert(this.world.clarifications, request, (candidate) => candidate.id === request.id) };
  }

  saveModel(model: Model): void {
    this.world = { ...this.world, models: upsert(this.world.models, model, (candidate) => candidate.id === model.id) };
  }

  saveModelReview(review: ModelReview): void {
    this.world = { ...this.world, reviews: [...this.world.reviews, review] };
  }

  addRevisionFact(fact: RevisionFact): void {
    this.world = { ...this.world, facts: [...this.world.facts, fact] };
  }

  addModelingFeedback(feedback: ModelingFeedback): void {
    this.world = { ...this.world, feedback: [...this.world.feedback, feedback] };
  }

  saveArtifact(artifact: Artifact): void {
    this.world = { ...this.world, artifacts: [...this.world.artifacts, artifact] };
  }

  saveCostEstimateReport(report: CostEstimateReport): void {
    this.world = { ...this.world, reports: upsert(this.world.reports, report, (candidate) => candidate.id === report.id) };
  }

  saveCostDataSnapshot(snapshot: CostDataSnapshot): void {
    this.world = {
      ...this.world,
      costData: {
        ...this.world.costData,
        materials: snapshot.materials,
        allowances: snapshot.allowances,
        fixedCosts: snapshot.fixedCosts,
        customFields: snapshot.customFields
      }
    };
  }

  saveStorageSettings(settings: StorageSettings): void {
    this.world = { ...this.world, storageSettings: settings };
  }

  // ======================================================================
  // View projection helpers
  // ======================================================================

  private toDrawingListItem(drawing: Drawing): DrawingListItemView {
    const currentRevision = drawing.currentRevisionId
      ? this.world.revisions.find((revision) => revision.id === drawing.currentRevisionId)
      : undefined;
    const latestRun = currentRevision
      ? this.chronologicalRuns(currentRevision.id).at(-1)
      : undefined;
    const revisions = this.world.revisions.filter((revision) => revision.drawingId === drawing.id);
    const newestRevision = revisions.reduce<DrawingRevision | undefined>((newest, revision) => {
      if (newest === undefined || revision.sequence > newest.sequence) return revision;
      return newest;
    }, undefined);
    const currentOpenClarification = currentRevision
      ? this.world.clarifications.some(
          (request) => request.revisionId === currentRevision.id && request.status === "OPEN"
        )
      : false;
    return {
      drawingId: drawing.id,
      drawingNumber: drawing.drawingNumber,
      name: drawing.name,
      currentRevisionId: drawing.currentRevisionId,
      currentRevisionLabel: currentRevision ? revisionLabel(currentRevision.sequence) : null,
      currentApprovedModelId: currentRevision?.currentApprovedModelId ?? null,
      runStatus: latestRun?.status ?? null,
      updatedAt: drawing.updatedAt,
      totalRevisionCount: revisions.length,
      latestRevisionLabel: newestRevision === undefined ? null : revisionLabel(newestRevision.sequence),
      hasOpenClarification: currentOpenClarification
    };
  }

  private toRevisionListItem(drawing: Drawing, revision: DrawingRevision): RevisionListItemView {
    return {
      revisionId: revision.id,
      revisionLabel: revisionLabel(revision.sequence),
      isCurrent: revision.id === drawing.currentRevisionId,
      currentApprovedModelId: revision.currentApprovedModelId,
      isCurrentApprovedModel: revision.currentApprovedModelId !== null,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt
    };
  }

  private toRunListItem(run: ModelingRun): RunListItemView {
    return {
      runId: run.id,
      runLabel: run.number,
      status: run.status,
      stage: run.stage,
      createdAt: run.createdAt,
      modelId: run.modelId ?? null,
      clarificationRequestId: run.clarificationRequestId ?? null,
      failureCode: run.failureCode ?? null
    };
  }

  private toModelListItem(model: Model, revision: DrawingRevision): ModelListItemView {
    return {
      modelId: model.id,
      modelLabel: model.number,
      reviewStatus: model.reviewStatus,
      isCurrentApproved: revision.currentApprovedModelId === model.id,
      generatedAt: model.generatedAt,
      runId: model.runId
    };
  }

  private toCostReportListItem(report: CostEstimateReport): CostReportListItemView {
    return {
      costReportId: report.id,
      label: report.label,
      quantity: report.quantity,
      perPieceCost: report.snapshot.result.perPieceCost,
      totalCost: report.snapshot.result.totalCost,
      currency: report.snapshot.result.currency,
      createdAt: report.createdAt
    };
  }

  private toRunDetailRun(run: ModelingRun): RunDetailView["run"] {
    const { activity, progressPercent } = this.activityFromEvents(this.world.runEvents[run.id] ?? []);
    return {
      runId: run.id,
      runLabel: run.number,
      drawingId: run.drawingId,
      revisionId: run.revisionId,
      status: run.status,
      stage: run.stage,
      activity,
      progressPercent,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      failureCode: run.failureCode ?? null,
      failureMessage: run.failureMessage ?? null,
      modelId: run.modelId ?? null,
      clarificationRequestId: run.clarificationRequestId ?? null
    };
  }

  private chronologicalRuns(revisionId: string): readonly ModelingRun[] {
    return this.world.runs
      .filter((run) => run.revisionId === revisionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private activityFromEvents(events: readonly RunEvent[]): {
    activity: string | null;
    progressPercent: number | null;
  } {
    let activity: string | null = null;
    let progressPercent: number | null = null;
    for (const event of events) {
      if (event.type === "ActivityUpdated") activity = event.activity;
      else if (event.type === "ProgressUpdated") progressPercent = event.progressPercent;
    }
    return { activity, progressPercent };
  }

  private requireDrawing(drawingId: string): Drawing {
    const drawing = this.world.drawings.find((candidate) => candidate.id === drawingId);
    if (drawing === undefined) throw new DomainInvariantError(`unknown drawing ${drawingId}`);
    return drawing;
  }

  private requireRevision(revisionId: string): DrawingRevision {
    const revision = this.world.revisions.find((candidate) => candidate.id === revisionId);
    if (revision === undefined) throw new DomainInvariantError(`unknown revision ${revisionId}`);
    return revision;
  }

  private requireRun(runId: string): ModelingRun {
    const run = this.world.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new DomainInvariantError(`unknown run ${runId}`);
    return run;
  }

  private requireModel(modelId: string): Model {
    const model = this.world.models.find((candidate) => candidate.id === modelId);
    if (model === undefined) throw new DomainInvariantError(`unknown model ${modelId}`);
    return model;
  }

  private requireClarification(clarificationRequestId: string): ClarificationRequest {
    const request = this.world.clarifications.find((candidate) => candidate.id === clarificationRequestId);
    if (request === undefined) {
      throw new DomainInvariantError(`unknown clarification ${clarificationRequestId}`);
    }
    return request;
  }

  private requireReport(costReportId: string): CostEstimateReport {
    const report = this.world.reports.find((candidate) => candidate.id === costReportId);
    if (report === undefined) throw new DomainInvariantError(`unknown cost report ${costReportId}`);
    return report;
  }
}

export type MockCommandOutcome =
  | { ok: true; problems: readonly []; next: MockWorld }
  | { ok: false; problems: readonly string[]; next: MockWorld };

function upsert<T>(items: readonly T[], item: T, isMatch: (candidate: T) => boolean): T[] {
  return items.some(isMatch) ? items.map((candidate) => (isMatch(candidate) ? item : candidate)) : [...items, item];
}

function cleanRequired(values: readonly string[]): boolean {
  return values.every((value) => value.trim().length > 0);
}

function clean(value: string): string {
  return value.trim();
}

function nextRunSequence(runs: readonly ModelingRun[], revisionId: string): number {
  let max = 0;
  for (const run of runs) {
    if (run.revisionId !== revisionId) continue;
    const match = /^R(\d+)$/.exec(run.number);
    if (match !== null) {
      const parsed = Number.parseInt(match[1] ?? "0", 10);
      if (parsed > max) max = parsed;
    }
  }
  return max + 1;
}

function safeId(seed: string): string {
  return seed.replace(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * Validates a command against the current world without mutating it. Returns
 * either `{ problems }` or `{ command }` (a sanitized copy of the input).
 */
function prepareCommand(
  world: MockWorld,
  command: MockCommand
): { problems: readonly string[] } | { command: MockCommand } {
  switch (command.kind) {
    case "createDrawing": {
      const problems: string[] = [];
      if (!cleanRequired([command.input.drawingNumber, command.input.name])) {
        problems.push("drawingNumber and name must not be empty");
      }
      if (!cleanRequired([command.input.createdAt])) {
        problems.push("createdAt must not be empty");
      }
      const duplicateNumber = world.drawings.some(
        (drawing) => drawing.drawingNumber === command.input.drawingNumber.trim()
      );
      if (duplicateNumber) {
        problems.push(`drawing number ${command.input.drawingNumber.trim()} already exists`);
      }
      problems.push(...validateSourceFile(command.input.sourceFile));
      return problems.length > 0 ? { problems } : { command };
    }
    case "createRevision": {
      const problems: string[] = [];
      const drawing = world.drawings.find((candidate) => candidate.id === command.input.drawingId);
      if (drawing === undefined) problems.push(`unknown drawing ${command.input.drawingId}`);
      if (!cleanRequired([command.input.createdAt])) {
        problems.push("createdAt must not be empty");
      }
      problems.push(...validateSourceFile(command.input.sourceFile));
      return problems.length > 0 ? { problems } : { command };
    }
    case "setCurrentRevision": {
      const problems: string[] = [];
      const drawing = world.drawings.find((candidate) => candidate.id === command.input.drawingId);
      if (drawing === undefined) {
        problems.push(`unknown drawing ${command.input.drawingId}`);
      }
      const revision = world.revisions.find((candidate) => candidate.id === command.input.revisionId);
      if (revision === undefined) {
        problems.push(`unknown revision ${command.input.revisionId}`);
      } else if (drawing !== undefined && !canSetCurrentRevision(drawing, revision)) {
        problems.push(`revision ${revision.id} does not belong to drawing ${drawing.id}`);
      }
      if (!cleanRequired([command.input.updatedAt])) {
        problems.push("updatedAt must not be empty");
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "deleteRevision": {
      const problems: string[] = [];
      const drawing = world.drawings.find((candidate) => candidate.id === command.input.drawingId);
      if (drawing === undefined) {
        problems.push(`unknown drawing ${command.input.drawingId}`);
      }
      const revision = world.revisions.find((candidate) => candidate.id === command.input.revisionId);
      if (revision === undefined) {
        problems.push(`unknown revision ${command.input.revisionId}`);
      } else if (drawing !== undefined && revision.drawingId !== drawing.id) {
        problems.push(`revision ${revision.id} does not belong to drawing ${drawing.id}`);
      } else if (drawing !== undefined && drawing.currentRevisionId === revision.id) {
        problems.push(`current revision ${revision.id} cannot be deleted`);
      } else if (
        world.runs.some((run) => run.revisionId === command.input.revisionId) ||
        world.models.some((model) => model.revisionId === command.input.revisionId)
      ) {
        problems.push(`revision ${command.input.revisionId} has runs or models and cannot be deleted`);
      }
      if (!cleanRequired([command.input.updatedAt])) {
        problems.push("updatedAt must not be empty");
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "addRevisionFact": {
      const problems: string[] = [];
      const drawing = world.drawings.find((candidate) => candidate.id === command.input.drawingId);
      if (drawing === undefined) problems.push(`unknown drawing ${command.input.drawingId}`);
      const revision = world.revisions.find((candidate) => candidate.id === command.input.revisionId);
      if (revision === undefined) {
        problems.push(`unknown revision ${command.input.revisionId}`);
      } else if (drawing !== undefined && revision.drawingId !== drawing.id) {
        problems.push(`revision ${revision.id} does not belong to drawing ${drawing.id}`);
      }
      if (!cleanRequired([command.input.field, command.input.value])) {
        problems.push("field and value must not be empty");
      }
      if (!REVISION_FACT_SOURCES.includes(command.input.source)) {
        problems.push(`unsupported fact source ${command.input.source}`);
      }
      if (!cleanRequired([command.input.createdAt])) {
        problems.push("createdAt must not be empty");
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "addModelingFeedback": {
      const problems: string[] = [];
      const drawing = world.drawings.find((candidate) => candidate.id === command.input.drawingId);
      if (drawing === undefined) problems.push(`unknown drawing ${command.input.drawingId}`);
      const revision = world.revisions.find((candidate) => candidate.id === command.input.revisionId);
      if (revision === undefined) {
        problems.push(`unknown revision ${command.input.revisionId}`);
      } else if (drawing !== undefined && revision.drawingId !== drawing.id) {
        problems.push(`revision ${revision.id} does not belong to drawing ${drawing.id}`);
      }
      if (!cleanRequired([command.input.content])) {
        problems.push("content must not be empty");
      }
      if (!cleanRequired([command.input.createdAt])) {
        problems.push("createdAt must not be empty");
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "createRun": {
      const problems: string[] = [];
      const drawing = world.drawings.find((candidate) => candidate.id === command.input.drawingId);
      if (drawing === undefined) problems.push(`unknown drawing ${command.input.drawingId}`);
      const revision = world.revisions.find((candidate) => candidate.id === command.input.revisionId);
      if (revision === undefined) {
        problems.push(`unknown revision ${command.input.revisionId}`);
      } else if (drawing !== undefined && revision.drawingId !== drawing.id) {
        problems.push(`revision ${revision.id} does not belong to drawing ${drawing.id}`);
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "cancelRun": {
      const run = world.runs.find((candidate) => candidate.id === command.input.runId);
      if (run === undefined) {
        return { problems: [`unknown run ${command.input.runId}`] };
      }
      if (!canCancelRun(run.status)) {
        return { problems: [`run ${run.id} is ${run.status}; only QUEUED or RUNNING runs can be cancelled`] };
      }
      return { command };
    }
    case "deleteRun": {
      const problems: string[] = [];
      const run = world.runs.find((candidate) => candidate.id === command.input.runId);
      if (run === undefined) {
        return { problems: [`unknown run ${command.input.runId}`] };
      }
      if (run.drawingId !== command.input.drawingId || run.revisionId !== command.input.revisionId) {
        problems.push(
          `run ${run.id} does not belong to drawing ${command.input.drawingId} revision ${command.input.revisionId}`
        );
      }
      // Deletion is conservative like the Runner: only naturally terminal Runs
      // (COMPLETED / FAILED / CANCELLED) may be removed.
      if (run.status !== "COMPLETED" && run.status !== "FAILED" && run.status !== "CANCELLED") {
        problems.push(`run ${run.id} is ${run.status}; only terminal runs can be deleted`);
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "deleteCostReport": {
      const report = world.reports.find((candidate) => candidate.id === command.input.costReportId);
      if (report === undefined) {
        return { problems: [`unknown cost report ${command.input.costReportId}`] };
      }
      if (report.revisionId !== command.input.revisionId) {
        return {
          problems: [
            `cost report ${report.id} does not belong to revision ${command.input.revisionId}`
          ]
        };
      }
      return { command };
    }
    case "submitClarification": {
      const problems: string[] = [];
      const request = world.clarifications.find(
        (candidate) => candidate.id === command.input.clarificationRequestId
      );
      if (request === undefined) {
        return { problems: [`unknown clarification ${command.input.clarificationRequestId}`] };
      }
      if (!canAnswerClarification(request)) {
        problems.push(`clarification ${request.id} is not open`);
      }
      if (!cleanRequired([command.input.answeredBy])) {
        problems.push("answeredBy must not be empty");
      }
      if (command.input.answers.length === 0) {
        problems.push("at least one answer is required");
      }
      const known = new Set(request.questions.map((question) => question.id));
      const seen = new Set<string>();
      for (const answer of command.input.answers) {
        if (!known.has(answer.questionId)) {
          problems.push(`answer references unknown question ${answer.questionId}`);
          continue;
        }
        if (seen.has(answer.questionId)) {
          problems.push(`duplicate answer for question ${answer.questionId}`);
          continue;
        }
        seen.add(answer.questionId);
        if (answer.value.kind === "text" && !cleanRequired([answer.value.value])) {
          problems.push(`answer for ${answer.questionId} must not be empty`);
        } else if (answer.value.kind === "dimension" && !Number.isFinite(answer.value.value)) {
          problems.push(`answer for ${answer.questionId} must be a finite number`);
        } else if (answer.value.kind === "dimension" && answer.value.value < 0) {
          problems.push(`answer for ${answer.questionId} must not be negative`);
        } else if (answer.value.kind === "choice") {
          const question = request.questions.find((candidate) => candidate.id === answer.questionId);
          const validOptions = new Set(
            (question?.options ?? []).map((option) => option.id)
          );
          if (!validOptions.has(answer.value.optionId)) {
            problems.push(`answer for ${answer.questionId} selects unknown option ${answer.value.optionId}`);
          }
        }
      }
      // The clarification batch is atomic: every question must be answered in
      // the same submission; a partial batch never advances the request.
      const answeredIds = new Set(command.input.answers.map((answer) => answer.questionId));
      for (const question of request.questions) {
        if (!answeredIds.has(question.id)) {
          problems.push(`missing answer for question ${question.id}`);
        }
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "reviewModel": {
      const problems: string[] = [];
      const model = world.models.find((candidate) => candidate.id === command.input.modelId);
      if (model === undefined) {
        return { problems: [`unknown model ${command.input.modelId}`] };
      }
      if (!canReviewModel(model.reviewStatus)) {
        problems.push(`model ${model.id} is ${model.reviewStatus}; only PENDING_REVIEW can be reviewed`);
      }
      if (command.input.result === "REJECTED" && !cleanRequired([command.input.comment ?? ""])) {
        problems.push("comment is required when rejecting a model");
      }
      if (!cleanRequired([command.input.reviewerId])) {
        problems.push("reviewerId must not be empty");
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "updateCostData": {
      const problems: string[] = [];
      if (!cleanRequired([command.input.updatedAt])) {
        problems.push("updatedAt must not be empty");
      }
      if (!cleanRequired([command.input.snapshot.capturedAt])) {
        problems.push("snapshot.capturedAt must not be empty");
      }
      for (const material of command.input.snapshot.materials) {
        problems.push(...validateMaterialValue(material));
      }
      for (const fixedCost of command.input.snapshot.fixedCosts) {
        problems.push(...validateFixedCostValue(fixedCost));
      }
      for (const allowance of command.input.snapshot.allowances) {
        for (const value of allowance.allowances) {
          if (!Number.isFinite(value.valueMm) || value.valueMm < 0) {
            problems.push(`allowance ${allowance.id} value must be a finite non-negative number`);
          }
        }
      }
      return problems.length > 0 ? { problems } : { command };
    }
    case "createCostReport": {
      const problems: string[] = [];
      const revision = world.revisions.find((candidate) => candidate.id === command.input.revisionId);
      const drawing = world.drawings.find((candidate) => candidate.id === command.input.drawingId);
      const model = world.models.find((candidate) => candidate.id === command.input.modelId);
      if (revision === undefined) problems.push(`unknown revision ${command.input.revisionId}`);
      if (drawing === undefined) problems.push(`unknown drawing ${command.input.drawingId}`);
      if (model === undefined) {
        problems.push(`unknown model ${command.input.modelId}`);
      } else if (model.reviewStatus !== "APPROVED") {
        problems.push(`model ${model.id} is ${model.reviewStatus}; only an APPROVED model can generate a report`);
      }
      if (revision !== undefined && drawing !== undefined) {
        if (!canCreateCostEstimateReport(drawing, revision)) {
          problems.push("only the current revision with a current approved model may generate a report");
        } else if (revision.currentApprovedModelId !== command.input.modelId) {
          // Exact current-approved-model eligibility: the model must be the
          // revision's current formal model, not merely an approved history model.
          problems.push(`model ${command.input.modelId} is not the current approved model of revision ${revision.id}`);
        }
      }
      const inputSnapshot = command.input.inputSnapshot;
      if (!Number.isInteger(inputSnapshot.quantity) || inputSnapshot.quantity < 1) {
        problems.push("quantity must be a positive integer");
      }
      if (!cleanRequired([inputSnapshot.stockSpec])) {
        problems.push("stockSpec must not be empty");
      }
      if (!STOCK_TYPES.includes(inputSnapshot.stockType)) {
        problems.push(`unsupported stockType ${String(inputSnapshot.stockType)}`);
      }
      if (!Number.isFinite(inputSnapshot.finishedVolume) || inputSnapshot.finishedVolume <= 0) {
        problems.push("finishedVolume must be a positive number");
      }
      if (inputSnapshot.drawingId !== command.input.drawingId) {
        problems.push("inputSnapshot.drawingId does not match the report's drawing");
      }
      if (inputSnapshot.revisionId !== command.input.revisionId) {
        problems.push("inputSnapshot.revisionId does not match the report's revision");
      }
      if (inputSnapshot.modelId !== command.input.modelId) {
        problems.push("inputSnapshot.modelId does not match the report's model");
      }
      if (
        world.costData.materials.every((material) => material.id !== inputSnapshot.materialId)
      ) {
        problems.push(`unknown material ${inputSnapshot.materialId}`);
      }
      if (inputSnapshot.costData.materials.every((material) => material.id !== inputSnapshot.materialId)) {
        problems.push(`snapshot has no material ${inputSnapshot.materialId}`);
      }
      for (const material of inputSnapshot.costData.materials) {
        problems.push(...validateMaterialValue(material));
      }
      for (const fixedCost of inputSnapshot.costData.fixedCosts) {
        problems.push(...validateFixedCostValue(fixedCost));
      }
      // The caller-supplied `result` is intentionally NOT trusted: the stored
      // result is always recomputed deterministically from the input snapshot,
      // so a forged/zero result can never be accepted.
      return problems.length > 0 ? { problems } : { command };
    }
    case "updateStorageSettings": {
      const problems: string[] = [];
      const settings = command.input.settings;
      if (!cleanRequired([settings.dataRoot, settings.workspaceRoot])) {
        problems.push("dataRoot and workspaceRoot must not be empty");
      }
      if (!STORAGE_CONSTRAINTS.includes(settings.constraint)) {
        problems.push(`unsupported storage constraint ${settings.constraint}`);
      }
      if (!cleanRequired([settings.updatedAt])) {
        problems.push("updatedAt must not be empty");
      }
      return problems.length > 0 ? { problems } : { command };
    }
  }
}

/**
 * Validates a user-supplied source file before the repository mints its stable
 * identity and library-relative path: the format must be a supported drawing
 * format, the declared size finite, and the SHA-256 a canonical hex digest.
 */
function validateSourceFile(sourceFile: {
  fileName: string;
  format: string;
  sizeBytes: number;
  sha256: string;
}): readonly string[] {
  const problems: string[] = [];
  if (!cleanRequired([sourceFile.fileName])) {
    problems.push("sourceFile.fileName must not be empty");
  }
  if (!DRAWING_FILE_FORMATS.includes(sourceFile.format as never)) {
    problems.push(`unsupported source file format ${sourceFile.format}`);
  }
  if (!Number.isInteger(sourceFile.sizeBytes) || sourceFile.sizeBytes <= 0) {
    problems.push("sourceFile.sizeBytes must be a positive integer");
  }
  if (!/^[a-f0-9]{64}$/.test(sourceFile.sha256)) {
    problems.push("sourceFile.sha256 must be a 64-character hex digest");
  }
  return problems;
}

/**
 * Validates a material cost value: finite, non-negative price and a positive
 * finite density when present; unsupported price units are rejected.
 */
function validateMaterialValue(material: {
  name: string;
  purchasePrice: number;
  priceUnit: string;
  density?: number;
}): readonly string[] {
  const problems: string[] = [];
  if (!cleanRequired([material.name, material.priceUnit])) {
    problems.push(`material ${material.name} must have a name and price unit`);
  }
  if (!Number.isFinite(material.purchasePrice) || material.purchasePrice < 0) {
    problems.push(`material ${material.name} purchasePrice must be a finite non-negative number`);
  }
  if (material.density !== undefined && (!Number.isFinite(material.density) || material.density <= 0)) {
    problems.push(`material ${material.name} density must be a positive finite number`);
  }
  if (!(SUPPORTED_PRICE_UNITS as readonly string[]).includes(material.priceUnit)) {
    problems.push(`material ${material.name} uses unsupported price unit ${material.priceUnit}`);
  }
  return problems;
}

/** Validates a fixed cost value: finite, non-negative amount, supported basis and currency. */
function validateFixedCostValue(fixedCost: {
  name: string;
  amount: number;
  basis: string;
  currency: string;
}): readonly string[] {
  const problems: string[] = [];
  if (!cleanRequired([fixedCost.name])) {
    problems.push("fixed cost must have a name");
  }
  if (!Number.isFinite(fixedCost.amount) || fixedCost.amount < 0) {
    problems.push(`fixed cost ${fixedCost.name} amount must be a finite non-negative number`);
  }
  if (!COST_BASES.includes(fixedCost.basis as never)) {
    problems.push(`fixed cost ${fixedCost.name} uses unsupported basis ${fixedCost.basis}`);
  }
  if (!COST_CURRENCIES.includes(fixedCost.currency as never)) {
    problems.push(`fixed cost ${fixedCost.name} uses unsupported currency ${fixedCost.currency}`);
  }
  return problems;
}

/** Validates a fixed cost line inside a report result. */
function validateFixedCostLine(line: {
  name: string;
  amount: number;
  subtotal: number;
  basis: string;
}): readonly string[] {
  const problems: string[] = [];
  if (!cleanRequired([line.name])) {
    problems.push("fixed cost line must have a name");
  }
  if (!Number.isFinite(line.amount) || line.amount < 0) {
    problems.push(`fixed cost line ${line.name} amount must be a finite non-negative number`);
  }
  if (!Number.isFinite(line.subtotal) || line.subtotal < 0) {
    problems.push(`fixed cost line ${line.name} subtotal must be a finite non-negative number`);
  }
  if (!COST_BASES.includes(line.basis as never)) {
    problems.push(`fixed cost line ${line.name} uses unsupported basis ${line.basis}`);
  }
  return problems;
}

const SUPPORTED_PRICE_UNITS = ["元/吨", "元/kg", "元/件"] as const;

function makeEvent(
  runId: string,
  sequence: number,
  occurredAt: string,
  payload: RunEventPayload
): RunEvent {
  return {
    contractVersion: RUN_EVENT_CONTRACT_VERSION,
    runId,
    attemptId: MOCK_ATTEMPT_ID,
    sequence,
    occurredAt,
    ...payload
  };
}

/**
 * Applies a prepared command to a world, returning the next world. Commands
 * never mutate the previous world; every success produces a new immutable
 * snapshot so subscriptions receive an atomic view.
 */
function applyCommand(world: MockWorld, command: MockCommand): MockWorld {
  switch (command.kind) {
    case "createDrawing": {
      const input = command.input;
      const drawingId = `drawing-${safeId(input.drawingNumber)}`;
      if (world.drawings.some((candidate) => candidate.id === drawingId)) {
        throw new DomainInvariantError(`drawing ${drawingId} already exists`);
      }
      const sourceFile: RevisionSourceFile = {
        id: `file-${safeId(input.drawingNumber)}-v1`,
        fileName: clean(input.sourceFile.fileName),
        format: input.sourceFile.format,
        sizeBytes: input.sourceFile.sizeBytes,
        sha256: input.sourceFile.sha256,
        relativePath: `library/drawings/${drawingId}/revisions/${safeId(input.drawingNumber)}-v1/source/${clean(input.sourceFile.fileName)}`,
        uploadedAt: input.createdAt
      };
      const sequence = 1;
      const revision: DrawingRevision = {
        id: `rev-${safeId(input.drawingNumber)}-v${sequence}`,
        drawingId,
        sequence,
        sourceFile,
        currentApprovedModelId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      };
      const drawing: Drawing = {
        id: drawingId,
        drawingNumber: clean(input.drawingNumber),
        name: clean(input.name),
        currentRevisionId: revision.id,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      };
      return {
        ...world,
        drawings: [...world.drawings, drawing],
        revisions: [...world.revisions, revision]
      };
    }
    case "createRevision": {
      const input = command.input;
      const drawing = world.drawings.find((candidate) => candidate.id === input.drawingId);
      if (drawing === undefined) {
        throw new DomainInvariantError(`drawing ${input.drawingId} missing`);
      }
      const drawingRevisions = world.revisions.filter(
        (revision) => revision.drawingId === drawing.id
      );
      const sequence = nextRevisionSequence(drawingRevisions);
      const revisionId = `rev-${safeId(drawing.id)}-v${sequence}`;
      const sourceFile: RevisionSourceFile = {
        id: `file-${safeId(drawing.id)}-v${sequence}`,
        fileName: clean(input.sourceFile.fileName),
        format: input.sourceFile.format,
        sizeBytes: input.sourceFile.sizeBytes,
        sha256: input.sourceFile.sha256,
        relativePath: `library/drawings/${drawing.id}/revisions/${revisionId}/source/${clean(input.sourceFile.fileName)}`,
        uploadedAt: input.createdAt
      };
      const revision: DrawingRevision = {
        id: revisionId,
        drawingId: drawing.id,
        sequence,
        sourceFile,
        currentApprovedModelId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      };
      return {
        ...world,
        revisions: [...world.revisions, revision]
      };
    }
    case "setCurrentRevision": {
      const input = command.input;
      const drawing = world.drawings.find((candidate) => candidate.id === input.drawingId);
      if (drawing === undefined) {
        throw new DomainInvariantError(`drawing ${input.drawingId} missing`);
      }
      const revision = world.revisions.find((candidate) => candidate.id === input.revisionId);
      if (revision === undefined) {
        throw new DomainInvariantError(`revision ${input.revisionId} missing`);
      }
      if (!canSetCurrentRevision(drawing, revision)) {
        throw new DomainInvariantError(
          `revision ${revision.id} does not belong to drawing ${drawing.id}`
        );
      }
      const next: Drawing = { ...drawing, currentRevisionId: revision.id, updatedAt: input.updatedAt };
      return {
        ...world,
        drawings: world.drawings.map((candidate) =>
          candidate.id === drawing.id ? next : candidate
        )
      };
    }
    case "deleteRevision": {
      const input = command.input;
      const drawing = world.drawings.find((candidate) => candidate.id === input.drawingId);
      if (drawing === undefined) {
        throw new DomainInvariantError(`drawing ${input.drawingId} missing`);
      }
      const revision = world.revisions.find((candidate) => candidate.id === input.revisionId);
      if (revision === undefined) {
        throw new DomainInvariantError(`revision ${input.revisionId} missing`);
      }
      if (revision.drawingId !== drawing.id) {
        throw new DomainInvariantError(
          `revision ${revision.id} does not belong to drawing ${drawing.id}`
        );
      }
      if (drawing.currentRevisionId === revision.id) {
        throw new DomainInvariantError(`current revision ${revision.id} cannot be deleted`);
      }
      return {
        ...world,
        drawings: world.drawings.map((candidate) =>
          candidate.id === drawing.id ? { ...candidate, updatedAt: input.updatedAt } : candidate
        ),
        revisions: world.revisions.filter((candidate) => candidate.id !== revision.id),
        facts: world.facts.filter((fact) => fact.revisionId !== revision.id),
        feedback: world.feedback.filter((entry) => entry.revisionId !== revision.id)
      };
    }
    case "addRevisionFact": {
      const input = command.input;
      const revision = world.revisions.find((candidate) => candidate.id === input.revisionId);
      if (revision === undefined) {
        throw new DomainInvariantError(`revision ${input.revisionId} missing`);
      }
      const fact: RevisionFact = {
        id: `fact-${input.revisionId}-${input.field}`,
        revisionId: revision.id,
        field: clean(input.field),
        value: clean(input.value),
        ...(input.unit !== undefined ? { unit: clean(input.unit) } : {}),
        source: input.source,
        ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
        createdAt: input.createdAt,
        ...(input.createdBy !== undefined ? { createdBy: clean(input.createdBy) } : {})
      };
      // Upsert by the stable canonical (revisionId, field) identity so a
      // user-supplemented fact replaces any older fact of the same field,
      // exactly like clarification answers do.
      const nextFacts = upsertFactsByField(world.facts, [fact]);
      return { ...world, facts: nextFacts };
    }
    case "addModelingFeedback": {
      const input = command.input;
      const revision = world.revisions.find((candidate) => candidate.id === input.revisionId);
      if (revision === undefined) {
        throw new DomainInvariantError(`revision ${input.revisionId} missing`);
      }
      const feedback: ModelingFeedback = {
        id: `feedback-${safeId(input.revisionId)}-${safeId(input.createdAt)}`,
        revisionId: revision.id,
        content: clean(input.content),
        source: "USER_SUPPLEMENT",
        createdAt: input.createdAt
      };
      return { ...world, feedback: [...world.feedback, feedback] };
    }
    case "updateStorageSettings": {
      const input = command.input;
      return { ...world, storageSettings: input.settings };
    }
    case "createRun": {
      const input = command.input;
      const revision = world.revisions.find((candidate) => candidate.id === input.revisionId);
      if (revision === undefined) {
        throw new DomainInvariantError(`revision ${input.revisionId} missing`);
      }
      const sequence = nextRunSequence(world.runs, revision.id);
      const runId = `run-${safeId(input.revisionId)}-r${String(sequence).padStart(2, "0")}`;
      // The repository owns snapshot freezing, mirroring the Runner: the input
      // is captured from the repository's own memory at the creation moment
      // (facts/feedback recorded up to `createdAt`), never supplied by the
      // caller, and is never modified afterwards.
      const createdAt = clock();
      // Defensive immutability: the snapshot is deep-cloned first so the stored
      // world never shares object references with the repository's own Memory
      // arrays, then deep-frozen so any mutation attempt on the returned Run
      // throws in strict mode instead of corrupting stored state.
      const inputSnapshot = deepFreeze(
        deepClone(
          buildInputSnapshot({
            revision,
            facts: world.facts.filter((fact) => fact.revisionId === revision.id),
            feedback: world.feedback.filter((entry) => entry.revisionId === revision.id),
            createdAt
          })
        )
      );
      const run: ModelingRun = deepFreeze({
        id: runId,
        number: `R${String(sequence).padStart(2, "0")}`,
        drawingId: input.drawingId,
        revisionId: revision.id,
        status: "QUEUED",
        stage: null,
        inputSnapshot,
        createdAt
      });
      return {
        ...world,
        runs: [...world.runs, run],
        runEvents: { ...world.runEvents, [runId]: [] }
      };
    }
    case "cancelRun": {
      const input = command.input;
      const run = world.runs.find((candidate) => candidate.id === input.runId);
      if (run === undefined) {
        throw new DomainInvariantError(`run ${input.runId} missing`);
      }
      transitionRunStatus(run.status, "CANCELLED");
      const cancelledAt = clock();
      const events = world.runEvents[run.id] ?? [];
      const startSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0);
      const cancelled: ModelingRun = {
        ...run,
        status: "CANCELLED",
        stage: null,
        completedAt: cancelledAt
      };
      return {
        ...world,
        runs: world.runs.map((candidate) => (candidate.id === run.id ? cancelled : candidate)),
        runEvents: {
          ...world.runEvents,
          [run.id]: [
            ...events,
            makeEvent(run.id, startSequence + 1, cancelledAt, {
              type: "CancellationRequested",
              ...(input.reason !== undefined ? { reason: input.reason } : {})
            }),
            makeEvent(run.id, startSequence + 2, cancelledAt, {
              type: "CancellationConfirmed"
            })
          ]
        }
      };
    }
    case "deleteRun": {
      const input = command.input;
      const run = world.runs.find((candidate) => candidate.id === input.runId);
      if (run === undefined) {
        throw new DomainInvariantError(`run ${input.runId} missing`);
      }
      const nextEvents = { ...world.runEvents };
      delete nextEvents[run.id];
      return {
        ...world,
        runs: world.runs.filter((candidate) => candidate.id !== run.id),
        runEvents: nextEvents
      };
    }
    case "deleteCostReport": {
      const input = command.input;
      const report = world.reports.find((candidate) => candidate.id === input.costReportId);
      if (report === undefined) {
        throw new DomainInvariantError(`cost report ${input.costReportId} missing`);
      }
      return {
        ...world,
        reports: world.reports.filter((candidate) => candidate.id !== report.id)
      };
    }
    case "submitClarification": {
      const input = command.input;
      const request = world.clarifications.find(
        (candidate) => candidate.id === input.clarificationRequestId
      );
      if (request === undefined) {
        throw new DomainInvariantError(`clarification ${input.clarificationRequestId} missing`);
      }
      const answered: ClarificationRequest = {
        ...request,
        status: "ANSWERED",
        answers: input.answers,
        answeredAt: input.answeredAt
      };
      const facts = factsFromAnswers(
        request,
        input.answers.map((answer) => ({ questionId: answer.questionId, value: answer.value })),
        input.answeredAt
      );
      // Upsert by the stable canonical fact field: a clarification answer
      // replaces any existing fact for the same (revision, field), so the
      // `材料` answer can never coexist with a contradictory drawing-confirmed
      // `材料` fact — exactly one canonical fact per field survives.
      const nextFacts = upsertFactsByField(world.facts, facts);
      return {
        ...world,
        clarifications: world.clarifications.map((candidate) =>
          candidate.id === request.id ? answered : candidate
        ),
        facts: nextFacts
      };
    }
    case "reviewModel": {
      const input = command.input;
      const model = world.models.find((candidate) => candidate.id === input.modelId);
      if (model === undefined) {
        throw new DomainInvariantError(`model ${input.modelId} missing`);
      }
      const nextStatus = transitionModelStatus(model.reviewStatus, input.result);
      const reviewId = `review-${model.id}-${input.result === "APPROVED" ? "approve" : "reject"}-${safeId(input.reviewedAt)}`;
      const review: ModelReview = {
        id: reviewId,
        modelId: model.id,
        result: input.result,
        reviewerId: input.reviewerId,
        createdAt: input.reviewedAt,
        ...(input.result === "REJECTED" ? { comment: clean(input.comment ?? "") } : {})
      };
      return {
        ...world,
        models: world.models.map((candidate) =>
          candidate.id === model.id ? { ...candidate, reviewStatus: nextStatus } : candidate
        ),
        revisions:
          input.result === "APPROVED"
            ? world.revisions.map((revision) =>
                revision.id === model.revisionId
                  ? { ...revision, currentApprovedModelId: model.id, updatedAt: input.reviewedAt }
                  : revision
              )
            : world.revisions,
        reviews: [...world.reviews, review],
        feedback:
          input.result === "REJECTED"
            ? [
                ...world.feedback,
                {
                  id: `feedback-${model.id}-${safeId(input.reviewedAt)}`,
                  revisionId: model.revisionId,
                  modelId: model.id,
                  reviewId,
                  content: clean(input.comment ?? ""),
                  source: "MODEL_REVIEW_REJECTED",
                  createdAt: input.reviewedAt
                }
              ]
            : world.feedback
      };
    }
    case "updateCostData": {
      const input = command.input;
      return {
        ...world,
        costData: {
          ...world.costData,
          materials: input.snapshot.materials,
          allowances: input.snapshot.allowances,
          fixedCosts: input.snapshot.fixedCosts,
          customFields: input.snapshot.customFields,
          definitions: world.costData.definitions.map((definition) =>
            definition.updatedAt < input.updatedAt
              ? { ...definition, updatedAt: input.updatedAt }
              : definition
          )
        }
      };
    }
    case "createCostReport": {
      const input = command.input;
      const revision = world.revisions.find((candidate) => candidate.id === input.revisionId);
      const drawing = world.drawings.find((candidate) => candidate.id === input.drawingId);
      if (revision === undefined || drawing === undefined) {
        throw new DomainInvariantError("revision or drawing missing");
      }
      if (!canCreateCostEstimateReport(drawing, revision)) {
        throw new DomainInvariantError(
          `revision ${revision.id} has no current approved model; cannot generate a report`
        );
      }
      const material = input.inputSnapshot.costData.materials.find(
        (candidate) => candidate.id === input.inputSnapshot.materialId
      );
      if (material === undefined) {
        throw new DomainInvariantError(
          `material ${input.inputSnapshot.materialId} missing from the report snapshot`
        );
      }
      // Central report creation: the stored result is ALWAYS recomputed from the
      // validated input snapshot by the deterministic synthetic engine. Any
      // caller-supplied `result` is ignored — a zero/forged result can never be
      // accepted, so CostParams cannot persist a zero report.
      const result = computeSyntheticCostResult({
        quantity: input.inputSnapshot.quantity,
        materialCostPerPiece: syntheticMaterialCostPerPiece({
          finishedVolume: input.inputSnapshot.finishedVolume,
          material
        }),
        fixedCosts: input.inputSnapshot.costData.fixedCosts
      });
      // Defense in depth: the internally recomputed result must itself satisfy
      // the nested amount/currency/basis constraints before it is stored.
      for (const line of result.fixedCostLines) {
        const lineProblems = validateFixedCostLine(line);
        if (lineProblems.length > 0) {
          throw new DomainInvariantError(lineProblems.join("; "));
        }
      }
      const revisionReports = world.reports.filter((report) => report.revisionId === revision.id);
      const label = `Q${String(revisionReports.length + 1).padStart(2, "0")}`;
      const reportId = `report-${safeId(input.revisionId)}-${label.toLowerCase()}`;
      // Deep-clone the immutable input snapshot before storage and freeze the
      // whole report so no later Cost Data edit or caller mutation can rewrite
      // this historical record.
      const storedInput = deepFreeze(deepClone(input.inputSnapshot));
      const storedResult = deepFreeze(deepClone(result));
      const report = deepFreeze({
        id: reportId,
        label,
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        modelId: input.modelId,
        quantity: input.inputSnapshot.quantity,
        snapshot: {
          input: storedInput,
          result: storedResult,
          createdAt: input.createdAt
        },
        createdAt: input.createdAt,
        updatedAt: input.createdAt
      });
      return { ...world, reports: [...world.reports, report] };
    }
  }
}

/**
 * Deterministic clock override used by tests to control timestamps (e.g. the
 * cancellation time). Production repositories use the real clock.
 */
let clockOverride: (() => string) | null = null;

export function setClockOverride(fn: (() => string) | null): void {
  clockOverride = fn;
}

function clock(): string {
  return clockOverride !== null ? clockOverride() : new Date().toISOString();
}
