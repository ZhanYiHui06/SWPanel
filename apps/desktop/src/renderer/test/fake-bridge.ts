/**
 * Deterministic fake `window.swpanel` bridge for WP6 tests.
 *
 * Implements the exact typed `SwpanelBridgeApi` surface with an in-memory
 * state machine, a call log, scriptable failures and a configurable file
 * picker. Product code never imports this module; it exists so unit/component
 * tests can drive the Drawing-management pages against an honest async bridge.
 *
 * The bridge surface is strictly allowlisted and frozen (the exact
 * {@link SwpanelBridgeApi} shape): the Phase 3 (P3-4) Run / Clarification
 * surface (`runs.list/getDetail/create/cancel/subscribe`,
 * `clarifications.get/submit`) is implemented honestly — run.create mints a
 * QUEUED Run, subscribe delivers the persisted backlog then scripted live
 * pushes via `emitRunEvents` — and nothing beyond the frozen surface exists.
 */

import type {
  Artifact,
  ClarificationRequest,
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  CostEstimateResult,
  Drawing,
  DrawingRevision,
  ModelingFeedback,
  ModelingRun,
  Model,
  ModelReview,
  RevisionFact,
  RunEvent,
  StorageSettings
} from "@swpanel/domain";
import type {
  ClarificationView,
  CostReportDetailView,
  CostReportListItemView,
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  ModelDetailView,
  RevisionDetailView,
  RevisionHistoryView,
  RunDetailView,
  RunListItemView,
  StorageSettingsView
} from "@swpanel/contracts";
import {
  calculateCostEstimate,
  costReportLabel,
  revisionLabel,
  runLabel,
  transitionModelStatus
} from "@swpanel/domain";
import type {
  AddModelingFeedbackBridgeInput,
  AddRevisionBridgeInput,
  AddRevisionFactBridgeInput,
  BridgeResult,
  ClarificationSubmitBridgeInput,
  CostDataBridgeResult,
  CostReportCreateBridgeInput,
  CostReportCreateBridgeResult,
  CostReportDeleteBridgeInput,
  CostReportDeleteBridgeResult,
  CostReportDetailBridgeResult,
  DeleteRevisionBridgeInput,
  ImportDrawingBridgeInput,
  RecoveryStatusBridgeResult,
  RunCancelBridgeInput,
  RunCancelBridgeResult,
  RunCreateBridgeInput,
  RunDeleteBridgeInput,
  RunDeleteBridgeResult,
  RunEventsBridgePush,
  RunSubscribeBridgeInput,
  ReviewModelBridgeInput,
  SecretsStatusBridgeResult,
  SelectedDrawingFile,
  SetCurrentRevisionBridgeInput,
  SwpanelBridgeApi,
  UpdateStorageSettingsBridgeInput
} from "../../main/bridge/bridge-contract.js";

/**
 * Synthetic company-global cost data baseline for the in-memory fake bridge.
 * Purely fictional values — never real enterprise pricing.
 */
const DEFAULT_COST_DATA: CostDataSnapshot = {
  materials: [
    {
      id: "mat-42crmo-fake",
      name: "42CrMo",
      purchasePrice: 5200,
      priceUnit: "元/吨",
      density: 7.85,
      densityUnit: "g/cm³",
      effectiveFrom: "2026-08-10T08:00:00.000Z",
      updatedAt: "2026-08-10T08:00:00.000Z"
    }
  ],
  allowances: [
    {
      id: "allowance-cylinder-fake",
      stockType: "CYLINDER",
      allowances: [
        { name: "直径方向默认余量", valueMm: 20 },
        { name: "长度方向默认余量", valueMm: 20 }
      ],
      updatedAt: "2026-08-10T08:00:00.000Z"
    },
    {
      id: "allowance-rect-fake",
      stockType: "RECTANGULAR_BAR",
      allowances: [
        { name: "长度方向默认余量", valueMm: 20 },
        { name: "宽度方向默认余量", valueMm: 20 },
        { name: "高度方向默认余量", valueMm: 20 }
      ],
      updatedAt: "2026-08-10T08:00:00.000Z"
    }
  ],
  fixedCosts: [
    {
      id: "fixed-processing-fake",
      name: "基础加工成本",
      amount: 500,
      currency: "CNY",
      basis: "PER_PIECE",
      defaultEnabled: true,
      updatedAt: "2026-08-10T08:00:00.000Z"
    },
    {
      id: "fixed-packaging-fake",
      name: "包装成本",
      amount: 80,
      currency: "CNY",
      basis: "PER_BATCH",
      defaultEnabled: true,
      updatedAt: "2026-08-10T08:00:00.000Z"
    }
  ],
  customFields: [
    {
      id: "custom-note-fake",
      key: "note.general",
      name: "备注",
      value: "常规加工工艺",
      semantics: "DISPLAY_ONLY",
      updatedAt: "2026-08-10T08:00:00.000Z"
    }
  ],
  capturedAt: "2026-08-10T08:00:00.000Z"
};

export interface FakeRevisionSeed {
  readonly id?: string;
  readonly sequence: number;
  readonly fileName: string;
  readonly sizeBytes?: number;
  readonly uploadedAt: string;
  readonly facts?: readonly RevisionFact[];
  readonly feedback?: readonly ModelingFeedback[];
}

export interface FakeDrawingSeed {
  readonly id?: string;
  readonly drawingNumber: string;
  readonly name: string;
  readonly currentRevisionId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly revisions: readonly FakeRevisionSeed[];
}

export interface FakeBridgeState {
  readonly drawings: readonly Drawing[];
  readonly revisions: readonly DrawingRevision[];
  readonly facts: readonly RevisionFact[];
  readonly feedback: readonly ModelingFeedback[];
  readonly settings: StorageSettings;
  readonly runs: readonly ModelingRun[];
  readonly runEvents: Readonly<Record<string, readonly RunEvent[]>>;
  readonly clarifications: readonly ClarificationRequest[];
  readonly models: readonly Model[];
  readonly reviews: readonly ModelReview[];
  readonly artifacts: readonly Artifact[];
  /** Latest startup recovery-scan summary resolved by `system.getRecoveryStatus`. */
  readonly recoveryStatus: RecoveryStatusBridgeResult;
  /** Secrets status resolved by the `secrets` surface (presence + mask only). */
  readonly apiKeyStatus: SecretsStatusBridgeResult;
}

export interface FakeBridgeOptions {
  seed?: readonly FakeDrawingSeed[];
  settings?: StorageSettings;
  /** Bridge method names that fail with RUNNER_UNAVAILABLE until cleared. */
  fail?: readonly string[];
  /** Pick result: a file, null file (canceled), or undefined (error). */
  pick?: SelectedDrawingFile | null | undefined;
  /**
   * Scripted cancel outcome returned WITHOUT mutating the store (deterministic
   * CANCEL_PENDING / FAILED / alreadyCancelled paths the real Runner can echo).
   * A function receives the runId and returns the outcome.
   */
  cancelResult?: RunCancelBridgeResult | ((runId: string) => RunCancelBridgeResult);
  /**
   * When provided, `runs.cancel` awaits it before resolving (lets tests hold a
   * cancel request in-flight to assert duplicate-submit guards).
   */
  cancelDelay?: () => Promise<void>;
  /** Initial recovery-scan summary resolved by `system.getRecoveryStatus`. */
  recoveryStatus?: RecoveryStatusBridgeResult;
  /** Initial secrets status resolved by the `secrets` surface. */
  apiKeyStatus?: SecretsStatusBridgeResult;
}

export interface FakeBridge {
  readonly api: SwpanelBridgeApi;
  readonly calls: string[];
  readonly state: () => FakeBridgeState;
  /** Removes a scripted failure (retry flows). */
  clearFailure(method: string): void;
  /** Replaces the picker result for the next selectDrawingFile call. */
  setPick(pick: SelectedDrawingFile | null | undefined): void;
  /** Seeds a Clarification Request so `clarifications.get` can resolve it. */
  addClarification(request: ClarificationRequest): void;
  /** Seeds a Run (e.g. a RUNNING one) so `runs.getDetail`/`runs.cancel` can resolve it. */
  addRun(run: ModelingRun): void;
  /** Appends events to one Run and pushes them to its live subscriptions. */
  emitRunEvents(runId: string, events: readonly RunEvent[]): void;
  /** Fails the live stream of one Run with a structured error push. */
  failRunStream(runId: string, code: string, message: string): void;
  /** Seeds a Model so `models.getDetail`/`models.review` can resolve it. */
  addModel(model: Model, artifacts?: readonly Artifact[]): void;
  /** Seeds a persisted Model Review record (already-performed review). */
  addModelReview(review: ModelReview): void;
}

function ok<T>(data: T): BridgeResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): BridgeResult<never> {
  return { ok: false, error: { code, message } };
}

/** Mirrors Main's `maskApiKey`: presence + masked preview, never the key. */
function maskStatus(apiKey: string): SecretsStatusBridgeResult {
  const maskedApiKey = apiKey.length > 7 ? `${apiKey.slice(0, 3)}****${apiKey.slice(-4)}` : "****";
  return { hasApiKey: true, maskedApiKey };
}

const DEFAULT_SETTINGS: StorageSettings = {
  dataRoot: "%LOCALAPPDATA%\\JANGHI\\SWPanel",
  workspaceRoot: "%LOCALAPPDATA%\\JANGHI\\SWPanel\\workspaces",
  constraint: "LOCAL_FIXED_NTFS",
  updatedAt: "2026-08-13T00:00:00.000Z"
};

/** Structured NOT_FOUND failure so pages can branch on the stable code. */
class FakeNotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "FakeNotFoundError";
  }
}

/** Structured invariant failure mirroring the Runner's DOMAIN_INVARIANT code. */
class FakeInvariantError extends Error {
  readonly code = "DOMAIN_INVARIANT";

  constructor(message: string) {
    super(message);
    this.name = "FakeInvariantError";
  }
}

export function createFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const calls: string[] = [];
  const failures = new Set(options.fail ?? []);
  let pick: SelectedDrawingFile | null | undefined = options.pick === undefined
    ? {
        token: "swsel_00000000000000000000000000000000",
        fileName: "PDJF001.01.pdf",
        format: "PDF",
        sizeBytes: 1_234_567,
        sha256: "0".repeat(64)
      }
    : options.pick;

  const drawings: Drawing[] = [];
  const revisions: DrawingRevision[] = [];
  const facts: RevisionFact[] = [];
  const feedback: ModelingFeedback[] = [];
  const runs: ModelingRun[] = [];
  const runEvents: Record<string, RunEvent[]> = {};
  const clarifications: ClarificationRequest[] = [];
  const models: Model[] = [];
  const reviews: ModelReview[] = [];
  const artifacts: Artifact[] = [];
  const costReports: CostReportDetailView[] = [];
  let currentCostData: CostDataSnapshot = { ...DEFAULT_COST_DATA };
  let settings: StorageSettings = options.settings ?? { ...DEFAULT_SETTINGS };
  const recoveryStatus: RecoveryStatusBridgeResult = options.recoveryStatus ?? null;
  let apiKeyStatus: SecretsStatusBridgeResult = options.apiKeyStatus ?? {
    hasApiKey: false,
    maskedApiKey: null
  };
  let drawingSequence = 0;
  let factSequence = 0;
  let feedbackSequence = 0;
  let runSequence = 0;
  let answerSequence = 0;
  let reviewSequence = 0;
  /** Live run-event subscriptions: runId -> subscriber pushes (backlog + live). */
  const runSubscriptions = new Map<string, Set<(push: RunEventsBridgePush) => void>>();

  const now = "2026-08-13T00:00:00.000Z";
  let lastPick: SelectedDrawingFile | null = null;

  function guard<T>(method: string, build: () => T): BridgeResult<T> {
    if (failures.has(method)) {
      return fail("RUNNER_UNAVAILABLE", `${method} 暂时不可用（模拟失败）`);
    }
    try {
      return ok(build());
    } catch (error) {
      if (error instanceof FakeNotFoundError) {
        return fail(error.code, error.message);
      }
      if (error instanceof FakeInvariantError) {
        return fail(error.code, error.message);
      }
      return fail(
        "INTERNAL",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  function record(method: string, payload?: unknown): void {
    calls.push(payload === undefined ? method : `${method}:${JSON.stringify(payload)}`);
  }

  function findDrawing(drawingId: string): Drawing {
    const drawing = drawings.find((candidate) => candidate.id === drawingId);
    if (drawing === undefined) {
      throw new FakeNotFoundError(`drawing ${drawingId} not found`);
    }
    return drawing;
  }

  function findRevision(revisionId: string): DrawingRevision {
    const revision = revisions.find((candidate) => candidate.id === revisionId);
    if (revision === undefined) {
      throw new FakeNotFoundError(`revision ${revisionId} not found`);
    }
    return revision;
  }

  function listItems(): DrawingListItemView[] {
    return drawings
      .map((drawing) => {
        const drawingRevisions = revisions.filter((revision) => revision.drawingId === drawing.id);
        const current = drawingRevisions.find((revision) => revision.id === drawing.currentRevisionId);
        const latest = drawingRevisions.at(-1);
        return {
          drawingId: drawing.id,
          drawingNumber: drawing.drawingNumber,
          name: drawing.name,
          currentRevisionId: drawing.currentRevisionId,
          currentRevisionLabel: current === undefined ? null : revisionLabel(current.sequence),
          currentApprovedModelId: current?.currentApprovedModelId ?? null,
          runStatus: null,
          updatedAt: drawing.updatedAt,
          totalRevisionCount: drawingRevisions.length,
          latestRevisionLabel: latest === undefined ? null : revisionLabel(latest.sequence),
          hasOpenClarification: false
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function toDetail(drawingId: string): DrawingDetailView {
    const drawing = findDrawing(drawingId);
    const drawingRevisions = revisions.filter((revision) => revision.drawingId === drawing.id);
    return {
      drawing: {
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        name: drawing.name,
        currentRevisionId: drawing.currentRevisionId,
        createdAt: drawing.createdAt,
        updatedAt: drawing.updatedAt
      },
      revisions: drawingRevisions
        .sort((a, b) => a.sequence - b.sequence)
        .map((revision) => ({
          revisionId: revision.id,
          revisionLabel: revisionLabel(revision.sequence),
          isCurrent: revision.id === drawing.currentRevisionId,
          currentApprovedModelId: revision.currentApprovedModelId,
          isCurrentApprovedModel: false,
          createdAt: revision.createdAt,
          updatedAt: revision.updatedAt
        }))
    };
  }

  function toHistory(drawingId: string): DrawingHistoryView {
    const drawing = findDrawing(drawingId);
    const drawingRevisions = revisions.filter((revision) => revision.drawingId === drawing.id);
    return {
      drawingId: drawing.id,
      drawingNumber: drawing.drawingNumber,
      name: drawing.name,
      currentRevisionId: drawing.currentRevisionId,
      revisions: drawingRevisions
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

  function toRevisionDetail(drawingId: string, revisionId: string): RevisionDetailView {
    const drawing = findDrawing(drawingId);
    const revision = findRevision(revisionId);
    const revisionModels = models.filter((model) => model.revisionId === revisionId);
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
      runs: runs
        .filter((run) => run.revisionId === revisionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(toRunListItem),
      models: revisionModels.map((model) => ({
        modelId: model.id,
        modelLabel: model.number,
        reviewStatus: model.reviewStatus,
        isCurrentApproved: revision.currentApprovedModelId === model.id,
        generatedAt: model.generatedAt,
        runId: model.runId
      })),
      costReports: costReports
        .filter((report) => report.revisionId === revisionId)
        .map(toCostReportListItem),
      facts: facts.filter((fact) => fact.revisionId === revisionId),
      modelingFeedback: feedback.filter((entry) => entry.revisionId === revisionId)
    };
  }

  function toCostReportListItem(report: CostReportDetailView): CostReportListItemView {
    return {
      costReportId: report.costReportId,
      label: report.label,
      quantity: report.quantity,
      perPieceCost: report.result.perPieceCost,
      totalCost: report.result.totalCost,
      currency: report.result.currency,
      createdAt: report.createdAt
    };
  }

  function toCostReportDetail(
    input: CostEstimateInputSnapshot,
    createdAt: string
  ): CostReportDetailView {
    // The renderer never submits an authoritative result: like the real Runner,
    // the fake computes the deterministic result from the frozen input via the
    // pure domain calculator.
    const result: CostEstimateResult = calculateCostEstimate(input);
    const revisionReports = costReports.filter((report) => report.revisionId === input.revisionId);
    const sequence = revisionReports.length + 1;
    return {
      costReportId: `report-${input.revisionId}-q${sequence.toString().padStart(2, "0")}`,
      label: costReportLabel(sequence),
      drawingId: input.drawingId,
      revisionId: input.revisionId,
      modelId: input.modelId,
      quantity: input.quantity,
      createdAt,
      snapshot: { input, result, createdAt },
      result: {
        rawStockVolume: result.rawStockVolume,
        materialCost: result.materialCost,
        fixedCostLines: result.fixedCostLines,
        perPieceCost: result.perPieceCost,
        totalCost: result.totalCost,
        currency: result.currency
      }
    };
  }

  function toRevisionHistory(drawingId: string, revisionId: string): RevisionHistoryView {
    const drawing = findDrawing(drawingId);
    const revision = findRevision(revisionId);
    return {
      revisionId: revision.id,
      revisionLabel: revisionLabel(revision.sequence),
      drawingId: drawing.id,
      drawingNumber: drawing.drawingNumber,
      isCurrent: drawing.currentRevisionId === revision.id,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt,
      facts: facts.filter((fact) => fact.revisionId === revisionId),
      modelingFeedback: feedback.filter((entry) => entry.revisionId === revisionId)
    };
  }

  /** Generates fact/feedback ids that never collide with seeded ids. */
  function nextFactId(): string {
    let id: string;
    do {
      factSequence += 1;
      id = `fact-${factSequence}`;
    } while (facts.some((fact) => fact.id === id));
    return id;
  }

  function nextFeedbackId(): string {
    let id: string;
    do {
      feedbackSequence += 1;
      id = `feedback-${feedbackSequence}`;
    } while (feedback.some((entry) => entry.id === id));
    return id;
  }

  function makeRevisionSourceFile(
    drawingId: string,
    revisionId: string,
    fileName: string,
    uploadedAt: string,
    sizeBytes = 1_234_567
  ): DrawingRevision["sourceFile"] {
    return {
      id: `file-${revisionId}`,
      fileName,
      format: "PDF",
      sizeBytes,
      sha256: "a".repeat(64),
      relativePath: `library/drawings/${drawingId}/revisions/${revisionId}/source/${fileName}`,
      uploadedAt
    };
  }

  // Seed the in-memory store.
  for (const seed of options.seed ?? []) {
    const drawingId = seed.id ?? `drawing-${drawingSequence + 1}`;
    drawingSequence += 1;
    const seededRevisions: DrawingRevision[] = seed.revisions.map((revisionSeed) => {
      const revisionId = revisionSeed.id ?? `rev-${drawingId}-${revisionSeed.sequence}`;
      const uploadedAt = revisionSeed.uploadedAt;
      const revision: DrawingRevision = {
        id: revisionId,
        drawingId,
        sequence: revisionSeed.sequence,
        sourceFile: makeRevisionSourceFile(
          drawingId,
          revisionId,
          revisionSeed.fileName,
          uploadedAt,
          revisionSeed.sizeBytes
        ),
        currentApprovedModelId: null,
        createdAt: uploadedAt,
        updatedAt: uploadedAt
      };
      return revision;
    });
    const created = seed.createdAt ?? seededRevisions[0]?.createdAt ?? now;
    const updated = seed.updatedAt ?? seededRevisions.at(-1)?.createdAt ?? created;
    drawings.push({
      id: drawingId,
      drawingNumber: seed.drawingNumber,
      name: seed.name,
      currentRevisionId: seed.currentRevisionId ?? seededRevisions.at(-1)?.id ?? null,
      createdAt: created,
      updatedAt: updated
    });
    revisions.push(...seededRevisions);
    for (const revisionSeed of seed.revisions) {
      for (const fact of revisionSeed.facts ?? []) {
        facts.push(fact);
      }
      for (const entry of revisionSeed.feedback ?? []) {
        feedback.push(entry);
      }
    }
  }

  /** Finds a Run or throws a structured NOT_FOUND (mirrors the Runner). */
  function findRun(runId: string): ModelingRun {
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new FakeNotFoundError(`run ${runId} not found`);
    return run;
  }

  function toRunListItem(run: ModelingRun): RunListItemView {
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

  function toRunDetail(runId: string): RunDetailView {
    const run = findRun(runId);
    const events = runEvents[runId] ?? [];
    // Mirrors the Runner's persisted row: activity/progress are derived from
    // the applied event stream.
    const derived = deriveActivityAndProgress(events);
    return {
      run: {
        runId: run.id,
        runLabel: run.number,
        drawingId: run.drawingId,
        revisionId: run.revisionId,
        status: run.status,
        stage: run.stage,
        activity: derived.activity,
        progressPercent: derived.progressPercent,
        createdAt: run.createdAt,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        failureCode: run.failureCode ?? null,
        failureMessage: run.failureMessage ?? null,
        modelId: run.modelId ?? null,
        clarificationRequestId: run.clarificationRequestId ?? null
      },
      events,
      lastEventSequence: events.reduce((max, event) => Math.max(max, event.sequence), 0)
    };
  }

  /** Latest user-visible activity/progress from the ordered event stream. */
  function deriveActivityAndProgress(events: readonly RunEvent[]): {
    activity: string | null;
    progressPercent: number | null;
  } {
    let activity: string | null = null;
    let progressPercent: number | null = null;
    for (const event of events) {
      if (event.type === "StageChanged") {
        if (event.activity !== undefined) activity = event.activity;
      } else if (event.type === "ActivityUpdated") {
        activity = event.activity;
      } else if (event.type === "ProgressUpdated") {
        progressPercent = event.progressPercent;
        if (event.activity !== undefined) activity = event.activity;
      }
    }
    return { activity, progressPercent };
  }

  function toClarificationView(request: ClarificationRequest): ClarificationView {
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

  /** Aggregated Model detail from the in-memory store (mirrors the Runner view). */
  function toModelDetail(modelId: string): ModelDetailView {
    const model = models.find((candidate) => candidate.id === modelId);
    if (model === undefined) throw new FakeNotFoundError(`model ${modelId} not found`);
    const revision = revisions.find((candidate) => candidate.id === model.revisionId);
    const revisionReviews = reviews.filter((review) => review.modelId === model.id);
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
      artifacts: artifacts
        .filter((artifact) => artifact.modelId === model.id)
        .map((artifact) => ({
          artifactId: artifact.id,
          kind: artifact.kind,
          fileName: artifact.fileName,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256
        })),
      reviews: revisionReviews.map((review) => ({
        reviewId: review.id,
        result: review.result,
        reviewerId: review.reviewerId,
        comment: review.comment ?? null,
        createdAt: review.createdAt
      }))
    };
  }

  /**
   * Applies a model review exactly like the Runner: PENDING_REVIEW -> APPROVED
   * repoints the revision's current approved model; PENDING_REVIEW -> REJECTED
   * records the review (with a REQUIRED comment) and writes Modeling Feedback.
   */
  function applyModelReview(input: ReviewModelBridgeInput): ModelDetailView {
    const model = models.find((candidate) => candidate.id === input.modelId);
    if (model === undefined) throw new FakeNotFoundError(`model ${input.modelId} not found`);
    if (model.reviewStatus !== "PENDING_REVIEW") {
      throw new FakeInvariantError(
        `model ${model.id} is ${model.reviewStatus}; only PENDING_REVIEW models can be reviewed`
      );
    }
    const nextStatus = transitionModelStatus(model.reviewStatus, input.result);
    reviewSequence += 1;
    const review: ModelReview = {
      id: `review-${reviewSequence}`,
      modelId: model.id,
      result: input.result,
      reviewerId: input.reviewerId,
      createdAt: input.reviewedAt,
      ...(input.result === "REJECTED" ? { comment: input.comment } : {})
    };
    const modelIndex = models.findIndex((candidate) => candidate.id === model.id);
    models[modelIndex] = { ...model, reviewStatus: nextStatus };
    reviews.push(review);
    if (input.result === "APPROVED") {
      const revisionIndex = revisions.findIndex((candidate) => candidate.id === model.revisionId);
      const revision = revisions[revisionIndex];
      if (revision !== undefined) {
        revisions[revisionIndex] = {
          ...revision,
          currentApprovedModelId: model.id,
          updatedAt: input.reviewedAt
        };
      }
    } else {
      const comment = input.comment ?? "";
      feedback.push({
        id: `feedback-${review.id}`,
        revisionId: model.revisionId,
        modelId: model.id,
        reviewId: review.id,
        content: comment,
        source: "MODEL_REVIEW_REJECTED",
        createdAt: input.reviewedAt
      });
    }
    return toModelDetail(model.id);
  }

  /** Pushes one batch/error to every live subscription of a Run. */
  function pushToRunSubscribers(runId: string, push: RunEventsBridgePush): void {
    const subscribers = runSubscriptions.get(runId);
    if (subscribers === undefined) return;
    for (const subscriber of [...subscribers]) {
      subscriber(push);
    }
  }

  /**
   * Mirrors the Runner's persisted status transitions when scripted events are
   * emitted: the first execution event starts a QUEUED run, terminal events
   * land the run status (a `Completed` event without modelId stays model-less).
   */
  function applyEventToRun(run: ModelingRun, event: RunEvent): void {
    switch (event.type) {
      case "StageChanged":
        if (run.status === "QUEUED") {
          run.status = "RUNNING";
          run.startedAt = event.occurredAt;
        }
        run.stage = event.stage;
        break;
      case "ActivityUpdated":
      case "ProgressUpdated":
        if (run.status === "QUEUED") {
          run.status = "RUNNING";
          run.startedAt = event.occurredAt;
        }
        break;
      case "ClarificationRequired":
        run.status = "CLARIFICATION_REQUIRED";
        run.clarificationRequestId = event.clarificationRequestId;
        run.completedAt = event.occurredAt;
        break;
      case "Completed":
        run.status = "COMPLETED";
        run.completedAt = event.occurredAt;
        if (event.modelId !== undefined) run.modelId = event.modelId;
        break;
      case "Failed":
        run.status = "FAILED";
        run.failureCode = event.failureCode;
        if (event.failureMessage !== undefined) run.failureMessage = event.failureMessage;
        run.completedAt = event.occurredAt;
        break;
      case "CancellationConfirmed":
        run.status = "CANCELLED";
        run.completedAt = event.occurredAt;
        break;
      default:
        break;
    }
  }

  const api: SwpanelBridgeApi = {
    metadata: Object.freeze({
      platform: "test",
      versions: Object.freeze({ chrome: "1", electron: "1" })
    }),
    health: Object.freeze({
      get: () => Promise.resolve(guard("health.get", () => ({ status: "READY" as const, serverInstanceId: "fake", error: null })))
    }),
    files: Object.freeze({
      selectDrawingFile: () => {
        record("files.selectDrawingFile");
        const current = pick;
        if (current === undefined) {
          return Promise.resolve(fail("SELECTION_INVALID", "模拟文件选择失败"));
        }
        if (current === null) {
          return Promise.resolve(ok({ canceled: true, file: null }));
        }
        lastPick = current;
        return Promise.resolve(ok({ canceled: false, file: current }));
      }
    }),
    drawings: Object.freeze({
      list: () => {
        record("drawings.list");
        return Promise.resolve(guard("drawings.list", () => listItems()));
      },
      getHistory: (drawingId: string) => {
        record("drawings.getHistory", drawingId);
        return Promise.resolve(guard("drawings.getHistory", () => toHistory(drawingId)));
      },
      getDetail: (drawingId: string) => {
        record("drawings.getDetail", drawingId);
        return Promise.resolve(guard("drawings.getDetail", () => toDetail(drawingId)));
      },
      getRevisionHistory: (drawingId: string, revisionId: string) => {
        record("drawings.getRevisionHistory", { drawingId, revisionId });
        return Promise.resolve(
          guard("drawings.getRevisionHistory", () => toRevisionHistory(drawingId, revisionId))
        );
      },
      getRevisionDetail: (drawingId: string, revisionId: string) => {
        record("drawings.getRevisionDetail", { drawingId, revisionId });
        return Promise.resolve(
          guard("drawings.getRevisionDetail", () => toRevisionDetail(drawingId, revisionId))
        );
      },
      importDrawing: (input: ImportDrawingBridgeInput) => {
        record("drawings.importDrawing", input);
        return Promise.resolve(
          guard("drawings.importDrawing", () => {
            if (drawings.some((candidate) => candidate.drawingNumber === input.drawingNumber)) {
              throw new Error("A Drawing with number " + input.drawingNumber + " already exists");
            }
            drawingSequence += 1;
            const drawingId = `drawing-${drawingSequence}`;
            const revisionId = `rev-${drawingId}-1`;
            const sourceFile = makeRevisionSourceFile(
              drawingId,
              revisionId,
              lastPick?.fileName ?? `${input.drawingNumber}.pdf`,
              input.createdAt,
              lastPick?.sizeBytes
            );
            const revision: DrawingRevision = {
              id: revisionId,
              drawingId,
              sequence: 1,
              sourceFile,
              currentApprovedModelId: null,
              createdAt: input.createdAt,
              updatedAt: input.createdAt
            };
            const drawing: Drawing = {
              id: drawingId,
              drawingNumber: input.drawingNumber,
              name: input.name,
              currentRevisionId: revisionId,
              createdAt: input.createdAt,
              updatedAt: input.createdAt
            };
            drawings.push(drawing);
            revisions.push(revision);
            return { drawing, revision, sourceFile };
          })
        );
      },
      addRevision: (input: AddRevisionBridgeInput) => {
        record("drawings.addRevision", input);
        return Promise.resolve(
          guard("drawings.addRevision", () => {
            const drawing = findDrawing(input.drawingId);
            const drawingRevisions = revisions.filter((revision) => revision.drawingId === drawing.id);
            const sequence = drawingRevisions.reduce((max, revision) => Math.max(max, revision.sequence), 0) + 1;
            const revisionId = `rev-${drawing.id}-${sequence}`;
            const sourceFile = makeRevisionSourceFile(drawing.id, revisionId, `V${sequence}.pdf`, input.createdAt);
            const revision: DrawingRevision = {
              id: revisionId,
              drawingId: drawing.id,
              sequence,
              sourceFile,
              currentApprovedModelId: null,
              createdAt: input.createdAt,
              updatedAt: input.createdAt
            };
            revisions.push(revision);
            drawing.updatedAt = input.createdAt;
            return { revision, sourceFile };
          })
        );
      },
      setCurrentRevision: (input: SetCurrentRevisionBridgeInput) => {
        record("drawings.setCurrentRevision", input);
        return Promise.resolve(
          guard("drawings.setCurrentRevision", () => {
            const drawing = findDrawing(input.drawingId);
            findRevision(input.revisionId);
            drawing.currentRevisionId = input.revisionId;
            drawing.updatedAt = input.updatedAt;
            return { ...drawing };
          })
        );
      },
      deleteRevision: (input: DeleteRevisionBridgeInput) => {
        record("drawings.deleteRevision", input);
        return Promise.resolve(
          guard("drawings.deleteRevision", () => {
            const drawing = findDrawing(input.drawingId);
            const revision = findRevision(input.revisionId);
            if (revision.drawingId !== drawing.id) {
              throw new Error(`revision ${input.revisionId} does not belong to drawing ${drawing.id}`);
            }
            if (drawing.currentRevisionId === revision.id) {
              throw new FakeInvariantError(`current revision ${revision.id} cannot be deleted`);
            }
            const revisionIndex = revisions.findIndex((candidate) => candidate.id === revision.id);
            if (revisionIndex >= 0) revisions.splice(revisionIndex, 1);
            for (let index = facts.length - 1; index >= 0; index--) {
              if ((facts[index] as RevisionFact).revisionId === revision.id) facts.splice(index, 1);
            }
            for (let index = feedback.length - 1; index >= 0; index--) {
              if ((feedback[index] as ModelingFeedback).revisionId === revision.id) {
                feedback.splice(index, 1);
              }
            }
            drawing.updatedAt = input.updatedAt;
            return { drawing: { ...drawing }, deletedRevisionId: revision.id };
          })
        );
      },
      addRevisionFact: (input: AddRevisionFactBridgeInput) => {
        record("drawings.addRevisionFact", input);
        return Promise.resolve(
          guard("drawings.addRevisionFact", () => {
            const fact: RevisionFact = {
              id: nextFactId(),
              revisionId: input.revisionId,
              field: input.field,
              value: input.value,
              ...(input.unit === undefined ? {} : { unit: input.unit }),
              source: input.source,
              createdAt: input.createdAt
            };
            facts.push(fact);
            return fact;
          })
        );
      },
      addModelingFeedback: (input: AddModelingFeedbackBridgeInput) => {
        record("drawings.addModelingFeedback", input);
        return Promise.resolve(
          guard("drawings.addModelingFeedback", () => {
            const entry: ModelingFeedback = {
              id: nextFeedbackId(),
              revisionId: input.revisionId,
              content: input.content,
              source: "USER_SUPPLEMENT",
              createdAt: input.createdAt
            };
            feedback.push(entry);
            return entry;
          })
        );
      }
    }),
    storage: Object.freeze({
      getSettings: (): Promise<BridgeResult<StorageSettingsView>> => {
        record("storage.getSettings");
        return Promise.resolve(guard("storage.getSettings", () => ({ settings: { ...settings } })));
      },
      updateSettings: (input: UpdateStorageSettingsBridgeInput): Promise<BridgeResult<StorageSettingsView>> => {
        record("storage.updateSettings", input);
        return Promise.resolve(
          guard("storage.updateSettings", () => {
            settings = { ...input.settings };
            return { settings: { ...settings } };
          })
        );
      }
    }),
    runs: Object.freeze({
      list: (): Promise<BridgeResult<readonly RunListItemView[]>> => {
        record("runs.list");
        return Promise.resolve(
          guard("runs.list", () =>
            [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toRunListItem)
          )
        );
      },
      getDetail: (runId: string): Promise<BridgeResult<RunDetailView>> => {
        record("runs.getDetail", runId);
        return Promise.resolve(guard("runs.getDetail", () => toRunDetail(runId)));
      },
      create: (input: RunCreateBridgeInput): Promise<BridgeResult<ModelingRun>> => {
        record("runs.create", input);
        return Promise.resolve(
          guard("runs.create", () => {
            const drawing = findDrawing(input.drawingId);
            const revision = findRevision(input.revisionId);
            if (revision.drawingId !== drawing.id) {
              throw new Error(`revision ${input.revisionId} does not belong to drawing ${drawing.id}`);
            }
            runSequence += 1;
            const id = `run-${runSequence}`;
            const revisionRuns = runs.filter((run) => run.revisionId === revision.id);
            const number = runLabel(
              revisionRuns.reduce((max, run) => Math.max(max, parseInt(run.number.slice(1), 10) || 0), 0) + 1
            );
            const createdAt = "2026-08-13T10:00:00.000Z";
            const run: ModelingRun = {
              id,
              number,
              drawingId: drawing.id,
              revisionId: revision.id,
              status: "QUEUED",
              stage: null,
              inputSnapshot: {
                drawingId: drawing.id,
                revisionId: revision.id,
                originalFileRef: revision.sourceFile.relativePath,
                revisionFacts: facts.filter((fact) => fact.revisionId === revision.id),
                modelingFeedback: feedback.filter((entry) => entry.revisionId === revision.id),
                promptTemplateVersion: "fake-bridge-v1",
                skill: { name: "solidworks-build-part-from-drawing", sha256: "b".repeat(64) },
                agentConfigId: "fake-agent-config",
                createdAt
              },
              createdAt
            };
            runs.push(run);
            runEvents[id] = [];
            return run;
          })
        );
      },
      cancel: async (input: RunCancelBridgeInput): Promise<BridgeResult<RunCancelBridgeResult>> => {
        record("runs.cancel", input);
        if (options.cancelDelay !== undefined) {
          await options.cancelDelay();
        }
        return Promise.resolve(
          guard("runs.cancel", () => {
            const run = findRun(input.runId);
            if (options.cancelResult !== undefined) {
              return typeof options.cancelResult === "function"
                ? options.cancelResult(input.runId)
                : options.cancelResult;
            }
            if (run.status === "CANCELLED") {
              return { runId: run.id, status: "CANCELLED" as const, alreadyCancelled: true };
            }
            if (run.status !== "QUEUED" && run.status !== "RUNNING") {
              throw new FakeInvariantError(
                `run ${run.id} is ${run.status}; only QUEUED or RUNNING runs can be cancelled`
              );
            }
            const events = runEvents[run.id] ?? [];
            const now = "2026-08-13T10:01:00.000Z";
            const requested: RunEvent = {
              contractVersion: 1,
              runId: run.id,
              attemptId: `attempt-${run.id}-cancel`,
              sequence: events.length + 1,
              occurredAt: now,
              type: "CancellationRequested",
              ...(input.reason === undefined ? {} : { reason: input.reason })
            };
            const confirmed: RunEvent = {
              contractVersion: 1,
              runId: run.id,
              attemptId: `attempt-${run.id}-cancel`,
              sequence: events.length + 2,
              occurredAt: now,
              type: "CancellationConfirmed"
            };
            runEvents[run.id] = [...events, requested, confirmed];
            run.status = "CANCELLED";
            run.completedAt = now;
            pushToRunSubscribers(run.id, {
              kind: "runEvents",
              runId: run.id,
              fromSequence: requested.sequence,
              events: [requested, confirmed]
            });
            // Scripted behavior note: the real Runner confirms a RUNNING
            // cancellation only after the executor stops cooperatively and the
            // attempt workspace is cleaned. The fake confirms immediately
            // (deterministic for renderer tests) and still appends the exact
            // cancellation pair the real history would carry.
            return { runId: run.id, status: "CANCELLED" as const, alreadyCancelled: false };
          })
        );
      },
      delete: (input: RunDeleteBridgeInput): Promise<BridgeResult<RunDeleteBridgeResult>> => {
        record("runs.delete", input);
        return Promise.resolve(
          guard("runs.delete", () => {
            const run = findRun(input.runId);
            if (run.drawingId !== input.drawingId || run.revisionId !== input.revisionId) {
              throw new FakeInvariantError(
                `run ${input.runId} does not belong to drawing ${input.drawingId} revision ${input.revisionId}`
              );
            }
            const index = runs.findIndex((candidate) => candidate.id === run.id);
            if (index >= 0) runs.splice(index, 1);
            delete runEvents[run.id];
            return { runId: run.id, attemptSequences: [1] };
          })
        );
      },
      subscribe: (
        input: RunSubscribeBridgeInput,
        onPush: (push: RunEventsBridgePush) => void
      ): (() => void) => {
        record("runs.subscribe", input);
        // Real Runner alignment: subscribing to an UNKNOWN run is rejected
        // with a structured error — the renderer receives a runEventsError
        // push (the client surfaces the Runner's NOT_FOUND as
        // RUN_EVENT_INVALID) and NO subscription is registered.
        const run = runs.find((candidate) => candidate.id === input.runId);
        if (run === undefined) {
          onPush({
            kind: "runEventsError",
            runId: input.runId,
            error: {
              code: "RUN_EVENT_INVALID",
              message: `Run ${input.runId} was not found (NOT_FOUND)`
            }
          });
          return () => {};
        }
        const backlog = (runEvents[input.runId] ?? []).filter(
          (event) => event.sequence >= input.fromSequence
        );
        // The backlog is delivered first (like the Runner's subscribe response),
        // then scripted live pushes via emitRunEvents / failRunStream.
        const first = backlog[0];
        onPush({
          kind: "runEvents",
          runId: input.runId,
          fromSequence: first === undefined ? input.fromSequence : first.sequence,
          events: backlog
        });
        let subscribers = runSubscriptions.get(input.runId);
        if (subscribers === undefined) {
          subscribers = new Set();
          runSubscriptions.set(input.runId, subscribers);
        }
        subscribers.add(onPush);
        return () => {
          const current = runSubscriptions.get(input.runId);
          if (current === undefined) return;
          current.delete(onPush);
          if (current.size === 0) runSubscriptions.delete(input.runId);
        };
      }
    }),
    clarifications: Object.freeze({
      get: (clarificationRequestId: string): Promise<BridgeResult<ClarificationView>> => {
        record("clarifications.get", clarificationRequestId);
        return Promise.resolve(
          guard("clarifications.get", () => {
            const request = clarifications.find(
              (candidate) => candidate.id === clarificationRequestId
            );
            if (request === undefined) {
              throw new FakeNotFoundError(
                `clarification request ${clarificationRequestId} not found`
              );
            }
            return toClarificationView(request);
          })
        );
      },
      submit: (input: ClarificationSubmitBridgeInput): Promise<BridgeResult<ClarificationView>> => {
        record("clarifications.submit", input);
        return Promise.resolve(
          guard("clarifications.submit", () => {
            const request = clarifications.find(
              (candidate) => candidate.id === input.clarificationRequestId
            );
            if (request === undefined) {
              throw new FakeNotFoundError(
                `clarification request ${input.clarificationRequestId} not found`
              );
            }
            if (request.status !== "OPEN") {
              throw new FakeInvariantError(
                `clarification request ${request.id} is ${request.status}; only an OPEN request can be answered`
              );
            }
            const answers = input.answers.map((answer) => {
              answerSequence += 1;
              return { ...answer, id: `answer-${answerSequence}` };
            });
            request.status = "ANSWERED";
            request.answers = answers;
            request.answeredAt = input.answeredAt;
            return toClarificationView(request);
          })
        );
      }
    }),
    models: Object.freeze({
      getDetail: (modelId: string): Promise<BridgeResult<ModelDetailView>> => {
        record("models.getDetail", modelId);
        return Promise.resolve(guard("models.getDetail", () => toModelDetail(modelId)));
      },
      review: (input: ReviewModelBridgeInput): Promise<BridgeResult<ModelDetailView>> => {
        record("models.review", input);
        return Promise.resolve(guard("models.review", () => applyModelReview(input)));
      }
    }),
    cost: Object.freeze({
      getEffectiveCostData: (): Promise<BridgeResult<CostDataBridgeResult>> => {
        record("cost.getEffectiveCostData");
        return Promise.resolve(guard("cost.getEffectiveCostData", () => ({ ...currentCostData })));
      },
      updateCostData: (snapshot: CostDataSnapshot): Promise<BridgeResult<CostDataBridgeResult>> => {
        record("cost.updateCostData", snapshot);
        return Promise.resolve(
          guard("cost.updateCostData", () => {
            currentCostData = snapshot;
            return snapshot;
          })
        );
      },
      getReportDetail: (
        costReportId: string
      ): Promise<BridgeResult<CostReportDetailBridgeResult>> => {
        record("cost.getReportDetail", costReportId);
        return Promise.resolve(
          guard("cost.getReportDetail", () => {
            const found = costReports.find((report) => report.costReportId === costReportId);
            if (found === undefined) {
              throw new Error(`cost report ${costReportId} not found`);
            }
            return found;
          })
        );
      },
      createReport: (
        input: CostReportCreateBridgeInput
      ): Promise<BridgeResult<CostReportCreateBridgeResult>> => {
        record("cost.createReport", input);
        return Promise.resolve(
          guard("cost.createReport", () => {
            const report = toCostReportDetail(input.input, input.createdAt);
            costReports.push(report);
            return report;
          })
        );
      },
      deleteReport: (
        input: CostReportDeleteBridgeInput
      ): Promise<BridgeResult<CostReportDeleteBridgeResult>> => {
        record("cost.deleteReport", input);
        return Promise.resolve(
          guard("cost.deleteReport", () => {
            const index = costReports.findIndex(
              (report) => report.costReportId === input.costReportId
            );
            if (index < 0) throw new FakeNotFoundError(`cost report ${input.costReportId} not found`);
            costReports.splice(index, 1);
            return { costReportId: input.costReportId };
          })
        );
      }
    }),
    system: Object.freeze({
      getRecoveryStatus: (): Promise<BridgeResult<RecoveryStatusBridgeResult>> => {
        record("system.getRecoveryStatus");
        return Promise.resolve(guard("system.getRecoveryStatus", () => recoveryStatus));
      }
    }),
    secrets: Object.freeze({
      getStatus: (): Promise<BridgeResult<SecretsStatusBridgeResult>> => {
        record("secrets.getStatus");
        return Promise.resolve(guard("secrets.getStatus", () => ({ ...apiKeyStatus })));
      },
      setApiKey: (apiKey: string): Promise<BridgeResult<SecretsStatusBridgeResult>> => {
        record("secrets.setApiKey", { apiKey });
        return Promise.resolve(
          guard("secrets.setApiKey", () => {
            apiKeyStatus = maskStatus(apiKey);
            return { ...apiKeyStatus };
          })
        );
      },
      clearApiKey: (): Promise<BridgeResult<SecretsStatusBridgeResult>> => {
        record("secrets.clearApiKey");
        return Promise.resolve(
          guard("secrets.clearApiKey", () => {
            apiKeyStatus = { hasApiKey: false, maskedApiKey: null };
            return { ...apiKeyStatus };
          })
        );
      }
    })
  };

  return {
    api,
    calls,
    state: () => ({
      drawings: [...drawings],
      revisions: [...revisions],
      facts: [...facts],
      feedback: [...feedback],
      settings: { ...settings },
      runs: [...runs],
      runEvents: Object.fromEntries(
        Object.entries(runEvents).map(([runId, events]) => [runId, [...events]])
      ),
      clarifications: clarifications.map((request) => ({
        ...request,
        questions: [...request.questions],
        answers: [...request.answers]
      })),
      models: models.map((model) => ({ ...model })),
      reviews: reviews.map((review) => ({ ...review })),
      artifacts: artifacts.map((artifact) => ({ ...artifact })),
      costData: { ...currentCostData },
      costReports: [...costReports],
      recoveryStatus,
      apiKeyStatus: { ...apiKeyStatus }
    }),
    clearFailure: (method: string) => {
      failures.delete(method);
    },
    setPick: (next: SelectedDrawingFile | null | undefined) => {
      pick = next;
    },
    addClarification: (request: ClarificationRequest) => {
      clarifications.push(request);
    },
    addRun: (run: ModelingRun) => {
      // Replace a same-id entry so a test can re-stage a Run's status.
      const existingIndex = runs.findIndex((candidate) => candidate.id === run.id);
      if (existingIndex >= 0) runs.splice(existingIndex, 1);
      runs.push(run);
      if (runEvents[run.id] === undefined) {
        runEvents[run.id] = [];
      }
    },
    emitRunEvents: (runId: string, events: readonly RunEvent[]) => {
      const existing = runEvents[runId] ?? [];
      const next = [...existing, ...events];
      runEvents[runId] = next;
      // Persisted status transitions mirror the Runner (runs.list/getDetail
      // reflect them after invalidation, exactly like the real backend).
      const run = runs.find((candidate) => candidate.id === runId);
      for (const event of events) {
        if (run !== undefined) applyEventToRun(run, event);
      }
      const first = events[0];
      if (first !== undefined) {
        pushToRunSubscribers(runId, {
          kind: "runEvents",
          runId,
          fromSequence: first.sequence,
          events
        });
      }
    },
    failRunStream: (runId: string, code: string, message: string) => {
      pushToRunSubscribers(runId, {
        kind: "runEventsError",
        runId,
        error: { code, message }
      });
    },
    addModel: (model: Model, modelArtifacts: readonly Artifact[] = []) => {
      const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
      if (existingIndex >= 0) models.splice(existingIndex, 1);
      models.push(model);
      for (const artifact of modelArtifacts) {
        const artifactIndex = artifacts.findIndex((candidate) => candidate.id === artifact.id);
        if (artifactIndex >= 0) artifacts.splice(artifactIndex, 1);
        artifacts.push(artifact);
      }
    },
    addModelReview: (review: ModelReview) => {
      reviews.push(review);
    }
  };
}
