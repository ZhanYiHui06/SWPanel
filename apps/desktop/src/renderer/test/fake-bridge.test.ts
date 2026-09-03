import { describe, expect, it } from "vitest";

import type { ModelingRun, RunEvent } from "@swpanel/domain";

import type {
  BridgeResult,
  RunEventsBridgePush
} from "../../main/bridge/bridge-contract.js";
import { createFakeBridge, type FakeBridge } from "./fake-bridge.js";

/** Deterministic RunEvent for fake-bridge subscription tests. */
function runEvent(runId: string, sequence: number): RunEvent {
  return {
    contractVersion: 1,
    runId,
    attemptId: "attempt-1",
    sequence,
    occurredAt: "2026-08-13T10:00:00.000Z",
    type: "StageChanged",
    stage: "PREPARING"
  };
}

/** Seeds a Drawing + Revision so runs.create can resolve the identity pair. */
function seedDrawing(bridge: FakeBridge): { drawingId: string; revisionId: string } {
  void bridge.api.drawings.importDrawing({
    drawingNumber: "PDJF-FAKE.01",
    name: "Fake 图纸",
    selectedFileToken: "swsel_00000000000000000000000000000000",
    createdAt: "2026-08-13T09:00:00.000Z"
  });
  const state = bridge.state();
  return {
    drawingId: state.drawings[0]?.id as string,
    revisionId: state.revisions[0]?.id as string
  };
}

function unwrap<T>(result: BridgeResult<T>): T {
  if (result.ok) return result.data;
  throw new Error(`bridge failed: ${result.error.code} ${result.error.message}`);
}

describe("fake bridge run surface (M2)", () => {
  it("runs.create mints a QUEUED Run with a frozen snapshot and serves detail/list", async () => {
    const bridge = createFakeBridge();
    const { drawingId, revisionId } = seedDrawing(bridge);
    const created = unwrap(
      await bridge.api.runs.create({ drawingId, revisionId })
    );
    expect(created.status).toBe("QUEUED");
    expect(created.inputSnapshot.drawingId).toBe(drawingId);
    expect(created.inputSnapshot.revisionFacts).toEqual([]);

    const list = unwrap(await bridge.api.runs.list());
    expect(list.map((item) => item.runId)).toEqual([created.id]);
    const detail = unwrap(await bridge.api.runs.getDetail(created.id));
    expect(detail.run.status).toBe("QUEUED");
    expect(detail.lastEventSequence).toBe(0);
  });

  it("runs.cancel cancels a QUEUED Run atomically and is stable on repeats", async () => {
    const bridge = createFakeBridge();
    const { drawingId, revisionId } = seedDrawing(bridge);
    const run = unwrap(await bridge.api.runs.create({ drawingId, revisionId }));
    const pushes: RunEventsBridgePush[] = [];
    bridge.api.runs.subscribe({ runId: run.id, fromSequence: 0 }, (push) => pushes.push(push));

    const cancelled = unwrap(await bridge.api.runs.cancel({ runId: run.id, reason: "用户取消" }));
    expect(cancelled).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
    const detail = unwrap(await bridge.api.runs.getDetail(run.id));
    expect(detail.run.status).toBe("CANCELLED");
    expect(detail.events.map((event) => event.type)).toEqual([
      "CancellationRequested",
      "CancellationConfirmed"
    ]);
    // The cancellation pair is pushed to live subscribers.
    expect(pushes).toHaveLength(2);

    // Repeat is stable, never an error.
    const repeat = unwrap(await bridge.api.runs.cancel({ runId: run.id }));
    expect(repeat).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: true });
  });

  it("runs.cancel cancels a RUNNING Run (scripted immediate confirmation, mirroring the real pair)", async () => {
    const bridge = createFakeBridge();
    const { drawingId, revisionId } = seedDrawing(bridge);
    const seeded = unwrap(await bridge.api.runs.create({ drawingId, revisionId }));
    // Stage the run as RUNNING like the real executor claim would.
    const running: ModelingRun = { ...seeded, status: "RUNNING" };
    bridge.addRun(running);

    const cancelled = unwrap(await bridge.api.runs.cancel({ runId: seeded.id }));
    expect(cancelled).toEqual({ runId: seeded.id, status: "CANCELLED", alreadyCancelled: false });
    const detail = unwrap(await bridge.api.runs.getDetail(seeded.id));
    expect(detail.run.status).toBe("CANCELLED");
    expect(detail.events.map((event) => event.type)).toEqual([
      "CancellationRequested",
      "CancellationConfirmed"
    ]);
  });

  it("runs.cancel refuses terminal runs truthfully (DOMAIN_INVARIANT)", async () => {
    const bridge = createFakeBridge();
    const { drawingId, revisionId } = seedDrawing(bridge);
    const run = unwrap(await bridge.api.runs.create({ drawingId, revisionId }));
    bridge.addRun({ ...run, status: "COMPLETED", completedAt: "2026-08-13T10:05:00.000Z" });
    const result = await bridge.api.runs.cancel({ runId: run.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DOMAIN_INVARIANT");
  });

  it("runs.subscribe to an unknown Run surfaces a runEventsError push and registers nothing (real-Runner alignment)", () => {
    const bridge = createFakeBridge();
    const pushes: RunEventsBridgePush[] = [];
    const unsubscribe = bridge.api.runs.subscribe(
      { runId: "missing-run", fromSequence: 0 },
      (push) => pushes.push(push)
    );
    expect(pushes).toHaveLength(1);
    const push = pushes[0];
    expect(push?.kind).toBe("runEventsError");
    expect(push?.runId).toBe("missing-run");
    if (push?.kind === "runEventsError") {
      expect(push.error.code).toBe("RUN_EVENT_INVALID");
      // Aligned with the real chain: the client surfaces the Runner's NOT_FOUND.
      expect(push.error.message).toContain("NOT_FOUND");
    }
    unsubscribe();
    // No subscription was registered: later scripted pushes must not arrive.
    bridge.emitRunEvents("missing-run", [runEvent("missing-run", 1)]);
    expect(pushes).toHaveLength(1);
  });

  it("runs.subscribe delivers the backlog then scripted live pushes; failRunStream surfaces an error push", async () => {
    const bridge = createFakeBridge();
    const { drawingId, revisionId } = seedDrawing(bridge);
    const run = unwrap(await bridge.api.runs.create({ drawingId, revisionId }));
    bridge.emitRunEvents(run.id, [runEvent(run.id, 1)]);

    const pushes: RunEventsBridgePush[] = [];
    bridge.api.runs.subscribe({ runId: run.id, fromSequence: 0 }, (push) => pushes.push(push));
    expect(pushes).toEqual([
      { kind: "runEvents", runId: run.id, fromSequence: 1, events: [runEvent(run.id, 1)] }
    ]);

    // Live pushes flow to the subscription; the persisted history grows too.
    bridge.emitRunEvents(run.id, [runEvent(run.id, 2)]);
    expect(pushes[1]).toEqual({
      kind: "runEvents",
      runId: run.id,
      fromSequence: 2,
      events: [runEvent(run.id, 2)]
    });
    expect(bridge.state().runEvents[run.id]?.map((event) => event.sequence)).toEqual([1, 2]);

    // A scripted stream failure surfaces as the structured error push.
    bridge.failRunStream(run.id, "RUN_EVENT_GAP", "skipped sequence 3");
    expect(pushes[2]).toEqual({
      kind: "runEventsError",
      runId: run.id,
      error: { code: "RUN_EVENT_GAP", message: "skipped sequence 3" }
    });
  });

  it("unsubscribe stops live delivery", async () => {
    const bridge = createFakeBridge();
    const { drawingId, revisionId } = seedDrawing(bridge);
    const run = unwrap(await bridge.api.runs.create({ drawingId, revisionId }));
    const pushes: RunEventsBridgePush[] = [];
    const unsubscribe = bridge.api.runs.subscribe(
      { runId: run.id, fromSequence: 0 },
      (push) => pushes.push(push)
    );
    expect(pushes).toHaveLength(1); // empty backlog
    unsubscribe();
    bridge.emitRunEvents(run.id, [runEvent(run.id, 1)]);
    expect(pushes).toHaveLength(1);
  });

  it("clarifications.get/submit persist answers and refuse a second submission", async () => {
    const bridge = createFakeBridge();
    bridge.addClarification({
      id: "clar-1",
      runId: "run-1",
      revisionId: "rev-1",
      status: "OPEN",
      questions: [
        { id: "dimension", type: "dimension", question: "底板厚度？", unit: "mm" }
      ],
      answers: [],
      createdAt: "2026-08-13T09:00:00.000Z"
    });
    const got = unwrap(await bridge.api.clarifications.get("clar-1"));
    expect(got.status).toBe("OPEN");

    const submitted = unwrap(
      await bridge.api.clarifications.submit({
        clarificationRequestId: "clar-1",
        answers: [
          {
            id: "renderer-ans-1",
            questionId: "dimension",
            value: { kind: "dimension", value: 12, unit: "mm" },
            answeredAt: "2026-08-13T10:00:00.000Z",
            answeredBy: "alice"
          }
        ],
        answeredAt: "2026-08-13T10:00:00.000Z",
        answeredBy: "alice"
      })
    );
    expect(submitted.status).toBe("ANSWERED");
    expect(submitted.answers).toHaveLength(1);

    const resubmit = await bridge.api.clarifications.submit({
      clarificationRequestId: "clar-1",
      answers: [
        {
          id: "renderer-ans-2",
          questionId: "dimension",
          value: { kind: "dimension", value: 20, unit: "mm" },
          answeredAt: "2026-08-13T10:05:00.000Z",
          answeredBy: "alice"
        }
      ],
      answeredAt: "2026-08-13T10:05:00.000Z",
      answeredBy: "alice"
    });
    expect(resubmit.ok).toBe(false);
    if (!resubmit.ok) expect(resubmit.error.code).toBe("DOMAIN_INVARIANT");
  });
});
