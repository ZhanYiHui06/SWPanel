import { describe, expect, it } from "vitest";

import type { Drawing, DrawingRevision, Model, RunEvent, RunStage } from "@swpanel/domain";
import {
  MOCK_SCENARIOS,
  buildScenario
} from "../fixtures/scenarios.js";
import {
  RUN_IDS,
  buildInputSnapshot,
  buildRun,
  event,
  stageEvent
} from "../fixtures/runs.js";
import { FEEDBACK_IDS, MODEL_IDS, REPORT_IDS } from "../fixtures/index.js";
import { REVISION_IDS } from "../fixtures/drawings.js";
import { emptyWorld, type MockWorld } from "../fixtures/world.js";
import {
  auditAllScenarios,
  auditMockRepository,
  auditScenario,
  collectViolations,
  R05_CAUSAL_SCENARIOS,
  type TimelineAudit
} from "./validate-timeline.js";
import { MockRepository } from "../features/mock-repository/mock-repository.js";

const ALL_SCENARIOS = [...MOCK_SCENARIOS];

/**
 * Runs the full validator and returns the aggregated violations. Empty result
 * means the fixture timeline is self-consistent.
 */
function violationsFor(scenarios: readonly (typeof MOCK_SCENARIOS)[number][]): {
  violations: ReturnType<typeof collectViolations>;
  audits: TimelineAudit[];
} {
  const audits = auditAllScenarios(scenarios);
  return { violations: collectViolations(audits), audits };
}

function scenarioWorld(scenario: (typeof MOCK_SCENARIOS)[number]) {
  return buildScenario(scenario);
}

describe("fixture timeline causality validator", () => {
  it("audits every canonical scenario without violations", () => {
    const { violations } = violationsFor(ALL_SCENARIOS);
    expect(violations).toEqual([]);
  });

  it("covers every R05 variant that walks the causal chain plus the model-outcome scenarios", () => {
    // The running/completed/failed variants plus the model-outcome scenarios
    // that share a completed R05 must be audited for the causal chain. The
    // queued variant never starts and the cancelled variant stops early, so
    // neither walks running -> validating -> packaging -> completed/failed.
    for (const scenario of R05_CAUSAL_SCENARIOS) {
      const world = buildScenario(scenario);
      expect(
        world.runs.some((run) => run.id === RUN_IDS.mainR05),
        `${scenario} must feature R05 for its causal chain to be audited`
      ).toBe(true);
    }
    expect(R05_CAUSAL_SCENARIOS).toContain("run-running");
    expect(R05_CAUSAL_SCENARIOS).toContain("run-completed");
    expect(R05_CAUSAL_SCENARIOS).toContain("run-failed");
    expect(R05_CAUSAL_SCENARIOS).toContain("model-pending-review");
    expect(R05_CAUSAL_SCENARIOS).toContain("model-approved");
    expect(R05_CAUSAL_SCENARIOS).toContain("model-rejected");
    expect(R05_CAUSAL_SCENARIOS).toContain("cost-report-generated");
    expect(R05_CAUSAL_SCENARIOS).not.toContain("run-queued");
    expect(R05_CAUSAL_SCENARIOS).not.toContain("run-cancelled");
  });
  it("audits the same world through the Mock Repository adapter", () => {
    // The repository is seeded from buildScenario, so auditing its snapshot must
    // match auditing the fixture world exactly — proving the validator checks
    // the live repository data, not a second copy.
    for (const scenario of MOCK_SCENARIOS) {
      const repository = MockRepository.create(scenario);
      const viaRepository = auditMockRepository(repository, scenario);
      const viaFixture = auditScenario(scenario, repository.getSnapshot());
      expect(viaRepository).toEqual(viaFixture);
      expect(viaRepository.violations).toEqual([]);
    }
  });
});

describe("per-run event sequence / occurredAt", () => {
  it("reports a non-increasing event sequence", () => {
    const world = scenarioWorld("run-running");
    const audit = auditScenario("run-running", {
      ...world,
      runEvents: {
        ...world.runEvents,
        [RUN_IDS.mainR05]: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { ...(world.runEvents[RUN_IDS.mainR05]?.[0] as any), sequence: 1 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { ...(world.runEvents[RUN_IDS.mainR05]?.[1] as any), sequence: 1 }
        ]
      }
    });
    expect(audit.violations.some((v) => v.rule === "event-order")).toBe(true);
  });

  it("reports a back-in-time occurredAt", () => {
    const world = scenarioWorld("run-running");
    const audit = auditScenario("run-running", {
      ...world,
      runEvents: {
        ...world.runEvents,
        [RUN_IDS.mainR05]: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { ...(world.runEvents[RUN_IDS.mainR05]?.[0] as any), occurredAt: "2026-08-10T22:40:00.000Z" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { ...(world.runEvents[RUN_IDS.mainR05]?.[1] as any), occurredAt: "2026-08-10T22:30:00.000Z" }
        ]
      }
    });
    expect(audit.violations.some((v) => v.rule === "event-order")).toBe(true);
  });
});

describe("run lifecycle / terminal state", () => {
  it("reports a Completed event that publishes the wrong model", () => {
    const world = scenarioWorld("run-completed");
    const events = world.runEvents[RUN_IDS.mainR05] ?? [];
    const audit = auditScenario("run-completed", {
      ...world,
      runEvents: {
        ...world.runEvents,
        [RUN_IDS.mainR05]: events.map((event) =>
          event.type === "Completed" ? { ...event, modelId: MODEL_IDS.mainM02 } : event
        )
      }
    });
    expect(audit.violations.some((v) => v.rule === "run-lifecycle")).toBe(true);
  });

  it("reports an event that arrives after a terminal event", () => {
    const world = scenarioWorld("run-completed");
    const events = world.runEvents[RUN_IDS.mainR05] ?? [];
    const audit = auditScenario("run-completed", {
      ...world,
      runEvents: {
        ...world.runEvents,
        [RUN_IDS.mainR05]: [
          ...events,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { ...(events.at(-1) as any), type: "ActivityUpdated", activity: "不该发生" }
        ]
      }
    });
    expect(audit.violations.some((v) => v.rule === "run-lifecycle")).toBe(true);
  });

  it("treats failed and clarification runs as terminal with exactly one matching terminal event", () => {
    const failed = scenarioWorld("run-failed");
    const failedEvents = failed.runEvents[RUN_IDS.mainR05] ?? [];
    const failedAudit = auditScenario("run-failed", {
      ...failed,
      runEvents: {
        ...failed.runEvents,
        [RUN_IDS.mainR05]: failedEvents.map((event) =>
          event.type === "Failed" ? { ...event, type: "Completed", modelId: MODEL_IDS.mainM03 } : event
        )
      }
    });
    expect(failedAudit.violations.some((v) => v.rule === "run-lifecycle")).toBe(true);

    const clarification = scenarioWorld("clarification-open");
    const requestRun = clarification.runs.find((run) => run.status === "CLARIFICATION_REQUIRED");
    if (requestRun === undefined) throw new Error("clarification run missing");
    const clarificationAudit = auditScenario("clarification-open", {
      ...clarification,
      runEvents: {
        ...clarification.runEvents,
        [requestRun.id]: (clarification.runEvents[requestRun.id] ?? []).filter(
          (event) => event.type !== "ClarificationRequired"
        )
      }
    });
    expect(clarificationAudit.violations.some((v) => v.rule === "run-lifecycle")).toBe(true);
  });
});

describe("model-source relaxation (Phase 3 Fake COMPLETED without a Model)", () => {
  const t0 = "2026-08-13T09:00:00.000Z";
  const t1 = "2026-08-13T09:01:00.000Z";
  const t2 = "2026-08-13T09:05:00.000Z";

  /** Minimal coherent world: one COMPLETED Run on one Revision, no Models. */
  function syntheticCompletedWorld(
    completedPayload: { type: "Completed"; modelId?: string } = { type: "Completed" }
  ): MockWorld {
    const revision: DrawingRevision = {
      id: "revision-phase3",
      drawingId: "drawing-phase3",
      sequence: 1,
      sourceFile: {
        id: "file-phase3",
        fileName: "phase3.pdf",
        format: "PDF",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        relativePath: "library/drawings/file-phase3/source/original.pdf",
        uploadedAt: t0
      },
      currentApprovedModelId: null,
      createdAt: t0,
      updatedAt: t0
    };
    const drawing: Drawing = {
      id: "drawing-phase3",
      drawingNumber: "PH3-01",
      name: "Phase 3",
      currentRevisionId: revision.id,
      createdAt: t0,
      updatedAt: t0
    };
    const run = buildRun({
      id: "run-phase3",
      number: "R01",
      drawingId: drawing.id,
      revisionId: revision.id,
      status: "COMPLETED",
      stage: null,
      inputSnapshot: buildInputSnapshot({ revision, facts: [], feedback: [], createdAt: t0 }),
      createdAt: t0,
      startedAt: t1,
      completedAt: t2
    });
    const stages: readonly RunStage[] = [
      "PREPARING",
      "ANALYZING",
      "PLANNING",
      "MODELING",
      "VALIDATING",
      "PACKAGING"
    ];
    const events: RunEvent[] = stages.map((stage, index) =>
      stageEvent("run-phase3", index + 1, t1, stage)
    );
    events.push(event("run-phase3", stages.length + 1, t2, completedPayload));
    return {
      ...emptyWorld(),
      drawings: [drawing],
      revisions: [revision],
      runs: [run],
      runEvents: { "run-phase3": events }
    };
  }

  function withRecordModelId(world: MockWorld, modelId: string): MockWorld {
    return {
      ...world,
      runs: world.runs.map((run) => ({ ...run, modelId }))
    };
  }

  it("accepts a COMPLETED Run whose record and Completed event carry no modelId", () => {
    const world = syntheticCompletedWorld();
    const audit = auditScenario("run-completed", world);
    expect(audit.violations.filter((v) => v.rule === "model-source")).toEqual([]);
    expect(audit.violations).toEqual([]);
  });

  it("flags a COMPLETED Run record that names an unknown model", () => {
    const world = withRecordModelId(syntheticCompletedWorld(), "model-unknown");
    const audit = auditScenario("run-completed", world);
    expect(
      audit.violations.some(
        (v) => v.rule === "model-source" && v.message.includes("unknown model model-unknown")
      )
    ).toBe(true);
  });

  it("flags a Completed event that publishes an unknown model while the run records none", () => {
    const world = syntheticCompletedWorld({ type: "Completed", modelId: "model-unknown" });
    const audit = auditScenario("run-completed", world);
    expect(
      audit.violations.some(
        (v) => v.rule === "model-source" && v.message.includes("unknown model model-unknown")
      )
    ).toBe(true);
    expect(
      audit.violations.some(
        (v) => v.rule === "run-lifecycle" && v.message.includes("records none")
      )
    ).toBe(true);
  });

  it("flags a Completed event publishing a resolving Model the run record does not carry", () => {
    const model: Model = {
      id: "model-phase3",
      number: "M01",
      drawingId: "drawing-phase3",
      revisionId: "revision-phase3",
      runId: "run-phase3",
      reviewStatus: "PENDING_REVIEW",
      generatedAt: t2,
      productionVerified: false,
      artifactIds: []
    };
    const world = syntheticCompletedWorld({ type: "Completed", modelId: model.id });
    const audit = auditScenario("run-completed", {
      ...world,
      models: [model]
    });
    expect(
      audit.violations.some(
        (v) => v.rule === "run-lifecycle" &&
          v.message.includes(`publishes model ${model.id}`) &&
          v.message.includes("records none")
      )
    ).toBe(true);
    expect(
      audit.violations.some(
        (v) => v.rule === "model-source" && v.message.includes("records modelId none")
      )
    ).toBe(true);
  });
});

describe("R05 causal chain variants", () => {
  it("audits the running -> validating -> packaging chain in the completed variants", () => {
    for (const scenario of [
      "run-completed",
      "model-pending-review",
      "model-approved",
      "model-rejected",
      "cost-report-generated"
    ] as const) {
      const world = scenarioWorld(scenario);
      const events = world.runEvents[RUN_IDS.mainR05] ?? [];
      const stages = events
        .filter((event) => event.type === "StageChanged")
        .map((event) => event.stage);
      const audit = auditScenario(scenario, world);
      expect(
        audit.violations.filter((v) => v.rule === "r05-variants"),
        `${scenario} must walk the documented causal chain`
      ).toEqual([]);
      expect(stages).toEqual([
        "PREPARING",
        "ANALYZING",
        "PLANNING",
        "MODELING",
        "VALIDATING",
        "PACKAGING"
      ]);
    }
  });

  it("fails R05 when the Completed event is missing", () => {
    const world = scenarioWorld("run-completed");
    const events = world.runEvents[RUN_IDS.mainR05] ?? [];
    const audit = auditScenario("run-completed", {
      ...world,
      runEvents: {
        ...world.runEvents,
        [RUN_IDS.mainR05]: events.filter((event) => event.type !== "Completed")
      }
    });
    expect(audit.violations.some((v) => v.rule === "r05-variants")).toBe(true);
  });
});

describe("M02 rejected after source R06", () => {
  it("flags a REJECTED review that predates its source Run completion", () => {
    const world = scenarioWorld("model-approved");
    const audit = auditScenario("model-approved", {
      ...world,
      reviews: world.reviews.map((review) =>
        review.modelId === MODEL_IDS.mainM02
          ? { ...review, createdAt: "2026-08-10T21:00:00.000Z" }
          : review
      )
    });
    expect(audit.violations.some((v) => v.rule === "reject-source")).toBe(true);
  });
});

describe("sole RUNNING", () => {
  it("reports more than one RUNNING run", () => {
    const world = scenarioWorld("run-running");
    // run-running already features R05 as RUNNING; adding cR02 as a second
    // RUNNING run breaks the single-RUNNING invariant.
    const audit = auditScenario("run-running", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.cR02
          ? {
              ...run,
              status: "RUNNING" as const,
              stage: "MODELING" as const,
              startedAt: run.createdAt
            }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "sole-running")).toBe(true);
  });

  it("reports a RUNNING run that overlaps a completed R05", () => {
    const world = scenarioWorld("run-completed");
    // run-completed has R05 COMPLETED and cR02 RUNNING after R05 finished.
    // Moving cR02's start before R05's completion breaks the serial order.
    const r05 = world.runs.find((run) => run.id === RUN_IDS.mainR05);
    if (r05?.completedAt === undefined) throw new Error("R05 completion missing");
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.cR02
          ? { ...run, startedAt: "2026-08-10T22:40:00.000Z" }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "sole-running")).toBe(true);
  });
});

describe("cost reports depend on the then-current approved model", () => {
  it("flags a report that references a model approved later than the report", () => {
    const world = scenarioWorld("cost-report-generated");
    const q03 = world.reports.find((report) => report.id === REPORT_IDS.q03);
    if (q03 === undefined) throw new Error("Q03 missing");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      reports: world.reports.map((report) =>
        report.id === REPORT_IDS.q03
          ? { ...report, modelId: MODEL_IDS.mainM01, createdAt: "2026-08-10T23:21:00.000Z" }
          : report
      )
    });
    // M01 was not the current approved model when Q03 was created (M03 was), so
    // the report becomes stale.
    expect(audit.violations.some((v) => v.rule === "cost-reports")).toBe(true);
  });

  it("rejects a report whose frozen cost snapshot is incomplete or from another time", () => {
    const world = scenarioWorld("cost-report-generated");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      reports: world.reports.map((report) =>
        report.id === REPORT_IDS.q01
          ? {
              ...report,
              snapshot: {
                ...report.snapshot,
                input: {
                  ...report.snapshot.input,
                  costData: { ...report.snapshot.input.costData, materials: [] }
                }
              }
            }
          : report
      )
    });
    expect(audit.violations.some((v) => v.rule === "timeline")).toBe(true);
  });
});

describe("identity, timestamp, and execution interval invariants", () => {
  it("reports duplicate ids and run-event ownership mismatches", () => {
    const world = scenarioWorld("run-completed");
    const firstRun = world.runs[0];
    if (firstRun === undefined) throw new Error("run missing");
    const audit = auditScenario("run-completed", {
      ...world,
      runs: [...world.runs, { ...firstRun }],
      runEvents: {
        ...world.runEvents,
        rogue: [...(world.runEvents[firstRun.id] ?? [])],
        [firstRun.id]: (world.runEvents[firstRun.id] ?? []).map((event) => ({ ...event, runId: "rogue" }))
      }
    });
    expect(audit.violations.some((v) => v.rule === "unique-ids")).toBe(true);
  });

  it("reports invalid timestamps instead of silently treating them as zero", () => {
    const world = scenarioWorld("run-running");
    const audit = auditScenario("run-running", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05 ? { ...run, startedAt: "not-a-timestamp" } : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "finite-times")).toBe(true);
  });

  it("reports overlap between any executed run intervals", () => {
    const world = scenarioWorld("run-completed");
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.cR01
          ? { ...run, startedAt: "2026-08-10T22:35:00.000Z", completedAt: "2026-08-10T22:45:00.000Z" }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "run-intervals")).toBe(true);
  });

  it("reports a run snapshot tied to the wrong revision source file", () => {
    const world = scenarioWorld("run-completed");
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? { ...run, inputSnapshot: { ...run.inputSnapshot, originalFileRef: "revision-source-wrong" } }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "timeline")).toBe(true);
  });
});

describe("rule 1 mutation: every Model is produced by a COMPLETED source Run", () => {
  it("flags a Model whose source Run is not COMPLETED", () => {
    const world = scenarioWorld("run-completed");
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? { ...run, status: "FAILED" as const, completedAt: "2026-08-10T22:40:00.000Z" }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "model-source")).toBe(true);
  });

  it("flags a COMPLETED Run whose modelId does not point back at its Model", () => {
    const world = scenarioWorld("run-completed");
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05 ? { ...run, modelId: "model-nonexistent" } : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "model-source")).toBe(true);
  });

  it("flags a COMPLETED Run that has more than one Completed event", () => {
    const world = scenarioWorld("run-completed");
    const events = world.runEvents[RUN_IDS.mainR05] ?? [];
    const lastEvent = events.at(-1);
    if (lastEvent === undefined) throw new Error("R05 events missing");
    const audit = auditScenario("run-completed", {
      ...world,
      runEvents: {
        ...world.runEvents,
        [RUN_IDS.mainR05]: [
          ...events,
          { ...lastEvent, sequence: lastEvent.sequence + 1 }
        ]
      }
    });
    expect(audit.violations.some((v) => v.rule === "model-source")).toBe(true);
  });

  it("flags a REJECTED model whose source Run is not COMPLETED", () => {
    const world = scenarioWorld("model-rejected");
    const audit = auditScenario("model-rejected", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? { ...run, status: "FAILED" as const, completedAt: "2026-08-10T22:40:00.000Z" }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "model-source")).toBe(true);
  });
});

describe("rule 2 mutation: currentApprovedModelId equals the unique latest valid approval", () => {
  it("flags a pointer that does not match the unique latest valid approval", () => {
    const world = scenarioWorld("cost-report-generated");
    // M01's approval is moved after M03's, so the latest valid approval of V3
    // becomes M01 while the pointer still names M03.
    const audit = auditScenario("cost-report-generated", {
      ...world,
      reviews: world.reviews.map((review) =>
        review.modelId === MODEL_IDS.mainM01 && review.result === "APPROVED"
          ? { ...review, createdAt: "2026-08-10T23:30:00.000Z" }
          : review
      )
    });
    expect(audit.violations.some((v) => v.rule === "approval-pointer")).toBe(true);
  });

  it("flags a pointer that is stale when a newer approval exists", () => {
    const world = scenarioWorld("cost-report-generated");
    const v3 = world.revisions.find((revision) => revision.id === REVISION_IDS.mainV3);
    if (v3 === undefined) throw new Error("V3 missing");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      revisions: world.revisions.map((revision) =>
        revision.id === REVISION_IDS.mainV3 ? { ...revision, currentApprovedModelId: null } : revision
      )
    });
    expect(audit.violations.some((v) => v.rule === "approval-pointer")).toBe(true);
  });

  it("flags a non-null pointer on a revision that has no valid approval", () => {
    const world = scenarioWorld("no-current-approved-model");
    const audit = auditScenario("no-current-approved-model", {
      ...world,
      revisions: world.revisions.map((revision) =>
        revision.id === REVISION_IDS.mainV3
          ? { ...revision, currentApprovedModelId: MODEL_IDS.mainM01 }
          : revision
      )
    });
    expect(audit.violations.some((v) => v.rule === "approval-pointer")).toBe(true);
  });
});

describe("rule 3 mutation: run snapshot freezes exactly the visible facts/feedback", () => {
  /** The canonical `材料` fact survives the clarification upsert by its field. */
  const materialFactOf = (world: ReturnType<typeof scenarioWorld>) => {
    const fact = world.facts.find((candidate) => candidate.field === "材料");
    if (fact === undefined) throw new Error("material fact missing");
    return fact;
  };

  it("flags a snapshot missing a revision fact visible at run creation", () => {
    const world = scenarioWorld("run-completed");
    const materialFact = materialFactOf(world);
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? {
              ...run,
              inputSnapshot: {
                ...run.inputSnapshot,
                revisionFacts: run.inputSnapshot.revisionFacts.filter(
                  (fact) => fact.id !== materialFact.id
                )
              }
            }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "snapshot-freeze")).toBe(true);
  });

  it("flags a snapshot carrying a fact of another revision", () => {
    const world = scenarioWorld("run-completed");
    const materialFact = materialFactOf(world);
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? {
              ...run,
              inputSnapshot: {
                ...run.inputSnapshot,
                revisionFacts: [
                  ...run.inputSnapshot.revisionFacts,
                  { ...materialFact, id: "fact-rogue-revision", revisionId: REVISION_IDS.aV2 }
                ]
              }
            }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "snapshot-freeze")).toBe(true);
  });

  it("flags a snapshot including a fact not visible at run creation", () => {
    const world = scenarioWorld("run-completed");
    const materialFact = materialFactOf(world);
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? {
              ...run,
              inputSnapshot: {
                ...run.inputSnapshot,
                revisionFacts: [
                  ...run.inputSnapshot.revisionFacts,
                  { ...materialFact, id: "fact-phantom", createdAt: "2026-08-10T22:00:00.000Z" }
                ]
              }
            }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "snapshot-freeze")).toBe(true);
  });

  it("flags a snapshot including a future feedback record", () => {
    const world = scenarioWorld("cost-report-generated");
    const m02Feedback = world.feedback.find((entry) => entry.id === FEEDBACK_IDS.m02);
    if (m02Feedback === undefined) throw new Error("M02 feedback missing");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? {
              ...run,
              inputSnapshot: {
                ...run.inputSnapshot,
                modelingFeedback: [...run.inputSnapshot.modelingFeedback, m02Feedback]
              }
            }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "snapshot-freeze")).toBe(true);
  });

  it("flags a snapshot feedback referencing a model of another revision", () => {
    const world = scenarioWorld("cost-report-generated");
    const m02Feedback = world.feedback.find((entry) => entry.id === FEEDBACK_IDS.m02);
    if (m02Feedback === undefined) throw new Error("M02 feedback missing");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? {
              ...run,
              inputSnapshot: {
                ...run.inputSnapshot,
                modelingFeedback: [
                  ...run.inputSnapshot.modelingFeedback,
                  { ...m02Feedback, id: "feedback-rogue-revision", modelId: MODEL_IDS.aM01 }
                ]
              }
            }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "snapshot-freeze")).toBe(true);
  });
});

describe("rule 4 mutation: cost snapshot items are effective by the capture instant", () => {
  it("flags a snapshot material updated after the capture instant", () => {
    const world = scenarioWorld("cost-report-generated");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      reports: world.reports.map((report) =>
        report.id === REPORT_IDS.q01
          ? {
              ...report,
              snapshot: {
                ...report.snapshot,
                input: {
                  ...report.snapshot.input,
                  costData: {
                    ...report.snapshot.input.costData,
                    materials: report.snapshot.input.costData.materials.map((material) =>
                      material.id === "material-42crmo"
                        ? { ...material, updatedAt: "2026-08-11T00:00:00.000Z" }
                        : material
                    )
                  }
                }
              }
            }
          : report
      )
    });
    expect(audit.violations.some((v) => v.rule === "cost-snapshot")).toBe(true);
  });

  it("flags a snapshot material whose effectiveFrom postdates the capture instant", () => {
    const world = scenarioWorld("cost-report-generated");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      reports: world.reports.map((report) =>
        report.id === REPORT_IDS.q01
          ? {
              ...report,
              snapshot: {
                ...report.snapshot,
                input: {
                  ...report.snapshot.input,
                  costData: {
                    ...report.snapshot.input.costData,
                    materials: report.snapshot.input.costData.materials.map((material) =>
                      material.id === "material-42crmo"
                        ? { ...material, effectiveFrom: "2026-08-11T00:00:00.000Z" }
                        : material
                    )
                  }
                }
              }
            }
          : report
      )
    });
    expect(audit.violations.some((v) => v.rule === "cost-snapshot")).toBe(true);
  });
});

describe("rule 5 mutation: stage/event timing consistency", () => {
  it("flags a RUNNING run whose stage does not match its last StageChanged event", () => {
    const world = scenarioWorld("run-running");
    const audit = auditScenario("run-running", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05 ? { ...run, stage: "ANALYZING" as const } : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "run-lifecycle")).toBe(true);
  });

  it("flags a RUNNING run with a stage but no StageChanged event", () => {
    const world = scenarioWorld("run-running");
    const events = world.runEvents[RUN_IDS.mainR05] ?? [];
    const audit = auditScenario("run-running", {
      ...world,
      runEvents: {
        ...world.runEvents,
        [RUN_IDS.mainR05]: events.filter((event) => event.type !== "StageChanged")
      }
    });
    expect(audit.violations.some((v) => v.rule === "run-lifecycle")).toBe(true);
  });

  it("flags an executed run event that predates startedAt", () => {
    const world = scenarioWorld("run-running");
    const events = world.runEvents[RUN_IDS.mainR05] ?? [];
    const audit = auditScenario("run-running", {
      ...world,
      runEvents: {
        ...world.runEvents,
        [RUN_IDS.mainR05]: events.map((event, index) =>
          index === 0 ? { ...event, occurredAt: "2026-08-10T22:30:00.000Z" } : event
        )
      }
    });
    expect(audit.violations.some((v) => v.rule === "run-lifecycle")).toBe(true);
  });

  it("flags a terminal run that still shows a stage", () => {
    const world = scenarioWorld("run-completed");
    const audit = auditScenario("run-completed", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05 ? { ...run, stage: "PACKAGING" as const } : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "run-lifecycle")).toBe(true);
  });
});

describe("rule 6 mutation: source upload between drawing creation and revision creation", () => {
  it("flags a source file uploaded before its drawing was created", () => {
    const world = scenarioWorld("run-completed");
    const v3 = world.revisions.find((revision) => revision.id === REVISION_IDS.mainV3);
    if (v3 === undefined) throw new Error("V3 missing");
    const audit = auditScenario("run-completed", {
      ...world,
      revisions: world.revisions.map((revision) =>
        revision.id === REVISION_IDS.mainV3
          ? {
              ...revision,
              sourceFile: { ...revision.sourceFile, uploadedAt: "2026-08-01T00:00:00.000Z" }
            }
          : revision
      )
    });
    expect(audit.violations.some((v) => v.rule === "timeline")).toBe(true);
  });

  it("flags a source file uploaded after its revision was created", () => {
    const world = scenarioWorld("run-completed");
    const v3 = world.revisions.find((revision) => revision.id === REVISION_IDS.mainV3);
    if (v3 === undefined) throw new Error("V3 missing");
    const audit = auditScenario("run-completed", {
      ...world,
      revisions: world.revisions.map((revision) =>
        revision.id === REVISION_IDS.mainV3
          ? {
              ...revision,
              sourceFile: { ...revision.sourceFile, uploadedAt: "2026-08-11T00:00:00.000Z" }
            }
          : revision
      )
    });
    expect(audit.violations.some((v) => v.rule === "timeline")).toBe(true);
  });
});

describe("rule 15 mutation: Memory references never cross revisions", () => {
  it("flags a world feedback whose review is APPROVED instead of REJECTED", () => {
    const world = scenarioWorld("cost-report-generated");
    const m02Feedback = world.feedback.find((entry) => entry.id === FEEDBACK_IDS.m02);
    if (m02Feedback === undefined) throw new Error("M02 feedback missing");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      reviews: world.reviews.map((review) =>
        review.id === m02Feedback.reviewId ? { ...review, result: "APPROVED" as const } : review
      )
    });
    expect(audit.violations.some((v) => v.rule === "cross-revision")).toBe(true);
  });

  it("flags a world feedback whose review names a different model than the feedback", () => {
    const world = scenarioWorld("cost-report-generated");
    const m02Feedback = world.feedback.find((entry) => entry.id === FEEDBACK_IDS.m02);
    if (m02Feedback === undefined) throw new Error("M02 feedback missing");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      reviews: world.reviews.map((review) =>
        review.id === m02Feedback.reviewId ? { ...review, modelId: MODEL_IDS.mainM01 } : review
      )
    });
    expect(audit.violations.some((v) => v.rule === "cross-revision")).toBe(true);
  });

  it("flags a cross-revision Model Review (review names a model of another revision)", () => {
    const world = scenarioWorld("cost-report-generated");
    const m02Feedback = world.feedback.find((entry) => entry.id === FEEDBACK_IDS.m02);
    if (m02Feedback === undefined) throw new Error("M02 feedback missing");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      reviews: world.reviews.map((review) =>
        review.id === m02Feedback.reviewId
          ? { ...review, modelId: MODEL_IDS.aM01 }
          : review
      )
    });
    expect(audit.violations.some((v) => v.rule === "cross-revision")).toBe(true);
  });

  it("flags a world fact whose source Run belongs to another revision", () => {
    const world = scenarioWorld("cost-report-generated");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      facts: world.facts.map((fact) =>
        fact.sourceRunId === RUN_IDS.mainR04
          ? { ...fact, sourceRunId: RUN_IDS.cR02 }
          : fact
      )
    });
    expect(audit.violations.some((v) => v.rule === "cross-revision")).toBe(true);
  });

  it("flags a snapshot fact whose source Run belongs to another revision", () => {
    const world = scenarioWorld("cost-report-generated");
    const audit = auditScenario("cost-report-generated", {
      ...world,
      runs: world.runs.map((run) =>
        run.id === RUN_IDS.mainR05
          ? {
              ...run,
              inputSnapshot: {
                ...run.inputSnapshot,
                revisionFacts: run.inputSnapshot.revisionFacts.map((fact) =>
                  fact.sourceRunId !== undefined ? { ...fact, sourceRunId: RUN_IDS.cR02 } : fact
                )
              }
            }
          : run
      )
    });
    expect(audit.violations.some((v) => v.rule === "cross-revision")).toBe(true);
  });
});
