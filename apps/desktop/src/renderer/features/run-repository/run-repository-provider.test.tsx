import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { ModelingRun } from "@swpanel/domain";

import { BridgeRunRepository } from "./bridge-run-repository.js";
import { MockRunRepository } from "./mock-run-repository.js";
import { RunRepositoryProvider, useRunEventStream } from "./run-repository-provider.js";
import { MockRepository } from "../mock-repository/mock-repository.js";
import { createFakeBridge } from "../../test/fake-bridge.js";
import { DRAWING_IDS, REVISION_IDS } from "../../fixtures/index.js";
import { buildRun, event, progressEvent } from "../../fixtures/runs.js";

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

/** Minimal observable harness for the stream lifecycle. */
function StreamHarness({ runId }: { readonly runId: string | null }): React.JSX.Element {
  const stream = useRunEventStream(runId);
  return (
    <div>
      <span data-testid="status">{stream.status}</span>
      <span data-testid="seq">{stream.lastSequence}</span>
      <span data-testid="events">{stream.events.length}</span>
      <span data-testid="progress">{stream.detail?.run.progressPercent ?? ""}</span>
      <span data-testid="runstatus">{stream.detail?.run.status ?? ""}</span>
      <span data-testid="error">{stream.error?.code ?? ""}</span>
      <button onClick={() => stream.retry()}>retry</button>
    </div>
  );
}

function renderStream(repository: MockRunRepository | BridgeRunRepository, runId: string | null) {
  return render(
    <RunRepositoryProvider repository={repository}>
      <StreamHarness runId={runId} />
    </RunRepositoryProvider>
  );
}

function readState(): { status: string; seq: string; events: string; progress: string; error: string } {
  return {
    status: screen.getByTestId("status").textContent ?? "",
    seq: screen.getByTestId("seq").textContent ?? "",
    events: screen.getByTestId("events").textContent ?? "",
    progress: screen.getByTestId("progress").textContent ?? "",
    error: screen.getByTestId("error").textContent ?? ""
  };
}

afterEach(cleanup);

describe("useRunEventStream (snapshot-then-subscribe + reconnect)", () => {
  it("loads the snapshot, then subscribes from lastEventSequence + 1", async () => {
    const fake = createFakeBridge();
    const run = makeRun({ id: "run-1", status: "RUNNING", stage: "PREPARING" });
    fake.addRun(run);
    fake.emitRunEvents("run-1", [
      event("run-1", 1, NOW, { type: "ActivityUpdated", activity: "a1" }),
      event("run-1", 2, NOW, { type: "ActivityUpdated", activity: "a2" }),
      event("run-1", 3, NOW, { type: "ActivityUpdated", activity: "a3" })
    ]);
    const repository = new BridgeRunRepository(fake.api);
    renderStream(repository, "run-1");

    await waitFor(() => expect(readState().status).toBe("live"));
    expect(readState().seq).toBe("3");
    expect(readState().events).toBe("3");
    // Subscribe is requested from the first unseen sequence.
    const subscribeCalls = fake.calls.filter((call) => call.startsWith("runs.subscribe:"));
    expect(subscribeCalls).toEqual([
      `runs.subscribe:${JSON.stringify({ runId: "run-1", fromSequence: 4 })}`
    ]);
  });

  it("applies live events onto the merged detail and ignores duplicates", async () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "RUNNING", stage: "MODELING" }));
    const repository = new BridgeRunRepository(fake.api);
    renderStream(repository, "run-1");
    await waitFor(() => expect(readState().status).toBe("live"));

    fake.emitRunEvents("run-1", [progressEvent("run-1", 1, NOW, 63)]);
    await waitFor(() => expect(readState().progress).toBe("63"));
    expect(readState().events).toBe("1");

    // Re-emitted duplicates are ignored (no double application).
    fake.emitRunEvents("run-1", [
      progressEvent("run-1", 1, NOW, 63),
      progressEvent("run-1", 2, NOW, 77)
    ]);
    await waitFor(() => expect(readState().progress).toBe("77"));
    expect(readState().events).toBe("2");
  });

  it("recovers from a sequence GAP by refetching the snapshot and resubscribing", async () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "RUNNING", stage: "MODELING" }));
    fake.emitRunEvents("run-1", [
      event("run-1", 1, NOW, { type: "ActivityUpdated", activity: "a1" }),
      event("run-1", 2, NOW, { type: "ActivityUpdated", activity: "a2" }),
      event("run-1", 3, NOW, { type: "ActivityUpdated", activity: "a3" })
    ]);
    const repository = new BridgeRunRepository(fake.api);
    renderStream(repository, "run-1");
    await waitFor(() => expect(readState().status).toBe("live"));

    const detailCallsBefore = fake.calls.filter((call) => call.startsWith("runs.getDetail:")).length;

    // A batch that skips sequence 4 is a gap: never silently applied.
    fake.emitRunEvents("run-1", [
      event("run-1", 5, NOW, { type: "ActivityUpdated", activity: "skipped-4" })
    ]);

    await waitFor(() => {
      const state = readState();
      expect(state.status).toBe("live");
      expect(state.events).toBe("4"); // refetched snapshot includes seq 5
    });
    // The snapshot was re-read and a fresh subscription started after it.
    const detailCallsAfter = fake.calls.filter((call) => call.startsWith("runs.getDetail:")).length;
    expect(detailCallsAfter).toBe(detailCallsBefore + 1);
    const subscribeCalls = fake.calls.filter((call) => call.startsWith("runs.subscribe:"));
    expect(subscribeCalls).toHaveLength(2);
    expect(subscribeCalls[1]).toBe(
      `runs.subscribe:${JSON.stringify({ runId: "run-1", fromSequence: 6 })}`
    );

    // The recovered stream keeps delivering live events.
    fake.emitRunEvents("run-1", [event("run-1", 6, NOW, { type: "ActivityUpdated", activity: "a6" })]);
    await waitFor(() => expect(readState().events).toBe("5"));
  });

  it("recovers from a structured stream failure by refetching and resubscribing", async () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "RUNNING", stage: "MODELING" }));
    const repository = new BridgeRunRepository(fake.api);
    renderStream(repository, "run-1");
    await waitFor(() => expect(readState().status).toBe("live"));

    fake.failRunStream("run-1", "RUN_EVENT_STREAM_LOST", "connection lost");
    await waitFor(() => {
      expect(readState().status).toBe("live"); // recovered automatically
      expect(fake.calls.filter((call) => call.startsWith("runs.getDetail:")).length).toBeGreaterThanOrEqual(2);
      expect(fake.calls.filter((call) => call.startsWith("runs.subscribe:")).length).toBeGreaterThanOrEqual(2);
    });
  });

  it("stops in a recoverable error state after repeated failures and retry() restarts", async () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "RUNNING", stage: "MODELING" }));
    const repository = new BridgeRunRepository(fake.api);
    const user = userEvent.setup();
    renderStream(repository, "run-1");
    await waitFor(() => expect(readState().status).toBe("live"));

    // Three transient stream failures each recover via refetch; the fourth
    // (still with no applied live events in between) exhausts the bounded
    // recovery attempts and stops in a recoverable error state.
    for (let attempt = 1; attempt <= 3; attempt++) {
      fake.failRunStream("run-1", "RUN_EVENT_GAP", `gap ${attempt}`);
      await waitFor(() => expect(readState().status).toBe("live"));
    }
    fake.failRunStream("run-1", "RUN_EVENT_GAP", "gap 4");
    await waitFor(() => expect(readState().status).toBe("error"));
    expect(readState().error).toBe("RUN_EVENT_STREAM_LOST");

    await user.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(readState().status).toBe("live"));
    expect(readState().seq).toBe("0");
  });

  it("shows the recovering state while the refetch is pending, then resumes", async () => {
    const mock = MockRepository.create("run-running");
    const repository = new SlowMockRunRepository(mock);
    renderStream(repository, "run-main-r05");
    await waitFor(() => expect(readState().status).toBe("live"));

    repository.delayNextDetail = true;
    repository.failStream("run-main-r05", "RUN_EVENT_GAP", "gap");
    await waitFor(() => expect(readState().status).toBe("recovering"));
    // Old data stays visible while recovering.
    expect(readState().events).not.toBe("0");

    repository.releaseDetail();
    await waitFor(() => expect(readState().status).toBe("live"));
  });

  it("guards against concurrent recoveries: stream errors during an in-flight recovery are ignored", async () => {
    const mock = MockRepository.create("run-running");
    const repository = new SlowMockRunRepository(mock);
    renderStream(repository, "run-main-r05");
    await waitFor(() => expect(readState().status).toBe("live"));
    const subscribesBefore = repository.subscribeCount;

    repository.delayNextDetail = true;
    repository.failStream("run-main-r05", "RUN_EVENT_GAP", "gap 1");
    await waitFor(() => expect(readState().status).toBe("recovering"));
    // A second failure lands while the recovery refetch is still pending.
    repository.failStream("run-main-r05", "RUN_EVENT_STREAM_LOST", "lost");

    repository.releaseDetail();
    await waitFor(() => expect(readState().status).toBe("live"));
    // Exactly ONE recovery: the initial subscribe + one resubscribe.
    expect(repository.subscribeCount).toBe(subscribesBefore + 1);
  });

  it("unsubscribes on unmount and on runId change", async () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "RUNNING" }));
    fake.addRun(makeRun({ id: "run-2", status: "RUNNING" }));
    let activeSubscriptions = 0;
    const wrappedApi = {
      ...fake.api,
      runs: {
        ...fake.api.runs,
        subscribe: (
          input: { runId: string; fromSequence: number },
          onPush: (push: import("../../../main/bridge/bridge-contract.js").RunEventsBridgePush) => void
        ) => {
          activeSubscriptions += 1;
          const inner = fake.api.runs.subscribe(input, onPush);
          return () => {
            activeSubscriptions -= 1;
            inner();
          };
        }
      }
    };
    const repository = new BridgeRunRepository(wrappedApi);
    const { rerender, unmount } = renderStream(repository, "run-1");
    await waitFor(() => expect(readState().status).toBe("live"));
    expect(activeSubscriptions).toBe(1);

    // runId change tears the old subscription down and opens the new one.
    rerender(
      <RunRepositoryProvider repository={repository}>
        <StreamHarness runId="run-2" />
      </RunRepositoryProvider>
    );
    await waitFor(() => expect(readState().seq).toBe("0"));
    expect(activeSubscriptions).toBe(1);

    unmount();
    expect(activeSubscriptions).toBe(0);
  });

  it("never flashes the previous run's data after a runId change", async () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "RUNNING", stage: "MODELING" }));
    fake.addRun(makeRun({ id: "run-2", status: "RUNNING", stage: "MODELING" }));
    const repository = new BridgeRunRepository(fake.api);
    const { rerender } = renderStream(repository, "run-1");
    await waitFor(() => expect(readState().status).toBe("live"));
    fake.emitRunEvents("run-1", [event("run-1", 1, NOW, { type: "ProgressUpdated", progressPercent: 63 })]);
    await waitFor(() => expect(readState().progress).toBe("63"));

    rerender(
      <RunRepositoryProvider repository={repository}>
        <StreamHarness runId="run-2" />
      </RunRepositoryProvider>
    );
    // The old session must not render or act: no run-1 progress, no old seq.
    expect(readState().status).not.toBe("live");
    expect(readState().progress).not.toBe("63");
    await waitFor(() => expect(readState().status).toBe("live"));
    expect(readState().seq).toBe("0");
    expect(readState().progress).toBe("");
  });

  it("applies the QUEUED -> RUNNING inference from live events to the merged detail", async () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "QUEUED" }));
    const repository = new BridgeRunRepository(fake.api);
    renderStream(repository, "run-1");
    await waitFor(() => expect(readState().status).toBe("live"));
    expect(readState().status).toBe("live");

    fake.emitRunEvents("run-1", [event("run-1", 1, NOW, { type: "StageChanged", stage: "PREPARING" })]);
    await waitFor(() => {
      expect(readState().events).toBe("1");
      expect(screen.getByTestId("runstatus").textContent).toBe("RUNNING");
    });
  });

  it("ignores pushes for other runs (per-run isolation)", async () => {
    const fake = createFakeBridge();
    fake.addRun(makeRun({ id: "run-1", status: "RUNNING" }));
    fake.addRun(makeRun({ id: "run-2", status: "RUNNING" }));
    const repository = new BridgeRunRepository(fake.api);
    renderStream(repository, "run-1");
    await waitFor(() => expect(readState().status).toBe("live"));
    fake.emitRunEvents("run-2", [progressEvent("run-2", 1, NOW, 99)]);
    expect(readState().events).toBe("0");
  });
});

/** Mock adapter whose detail refetch can be delayed to observe `recovering`. */
class SlowMockRunRepository extends MockRunRepository {
  delayNextDetail = false;
  subscribeCount = 0;
  private releaseDetailRef: (() => void) | null = null;

  async getRunDetail(runId: string) {
    if (this.delayNextDetail) {
      this.delayNextDetail = false;
      await new Promise<void>((resolve) => {
        this.releaseDetailRef = resolve;
      });
    }
    return super.getRunDetail(runId);
  }

  subscribeRunEvents(
    input: { runId: string; fromSequence: number },
    onPush: (push: import("../../../main/bridge/bridge-contract.js").RunEventsBridgePush) => void
  ): () => void {
    this.subscribeCount += 1;
    return super.subscribeRunEvents(input, onPush);
  }

  releaseDetail(): void {
    this.releaseDetailRef?.();
    this.releaseDetailRef = null;
  }
}
