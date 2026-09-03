import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 3 browser E2E (Batch P3-6): drives the PRODUCT-mode Run UI end to end
 * through an EXPLICIT fake `window.swpanel` bridge installed before the
 * renderer boots (same pattern as `phase2.browser.spec.ts`). The fake bridge
 * is fully self-contained, implements the frozen Phase 3 bridge surface
 * (`runs.*`, `clarifications.*` + the drawing surface) and simulates the
 * Runner's serial queue semantics with deterministic scripted events.
 *
 * The scenario controls live ONLY on `window.__swpanelFake` (a test-only hook
 * never rendered by the product UI): the pages under test consume the real
 * bridge API and never expose a "fake scenario selector" — the spec asserts
 * that explicitly.
 *
 * Covered Exit-Gate behaviors:
 * - product-mode run confirmation/create (identity pair only, no snapshot
 *   smuggling) and QUEUED display;
 * - queue/current transitions driven by live events;
 * - all six stages walked live;
 * - model-less COMPLETED (Phase 3 contract decision);
 * - CLARIFICATION_REQUIRED with submit + new-run guidance (old Run stays
 *   terminal, a NEW Run is created);
 * - FAILED / artifact-validation UI;
 * - queued + running cancel outcomes, including CANCEL_CLEANUP_PENDING and
 *   CANCEL_PENDING (foreign live lease);
 * - live events, duplicate ignore, gap/lost refetch + resubscribe from the
 *   last sequence, unsubscribe / route-remount reconnect.
 */

const viewport = { width: 1366, height: 768 };

// ---------------------------------------------------------------------------
// Seed types (plain data, serialized into the page)
// ---------------------------------------------------------------------------

interface FakeEventSeed {
  sequence: number;
  type: string;
  occurredAt: string;
  [key: string]: unknown;
}

interface FakeClarificationSeed {
  clarificationRequestId: string;
  runId: string;
  revisionId: string;
  status: "OPEN" | "ANSWERED";
  createdAt: string;
  questions: {
    questionId: string;
    type: "dimension" | "text" | "choice";
    question: string;
    hint: string | null;
    unit: string | null;
    options: readonly { id: string; label: string }[];
  }[];
  answers: readonly {
    answerId: string;
    questionId: string;
    value: unknown;
    answeredAt: string;
  }[];
}

interface FakeRunSeed {
  runId: string;
  runLabel: string;
  drawingId: string;
  revisionId: string;
  status: string;
  stage: string | null;
  activity: string | null;
  progressPercent: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  modelId: string | null;
  clarificationRequestId: string | null;
  events: FakeEventSeed[];
  clarifications?: FakeClarificationSeed[];
}

interface FakeInitRevision {
  id: string;
  sequence: number;
  fileName: string;
  uploadedAt: string;
}

interface FakeInitDrawing {
  id: string;
  drawingNumber: string;
  name: string;
  currentRevisionId?: string;
  createdAt: string;
  updatedAt: string;
  revisions: FakeInitRevision[];
}

interface FakeInitOptions {
  seed: FakeInitDrawing[];
  settings: { dataRoot: string; workspaceRoot: string; constraint: string; updatedAt: string };
  runs: FakeRunSeed[];
  fail: string[];
}

// ---------------------------------------------------------------------------
// Event script builders (Node side; produce plain JSON for the fake bridge)
// ---------------------------------------------------------------------------

const STAGE_ACTIVITIES: Readonly<Record<string, string>> = {
  PREPARING: "准备建模任务",
  ANALYZING: "分析图纸",
  PLANNING: "规划建模方案",
  MODELING: "SolidWorks 建模中",
  VALIDATING: "校验模型",
  PACKAGING: "生成结果"
};

const ALL_STAGES = ["PREPARING", "ANALYZING", "PLANNING", "MODELING", "VALIDATING", "PACKAGING"] as const;

const BASE_TIME = "2026-08-13T06:00:00.000Z";

/** One StageChanged + ActivityUpdated + ProgressUpdated trio for one stage. */
function stageTrio(runId: string, attemptId: string, sequence: number, stage: (typeof ALL_STAGES)[number], time: string): FakeEventSeed[] {
  const activity = STAGE_ACTIVITIES[stage] ?? stage;
  const progressPercent = Math.round(((ALL_STAGES.indexOf(stage) + 1) / ALL_STAGES.length) * 100);
  return [
    { sequence, type: "StageChanged", stage, activity, occurredAt: time },
    { sequence: sequence + 1, type: "ActivityUpdated", activity, occurredAt: time },
    {
      sequence: sequence + 2,
      type: "ProgressUpdated",
      progressPercent,
      activity,
      occurredAt: time
    }
  ];
}

function successScript(runId: string, attemptId: string, startAt: number): FakeEventSeed[] {
  const events: FakeEventSeed[] = [];
  let seq = 1;
  ALL_STAGES.forEach((stage, index) => {
    events.push(
      ...stageTrio(
        runId,
        attemptId,
        seq,
        stage,
        new Date(startAt + index * 60_000).toISOString()
      )
    );
    seq += 3;
  });
  events.push({
    sequence: seq,
    type: "Completed",
    occurredAt: new Date(startAt + ALL_STAGES.length * 60_000).toISOString()
  });
  return events;
}

function runningScript(runId: string, attemptId: string, startAt: number): FakeEventSeed[] {
  return stageTrio(runId, attemptId, 1, "PREPARING", new Date(startAt).toISOString());
}

// ---------------------------------------------------------------------------
// Fake bridge (installed BEFORE the app loads; must be fully self-contained)
// ---------------------------------------------------------------------------

function installFakeBridge(init: FakeInitOptions) {
  const ok = (data: unknown) => ({ ok: true, data });
  const fail = (code: string, message: string) => ({ ok: false, error: { code, message } });
  const calls: string[] = [];
  const failures = new Set(init.fail);
  const subscribeCalls: Array<{ runId: string; fromSequence: number }> = [];
  const unsubscribeCalls: Array<{ runId: string }> = [];
  const getDetailCalls: Record<string, number> = {};
  const deliveryCounts: Record<string, number> = {};
  const heldRuns = new Set<string>();
  const pendingGetDetail: Record<string, Array<{ resolve: (value: unknown) => void }>> = {};
  const lastBatch: Record<string, FakeEventSeed[]> = {};
  const cancelOutcomes: Record<string, "cancelled" | "cleanup-failed" | "cancel-pending"> = {};

  interface FakeRun {
    runId: string;
    runLabel: string;
    drawingId: string;
    revisionId: string;
    status: string;
    stage: string | null;
    activity: string | null;
    progressPercent: number | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    modelId: string | null;
    clarificationRequestId: string | null;
    events: FakeEventSeed[];
  }

  /** Plain alias of the clarification seed (no member changes). */
  type FakeClarification = FakeClarificationSeed;

  const runs = new Map<string, FakeRun>();
  const clarifications = new Map<string, FakeClarification>();
  const subscribers = new Map<string, Set<(push: unknown) => void>>();

  const state = {
    drawings: [] as Array<{ id: string; drawingNumber: string; name: string; currentRevisionId: string | null; createdAt: string; updatedAt: string }>,
    revisions: [] as Array<{ id: string; drawingId: string; sequence: number; fileName: string; uploadedAt: string }>,
    settings: { ...init.settings }
  };

  for (const seed of init.runs) {
    runs.set(seed.runId, {
      runId: seed.runId,
      runLabel: seed.runLabel,
      drawingId: seed.drawingId,
      revisionId: seed.revisionId,
      status: seed.status,
      stage: seed.stage,
      activity: seed.activity,
      progressPercent: seed.progressPercent,
      createdAt: seed.createdAt,
      startedAt: seed.startedAt,
      completedAt: seed.completedAt,
      failureCode: seed.failureCode,
      failureMessage: seed.failureMessage,
      modelId: seed.modelId,
      clarificationRequestId: seed.clarificationRequestId,
      events: [...seed.events]
    });
    for (const clarification of seed.clarifications ?? []) {
      clarifications.set(clarification.clarificationRequestId, {
        ...clarification,
        answers: [...clarification.answers]
      });
    }
  }

  for (const seed of init.seed) {
    state.drawings.push({
      id: seed.id,
      drawingNumber: seed.drawingNumber,
      name: seed.name,
      currentRevisionId: seed.currentRevisionId ?? seed.revisions.at(-1)?.id ?? null,
      createdAt: seed.createdAt,
      updatedAt: seed.updatedAt
    });
    for (const revisionSeed of seed.revisions) {
      state.revisions.push({
        id: revisionSeed.id,
        drawingId: seed.id,
        sequence: revisionSeed.sequence,
        fileName: revisionSeed.fileName,
        uploadedAt: revisionSeed.uploadedAt
      });
    }
  }

  const revisionLabel = (sequence: number) => `V${sequence}`;

  const findDrawing = (drawingId: string) => {
    const drawing = state.drawings.find((candidate) => candidate.id === drawingId);
    if (drawing === undefined) {
      throw Object.assign(new Error(`drawing ${drawingId} not found`), { code: "NOT_FOUND" });
    }
    return drawing;
  };
  const findRevision = (revisionId: string) => {
    const revision = state.revisions.find((candidate) => candidate.id === revisionId);
    if (revision === undefined) {
      throw Object.assign(new Error(`revision ${revisionId} not found`), { code: "NOT_FOUND" });
    }
    return revision;
  };

  /** Projects ONE event onto the fake Run state (mirrors the Runner projection). */
  function project(run: FakeRun, event: FakeEventSeed): void {
    switch (event.type) {
      case "StageChanged":
        if (run.status === "QUEUED") {
          run.status = "RUNNING";
          run.startedAt = run.startedAt ?? event.occurredAt;
        }
        run.stage = event.stage as string;
        if (event.activity !== undefined) run.activity = event.activity as string;
        break;
      case "ActivityUpdated":
        run.activity = event.activity as string;
        break;
      case "ProgressUpdated":
        run.progressPercent = event.progressPercent as number;
        if (event.activity !== undefined) run.activity = event.activity as string;
        break;
      case "ClarificationRequired":
        run.status = "CLARIFICATION_REQUIRED";
        run.clarificationRequestId = event.clarificationRequestId as string;
        finish(run, event.occurredAt);
        break;
      case "Completed":
        run.status = "COMPLETED";
        if (event.modelId !== undefined) run.modelId = event.modelId as string;
        finish(run, event.occurredAt);
        break;
      case "Failed":
        run.status = "FAILED";
        run.failureCode = event.failureCode as string;
        if (event.failureMessage !== undefined) run.failureMessage = event.failureMessage as string;
        finish(run, event.occurredAt);
        break;
      case "CancellationRequested":
        break;
      case "CancellationConfirmed":
        run.status = "CANCELLED";
        finish(run, event.occurredAt);
        break;
      default:
        break;
    }
  }

  /** Terminal projection of the REAL read model (F3): record completed_at and
   *  clear the live execution fields — the walked history lives in the events. */
  function finish(run: FakeRun, occurredAt: string): void {
    run.completedAt = occurredAt;
    run.stage = null;
    run.activity = null;
    run.progressPercent = null;
  }

  function toListItem(run: FakeRun) {
    return {
      runId: run.runId,
      runLabel: run.runLabel,
      status: run.status,
      stage: run.stage,
      createdAt: run.createdAt,
      modelId: run.modelId,
      clarificationRequestId: run.clarificationRequestId,
      failureCode: run.failureCode
    };
  }

  function toDetail(run: FakeRun) {
    return {
      run: {
        runId: run.runId,
        runLabel: run.runLabel,
        drawingId: run.drawingId,
        revisionId: run.revisionId,
        status: run.status,
        stage: run.stage,
        activity: run.activity,
        progressPercent: run.progressPercent,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failureCode: run.failureCode,
        failureMessage: run.failureMessage,
        modelId: run.modelId,
        clarificationRequestId: run.clarificationRequestId
      },
      // Fresh copies, like the real bridge's IPC serialization: the renderer's
      // snapshot must never share an array with the fake's live state.
      events: [...run.events],
      lastEventSequence: run.events.length === 0 ? 0 : run.events[run.events.length - 1]?.sequence ?? 0
    };
  }

  function deliver(runId: string, push: unknown): void {
    deliveryCounts[runId] = (deliveryCounts[runId] ?? 0) + 1;
    const set = subscribers.get(runId);
    if (set === undefined) return;
    for (const onPush of set) onPush(push);
  }

  /** Structured bridge failure instead of a synchronous throw (real-bridge parity). */
  const guard = (build: () => unknown) => {
    try {
      return ok(build());
    } catch (error) {
      const code = error instanceof Object && "code" in error ? String(error.code) : "INTERNAL";
      return fail(code, error instanceof Error ? error.message : String(error));
    }
  };

  /** Envelopes + appends payloads, projects state, delivers one batch. */
  function pushEvents(runId: string, payloads: Array<Record<string, unknown>>): FakeEventSeed[] {
    const run = runs.get(runId);
    if (run === undefined) throw new Error(`run ${runId} not found`);
    const nextSequence = (run.events.at(-1)?.sequence ?? 0) + 1;
    const created: FakeEventSeed[] = [];
    payloads.forEach((payload, index) => {
      const event: FakeEventSeed = {
        sequence: nextSequence + index,
        type: payload.type as string,
        occurredAt: payload.occurredAt as string,
        ...payload
      };
      run.events.push(event);
      created.push(event);
      project(run, event);
    });
    lastBatch[runId] = created;
    deliver(runId, {
      kind: "runEvents",
      runId,
      fromSequence: nextSequence,
      events: created
    });
    return created;
  }

  const api = Object.freeze({
    metadata: Object.freeze({ platform: "test", versions: Object.freeze({ chrome: "1", electron: "1" }) }),
    health: Object.freeze({
      get: () => Promise.resolve(ok({ status: "READY", serverInstanceId: "fake", error: null }))
    }),
    files: Object.freeze({
      selectDrawingFile: () => Promise.resolve(ok({ canceled: true, file: null }))
    }),
    drawings: Object.freeze({
      list: () => {
        calls.push("drawings.list");
        const items = state.drawings
          .map((drawing) => {
            const revisions = state.revisions.filter((revision) => revision.drawingId === drawing.id);
            const current = revisions.find((revision) => revision.id === drawing.currentRevisionId);
            const latest = revisions.at(-1);
            return {
              drawingId: drawing.id,
              drawingNumber: drawing.drawingNumber,
              name: drawing.name,
              currentRevisionId: drawing.currentRevisionId,
              currentRevisionLabel: current === undefined ? null : revisionLabel(current.sequence),
              currentApprovedModelId: null,
              runStatus: null,
              updatedAt: drawing.updatedAt,
              totalRevisionCount: revisions.length,
              latestRevisionLabel: latest === undefined ? null : revisionLabel(latest.sequence),
              hasOpenClarification: false
            };
          })
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return Promise.resolve(ok(items));
      },
      getHistory: (drawingId: string) => {
        calls.push(`drawings.getHistory:${drawingId}`);
        return Promise.resolve(
          guard(() => {
            const drawing = findDrawing(drawingId);
            const revisions = state.revisions.filter((revision) => revision.drawingId === drawing.id);
            return {
              drawingId: drawing.id,
              drawingNumber: drawing.drawingNumber,
              name: drawing.name,
              currentRevisionId: drawing.currentRevisionId,
              revisions: revisions
                .sort((a, b) => a.sequence - b.sequence)
                .map((revision) => ({
                  revisionId: revision.id,
                  revisionLabel: revisionLabel(revision.sequence),
                  isCurrent: revision.id === drawing.currentRevisionId,
                  sourceFile: {
                    fileName: revision.fileName,
                    format: "PDF",
                    sizeBytes: 1_234_567,
                    sha256: "a".repeat(64),
                    uploadedAt: revision.uploadedAt
                  },
                  createdAt: revision.uploadedAt
                }))
            };
          })
        );
      },
      getDetail: (drawingId: string) => {
        calls.push(`drawings.getDetail:${drawingId}`);
        return Promise.resolve(
          guard(() => {
            const drawing = findDrawing(drawingId);
            const revisions = state.revisions.filter((revision) => revision.drawingId === drawing.id);
            return {
              drawing: {
                drawingId: drawing.id,
                drawingNumber: drawing.drawingNumber,
                name: drawing.name,
                currentRevisionId: drawing.currentRevisionId,
                createdAt: drawing.createdAt,
                updatedAt: drawing.updatedAt
              },
              revisions: revisions
                .sort((a, b) => a.sequence - b.sequence)
                .map((revision) => ({
                  revisionId: revision.id,
                  revisionLabel: revisionLabel(revision.sequence),
                  isCurrent: revision.id === drawing.currentRevisionId,
                  currentApprovedModelId: null,
                  isCurrentApprovedModel: false,
                  createdAt: revision.uploadedAt,
                  updatedAt: revision.uploadedAt
                }))
            };
          })
        );
      },
      getRevisionHistory: (drawingId: string, revisionId: string) => {
        calls.push(`drawings.getRevisionHistory:${drawingId}:${revisionId}`);
        return Promise.resolve(
          guard(() => {
            const drawing = findDrawing(drawingId);
            const revision = findRevision(revisionId);
            return {
              revisionId: revision.id,
              revisionLabel: revisionLabel(revision.sequence),
              drawingId: drawing.id,
              drawingNumber: drawing.drawingNumber,
              isCurrent: drawing.currentRevisionId === revision.id,
              createdAt: revision.uploadedAt,
              updatedAt: revision.uploadedAt,
              facts: [],
              modelingFeedback: []
            };
          })
        );
      },
      getRevisionDetail: (drawingId: string, revisionId: string) => {
        calls.push(`drawings.getRevisionDetail:${drawingId}:${revisionId}`);
        return Promise.resolve(
          guard(() => {
            const drawing = findDrawing(drawingId);
            const revision = findRevision(revisionId);
            const revisionRuns = [...runs.values()]
              .filter((run) => run.revisionId === revisionId)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map(toListItem);
            return {
              revision: {
                revisionId: revision.id,
                revisionLabel: revisionLabel(revision.sequence),
                drawingId: drawing.id,
                drawingNumber: drawing.drawingNumber,
                drawingName: drawing.name,
                isCurrent: drawing.currentRevisionId === revision.id,
                currentApprovedModelId: null,
                sourceFile: {
                  fileName: revision.fileName,
                  format: "PDF",
                  sizeBytes: 1_234_567,
                  uploadedAt: revision.uploadedAt
                },
                createdAt: revision.uploadedAt
              },
              runs: revisionRuns,
              models: [],
              costReports: [],
              facts: [],
              modelingFeedback: []
            };
          })
        );
      },
      importDrawing: () => Promise.resolve(fail("NOT_IMPLEMENTED", "not used in phase3 spec")),
      addRevision: () => Promise.resolve(fail("NOT_IMPLEMENTED", "not used in phase3 spec")),
      setCurrentRevision: () => Promise.resolve(fail("NOT_IMPLEMENTED", "not used in phase3 spec")),
      deleteRevision: () => Promise.resolve(fail("NOT_IMPLEMENTED", "not used in phase3 spec")),
      addRevisionFact: () => Promise.resolve(fail("NOT_IMPLEMENTED", "not used in phase3 spec")),
      addModelingFeedback: () => Promise.resolve(fail("NOT_IMPLEMENTED", "not used in phase3 spec"))
    }),
    storage: Object.freeze({
      getSettings: () => {
        calls.push("storage.getSettings");
        return Promise.resolve(ok({ settings: { ...state.settings } }));
      },
      updateSettings: () => Promise.resolve(fail("NOT_IMPLEMENTED", "not used in phase3 spec"))
    }),
    runs: Object.freeze({
      list: () => {
        calls.push("runs.list");
        if (failures.has("runs.list")) {
          return Promise.resolve(fail("RUNNER_UNAVAILABLE", "runs.list 暂时不可用（模拟失败）"));
        }
        const items = [...runs.values()]
          .map(toListItem)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return Promise.resolve(ok(items));
      },
      getDetail: (runId: string) => {
        calls.push(`runs.getDetail:${runId}`);
        getDetailCalls[runId] = (getDetailCalls[runId] ?? 0) + 1;
        const run = runs.get(runId);
        if (run === undefined) {
          return Promise.resolve(fail("NOT_FOUND", `Run ${runId} 不存在`));
        }
        const data = toDetail(run);
        if (heldRuns.has(runId)) {
          return new Promise((resolve) => {
            const pending = pendingGetDetail[runId] ?? [];
            pending.push({ resolve });
            pendingGetDetail[runId] = pending;
          }).then(() => ok(data));
        }
        return Promise.resolve(ok(data));
      },
      create: (input: { drawingId: string; revisionId: string }) => {
        calls.push(`runs.create:${JSON.stringify(input)}`);
        if (failures.has("runs.create")) {
          return Promise.resolve(fail("RUNNER_UNAVAILABLE", "runs.create 暂时不可用（模拟失败）"));
        }
        try {
          const drawing = findDrawing(input.drawingId);
          const revision = findRevision(input.revisionId);
          if (revision.drawingId !== drawing.id) {
            throw Object.assign(new Error("revision does not belong to drawing"), { code: "INVALID_PAYLOAD" });
          }
          const revisionRuns = [...runs.values()].filter((run) => run.revisionId === input.revisionId);
          const maxSequence = revisionRuns.reduce((max, run) => {
            const parsed = Number(run.runLabel.replace(/^R/, ""));
            return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
          }, 0);
          const sequence = maxSequence + 1;
          const runLabel = `R${String(sequence).padStart(2, "0")}`;
          const runId = `run-${Date.now().toString(36)}-${sequence}`;
          const createdAt = new Date().toISOString();
          const run: FakeRun = {
            runId,
            runLabel,
            drawingId: drawing.id,
            revisionId: revision.id,
            status: "QUEUED",
            stage: null,
            activity: null,
            progressPercent: null,
            createdAt,
            startedAt: null,
            completedAt: null,
            failureCode: null,
            failureMessage: null,
            modelId: null,
            clarificationRequestId: null,
            events: []
          };
          runs.set(runId, run);
          return Promise.resolve(
            ok({
              id: runId,
              number: runLabel,
              drawingId: drawing.id,
              revisionId: revision.id,
              status: "QUEUED",
              stage: null,
              inputSnapshot: {
                drawingId: drawing.id,
                revisionId: revision.id,
                originalFileRef: `library/drawings/${drawing.id}/revisions/${revision.id}/source/${revision.fileName}`,
                revisionFacts: [],
                modelingFeedback: [],
                promptTemplateVersion: "pt-1",
                skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) },
                agentConfigId: "agent-default",
                createdAt
              },
              createdAt
            })
          );
        } catch (error) {
          const code = error instanceof Object && "code" in error ? String(error.code) : "INTERNAL";
          return Promise.resolve(
            fail(code, error instanceof Error ? error.message : String(error))
          );
        }
      },
      cancel: (input: { runId: string; reason?: string }) => {
        calls.push(`runs.cancel:${JSON.stringify(input)}`);
        const run = runs.get(input.runId);
        if (run === undefined) {
          return Promise.resolve(fail("NOT_FOUND", `Run ${input.runId} 不存在`));
        }
        if (run.status === "CANCELLED") {
          return Promise.resolve(ok({ runId: input.runId, status: "CANCELLED", alreadyCancelled: true }));
        }
        if (run.status === "QUEUED") {
          const now = new Date().toISOString();
          pushEvents(input.runId, [
            { type: "CancellationRequested", ...(input.reason === undefined ? {} : { reason: input.reason }), occurredAt: now },
            { type: "CancellationConfirmed", occurredAt: now }
          ]);
          return Promise.resolve(ok({ runId: input.runId, status: "CANCELLED", alreadyCancelled: false }));
        }
        if (run.status === "RUNNING") {
          const outcome = cancelOutcomes[input.runId] ?? "cancelled";
          if (outcome === "cleanup-failed") {
            return Promise.resolve(
              ok({ runId: input.runId, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" })
            );
          }
          if (outcome === "cancel-pending") {
            return Promise.resolve(
              ok({
                runId: input.runId,
                status: "CANCEL_PENDING",
                detail: "FOREIGN_LIVE_LEASE",
                leaseDeadlineAt: new Date(Date.now() + 30_000).toISOString()
              })
            );
          }
          const now = new Date().toISOString();
          pushEvents(input.runId, [
            { type: "CancellationRequested", ...(input.reason === undefined ? {} : { reason: input.reason }), occurredAt: now },
            { type: "CancellationConfirmed", occurredAt: now }
          ]);
          return Promise.resolve(ok({ runId: input.runId, status: "CANCELLED", alreadyCancelled: false }));
        }
        return Promise.resolve(
          fail("RUNNER_INVARIANT", `Run ${input.runId} 处于终态 ${run.status}，无法取消`)
        );
      },
      subscribe: (
        input: { runId: string; fromSequence: number },
        onPush: (push: unknown) => void
      ) => {
        calls.push(`runs.subscribe:${JSON.stringify(input)}`);
        subscribeCalls.push({ runId: input.runId, fromSequence: input.fromSequence });
        let set = subscribers.get(input.runId);
        if (set === undefined) {
          set = new Set();
          subscribers.set(input.runId, set);
        }
        set.add(onPush);
        const run = runs.get(input.runId);
        const backlog =
          run === undefined
            ? []
            : run.events.filter((event) => (event.sequence ?? 0) >= input.fromSequence);
        if (backlog.length > 0) {
          onPush({ kind: "runEvents", runId: input.runId, fromSequence: input.fromSequence, events: backlog });
        }
        return () => {
          unsubscribeCalls.push({ runId: input.runId });
          set?.delete(onPush);
        };
      }
    }),
    clarifications: Object.freeze({
      get: (clarificationRequestId: string) => {
        calls.push(`clarifications.get:${clarificationRequestId}`);
        const clarification = clarifications.get(clarificationRequestId);
        if (clarification === undefined) {
          return Promise.resolve(fail("NOT_FOUND", `Clarification ${clarificationRequestId} 不存在`));
        }
        return Promise.resolve(
          ok({
            ...clarification,
            questions: [...clarification.questions],
            answers: [...clarification.answers]
          })
        );
      },
      submit: (input: {
        clarificationRequestId: string;
        answers: unknown[];
        answeredAt: string;
        answeredBy: string;
      }) => {
        calls.push(`clarifications.submit:${JSON.stringify(input)}`);
        const clarification = clarifications.get(input.clarificationRequestId);
        if (clarification === undefined) {
          return Promise.resolve(fail("NOT_FOUND", `Clarification ${input.clarificationRequestId} 不存在`));
        }
        clarification.status = "ANSWERED";
        clarification.answers = input.answers.map((answer) => {
          const typed = answer as { id: string; questionId: string; value: unknown };
          return {
            answerId: typed.id,
            questionId: typed.questionId,
            value: typed.value,
            answeredAt: input.answeredAt
          };
        });
        return Promise.resolve(ok(clarification));
      }
    })
  });

  const target = globalThis as typeof globalThis & {
    swpanel?: typeof api;
    __swpanelFake?: Record<string, unknown>;
  };
  target.swpanel = api;
  target.__swpanelFake = {
    calls,
    subscribeCalls,
    unsubscribeCalls,
    getDetailCalls,
    deliveryCounts,
    runs: [...runs.values()],
    state,
    pushEvents,
    pushStreamError: (runId: string, code: string, message: string) => {
      deliver(runId, { kind: "runEventsError", runId, error: { code, message } });
    },
    replayLastBatch: (runId: string) => {
      const batch = lastBatch[runId];
      if (batch !== undefined && batch.length > 0) {
        deliver(runId, { kind: "runEvents", runId, fromSequence: batch[0]?.sequence, events: batch });
      }
    },
    holdGetDetail: (runId: string) => {
      heldRuns.add(runId);
    },
    releaseGetDetail: (runId: string) => {
      heldRuns.delete(runId);
      const pending = pendingGetDetail[runId] ?? [];
      pendingGetDetail[runId] = [];
      for (const entry of pending) entry.resolve(undefined);
    },
    setCancelOutcome: (runId: string, outcome: "cancelled" | "cleanup-failed" | "cancel-pending") => {
      cancelOutcomes[runId] = outcome;
    },
    setFail: (method: string) => {
      failures.add(method);
    },
    clearFailure: (method: string) => {
      failures.delete(method);
    }
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures and helpers
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  dataRoot: "%LOCALAPPDATA%\\JANGHI\\SWPanel",
  workspaceRoot: "%LOCALAPPDATA%\\JANGHI\\SWPanel\\workspaces",
  constraint: "LOCAL_FIXED_NTFS",
  updatedAt: "2026-08-13T00:00:00.000Z"
};

const DRAWING_A: FakeInitDrawing = {
  id: "drawing-a",
  drawingNumber: "PDJF001.01",
  name: "轧辊（一）",
  currentRevisionId: "rev-a-1",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  revisions: [
    { id: "rev-a-1", sequence: 1, fileName: "PDJF001.01.pdf", uploadedAt: "2026-08-12T00:00:00.000Z" },
    { id: "rev-a-2", sequence: 2, fileName: "PDJF001.01_V2.pdf", uploadedAt: "2026-08-12T01:00:00.000Z" }
  ]
};

const RUN_A_QUEUED: FakeRunSeed = {
  runId: "run-a-1",
  runLabel: "R01",
  drawingId: "drawing-a",
  revisionId: "rev-a-1",
  status: "QUEUED",
  stage: null,
  activity: null,
  progressPercent: null,
  createdAt: "2026-08-13T06:00:00.000Z",
  startedAt: null,
  completedAt: null,
  failureCode: null,
  failureMessage: null,
  modelId: null,
  clarificationRequestId: null,
  events: []
};

const RUN_A_RUNNING: FakeRunSeed = {
  ...RUN_A_QUEUED,
  runId: "run-a-running",
  status: "RUNNING",
  stage: "PREPARING",
  activity: "准备建模任务",
  progressPercent: 17,
  startedAt: "2026-08-13T06:01:00.000Z",
  events: runningScript("run-a-running", "att-1", Date.parse(BASE_TIME))
};

const RUN_B_QUEUED: FakeRunSeed = {
  runId: "run-b-1",
  runLabel: "R02",
  drawingId: "drawing-a",
  revisionId: "rev-a-1",
  status: "QUEUED",
  stage: null,
  activity: null,
  progressPercent: null,
  createdAt: "2026-08-13T06:05:00.000Z",
  startedAt: null,
  completedAt: null,
  failureCode: null,
  failureMessage: null,
  modelId: null,
  clarificationRequestId: null,
  events: []
};

const RUN_C_COMPLETED: FakeRunSeed = {
  runId: "run-c-completed",
  runLabel: "R03",
  drawingId: "drawing-a",
  revisionId: "rev-a-1",
  status: "COMPLETED",
  // F3: the real terminal read model clears the live execution fields; the
  // walked history lives in the events.
  stage: null,
  activity: null,
  progressPercent: null,
  createdAt: "2026-08-13T06:10:00.000Z",
  startedAt: "2026-08-13T06:11:00.000Z",
  completedAt: "2026-08-13T06:17:00.000Z",
  failureCode: null,
  failureMessage: null,
  modelId: null,
  clarificationRequestId: null,
  events: successScript("run-c-completed", "att-1", Date.parse("2026-08-13T06:11:00.000Z"))
};

const CLARIFICATION_SEED: FakeClarificationSeed = {
  clarificationRequestId: "clar-1",
  runId: "run-d-clarification",
  revisionId: "rev-a-1",
  status: "OPEN",
  createdAt: "2026-08-13T06:20:00.000Z",
  questions: [
    {
      questionId: "dimension",
      type: "dimension",
      question: "底板厚度是多少？",
      hint: "12",
      unit: "mm",
      options: []
    },
    {
      questionId: "weld-treatment",
      type: "choice",
      question: "焊缝处理方式？",
      hint: null,
      unit: null,
      options: [
        { id: "none", label: "无需焊缝" },
        { id: "full", label: "全周满焊" }
      ]
    }
  ],
  answers: []
};

function clarificationScript(runId: string, attemptId: string, startAt: number): FakeEventSeed[] {
  const events: FakeEventSeed[] = [];
  let seq = 1;
  for (const stage of ["PREPARING", "ANALYZING", "PLANNING"] as const) {
    events.push(
      ...stageTrio(runId, attemptId, seq, stage, new Date(startAt).toISOString())
    );
    seq += 3;
  }
  events.push({
    sequence: seq,
    type: "ClarificationRequired",
    clarificationRequestId: "clar-1",
    occurredAt: new Date(startAt).toISOString()
  });
  return events;
}

const RUN_D_CLARIFICATION: FakeRunSeed = {
  runId: "run-d-clarification",
  runLabel: "R01",
  drawingId: "drawing-a",
  revisionId: "rev-a-1",
  status: "CLARIFICATION_REQUIRED",
  // F3: terminal read model clears the live execution fields.
  stage: null,
  activity: null,
  progressPercent: null,
  createdAt: "2026-08-13T06:20:00.000Z",
  startedAt: "2026-08-13T06:21:00.000Z",
  completedAt: "2026-08-13T06:24:00.000Z",
  failureCode: null,
  failureMessage: null,
  modelId: null,
  clarificationRequestId: "clar-1",
  events: clarificationScript("run-d-clarification", "att-1", Date.parse("2026-08-13T06:21:00.000Z")),
  clarifications: [CLARIFICATION_SEED]
};

const RUN_E_FAILED: FakeRunSeed = {
  runId: "run-e-failed",
  runLabel: "R05",
  drawingId: "drawing-a",
  revisionId: "rev-a-1",
  status: "FAILED",
  // F3: terminal read model clears the live execution fields.
  stage: null,
  activity: null,
  progressPercent: null,
  createdAt: "2026-08-13T06:30:00.000Z",
  startedAt: "2026-08-13T06:31:00.000Z",
  completedAt: "2026-08-13T06:34:00.000Z",
  failureCode: "AGENT_RUNTIME_UNAVAILABLE",
  failureMessage: "Fake 场景：模拟 Agent 运行时不可用",
  modelId: null,
  clarificationRequestId: null,
  events: (() => {
    const events: FakeEventSeed[] = [];
    let seq = 1;
    for (const stage of ["PREPARING", "ANALYZING", "PLANNING"] as const) {
      events.push(...stageTrio("run-e-failed", "att-1", seq, stage, "2026-08-13T06:31:00.000Z"));
      seq += 3;
    }
    events.push({
      sequence: seq,
      type: "Failed",
      failureCode: "AGENT_RUNTIME_UNAVAILABLE",
      failureMessage: "Fake 场景：模拟 Agent 运行时不可用",
      occurredAt: "2026-08-13T06:34:00.000Z"
    });
    return events;
  })()
};

const RUN_F_ARTIFACT: FakeRunSeed = {
  runId: "run-f-artifact",
  runLabel: "R06",
  drawingId: "drawing-a",
  revisionId: "rev-a-1",
  status: "FAILED",
  // F3: terminal read model clears the live execution fields.
  stage: null,
  activity: null,
  progressPercent: null,
  createdAt: "2026-08-13T06:40:00.000Z",
  startedAt: "2026-08-13T06:41:00.000Z",
  completedAt: "2026-08-13T06:46:00.000Z",
  failureCode: "VALIDATION_REJECTED",
  failureMessage: "Fake 场景：产物校验失败（模拟产物缺失）",
  modelId: null,
  clarificationRequestId: null,
  events: (() => {
    const events: FakeEventSeed[] = [];
    let seq = 1;
    for (const stage of ["PREPARING", "ANALYZING", "PLANNING", "MODELING", "VALIDATING"] as const) {
      events.push(...stageTrio("run-f-artifact", "att-1", seq, stage, "2026-08-13T06:41:00.000Z"));
      seq += 3;
    }
    events.push({
      sequence: seq,
      type: "ArtifactValidationFailed",
      failureCode: "ARTIFACT_MISSING",
      occurredAt: "2026-08-13T06:45:00.000Z"
    });
    events.push({
      sequence: seq + 1,
      type: "Failed",
      failureCode: "VALIDATION_REJECTED",
      failureMessage: "Fake 场景：产物校验失败（模拟产物缺失）",
      occurredAt: "2026-08-13T06:46:00.000Z"
    });
    return events;
  })()
};

interface FakeInspect {
  calls: string[];
  subscribeCalls: Array<{ runId: string; fromSequence: number }>;
  unsubscribeCalls: Array<{ runId: string }>;
  getDetailCalls: Record<string, number>;
  deliveryCounts: Record<string, number>;
  runs: Array<{ runId: string; status: string; stage: string | null }>;
  state: { drawings: unknown[]; revisions: unknown[] };
}

async function fake(page: Page): Promise<FakeInspect> {
  return page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __swpanelFake: Record<string, unknown> };
    const exposed = target.__swpanelFake;
    return {
      calls: exposed.calls as string[],
      subscribeCalls: exposed.subscribeCalls as FakeInspect["subscribeCalls"],
      unsubscribeCalls: exposed.unsubscribeCalls as FakeInspect["unsubscribeCalls"],
      getDetailCalls: exposed.getDetailCalls as FakeInspect["getDetailCalls"],
      deliveryCounts: exposed.deliveryCounts as FakeInspect["deliveryCounts"],
      runs: exposed.runs as FakeInspect["runs"],
      state: exposed.state as FakeInspect["state"]
    };
  });
}

/** Pushes stage events of one success-script step onto the fake bridge. */
async function pushSuccessStep(page: Page, runId: string, stepIndex: number) {
  const stage = ALL_STAGES[stepIndex] as (typeof ALL_STAGES)[number];
  await page.evaluate(
    ({ runId, stage, stageIndex, stageCount, time }) => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: {
          pushEvents: (runId: string, payloads: Array<Record<string, unknown>>) => void;
        };
      };
      const pushEvents = target.__swpanelFake?.pushEvents;
      if (pushEvents === undefined) throw new Error("fake bridge missing");
      const activity =
        stage === "PREPARING"
          ? "准备建模任务"
          : stage === "ANALYZING"
            ? "分析图纸"
            : stage === "PLANNING"
              ? "规划建模方案"
              : stage === "MODELING"
                ? "SolidWorks 建模中"
                : stage === "VALIDATING"
                  ? "校验模型"
                  : "生成结果";
      const progressPercent = Math.round(((stageIndex + 1) / stageCount) * 100);
      pushEvents(runId, [
        { type: "StageChanged", stage, activity, occurredAt: time },
        { type: "ActivityUpdated", activity, occurredAt: time },
        { type: "ProgressUpdated", progressPercent, activity, occurredAt: time }
      ]);
    },
    {
      runId,
      stage,
      stageIndex: stepIndex,
      stageCount: ALL_STAGES.length,
      time: new Date(Date.parse(BASE_TIME) + stepIndex * 60_000).toISOString()
    }
  );
}

async function pushCompleted(page: Page, runId: string) {
  await page.evaluate(
    ({ runId, time }) => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: { pushEvents: (runId: string, payloads: Array<Record<string, unknown>>) => void };
      };
      target.__swpanelFake?.pushEvents(runId, [{ type: "Completed", occurredAt: time }]);
    },
    { runId, time: new Date(Date.parse(BASE_TIME) + 6 * 60_000).toISOString() }
  );
}

async function installAndOpen(
  page: Page,
  options: { runs: FakeRunSeed[]; route: string; fail?: string[] }
) {
  await page.addInitScript(installFakeBridge, {
    seed: [DRAWING_A],
    settings: DEFAULT_SETTINGS,
    runs: options.runs,
    fail: options.fail ?? []
  });
  await page.setViewportSize(viewport);
  await page.goto(options.route, { waitUntil: "networkidle" });
}

async function expectCleanPage(page: Page) {
  await expect(page.locator("[data-route-id]")).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.documentElement.dataset.phase3FontsReady = "true";
  });
  await expect(page.locator("html")).toHaveAttribute("data-phase3-fonts-ready", "true");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Phase 3 browser Modeling Run UI (explicit fake bridge)", () => {
  test("product-mode confirmation dialog creates a Run with ONLY the identity pair and no fake scenario controls", async ({ page }) => {
    await installAndOpen(page, { runs: [], route: "/#/drawings/drawing-a/revisions/rev-a-1/overview" });
    await expectCleanPage(page);
    await expect(page.getByRole("heading", { name: "PDJF001.01" })).toBeVisible();

    // The product mode must never surface fake scenario controls: no scenario
    // query, no scenario selector, and the URL never gains `?scenario=`.
    await expect(page).not.toHaveURL(/scenario=/);
    await expect(page.getByText("场景", { exact: true })).toHaveCount(0);

    // Lightweight confirmation -> create.
    await page.getByRole("button", { name: "开始自动建模" }).click();
    const dialog = page.getByRole("dialog", { name: "确认开始自动建模" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/将基于当前版本 V1 的工程事实和历史反馈创建新的建模任务/)).toBeVisible();
    await dialog.getByRole("button", { name: "确认并开始" }).click();

    // The success notice names the fresh Run and links to its detail page.
    await expect(page.getByText("Run R01 已创建，等待执行。")).toBeVisible();
    await page.getByRole("link", { name: "查看任务" }).click();
    await expect(page).toHaveURL(/\/#\/runs\/run-/);

    // The bridge payload carried ONLY the identity pair (no Input Snapshot or
    // scenario field may ever cross the bridge).
    const inspected = await fake(page);
    const createCall = inspected.calls.find((call) => call.startsWith("runs.create:"));
    expect(createCall).toBeDefined();
    const payload = JSON.parse((createCall as string).slice("runs.create:".length)) as {
      drawingId: string;
      revisionId: string;
    };
    expect(payload).toEqual({ drawingId: "drawing-a", revisionId: "rev-a-1" });

    // The created Run is visible on the detail page as QUEUED (等待执行).
    await expect(page.getByText("等待执行", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("任务已在队列中，将按顺序自动执行。")).toBeVisible();
    await expect(page.getByRole("button", { name: "取消任务" })).toBeVisible();
  });

  test("create failure surfaces a structured error and leaves the dialog recoverable", async ({ page }) => {
    await installAndOpen(page, { runs: [], route: "/#/drawings/drawing-a/revisions/rev-a-1/overview", fail: ["runs.create"] });
    await expectCleanPage(page);
    await page.getByRole("button", { name: "开始自动建模" }).click();
    const dialog = page.getByRole("dialog", { name: "确认开始自动建模" });
    await dialog.getByRole("button", { name: "确认并开始" }).click();
    await expect(page.getByText("创建建模任务失败")).toBeVisible();
    await expect(page.getByText(/runs.create 暂时不可用/)).toBeVisible();

    // Clearing the injected failure lets the retry succeed (no reload).
    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: { clearFailure: (method: string) => void };
      };
      target.__swpanelFake?.clearFailure("runs.create");
    });
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByText("Run R01 已创建，等待执行。")).toBeVisible();
  });

  test("a QUEUED run moves to the current section when a live start event arrives", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_A_QUEUED], route: "/#/runs" });
    await expectCleanPage(page);

    // Queued row: drawing identity + run label + 取消.
    await expect(page.getByText("当前没有正在执行的建模任务。")).toBeVisible();
    const queueRow = page.locator(".queue-item").filter({ hasText: "PDJF001.01 · V1 · R01" });
    await expect(queueRow).toBeVisible();
    await expect(queueRow.getByText("等待执行")).toBeVisible();

    // Live start: QUEUED -> RUNNING (list invalidates and the row moves to the
    // current-run card with the first stage active).
    await pushSuccessStep(page, "run-a-1", 0);
    await expect(page.getByText("当前没有正在执行的建模任务。")).toHaveCount(0);
    await expect(page.locator(".queue-item").filter({ hasText: "R01" })).toHaveCount(0);
    const currentCard = page.locator(".run-card");
    await expect(currentCard.getByText("执行中")).toBeVisible();
    await expect(currentCard.getByText("准备建模任务")).toBeVisible();
    await expect(currentCard.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute("aria-valuenow", "17");

    // The stage progress shows PREPARING active and the rest pending.
    const stages = currentCard.locator(".stage-step");
    await expect(stages).toHaveCount(6);
    await expect(stages.nth(0)).toHaveClass(/active/);
    await expect(stages.nth(0)).toContainText("准备任务");
    await expect(stages.nth(1)).toHaveClass(/pending/);

    // Only the bridge run surface was used (no mock scenario path).
    const inspected = await fake(page);
    expect(inspected.calls.some((call) => call.startsWith("runs.list"))).toBe(true);
    expect(inspected.calls.some((call) => call.startsWith("runs.subscribe:"))).toBe(true);
  });

  test("all six stages walk live in order and the Run completes model-less", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_A_QUEUED], route: "/#/runs/run-a-1" });
    await expectCleanPage(page);

    // Walk the six stages one by one; each stage's canonical label becomes
    // visible with the right progress value.
    const expected: ReadonlyArray<{ label: string; pct: string; stage: string }> = [
      { label: "准备建模任务", pct: "17", stage: "PREPARING" },
      { label: "分析图纸", pct: "33", stage: "ANALYZING" },
      { label: "规划建模方案", pct: "50", stage: "PLANNING" },
      { label: "SolidWorks 建模中", pct: "67", stage: "MODELING" },
      { label: "校验模型", pct: "83", stage: "VALIDATING" },
      { label: "生成结果", pct: "100", stage: "PACKAGING" }
    ];
    for (let index = 0; index < expected.length; index += 1) {
      await pushSuccessStep(page, "run-a-1", index);
      const entry = expected[index] as (typeof expected)[number];
      await expect(page.getByText(entry.label).first()).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute(
        "aria-valuenow",
        entry.pct
      );
      await expect(page.getByText(entry.stage, { exact: true })).toHaveCount(1);
    }

    // Terminal: model-less COMPLETED (Phase 3 decision — no modelId).
    await pushCompleted(page, "run-a-1");
    await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Run 已完成（未生成模型）")).toBeVisible();
    await expect(page.getByText("本阶段执行完成，未发布模型。可随时发起新的 Run。")).toBeVisible();
    await expect(page.getByRole("button", { name: "取消任务" })).toHaveCount(0);

    // The 事件流 section lists every structured event in order (19 events);
    // the terminal 执行阶段 rows live in their own section.
    const eventStreamSection = page.locator(".section").filter({ hasText: "结构化事件" });
    const eventRows = eventStreamSection.locator(".run-detail-stage");
    await expect(eventRows).toHaveCount(19);
    await expect(eventStreamSection.locator(".run-detail-stage").filter({ hasText: "Completed" })).toHaveCount(1);

    // The fake bridge never published a model on completion.
    const inspected = await fake(page);
    const completedRun = inspected.runs.find((run) => run.runId === "run-a-1");
    expect(completedRun?.status).toBe("COMPLETED");
  });

  test("CLARIFICATION_REQUIRED shows the form; answers keep the Run terminal and start a NEW Run", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_D_CLARIFICATION], route: "/#/runs/run-d-clarification" });
    await expectCleanPage(page);

    // Terminal clarification state with the open form.
    await expect(page.getByText("需要补充信息", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("需要补充 2 项信息")).toBeVisible();
    await expect(page.getByText("底板厚度是多少？")).toBeVisible();
    await expect(page.getByText("焊缝处理方式？")).toBeVisible();

    // Fill both questions and submit.
    await page.getByRole("textbox", { name: "底板厚度是多少？" }).fill("12");
    await page.getByRole("combobox", { name: "焊缝处理方式？" }).selectOption({ label: "全周满焊" });
    await page.getByRole("button", { name: "提交补充信息" }).click();

    // Answered state: answers saved, guidance to update Facts in Memory, and
    // the terminal notice that the old Run is NOT resumed.
    await expect(page.getByText("补充信息已保存至版本记忆")).toBeVisible();
    await expect(page.getByText("本次 Run 已结束。重新建模将创建新的 Run。")).toBeVisible();
    await expect(page.getByRole("link", { name: "前往版本记忆更新 Facts" })).toBeVisible();

    // The submitted answers reached the bridge with the request id.
    const inspected = await fake(page);
    expect(
      inspected.calls.some((call) => call.startsWith("clarifications.submit:") && call.includes('"clarificationRequestId":"clar-1"'))
    ).toBe(true);

    // New Run guidance: 重新自动建模 creates a NEW Run (same revision, next
    // number R02) and navigates to it — the old Run is never resumed.
    await page.getByRole("button", { name: "重新自动建模" }).click();
    await expect(page).toHaveURL(/\/#\/runs\/run-/);
    await expect(page.getByRole("heading", { name: "R02" })).toBeVisible();
    await expect(page.getByText("等待执行", { exact: true }).first()).toBeVisible();
    const afterCreate = await fake(page);
    const createCall = afterCreate.calls.find((call) => call.startsWith("runs.create:"));
    expect(createCall).toContain('"revisionId":"rev-a-1"');

    // The old Run stayed terminal CLARIFICATION_REQUIRED.
    const runs = afterCreate.runs;
    const oldRun = runs.find((run) => run.runId === "run-d-clarification");
    expect(oldRun?.status).toBe("CLARIFICATION_REQUIRED");
  });

  test("FAILED run shows structured failure detail and a restart action", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_E_FAILED], route: "/#/runs/run-e-failed" });
    await expectCleanPage(page);

    await expect(page.getByText("执行失败", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("失败信息", { exact: true })).toBeVisible();
    await expect(page.getByText("Fake 场景：模拟 Agent 运行时不可用")).toBeVisible();
    await expect(page.getByText("失败代码：AGENT_RUNTIME_UNAVAILABLE")).toBeVisible();
    await expect(page.getByText("该 Run 已终止。修复后可通过「开始自动建模」发起新的 Run。")).toBeVisible();
    await expect(page.getByRole("button", { name: "重新自动建模" })).toBeVisible();
    await expect(page.getByText("事件流", { exact: true })).toBeVisible();
  });

  test("artifact validation failure is visible in the event stream and failure UI", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_F_ARTIFACT], route: "/#/runs/run-f-artifact" });
    await expectCleanPage(page);

    await expect(page.getByText("执行失败", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("失败代码：VALIDATION_REJECTED")).toBeVisible();
    await expect(page.getByText("Fake 场景：产物校验失败（模拟产物缺失）")).toBeVisible();
    // The ArtifactValidationFailed event is part of the structured event stream.
    const eventLabels = page.locator(".run-detail-stage-label");
    await expect(eventLabels.filter({ hasText: /^ArtifactValidationFailed$/ })).toHaveCount(1);
    await expect(eventLabels.filter({ hasText: /^Failed$/ })).toHaveCount(1);
    await expect(eventLabels.filter({ hasText: /^Completed$/ })).toHaveCount(0);
  });

  test("a QUEUED Run is cancelled while another Run runs; the queue row disappears", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_A_RUNNING, RUN_B_QUEUED], route: "/#/runs" });
    await expectCleanPage(page);

    // Current: A running. Queue: B queued (R02).
    await expect(page.locator(".run-card").getByText("执行中")).toBeVisible();
    const queueRow = page.locator(".queue-item").filter({ hasText: "PDJF001.01 · V1 · R02" });
    await expect(queueRow).toBeVisible();

    // Cancel B from the queue while A is running.
    await queueRow.getByRole("button", { name: "取消" }).click();
    await expect(page.getByText("Run R02 已取消")).toBeVisible();
    await expect(page.locator(".queue-item").filter({ hasText: "R02" })).toHaveCount(0);
    await expect(page.getByText("当前没有等待执行的任务。")).toBeVisible();

    // A stays RUNNING (the serial slot was never touched).
    await expect(page.locator(".run-card").getByText("执行中")).toBeVisible();

    const inspected = await fake(page);
    const cancelCall = inspected.calls.find((call) => call.startsWith("runs.cancel:") && call.includes("run-b-1"));
    expect(cancelCall).toBeDefined();
    const payload = JSON.parse((cancelCall as string).slice("runs.cancel:".length)) as {
      runId: string;
      reason?: string;
    };
    expect(payload.runId).toBe("run-b-1");
    const cancelledRun = inspected.runs.find((run) => run.runId === "run-b-1");
    expect(cancelledRun?.status).toBe("CANCELLED");
  });

  test("RUNNING cancel cleanup failure surfaces CANCEL_CLEANUP_PENDING and never claims CANCELLED", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_A_RUNNING], route: "/#/runs/run-a-running" });
    await expectCleanPage(page);

    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: { setCancelOutcome: (runId: string, outcome: string) => void };
      };
      target.__swpanelFake?.setCancelOutcome("run-a-running", "cleanup-failed");
    });
    await page.getByRole("button", { name: "取消任务" }).click();

    // The explicit failure outcome: the Run was NOT cancelled and the cleanup
    // is pending; the notice must never claim a full cancellation.
    await expect(page.getByText("Run R01 取消未完成")).toBeVisible();
    await expect(page.getByText("CANCEL_CLEANUP_PENDING")).toBeVisible();
    await expect(page.getByRole("button", { name: "取消任务" })).toBeVisible();
    const inspected = await fake(page);
    expect(inspected.runs.find((run) => run.runId === "run-a-running")?.status).toBe("RUNNING");
  });

  test("RUNNING cancel with a foreign live lease returns CANCEL_PENDING and keeps the Run running", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_A_RUNNING], route: "/#/runs/run-a-running" });
    await expectCleanPage(page);

    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: { setCancelOutcome: (runId: string, outcome: string) => void };
      };
      target.__swpanelFake?.setCancelOutcome("run-a-running", "cancel-pending");
    });
    await page.getByRole("button", { name: "取消任务" }).click();

    await expect(page.getByText("Run R01 取消待处理")).toBeVisible();
    await expect(page.getByText(/等待执行租约释放后会自动完成取消/)).toBeVisible();
    await expect(page.getByText("执行中", { exact: true }).first()).toBeVisible();
    const inspected = await fake(page);
    expect(inspected.runs.find((run) => run.runId === "run-a-running")?.status).toBe("RUNNING");
  });

  test("live events apply and duplicate batches are ignored without a refetch", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_A_QUEUED], route: "/#/runs/run-a-1" });
    await expectCleanPage(page);

    await pushSuccessStep(page, "run-a-1", 0);
    await expect(page.getByText("准备建模任务").first()).toBeVisible();
    const getDetailCallsAfterFirst = (await fake(page)).getDetailCalls["run-a-1"] ?? 0;

    // Re-deliver the exact same batch: duplicates must be ignored (no event
    // row duplication, no refetch).
    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: { replayLastBatch: (runId: string) => void };
      };
      target.__swpanelFake?.replayLastBatch("run-a-1");
    });
    await page.waitForTimeout(300);
    await expect(page.locator(".run-detail-stage")).toHaveCount(3);
    const after = await fake(page);
    expect(after.getDetailCalls["run-a-1"] ?? 0).toBe(getDetailCallsAfterFirst);
    expect(after.subscribeCalls).toHaveLength(1);

    // A further live batch still applies normally.
    await pushSuccessStep(page, "run-a-1", 1);
    await expect(page.locator(".run-detail-stage")).toHaveCount(6);
    await expect(page.getByText("分析图纸").first()).toBeVisible();
  });

  test("a lost stream refetches the snapshot and resubscribes from the last sequence", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_A_QUEUED], route: "/#/runs/run-a-1" });
    await expectCleanPage(page);
    await pushSuccessStep(page, "run-a-1", 0);
    await expect(page.getByText("准备建模任务").first()).toBeVisible();

    // Hold the refetch so the recovering state is observable, then fail the
    // stream exactly like a Main-side gap / lost connection.
    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: {
          holdGetDetail: (runId: string) => void;
          pushStreamError: (runId: string, code: string, message: string) => void;
        };
      };
      target.__swpanelFake?.holdGetDetail("run-a-1");
      target.__swpanelFake?.pushStreamError("run-a-1", "RUN_EVENT_GAP", "event gap");
    });
    await expect(page.getByText("正在重新连接任务事件流")).toBeVisible();
    await expect(page.getByText("正在重新同步进度（第 1 次尝试）…")).toBeVisible();

    // Release the refetch: the stream recovers, resubscribes from the NEW last
    // sequence (4, not 1) and keeps delivering live events.
    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: { releaseGetDetail: (runId: string) => void };
      };
      target.__swpanelFake?.releaseGetDetail("run-a-1");
    });
    await expect(page.getByText("正在重新连接任务事件流")).toHaveCount(0);
    await pushSuccessStep(page, "run-a-1", 1);
    await expect(page.getByText("分析图纸").first()).toBeVisible();

    const inspected = await fake(page);
    expect(inspected.subscribeCalls.map((call) => call.fromSequence)).toEqual([1, 4]);
    expect((inspected.getDetailCalls["run-a-1"] ?? 0)).toBeGreaterThanOrEqual(2);
  });

  test("route unmount unsubscribes and a remount resubscribes from the last sequence", async ({ page }) => {
    await installAndOpen(page, { runs: [RUN_A_RUNNING], route: "/#/runs/run-a-running" });
    await expectCleanPage(page);
    await expect(page.getByText("执行进度", { exact: true })).toBeVisible();

    const subscribeCallsBefore = (await fake(page)).subscribeCalls;
    expect(subscribeCallsBefore).toHaveLength(1);
    expect(subscribeCallsBefore[0]?.fromSequence).toBe(4); // lastEventSequence(3) + 1

    // Navigate away: the detail-page subscription is torn down.
    await page.goto("/#/runs", { waitUntil: "networkidle" });
    await expect(page.getByText("当前没有正在执行的建模任务。")).toHaveCount(0);
    const afterAway = await fake(page);
    expect(afterAway.unsubscribeCalls.some((call) => call.runId === "run-a-running")).toBe(true);

    // Navigate back: a NEW subscription starts from the same last sequence
    // (never from 0), so no event is replayed or missed.
    await page.goto("/#/runs/run-a-running", { waitUntil: "networkidle" });
    await expect(page.getByText("执行进度", { exact: true })).toBeVisible();
    const afterBack = await fake(page);
    const runSubscribes = afterBack.subscribeCalls.filter((call) => call.runId === "run-a-running");
    expect(runSubscribes.length).toBeGreaterThanOrEqual(2);
    // EVERY subscribe of this Run starts at lastEventSequence + 1 (never 0/1):
    // the stream always resumes from the last known sequence.
    for (const call of runSubscribes) expect(call.fromSequence).toBe(4);
    const lastSubscribe = runSubscribes.at(-1);
    expect(lastSubscribe?.runId).toBe("run-a-running");
  });

  test("Phase 3 Run pages keep the explicit-bridge product posture (no mock fixture selectors)", async ({ page }) => {
    await installAndOpen(page, {
      runs: [RUN_A_RUNNING, RUN_B_QUEUED, RUN_C_COMPLETED, RUN_D_CLARIFICATION, RUN_E_FAILED, RUN_F_ARTIFACT],
      route: "/#/runs"
    });
    await expectCleanPage(page);

    // Every canonical status is rendered from real bridge data.
    await expect(page.locator(".run-card").getByText("执行中")).toBeVisible();
    await expect(page.locator(".queue-item").filter({ hasText: "R02" }).getByText("等待执行")).toBeVisible();
    await expect(page.getByText("已完成（未生成模型）")).toBeVisible();
    await expect(page.getByText("需要补充信息").first()).toBeVisible();
    await expect(page.getByText("用户主动取消")).toHaveCount(0);
    await expect(page.getByText("执行失败").first()).toBeVisible();

    // No scenario / mock controls exist anywhere on the page.
    await expect(page.getByText("场景", { exact: true })).toHaveCount(0);
    await expect(page.locator("select").filter({ hasText: "scenario" })).toHaveCount(0);
    await expect(page).not.toHaveURL(/scenario=/);

    // The data came through the bridge run surface, never the fixture world.
    const inspected = await fake(page);
    expect(inspected.calls.filter((call) => call.startsWith("runs.")).length).toBeGreaterThan(0);
    expect(inspected.calls.some((call) => call.startsWith("runs.list"))).toBe(true);
  });
});
