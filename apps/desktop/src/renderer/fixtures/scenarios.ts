import type {
  Artifact,
  ClarificationRequest,
  CostEstimateReport,
  Drawing,
  DrawingRevision,
  Model,
  ModelingFeedback,
  ModelingRun,
  ModelReview,
  RevisionFact,
  RunEvent
} from "@swpanel/domain";
import { DomainInvariantError, modelLabel, runLabel } from "@swpanel/domain";
import {
  buildDOpenClarification,
  buildMainAnsweredClarification,
  buildMainOpenClarification,
  factsFromAnswers,
  mainAnsweredInputs,
  upsertFactsByField
} from "./clarifications.js";
import { buildModelArtifacts } from "./artifacts.js";
import { costDataSnapshot, defaultCostData, historicalCostData, type CostDataState } from "./cost-data.js";
import {
  CANONICAL_FINISHED_VOLUME,
  CANONICAL_STOCK_SPEC,
  REPORT_IDS,
  buildVisualReport
} from "./cost-reports.js";
import { MOCK_REVIEWER_ID } from "./execution.js";
import { buildPrimaryWorld, DRAWING_IDS, REVISION_IDS } from "./drawings.js";
import { buildMaterialFact, buildM02Feedback, buildM03Feedback } from "./memory.js";
import {
  buildModel,
  buildModelReview,
  M02_REVIEW_COMMENT,
  M03_REVIEW_COMMENT,
  MODEL_IDS,
  buildReportSummaryText,
  modelArtifactIds,
  validationSummary
} from "./models.js";
import {
  buildInputSnapshot,
  buildRun,
  cancelledRunEvents,
  clarificationRunEvents,
  completedRunEvents,
  failedRunEvents,
  mainR05CompletedEvents,
  mainR05FailedEvents,
  mainR05RunningEvents,
  mainR06CompletedEvents,
  RUN_IDS
} from "./runs.js";
import { TIME } from "./timeline.js";
import { defaultStorageSettings, emptyWorld, type MockWorld } from "./world.js";
import { CLARIFICATION_IDS } from "./clarifications.js";

/**
 * The canonical Mock Repository scenario selectors.
 *
 * Ten named scenarios plus the three queued/completed/cancelled Run variants of
 * the featured Run R05. Each selector maps to one coherent, deterministic world
 * (see `buildScenario`).
 */
export const MOCK_SCENARIOS = [
  "run-running",
  "run-queued",
  "run-completed",
  "run-cancelled",
  "clarification-open",
  "clarification-answered",
  "model-pending-review",
  "model-approved",
  "model-rejected",
  "no-current-approved-model",
  "cost-report-generated",
  "run-failed",
  "empty-drawing-library"
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const DEFAULT_SCENARIO: MockScenario = "run-running";

/**
 * Packaged-app seed. It includes the approved M03 → Q03 lineage on main V3 and
 * keeps drawing C's cR02 as the world's single RUNNING Run for Workbench. R05
 * is COMPLETED only, so no Run is represented with contradictory statuses.
 */
export const PRODUCTION_DEFAULT_SCENARIO: MockScenario = "cost-report-generated";

/** Compares two canonical ISO-8601 timestamps as numbers. */
function timestampCompare(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

export const SCENARIO_DESCRIPTIONS: Readonly<Record<MockScenario, string>> = {
  "run-running": "Featured Run R05 is RUNNING at the MODELING stage (63%).",
  "run-queued": "Featured Run R05 is QUEUED and has not started yet.",
  "run-completed": "Featured Run R05 COMPLETED and published M03 (PENDING_REVIEW).",
  "run-cancelled": "Featured Run R05 was CANCELLED by the user.",
  "clarification-open": "R04 needs answers (OPEN) and drawing D R02 is also open.",
  "clarification-answered": "R04 answers are saved; R04 stays terminal CLARIFICATION_REQUIRED.",
  "model-pending-review": "M03 from R05 is PENDING_REVIEW and needs human review.",
  "model-approved": "M03 is APPROVED and is the revision's current formal model.",
  "model-rejected": "M03 was REJECTED and the rejection feedback is recorded.",
  "no-current-approved-model": "V3 has runs but no approved model yet.",
  "cost-report-generated": "M03 is approved and cost reports Q01/Q02/Q03 exist.",
  "run-failed": "Featured Run R05 FAILED with a technical failure.",
  "empty-drawing-library": "No drawings, runs, models or reports exist."
};

/** The featured Run R05 variants share the model-outcome semantics with the named scenarios. */
export const RUN_VARIANT_SCENARIOS: readonly MockScenario[] = [
  "run-running",
  "run-queued",
  "run-completed",
  "run-cancelled",
  "run-failed"
];

/**
 * Feature flags controlling the canonical main-drawing timeline. Each scenario
 * maps to one combination (see `buildScenario`).
 */
interface MainTimelineOptions {
  /** R05 outcome: what the featured Run looks like in the snapshot. */
  featuredRun: "RUNNING" | "QUEUED" | "COMPLETED" | "FAILED" | "CANCELLED" | "NONE";
  /** Review outcome of the Model published by a completed R05 (M03). */
  m03Outcome: "NONE" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  /** R04 clarification state. */
  r04Status: "OPEN" | "ANSWERED";
  /** M01 review state. `PENDING_REVIEW` is used by no-current-approved-model. */
  m01Status: "APPROVED" | "PENDING_REVIEW";
  /** Whether the background M02/R06 history exists (only after R05 completed). */
  includeM02: boolean;
  /** Whether the visual cost reports Q01-Q03 exist. */
  includeReports: boolean;
}

interface MainWorld {
  drawings: Drawing[];
  revisions: DrawingRevision[];
  facts: RevisionFact[];
  feedback: ModelingFeedback[];
  runs: ModelingRun[];
  runEvents: Readonly<Record<string, readonly RunEvent[]>>;
  models: Model[];
  reviews: ModelReview[];
  clarifications: ClarificationRequest[];
  artifacts: Artifact[];
  reports: CostEstimateReport[];
}

/** Time-ordered facts/feedback of the main V3 revision at scenario build time. */
function mainMemory(options: Pick<MainTimelineOptions, "r04Status" | "includeM02">): {
  facts: RevisionFact[];
  feedback: ModelingFeedback[];
} {
  let facts: RevisionFact[] = [buildMaterialFact()];
  if (options.r04Status === "ANSWERED") {
    const answered = buildMainOpenClarification();
    const candidateFacts = factsFromAnswers(answered, mainAnsweredInputs(), TIME.r04Answered);
    // The material answer upserts the canonical `材料` fact by its stable field
    // identity, exactly like the repository command. This keeps the seeded world
    // and the world produced by `submitClarificationAnswers` consistent, and
    // guarantees a clarification answer never coexists with a contradictory
    // drawing-confirmed fact of the same canonical field.
    facts = upsertFactsByField(facts, candidateFacts);
  }
  const feedback: ModelingFeedback[] = [];
  if (options.includeM02) {
    feedback.push(buildM02Feedback("review-main-m02-reject"));
  }
  return { facts, feedback };
}

/** Freezes the input snapshot of a Run created at `createdAt` on a revision. */
function frozenSnapshot(
  revision: DrawingRevision,
  facts: readonly RevisionFact[],
  feedback: readonly ModelingFeedback[],
  createdAt: string
) {
  return buildInputSnapshot({
    revision,
    facts: facts.filter((fact) => fact.createdAt <= createdAt),
    feedback: feedback.filter((entry) => entry.createdAt <= createdAt),
    createdAt
  });
}

function buildMainWorld(options: MainTimelineOptions): MainWorld {
  const { drawings: allDrawings, revisions: baseRevisions } = buildPrimaryWorld(
    options.m01Status === "APPROVED" ? MODEL_IDS.mainM01 : null
  );
  const mainV3 = baseRevisions.find((revision) => revision.id === REVISION_IDS.mainV3);
  if (mainV3 === undefined) {
    throw new DomainInvariantError("main V3 revision missing from fixture world");
  }

  const { facts, feedback } = mainMemory(options);
  const revisionsOut: DrawingRevision[] = [...baseRevisions];
  const runsOut: ModelingRun[] = [];
  const eventsOut: Record<string, readonly RunEvent[]> = {};
  const modelsOut: Model[] = [];
  const reviewsOut: ModelReview[] = [];
  const clarificationsOut: ClarificationRequest[] = [];
  const artifactsOut: Artifact[] = [];
  const reportsOut: CostEstimateReport[] = [];

  // ---- R01 -> M01 ----
  const r01 = buildRun({
    id: RUN_IDS.mainR01,
    number: runLabel(1),
    drawingId: DRAWING_IDS.main,
    revisionId: REVISION_IDS.mainV3,
    status: "COMPLETED",
    stage: null,
    inputSnapshot: frozenSnapshot(mainV3, facts, feedback, TIME.r01Created),
    createdAt: TIME.r01Created,
    startedAt: TIME.r01Created,
    completedAt: TIME.r01Completed,
    modelId: MODEL_IDS.mainM01
  });
  runsOut.push(r01);
  eventsOut[RUN_IDS.mainR01] = completedRunEvents({
    runId: RUN_IDS.mainR01,
    modelId: MODEL_IDS.mainM01,
    startedAt: TIME.r01Created,
    completedAt: TIME.r01Completed
  });
  const m01 = buildModel({
    id: MODEL_IDS.mainM01,
    number: modelLabel(1),
    drawingId: DRAWING_IDS.main,
    revisionId: REVISION_IDS.mainV3,
    runId: RUN_IDS.mainR01,
    reviewStatus: options.m01Status,
    generatedAt: TIME.r01Completed,
    validationSummary: validationSummary(12, 1),
    buildReportSummary: buildReportSummaryText(),
    artifactIds: modelArtifactIds(MODEL_IDS.mainM01)
  });
  modelsOut.push(m01);
  artifactsOut.push(...buildModelArtifacts(RUN_IDS.mainR01, MODEL_IDS.mainM01, TIME.r01Completed));
  if (options.m01Status === "APPROVED") {
    reviewsOut.push(
      buildModelReview({
        id: "review-main-m01-approve",
        modelId: MODEL_IDS.mainM01,
        result: "APPROVED",
        reviewerId: MOCK_REVIEWER_ID,
        createdAt: TIME.m01Approved
      })
    );
  }

  // ---- R02 -> FAILED ----
  const r02 = buildRun({
    id: RUN_IDS.mainR02,
    number: runLabel(2),
    drawingId: DRAWING_IDS.main,
    revisionId: REVISION_IDS.mainV3,
    status: "FAILED",
    stage: null,
    inputSnapshot: frozenSnapshot(mainV3, facts, feedback, TIME.r02Created),
    createdAt: TIME.r02Created,
    startedAt: TIME.r02Created,
    completedAt: TIME.r02Failed,
    failureCode: "VALIDATION_REJECTED",
    failureMessage: "SolidWorks 自动重建失败"
  });
  runsOut.push(r02);
  eventsOut[RUN_IDS.mainR02] = failedRunEvents({
    runId: RUN_IDS.mainR02,
    failureCode: "VALIDATION_REJECTED",
    failureMessage: "SolidWorks 自动重建失败",
    startedAt: TIME.r02Created,
    failedAt: TIME.r02Failed
  });

  // ---- R03 -> CANCELLED ----
  const r03 = buildRun({
    id: RUN_IDS.mainR03,
    number: runLabel(3),
    drawingId: DRAWING_IDS.main,
    revisionId: REVISION_IDS.mainV3,
    status: "CANCELLED",
    stage: null,
    inputSnapshot: frozenSnapshot(mainV3, facts, feedback, TIME.r03Created),
    createdAt: TIME.r03Created,
    startedAt: TIME.r03Created,
    completedAt: TIME.r03Cancelled
  });
  runsOut.push(r03);
  eventsOut[RUN_IDS.mainR03] = cancelledRunEvents({
    runId: RUN_IDS.mainR03,
    startedAt: TIME.r03Created,
    cancelledAt: TIME.r03Cancelled,
    reason: "用户主动取消"
  });

  // ---- R04 -> CLARIFICATION_REQUIRED ----
  const r04 = buildRun({
    id: RUN_IDS.mainR04,
    number: runLabel(4),
    drawingId: DRAWING_IDS.main,
    revisionId: REVISION_IDS.mainV3,
    status: "CLARIFICATION_REQUIRED",
    stage: null,
    inputSnapshot: frozenSnapshot(mainV3, facts, feedback, TIME.r04Created),
    createdAt: TIME.r04Created,
    startedAt: TIME.r04Created,
    completedAt: TIME.r04Clarified,
    clarificationRequestId: CLARIFICATION_IDS.mainR04
  });
  runsOut.push(r04);
  eventsOut[RUN_IDS.mainR04] = clarificationRunEvents({
    runId: RUN_IDS.mainR04,
    clarificationRequestId: CLARIFICATION_IDS.mainR04,
    startedAt: TIME.r04Created,
    clarifiedAt: TIME.r04Clarified
  });

  if (options.r04Status === "OPEN") {
    clarificationsOut.push(buildMainOpenClarification());
  } else {
    clarificationsOut.push(buildMainAnsweredClarification());
  }

  // ---- R06 (background) -> M02 REJECTED (only after R05 completed) ----
  if (options.includeM02) {
    const r06 = buildRun({
      id: RUN_IDS.mainR06,
      number: runLabel(6),
      drawingId: DRAWING_IDS.main,
      revisionId: REVISION_IDS.mainV3,
      status: "COMPLETED",
      stage: null,
      inputSnapshot: frozenSnapshot(mainV3, facts, feedback, TIME.r06Created),
      createdAt: TIME.r06Created,
      startedAt: TIME.r06Created,
      completedAt: TIME.r06Completed,
      modelId: MODEL_IDS.mainM02
    });
    runsOut.push(r06);
    eventsOut[RUN_IDS.mainR06] = mainR06CompletedEvents();
    const m02 = buildModel({
      id: MODEL_IDS.mainM02,
      number: modelLabel(2),
      drawingId: DRAWING_IDS.main,
      revisionId: REVISION_IDS.mainV3,
      runId: RUN_IDS.mainR06,
      reviewStatus: "REJECTED",
      generatedAt: TIME.r06Completed,
      validationSummary: validationSummary(10, 1),
      buildReportSummary: buildReportSummaryText(),
      artifactIds: modelArtifactIds(MODEL_IDS.mainM02)
    });
    modelsOut.push(m02);
    artifactsOut.push(...buildModelArtifacts(RUN_IDS.mainR06, MODEL_IDS.mainM02, TIME.r06Completed));
    reviewsOut.push(
      buildModelReview({
        id: "review-main-m02-reject",
        modelId: MODEL_IDS.mainM02,
        result: "REJECTED",
        reviewerId: MOCK_REVIEWER_ID,
        createdAt: TIME.m02Rejected,
        comment: M02_REVIEW_COMMENT
      })
    );
  }

  // ---- R05 featured run ----
  if (options.featuredRun !== "NONE") {
    const r05Common = {
      id: RUN_IDS.mainR05,
      number: runLabel(5),
      drawingId: DRAWING_IDS.main,
      revisionId: REVISION_IDS.mainV3,
      inputSnapshot: frozenSnapshot(mainV3, facts, feedback, TIME.r05Created),
      createdAt: TIME.r05Created
    };
    if (options.featuredRun === "RUNNING") {
      runsOut.push(
        buildRun({ ...r05Common, status: "RUNNING", stage: "MODELING", startedAt: TIME.r05Created })
      );
      eventsOut[RUN_IDS.mainR05] = mainR05RunningEvents();
    } else if (options.featuredRun === "QUEUED") {
      runsOut.push(buildRun({ ...r05Common, status: "QUEUED", stage: null }));
      eventsOut[RUN_IDS.mainR05] = [];
    } else if (options.featuredRun === "CANCELLED") {
      runsOut.push(
        buildRun({
          ...r05Common,
          status: "CANCELLED",
          stage: null,
          startedAt: TIME.r05Created,
          completedAt: TIME.r05Cancelled
        })
      );
      eventsOut[RUN_IDS.mainR05] = cancelledRunEvents({
        runId: RUN_IDS.mainR05,
        startedAt: TIME.r05Created,
        cancelledAt: TIME.r05Cancelled,
        reason: "用户主动取消"
      });
    } else if (options.featuredRun === "FAILED") {
      runsOut.push(
        buildRun({
          ...r05Common,
          status: "FAILED",
          stage: null,
          startedAt: TIME.r05Created,
          completedAt: TIME.r05Failed,
          failureCode: "VALIDATION_REJECTED",
          failureMessage: "SolidWorks 自动重建失败"
        })
      );
      eventsOut[RUN_IDS.mainR05] = mainR05FailedEvents();
    } else if (options.featuredRun === "COMPLETED") {
      const m03ModelId = MODEL_IDS.mainM03;
      runsOut.push(
        buildRun({
          ...r05Common,
          status: "COMPLETED",
          stage: null,
          startedAt: TIME.r05Created,
          completedAt: TIME.r05Completed,
          modelId: m03ModelId
        })
      );
      eventsOut[RUN_IDS.mainR05] = mainR05CompletedEvents();
      const m03 = buildModel({
        id: m03ModelId,
        number: modelLabel(3),
        drawingId: DRAWING_IDS.main,
        revisionId: REVISION_IDS.mainV3,
        runId: RUN_IDS.mainR05,
        reviewStatus:
          options.m03Outcome === "NONE" ? "PENDING_REVIEW" : options.m03Outcome,
        generatedAt: TIME.r05Completed,
        validationSummary: validationSummary(14, 1),
        buildReportSummary: buildReportSummaryText(),
        artifactIds: modelArtifactIds(m03ModelId)
      });
      modelsOut.push(m03);
      artifactsOut.push(...buildModelArtifacts(RUN_IDS.mainR05, m03ModelId, TIME.r05Completed));
      if (options.m03Outcome === "APPROVED") {
        reviewsOut.push(
          buildModelReview({
            id: "review-main-m03-approve",
            modelId: m03ModelId,
            result: "APPROVED",
            reviewerId: MOCK_REVIEWER_ID,
            createdAt: TIME.m03Approved
          })
        );
      } else if (options.m03Outcome === "REJECTED") {
        const reviewId = "review-main-m03-reject";
        reviewsOut.push(
          buildModelReview({
            id: reviewId,
            modelId: m03ModelId,
            result: "REJECTED",
            reviewerId: MOCK_REVIEWER_ID,
            createdAt: TIME.m03Rejected,
            comment: M03_REVIEW_COMMENT
          })
        );
        feedback.push(buildM03Feedback(reviewId));
      }
    }
  }

  // ---- current approved model pointer ----
  const currentApprovedModelId =
    options.m03Outcome === "APPROVED"
      ? MODEL_IDS.mainM03
      : options.m01Status === "APPROVED"
        ? MODEL_IDS.mainM01
        : null;
  const mainV3Index = revisionsOut.findIndex((revision) => revision.id === REVISION_IDS.mainV3);
  revisionsOut[mainV3Index] = {
    ...mainV3,
    currentApprovedModelId,
    updatedAt: options.m03Outcome === "APPROVED" ? TIME.m03Approved : mainV3.updatedAt
  };

  // ---- cost reports (visual records) ----
  if (options.includeReports) {
    const costData = defaultCostData();
    // Q01/Q02 (08-09) freeze the historical cost basis predating the 08-10 08:00
    // update; Q03 (08-10 23:21) freezes the current basis. Historical reports
    // never reference cost items stamped after their capture instant.
    const historicalCostDataState = historicalCostData();
    const material = costData.materials.find((candidate) => candidate.id === "material-42crmo");
    if (material === undefined) {
      throw new DomainInvariantError("42CrMo material missing from cost data fixture");
    }
    const cylinderAllowances =
      costData.allowances.find((allowance) => allowance.stockType === "CYLINDER")?.allowances ?? [];
    const snapshotAt = (state: CostDataState, capturedAt: string) => costDataSnapshot(state, capturedAt);
    reportsOut.push(
      buildVisualReport({
        id: REPORT_IDS.q01,
        label: "Q01",
        createdAt: TIME.q01Created,
        drawingId: DRAWING_IDS.main,
        revisionId: REVISION_IDS.mainV3,
        modelId: MODEL_IDS.mainM01,
        quantity: 5,
        material,
        stockType: "CYLINDER",
        stockSpec: CANONICAL_STOCK_SPEC,
        finishedVolume: CANONICAL_FINISHED_VOLUME,
        allowances: cylinderAllowances,
        fixedCosts: costData.fixedCosts,
        costData: snapshotAt(historicalCostDataState, TIME.q01Created)
      }),
      buildVisualReport({
        id: REPORT_IDS.q02,
        label: "Q02",
        createdAt: TIME.q02Created,
        drawingId: DRAWING_IDS.main,
        revisionId: REVISION_IDS.mainV3,
        modelId: MODEL_IDS.mainM01,
        quantity: 1,
        material,
        stockType: "CYLINDER",
        stockSpec: CANONICAL_STOCK_SPEC,
        finishedVolume: CANONICAL_FINISHED_VOLUME,
        allowances: cylinderAllowances,
        fixedCosts: costData.fixedCosts,
        costData: snapshotAt(historicalCostDataState, TIME.q02Created)
      }),
      buildVisualReport({
        id: REPORT_IDS.q03,
        label: "Q03",
        createdAt: TIME.q03Created,
        drawingId: DRAWING_IDS.main,
        revisionId: REVISION_IDS.mainV3,
        modelId: MODEL_IDS.mainM03,
        quantity: 10,
        material,
        stockType: "CYLINDER",
        stockSpec: CANONICAL_STOCK_SPEC,
        finishedVolume: CANONICAL_FINISHED_VOLUME,
        allowances: cylinderAllowances,
        fixedCosts: costData.fixedCosts,
        costData: snapshotAt(costData, TIME.q03Created)
      })
    );
  }

  // The drawing's "最近更新" reflects the latest activity in this scenario
  // world (upload, run completion, model generation, review or report). This
  // keeps the drawings page ordering and relative-time display coherent even
  // though the V3 upload instant (TIME.v3Uploaded) predates today's runs.
  const activityTimes = [
    TIME.v3Uploaded,
    ...runsOut.map((run) => run.completedAt ?? run.createdAt),
    ...modelsOut.map((model) => model.generatedAt),
    ...reviewsOut.map((review) => review.createdAt),
    ...reportsOut.map((report) => report.createdAt)
  ].sort((a, b) => timestampCompare(b, a));
  const latestActivity = activityTimes[0] ?? TIME.v3Uploaded;
  const mainDrawingIndex = allDrawings.findIndex((drawing) => drawing.id === DRAWING_IDS.main);
  const mainDrawing = allDrawings[mainDrawingIndex];
  if (mainDrawingIndex >= 0 && mainDrawing !== undefined) {
    allDrawings[mainDrawingIndex] = { ...mainDrawing, updatedAt: latestActivity };
  }

  return {
    drawings: allDrawings,
    revisions: revisionsOut,
    facts,
    feedback,
    runs: runsOut,
    runEvents: eventsOut,
    models: modelsOut,
    reviews: reviewsOut,
    clarifications: clarificationsOut,
    artifacts: artifactsOut,
    reports: reportsOut
  };
}

/**
 * Builds the four secondary drawings (A/B/C/D) with their own runs, models,
 * reviews, artifacts and the always-open Clarification on drawing D.
 *
 * Single-RUNNING invariant: SWPanel executes Modeling Runs serially on one
 * machine, so at most one Run may be RUNNING at any time. When the featured
 * main R05 is RUNNING, the secondary drawing C run (cR02, which would otherwise
 * represent "建模中") must stay QUEUED; in all other scenarios it may RUN.
 */
function buildSecondaryWorld(featuredRunRunning: boolean): Omit<MockWorld, "costData" | "facts" | "feedback" | "reports"> {
  const { revisions: baseRevisions } = buildPrimaryWorld(null);
  const drawingsOut: Drawing[] = [];
  const revisionsOut: DrawingRevision[] = [];
  const runsOut: ModelingRun[] = [];
  const eventsOut: Record<string, readonly RunEvent[]> = {};
  const modelsOut: Model[] = [];
  const reviewsOut: ModelReview[] = [];
  const clarificationsOut: ClarificationRequest[] = [];
  const artifactsOut: Artifact[] = [];

  for (const drawing of buildPrimaryWorld(null).drawings) {
    if (drawing.id !== DRAWING_IDS.main) drawingsOut.push(drawing);
  }
  for (const revision of baseRevisions) {
    if (revision.drawingId !== DRAWING_IDS.main) revisionsOut.push(revision);
  }

  const approveModel = (model: Model, reviewId: string, createdAt: string, revisionId: string) => {
    reviewsOut.push(
      buildModelReview({
        id: reviewId,
        modelId: model.id,
        result: "APPROVED",
        reviewerId: MOCK_REVIEWER_ID,
        createdAt
      })
    );
    const index = revisionsOut.findIndex((candidate) => candidate.id === revisionId);
    const current = revisionsOut[index];
    if (current === undefined) {
      throw new DomainInvariantError(`revision ${revisionId} missing in secondary world`);
    }
    revisionsOut[index] = { ...current, currentApprovedModelId: model.id, updatedAt: createdAt };
  };

  // ---- Drawing A 定径辊 (formal model + cancelled + queued) ----
  const aV2 = revisionsOut.find((revision) => revision.id === REVISION_IDS.aV2);
  if (aV2 === undefined) throw new DomainInvariantError("aV2 missing");
  const aR01 = buildRun({
    id: RUN_IDS.aR01,
    number: runLabel(1),
    drawingId: DRAWING_IDS.a,
    revisionId: REVISION_IDS.aV2,
    status: "COMPLETED",
    stage: null,
    inputSnapshot: frozenSnapshot(aV2, [], [], TIME.aR01Created),
    createdAt: TIME.aR01Created,
    startedAt: TIME.aR01Created,
    completedAt: TIME.aR01Completed,
    modelId: MODEL_IDS.aM01
  });
  runsOut.push(aR01);
  eventsOut[RUN_IDS.aR01] = completedRunEvents({
    runId: RUN_IDS.aR01,
    modelId: MODEL_IDS.aM01,
    startedAt: TIME.aR01Created,
    completedAt: TIME.aR01Completed
  });
  const aM01 = buildModel({
    id: MODEL_IDS.aM01,
    number: modelLabel(1),
    drawingId: DRAWING_IDS.a,
    revisionId: REVISION_IDS.aV2,
    runId: RUN_IDS.aR01,
    reviewStatus: "APPROVED",
    generatedAt: TIME.aR01Completed,
    validationSummary: validationSummary(9, 1),
    buildReportSummary: "定径辊模型",
    artifactIds: modelArtifactIds(MODEL_IDS.aM01)
  });
  modelsOut.push(aM01);
  artifactsOut.push(...buildModelArtifacts(RUN_IDS.aR01, MODEL_IDS.aM01, TIME.aR01Completed));
  approveModel(aM01, "review-a-m01-approve", TIME.aR01Completed, REVISION_IDS.aV2);

  const aR02 = buildRun({
    id: RUN_IDS.aR02,
    number: runLabel(2),
    drawingId: DRAWING_IDS.a,
    revisionId: REVISION_IDS.aV2,
    status: "CANCELLED",
    stage: null,
    inputSnapshot: frozenSnapshot(aV2, [], [], TIME.aR02Created),
    createdAt: TIME.aR02Created,
    startedAt: TIME.aR02Created,
    completedAt: TIME.aR02Cancelled
  });
  runsOut.push(aR02);
  eventsOut[RUN_IDS.aR02] = cancelledRunEvents({
    runId: RUN_IDS.aR02,
    startedAt: TIME.aR02Created,
    cancelledAt: TIME.aR02Cancelled,
    reason: "用户主动取消"
  });

  const aR03 = buildRun({
    id: RUN_IDS.aR03,
    number: runLabel(3),
    drawingId: DRAWING_IDS.a,
    revisionId: REVISION_IDS.aV2,
    status: "QUEUED",
    stage: null,
    inputSnapshot: frozenSnapshot(aV2, [], [], TIME.aR03Created),
    createdAt: TIME.aR03Created
  });
  runsOut.push(aR03);
  eventsOut[RUN_IDS.aR03] = [];

  // ---- Drawing B 阶梯轴 (not modeled yet, queued) ----
  const bV1 = revisionsOut.find((revision) => revision.id === REVISION_IDS.bV1);
  if (bV1 === undefined) throw new DomainInvariantError("bV1 missing");
  const bR01 = buildRun({
    id: RUN_IDS.bR01,
    number: runLabel(1),
    drawingId: DRAWING_IDS.b,
    revisionId: REVISION_IDS.bV1,
    status: "QUEUED",
    stage: null,
    inputSnapshot: frozenSnapshot(bV1, [], [], TIME.bR01Created),
    createdAt: TIME.bR01Created
  });
  runsOut.push(bR01);
  eventsOut[RUN_IDS.bR01] = [];

  // ---- Drawing C 连轧辊 (formal model + currently modeling) ----
  const cV2 = revisionsOut.find((revision) => revision.id === REVISION_IDS.cV2);
  if (cV2 === undefined) throw new DomainInvariantError("cV2 missing");
  const cR01 = buildRun({
    id: RUN_IDS.cR01,
    number: runLabel(1),
    drawingId: DRAWING_IDS.c,
    revisionId: REVISION_IDS.cV2,
    status: "COMPLETED",
    stage: null,
    inputSnapshot: frozenSnapshot(cV2, [], [], TIME.cR01Created),
    createdAt: TIME.cR01Created,
    startedAt: TIME.cR01Created,
    completedAt: TIME.cR01Completed,
    modelId: MODEL_IDS.cM01
  });
  runsOut.push(cR01);
  eventsOut[RUN_IDS.cR01] = completedRunEvents({
    runId: RUN_IDS.cR01,
    modelId: MODEL_IDS.cM01,
    startedAt: TIME.cR01Created,
    completedAt: TIME.cR01Completed
  });
  const cM01 = buildModel({
    id: MODEL_IDS.cM01,
    number: modelLabel(1),
    drawingId: DRAWING_IDS.c,
    revisionId: REVISION_IDS.cV2,
    runId: RUN_IDS.cR01,
    reviewStatus: "APPROVED",
    generatedAt: TIME.cR01Completed,
    validationSummary: validationSummary(11, 1),
    buildReportSummary: "连轧辊模型",
    artifactIds: modelArtifactIds(MODEL_IDS.cM01)
  });
  modelsOut.push(cM01);
  artifactsOut.push(...buildModelArtifacts(RUN_IDS.cR01, MODEL_IDS.cM01, TIME.cR01Completed));
  approveModel(cM01, "review-c-m01-approve", TIME.cR01Completed, REVISION_IDS.cV2);

  // cR02 enforces the single-RUNNING invariant: it stays QUEUED while the
  // featured main R05 is the only RUNNING run; otherwise it represents the
  // "建模中" state of drawing C.
  const cR02Status = featuredRunRunning ? "QUEUED" : "RUNNING";
  const cR02 = buildRun({
    id: RUN_IDS.cR02,
    number: runLabel(2),
    drawingId: DRAWING_IDS.c,
    revisionId: REVISION_IDS.cV2,
    status: cR02Status,
    stage: cR02Status === "RUNNING" ? "MODELING" : null,
    inputSnapshot: frozenSnapshot(cV2, [], [], TIME.cR02Created),
    createdAt: TIME.cR02Created,
    ...(cR02Status === "RUNNING" ? { startedAt: TIME.cR02Created } : {})
  });
  runsOut.push(cR02);
  eventsOut[RUN_IDS.cR02] =
    cR02Status === "RUNNING"
      ? [
          { contractVersion: 1, runId: RUN_IDS.cR02, attemptId: "attempt-1", sequence: 1, occurredAt: TIME.cR02Created, type: "StageChanged", stage: "PREPARING" },
          { contractVersion: 1, runId: RUN_IDS.cR02, attemptId: "attempt-1", sequence: 2, occurredAt: TIME.cR02Created, type: "StageChanged", stage: "ANALYZING" },
          { contractVersion: 1, runId: RUN_IDS.cR02, attemptId: "attempt-1", sequence: 3, occurredAt: TIME.cR02Created, type: "StageChanged", stage: "PLANNING" },
          { contractVersion: 1, runId: RUN_IDS.cR02, attemptId: "attempt-1", sequence: 4, occurredAt: TIME.cR02Created, type: "StageChanged", stage: "MODELING" },
          { contractVersion: 1, runId: RUN_IDS.cR02, attemptId: "attempt-1", sequence: 5, occurredAt: TIME.cR02Created, type: "ProgressUpdated", progressPercent: 55 },
          { contractVersion: 1, runId: RUN_IDS.cR02, attemptId: "attempt-1", sequence: 6, occurredAt: TIME.cR02Created, type: "ActivityUpdated", activity: "正在创建主要旋转特征" }
        ]
      : [];

  // ---- Drawing D 矫直辊 (formal model + open clarification) ----
  const dV1 = revisionsOut.find((revision) => revision.id === REVISION_IDS.dV1);
  if (dV1 === undefined) throw new DomainInvariantError("dV1 missing");
  const dR01 = buildRun({
    id: RUN_IDS.dR01,
    number: runLabel(1),
    drawingId: DRAWING_IDS.d,
    revisionId: REVISION_IDS.dV1,
    status: "COMPLETED",
    stage: null,
    inputSnapshot: frozenSnapshot(dV1, [], [], TIME.dR01Created),
    createdAt: TIME.dR01Created,
    startedAt: TIME.dR01Created,
    completedAt: TIME.dR01Completed,
    modelId: MODEL_IDS.dM01
  });
  runsOut.push(dR01);
  eventsOut[RUN_IDS.dR01] = completedRunEvents({
    runId: RUN_IDS.dR01,
    modelId: MODEL_IDS.dM01,
    startedAt: TIME.dR01Created,
    completedAt: TIME.dR01Completed
  });
  const dM01 = buildModel({
    id: MODEL_IDS.dM01,
    number: modelLabel(1),
    drawingId: DRAWING_IDS.d,
    revisionId: REVISION_IDS.dV1,
    runId: RUN_IDS.dR01,
    reviewStatus: "APPROVED",
    generatedAt: TIME.dR01Completed,
    validationSummary: validationSummary(8, 1),
    buildReportSummary: "矫直辊模型",
    artifactIds: modelArtifactIds(MODEL_IDS.dM01)
  });
  modelsOut.push(dM01);
  artifactsOut.push(...buildModelArtifacts(RUN_IDS.dR01, MODEL_IDS.dM01, TIME.dR01Completed));
  approveModel(dM01, "review-d-m01-approve", TIME.dR01Completed, REVISION_IDS.dV1);

  const dR02 = buildRun({
    id: RUN_IDS.dR02,
    number: runLabel(2),
    drawingId: DRAWING_IDS.d,
    revisionId: REVISION_IDS.dV1,
    status: "CLARIFICATION_REQUIRED",
    stage: null,
    inputSnapshot: frozenSnapshot(dV1, [], [], TIME.dR02Created),
    createdAt: TIME.dR02Created,
    startedAt: TIME.dR02Created,
    completedAt: TIME.dR02Clarified,
    clarificationRequestId: CLARIFICATION_IDS.dR02
  });
  runsOut.push(dR02);
  eventsOut[RUN_IDS.dR02] = clarificationRunEvents({
    runId: RUN_IDS.dR02,
    clarificationRequestId: CLARIFICATION_IDS.dR02,
    startedAt: TIME.dR02Created,
    clarifiedAt: TIME.dR02Clarified
  });
  clarificationsOut.push(buildDOpenClarification());

  return {
    drawings: drawingsOut,
    revisions: revisionsOut,
    runs: runsOut,
    runEvents: eventsOut,
    models: modelsOut,
    reviews: reviewsOut,
    clarifications: clarificationsOut,
    artifacts: artifactsOut,
    storageSettings: defaultStorageSettings()
  };
}

/**
 * Builds the deterministic world for a scenario selector. The same selector
 * always produces the same world (stable ids, stable times, stable ordering).
 */
export function buildScenario(scenario: MockScenario): MockWorld {
  if (scenario === "empty-drawing-library") {
    return emptyWorld();
  }

  // The single-RUNNING invariant holds per scenario: when R05 is the featured
  // RUNNING run, no secondary run may be RUNNING at the same time.
  const secondary = buildSecondaryWorld(scenario === "run-running");

  let mainOptions: MainTimelineOptions;
  switch (scenario) {
    case "run-running":
      mainOptions = { featuredRun: "RUNNING", m03Outcome: "NONE", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: false, includeReports: false };
      break;
    case "run-queued":
      mainOptions = { featuredRun: "QUEUED", m03Outcome: "NONE", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: false, includeReports: false };
      break;
    case "run-completed":
    case "model-pending-review":
      mainOptions = { featuredRun: "COMPLETED", m03Outcome: "PENDING_REVIEW", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: true, includeReports: false };
      break;
    case "run-cancelled":
      mainOptions = { featuredRun: "CANCELLED", m03Outcome: "NONE", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: false, includeReports: false };
      break;
    case "clarification-open":
      mainOptions = { featuredRun: "NONE", m03Outcome: "NONE", r04Status: "OPEN", m01Status: "APPROVED", includeM02: false, includeReports: false };
      break;
    case "clarification-answered":
      mainOptions = { featuredRun: "NONE", m03Outcome: "NONE", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: false, includeReports: false };
      break;
    case "model-approved":
      mainOptions = { featuredRun: "COMPLETED", m03Outcome: "APPROVED", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: true, includeReports: false };
      break;
    case "model-rejected":
      mainOptions = { featuredRun: "COMPLETED", m03Outcome: "REJECTED", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: true, includeReports: false };
      break;
    case "no-current-approved-model":
      mainOptions = { featuredRun: "NONE", m03Outcome: "NONE", r04Status: "OPEN", m01Status: "PENDING_REVIEW", includeM02: false, includeReports: false };
      break;
    case "cost-report-generated":
      mainOptions = { featuredRun: "COMPLETED", m03Outcome: "APPROVED", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: true, includeReports: true };
      break;
    case "run-failed":
      mainOptions = { featuredRun: "FAILED", m03Outcome: "NONE", r04Status: "ANSWERED", m01Status: "APPROVED", includeM02: false, includeReports: false };
      break;
  }

  const main = buildMainWorld(mainOptions);

  // The main world owns the main drawing's entities only (buildPrimaryWorld
  // materializes all five drawings); the secondary world owns A/B/C/D. Filter
  // here so drawing/revision ids never duplicate across the merged world.
  const mainDrawings = main.drawings.filter((drawing) => drawing.id === DRAWING_IDS.main);
  const mainRevisions = main.revisions.filter((revision) => revision.drawingId === DRAWING_IDS.main);

  return {
    drawings: [...secondary.drawings, ...mainDrawings],
    revisions: [...secondary.revisions, ...mainRevisions],
    facts: main.facts,
    feedback: main.feedback,
    runs: [...secondary.runs, ...main.runs],
    runEvents: { ...secondary.runEvents, ...main.runEvents },
    models: [...secondary.models, ...main.models],
    reviews: [...secondary.reviews, ...main.reviews],
    clarifications: [...secondary.clarifications, ...main.clarifications],
    artifacts: [...secondary.artifacts, ...main.artifacts],
    costData: defaultCostData(),
    reports: main.reports,
    storageSettings: defaultStorageSettings()
  };
}
