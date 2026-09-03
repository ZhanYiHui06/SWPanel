import { beforeEach, describe, expect, it } from "vitest";

import { MockRepository, setClockOverride } from "./mock-repository.js";
import {
  CLARIFICATION_IDS,
  DRAWING_IDS,
  MODEL_IDS,
  REVISION_IDS,
  REPORT_IDS,
  RUN_IDS
} from "../../fixtures/index.js";
import { DomainInvariantError, revisionLabel, type ModelingRun } from "@swpanel/domain";
import type { MockCommand } from "./command-types.js";
import type { ClarificationAnswerInput } from "../../fixtures/clarifications.js";

const MAIN = DRAWING_IDS.main;
const V3 = REVISION_IDS.mainV3;

function toAnswerInputs(
  answers: readonly {
    questionId: string;
    value: ClarificationAnswerInput["value"];
    field?: string;
  }[]
): readonly ClarificationAnswerInput[] {
  return answers;
}

/** Builds a valid cost-estimate input snapshot from the repository's cost data. */
function costReportSnapshot(
  repository: MockRepository,
  overrides: Partial<{
    drawingId: string;
    revisionId: string;
    modelId: string;
    quantity: number;
    materialId: string;
    finishedVolume: number;
  }> = {}
) {
  const costData = repository.getCostData();
  return {
    drawingId: overrides.drawingId ?? MAIN,
    revisionId: overrides.revisionId ?? V3,
    modelId: overrides.modelId ?? MODEL_IDS.mainM03,
    quantity: overrides.quantity ?? 3,
    materialId: overrides.materialId ?? "material-42crmo",
    stockType: "CYLINDER" as const,
    stockSpec: "Ø320 × 820 mm",
    finishedVolume: overrides.finishedVolume ?? 0.031,
    allowances: [],
    // Mutable copies so callers (and tests) may mutate their own input object
    // without touching the repository's shared state.
    costData: {
      materials: [...costData.materials],
      allowances: [...costData.allowances],
      fixedCosts: [...costData.fixedCosts],
      customFields: [...costData.customFields],
      capturedAt: "2026-08-10T23:21:00.000Z"
    },
    formulaVersion: "visual-mock-1",
    capturedAt: "2026-08-10T23:21:00.000Z"
  };
}

describe("MockRepository seeding and subscriptions", () => {
  it("exposes the scenario it was seeded from", () => {
    expect(MockRepository.create("run-running").scenario).toBe("run-running");
  });

  it("provides deterministic world snapshots", () => {
    const a = MockRepository.create("model-approved");
    const b = MockRepository.create("model-approved");
    expect(a.getSnapshot()).toEqual(b.getSnapshot());
  });

  it("notifies subscribers only on successful commands", () => {
    const repository = MockRepository.create("model-pending-review");
    const seen: MockCommand[] = [];
    const subscription = repository.subscribe((_world, command) => {
      seen.push(command);
    });
    // Invalid command: must not notify.
    expect(() =>
      repository.reviewModel({
        modelId: MODEL_IDS.mainM03,
        result: "REJECTED",
        comment: "  ",
        reviewerId: "user",
        reviewedAt: "2026-08-10T23:30:00.000Z"
      })
    ).toThrow(DomainInvariantError);
    expect(seen).toHaveLength(0);
    // Valid command: notifies once.
    repository.approveModel({
      modelId: MODEL_IDS.mainM03,
      reviewerId: "user",
      reviewedAt: "2026-08-10T23:30:00.000Z"
    });
    expect(seen).toHaveLength(1);
    subscription.unsubscribe();
    repository.rejectModel({
      modelId: MODEL_IDS.mainM01,
      reviewerId: "user",
      reviewedAt: "2026-08-10T23:31:00.000Z",
      comment: "wrong dimension"
    });
    expect(seen).toHaveLength(1);
  });

  it("reads only immutable snapshots after commands", () => {
    const repository = MockRepository.create("run-running");
    const before = repository.getSnapshot();
    repository.createRun({
      drawingId: MAIN,
      revisionId: V3
    });
    const after = repository.getSnapshot();
    expect(before).not.toBe(after);
    expect(before.runs).not.toBe(after.runs);
    // The old snapshot is unchanged.
    expect(before.runs.find((run) => run.id === RUN_IDS.mainR05)?.status).toBe("RUNNING");
  });
});

describe("run creation and cancellation commands", () => {
  it("creates a QUEUED run with the frozen snapshot on the revision", () => {
    setClockOverride(() => "2026-08-10T23:40:00.000Z");
    const repository = MockRepository.create("clarification-open");
    const run = repository.createRun({
      drawingId: MAIN,
      revisionId: V3
    });
    setClockOverride(null);
    expect(run.status).toBe("QUEUED");
    expect(run.stage).toBeNull();
    expect(run.number).toBe("R05");
    expect(run.createdAt).toBe("2026-08-10T23:40:00.000Z");
    expect(run.inputSnapshot.revisionId).toBe(V3);
    expect(run.inputSnapshot.createdAt).toBe(run.createdAt);
    expect(run.inputSnapshot.skill.name).toBe("solidworks-build-part-from-drawing");
    expect(repository.getRunEvents(run.id)).toEqual([]);
  });

  it("rejects creating a run against a revision of another drawing", () => {
    const repository = MockRepository.create("clarification-open");
    expect(() =>
      repository.createRun({
        drawingId: MAIN,
        revisionId: REVISION_IDS.aV2
      })
    ).toThrow(/does not belong to drawing/);
  });

  it("freezes the snapshot from the repository's own memory at the creation moment", () => {
    // The repository owns snapshot freezing (the Runner stand-in): a fact
    // recorded at or before the creation moment is captured, a later fact is
    // not, and the caller can never inject a forged snapshot.
    setClockOverride(() => "2026-08-10T23:40:00.000Z");
    const repository = MockRepository.create("clarification-open");
    repository.addRevisionFact({
      id: "fact-fresh-1",
      revisionId: V3,
      field: "新鲜事实",
      value: "是",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-10T23:39:00.000Z"
    });
    repository.addRevisionFact({
      id: "fact-fresh-2",
      revisionId: V3,
      field: "未来事实",
      value: "否",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-10T23:41:00.000Z"
    });
    const run = repository.createRun({
      drawingId: MAIN,
      revisionId: V3
    });
    setClockOverride(null);
    expect(run.inputSnapshot.revisionFacts.some((fact) => fact.id === "fact-fresh-1")).toBe(true);
    expect(run.inputSnapshot.revisionFacts.some((fact) => fact.id === "fact-fresh-2")).toBe(false);
  });

  it("deep-clones and deep-freezes the created Run and its input snapshot", () => {
    setClockOverride(() => "2026-08-10T23:40:00.000Z");
    const repository = MockRepository.create("clarification-open");
    repository.addRevisionFact({
      id: "fact-freeze-1",
      revisionId: V3,
      field: "冻结事实",
      value: "原始值",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-10T23:39:00.000Z"
    });
    const run = repository.createRun({ drawingId: MAIN, revisionId: V3 });
    setClockOverride(null);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.inputSnapshot)).toBe(true);
    expect(Object.isFrozen(run.inputSnapshot.revisionFacts)).toBe(true);
    const frozenFact = run.inputSnapshot.revisionFacts.find((fact) => fact.id === "fact-freeze-1");
    expect(frozenFact).toBeDefined();
    // A mutation attempt on the returned snapshot throws in strict mode
    // instead of corrupting the stored world.
    expect(() => {
      (frozenFact as { value: string }).value = "篡改";
    }).toThrowError(TypeError);
    // The frozen snapshot is a deep copy: mutating the repository's own Memory
    // after creation cannot leak into it.
    expect(frozenFact?.value).toBe("原始值");
    const liveFact = repository.getSnapshot().facts.find((fact) => fact.id === "fact-freeze-1");
    expect(liveFact?.value).toBe("原始值");
  });

  it("cancels a RUNNING run and keeps its history terminal", () => {
    setClockOverride(() => "2026-08-10T23:45:00.000Z");
    const repository = MockRepository.create("run-running");
    const cancelled = repository.cancelRun(RUN_IDS.mainR05, "用户主动取消");
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.stage).toBeNull();
    const events = repository.getRunEvents(RUN_IDS.mainR05);
    expect(events.some((event) => event.type === "CancellationRequested")).toBe(true);
    expect(events.some((event) => event.type === "CancellationConfirmed")).toBe(true);
    setClockOverride(null);
  });

  it("rejects cancelling a terminal run", () => {
    const repository = MockRepository.create("run-cancelled");
    expect(() => repository.cancelRun(RUN_IDS.mainR05)).toThrow(/only QUEUED or RUNNING/);
  });
});

describe("clarification submission command", () => {
  it("answers the open request, saves facts and keeps R04 terminal", () => {
    const repository = MockRepository.create("clarification-open");
    repository.submitClarificationAnswers({
      clarificationId: CLARIFICATION_IDS.mainR04,
      answeredBy: "current-windows-user",
      answeredAt: "2026-08-10T21:10:00.000Z",
      answers: toAnswerInputs([
        { questionId: "C01", value: { kind: "dimension", value: 85, unit: "mm" }, field: "中心孔深度" },
        { questionId: "C02", value: { kind: "text", value: "右侧轴肩外缘" }, field: "R5 圆角位置" },
        { questionId: "C03", value: { kind: "choice", optionId: "opt-42crmo" }, field: "材料" }
      ])
    });
    const request = repository.getClarificationRequest(CLARIFICATION_IDS.mainR04);
    expect(request?.status).toBe("ANSWERED");
    expect(request?.answers).toHaveLength(3);
    const run = repository.getRun(RUN_IDS.mainR04);
    expect(run?.status).toBe("CLARIFICATION_REQUIRED");
    // Facts carry the stable canonical field, not the free-form question text.
    const facts = repository
      .listFacts()
      .filter((fact) => fact.revisionId === V3 && fact.source === "CLARIFICATION");
    expect(facts.map((fact) => fact.field)).toEqual(
      expect.arrayContaining(["中心孔深度", "R5 圆角位置", "材料"])
    );
    // The material answer upserts the canonical `材料` fact: exactly one fact
    // survives with the answered value, never a contradictory DRAWING_CONFIRMED
    // duplicate alongside it.
    const materialFacts = repository
      .listFacts()
      .filter((fact) => fact.revisionId === V3 && fact.field === "材料");
    expect(materialFacts).toHaveLength(1);
    expect(materialFacts[0]?.source).toBe("CLARIFICATION");
    expect(materialFacts[0]?.value).toBe("42CrMo");
  });

  it("rejects answering an already answered request", () => {
    const repository = MockRepository.create("clarification-answered");
    const outcome = repository.submitClarificationAnswers({
      clarificationId: CLARIFICATION_IDS.mainR04,
      answeredBy: "current-windows-user",
      answeredAt: "2026-08-10T22:00:00.000Z",
      answers: toAnswerInputs([
        { questionId: "C01", value: { kind: "dimension", value: 90, unit: "mm" } }
      ])
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join()).toContain("not open");
  });

  it("rejects answers referencing unknown questions", () => {
    const repository = MockRepository.create("clarification-open");
    const outcome = repository.submitClarificationAnswers({
      clarificationId: CLARIFICATION_IDS.mainR04,
      answeredBy: "current-windows-user",
      answeredAt: "2026-08-10T21:10:00.000Z",
      answers: toAnswerInputs([{ questionId: "C99", value: { kind: "text", value: "x" } }])
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join()).toContain("unknown question");
  });

  it("rejects a partial batch (missing answers) atomically", () => {
    const repository = MockRepository.create("clarification-open");
    const outcome = repository.submitClarificationAnswers({
      clarificationId: CLARIFICATION_IDS.mainR04,
      answeredBy: "current-windows-user",
      answeredAt: "2026-08-10T21:10:00.000Z",
      answers: toAnswerInputs([
        { questionId: "C01", value: { kind: "dimension", value: 85, unit: "mm" } }
      ])
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join()).toContain("missing answer for question C02");
    // Atomic: the request stays OPEN and nothing was persisted.
    expect(repository.getClarificationRequest(CLARIFICATION_IDS.mainR04)?.status).toBe("OPEN");
  });

  it("rejects duplicate answers for the same question", () => {
    const repository = MockRepository.create("clarification-open");
    const outcome = repository.submitClarificationAnswers({
      clarificationId: CLARIFICATION_IDS.mainR04,
      answeredBy: "current-windows-user",
      answeredAt: "2026-08-10T21:10:00.000Z",
      answers: toAnswerInputs([
        { questionId: "C01", value: { kind: "dimension", value: 85, unit: "mm" } },
        { questionId: "C01", value: { kind: "dimension", value: 86, unit: "mm" } },
        { questionId: "C02", value: { kind: "text", value: "右侧轴肩外缘" } },
        { questionId: "C03", value: { kind: "choice", optionId: "opt-42crmo" } }
      ])
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join()).toContain("duplicate answer for question C01");
  });

  it("rejects a negative dimension answer", () => {
    const repository = MockRepository.create("clarification-open");
    const outcome = repository.submitClarificationAnswers({
      clarificationId: CLARIFICATION_IDS.mainR04,
      answeredBy: "current-windows-user",
      answeredAt: "2026-08-10T21:10:00.000Z",
      answers: toAnswerInputs([
        { questionId: "C01", value: { kind: "dimension", value: -85, unit: "mm" } },
        { questionId: "C02", value: { kind: "text", value: "右侧轴肩外缘" } },
        { questionId: "C03", value: { kind: "choice", optionId: "opt-42crmo" } }
      ])
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join()).toContain("must not be negative");
  });

  it("rejects a choice answer with an unknown option id", () => {
    const repository = MockRepository.create("clarification-open");
    const outcome = repository.submitClarificationAnswers({
      clarificationId: CLARIFICATION_IDS.mainR04,
      answeredBy: "current-windows-user",
      answeredAt: "2026-08-10T21:10:00.000Z",
      answers: toAnswerInputs([
        { questionId: "C01", value: { kind: "dimension", value: 85, unit: "mm" } },
        { questionId: "C02", value: { kind: "text", value: "右侧轴肩外缘" } },
        { questionId: "C03", value: { kind: "choice", optionId: "opt-nope" } }
      ])
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join()).toContain("unknown option");
  });
});

describe("drawing workflow commands", () => {
  const SHA = "ab".repeat(32);
  const AT = "2026-08-12T10:00:00.000Z";

  it("creates a drawing with its first revision and no Modeling Run", () => {
    const repository = MockRepository.create("empty-drawing-library");
    const runsBefore = repository.listRuns().length;
    const { drawing, revision } = repository.createDrawing({
      drawingNumber: "PDJF999.01.01",
      name: "测试图纸",
      sourceFile: { fileName: "PDJF999.01.01.pdf", format: "PDF", sizeBytes: 2_048_000, sha256: SHA },
      createdAt: AT
    });
    // First revision is automatically the current one; no run is created.
    expect(drawing.currentRevisionId).toBe(revision.id);
    expect(revision.sequence).toBe(1);
    expect(revisionLabel(revision.sequence)).toBe("V1");
    expect(revision.sourceFile.sha256).toBe(SHA);
    expect(revision.sourceFile.relativePath).toContain("library/drawings/");
    expect(repository.listRuns().length).toBe(runsBefore);
    expect(repository.getDrawingHistory(drawing.id).revisions).toHaveLength(1);
  });

  it("rejects a duplicate drawing number atomically", () => {
    const repository = MockRepository.create("empty-drawing-library");
    repository.createDrawing({
      drawingNumber: "PDJF999.01.01",
      name: "测试图纸",
      sourceFile: { fileName: "a.pdf", format: "PDF", sizeBytes: 100, sha256: SHA },
      createdAt: AT
    });
    expect(() =>
      repository.createDrawing({
        drawingNumber: "PDJF999.01.01",
        name: "重复图号",
        sourceFile: { fileName: "b.pdf", format: "PDF", sizeBytes: 100, sha256: SHA },
        createdAt: AT
      })
    ).toThrow(/already exists/);
    expect(repository.listDrawings()).toHaveLength(1);
  });

  it("appends a new revision with the next sequence without switching the current pointer", () => {
    const repository = MockRepository.create("run-running");
    const v3Before = repository.getDrawingDetail(MAIN).drawing.currentRevisionId;
    const revision = repository.createRevision({
      drawingId: MAIN,
      sourceFile: { fileName: "PDJF480.01.17C-4_V4.pdf", format: "PDF", sizeBytes: 3_000_000, sha256: SHA },
      createdAt: AT
    });
    expect(revision.sequence).toBe(4);
    expect(revisionLabel(revision.sequence)).toBe("V4");
    // The current pointer stays on the previous current revision.
    expect(repository.getDrawingDetail(MAIN).drawing.currentRevisionId).toBe(v3Before);
    // No run was created by adding a revision.
    expect(
      repository.listRuns().some((run) => run.revisionId === revision.id)
    ).toBe(false);
  });

  it("switches the current revision atomically and never touches runs", () => {
    const repository = MockRepository.create("run-running");
    const v1 = REVISION_IDS.mainV1;
    const runsBefore = repository.getSnapshot().runs;
    const drawing = repository.setCurrentRevision({
      drawingId: MAIN,
      revisionId: v1,
      updatedAt: "2026-08-12T10:10:00.000Z"
    });
    expect(drawing.currentRevisionId).toBe(v1);
    const detail = repository.getDrawingDetail(MAIN);
    expect(detail.revisions.find((revision) => revision.revisionId === v1)?.isCurrent).toBe(true);
    // Runs keep their original revision/input snapshot untouched.
    expect(repository.getSnapshot().runs).toEqual(runsBefore);
  });

  it("rejects switching the current revision to a foreign revision", () => {
    const repository = MockRepository.create("run-running");
    expect(() =>
      repository.setCurrentRevision({
        drawingId: MAIN,
        revisionId: REVISION_IDS.aV2,
        updatedAt: "2026-08-12T10:10:00.000Z"
      })
    ).toThrow(/does not belong to drawing/);
  });

  it("appends a user-supplemented revision fact with canonical upsert identity", () => {
    const repository = MockRepository.create("run-running");
    const fact = repository.createRevisionFact({
      drawingId: MAIN,
      revisionId: V3,
      field: "中心孔深度",
      value: "88 mm",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T10:20:00.000Z",
      createdBy: "user-1"
    });
    expect(fact.source).toBe("USER_SUPPLEMENT");
    expect(fact.createdBy).toBe("user-1");
    // The fact uses the same canonical id identity as clarification-derived
    // facts, so a later clarification answer replaces it (and vice versa).
    expect(fact.id).toBe(`fact-${V3}-中心孔深度`);
    // The fact is visible on the revision detail and history views.
    expect(repository.getRevisionHistory(MAIN, V3).facts.some((candidate) => candidate.id === fact.id)).toBe(true);
    expect(
      repository.getRevisionDetail(MAIN, V3).facts.some((candidate) => candidate.id === fact.id)
    ).toBe(true);
  });

  it("rejects appending a fact with an unsupported source or empty value", () => {
    const repository = MockRepository.create("run-running");
    expect(() =>
      repository.createRevisionFact({
        drawingId: MAIN,
        revisionId: V3,
        field: "材料",
        value: " ",
        source: "USER_SUPPLEMENT",
        createdAt: AT
      })
    ).toThrow(/value must not be empty/);
    expect(() =>
      repository.createRevisionFact({
        drawingId: MAIN,
        revisionId: V3,
        field: "材料",
        value: "42CrMo",
        source: "FABRICATED" as never,
        createdAt: AT
      })
    ).toThrow(/unsupported fact source/);
  });

  it("appends user-supplemented modeling feedback without model/review references", () => {
    const repository = MockRepository.create("run-running");
    repository.createModelingFeedback({
      drawingId: MAIN,
      revisionId: V3,
      content: "注意右侧台阶直径，图纸标注为 Ø120。",
      createdAt: "2026-08-12T10:30:00.000Z"
    });
    const entry = repository
      .listFeedback()
      .find((candidate) => candidate.content.includes("Ø120"));
    expect(entry?.source).toBe("USER_SUPPLEMENT");
    expect(entry?.modelId).toBeUndefined();
    expect(entry?.reviewId).toBeUndefined();
    expect(repository.getRevisionDetail(MAIN, V3).modelingFeedback.some((c) => c.id === entry?.id)).toBe(true);
  });

  it("rejects feedback on a foreign revision", () => {
    const repository = MockRepository.create("run-running");
    expect(() =>
      repository.createModelingFeedback({
        drawingId: MAIN,
        revisionId: REVISION_IDS.aV2,
        content: "无效反馈",
        createdAt: AT
      })
    ).toThrow(/does not belong to drawing/);
  });

  it("updates storage settings without touching business data", () => {
    const repository = MockRepository.create("run-running");
    repository.updateStorageSettings({
      dataRoot: "C:\\Users\\engineer\\AppData\\Local\\JANGHI\\SWPanel",
      workspaceRoot: "C:\\Users\\engineer\\AppData\\Local\\JANGHI\\SWPanel\\workspaces",
      constraint: "LOCAL_FIXED_NTFS",
      updatedAt: "2026-08-12T10:40:00.000Z"
    });
    const settings = repository.getStorageSettings().settings;
    expect(settings.dataRoot).toBe("C:\\Users\\engineer\\AppData\\Local\\JANGHI\\SWPanel");
    expect(settings.constraint).toBe("LOCAL_FIXED_NTFS");
  });

  it("rejects unsupported storage constraints", () => {
    const repository = MockRepository.create("run-running");
    expect(() =>
      repository.updateStorageSettings({
        dataRoot: "S:\\share\\swpanel",
        workspaceRoot: "S:\\share\\swpanel\\workspaces",
        constraint: "SMB" as never,
        updatedAt: AT
      })
    ).toThrow(/unsupported storage constraint/);
  });

  it("reports drawing list items with revision counts and open clarifications", () => {
    const repository = MockRepository.create("clarification-open");
    const detail = repository.getDrawingDetail(MAIN);
    expect(detail.revisions).toHaveLength(3);
    expect(repository.getWorkspaceDashboard().recentDrawings.find((d) => d.drawingId === MAIN)?.totalRevisionCount).toBe(3);
    // The main revision V3 carries the OPEN clarification request.
    expect(
      repository.getWorkspaceDashboard().recentDrawings.find((d) => d.drawingId === MAIN)?.hasOpenClarification
    ).toBe(true);
  });
});

describe("model review commands", () => {
  it("approves a PENDING_REVIEW model and switches the current pointer", () => {
    const repository = MockRepository.create("model-pending-review");
    const model = repository.reviewModel({
      modelId: MODEL_IDS.mainM03,
      result: "APPROVED",
      reviewerId: "current-windows-user",
      reviewedAt: "2026-08-10T22:50:00.000Z"
    });
    expect(model.reviewStatus).toBe("APPROVED");
    expect(repository.getRevision(V3)?.currentApprovedModelId).toBe(MODEL_IDS.mainM03);
    expect(
      repository.listReviews().some((review) => review.modelId === MODEL_IDS.mainM03 && review.result === "APPROVED")
    ).toBe(true);
  });

  it("approving keeps the old approved model's historical review fact", () => {
    const repository = MockRepository.create("model-pending-review");
    repository.approveModel({
      modelId: MODEL_IDS.mainM03,
      reviewerId: "user",
      reviewedAt: "2026-08-10T22:50:00.000Z"
    });
    const m01 = repository.getModel(MODEL_IDS.mainM01);
    expect(m01?.reviewStatus).toBe("APPROVED");
    expect(repository.getRevision(V3)?.currentApprovedModelId).toBe(MODEL_IDS.mainM03);
  });

  it("rejects a PENDING_REVIEW model and writes Modeling Feedback", () => {
    const repository = MockRepository.create("model-pending-review");
    const model = repository.reviewModel({
      modelId: MODEL_IDS.mainM03,
      result: "REJECTED",
      reviewerId: "current-windows-user",
      reviewedAt: "2026-08-10T22:52:00.000Z",
      comment: "右侧台阶直径识别错误，应为 Ø120"
    });
    expect(model.reviewStatus).toBe("REJECTED");
    const feedback = repository
      .listFeedback()
      .find((entry) => entry.modelId === MODEL_IDS.mainM03);
    expect(feedback?.content).toBe("右侧台阶直径识别错误，应为 Ø120");
    expect(feedback?.source).toBe("MODEL_REVIEW_REJECTED");
  });

  it("requires a comment when rejecting", () => {
    const repository = MockRepository.create("model-pending-review");
    expect(() =>
      repository.reviewModel({
        modelId: MODEL_IDS.mainM03,
        result: "REJECTED",
        comment: "   ",
        reviewerId: "user",
        reviewedAt: "2026-08-10T22:52:00.000Z"
      })
    ).toThrow(/comment is required/);
  });

  it("never reviews an already rejected model", () => {
    const repository = MockRepository.create("model-rejected");
    expect(() =>
      repository.reviewModel({
        modelId: MODEL_IDS.mainM03,
        result: "APPROVED",
        reviewerId: "user",
        reviewedAt: "2026-08-10T23:00:00.000Z"
      })
    ).toThrow(/only PENDING_REVIEW/);
  });
});

describe("cost data editing command", () => {
  it("updates material price and fixed cost without touching unrelated values", () => {
    const repository = MockRepository.create("run-running");
    const before = repository.getCostData();
    const outcome = repository.editCostData({
      materials: [
        {
          id: "material-42crmo",
          name: "42CrMo",
          purchasePrice: 5300,
          priceUnit: "元/吨",
          density: 7.85,
          densityUnit: "g/cm³"
        }
      ],
      fixedCosts: [
        {
          id: "fixed-basic-processing",
          name: "基础加工成本",
          amount: 550,
          currency: "CNY",
          basis: "PER_PIECE"
        }
      ],
      updatedAt: "2026-08-10T23:30:00.000Z"
    });
    expect(outcome.ok).toBe(true);
    const after = repository.getCostData();
    expect(
      after.materials.find((material) => material.id === "material-42crmo")?.purchasePrice
    ).toBe(5300);
    expect(
      after.fixedCosts.find((fixedCost) => fixedCost.id === "fixed-basic-processing")?.amount
    ).toBe(550);
    expect(
      after.materials.find((material) => material.id === "material-45steel")?.purchasePrice
    ).toBe(before.materials.find((material) => material.id === "material-45steel")?.purchasePrice);
  });

  it("rejects NaN prices via the canonical cost-data command", () => {
    const repository = MockRepository.create("run-running");
    const outcome = repository.editCostData({
      materials: [
        {
          id: "material-42crmo",
          name: "42CrMo",
          purchasePrice: Number.NaN,
          priceUnit: "元/吨",
          density: 7.85,
          densityUnit: "g/cm³"
        }
      ],
      fixedCosts: [],
      updatedAt: "2026-08-10T23:30:00.000Z"
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problems.join()).toContain("purchasePrice");
    }
    // The world is unchanged: no NaN entered the store.
    expect(
      repository
        .getCostData()
        .materials.find((material) => material.id === "material-42crmo")?.purchasePrice
    ).toBe(5200);
  });
});

describe("cost report commands", () => {
  it("generates a report only for the current approved model", () => {
    const repository = MockRepository.create("model-pending-review");
    const outcome = repository.generateCostReport({
      drawingId: MAIN,
      revisionId: V3,
      modelId: MODEL_IDS.mainM03,
      quantity: 1,
      materialId: "material-42crmo",
      stockType: "CYLINDER",
      stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031,
      createdAt: "2026-08-10T23:21:00.000Z"
    });
    // M03 is PENDING_REVIEW, so report generation must be rejected.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problems.join()).toContain("APPROVED");
    }
  });

  it("rejects report generation for an approved model that is not the current approved model", () => {
    // cost-report-generated has M01 (APPROVED history) and M03 (current).
    const repository = MockRepository.create("cost-report-generated");
    const outcome = repository.generateCostReport({
      drawingId: MAIN,
      revisionId: V3,
      modelId: MODEL_IDS.mainM01,
      quantity: 1,
      materialId: "material-42crmo",
      stockType: "CYLINDER",
      stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031,
      createdAt: "2026-08-10T23:30:00.000Z"
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problems.join()).toContain("not the current approved model");
    }
  });

  it("rejects report generation for a stale (non-current) revision", () => {
    // model-approved has V2 approved M01, but V3 is the current revision.
    const repository = MockRepository.create("model-approved");
    const v2 = REVISION_IDS.mainV2;
    const outcome = repository.generateCostReport({
      drawingId: MAIN,
      revisionId: v2,
      modelId: MODEL_IDS.mainM01,
      quantity: 1,
      materialId: "material-42crmo",
      stockType: "CYLINDER",
      stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031,
      createdAt: "2026-08-10T23:30:00.000Z"
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problems.join()).toContain("current revision");
    }
  });

  it("rejects report generation for an unsupported stock type", () => {
    const repository = MockRepository.create("cost-report-generated");
    const outcome = repository.generateCostReport({
      drawingId: MAIN,
      revisionId: V3,
      modelId: MODEL_IDS.mainM03,
      quantity: 1,
      materialId: "material-42crmo",
      stockType: "OCTAGONAL_BAR" as never,
      stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031,
      createdAt: "2026-08-10T23:21:00.000Z"
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problems.join()).toContain("unsupported stockType");
    }
  });

  it("rejects report generation for a negative or non-finite finished volume", () => {
    const repository = MockRepository.create("cost-report-generated");
    for (const finishedVolume of [-0.031, Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = repository.generateCostReport({
        drawingId: MAIN,
        revisionId: V3,
        modelId: MODEL_IDS.mainM03,
        quantity: 1,
        materialId: "material-42crmo",
        stockType: "CYLINDER",
        stockSpec: "Ø320 × 820 mm",
        finishedVolume,
        createdAt: "2026-08-10T23:21:00.000Z"
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.problems.join()).toContain("finishedVolume");
      }
    }
  });

  it("generates a report with coherent deterministic synthetic totals", () => {
    const repository = MockRepository.create("cost-report-generated");
    const generated = repository.generateCostReport({
      drawingId: MAIN,
      revisionId: V3,
      modelId: MODEL_IDS.mainM03,
      quantity: 3,
      materialId: "material-42crmo",
      stockType: "CYLINDER",
      stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031,
      createdAt: "2026-08-10T23:21:00.000Z"
    });
    expect(generated.ok).toBe(true);
    const report = repository.listReports().find((candidate) => candidate.label === "Q04");
    expect(report?.quantity).toBe(3);
    expect(report?.modelId).toBe(MODEL_IDS.mainM03);
    if (report === undefined) throw new Error("Q04 report missing");
    // Coherence: totalCost === perPieceCost × quantity.
    expect(report.snapshot.result.totalCost).toBeCloseTo(
      report.snapshot.result.perPieceCost * 3,
      6
    );
    // All monetary values finite and non-negative.
    for (const value of [
      report.snapshot.result.rawStockVolume,
      report.snapshot.result.materialQuantity,
      report.snapshot.result.materialCost,
      report.snapshot.result.perPieceCost,
      report.snapshot.result.totalCost
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value >= 0).toBe(true);
    }
  });

  it("does not mutate an existing report when a new report is generated", () => {
    const repository = MockRepository.create("cost-report-generated");
    const before = repository.getCostReportDetail(REPORT_IDS.q03);
    repository.generateCostReport({
      drawingId: MAIN,
      revisionId: V3,
      modelId: MODEL_IDS.mainM03,
      quantity: 3,
      materialId: "material-42crmo",
      stockType: "CYLINDER",
      stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031,
      createdAt: "2026-08-10T23:25:00.000Z"
    });
    const after = repository.getCostReportDetail(REPORT_IDS.q03);
    expect(after).toEqual(before);
  });

  it("central creation ignores a caller-supplied zero result and recomputes deterministically", () => {
    const repository = MockRepository.create("cost-report-generated");
    const zeroResult = {
      rawStockVolume: 0,
      materialQuantity: 0,
      materialCost: 0,
      fixedCostLines: [],
      perPieceCost: 0,
      totalCost: 0,
      currency: "CNY" as const
    };
    // CostParams could attempt to persist a zero report; the central creation
    // path must recompute from the input snapshot instead of trusting `result`.
    repository.createCostReport({
      drawingId: MAIN,
      revisionId: V3,
      modelId: MODEL_IDS.mainM03,
      inputSnapshot: costReportSnapshot(repository, { quantity: 3 }),
      result: zeroResult,
      createdAt: "2026-08-10T23:30:00.000Z"
    });
    const report = repository
      .listReports()
      .find((candidate) => candidate.createdAt === "2026-08-10T23:30:00.000Z");
    if (report === undefined) throw new Error("report was not created");
    // Not zero: the stored result is the deterministic synthetic computation.
    expect(report.snapshot.result.perPieceCost).toBeGreaterThan(0);
    expect(report.snapshot.result.totalCost).toBeGreaterThan(0);
    expect(report.snapshot.result.perPieceCost * 3).toBeCloseTo(
      report.snapshot.result.totalCost,
      6
    );
    expect(report.snapshot.result).not.toEqual(zeroResult);
  });

  it("freezes stored cost report snapshots so reads are immutable", () => {
    const repository = MockRepository.create("cost-report-generated");
    const stored = repository
      .listReports()
      .find((candidate) => candidate.id === REPORT_IDS.q03);
    if (stored === undefined) throw new Error("Q03 report missing");
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.snapshot)).toBe(true);
    expect(Object.isFrozen(stored.snapshot.input)).toBe(true);
    expect(Object.isFrozen(stored.snapshot.result)).toBe(true);
    expect(Object.isFrozen(stored.snapshot.input.costData)).toBe(true);
  });

  it("defends stored reports against mutation of the caller's command input", () => {
    const repository = MockRepository.create("cost-report-generated");
    const inputSnapshot = costReportSnapshot(repository, { quantity: 3 });
    repository.createCostReport({
      drawingId: MAIN,
      revisionId: V3,
      modelId: MODEL_IDS.mainM03,
      inputSnapshot,
      result: {
        rawStockVolume: 0,
        materialQuantity: 0,
        materialCost: 0,
        fixedCostLines: [],
        perPieceCost: 0,
        totalCost: 0,
        currency: "CNY"
      },
      createdAt: "2026-08-10T23:35:00.000Z"
    });
    // Mutate the caller's object after the command returns.
    inputSnapshot.quantity = 999;
    inputSnapshot.costData.materials[0] = {
      ...inputSnapshot.costData.materials[0]!,
      purchasePrice: 1
    };
    const stored = repository
      .listReports()
      .find((candidate) => candidate.createdAt === "2026-08-10T23:35:00.000Z");
    if (stored === undefined) throw new Error("report was not created");
    expect(stored.quantity).toBe(3);
    expect(
      stored.snapshot.input.costData.materials.find(
        (material) => material.id === "material-42crmo"
      )?.purchasePrice
    ).toBe(5200);
  });
});

describe("contract reader aggregate views", () => {
  beforeEach(() => {
    setClockOverride(null);
  });

  it("getDrawingDetail lists revisions with current labels", () => {
    const repository = MockRepository.create("run-running");
    const detail = repository.getDrawingDetail(MAIN);
    expect(detail.drawing.drawingNumber).toBe("PDJF480.01.17C-4");
    expect(detail.revisions.map((revision) => revision.revisionLabel)).toEqual(["V1", "V2", "V3"]);
    expect(detail.revisions.find((revision) => revision.revisionLabel === "V3")?.isCurrent).toBe(true);
  });

  it("getRevisionDetail aggregates runs, models and reports", () => {
    const repository = MockRepository.create("cost-report-generated");
    const detail = repository.getRevisionDetail(MAIN, V3);
    expect(detail.revision.revisionLabel).toBe("V3");
    expect(detail.revision.drawingNumber).toBe("PDJF480.01.17C-4");
    expect(detail.runs.some((run) => run.status === "COMPLETED")).toBe(true);
    expect(detail.models.map((model) => model.modelLabel)).toEqual(
      expect.arrayContaining(["M01", "M02", "M03"])
    );
    expect(
      detail.models.find((model) => model.modelLabel === "M03")?.isCurrentApproved
    ).toBe(true);
    expect(detail.costReports.map((report) => report.label)).toEqual(["Q01", "Q02", "Q03"]);
  });

  it("getRunDetail exposes activity, progress and the event cursor", () => {
    const repository = MockRepository.create("run-running");
    const detail = repository.getRunDetail(RUN_IDS.mainR05);
    expect(detail.run.status).toBe("RUNNING");
    expect(detail.run.stage).toBe("MODELING");
    expect(detail.run.activity).toBe("正在创建主要旋转特征");
    expect(detail.run.progressPercent).toBe(63);
    expect(detail.lastEventSequence).toBeGreaterThanOrEqual(8);
    expect(detail.events.at(-1)?.type).toBe("ActivityUpdated");
  });

  it("getClarification returns the view with questions and answers", () => {
    const repository = MockRepository.create("clarification-open");
    const view = repository.getClarification(CLARIFICATION_IDS.mainR04);
    expect(view.status).toBe("OPEN");
    expect(view.questions).toHaveLength(3);
    expect(view.questions[0]).toMatchObject({ type: "dimension", unit: "mm" });
  });

  it("getModelDetail aggregates artifacts and reviews", () => {
    const repository = MockRepository.create("model-approved");
    const detail = repository.getModelDetail(MODEL_IDS.mainM03);
    expect(detail.model.reviewStatus).toBe("APPROVED");
    expect(detail.model.isCurrentApproved).toBe(true);
    // The read-only production-verification claim is surfaced truthfully (the
    // fixture models are synthetic demo data, never production-verified).
    expect(detail.model.productionVerified).toBe(false);
    expect(detail.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["SLDPRT", "PREVIEW", "DIMENSION_LEDGER"])
    );
    expect(detail.reviews.some((review) => review.result === "APPROVED")).toBe(true);
  });

  it("getWorkspaceDashboard aggregates current run, queue and pending items", () => {
    const repository = MockRepository.create("run-running");
    const dashboard = repository.getWorkspaceDashboard();
    // Single RUNNING invariant: R05 is the only running run and the dashboard
    // current run.
    expect(dashboard.currentRun?.status).toBe("RUNNING");
    expect(dashboard.currentRun?.runId).toBe(RUN_IDS.mainR05);
    // Drawing A has a queued R03, drawing B a queued R01, and drawing C's R02
    // is queued while R05 is the featured running run.
    expect(dashboard.queuedRunLabels).toContain("R03");
    expect(dashboard.queuedRunLabels).toContain("R01");
    // run-running has no pending reviews (M01 already approved, no M03 yet).
    expect(dashboard.pendingReviews).toHaveLength(0);
  });

  it("getWorkspaceDashboard lists pending review from the model-pending-review scenario", () => {
    const repository = MockRepository.create("model-pending-review");
    const dashboard = repository.getWorkspaceDashboard();
    expect(dashboard.pendingReviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: MODEL_IDS.mainM03, modelLabel: "M03" })
      ])
    );
  });

  it("getEffectiveCostData returns the canonical snapshot", () => {
    const repository = MockRepository.create("run-running");
    const snapshot = repository.getEffectiveCostData();
    expect(snapshot.materials.find((material) => material.id === "material-42crmo")?.purchasePrice).toBe(5200);
    expect(snapshot.fixedCosts).toHaveLength(3);
  });

  it("getRevisionDetail uses the contracts revision label helper", () => {
    const repository = MockRepository.create("run-running");
    const detail = repository.getRevisionDetail(MAIN, REVISION_IDS.mainV2);
    expect(detail.revision.revisionLabel).toBe(revisionLabel(2));
    expect(detail.revision.isCurrent).toBe(false);
  });
});

describe("contract writer primitives", () => {
  it("appends ordered run events via appendRunEvent", () => {
    const repository = MockRepository.create("run-queued");
    const run = repository.createRun({
      drawingId: MAIN,
      revisionId: V3
    });
    expect(repository.getRunEvents(run.id)).toEqual([]);
    repository.appendRunEvent({
      contractVersion: 1,
      runId: run.id,
      attemptId: "attempt-1",
      sequence: 1,
      occurredAt: "2026-08-10T23:41:00.000Z",
      type: "StageChanged",
      stage: "PREPARING"
    });
    repository.appendRunEvent({
      contractVersion: 1,
      runId: run.id,
      attemptId: "attempt-1",
      sequence: 2,
      occurredAt: "2026-08-10T23:42:00.000Z",
      type: "StageChanged",
      stage: "ANALYZING"
    });
    expect(
      repository
        .getRunEvents(run.id)
        .filter((event) => event.type === "StageChanged")
        .map((event) => event.stage)
    ).toEqual(["PREPARING", "ANALYZING"]);
  });

  it("saveModelReview, addRevisionFact and addModelingFeedback persist", () => {
    const repository = MockRepository.create("run-running");
    repository.addRevisionFact({
      id: "fact-test-1",
      revisionId: V3,
      field: "测试字段",
      value: "测试值",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-10T23:50:00.000Z"
    });
    repository.saveModelReview({
      id: "review-test-1",
      modelId: MODEL_IDS.mainM01,
      result: "REJECTED",
      reviewerId: "user",
      comment: "测试意见",
      createdAt: "2026-08-10T23:51:00.000Z"
    });
    repository.addModelingFeedback({
      id: "feedback-test-1",
      revisionId: V3,
      modelId: MODEL_IDS.mainM01,
      reviewId: "review-test-1",
      content: "测试意见",
      source: "MODEL_REVIEW_REJECTED",
      createdAt: "2026-08-10T23:51:00.000Z"
    });
    expect(repository.listFacts().some((fact) => fact.id === "fact-test-1")).toBe(true);
    expect(repository.listReviews().some((review) => review.id === "review-test-1")).toBe(true);
    expect(repository.listFeedback().some((entry) => entry.id === "feedback-test-1")).toBe(true);
  });

  it("saveRun rejects a second RUNNING run (single-RUNNING invariant)", () => {
    const repository = MockRepository.create("run-running");
    // R05 is already RUNNING; saving a second RUNNING run must throw.
    const secondRunning: ModelingRun = {
      id: "run-forced-running",
      number: "R99",
      drawingId: MAIN,
      revisionId: V3,
      status: "RUNNING",
      stage: "MODELING",
      inputSnapshot: {
        drawingId: MAIN,
        revisionId: V3,
        originalFileRef: "file-main-v3",
        revisionFacts: [],
        modelingFeedback: [],
        promptTemplateVersion: "1.0.0",
        skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) },
        agentConfigId: "codex-app-server",
        createdAt: "2026-08-10T23:55:00.000Z"
      },
      createdAt: "2026-08-10T23:55:00.000Z"
    };
    expect(() => repository.saveRun(secondRunning)).toThrow(/another run is already RUNNING/);
  });

  it("saveRun permits updating the existing RUNNING run itself", () => {
    const repository = MockRepository.create("run-running");
    const running = repository.getRun(RUN_IDS.mainR05);
    if (running === undefined) throw new Error("R05 missing");
    expect(() => repository.saveRun({ ...running, stage: "VALIDATING" })).not.toThrow();
    expect(repository.getRun(RUN_IDS.mainR05)?.stage).toBe("VALIDATING");
  });
});
