import { describe, expect, it } from "vitest";

import type { ClarificationRequest, ModelingRun, RunEvent } from "@swpanel/domain";
import type { RunDetailView } from "@swpanel/contracts";

import { BridgeRunRepository } from "./bridge-run-repository.js";
import { MockRunRepository } from "./mock-run-repository.js";
import { UnavailableRunRepository } from "./unavailable-run-repository.js";
import { applyRunEventToDetail, RunRepositoryError, type RunRepository } from "./run-repository.js";
import { cancelOutcomeNotice } from "../runs/cancel-outcome.js";
import { MockRepository } from "../mock-repository/mock-repository.js";
import { createFakeBridge } from "../../test/fake-bridge.js";
import { DRAWING_IDS, REVISION_IDS, RUN_IDS } from "../../fixtures/index.js";
import {
  buildRun,
  clarificationEvent,
  event,
  failedEvent,
  progressEvent
} from "../../fixtures/runs.js";

const NOW = "2026-08-13T00:00:00.000Z";

function makeRun(overrides: Partial<ModelingRun> & { id: string }): ModelingRun {
  return buildRun({
    id: overrides.id,
    number: overrides.number ?? `R${overrides.id.replace(/[^0-9]/g, "")}`,
    drawingId: overrides.drawingId ?? DRAWING_IDS.main,
    revisionId: overrides.revisionId ?? REVISION_IDS.mainV3,
    status: overrides.status ?? "QUEUED",
    stage: overrides.stage ?? null,
    inputSnapshot: overrides.inputSnapshot ?? {
      drawingId: DRAWING_IDS.main,
      revisionId: REVISION_IDS.mainV3,
      originalFileRef: `file-${REVISION_IDS.mainV3}`,
      revisionFacts: [],
      modelingFeedback: [],
      promptTemplateVersion: "test-v1",
      skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) },
      agentConfigId: "test-config",
      createdAt: NOW
    },
    createdAt: overrides.createdAt ?? NOW,
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.failureCode !== undefined ? { failureCode: overrides.failureCode } : {}),
    ...(overrides.failureMessage !== undefined ? { failureMessage: overrides.failureMessage } : {}),
    ...(overrides.clarificationRequestId !== undefined
      ? { clarificationRequestId: overrides.clarificationRequestId }
      : {}),
    ...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {})
  });
}

function makeDetail(run: ModelingRun, events: readonly RunEvent[] = []): RunDetailView {
  return {
    run: {
      runId: run.id,
      runLabel: run.number,
      drawingId: run.drawingId,
      revisionId: run.revisionId,
      status: run.status,
      stage: run.stage,
      activity: null,
      progressPercent: null,
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

describe("applyRunEventToDetail (strict ordered event application)", () => {
  it("applies StageChanged and ProgressUpdated onto the run fields", () => {
    const detail = makeDetail(makeRun({ id: "run-1", status: "RUNNING", stage: "PREPARING" }));
    const withStage = applyRunEventToDetail(
      detail,
      event("run-1", 1, NOW, { type: "StageChanged", stage: "ANALYZING", activity: "正在解析图纸" })
    );
    expect(withStage.run.stage).toBe("ANALYZING");
    expect(withStage.run.activity).toBe("正在解析图纸");
    const withProgress = applyRunEventToDetail(
      withStage,
      event("run-1", 2, NOW, { type: "ProgressUpdated", progressPercent: 63 })
    );
    expect(withProgress.run.progressPercent).toBe(63);
    expect(withProgress.lastEventSequence).toBe(2);
    expect(withProgress.events).toHaveLength(2);
  });

  it("turns ClarificationRequired into the terminal CLARIFICATION_REQUIRED status", () => {
    const detail = makeDetail(makeRun({ id: "run-1", status: "RUNNING" }));
    const next = applyRunEventToDetail(detail, clarificationEvent("run-1", 1, NOW, "clar-1"));
    expect(next.run.status).toBe("CLARIFICATION_REQUIRED");
    expect(next.run.clarificationRequestId).toBe("clar-1");
    expect(next.run.completedAt).toBe(NOW);
  });

  it("completes a run truthfully WITHOUT a model (Phase 3 model-less COMPLETED)", () => {
    const detail = makeDetail(makeRun({ id: "run-1", status: "RUNNING", stage: "PACKAGING" }));
    const withModel = applyRunEventToDetail(
      detail,
      event("run-1", 1, NOW, { type: "Completed", modelId: "model-m01" })
    );
    const modelLess = applyRunEventToDetail(detail, event("run-1", 1, NOW, { type: "Completed" }));
    expect(withModel.run.status).toBe("COMPLETED");
    expect(withModel.run.modelId).toBe("model-m01");
    expect(modelLess.run.status).toBe("COMPLETED");
    expect(modelLess.run.modelId).toBeNull();
    expect(modelLess.run.completedAt).toBe(NOW);
  });

  it("applies Failed with failure code and message", () => {
    const detail = makeDetail(makeRun({ id: "run-1", status: "RUNNING" }));
    const next = applyRunEventToDetail(
      detail,
      failedEvent("run-1", 1, NOW, "SOLIDWORKS_UNAVAILABLE", "SolidWorks 不可用")
    );
    expect(next.run.status).toBe("FAILED");
    expect(next.run.failureCode).toBe("SOLIDWORKS_UNAVAILABLE");
    expect(next.run.failureMessage).toBe("SolidWorks 不可用");
  });

  it("infers QUEUED -> RUNNING and startedAt from the first execution event", () => {
    const queued = makeDetail(makeRun({ id: "run-1", status: "QUEUED" }));
    const started = applyRunEventToDetail(
      queued,
      event("run-1", 1, NOW, { type: "StageChanged", stage: "PREPARING" })
    );
    expect(started.run.status).toBe("RUNNING");
    expect(started.run.startedAt).toBe(NOW);
    // Later execution events never overwrite the recorded startedAt.
    const later = applyRunEventToDetail(
      started,
      event("run-1", 2, NOW, { type: "ProgressUpdated", progressPercent: 5 })
    );
    expect(later.run.status).toBe("RUNNING");
    expect(later.run.startedAt).toBe(NOW);
  });

  it("starts a QUEUED run from an ActivityUpdated or ProgressUpdated first event", () => {
    const byActivity = applyRunEventToDetail(
      makeDetail(makeRun({ id: "run-1", status: "QUEUED" })),
      event("run-1", 1, NOW, { type: "ActivityUpdated", activity: "正在准备" })
    );
    expect(byActivity.run.status).toBe("RUNNING");
    expect(byActivity.run.startedAt).toBe(NOW);

    const byProgress = applyRunEventToDetail(
      makeDetail(makeRun({ id: "run-1", status: "QUEUED" })),
      progressEvent("run-1", 1, NOW, 3)
    );
    expect(byProgress.run.status).toBe("RUNNING");
    expect(byProgress.run.startedAt).toBe(NOW);
    expect(byProgress.run.progressPercent).toBe(3);
  });

  it("keeps a RUNNING run's startedAt and does not re-start after recovery events", () => {
    const running = makeDetail(makeRun({ id: "run-1", status: "RUNNING", startedAt: "2026-08-13T01:00:00.000Z" }));
    const next = applyRunEventToDetail(
      running,
      event("run-1", 1, NOW, { type: "StageChanged", stage: "MODELING" })
    );
    expect(next.run.status).toBe("RUNNING");
    expect(next.run.startedAt).toBe("2026-08-13T01:00:00.000Z");
  });

  it("applies CancellationConfirmed as the terminal cancelled state", () => {
    const detail = makeDetail(makeRun({ id: "run-1", status: "RUNNING" }));
    const next = applyRunEventToDetail(detail, event("run-1", 1, NOW, { type: "CancellationConfirmed" }));
    expect(next.run.status).toBe("CANCELLED");
    expect(next.run.completedAt).toBe(NOW);
  });
});

describe("BridgeRunRepository (product runtime)", () => {
  it("maps every read/command onto the bridge surface and unwraps results", async () => {
    const fake = createFakeBridge({
      seed: [
        {
          id: DRAWING_IDS.main,
          drawingNumber: "PDJF480.01.17C-4",
          name: "主图纸",
          createdAt: NOW,
          updatedAt: NOW,
          revisions: [{ id: REVISION_IDS.mainV3, sequence: 3, fileName: "v3.pdf", uploadedAt: NOW }]
        }
      ]
    });
    fake.addRun(makeRun({ id: "run-1", status: "QUEUED", createdAt: NOW }));
    const repository = new BridgeRunRepository(fake.api);

    const list = await repository.listRuns();
    expect(list).toHaveLength(1);
    expect(list[0]?.runId).toBe("run-1");

    const detail = await repository.getRunDetail("run-1");
    expect(detail.run.runId).toBe("run-1");

    const created = await repository.createRun({ drawingId: DRAWING_IDS.main, revisionId: REVISION_IDS.mainV3 });
    expect(created.status).toBe("QUEUED");
    const createCall = fake.calls.find((call) => call.startsWith("runs.create:"));
    expect(createCall).toBe(
      `runs.create:${JSON.stringify({ drawingId: DRAWING_IDS.main, revisionId: REVISION_IDS.mainV3 })}`
    );
  });

  it("surfaces structured bridge errors (RUNNER_UNAVAILABLE, NOT_FOUND)", async () => {
    const fake = createFakeBridge({ fail: ["runs.list"] });
    const repository = new BridgeRunRepository(fake.api);
    await expect(repository.listRuns()).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });

    const clean = createFakeBridge();
    const missing = new BridgeRunRepository(clean.api);
    await expect(missing.getRunDetail("run-nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deletes a terminal Run through runs.delete with the owning pair", async () => {
    const fake = createFakeBridge({
      seed: [
        {
          id: DRAWING_IDS.main,
          drawingNumber: "PDJF480.01.17C-4",
          name: "主图纸",
          createdAt: NOW,
          updatedAt: NOW,
          revisions: [{ id: REVISION_IDS.mainV3, sequence: 3, fileName: "v3.pdf", uploadedAt: NOW }]
        }
      ]
    });
    fake.addRun(makeRun({ id: "run-1", status: "COMPLETED", createdAt: NOW }));
    const repository = new BridgeRunRepository(fake.api);

    const result = await repository.deleteRun({
      runId: "run-1",
      drawingId: DRAWING_IDS.main,
      revisionId: REVISION_IDS.mainV3
    });
    expect(result.runId).toBe("run-1");
    const deleteCall = fake.calls.find((call) => call.startsWith("runs.delete:"));
    expect(deleteCall).toBe(
      `runs.delete:${JSON.stringify({
        runId: "run-1",
        drawingId: DRAWING_IDS.main,
        revisionId: REVISION_IDS.mainV3
      })}`
    );
    expect(fake.state().runs).toHaveLength(0);
  });

  it("subscribes with the exact fromSequence and unsubscribes", () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "RUNNING" }));
    const subscribed: { runId: string; fromSequence: number }[] = [];
    let unsubscribeCount = 0;
    const wrappedApi = {
      ...fake.api,
      runs: {
        ...fake.api.runs,
        subscribe: (
          input: { runId: string; fromSequence: number },
          onPush: (push: import("../../../main/bridge/bridge-contract.js").RunEventsBridgePush) => void
        ) => {
          subscribed.push(input);
          const inner = fake.api.runs.subscribe(input, onPush);
          return () => {
            unsubscribeCount += 1;
            inner();
          };
        }
      }
    };
    const repository = new BridgeRunRepository(wrappedApi);
    const pushes: unknown[] = [];
    const unsubscribe = repository.subscribeRunEvents({ runId: "run-1", fromSequence: 4 }, (push) => pushes.push(push));
    expect(subscribed).toEqual([{ runId: "run-1", fromSequence: 4 }]);
    unsubscribe();
    expect(unsubscribeCount).toBe(1);
  });
});

describe("MockRunRepository (explicit mock adapter)", () => {
  it("lists runs and creates a QUEUED run with a frozen snapshot", async () => {
    const mock = MockRepository.create("run-running");
    const repository = new MockRunRepository(mock);
    const before = await repository.listRuns();
    const created = await repository.createRun({
      drawingId: DRAWING_IDS.main,
      revisionId: REVISION_IDS.mainV3
    });
    expect(created.status).toBe("QUEUED");
    expect(created.inputSnapshot.revisionId).toBe(REVISION_IDS.mainV3);
    const after = await repository.listRuns();
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.runId).toBe(created.id);
  });

  it("resolves cancel outcomes including alreadyCancelled", async () => {
    const mock = MockRepository.create("run-running");
    const repository = new MockRunRepository(mock);
    const outcome = await repository.cancelRun({ runId: RUN_IDS.aR03, reason: "用户主动取消" });
    expect(outcome).toEqual({ runId: RUN_IDS.aR03, status: "CANCELLED", alreadyCancelled: false });
    const again = await repository.cancelRun({ runId: RUN_IDS.aR03 });
    expect(again.status === "CANCELLED" ? again.alreadyCancelled : false).toBe(true);
  });

  it("submits clarification answers and returns the answered view", async () => {
    const mock = MockRepository.create("clarification-open");
    const repository = new MockRunRepository(mock);
    const request = mock.getClarificationRequest("clar-main-r04") as ClarificationRequest;
    const answers = request.questions.map((question) => ({
      id: `answer-${question.id}`,
      questionId: question.id,
      value:
        question.type === "dimension"
          ? { kind: "dimension" as const, value: 85, unit: "mm" }
          : question.type === "text"
            ? { kind: "text" as const, value: "右侧" }
            : { kind: "choice" as const, optionId: "opt-42crmo" },
      answeredAt: NOW,
      answeredBy: "current-windows-user"
    }));
    const view = await repository.submitClarification({
      clarificationRequestId: "clar-main-r04",
      answers,
      answeredAt: NOW,
      answeredBy: "current-windows-user"
    });
    expect(view.status).toBe("ANSWERED");
    expect(view.answers).toHaveLength(answers.length);
  });

  it("deletes a terminal run from the mock world", async () => {
    const mock = MockRepository.create("run-cancelled");
    const repository = new MockRunRepository(mock);
    await repository.deleteRun({
      runId: RUN_IDS.mainR05,
      drawingId: DRAWING_IDS.main,
      revisionId: REVISION_IDS.mainV3
    });
    expect(mock.getRun(RUN_IDS.mainR05)).toBeUndefined();
  });

  it("delivers the persisted backlog then scripted live events on subscribe", () => {
    const mock = MockRepository.create("run-running");
    const repository = new MockRunRepository(mock);
    const pushes: string[] = [];
    const unsubscribe = repository.subscribeRunEvents({ runId: RUN_IDS.mainR05, fromSequence: 0 }, (push) => {
      pushes.push(push.kind);
    });
    expect(pushes[0]).toBe("runEvents"); // backlog delivered first
    repository.emitEvents(RUN_IDS.mainR05, [event(RUN_IDS.mainR05, 999, NOW, { type: "ActivityUpdated", activity: "live" })]);
    expect(pushes.filter((kind) => kind === "runEvents").length).toBe(2);
    unsubscribe();
    repository.emitEvents(RUN_IDS.mainR05, [event(RUN_IDS.mainR05, 1000, NOW, { type: "ActivityUpdated", activity: "after-unsubscribe" })]);
    expect(pushes.length).toBe(2); // no push after unsubscribe
  });
});

describe("UnavailableRunRepository", () => {
  it("rejects every operation with RUNNER_UNAVAILABLE", async () => {
    const repository: RunRepository = new UnavailableRunRepository();
    await expect(repository.listRuns()).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });
    await expect(repository.createRun({ drawingId: "d", revisionId: "r" })).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE"
    });
  });

  it("surfaces the refusal deterministically as a stream error", () => {
    const repository = new UnavailableRunRepository();
    const pushes: { kind: string; error?: { code: string; message: string } }[] = [];
    const unsubscribe = repository.subscribeRunEvents({ runId: "run-1", fromSequence: 0 }, (push) => {
      pushes.push(push);
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.kind).toBe("runEventsError");
    expect(pushes[0]?.error?.code).toBe("RUNNER_UNAVAILABLE");
    unsubscribe();
  });
});

describe("cancelOutcomeNotice", () => {
  it("maps all five structured cancel outcomes", () => {
    expect(cancelOutcomeNotice({ runId: "r1", status: "CANCELLED", alreadyCancelled: false }, "R01", 1).tone).toBe("success");
    expect(cancelOutcomeNotice({ runId: "r1", status: "CANCELLED", alreadyCancelled: true }, "R01", 2).tone).toBe("info");
    expect(
      cancelOutcomeNotice({ runId: "r1", status: "CANCEL_PENDING", detail: "FOREIGN_LIVE_LEASE", leaseDeadlineAt: null }, "R01", 3).tone
    ).toBe("warning");
    expect(
      cancelOutcomeNotice({ runId: "r1", status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" }, "R01", 4).tone
    ).toBe("error");
    const natural = cancelOutcomeNotice(
      { runId: "r1", status: "ALREADY_TERMINAL", finalStatus: "COMPLETED" },
      "R01",
      5
    );
    expect(natural.tone).toBe("info");
    expect(natural.title).toBe("Run R01 已自然结束");
    expect(natural.text).toContain("已完成");
  });
});

describe("RunRepositoryError", () => {
  it("preserves the stable code", () => {
    const error = new RunRepositoryError("RUN_EVENT_GAP", "gap");
    expect(error.code).toBe("RUN_EVENT_GAP");
    expect(error.name).toBe("RunRepositoryError");
  });
});
