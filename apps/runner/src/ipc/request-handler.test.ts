import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { IPC_PROTOCOL_VERSION } from "@swpanel/contracts";
import type { IpcRequestEnvelope, IpcResponseEnvelope } from "@swpanel/contracts";

import { Runner } from "../runner.js";
import type { RunProfile } from "../db/run-repository.js";
import type { ExecutorScheduler, ScheduledTask } from "../execution/fake-executor.js";
import { FAKE_PREFLIGHT_SKILL_SHA256 } from "../preflight/preflight.js";
import { makeTempDir, removeTempDir, samplePdfBytes, sha256Of } from "../test-utils.js";
import { IpcServer } from "./server.js";
import { createDuplexPipePair, FrameCodec } from "./index.js";
import { RunnerRequestHandler } from "./request-handler.js";

/** Minimal wire client over the in-process duplex pair (server.test.ts pattern). */
class WireClient {
  readonly stream: import("node:stream").Duplex;
  private readonly codec = new FrameCodec();
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(server: IpcServer) {
    const pair = createDuplexPipePair();
    server.attach(pair.server);
    this.stream = pair.client;
    this.stream.pipe(this.codec);
    this.codec.on("data", (line: string) => {
      this.queue.push(JSON.parse(line));
      this.notify();
    });
  }

  private notify(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  async next(timeoutMs = 2_000): Promise<unknown> {
    const existing = this.queue.shift();
    if (existing !== undefined) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the next IPC message")),
        timeoutMs
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        const message = this.queue.shift();
        if (message === undefined) return;
        resolve(message);
      });
    });
  }

  write(message: unknown): void {
    this.stream.write(FrameCodec.encode(message));
  }
}

const PROFILE: RunProfile = {
  promptTemplateVersion: "prompt-template-v3",
  // The Runner gates PREPARING with the synthetic preflight fixture whose
  // allowlist is EXACTLY the fixture digest (P5-2 review fix).
  skill: { name: "solidworks-build-part-from-drawing", sha256: FAKE_PREFLIGHT_SKILL_SHA256 },
  agentConfigId: "agent-config-1"
};

/**
 * Deterministic manual scheduler: scheduled tasks run ONLY when the test
 * flushes them, so the Fake Executor queue advances exactly when asserted.
 */
class ManualScheduler implements ExecutorScheduler {
  private tasks: Array<{ id: number; at: number; fn: () => void; cancelled: boolean }> = [];
  private nextId = 0;
  private currentMs = Date.parse("2026-08-13T09:00:00.000Z");

  now = (): Date => new Date(this.currentMs);

  schedule(fn: () => void, delayMs: number): ScheduledTask {
    const id = ++this.nextId;
    const task = { id, at: this.currentMs + Math.max(0, delayMs), fn, cancelled: false };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      }
    };
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }

  hasPending(): boolean {
    return this.tasks.some((task) => !task.cancelled && task.at <= this.currentMs);
  }

  flushAll(): void {
    let guard = 0;
    while (this.hasPending() && guard++ < 10_000) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= this.currentMs)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (next === undefined) break;
      this.tasks = this.tasks.filter((task) => task !== next);
      next.fn();
    }
  }
}

  /** Runs every due scheduler task and drains the microtask chains they release. */
  async function drainScheduler(scheduler: ManualScheduler): Promise<void> {
    let guard = 0;
    while (scheduler.hasPending() && guard++ < 10_000) {
      scheduler.flushAll();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function queryEnvelope(operation: string, payload: unknown, requestId = "q-1"): IpcRequestEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    channel: "query",
    operation: operation as IpcRequestEnvelope["operation"],
    payload
  };
}

function commandEnvelope(
  operation: string,
  payload: unknown,
  requestId = "c-1",
  idempotencyKey?: string
): IpcRequestEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    channel: "command",
    operation: operation as IpcRequestEnvelope["operation"],
    payload
  };
}

describe("RunnerRequestHandler", () => {
  const roots: string[] = [];
  const runners: Runner[] = [];

  afterEach(() => {
    while (runners.length > 0) {
      runners.pop()?.close();
    }
    while (roots.length > 0) {
      removeTempDir(roots.pop() as string);
    }
  });

  function newHandler(config: { scenario?: "success" | "clarification" | "failure" } = {}): {
    handler: RunnerRequestHandler;
    runner: Runner;
    root: string;
    scheduler: ManualScheduler;
  } {
    const root = makeTempDir("ipc-handler");
    roots.push(root);
    mkdirSync(join(root, "sources"), { recursive: true });
    const scheduler = new ManualScheduler();
    const runner = new Runner(root, {
      runProfile: PROFILE,
      fakeExecutorScenario: config.scenario ?? "success",
      scheduler,
      now: scheduler.now
    });
    runner.open();
    runners.push(runner);
    return { handler: new RunnerRequestHandler(runner), runner, root, scheduler };
  }

  /** Imports one drawing+revision and returns the drawing/revision ids. */
  async function importDrawing(
    handler: RunnerRequestHandler,
    runner: Runner,
    root: string,
    drawingNumber: string
  ): Promise<{ drawingId: string; revisionId: string }> {
    const content = samplePdfBytes();
    const sourcePath = join(root, "sources", `${drawingNumber}.pdf`);
    writeFileSync(sourcePath, content);
    runner.registerSourceFile(sha256Of(content), sourcePath);
    const createResponse = await handler.handle(
      commandEnvelope("drawing.create", {
        command: "drawing.create",
        drawingNumber,
        name: drawingNumber,
        sourceFile: {
          fileName: `${drawingNumber}.pdf`,
          format: "PDF",
          sizeBytes: content.length,
          sha256: sha256Of(content)
        },
        createdAt: "2026-08-12T01:00:00.000Z"
      })
    );
    expect(createResponse.ok).toBe(true);
    const created = createResponse.data as { drawing: { id: string }; revision: { id: string } };
    return { drawingId: created.drawing.id, revisionId: created.revision.id };
  }

  it("answers storage.getSettings with the seeded settings", async () => {
    const { handler } = newHandler();
    const response = await handler.handle(queryEnvelope("storage.getSettings", {}));
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe("q-1");
    const settings = (response.data as { settings: { dataRoot: string } }).settings;
    expect(settings.dataRoot).toBeTypeOf("string");
  });

  it("answers workspace.getDashboard with an empty dashboard", async () => {
    const { handler } = newHandler();
    const response = await handler.handle(queryEnvelope("workspace.getDashboard", {}));
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({ currentRun: null });
  });

  it("answers costData.get with an empty snapshot", async () => {
    const { handler } = newHandler();
    const response = await handler.handle(queryEnvelope("costData.get", {}));
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({});
  });

  it("maps run.getDetail of an unknown Run to NOT_FOUND", async () => {
    const { handler } = newHandler();
    const response = await handler.handle(queryEnvelope("run.getDetail", { runId: "run-1" }));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("NOT_FOUND");
  });

  it("rejects an unknown query with UNSUPPORTED_PHASE_OPERATION", async () => {
    const { handler } = newHandler();
    const response = await handler.handle(queryEnvelope("drawing.listAll", {}));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("UNSUPPORTED_PHASE_OPERATION");
  });

  it("rejects drawing.create with an unregistered source file", async () => {
    const { handler, root } = newHandler();
    const sourcePath = join(root, "sources", "unregistered.pdf");
    writeFileSync(sourcePath, samplePdfBytes());
    const response = await handler.handle(
      commandEnvelope("drawing.create", {
        command: "drawing.create",
        drawingNumber: "PDJF001.01",
        name: "未注册来源",
        sourceFile: {
          fileName: "unregistered.pdf",
          format: "PDF",
          sizeBytes: samplePdfBytes().length,
          sha256: sha256Of(samplePdfBytes())
        },
        createdAt: "2026-08-12T01:00:00.000Z"
      })
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("SOURCE_FILE_NOT_REGISTERED");
  });

  it("creates a drawing through drawing.create once its source file is registered", async () => {
    const { handler, runner, root } = newHandler();
    const sourcePath = join(root, "sources", "PDJF001.01.pdf");
    const content = samplePdfBytes();
    writeFileSync(sourcePath, content);
    runner.registerSourceFile(sha256Of(content), sourcePath);

    const createResponse = await handler.handle(
      commandEnvelope("drawing.create", {
        command: "drawing.create",
        drawingNumber: "PDJF001.01",
        name: "轧辊（一）",
        sourceFile: {
          fileName: "PDJF001.01.pdf",
          format: "PDF",
          sizeBytes: content.length,
          sha256: sha256Of(content)
        },
        createdAt: "2026-08-12T01:00:00.000Z"
      })
    );
    expect(createResponse.ok).toBe(true);
    const created = createResponse.data as { drawing: { id: string }; revision: { id: string } };

    const detailResponse = await handler.handle(
      queryEnvelope("drawing.getDetail", { drawingId: created.drawing.id })
    );
    expect(detailResponse.ok).toBe(true);
    expect(detailResponse.data).toMatchObject({
      drawing: { drawingNumber: "PDJF001.01" }
    });

    const historyResponse = await handler.handle(
      queryEnvelope("drawing.getHistory", { drawingId: created.drawing.id })
    );
    expect(historyResponse.ok).toBe(true);
    expect((historyResponse.data as { revisions: unknown[] }).revisions).toHaveLength(1);
  });

  it("rejects later-phase commands with UNSUPPORTED_PHASE_OPERATION", async () => {
    const { handler } = newHandler();
    // model.openInSolidWorks stays unsupported; model.* review/getDetail is
    // wired in Phase 6 and instead fails truthfully with NOT_FOUND for unknown
    // Models.
    const openResponse = await handler.handle(
      commandEnvelope("model.openInSolidWorks", {
        command: "model.openInSolidWorks",
        modelId: "model-1"
      })
    );
    expect(openResponse.ok).toBe(false);
    expect(openResponse.error?.code).toBe("UNSUPPORTED_PHASE_OPERATION");
    expect(openResponse.error?.message).toContain("model.openInSolidWorks");

    const modelResponse = await handler.handle(
      commandEnvelope("model.review", {
        command: "model.review",
        modelId: "model-1",
        result: "APPROVED",
        reviewerId: "alice",
        reviewedAt: "2026-08-13T00:00:00.000Z"
      })
    );
    expect(modelResponse.ok).toBe(false);
    expect(modelResponse.error?.code).toBe("NOT_FOUND");
    expect(modelResponse.error?.message).toContain("model-1");

    const modelQuery = await handler.handle(queryEnvelope("model.getDetail", { modelId: "model-1" }));
    expect(modelQuery.ok).toBe(false);
    expect(modelQuery.error?.code).toBe("NOT_FOUND");
    expect(modelQuery.error?.message).toContain("model-1");
  });

  it("creates a Run through run.create, wakes the queue, and serves detail/list/dashboard", async () => {
    const { handler, runner, root, scheduler } = newHandler();
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-RUN1");

    const createResponse = await handler.handle(
      commandEnvelope("run.create", {
        command: "run.create",
        drawingId,
        revisionId
      })
    );
    expect(createResponse.ok).toBe(true);
    const created = createResponse.data as { id: string; number: string; status: string };
    expect(created.status).toBe("QUEUED");
    const runId = created.id;

    // run.getDetail serves the real Run: the queue was woken by run.create, so
    // the serial executor already claimed it and appended the first stage.
    const detailResponse = await handler.handle(queryEnvelope("run.getDetail", { runId }));
    expect(detailResponse.ok).toBe(true);
    const detail = detailResponse.data as { run: { status: string; stage: string | null }; events: unknown[] };
    expect(detail.run.status).toBe("RUNNING");
    expect(detail.run.stage).toBe("PREPARING");
    expect(detail.events.length).toBeGreaterThanOrEqual(3);

    // run.list includes the Run.
    const listResponse = await handler.handle(queryEnvelope("run.list", {}));
    expect(listResponse.ok).toBe(true);
    const list = listResponse.data as Array<{ runId: string; runLabel: string; status: string }>;
    expect(list.some((item) => item.runId === runId)).toBe(true);
    expect(list[0]?.runLabel).toBe(created.number);

    // The dashboard surfaces the RUNNING Run and the queue.
    const dashboardResponse = await handler.handle(queryEnvelope("workspace.getDashboard", {}));
    expect(dashboardResponse.ok).toBe(true);
    const dashboard = dashboardResponse.data as { currentRun: { runId: string } | null };
    expect(dashboard.currentRun?.runId).toBe(runId);

    // Draining the queue completes the Run through all six stages.
    await drainScheduler(scheduler);
    const completedResponse = await handler.handle(queryEnvelope("run.getDetail", { runId }));
    expect(completedResponse.ok).toBe(true);
    const completed = completedResponse.data as {
      run: { status: string; stage: string | null; completedAt: string | null };
      events: Array<{ type: string }>;
      lastEventSequence: number;
    };
    expect(completed.run.status).toBe("COMPLETED");
    expect(completed.run.stage).toBeNull();
    expect(completed.lastEventSequence).toBe(completed.events.length);
    expect(completed.events.at(-1)?.type).toBe("Completed");
  });

  it("serves model.getDetail and model.review through the Runner (Phase 6)", async () => {
    const { handler, runner, root, scheduler } = newHandler();
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-MODEL");
    const createResponse = await handler.handle(
      commandEnvelope("run.create", { command: "run.create", drawingId, revisionId })
    );
    expect(createResponse.ok).toBe(true);
    const runId = (createResponse.data as { id: string }).id;
    // Draining the queue completes the Run and the Runner's default
    // `publishModel: true` publishes a PENDING_REVIEW Model atomically.
    await drainScheduler(scheduler);

    const completed = (await handler.handle(queryEnvelope("run.getDetail", { runId }))).data as {
      run: { status: string; modelId: string | null };
    };
    expect(completed.run.status).toBe("COMPLETED");
    expect(completed.run.modelId).toBeTypeOf("string");
    const modelId = completed.run.modelId as string;

    // model.getDetail serves the freshly published PENDING_REVIEW Model with
    // its artifact metadata rows and an empty review history.
    const detailResponse = await handler.handle(queryEnvelope("model.getDetail", { modelId }));
    expect(detailResponse.ok).toBe(true);
    const detail = detailResponse.data as {
      model: {
        modelId: string;
        modelLabel: string;
        reviewStatus: string;
        isCurrentApproved: boolean;
        productionVerified: boolean;
      };
      artifacts: unknown[];
      reviews: unknown[];
    };
    expect(detail.model.modelId).toBe(modelId);
    expect(detail.model.modelLabel).toBe("M01");
    expect(detail.model.reviewStatus).toBe("PENDING_REVIEW");
    expect(detail.model.isCurrentApproved).toBe(false);
    expect(detail.model.productionVerified).toBe(false);
    expect(detail.artifacts.length).toBeGreaterThan(0);
    expect(detail.reviews).toEqual([]);

    // The dashed pending-review queue surfaces the untouched Model...
    const pending = (await handler.handle(queryEnvelope("workspace.getDashboard", {}))).data as {
      pendingReviews: Array<{ modelId: string; revisionLabel: string; modelLabel: string }>;
    };
    expect(pending.pendingReviews.some((item) => item.modelId === modelId)).toBe(true);
    expect(pending.pendingReviews[0]).toMatchObject({ modelId, modelLabel: "M01", revisionLabel: "V1" });

    // ...and the Revision detail lists it as not-yet current approved.
    const revisionItems = (await handler.handle(
      queryEnvelope("revision.getDetail", { drawingId, revisionId })
    )).data as { models: Array<{ modelId: string; isCurrentApproved: boolean }> };
    expect(revisionItems.models[0]).toMatchObject({ modelId, isCurrentApproved: false });

    // model.review APPROVED repoints the Revision's approved-Model pointer.
    const reviewResponse = await handler.handle(
      commandEnvelope("model.review", {
        command: "model.review",
        modelId,
        result: "APPROVED",
        reviewerId: "alice",
        reviewedAt: "2026-08-13T10:00:00.000Z"
      })
    );
    expect(reviewResponse.ok).toBe(true);
    const reviewed = reviewResponse.data as {
      model: { reviewStatus: string; isCurrentApproved: boolean };
      reviews: Array<{ reviewId: string; result: string; reviewerId: string; comment: string | null }>;
    };
    expect(reviewed.model.reviewStatus).toBe("APPROVED");
    expect(reviewed.model.isCurrentApproved).toBe(true);
    expect(reviewed.reviews).toHaveLength(1);
    expect(reviewed.reviews[0]).toMatchObject({ result: "APPROVED", reviewerId: "alice" });

    // The approved Model leaves the pending-review queue and becomes the
    // Revision's current approved Model.
    const afterPending = (await handler.handle(queryEnvelope("workspace.getDashboard", {}))).data as {
      pendingReviews: unknown[];
    };
    expect(afterPending.pendingReviews).toEqual([]);
    const afterRevision = (await handler.handle(
      queryEnvelope("revision.getDetail", { drawingId, revisionId })
    )).data as { models: Array<{ modelId: string; isCurrentApproved: boolean }> };
    expect(afterRevision.models[0]).toMatchObject({ modelId, isCurrentApproved: true });

    // A Model is reviewed exactly once: a second review is DOMAIN_INVARIANT
    // (the persisted status is no longer PENDING_REVIEW).
    const double = await handler.handle(
      commandEnvelope("model.review", {
        command: "model.review",
        modelId,
        result: "REJECTED",
        comment: "再来一次",
        reviewerId: "bob",
        reviewedAt: "2026-08-13T10:05:00.000Z"
      })
    );
    expect(double.ok).toBe(false);
    expect(double.error?.code).toBe("DOMAIN_INVARIANT");
  });

  it("keeps run.create idempotent under a repeated idempotencyKey (server dispatch)", async () => {
    const { handler, runner, root } = newHandler();
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-IDEM");
    // The idempotency cache lives at the IPC server boundary (dispatch), so the
    // repeated command must be routed through the real server entry point.
    const server = new IpcServer(handler, {
      pipePath: "\\\\.\\pipe\\swpanel.test.handler",
      platform: "win32"
    });
    try {
      const envelope = commandEnvelope(
        "run.create",
        { command: "run.create", drawingId, revisionId },
        "c-1",
        "intent:create-same-pair"
      );
      const first = await server.dispatch(envelope);
      const second = await server.dispatch({ ...envelope, requestId: "c-2" });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const firstData = first.data as { id: string };
      const secondData = second.data as { id: string };
      expect(secondData.id).toBe(firstData.id);
      const list = (await handler.handle(queryEnvelope("run.list", {}))).data as Array<{
        runId: string;
      }>;
      expect(list.filter((item) => item.runId === firstData.id)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("cancels a QUEUED Run through run.cancel and is stable on repeats", async () => {
    const { handler, runner, root } = newHandler();
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-CANCEL");
    // Create the Run through the facade WITHOUT waking the queue, so it stays
    // QUEUED and the atomic queued-cancellation path applies.
    const run = runner.createRun({ drawingId, revisionId });
    expect(run.status).toBe("QUEUED");

    const cancelResponse = await handler.handle(
      commandEnvelope("run.cancel", {
        command: "run.cancel",
        runId: run.id,
        reason: "用户取消"
      })
    );
    expect(cancelResponse.ok).toBe(true);
    expect(cancelResponse.data).toEqual({
      runId: run.id,
      status: "CANCELLED",
      alreadyCancelled: false
    });
    const cancelled = (await handler.handle(queryEnvelope("run.getDetail", { runId: run.id })))
      .data as { run: { status: string }; events: Array<{ type: string }> };
    expect(cancelled.run.status).toBe("CANCELLED");
    expect(cancelled.events.map((event) => event.type)).toEqual([
      "CancellationRequested",
      "CancellationConfirmed"
    ]);

    // A repeated cancel is stable (alreadyCancelled), never an error.
    const repeat = await handler.handle(
      commandEnvelope("run.cancel", { command: "run.cancel", runId: run.id })
    );
    expect(repeat.ok).toBe(true);
    expect(repeat.data).toEqual({
      runId: run.id,
      status: "CANCELLED",
      alreadyCancelled: true
    });
  });

  it("cancels a RUNNING Run through run.cancel (cooperative abort + confirm)", async () => {
    const { handler, runner, root, scheduler } = newHandler();
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-CANCL2");
    // run.create wakes the queue: the Run is claimed synchronously (RUNNING).
    const createResponse = await handler.handle(
      commandEnvelope("run.create", { command: "run.create", drawingId, revisionId })
    );
    expect(createResponse.ok).toBe(true);
    const runId = (createResponse.data as { id: string }).id;
    const running = (await handler.handle(queryEnvelope("run.getDetail", { runId }))).data as {
      run: { status: string };
    };
    expect(running.run.status).toBe("RUNNING");

    // The cancel persists CancellationRequested, signals the cooperative abort
    // and waits (bounded) for the claim to stop; the manual scheduler must be
    // flushed for the claim to observe the signal.
    const cancelPromise = handler.handle(
      commandEnvelope("run.cancel", { command: "run.cancel", runId, reason: "用户取消" })
    );
    scheduler.flushAll();
    const cancelResponse = await cancelPromise;
    expect(cancelResponse.ok).toBe(true);
    expect(cancelResponse.data).toEqual({
      runId,
      status: "CANCELLED",
      alreadyCancelled: false
    });
    const cancelled = (await handler.handle(queryEnvelope("run.getDetail", { runId }))).data as {
      run: { status: string };
    };
    expect(cancelled.run.status).toBe("CANCELLED");
  });

  it("cancels an unknown Run with a structured NOT_FOUND", async () => {
    const { handler } = newHandler();
    const response = await handler.handle(
      commandEnvelope("run.cancel", { command: "run.cancel", runId: "does-not-exist" })
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("NOT_FOUND");
  });

  it("serves clarification.get/submit on a CLARIFICATION_REQUIRED Run without resuming it", async () => {
    const { handler, runner, root, scheduler } = newHandler({ scenario: "clarification" });
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-CLAR");
    const createResponse = await handler.handle(
      commandEnvelope("run.create", { command: "run.create", drawingId, revisionId })
    );
    expect(createResponse.ok).toBe(true);
    const runId = (createResponse.data as { id: string }).id;
    // Drain the queue: the clarification scenario walks three stages then
    // persists the OPEN request + ClarificationRequired event atomically.
    await drainScheduler(scheduler);

    const runDetail = (await handler.handle(queryEnvelope("run.getDetail", { runId }))).data as {
      run: { status: string; clarificationRequestId: string | null };
    };
    expect(runDetail.run.status).toBe("CLARIFICATION_REQUIRED");
    const requestId = runDetail.run.clarificationRequestId as string;
    expect(requestId).toBeTypeOf("string");

    const getResponse = await handler.handle(
      queryEnvelope("clarification.get", { clarificationRequestId: requestId })
    );
    expect(getResponse.ok).toBe(true);
    const view = getResponse.data as {
      status: string;
      questions: Array<{
        questionId: string;
        type: string;
        options: Array<{ id: string; label: string }>;
      }>;
    };
    expect(view.status).toBe("OPEN");
    // Question ids are minted by the Runner (never the caller's), types keep
    // the deterministic scenario shape.
    expect(view.questions.map((question) => question.type)).toEqual(["dimension", "choice"]);
    const dimensionQuestionId = view.questions[0]?.questionId as string;
    const choiceQuestion = view.questions[1] as {
      questionId: string;
      options: Array<{ id: string; label: string }>;
    };
    // Option ids are minted too; the deterministic scenario order is
    // [无需焊缝, 全周满焊] — the second option is the full-weld choice.
    const fullWeldOptionId = choiceQuestion.options[1]?.id as string;

    // Submit answers: they persist and the request becomes ANSWERED.
    const submitResponse = await handler.handle(
      commandEnvelope("clarification.submit", {
        command: "clarification.submit",
        clarificationRequestId: requestId,
        answers: [
          {
            id: "renderer-ans-1",
            questionId: dimensionQuestionId,
            value: { kind: "dimension", value: 12, unit: "mm" },
            answeredAt: "2026-08-13T01:00:00.000Z",
            answeredBy: "alice"
          },
          {
            id: "renderer-ans-2",
            questionId: choiceQuestion.questionId,
            value: { kind: "choice", optionId: fullWeldOptionId },
            answeredAt: "2026-08-13T01:00:00.000Z",
            answeredBy: "alice"
          }
        ],
        answeredAt: "2026-08-13T01:00:00.000Z",
        answeredBy: "alice"
      })
    );
    expect(submitResponse.ok).toBe(true);
    const answered = submitResponse.data as {
      status: string;
      answers: Array<{ answerId: string; questionId: string }>;
    };
    expect(answered.status).toBe("ANSWERED");
    expect(answered.answers).toHaveLength(2);
    // Answer ids are minted by the Runner, never trusted from the renderer.
    expect(answered.answers[0]?.answerId).not.toBe("renderer-ans-1");

    // The old Run stays terminal CLARIFICATION_REQUIRED — answers never resume it.
    const afterSubmit = (await handler.handle(queryEnvelope("run.getDetail", { runId }))).data as {
      run: { status: string };
      lastEventSequence: number;
    };
    expect(afterSubmit.run.status).toBe("CLARIFICATION_REQUIRED");

    // A second submit of DIFFERENT answers is honestly rejected (already ANSWERED).
    const resubmit = await handler.handle(
      commandEnvelope("clarification.submit", {
        command: "clarification.submit",
        clarificationRequestId: requestId,
        answers: [
          {
            id: "renderer-ans-3",
            questionId: dimensionQuestionId,
            value: { kind: "dimension", value: 20, unit: "mm" },
            answeredAt: "2026-08-13T02:00:00.000Z",
            answeredBy: "alice"
          }
        ],
        answeredAt: "2026-08-13T02:00:00.000Z",
        answeredBy: "alice"
      })
    );
    expect(resubmit.ok).toBe(false);
    expect(resubmit.error?.code).toBe("DOMAIN_INVARIANT");
  });

  it("cancels a QUEUED Run while another Run of the same Runner is RUNNING (B1)", async () => {
    const { handler, runner, root, scheduler } = newHandler();
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-B1");
    // First Run: claimed by the woken queue (RUNNING, single-active slot,
    // execution attempt of this owner).
    const firstCreate = (await handler.handle(
      commandEnvelope("run.create", { command: "run.create", drawingId, revisionId })
    )).data as { id: string };
    const firstDetail = (await handler.handle(queryEnvelope("run.getDetail", { runId: firstCreate.id })))
      .data as { run: { status: string } };
    expect(firstDetail.run.status).toBe("RUNNING");

    // Second Run: stays QUEUED. Its queued cancellation must SUCCEED even
    // though this Runner still holds the unfinished EXECUTION attempt of the
    // first Run (the cancellation-scoped attempt is kind CANCELLATION and the
    // one-active-per-owner index is execution-scoped).
    const secondCreate = (await handler.handle(
      commandEnvelope("run.create", { command: "run.create", drawingId, revisionId })
    )).data as { id: string };
    const secondDetail = (await handler.handle(queryEnvelope("run.getDetail", { runId: secondCreate.id })))
      .data as { run: { status: string } };
    expect(secondDetail.run.status).toBe("QUEUED");

    const cancelResponse = await handler.handle(
      commandEnvelope("run.cancel", {
        command: "run.cancel",
        runId: secondCreate.id,
        reason: "用户取消"
      })
    );
    expect(cancelResponse.ok).toBe(true);
    expect(cancelResponse.data).toEqual({
      runId: secondCreate.id,
      status: "CANCELLED",
      alreadyCancelled: false
    });
    // Atomic CANCELLED history with the mandatory event attemptId: the
    // cancellation pair references the minted cancellation-scoped attempt.
    const cancelled = (await handler.handle(queryEnvelope("run.getDetail", { runId: secondCreate.id })))
      .data as { run: { status: string }; events: Array<{ type: string; attemptId: string }> };
    expect(cancelled.run.status).toBe("CANCELLED");
    expect(cancelled.events.map((event) => event.type)).toEqual([
      "CancellationRequested",
      "CancellationConfirmed"
    ]);
    expect(cancelled.events[0]?.attemptId).toBeTypeOf("string");
    expect(cancelled.events[1]?.attemptId).toBe(cancelled.events[0]?.attemptId);

    // The RUNNING Run is untouched and still finishes normally.
    const stillRunning = (await handler.handle(queryEnvelope("run.getDetail", { runId: firstCreate.id })))
      .data as { run: { status: string } };
    expect(stillRunning.run.status).toBe("RUNNING");
    await drainScheduler(scheduler);
    const completed = (await handler.handle(queryEnvelope("run.getDetail", { runId: firstCreate.id })))
      .data as { run: { status: string } };
    expect(completed.run.status).toBe("COMPLETED");
  });

  it("cancels a QUEUED Run over the live wire while another Run is RUNNING (B1 IPC regression)", async () => {
    const { handler, runner, root } = newHandler();
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-B1WIRE");
    const server = new IpcServer(handler, {
      pipePath: "\\\\.\\pipe\\swpanel.test.handler-wire",
      platform: "win32"
    });
    try {
      const client = new WireClient(server);
      await client.next(); // handshake

      const create = (requestId: string): void => {
        client.write(commandEnvelope("run.create", { command: "run.create", drawingId, revisionId }, requestId));
      };
      create("create-1");
      const createdA = (await client.next()) as IpcResponseEnvelope;
      expect(createdA.ok).toBe(true);
      create("create-2");
      const createdB = (await client.next()) as IpcResponseEnvelope;
      expect(createdB.ok).toBe(true);
      const runA = (createdA.data as { id: string }).id;
      const runB = (createdB.data as { id: string }).id;
      expect(runA).not.toBe(runB);

      const detailA = (await handler.handle(queryEnvelope("run.getDetail", { runId: runA })))
        .data as { run: { status: string } };
      const detailB = (await handler.handle(queryEnvelope("run.getDetail", { runId: runB })))
        .data as { run: { status: string } };
      expect(detailA.run.status).toBe("RUNNING");
      expect(detailB.run.status).toBe("QUEUED");

      // run.cancel of the QUEUED Run over the wire (validation + dispatch +
      // the B1 cancellation-scoped attempt redesign).
      client.write(commandEnvelope("run.cancel", { command: "run.cancel", runId: runB }));
      const cancelResponse = (await client.next()) as IpcResponseEnvelope;
      expect(cancelResponse.ok).toBe(true);
      expect(cancelResponse.data).toEqual({ runId: runB, status: "CANCELLED", alreadyCancelled: false });
    } finally {
      await server.close();
    }
  });

  it("serves a NOT_FOUND clarification.get for unknown requests", async () => {
    const { handler } = newHandler();
    const response = await handler.handle(
      queryEnvelope("clarification.get", { clarificationRequestId: "missing" })
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("NOT_FOUND");
  });

  it("updates storage settings through the storage.updateSettings command", async () => {
    const { handler, runner } = newHandler();
    const dataRoot = runner.getStorageSettings().settings.dataRoot;
    const response = await handler.handle(
      commandEnvelope("storage.updateSettings", {
        command: "storage.updateSettings",
        settings: {
          dataRoot,
          workspaceRoot: join(dataRoot, "workspaces"),
          constraint: "LOCAL_FIXED_NTFS",
          updatedAt: "2026-08-12T02:00:00.000Z"
        }
      })
    );
    expect(response.ok).toBe(true);
    expect((response.data as { settings: { workspaceRoot: string } }).settings.workspaceRoot).toBe(
      join(dataRoot, "workspaces")
    );
  });

  it("deletes a non-current Revision through drawing.deleteRevision and refreshes history", async () => {
    const { handler, runner, root } = newHandler();
    const sourcePath = join(root, "sources", "del-handler.pdf");
    writeFileSync(sourcePath, samplePdfBytes());
    runner.registerSourceFile(sha256Of(samplePdfBytes()), sourcePath);
    const createResponse = await handler.handle(
      commandEnvelope("drawing.create", {
        command: "drawing.create",
        drawingNumber: "PDJF-DELH",
        name: "Handler deletion",
        sourceFile: {
          fileName: "del-handler.pdf",
          format: "PDF",
          sizeBytes: samplePdfBytes().length,
          sha256: sha256Of(samplePdfBytes())
        },
        createdAt: "2026-08-12T01:00:00.000Z"
      })
    );
    expect(createResponse.ok).toBe(true);
    const created = createResponse.data as { drawing: { id: string }; revision: { id: string } };

    // The first Revision is the current one: deleting it must be refused with a
    // structured DOMAIN_INVARIANT error (current-pointer protection).
    const refused = await handler.handle(
      commandEnvelope("drawing.deleteRevision", {
        command: "drawing.deleteRevision",
        drawingId: created.drawing.id,
        revisionId: created.revision.id,
        updatedAt: "2026-08-12T02:00:00.000Z"
      })
    );
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("DOMAIN_INVARIANT");

    // A second (non-current) Revision deletes cleanly; history refreshes to 1.
    const sourcePath2 = join(root, "sources", "del-handler-v2.dwg");
    writeFileSync(sourcePath2, Buffer.from("dwg-v2"));
    runner.registerSourceFile(sha256Of(Buffer.from("dwg-v2")), sourcePath2);
    const addResponse = await handler.handle(
      commandEnvelope("drawing.createRevision", {
        command: "drawing.createRevision",
        drawingId: created.drawing.id,
        sourceFile: {
          fileName: "del-handler-v2.dwg",
          format: "DWG",
          sizeBytes: Buffer.from("dwg-v2").length,
          sha256: sha256Of(Buffer.from("dwg-v2"))
        },
        createdAt: "2026-08-12T02:10:00.000Z"
      })
    );
    expect(addResponse.ok).toBe(true);
    const added = addResponse.data as { revision: { id: string } };

    const deleted = await handler.handle(
      commandEnvelope("drawing.deleteRevision", {
        command: "drawing.deleteRevision",
        drawingId: created.drawing.id,
        revisionId: added.revision.id,
        updatedAt: "2026-08-12T02:20:00.000Z"
      })
    );
    expect(deleted.ok).toBe(true);
    expect(deleted.data).toMatchObject({ deletedRevisionId: added.revision.id });

    const historyResponse = await handler.handle(
      queryEnvelope("drawing.getHistory", { drawingId: created.drawing.id })
    );
    expect(historyResponse.ok).toBe(true);
    expect((historyResponse.data as { revisions: unknown[] }).revisions).toHaveLength(1);

    // Replaying the same delete is a structured NOT_FOUND, never a crash.
    const replay = await handler.handle(
      commandEnvelope("drawing.deleteRevision", {
        command: "drawing.deleteRevision",
        drawingId: created.drawing.id,
        revisionId: added.revision.id,
        updatedAt: "2026-08-12T02:21:00.000Z"
      })
    );
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("NOT_FOUND");
  });

  it("serves system.getRecoveryStatus with a zeroed summary on a clean root", async () => {
    const { handler } = newHandler();
    // The Runner always runs a recovery scan at open(); with no persisted Runs
    // the summary is a zeroed (non-null) result.
    const response = await handler.handle(
      commandEnvelope("system.getRecoveryStatus", { command: "system.getRecoveryStatus" })
    );
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({
      scanTime: expect.any(String) as string,
      totalActiveChecked: 0,
      resumedCount: 0,
      failedCount: 0,
      unsupportedCount: 0,
      skippedCount: 0
    });
  });

  it("serves system.getRecoveryStatus with the mapped summary of an expired-lease scan", async () => {
    const { handler, runner, root, scheduler } = newHandler();
    const { drawingId, revisionId } = await importDrawing(handler, runner, root, "PDJF-RECOV");
    // Claim a QUEUED Run directly (no stage events appended), so the
    // expired-lease recovery scan classifies the attempt RECOVERY_UNSUPPORTED
    // under the default conservative recovery capability (the `success`
    // scenario never proves safe resumption).
    const run = runner.createRun({ drawingId, revisionId });
    const claim = runner.claimNextQueuedRun();
    expect(claim?.runId).toBe(run.id);
    scheduler.advance(61_000); // past the default 60s lease
    const scan = runner.recoverExpiredAttempts();
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]?.outcome).toBe("RECOVERY_UNSUPPORTED");

    const response = await handler.handle(
      commandEnvelope("system.getRecoveryStatus", { command: "system.getRecoveryStatus" })
    );
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      scanTime: scan.scannedAt,
      totalActiveChecked: 1,
      resumedCount: 0,
      failedCount: 0,
      unsupportedCount: 1,
      skippedCount: 0
    });
  });

  it("echos the requestId on every response", async () => {
    const { handler } = newHandler();
    const response = await handler.handle(queryEnvelope("storage.getSettings", {}, "my-request"));
    expect(response.requestId).toBe("my-request");
    expect(response.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
  });
});
