import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import type {
  ClarificationAnswer,
  ClarificationAnswerValue,
  ClarificationQuestion,
  ClarificationRequest,
  Drawing,
  DrawingRevision,
  RevisionSourceFile,
  RunEventPayload
} from "@swpanel/domain";
import {
  InvalidArgumentError,
  NotFoundError,
  RunnerInvariantError
} from "../errors.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";
import { SqliteDatabase } from "./database.js";
import { SqliteRepository } from "./repository.js";
import { RunRepository, type RunProfile } from "./run-repository.js";

const T0 = "2026-08-13T09:00:00.000Z";
const T1 = "2026-08-13T09:01:00.000Z";
const T2 = "2026-08-13T09:02:00.000Z";
const T3 = "2026-08-13T09:05:00.000Z";

const PROFILE: RunProfile = {
  promptTemplateVersion: "prompt-template-v3",
  skill: { name: "solidworks-build-part-from-drawing", sha256: "b".repeat(64) },
  agentConfigId: "agent-config-1"
};

interface Fixture {
  dir: string;
  dbPath: string;
  db: SqliteDatabase;
  store: SqliteRepository;
  runs: RunRepository;
}

function openFixture(prefix: string): Fixture {
  const dir = makeTempDir(prefix);
  const dbPath = join(dir, "state", "swpanel.db");
  const db = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  return { dir, dbPath, db, store, runs: new RunRepository(db, store) };
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close();
  removeTempDir(fixture.dir);
}

/** Seeds a Drawing + Revision through the low-level store primitives. */
function seedRevision(
  fixture: Fixture,
  drawingId: string,
  revisionId: string,
  sequence = 1,
  createdAt = T0
): { drawing: Drawing; revision: DrawingRevision; sourceFile: RevisionSourceFile } {
  const sourceFile: RevisionSourceFile = {
    id: `file-${revisionId}`,
    fileName: `${drawingId}.pdf`,
    format: "PDF",
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    relativePath: `library/drawings/file-${revisionId}/source/original.pdf`,
    uploadedAt: createdAt
  };
  const existingDrawing = fixture.store.getDrawing(drawingId);
  const drawing: Drawing = existingDrawing ?? {
    id: drawingId,
    drawingNumber: `D-${drawingId}`,
    name: `Drawing ${drawingId}`,
    currentRevisionId: null,
    createdAt,
    updatedAt: createdAt
  };
  const revision: DrawingRevision = {
    id: revisionId,
    drawingId,
    sequence,
    sourceFile,
    currentApprovedModelId: null,
    createdAt,
    updatedAt: createdAt
  };
  fixture.db.transaction(() => {
    if (existingDrawing === null) fixture.store.insertDrawing(drawing);
    fixture.store.insertRevisionFile(sourceFile);
    fixture.store.insertRevision(revision);
    fixture.store.setCurrentRevisionPointer(drawingId, revisionId, createdAt);
  });
  return { drawing, revision, sourceFile };
}

function createRun(fixture: Fixture, drawingId: string, revisionId: string, createdAt = T0) {
  return fixture.runs.createRun({ drawingId, revisionId, profile: PROFILE, createdAt });
}

/**
 * Seeds a persisted ACTIVE attempt row (the claim mints attempts in P3-2;
 * event appends require the attempt to already exist).
 */
function seedAttempt(fixture: Fixture, attemptId: string, runId: string, sequence = 1): void {
  fixture.db
    .prepare(
      "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, created_at) " +
        "VALUES (?, ?, ?, 'ACTIVE', ?)"
    )
    .run(attemptId, runId, sequence, T0);
}

/**
 * Stages a QUEUED Run as RUNNING for projection tests. The production atomic
 * claim (`RunOrchestrator.claimNextQueuedRun`, P3-2) is the ONLY path to
 * RUNNING and always mints the ACTIVE attempt in the same transaction, so a
 * RUNNING Run can never exist without a live attempt; the repository exposes
 * no RUNNING transition primitive. These tests stage the state directly (the
 * attempt is seeded first, mirroring the claim) to exercise the projection
 * layer in isolation; the DB single-active-RUNNING unique index still applies.
 */
function stageRunning(fixture: Fixture, runId: string, startedAt: string): void {
  fixture.db
    .prepare(
      "UPDATE runs SET status = 'RUNNING', started_at = COALESCE(started_at, ?) " +
        "WHERE id = ? AND status = 'QUEUED'"
    )
    .run(startedAt, runId);
}

describe("RunRepository creation and snapshot freeze", () => {
  const fixtures: Fixture[] = [];
  beforeAll(() => {
    const fixture = openFixture("run-repo-create");
    fixtures.push(fixture);
    seedRevision(fixture, "drawing-a", "revision-a1", 1);
    seedRevision(fixture, "drawing-a", "revision-a2", 2);
    seedRevision(fixture, "drawing-b", "revision-b1", 1);
    fixture.store.addRevisionFact({
      id: "fact-1",
      revisionId: "revision-a1",
      field: "材料",
      value: "42CrMo",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-13T08:30:00.000Z"
    });
    fixture.store.addModelingFeedback({
      id: "feedback-1",
      revisionId: "revision-a1",
      content: "上次圆角位置不对",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-13T08:40:00.000Z"
    });
  });
  afterAll(() => {
    for (const fixture of fixtures) closeFixture(fixture);
  });

  it("creates a QUEUED Run with the Runner-built frozen snapshot and per-revision numbering", () => {
    const fixture = fixtures[0] as Fixture;
    const first = createRun(fixture, "drawing-a", "revision-a1", T1);
    expect(first.status).toBe("QUEUED");
    expect(first.stage).toBeNull();
    expect(first.number).toBe("R01");
    expect(first.createdAt).toBe(T1);
    expect(first.inputSnapshot).toEqual({
      drawingId: "drawing-a",
      revisionId: "revision-a1",
      originalFileRef: `library/drawings/file-revision-a1/source/original.pdf`,
      revisionFacts: [
        {
          id: "fact-1",
          revisionId: "revision-a1",
          field: "材料",
          value: "42CrMo",
          source: "USER_SUPPLEMENT",
          createdAt: "2026-08-13T08:30:00.000Z"
        }
      ],
      modelingFeedback: [
        {
          id: "feedback-1",
          revisionId: "revision-a1",
          content: "上次圆角位置不对",
          source: "USER_SUPPLEMENT",
          createdAt: "2026-08-13T08:40:00.000Z"
        }
      ],
      promptTemplateVersion: PROFILE.promptTemplateVersion,
      skill: PROFILE.skill,
      agentConfigId: PROFILE.agentConfigId,
      createdAt: T1
    });

    const second = createRun(fixture, "drawing-a", "revision-a1", T2);
    expect(second.number).toBe("R02");
    // Other revisions number independently.
    expect(createRun(fixture, "drawing-a", "revision-a2", T2).number).toBe("R01");
    expect(createRun(fixture, "drawing-b", "revision-b1", T2).number).toBe("R01");
  });

  it("freezes only Facts and Feedback visible at the snapshot moment", () => {
    const fixture = fixtures[0] as Fixture;
    // Snapshot at T0 < 08:40 feedback time: the feedback is not frozen.
    const run = createRun(fixture, "drawing-a", "revision-a1", "2026-08-13T08:35:00.000Z");
    expect(run.inputSnapshot.revisionFacts).toHaveLength(1);
    expect(run.inputSnapshot.modelingFeedback).toHaveLength(0);
  });

  it("compares snapshot causality numerically and stores canonical UTC ISO", () => {
    const fixture = fixtures[0] as Fixture;
    // 16:30+08:00 equals 08:30:00Z: the fact seeded at 08:30Z is visible at
    // exactly this instant (numeric epoch comparison; raw string comparison
    // would wrongly exclude it), and the stored timestamp is canonicalized.
    const run = createRun(fixture, "drawing-a", "revision-a1", "2026-08-13T16:30:00.000+08:00");
    expect(run.createdAt).toBe("2026-08-13T08:30:00.000Z");
    expect(run.inputSnapshot.createdAt).toBe("2026-08-13T08:30:00.000Z");
    expect(run.inputSnapshot.revisionFacts.some((fact) => fact.id === "fact-1")).toBe(true);
    expect(run.inputSnapshot.modelingFeedback).toHaveLength(0);
  });

  it("rejects an unknown Revision and a Revision of another Drawing", () => {
    const fixture = fixtures[0] as Fixture;
    expect(() => createRun(fixture, "drawing-a", "revision-none", T1)).toThrowError(NotFoundError);
    expect(() => createRun(fixture, "drawing-b", "revision-a1", T1)).toThrowError(RunnerInvariantError);
  });

  it("persists the snapshot across close/reopen and never aliases it on reads", () => {
    const fixture = openFixture("run-repo-reopen");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      fixture.store.addRevisionFact({
        id: "fact-1",
        revisionId: "revision-a1",
        field: "材料",
        value: "42CrMo",
        source: "USER_SUPPLEMENT",
        createdAt: T0
      });
      const created = createRun(fixture, "drawing-a", "revision-a1", T1);
      fixture.db.close();

      // Reopen on the same file: snapshot and Run survive.
      const reopenedDb = new SqliteDatabase({ dbPath: fixture.dbPath, busyTimeoutMs: 5_000 });
      reopenedDb.open();
      const reopenedRuns = new RunRepository(reopenedDb, new SqliteRepository(reopenedDb));
      const read = reopenedRuns.getRunSnapshot(created.id);
      expect(read).toEqual(created.inputSnapshot);
      expect(read).not.toBe(created.inputSnapshot);

      // Mutating a returned snapshot cannot corrupt the persisted one.
      (read.revisionFacts[0] as { value: string }).value = "篡改";
      expect(reopenedRuns.getRunSnapshot(created.id).revisionFacts[0]?.value).toBe("42CrMo");
      reopenedDb.close();
    } finally {
      if (fixture.db.isOpen) fixture.db.close();
      removeTempDir(fixture.dir);
    }
  });
});

describe("RunRepository event append and projection", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = openFixture("run-repo-events");
    seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
  });
  afterEach(() => closeFixture(fixture));

  it("allocates strictly monotonic DB sequences across separate appends", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    const first = fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [
        { payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: T1 },
        { payload: { type: "ProgressUpdated", progressPercent: 10 }, occurredAt: T2 }
      ]
    });
    expect(first.map((event) => event.sequence)).toEqual([1, 2]);
    const second = fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [{ payload: { type: "ActivityUpdated", activity: "分析中" }, occurredAt: T3 }]
    });
    expect(second.map((event) => event.sequence)).toEqual([3]);
    const events = fixture.runs.listRunEvents(run.id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.every((event) => event.runId === run.id && event.attemptId === "attempt-run-1")).toBe(true);
    expect(events[0]).toMatchObject({ type: "StageChanged", stage: "PREPARING" });
    const detail = fixture.runs.getRunDetail(run.id);
    expect(detail.lastEventSequence).toBe(3);
    expect(detail.events).toHaveLength(3);
    expect(detail.run.stage).toBe("PREPARING");
    expect(detail.run.progressPercent).toBe(10);
    expect(detail.run.activity).toBe("分析中");
    expect(detail.run.startedAt).toBe(T1);
  });

  it("projects a Fake COMPLETED terminal state without creating a Model", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    const events = fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [
        { payload: { type: "StageChanged", stage: "PREPARING", activity: "准备建模任务" }, occurredAt: T1 },
        { payload: { type: "ProgressUpdated", progressPercent: 17, activity: "准备建模任务" }, occurredAt: T2 },
        { payload: { type: "Completed" }, occurredAt: T3 }
      ]
    });
    expect(events.at(-1)?.type).toBe("Completed");
    const detail = fixture.runs.getRunDetail(run.id);
    expect(detail.run.status).toBe("COMPLETED");
    expect(detail.run.completedAt).toBe(T3);
    // F3: terminal runs clear ALL live execution fields (stage/activity/
    // progress) in the read model — the walked history lives in the events.
    expect(detail.run.stage).toBeNull();
    expect(detail.run.activity).toBeNull();
    expect(detail.run.progressPercent).toBeNull();
    expect(detail.run.modelId).toBeNull();
    expect(detail.run.failureCode).toBeNull();
    expect(detail.lastEventSequence).toBe(3);
    // No models row may ever be created by the Fake COMPLETED path.
    const modelCount = fixture.db.prepare("SELECT COUNT(*) AS count FROM models").get() as {
      count: number;
    };
    expect(modelCount.count).toBe(0);
    // Terminal Runs accept no further events.
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "ActivityUpdated", activity: "不该发生" }, occurredAt: T3 }]
      })
    ).toThrowError(/terminal Runs accept no further events/);
  });

  it("rejects a Completed event whose modelId does not resolve and rolls back the batch", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [
          { payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: T1 },
          { payload: { type: "Completed", modelId: "model-ghost" }, occurredAt: T3 }
        ]
      })
    ).toThrowError(RunnerInvariantError);
    // The whole batch rolled back: no events, still RUNNING.
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);
    expect(fixture.runs.getRun(run.id)?.status).toBe("RUNNING");
  });

  it("accepts a Completed event whose modelId resolves to a persisted Model", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    fixture.db
      .prepare(
        "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("model-real", "M01", "drawing-a", "revision-a1", run.id, "PENDING_REVIEW", T3);
    stageRunning(fixture, run.id, T1);
    fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [{ payload: { type: "Completed", modelId: "model-real" }, occurredAt: T3 }]
    });
    const detail = fixture.runs.getRunDetail(run.id);
    expect(detail.run.status).toBe("COMPLETED");
    expect(detail.run.modelId).toBe("model-real");
  });

  it("projects Failed with failure code/message and completedAt", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [
        {
          payload: { type: "Failed", failureCode: "VALIDATION_REJECTED", failureMessage: "重建失败" },
          occurredAt: T3
        }
      ]
    });
    const detail = fixture.runs.getRunDetail(run.id);
    expect(detail.run.status).toBe("FAILED");
    expect(detail.run.failureCode).toBe("VALIDATION_REJECTED");
    expect(detail.run.failureMessage).toBe("重建失败");
    expect(detail.run.completedAt).toBe(T3);
    expect(detail.run.stage).toBeNull();
  });

  it("projects ClarificationRequired as a business outcome, not a failure", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [
        {
          payload: { type: "ClarificationRequired", clarificationRequestId: "clarification-1" },
          occurredAt: T3
        }
      ]
    });
    const detail = fixture.runs.getRunDetail(run.id);
    expect(detail.run.status).toBe("CLARIFICATION_REQUIRED");
    expect(detail.run.clarificationRequestId).toBe("clarification-1");
    expect(detail.run.failureCode).toBeNull();
    expect(detail.run.completedAt).toBe(T3);
  });

  it("projects cancellation onto a QUEUED Run without a startedAt", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [
        { payload: { type: "CancellationRequested", reason: "用户取消" }, occurredAt: T2 },
        { payload: { type: "CancellationConfirmed" }, occurredAt: T2 }
      ]
    });
    const detail = fixture.runs.getRunDetail(run.id);
    expect(detail.run.status).toBe("CANCELLED");
    expect(detail.run.startedAt).toBeNull();
    expect(detail.run.completedAt).toBe(T2);
    expect(detail.run.stage).toBeNull();
    const row = fixture.db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as {
      cancellation_requested_at: string | null;
      cancellation_requested_reason: string | null;
      cancellation_confirmed_at: string | null;
    };
    expect(row.cancellation_requested_at).toBe(T2);
    expect(row.cancellation_requested_reason).toBe("用户取消");
    expect(row.cancellation_confirmed_at).toBe(T2);
    // A CANCELLED Run accepts no further events.
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "CancellationConfirmed" }, occurredAt: T3 }]
      })
    ).toThrowError(/terminal Runs accept no further events/);
  });

  it("enforces non-decreasing occurredAt within and across appends", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [{ payload: { type: "ActivityUpdated", activity: "第一步" }, occurredAt: T2 }]
    });
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "ActivityUpdated", activity: "回到过去" }, occurredAt: T1 }]
      })
    ).toThrowError(/earlier than the previous event time/);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [
          { payload: { type: "ActivityUpdated", activity: "前进" }, occurredAt: T3 },
          { payload: { type: "ActivityUpdated", activity: "倒退" }, occurredAt: T2 }
        ]
      })
    ).toThrowError(/earlier than the previous event time/);
    // Neither rejected append wrote any event.
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(1);
  });

  it("rejects invalid payloads before writing anything", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [
          { payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: T1 },
          { payload: { type: "ProgressUpdated", progressPercent: 150 }, occurredAt: T2 }
        ]
      })
    ).toThrowError(InvalidArgumentError);
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);
  });

  it("rejects events attributed to an attempt row that belongs to another Run", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    const otherRun = createRun(fixture, "drawing-a", "revision-a1", T1);
    fixture.db
      .prepare("INSERT INTO run_attempts (id, run_id, attempt_sequence, created_at) VALUES (?, ?, ?, ?)")
      .run("attempt-foreign", otherRun.id, 1, T0);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-foreign",
        entries: [{ payload: { type: "ActivityUpdated", activity: "越权" }, occurredAt: T1 }]
      })
    ).toThrowError(new RegExp(`belongs to run ${otherRun.id}`));
  });

  it("requires a persisted attempt of the Run before any event is appended", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-ghost",
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T1 }]
      })
    ).toThrowError(NotFoundError);
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);
  });

  it("requires an ACTIVE attempt for non-terminal execution events (P3-3 review fix)", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    // The attempt is finished BEFORE any execution event was emitted (e.g. a
    // raw finish or a crash between the terminal event and the finish): every
    // non-terminal execution event must now be rejected.
    fixture.db
      .prepare("UPDATE run_attempts SET status = 'FINISHED', finished_at = ? WHERE id = ?")
      .run(T2, "attempt-run-1");
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: T3 }]
      })
    ).toThrowError(/requires the ACTIVE attempt .* which is FINISHED/);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "ActivityUpdated", activity: "不该发生" }, occurredAt: T3 }]
      })
    ).toThrowError(/requires the ACTIVE attempt/);
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);

    // Terminal events keep the recovery contract: the wedge repair appends a
    // Failed interruption event referencing an already-terminal attempt.
    const events = fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [{ payload: { type: "Failed", failureCode: "AGENT_INTERRUPTED" }, occurredAt: T3 }]
    });
    expect(events.at(-1)?.type).toBe("Failed");
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(1);
  });

  it("rejects a terminal event that is not the single last event of the batch", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    // Terminal event followed by another event.
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [
          { payload: { type: "Completed" }, occurredAt: T2 },
          { payload: { type: "ActivityUpdated", activity: "不该发生" }, occurredAt: T2 }
        ]
      })
    ).toThrowError(/must be the single last event/);
    // Two terminal events in one batch.
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [
          { payload: { type: "CancellationConfirmed" }, occurredAt: T2 },
          { payload: { type: "CancellationConfirmed" }, occurredAt: T2 }
        ]
      })
    ).toThrowError(/must be the single last event/);
    // Neither rejected batch wrote any event.
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);
  });

  it("rejects execution events on a QUEUED Run (only cancellation is allowed)", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: T1 }]
      })
    ).toThrowError(/is QUEUED; only cancellation events/);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "Completed" }, occurredAt: T1 }]
      })
    ).toThrowError(/is QUEUED; only cancellation events/);
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);
  });

  it("rejects unknown event types before writing anything", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    expect(() =>
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [
          {
            payload: { type: "BogusEvent" } as unknown as RunEventPayload,
            occurredAt: T2
          }
        ]
      })
    ).toThrowError(/Unknown run event type/);
    expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);
  });

  it("canonicalizes offset timestamps to UTC ISO on write", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    // The claim (P3-2) canonicalizes started_at; the event path is what this
    // repository test pins: 17:02+08:00 == 09:02:00Z.
    stageRunning(fixture, run.id, T1);
    const events = fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [
        { payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: "2026-08-13T17:02:00.000+08:00" }
      ]
    });
    expect(events[0]?.occurredAt).toBe("2026-08-13T09:02:00.000Z");
    const detail = fixture.runs.getRunDetail(run.id);
    expect(detail.events[0]?.occurredAt).toBe("2026-08-13T09:02:00.000Z");
  });

  it("surfaces a stored unsupported contract version truthfully", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    fixture.db
      .prepare(
        "INSERT INTO run_events (run_id, sequence, contract_version, attempt_id, payload_json, occurred_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        run.id,
        1,
        99,
        "attempt-run-1",
        JSON.stringify({ type: "ActivityUpdated", activity: "legacy" }),
        T1
      );
    // A stored event from an unsupported contract version is never silently
    // relabeled as the current contract.
    expect(() => fixture.runs.listRunEvents(run.id)).toThrowError(/unsupported contract version 99/);
    expect(() => fixture.runs.getRunDetail(run.id)).toThrowError(/unsupported contract version 99/);
  });
});

describe("RunRepository list and dashboard reads", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = openFixture("run-repo-reads");
    seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
    seedRevision(fixture, "drawing-b", "revision-b1", 1, T0);
  });
  afterAll(() => closeFixture(fixture));

  it("lists Run items per revision/drawing and serves dashboard reads", () => {
    const runA1 = createRun(fixture, "drawing-a", "revision-a1", T1);
    const runA2 = createRun(fixture, "drawing-a", "revision-a1", T2);
    const runB1 = createRun(fixture, "drawing-b", "revision-b1", T3);
    // A RUNNING Run always carries a persisted ACTIVE attempt (claim mints it).
    seedAttempt(fixture, "attempt-runA1", runA1.id);
    stageRunning(fixture, runA1.id, T2);

    const revisionItems = fixture.runs.listRunItemsByRevision("revision-a1");
    expect(revisionItems.map((item) => item.runLabel)).toEqual(["R02", "R01"]);
    expect(revisionItems[0]).toMatchObject({ runId: runA2.id, status: "QUEUED", stage: null, modelId: null });
    expect(fixture.runs.listRunItemsByDrawing("drawing-a")).toHaveLength(2);
    expect(fixture.runs.listRunItemsByDrawing("drawing-b").map((item) => item.runId)).toEqual([runB1.id]);

    const current = fixture.runs.getCurrentRunDetail();
    expect(current?.runId).toBe(runA1.id);
    expect(current?.status).toBe("RUNNING");
    expect(fixture.runs.getQueuedRunLabels()).toEqual(["R02", "R01"]);
  });

  it("reports an empty event stream and sequence 0 before any event", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T1);
    const detail = fixture.runs.getRunDetail(run.id);
    expect(detail.events).toEqual([]);
    expect(detail.lastEventSequence).toBe(0);
  });

  it("throws NOT_FOUND for unknown Run reads", () => {
    expect(() => fixture.runs.getRunDetail("run-ghost")).toThrowError(NotFoundError);
    expect(() => fixture.runs.getRunSnapshot("run-ghost")).toThrowError(NotFoundError);
  });
});

describe("RunRepository clarification answers persist Revision Facts (P4-4)", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = openFixture("run-repo-clarification-facts");
    seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
  });
  afterEach(() => closeFixture(fixture));

  /** Deterministic question set covering every answer kind. */
  const QUESTIONS: readonly ClarificationQuestion[] = [
    { id: "q-dim", type: "dimension", question: "中心孔深度是多少？", hint: "85", unit: "mm" },
    { id: "q-text", type: "text", question: "R5 圆角对应哪一侧？" },
    {
      id: "q-choice",
      type: "choice",
      question: "图纸中的材料无法确认",
      options: [
        { id: "opt-42crmo", label: "42CrMo" },
        { id: "opt-45", label: "45#钢" }
      ]
    }
  ];

  function openRequest(runId: string, createdAt = T1): ClarificationRequest {
    return fixture.runs.persistClarificationRequest({ runId, questions: QUESTIONS, createdAt });
  }

  function submitAnswers(
    requestId: string,
    answers: readonly ClarificationAnswer[],
    answeredAt = T2
  ) {
    return fixture.runs.submitClarificationAnswers({
      clarificationRequestId: requestId,
      answers,
      answeredAt,
      answeredBy: "alice"
    });
  }

  // The persisted request mints fresh question/option ids (caller ids are
  // never trusted as primary keys); answers must reference the persisted ones.
  function questionAt(request: ClarificationRequest, index: number): ClarificationQuestion {
    const question = request.questions[index];
    if (question === undefined) throw new Error(`test question ${index} missing`);
    return question;
  }

  function answerAt(
    request: ClarificationRequest,
    index: number,
    value: ClarificationAnswerValue
  ): ClarificationAnswer {
    const question = questionAt(request, index);
    return { id: `ans-${question.id}`, questionId: question.id, value, answeredAt: T2, answeredBy: "alice" };
  }

  function optionIdAt(request: ClarificationRequest, questionIndex: number, optionIndex: number): string {
    const option = questionAt(request, questionIndex).options?.[optionIndex];
    if (option === undefined) throw new Error(`test option ${optionIndex} missing`);
    return option.id;
  }

  it("persists one deterministic CLARIFICATION Fact per answered question with sourceRunId", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    const request = openRequest(run.id);
    const view = submitAnswers(request.id, [
      answerAt(request, 0, { kind: "dimension", value: 85, unit: "mm" }),
      answerAt(request, 1, { kind: "text", value: "右侧轴肩外缘" }),
      answerAt(request, 2, { kind: "choice", optionId: optionIdAt(request, 2, 0) })
    ]);
    expect(view.status).toBe("ANSWERED");
    expect(view.answers).toHaveLength(3);

    const facts = fixture.store.listRevisionFacts("revision-a1");
    expect(facts).toHaveLength(3);
    const byField = new Map(facts.map((fact) => [fact.field, fact] as const));
    // Stable, auditable fact content per answer kind: dimension value with
    // unit, text verbatim, choice resolved to the option label. The id is
    // deterministic (`fact-{revisionId}-{field}`) and every fact records the
    // answering Run as sourceRunId.
    expect(byField.get("中心孔深度是多少？")).toEqual({
      id: "fact-revision-a1-中心孔深度是多少？",
      revisionId: "revision-a1",
      field: "中心孔深度是多少？",
      value: "85 mm",
      source: "CLARIFICATION",
      sourceRunId: run.id,
      createdAt: T2
    });
    expect(byField.get("R5 圆角对应哪一侧？")).toMatchObject({
      id: "fact-revision-a1-R5 圆角对应哪一侧？",
      value: "右侧轴肩外缘",
      source: "CLARIFICATION",
      sourceRunId: run.id
    });
    expect(byField.get("图纸中的材料无法确认")).toMatchObject({
      id: "fact-revision-a1-图纸中的材料无法确认",
      value: "42CrMo",
      source: "CLARIFICATION",
      sourceRunId: run.id
    });
  });

  it("keeps the old Run terminal and freezes the clarified facts into the next manual Run snapshot", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    seedAttempt(fixture, "attempt-run-1", run.id);
    stageRunning(fixture, run.id, T1);
    const request = openRequest(run.id, T2);
    fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId: "attempt-run-1",
      entries: [
        { payload: { type: "ClarificationRequired", clarificationRequestId: request.id }, occurredAt: T2 }
      ]
    });
    const before = fixture.runs.getRunDetail(run.id);
    expect(before.run.status).toBe("CLARIFICATION_REQUIRED");

    submitAnswers(request.id, [answerAt(request, 0, { kind: "dimension", value: 85, unit: "mm" })]);

    // The old Run stays terminal CLARIFICATION_REQUIRED: no event is appended,
    // the Run is never resumed.
    const after = fixture.runs.getRunDetail(run.id);
    expect(after.run.status).toBe("CLARIFICATION_REQUIRED");
    expect(after.lastEventSequence).toBe(before.lastEventSequence);
    expect(after.events).toHaveLength(before.events.length);

    // The user's manual new Run freezes the clarified fact (sourceRunId =
    // the old answering Run) into its Input Snapshot — the closure of the
    // clarification loop.
    const next = createRun(fixture, "drawing-a", "revision-a1", T3);
    expect(next.number).toBe("R02");
    expect(next.inputSnapshot.revisionFacts).toEqual([
      {
        id: "fact-revision-a1-中心孔深度是多少？",
        revisionId: "revision-a1",
        field: "中心孔深度是多少？",
        value: "85 mm",
        source: "CLARIFICATION",
        sourceRunId: run.id,
        createdAt: T2
      }
    ]);
  });

  it("rejects repeated submission without duplicating answers or facts", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    const request = openRequest(run.id);
    submitAnswers(request.id, [
      answerAt(request, 0, { kind: "dimension", value: 85, unit: "mm" }),
      answerAt(request, 1, { kind: "text", value: "右侧轴肩外缘" })
    ]);
    const factsAfterFirst = fixture.store.listRevisionFacts("revision-a1");
    expect(factsAfterFirst).toHaveLength(2);

    // A repeated submission of the same (or different) answers is honestly
    // rejected: the request is already ANSWERED, so no answer and no fact row
    // can ever be duplicated.
    expect(() =>
      submitAnswers(request.id, [answerAt(request, 0, { kind: "dimension", value: 85, unit: "mm" })])
    ).toThrowError(RunnerInvariantError);
    expect(() =>
      submitAnswers(request.id, [
        answerAt(request, 0, { kind: "dimension", value: 90, unit: "mm" }),
        answerAt(request, 1, { kind: "text", value: "另一侧" })
      ])
    ).toThrowError(RunnerInvariantError);

    expect(fixture.store.listRevisionFacts("revision-a1")).toEqual(factsAfterFirst);
    const view = fixture.runs.getClarificationView(request.id);
    expect(view.status).toBe("ANSWERED");
    expect(view.answers).toHaveLength(2);
  });

  it("rolls back answers and facts when any answer of the batch is invalid", () => {
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    const request = openRequest(run.id);
    // The first answer is valid, the second selects an unknown choice option:
    // the WHOLE batch must be rejected before anything is written.
    expect(() =>
      submitAnswers(request.id, [
        answerAt(request, 0, { kind: "dimension", value: 85, unit: "mm" }),
        answerAt(request, 2, { kind: "choice", optionId: "opt-unknown" })
      ])
    ).toThrowError(InvalidArgumentError);

    // No partial commit: the request stays OPEN with zero answers and zero
    // facts.
    const view = fixture.runs.getClarificationView(request.id);
    expect(view.status).toBe("OPEN");
    expect(view.answers).toHaveLength(0);
    expect(fixture.store.listRevisionFacts("revision-a1")).toHaveLength(0);

    // A duplicate answer for the same question is also rejected atomically.
    expect(() =>
      submitAnswers(request.id, [
        answerAt(request, 0, { kind: "dimension", value: 85, unit: "mm" }),
        answerAt(request, 0, { kind: "dimension", value: 90, unit: "mm" })
      ])
    ).toThrowError(/answered more than once/);
    expect(fixture.runs.getClarificationView(request.id).status).toBe("OPEN");
    expect(fixture.store.listRevisionFacts("revision-a1")).toHaveLength(0);
  });

  it("replaces a previous fact of the same revision field instead of duplicating", () => {
    const run1 = createRun(fixture, "drawing-a", "revision-a1", T0);
    const request1 = openRequest(run1.id, T1);
    submitAnswers(request1.id, [answerAt(request1, 0, { kind: "dimension", value: 85, unit: "mm" })], T2);
    expect(fixture.store.listRevisionFacts("revision-a1")).toHaveLength(1);

    // A later Run re-asks the same question: the deterministic fact id
    // targets the SAME record, so the upsert replaces it — exactly one
    // canonical fact per (revision, field) survives, pointing at the newest
    // answering Run.
    const run2 = createRun(fixture, "drawing-a", "revision-a1", T3);
    const request2 = openRequest(run2.id, T3);
    submitAnswers(request2.id, [answerAt(request2, 0, { kind: "dimension", value: 90, unit: "mm" })], T3);

    const facts = fixture.store.listRevisionFacts("revision-a1");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      id: "fact-revision-a1-中心孔深度是多少？",
      value: "90 mm",
      source: "CLARIFICATION",
      sourceRunId: run2.id,
      createdAt: T3
    });
  });

  it("replaces a pre-existing non-CLARIFICATION fact of the same revision field", () => {
    fixture.store.addRevisionFact({
      id: "fact-supplement-1",
      revisionId: "revision-a1",
      field: "中心孔深度是多少？",
      value: "旧值 80 mm",
      source: "USER_SUPPLEMENT",
      createdAt: T0
    });
    const run = createRun(fixture, "drawing-a", "revision-a1", T0);
    const request = openRequest(run.id);
    submitAnswers(request.id, [answerAt(request, 0, { kind: "dimension", value: 85, unit: "mm" })]);

    const facts = fixture.store.listRevisionFacts("revision-a1");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      id: "fact-revision-a1-中心孔深度是多少？",
      value: "85 mm",
      source: "CLARIFICATION",
      sourceRunId: run.id
    });
  });
});

describe("RunRepository concurrency with node:sqlite", () => {
  it("serializes concurrent writers so sequences stay strictly monotonic and unique", () => {
    const dir = makeTempDir("run-repo-concurrent");
    const dbPath = join(dir, "state", "swpanel.db");
    const first = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
    first.open();
    const firstStore = new SqliteRepository(first);
    const firstRuns = new RunRepository(first, firstStore);
    seedRevision(
      { dir, dbPath, db: first, store: firstStore, runs: firstRuns },
      "drawing-a",
      "revision-a1",
      1,
      T0
    );
    const run = firstRuns.createRun({ drawingId: "drawing-a", revisionId: "revision-a1", profile: PROFILE, createdAt: T0 });
    // The persisted attempt the events reference (visible to both connections).
    // In production the claim mints this ACTIVE attempt in the same transaction
    // as the QUEUED -> RUNNING transition; the repository tests stage both.
    first
      .prepare(
        "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, created_at) " +
          "VALUES ('attempt-run-1', ?, 1, 'ACTIVE', ?)"
      )
      .run(run.id, T0);
    first
      .prepare(
        "UPDATE runs SET status = 'RUNNING', started_at = COALESCE(started_at, ?) " +
          "WHERE id = ? AND status = 'QUEUED'"
      )
      .run(T1, run.id);

    // A second independent connection to the same WAL database.
    const second = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
    second.open();
    const secondRuns = new RunRepository(second, new SqliteRepository(second));

    try {
      const times = [T1, "2026-08-13T09:01:01.000Z", "2026-08-13T09:01:02.000Z"];
      secondRuns.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "ActivityUpdated", activity: "writer-b" }, occurredAt: times[1] as string }]
      });
      firstRuns.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "ActivityUpdated", activity: "writer-a" }, occurredAt: times[2] as string }]
      });
      secondRuns.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-run-1",
        entries: [{ payload: { type: "Completed" }, occurredAt: times[2] as string }]
      });

      const events = firstRuns.listRunEvents(run.id);
      const sequences = events.map((event) => event.sequence);
      expect(sequences).toEqual([...new Set(sequences)].sort((a, b) => a - b));
      expect(sequences).toEqual([1, 2, 3]);
      expect(events.at(-1)?.type).toBe("Completed");
      const detail = firstRuns.getRunDetail(run.id);
      expect(detail.run.status).toBe("COMPLETED");
      expect(detail.lastEventSequence).toBe(3);
    } finally {
      second.close();
      first.close();
      removeTempDir(dir);
    }
  });

  it("lets exactly one RUNNING Run exist (single-active-run index defense)", () => {
    const fixture = openFixture("run-repo-single-running");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run1 = createRun(fixture, "drawing-a", "revision-a1", T1);
      const run2 = createRun(fixture, "drawing-a", "revision-a1", T2);
      // Each candidate carries a persisted ACTIVE attempt (claim mints one).
      seedAttempt(fixture, "attempt-run1", run1.id);
      seedAttempt(fixture, "attempt-run2", run2.id);
      stageRunning(fixture, run1.id, T1);
      // The DB unique index refuses a second RUNNING Run even through raw
      // writes; the atomic claim converts the same violation into a clean
      // `null` claim (covered by the orchestrator tests).
      expect(() => stageRunning(fixture, run2.id, T2)).toThrow();
      expect(fixture.runs.getRun(run1.id)?.status).toBe("RUNNING");
      expect(fixture.runs.getRun(run2.id)?.status).toBe("QUEUED");
    } finally {
      closeFixture(fixture);
    }
  });

  it("never notifies committed listeners for a rolled-back event batch (H1)", () => {
    const fixture = openFixture("run-repo-rollback-events");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createRun(fixture, "drawing-a", "revision-a1", T0);
      const attemptId = "attempt-rollback";
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, kind, created_at) " +
            "VALUES (?, ?, 1, 'ACTIVE', 'EXECUTION', ?)"
        )
        .run(attemptId, run.id, T0);
      // Execution events require a RUNNING Run (the claim transition).
      stageRunning(fixture, run.id, T0);
      const batches: number[][] = [];
      fixture.runs.addRunEventsCommittedListener((events) =>
        batches.push(events.map((event) => event.sequence))
      );

      // The append happens inside an OUTER transaction that later rolls back:
      // the after-commit hook must be DISCARDED with the transaction and never
      // fire on a later unrelated commit.
      expect(() =>
        fixture.db.transaction(() => {
          fixture.runs.appendRunEvents({
            runId: run.id,
            attemptId,
            entries: [
              { payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: T1 }
            ]
          });
          throw new Error("boom");
        })
      ).toThrow("boom");
      expect(batches).toEqual([]);
      expect(fixture.runs.listRunEvents(run.id)).toEqual([]);

      // A later successful append notifies ONLY its own committed events.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId,
        entries: [{ payload: { type: "StageChanged", stage: "ANALYZING" }, occurredAt: T2 }]
      });
      expect(batches).toEqual([[1]]);
      expect(fixture.runs.listRunEvents(run.id)).toHaveLength(1);
    } finally {
      closeFixture(fixture);
    }
  });
});

describe("RunRepository deletion (Phase 8)", () => {
  /** Ends a QUEUED Run as COMPLETED through the repository projection surface. */
  function completeRun(fixture: Fixture, run: { id: string }, attemptId = "attempt-del-1"): void {
    seedAttempt(fixture, attemptId, run.id);
    stageRunning(fixture, run.id, T1);
    fixture.runs.appendRunEvents({
      runId: run.id,
      attemptId,
      entries: [
        { payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: T1 },
        { payload: { type: "Completed" }, occurredAt: T3 }
      ]
    });
    expect(fixture.runs.getRun(run.id)?.status).toBe("COMPLETED");
  }

  function countRows(fixture: Fixture, table: string): number {
    return (fixture.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
      .count;
  }

  it("rejects deleting a Run that does not exist", () => {
    const fixture = openFixture("run-repo-delete-missing");
    try {
      seedRevision(fixture, "drawing-del-missing", "revision-del-missing", 1);
      expect(() =>
        fixture.runs.deleteRun("run-ghost", "drawing-del-missing", "revision-del-missing")
      ).toThrowError(NotFoundError);
    } finally {
      closeFixture(fixture);
    }
  });

  it("rejects deleting a Run of a mismatched drawing/revision pair", () => {
    const fixture = openFixture("run-repo-delete-wrong-pair");
    try {
      seedRevision(fixture, "drawing-del-a", "revision-del-a1", 1);
      const run = createRun(fixture, "drawing-del-a", "revision-del-a1", T0);
      completeRun(fixture, run);
      expect(() => fixture.runs.deleteRun(run.id, "drawing-other", "revision-other")).toThrowError(
        expect.objectContaining({ code: "DOMAIN_INVARIANT" })
      );
      // The Run is untouched by the rejected deletion.
      expect(fixture.runs.getRun(run.id)?.status).toBe("COMPLETED");
    } finally {
      closeFixture(fixture);
    }
  });

  it("rejects active QUEUED and RUNNING Runs with RUN_NOT_TERMINAL", () => {
    const fixture = openFixture("run-repo-delete-active");
    try {
      seedRevision(fixture, "drawing-del-active", "revision-del-active1", 1);
      const queued = createRun(fixture, "drawing-del-active", "revision-del-active1", T0);
      expect(() =>
        fixture.runs.deleteRun(queued.id, "drawing-del-active", "revision-del-active1")
      ).toThrowError(
        expect.objectContaining({
          code: "DOMAIN_INVARIANT",
          details: expect.objectContaining({ reason: "RUN_NOT_TERMINAL" }) as object
        })
      );

      const running = createRun(fixture, "drawing-del-active", "revision-del-active1", T1);
      seedAttempt(fixture, "attempt-running", running.id, 1);
      stageRunning(fixture, running.id, T2);
      expect(() =>
        fixture.runs.deleteRun(running.id, "drawing-del-active", "revision-del-active1")
      ).toThrowError(
        expect.objectContaining({
          code: "DOMAIN_INVARIANT",
          details: expect.objectContaining({ reason: "RUN_NOT_TERMINAL" }) as object
        })
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it("rejects a CLARIFICATION_REQUIRED Run (its clarification session is the user's responsibility)", () => {
    const fixture = openFixture("run-repo-delete-clarification");
    try {
      seedRevision(fixture, "drawing-del-clar", "revision-del-clar1", 1);
      const run = createRun(fixture, "drawing-del-clar", "revision-del-clar1", T0);
      seedAttempt(fixture, "attempt-clar", run.id);
      stageRunning(fixture, run.id, T1);
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-clar",
        entries: [
          {
            payload: { type: "ClarificationRequired", clarificationRequestId: "req-clar" },
            occurredAt: T3
          }
        ]
      });
      expect(() =>
        fixture.runs.deleteRun(run.id, "drawing-del-clar", "revision-del-clar1")
      ).toThrowError(
        expect.objectContaining({
          code: "DOMAIN_INVARIANT",
          details: expect.objectContaining({ reason: "RUN_HAS_PENDING_CLARIFICATION" }) as object
        })
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it("deletes a COMPLETED Run and every owned row transactionally", () => {
    const fixture = openFixture("run-repo-delete-completed");
    try {
      seedRevision(fixture, "drawing-del-c", "revision-del-c1", 1);
      const run = createRun(fixture, "drawing-del-c", "revision-del-c1", T0);
      // A clarification chain persisted on the Run.
      const request = fixture.runs.persistClarificationRequest({
        runId: run.id,
        questions: [
          {
            id: "q-del-1",
            type: "dimension",
            question: "长度"
          }
        ],
        createdAt: T1
      });
      expect(request.questions).toHaveLength(1);
      completeRun(fixture, run);
      // A published Model + review + artifact all bound to the Run.
      fixture.db
        .prepare(
          "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
            "VALUES (?, 'M01', ?, ?, ?, 'APPROVED', ?)"
        )
        .run("model-del-1", "drawing-del-c", "revision-del-c1", run.id, T3);
      fixture.db
        .prepare(
          "INSERT INTO model_reviews (id, model_id, result, reviewer_id, comment, created_at) " +
            "VALUES (?, ?, 'APPROVED', 'alice', NULL, ?)"
        )
        .run("review-del-1", "model-del-1", T3);
      fixture.db
        .prepare(
          "INSERT INTO artifacts (id, run_id, model_id, kind, file_name, relative_path, size_bytes, sha256, mime_type, created_at) " +
            "VALUES (?, ?, ?, 'SLDPRT', 'part.sldprt', 'output/part.sldprt', 10, 'aaa', NULL, ?)"
        )
        .run("artifact-del-1", run.id, "model-del-1", T3);

      const result = fixture.runs.deleteRun(run.id, "drawing-del-c", "revision-del-c1");
      expect(result.runId).toBe(run.id);
      expect(result.attemptSequences).toEqual([1]);

      expect(fixture.runs.getRun(run.id)).toBeNull();
      expect(fixture.runs.listRunEvents(run.id)).toEqual([]);
      expect(() => fixture.runs.getRunDetail(run.id)).toThrowError(NotFoundError);
      expect(countRows(fixture, "run_input_snapshots")).toBe(0);
      expect(countRows(fixture, "run_attempts")).toBe(0);
      expect(countRows(fixture, "clarification_requests")).toBe(0);
      expect(countRows(fixture, "clarification_questions")).toBe(0);
      expect(countRows(fixture, "clarification_answers")).toBe(0);
      expect(countRows(fixture, "model_reviews")).toBe(0);
      expect(countRows(fixture, "artifacts")).toBe(0);
      expect(countRows(fixture, "models")).toBe(0);
      expect(countRows(fixture, "runs")).toBe(0);
    } finally {
      closeFixture(fixture);
    }
  });

  it("clears the Revision's approved-Model pointer when the deleted Run's Model was current-approved", () => {
    const fixture = openFixture("run-repo-delete-approved-model");
    try {
      seedRevision(fixture, "drawing-del-approve", "revision-del-approve1", 1);
      const run = createRun(fixture, "drawing-del-approve", "revision-del-approve1", T0);
      completeRun(fixture, run);
      fixture.store.updateCurrentApprovedModelPointer("revision-del-approve1", "model-del-approved", T3);
      fixture.db
        .prepare(
          "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
            "VALUES (?, 'M01', ?, ?, ?, 'APPROVED', ?)"
        )
        .run("model-del-approved", "drawing-del-approve", "revision-del-approve1", run.id, T3);

      fixture.runs.deleteRun(run.id, "drawing-del-approve", "revision-del-approve1");
      expect(fixture.store.getRevision("revision-del-approve1")?.currentApprovedModelId).toBeNull();
    } finally {
      closeFixture(fixture);
    }
  });

  it("deletes FAILED and CANCELLED terminal Runs", () => {
    const fixture = openFixture("run-repo-delete-terminal-kinds");
    try {
      seedRevision(fixture, "drawing-del-kinds", "revision-del-kinds1", 1);
      const failed = createRun(fixture, "drawing-del-kinds", "revision-del-kinds1", T0);
      seedAttempt(fixture, "attempt-failed", failed.id, 1);
      stageRunning(fixture, failed.id, T1);
      fixture.runs.appendRunEvents({
        runId: failed.id,
        attemptId: "attempt-failed",
        entries: [{ payload: { type: "Failed", failureCode: "AGENT_TIMEOUT" }, occurredAt: T2 }]
      });
      expect(fixture.runs.getRun(failed.id)?.status).toBe("FAILED");
      fixture.runs.deleteRun(failed.id, "drawing-del-kinds", "revision-del-kinds1");
      expect(fixture.runs.getRun(failed.id)).toBeNull();

      const cancelled = createRun(fixture, "drawing-del-kinds", "revision-del-kinds1", T1);
      seedAttempt(fixture, "attempt-cancelled", cancelled.id, 1);
      fixture.runs.appendRunEvents({
        runId: cancelled.id,
        attemptId: "attempt-cancelled",
        entries: [
          { payload: { type: "CancellationRequested" }, occurredAt: T2 },
          { payload: { type: "CancellationConfirmed" }, occurredAt: T2 }
        ]
      });
      expect(fixture.runs.getRun(cancelled.id)?.status).toBe("CANCELLED");
      fixture.runs.deleteRun(cancelled.id, "drawing-del-kinds", "revision-del-kinds1");
      expect(fixture.runs.getRun(cancelled.id)).toBeNull();
    } finally {
      closeFixture(fixture);
    }
  });
});
