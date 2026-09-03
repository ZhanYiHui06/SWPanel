import { describe, expect, it } from "vitest";

import {
  buildScenario,
  DEFAULT_SCENARIO,
  MOCK_SCENARIOS,
  PRODUCTION_DEFAULT_SCENARIO,
  SCENARIO_DESCRIPTIONS
} from "../fixtures/scenarios.js";
import { DRAWING_IDS, REVISION_IDS } from "../fixtures/drawings.js";
import { MODEL_IDS, CLARIFICATION_IDS } from "../fixtures/index.js";
import { RUN_IDS } from "../fixtures/runs.js";
import { REPORT_IDS } from "../fixtures/cost-reports.js";

const MAIN = DRAWING_IDS.main;
const V3 = REVISION_IDS.mainV3;

describe("scenario selectors", () => {
  it("pins the exact ten named scenarios plus three Run variants", () => {
    expect(MOCK_SCENARIOS).toEqual([
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
    ]);
    expect(DEFAULT_SCENARIO).toBe("run-running");
    expect(PRODUCTION_DEFAULT_SCENARIO).toBe("cost-report-generated");
  });

  it("documents every scenario with a description", () => {
    for (const scenario of MOCK_SCENARIOS) {
      expect(SCENARIO_DESCRIPTIONS[scenario]).toBeTruthy();
    }
  });

  it("is deterministic: the same scenario builds an equal world every time", () => {
    const first = buildScenario("run-running");
    const second = buildScenario("run-running");
    expect(second).toEqual(first);
  });

  it("seeds the empty library with no drawings, runs, models or reports", () => {
    const world = buildScenario("empty-drawing-library");
    expect(world.drawings).toEqual([]);
    expect(world.revisions).toEqual([]);
    expect(world.runs).toEqual([]);
    expect(world.models).toEqual([]);
    expect(world.reports).toEqual([]);
    expect(world.clarifications).toEqual([]);
  });
});

describe("run scenario worlds", () => {
  it("run-running shows R05 RUNNING at the MODELING stage", () => {
    const world = buildScenario("run-running");
    const r05 = world.runs.find((run) => run.id === RUN_IDS.mainR05);
    expect(r05).toBeDefined();
    expect(r05?.status).toBe("RUNNING");
    expect(r05?.stage).toBe("MODELING");
    const r05Events = world.runEvents[RUN_IDS.mainR05] ?? [];
    expect(r05Events.at(-1)).toMatchObject({
      type: "ActivityUpdated",
      activity: "正在创建主要旋转特征"
    });
  });

  it("run-queued keeps R05 QUEUED with no events", () => {
    const world = buildScenario("run-queued");
    const r05 = world.runs.find((run) => run.id === RUN_IDS.mainR05);
    expect(r05?.status).toBe("QUEUED");
    expect(r05?.stage).toBeNull();
    expect(world.runEvents[RUN_IDS.mainR05]).toEqual([]);
  });

  it("run-completed publishes M03 as PENDING_REVIEW", () => {
    const world = buildScenario("run-completed");
    const r05 = world.runs.find((run) => run.id === RUN_IDS.mainR05);
    expect(r05?.status).toBe("COMPLETED");
    expect(r05?.modelId).toBe(MODEL_IDS.mainM03);
    const m03 = world.models.find((model) => model.id === MODEL_IDS.mainM03);
    expect(m03?.reviewStatus).toBe("PENDING_REVIEW");
    expect(m03?.runId).toBe(RUN_IDS.mainR05);
  });

  it("run-cancelled keeps R05 CANCELLED with a cancellation event", () => {
    const world = buildScenario("run-cancelled");
    const r05 = world.runs.find((run) => run.id === RUN_IDS.mainR05);
    expect(r05?.status).toBe("CANCELLED");
    const events = world.runEvents[RUN_IDS.mainR05] ?? [];
    expect(events.some((event) => event.type === "CancellationRequested")).toBe(true);
    expect(events.some((event) => event.type === "CancellationConfirmed")).toBe(true);
  });

  it("run-failed keeps R05 FAILED with a technical failure code", () => {
    const world = buildScenario("run-failed");
    const r05 = world.runs.find((run) => run.id === RUN_IDS.mainR05);
    expect(r05?.status).toBe("FAILED");
    expect(r05?.failureCode).toBe("VALIDATION_REJECTED");
    expect(r05?.failureMessage).toBe("SolidWorks 自动重建失败");
  });
});

describe("clarification scenario worlds", () => {
  it("clarification-open keeps the main request OPEN", () => {
    const world = buildScenario("clarification-open");
    const request = world.clarifications.find(
      (candidate) => candidate.id === CLARIFICATION_IDS.mainR04
    );
    expect(request?.status).toBe("OPEN");
    expect(request?.runId).toBe(RUN_IDS.mainR04);
    expect(request?.questions).toHaveLength(3);
    // Secondary drawing D also keeps an open clarification.
    expect(
      world.clarifications.filter((candidate) => candidate.status === "OPEN")
    ).toHaveLength(2);
  });

  it("clarification-answered saves answers and facts while R04 stays terminal", () => {
    const world = buildScenario("clarification-answered");
    const request = world.clarifications.find(
      (candidate) => candidate.id === CLARIFICATION_IDS.mainR04
    );
    expect(request?.status).toBe("ANSWERED");
    expect(request?.answers).toHaveLength(3);
    const r04 = world.runs.find((run) => run.id === RUN_IDS.mainR04);
    expect(r04?.status).toBe("CLARIFICATION_REQUIRED");
    const factFields = world.facts
      .filter((fact) => fact.revisionId === V3 && fact.source === "CLARIFICATION")
      .map((fact) => fact.field);
    expect(factFields).toEqual(
      expect.arrayContaining(["中心孔深度", "R5 圆角位置", "材料"])
    );
    // Exactly one canonical `材料` fact survives the upsert: the clarification
    // answer replaces the drawing-confirmed material fact instead of coexisting
    // with a contradictory record.
    const materialFacts = world.facts.filter(
      (fact) => fact.revisionId === V3 && fact.field === "材料"
    );
    expect(materialFacts).toHaveLength(1);
    expect(materialFacts[0]?.source).toBe("CLARIFICATION");
    expect(materialFacts[0]?.value).toBe("42CrMo");
  });
});

describe("model scenario worlds", () => {
  it("model-pending-review leaves M03 awaiting review and no current pointer", () => {
    const world = buildScenario("model-pending-review");
    const m03 = world.models.find((model) => model.id === MODEL_IDS.mainM03);
    expect(m03?.reviewStatus).toBe("PENDING_REVIEW");
    const v3 = world.revisions.find((revision) => revision.id === V3);
    expect(v3?.currentApprovedModelId).toBe(MODEL_IDS.mainM01);
  });

  it("model-approved points the revision at M03 and records the review", () => {
    const world = buildScenario("model-approved");
    const m03 = world.models.find((model) => model.id === MODEL_IDS.mainM03);
    expect(m03?.reviewStatus).toBe("APPROVED");
    const v3 = world.revisions.find((revision) => revision.id === V3);
    expect(v3?.currentApprovedModelId).toBe(MODEL_IDS.mainM03);
    expect(
      world.reviews.some(
        (review) => review.modelId === MODEL_IDS.mainM03 && review.result === "APPROVED"
      )
    ).toBe(true);
  });

  it("model-rejected marks M03 REJECTED and writes Modeling Feedback", () => {
    const world = buildScenario("model-rejected");
    const m03 = world.models.find((model) => model.id === MODEL_IDS.mainM03);
    expect(m03?.reviewStatus).toBe("REJECTED");
    const review = world.reviews.find(
      (candidate) => candidate.modelId === MODEL_IDS.mainM03 && candidate.result === "REJECTED"
    );
    expect(review?.comment).toBeTruthy();
    expect(
      world.feedback.some(
        (entry) => entry.modelId === MODEL_IDS.mainM03 && entry.source === "MODEL_REVIEW_REJECTED"
      )
    ).toBe(true);
  });

  it("no-current-approved-model has runs but no approved model pointer", () => {
    const world = buildScenario("no-current-approved-model");
    const v3 = world.revisions.find((revision) => revision.id === V3);
    expect(v3?.currentApprovedModelId).toBeNull();
    expect(world.runs.filter((run) => run.revisionId === V3).length).toBeGreaterThan(0);
    expect(
      world.models.filter((model) => model.revisionId === V3).length
    ).toBeGreaterThan(0);
  });
});

describe("cost report scenario world", () => {
  it("cost-report-generated ships Q01/Q02/Q03 against the current approved model", () => {
    const world = buildScenario("cost-report-generated");
    const labels = world.reports.map((report) => report.label);
    expect(labels).toEqual(["Q01", "Q02", "Q03"]);
    const q03 = world.reports.find((report) => report.id === REPORT_IDS.q03);
    expect(q03?.quantity).toBe(10);
    if (q03 === undefined) throw new Error("Q03 report missing");
    // Coherent deterministic synthetic totals: perPiece × quantity = total.
    expect(q03.snapshot.result.perPieceCost).toBeCloseTo(1873.42, 2);
    expect(q03.snapshot.result.totalCost).toBeCloseTo(18734.2, 2);
    expect(q03.snapshot.result.perPieceCost * q03.quantity).toBeCloseTo(
      q03.snapshot.result.totalCost,
      6
    );
    // All monetary values are finite and non-negative.
    for (const value of [
      q03.snapshot.result.materialCost,
      q03.snapshot.result.perPieceCost,
      q03.snapshot.result.totalCost
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value >= 0).toBe(true);
    }
    const v3 = world.revisions.find((revision) => revision.id === V3);
    expect(v3?.currentApprovedModelId).toBe(MODEL_IDS.mainM03);
    expect(q03.modelId).toBe(MODEL_IDS.mainM03);
  });
});

describe("production default world", () => {
  it("covers M03 and Q03 on main V3 with valid completed lineage", () => {
    const world = buildScenario(PRODUCTION_DEFAULT_SCENARIO);
    const v3 = world.revisions.find((revision) => revision.id === V3);
    const m03 = world.models.find((model) => model.id === MODEL_IDS.mainM03);
    const sourceRun = world.runs.find((run) => run.id === m03?.runId);
    const q03 = world.reports.find((report) => report.id === REPORT_IDS.q03);

    expect(v3).toMatchObject({
      drawingId: MAIN,
      currentApprovedModelId: MODEL_IDS.mainM03
    });
    expect(m03).toMatchObject({
      drawingId: MAIN,
      revisionId: V3,
      reviewStatus: "APPROVED",
      generatedAt: sourceRun?.completedAt
    });
    expect(sourceRun).toMatchObject({
      id: RUN_IDS.mainR05,
      drawingId: MAIN,
      revisionId: V3,
      status: "COMPLETED",
      modelId: MODEL_IDS.mainM03
    });
    expect(q03).toMatchObject({
      drawingId: MAIN,
      revisionId: V3,
      modelId: MODEL_IDS.mainM03,
      label: "Q03"
    });
    expect(world.reviews).toContainEqual(
      expect.objectContaining({
        modelId: MODEL_IDS.mainM03,
        result: "APPROVED"
      })
    );
    expect(world.runEvents[RUN_IDS.mainR05]?.at(-1)).toMatchObject({
      type: "Completed",
      modelId: MODEL_IDS.mainM03
    });
  });

  it("contains exactly one RUNNING Run without contradicting completed R05", () => {
    const world = buildScenario(PRODUCTION_DEFAULT_SCENARIO);
    const running = world.runs.filter((run) => run.status === "RUNNING");
    const r05Records = world.runs.filter((run) => run.id === RUN_IDS.mainR05);

    expect(running).toHaveLength(1);
    expect(r05Records).toHaveLength(1);
    const currentRun = running[0];
    const r05 = r05Records[0];
    const q03 = world.reports.find((report) => report.id === REPORT_IDS.q03);
    if (currentRun === undefined || r05 === undefined || q03 === undefined) {
      throw new Error("production default lineage is incomplete");
    }

    expect(currentRun.id).toBe(RUN_IDS.cR02);
    expect(r05.status).toBe("COMPLETED");
    expect(currentRun.createdAt > (r05.completedAt ?? "")).toBe(true);
    expect(currentRun.createdAt > q03.createdAt).toBe(true);
  });
});

describe("single RUNNING invariant", () => {
  it("keeps at most one RUNNING run in every scenario world", () => {
    for (const scenario of MOCK_SCENARIOS) {
      const world = buildScenario(scenario);
      const running = world.runs.filter((run) => run.status === "RUNNING");
      expect(
        running.length,
        `scenario ${scenario} must have at most one RUNNING run`
      ).toBeLessThanOrEqual(1);
    }
  });

  it("run-running features exactly R05 as the only RUNNING run", () => {
    const world = buildScenario("run-running");
    const running = world.runs.filter((run) => run.status === "RUNNING");
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe(RUN_IDS.mainR05);
    expect(running[0]?.stage).toBe("MODELING");
  });

  it("clarification-open still shows drawing C modeling when R05 is not running", () => {
    const world = buildScenario("clarification-open");
    const running = world.runs.filter((run) => run.status === "RUNNING");
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe(RUN_IDS.cR02);
  });
});
