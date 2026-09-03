import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Drawing, DrawingRevision, RevisionSourceFile, RunStage } from "@swpanel/domain";
import { NotFoundError, RunnerInvariantError } from "../errors.js";
import { makeTempDir, removeTempDir, samplePdfBytes, sha256Of } from "../test-utils.js";
import { SqliteDatabase } from "../db/database.js";
import { SqliteRepository } from "../db/repository.js";
import { RunRepository, type RunProfile } from "../db/run-repository.js";
import { FAKE_PREFLIGHT_SKILL_SHA256 } from "../preflight/preflight.js";
import { Runner } from "../runner.js";
import {
  LiveForeignLeaseError,
  RunOrchestrator,
  type RecoveryScanEntry,
  type RunClaim,
  type RunRecoveryCapabilities,
  type RunOrchestratorOptions
} from "./run-orchestrator.js";

const T0 = "2026-08-13T09:00:00.000Z";
const T1 = "2026-08-13T09:01:00.000Z";
const T2 = "2026-08-13T09:02:00.000Z";
const T3 = "2026-08-13T09:03:00.000Z";

const PROFILE: RunProfile = {
  promptTemplateVersion: "prompt-template-v3",
  // Runner-based facade flows hit the ALWAYS-active synthetic preflight gate
  // at PREPARING: the all-pass path freezes the fixture's exact digest.
  skill: { name: "solidworks-build-part-from-drawing", sha256: FAKE_PREFLIGHT_SKILL_SHA256 },
  agentConfigId: "agent-config-1"
};

/** Deterministic injected clock. */
function makeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => new Date(current),
    set(iso: string): void {
      current = Date.parse(iso);
    },
    advance(ms: number): void {
      current += ms;
    },
    getMs(): number {
      return current;
    }
  };
}

interface Fixture {
  dir: string;
  dbPath: string;
  db: SqliteDatabase;
  store: SqliteRepository;
  runs: RunRepository;
  orchestrator: RunOrchestrator;
  clock: ReturnType<typeof makeClock>;
}

function openFixture(
  prefix: string,
  options: { leaseDurationMs?: number; recoveryCapabilities?: RunRecoveryCapabilities; start?: string } = {}
): Fixture {
  const dir = makeTempDir(prefix);
  const dbPath = join(dir, "state", "swpanel.db");
  const db = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  const runs = new RunRepository(db, store);
  const clock = makeClock(Date.parse(options.start ?? T0));
  const orchestrator = new RunOrchestrator(db, runs, {
    now: clock.now,
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    ...(options.recoveryCapabilities === undefined
      ? {}
      : { recoveryCapabilities: options.recoveryCapabilities })
  });
  return { dir, dbPath, db, store, runs, orchestrator, clock };
}

function closeFixture(fixture: Fixture): void {
  if (fixture.db.isOpen) fixture.db.close();
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

function createQueuedRun(fixture: Fixture, createdAt = T0) {
  return fixture.runs.createRun({ drawingId: "drawing-a", revisionId: "revision-a1", profile: PROFILE, createdAt });
}

/** Raw QUEUED Run insert (controlled id/created_at for tie-breaker tests). */
function insertQueuedRun(db: SqliteDatabase, id: string, number: string, createdAt: string): void {
  db.prepare(
    "INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) " +
      "VALUES (?, ?, 'drawing-x', 'revision-x', 'QUEUED', ?)"
  ).run(id, number, createdAt);
}

/**
 * Seeds a resolvable QUEUED Run for the Runner-facade tests: a real Drawing +
 * Revision + frozen snapshot + immutable ledger source file. Phase 4 (P4-1)
 * input preparation runs at PREPARING on every claim, so facade flows must
 * reference a REAL resolvable source (the Runner resolver verifies the ledger
 * copy against the recorded size/hash — an unresolvable source fails closed).
 */
function insertResolvableQueuedRun(
  db: SqliteDatabase,
  dir: string,
  id: string,
  number: string,
  createdAt: string
): void {
  const store = new SqliteRepository(db);
  const drawingId = `drawing-${id}`;
  const revisionId = `revision-${id}`;
  const relativePath = `library/drawings/file-${id}/source/original.pdf`;
  const sourceBytes = samplePdfBytes();
  const absolutePath = join(dir, ...relativePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, sourceBytes);
  const sourceFile: RevisionSourceFile = {
    id: `file-${id}`,
    fileName: `original-${id}.pdf`,
    format: "PDF",
    sizeBytes: sourceBytes.byteLength,
    sha256: sha256Of(sourceBytes),
    relativePath,
    uploadedAt: createdAt
  };
  db.transaction(() => {
    store.insertDrawing({
      id: drawingId,
      drawingNumber: `D-${id}`,
      name: `Drawing ${id}`,
      currentRevisionId: null,
      createdAt,
      updatedAt: createdAt
    });
    store.insertRevisionFile(sourceFile);
    store.insertRevision({
      id: revisionId,
      drawingId,
      sequence: 1,
      sourceFile,
      currentApprovedModelId: null,
      createdAt,
      updatedAt: createdAt
    });
    store.setCurrentRevisionPointer(drawingId, revisionId, createdAt);
    db.prepare(
      "INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) " +
        "VALUES (?, ?, ?, ?, 'QUEUED', ?)"
    ).run(id, number, drawingId, revisionId, createdAt);
    db.prepare("INSERT INTO run_input_snapshots (run_id, payload_json) VALUES (?, ?)").run(
      id,
      JSON.stringify({
        drawingId,
        revisionId,
        originalFileRef: relativePath,
        revisionFacts: [],
        modelingFeedback: [],
        promptTemplateVersion: PROFILE.promptTemplateVersion,
        skill: PROFILE.skill,
        agentConfigId: PROFILE.agentConfigId,
        createdAt
      })
    );
  });
}

/** Appends the Fake COMPLETED terminal event and finishes the attempt FINISHED. */
function completeRun(fixture: Fixture, claim: RunClaim, completedAt: string): void {
  fixture.runs.appendRunEvents({
    runId: claim.runId,
    attemptId: claim.attempt.id,
    entries: [{ payload: { type: "Completed" }, occurredAt: completedAt }]
  });
  fixture.orchestrator.finishAttempt({
    runId: claim.runId,
    attemptId: claim.attempt.id,
    ownerToken: fixture.orchestrator.ownerToken,
    status: "FINISHED",
    finishedAt: completedAt
  });
}

function stageRun(fixture: Fixture, claim: RunClaim, stage: RunStage, occurredAt: string): void {
  fixture.runs.appendRunEvents({
    runId: claim.runId,
    attemptId: claim.attempt.id,
    entries: [{ payload: { type: "StageChanged", stage }, occurredAt }]
  });
}

function runRow(db: SqliteDatabase, runId: string) {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as {
    status: string;
    stage: string | null;
    started_at: string | null;
    completed_at: string | null;
    failure_code: string | null;
    failure_message: string | null;
    model_id: string | null;
  };
}

function attemptRow(db: SqliteDatabase, attemptId: string) {
  return db.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId) as {
    status: string | null;
    owner_token: string | null;
    claimed_at: string | null;
    lease_deadline_at: string | null;
    heartbeat_at: string | null;
    started_at: string | null;
    finished_at: string | null;
    interruption_kind: string | null;
    recovery_decision: string | null;
  };
}

function eventTypesOf(fixture: Fixture, runId: string): string[] {
  return fixture.runs.listRunEvents(runId).map((event) => event.type);
}

function scalar(db: SqliteDatabase, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

function runningCount(db: SqliteDatabase): number {
  return scalar(db, "SELECT COUNT(*) AS count FROM runs WHERE status = 'RUNNING'");
}

function attemptCount(db: SqliteDatabase): number {
  return scalar(db, "SELECT COUNT(*) AS count FROM run_attempts");
}

function modelCount(db: SqliteDatabase): number {
  return scalar(db, "SELECT COUNT(*) AS count FROM models");
}

/** Reopens the same database file as a fresh Runner process would. */
function reopen(
  fixture: Fixture,
  clock: ReturnType<typeof makeClock>,
  options: RunOrchestratorOptions = {}
): { db: SqliteDatabase; store: SqliteRepository; runs: RunRepository; orchestrator: RunOrchestrator } {
  fixture.db.close();
  const db = new SqliteDatabase({ dbPath: fixture.dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  const runs = new RunRepository(db, store);
  const orchestrator = new RunOrchestrator(db, runs, { now: clock.now, ...options });
  return { db, store, runs, orchestrator };
}

describe("RunOrchestrator atomic claim", () => {
  const fixtures: Fixture[] = [];
  beforeAll(() => {
    const fixture = openFixture("orch-claim");
    fixtures.push(fixture);
    seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
  });
  afterAll(() => {
    for (const fixture of fixtures) closeFixture(fixture);
  });

  it("atomically claims the oldest QUEUED Run with a persisted ACTIVE attempt and canonical claim timestamps", () => {
    const fixture = fixtures[0] as Fixture;
    const first = createQueuedRun(fixture, T0);
    const second = createQueuedRun(fixture, T1);
    fixture.clock.set(T2);

    const claim = fixture.orchestrator.claimNextQueuedRun();
    expect(claim).not.toBeNull();
    expect(claim?.runId).toBe(first.id);
    expect(claim?.runNumber).toBe("R01");
    expect(claim?.attempt).toMatchObject({
      runId: first.id,
      attemptSequence: 1,
      status: "ACTIVE",
      ownerToken: fixture.orchestrator.ownerToken,
      claimedAt: T2,
      startedAt: T2,
      heartbeatAt: T2,
      leaseDeadlineAt: T3 // T2 + 60s default lease
    });
    expect(claim?.attempt.finishedAt).toBeUndefined();
    expect(claim?.attempt.interruptionKind).toBeUndefined();
    expect(claim?.attempt.recoveryDecision).toBeUndefined();

    // The persisted attempt reads back identically through the read surface.
    expect(fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "")).toEqual(claim?.attempt);

    // The Run transitioned QUEUED -> RUNNING atomically with startedAt.
    expect(runRow(fixture.db, first.id)).toMatchObject({ status: "RUNNING", started_at: T2 });
    expect(fixture.runs.getRun(first.id)?.status).toBe("RUNNING");
    expect(runRow(fixture.db, second.id).status).toBe("QUEUED");
    expect(fixture.runs.getQueuedRunLabels()).toEqual(["R02"]);
    expect(runningCount(fixture.db)).toBe(1);
    expect(attemptCount(fixture.db)).toBe(1);
  });

  it("claims QUEUED Runs in FIFO order with the created_at/id tie-breaker", () => {
    const fixture = openFixture("orch-fifo");
    try {
      insertQueuedRun(fixture.db, "run-aaa", "R10", T0);
      insertQueuedRun(fixture.db, "run-bbb", "R11", T0); // same createdAt: id tie-break
      insertQueuedRun(fixture.db, "run-ccc", "R12", T1);
      fixture.clock.set(T2);

      const first = fixture.orchestrator.claimNextQueuedRun();
      expect(first?.runId).toBe("run-aaa");
      expect(first?.attempt.attemptSequence).toBe(1);
      completeRun(fixture, first as RunClaim, T2);

      const second = fixture.orchestrator.claimNextQueuedRun();
      expect(second?.runId).toBe("run-bbb");
      completeRun(fixture, second as RunClaim, T2);

      const third = fixture.orchestrator.claimNextQueuedRun();
      expect(third?.runId).toBe("run-ccc");
      expect(fixture.orchestrator.claimNextQueuedRun()).toBeNull();
    } finally {
      closeFixture(fixture);
    }
  });

  it("returns null when the queue is empty", () => {
    const fixture = openFixture("orch-empty");
    try {
      expect(fixture.orchestrator.claimNextQueuedRun()).toBeNull();
      expect(attemptCount(fixture.db)).toBe(0);
    } finally {
      closeFixture(fixture);
    }
  });

  it("a busy owner (unfinished attempt) gets no second claim and leaves the candidate QUEUED", () => {
    const fixture = openFixture("orch-owner-busy");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      const second = createQueuedRun(fixture, T1);
      fixture.clock.set(T2);

      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(first.id);
      // Same owner still holds an unfinished attempt: no second claim.
      expect(fixture.orchestrator.claimNextQueuedRun()).toBeNull();
      expect(runRow(fixture.db, second.id).status).toBe("QUEUED");
      expect(attemptCount(fixture.db)).toBe(1);
      expect(runningCount(fixture.db)).toBe(1);
    } finally {
      closeFixture(fixture);
    }
  });
});

describe("RunOrchestrator claim across two SQLite connections", () => {
  it("one winner, the loser gets null instead of a raw SQLite failure", () => {
    const dir = makeTempDir("orch-two-connections");
    const dbPath = join(dir, "state", "swpanel.db");
    const dbA = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
    dbA.open();
    const storeA = new SqliteRepository(dbA);
    const runsA = new RunRepository(dbA, storeA);
    const fixtureA = { dir, dbPath, db: dbA, store: storeA, runs: runsA, orchestrator: new RunOrchestrator(dbA, runsA, { now: makeClock(Date.parse(T1)).now }), clock: makeClock(Date.parse(T1)) };
    const dbB = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
    try {
      seedRevision(fixtureA, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixtureA, T0);
      dbB.open();
      const runsB = new RunRepository(dbB, new SqliteRepository(dbB));
      const orchestratorB = new RunOrchestrator(dbB, runsB, { now: makeClock(Date.parse(T1)).now });

      // Two independent connections race for the single QUEUED Run.
      const winner = fixtureA.orchestrator.claimNextQueuedRun();
      expect(winner?.runId).toBe(run.id);
      const loser = orchestratorB.claimNextQueuedRun();
      expect(loser).toBeNull();

      // Exactly one RUNNING Run and one persisted attempt survive the race.
      expect(runningCount(dbA)).toBe(1);
      expect(runningCount(dbB)).toBe(1);
      expect(attemptCount(dbA)).toBe(1);

      // The loser is not poisoned: once the winner completes, the loser can
      // still claim (here the queue is simply empty).
      completeRun(fixtureA, winner as RunClaim, T2);
      expect(orchestratorB.claimNextQueuedRun()).toBeNull();
      expect(runningCount(dbB)).toBe(0);
    } finally {
      dbB.close();
      dbA.close();
      removeTempDir(dir);
    }
  });

  it("keeps the single active Run invariant across owners and recovers the second owner", () => {
    const dir = makeTempDir("orch-single-active");
    const dbPath = join(dir, "state", "swpanel.db");
    const dbA = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
    dbA.open();
    const storeA = new SqliteRepository(dbA);
    const runsA = new RunRepository(dbA, storeA);
    const orchestratorA = new RunOrchestrator(dbA, runsA, { now: makeClock(Date.parse(T1)).now });
    const fixtureA = { dir, dbPath, db: dbA, store: storeA, runs: runsA, orchestrator: orchestratorA, clock: makeClock(Date.parse(T1)) };
    const dbB = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
    try {
      seedRevision(fixtureA, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixtureA, T0);
      const second = createQueuedRun(fixtureA, T1);
      dbB.open();
      const runsB = new RunRepository(dbB, new SqliteRepository(dbB));
      const orchestratorB = new RunOrchestrator(dbB, runsB, { now: makeClock(Date.parse(T1)).now });

      const claimA = orchestratorA.claimNextQueuedRun();
      expect(claimA?.runId).toBe(first.id);
      // While A's Run is RUNNING, B must not claim the second Run.
      expect(orchestratorB.claimNextQueuedRun()).toBeNull();
      expect(runRow(dbB, second.id).status).toBe("QUEUED");
      expect(runningCount(dbB)).toBe(1);
      expect(attemptCount(dbB)).toBe(1);

      // A completes: the single-active slot frees and B claims next.
      completeRun(fixtureA, claimA as RunClaim, T2);
      expect(runningCount(dbB)).toBe(0);
      const claimB = orchestratorB.claimNextQueuedRun();
      expect(claimB?.runId).toBe(second.id);
      expect(runningCount(dbA)).toBe(1);
      expect(attemptCount(dbA)).toBe(2);
    } finally {
      dbB.close();
      dbA.close();
      removeTempDir(dir);
    }
  });
});

describe("RunOrchestrator lease heartbeat", () => {
  it("renews the lease with canonical timestamps for the exact run/attempt/owner", () => {
    const fixture = openFixture("orch-heartbeat", { leaseDurationMs: 60_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      expect(claim?.attempt.leaseDeadlineAt).toBe(T2); // T1 + 60s

      fixture.clock.advance(30_000); // 09:01:30
      const renewed = fixture.orchestrator.renewAttemptLease({
        runId: run.id,
        attemptId: claim?.attempt.id ?? "",
        ownerToken: fixture.orchestrator.ownerToken
      });
      expect(renewed).toMatchObject({
        id: claim?.attempt.id,
        runId: run.id,
        status: "ACTIVE",
        heartbeatAt: "2026-08-13T09:01:30.000Z",
        leaseDeadlineAt: "2026-08-13T09:02:30.000Z"
      });
      expect(attemptRow(fixture.db, claim?.attempt.id ?? "")).toMatchObject({
        status: "ACTIVE",
        heartbeat_at: "2026-08-13T09:01:30.000Z",
        lease_deadline_at: "2026-08-13T09:02:30.000Z"
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("rejects renewal for the wrong owner, wrong Run, and finished attempt", () => {
    const fixture = openFixture("orch-heartbeat-reject", { leaseDurationMs: 60_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;

      expect(() =>
        fixture.orchestrator.renewAttemptLease({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: "owner-evil"
        })
      ).toThrowError(/owned by another token/);
      expect(() =>
        fixture.orchestrator.renewAttemptLease({
          runId: "run-other",
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken
        })
      ).toThrowError(new RegExp(`belongs to run ${run.id}`));
      expect(() =>
        fixture.orchestrator.renewAttemptLease({
          runId: "run-ghost",
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken
        })
      ).toThrowError(RunnerInvariantError);

      completeRun(fixture, claim, T3);
      expect(() =>
        fixture.orchestrator.renewAttemptLease({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken
        })
      ).toThrowError(/only an ACTIVE attempt can renew/);
    } finally {
      closeFixture(fixture);
    }
  });

  it("an expired lease cannot be renewed and the scan interrupts the attempt", () => {
    const fixture = openFixture("orch-lease-expiry", { leaseDurationMs: 1_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      expect(claim.attempt.leaseDeadlineAt).toBe("2026-08-13T09:01:01.000Z");

      fixture.clock.advance(2_000); // 09:01:02 — past the inclusive deadline
      expect(() =>
        fixture.orchestrator.renewAttemptLease({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken
        })
      ).toThrowError(/lease expired/);
      expect(attemptRow(fixture.db, claim.attempt.id).status).toBe("ACTIVE");

      // The stale owner cannot renew; the recovery scan classifies the attempt.
      const result = fixture.orchestrator.recoverExpiredAttempts();
      expect(result.found).toBe(1);
      expect(result.entries[0]).toMatchObject({
        attemptId: claim.attempt.id,
        runId: run.id,
        outcome: "RECOVERY_UNSUPPORTED",
        decision: "RECOVERY_UNSUPPORTED",
        failureCode: "RECOVERY_UNSUPPORTED",
        stage: null
      });
      expect(attemptRow(fixture.db, claim.attempt.id)).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION",
        finished_at: "2026-08-13T09:01:02.000Z"
      });
      expect(runRow(fixture.db, run.id).status).toBe("FAILED");
    } finally {
      closeFixture(fixture);
    }
  });
});

describe("RunOrchestrator attempt finish", () => {
  it("finishes an ACTIVE attempt with domain semantics and a canonical terminal timestamp", () => {
    const fixture = openFixture("orch-finish");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "Completed" }, occurredAt: T3 }]
      });

      // The Run is COMPLETED (terminal event persisted): the guarded raw
      // finish allows FINISHED. A +08:00 input canonicalizes to UTC ISO.
      const finished = fixture.orchestrator.finishAttempt({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        status: "FINISHED",
        finishedAt: "2026-08-13T18:00:00.000+08:00"
      });
      expect(finished).toMatchObject({
        id: claim.attempt.id,
        status: "FINISHED",
        finishedAt: "2026-08-13T10:00:00.000Z"
      });
      expect(finished.interruptionKind).toBeUndefined();
      expect(attemptRow(fixture.db, claim.attempt.id)).toMatchObject({
        status: "FINISHED",
        finished_at: "2026-08-13T10:00:00.000Z",
        interruption_kind: null
      });

      // A terminal attempt can never be finished again.
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          status: "FINISHED",
          finishedAt: T3
        })
      ).toThrowError(/already FINISHED/);
    } finally {
      closeFixture(fixture);
    }
  });

  it("completeAttempt atomically appends Completed and finishes FINISHED (rollback on a ghost Model)", () => {
    const fixture = openFixture("orch-complete-atomic");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;

      // A +08:00 input canonicalizes on both the event and the attempt finish.
      const finished = fixture.orchestrator.completeAttempt({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        finishedAt: "2026-08-13T18:00:00.000+08:00"
      });
      expect(finished).toMatchObject({
        status: "FINISHED",
        finishedAt: "2026-08-13T10:00:00.000Z"
      });
      expect(finished.interruptionKind).toBeUndefined();
      const row = runRow(fixture.db, run.id);
      expect(row.status).toBe("COMPLETED");
      expect(row.completed_at).toBe("2026-08-13T10:00:00.000Z");
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      expect(fixture.runs.listRunEvents(run.id).at(-1)).toMatchObject({
        type: "Completed",
        attemptId: claim.attempt.id,
        occurredAt: "2026-08-13T10:00:00.000Z"
      });

      // Atomicity: a Completed event whose modelId does not resolve rolls the
      // event AND the attempt finish back together.
      const second = createQueuedRun(fixture, T1);
      const claim2 = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      expect(claim2.runId).toBe(second.id);
      expect(() =>
        fixture.orchestrator.completeAttempt({
          runId: second.id,
          attemptId: claim2.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          modelId: "model-ghost",
          finishedAt: T3
        })
      ).toThrowError(RunnerInvariantError);
      expect(runRow(fixture.db, second.id).status).toBe("RUNNING");
      expect(attemptRow(fixture.db, claim2.attempt.id).status).toBe("ACTIVE");
      expect(fixture.runs.listRunEvents(second.id)).toHaveLength(0);
    } finally {
      closeFixture(fixture);
    }
  });

  it("failAttempt atomically appends Failed and finishes INTERRUPTED (never a cancellation)", () => {
    const fixture = openFixture("orch-fail-atomic");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      stageRun(fixture, claim, "PREPARING", "2026-08-13T09:01:10.000Z");

      const interrupted = fixture.orchestrator.failAttempt({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        failureCode: "AGENT_TIMEOUT",
        failureMessage: "执行超时",
        finishedAt: T3
      });
      expect(interrupted).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        finishedAt: T3
      });
      const row = runRow(fixture.db, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("AGENT_TIMEOUT");
      expect(row.failure_message).toBe("执行超时");
      expect(row.completed_at).toBe(T3);
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      expect(fixture.runs.listRunEvents(run.id).at(-1)).toMatchObject({
        type: "Failed",
        attemptId: claim.attempt.id,
        failureCode: "AGENT_TIMEOUT",
        occurredAt: T3
      });
      expect(attemptRow(fixture.db, claim.attempt.id).status).not.toBe("CANCELLED");
      // The single-active slot freed: the next Run can be claimed.
      const second = createQueuedRun(fixture, T1);
      const claim2 = fixture.orchestrator.claimNextQueuedRun();
      expect(claim2?.runId).toBe(second.id);
    } finally {
      closeFixture(fixture);
    }
  });

  it("guards the raw finish against the Run status mapping", () => {
    const fixture = openFixture("orch-finish-guard");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;

      // The Run is still RUNNING: no raw finish is legal before the terminal
      // Run event is persisted.
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          status: "FINISHED",
          finishedAt: T2
        })
      ).toThrowError(/only be finished FINISHED when its Run is COMPLETED or CLARIFICATION_REQUIRED/);
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          status: "INTERRUPTED",
          finishedAt: T2
        })
      ).toThrowError(/only be finished INTERRUPTED when its Run is FAILED/);
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          status: "CANCELLED",
          finishedAt: T2
        })
      ).toThrowError(/only be finished CANCELLED when its Run is CANCELLED/);
      expect(attemptRow(fixture.db, claim.attempt.id).status).toBe("ACTIVE");

      // After the Completed event, FINISHED is legal but INTERRUPTED is not.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "Completed" }, occurredAt: T3 }]
      });
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          status: "INTERRUPTED",
          finishedAt: T3
        })
      ).toThrowError(/only be finished INTERRUPTED when its Run is FAILED/);
      expect(
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          status: "FINISHED",
          finishedAt: T3
        }).status
      ).toBe("FINISHED");
    } finally {
      closeFixture(fixture);
    }
  });

  it("derives the interruption kind from the raw-finish status (P3-3 review fix)", () => {
    const fixture = openFixture("orch-finish-derived-kind");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T2);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;

      // The raw finish request exposes NO caller-chosen interruptionKind: the
      // kind is always derived from the status — FINISHED records none,
      // INTERRUPTED records UNEXPECTED_INTERRUPTION, CANCELLED records
      // CANCELLED. The Run-status guard is unaffected.
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          status: "INTERRUPTED",
          finishedAt: T2
        })
      ).toThrowError(/only be finished INTERRUPTED when its Run is FAILED/);
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          status: "CANCELLED",
          finishedAt: T2
        })
      ).toThrowError(/only be finished CANCELLED when its Run is CANCELLED/);
      expect(attemptRow(fixture.db, claim.attempt.id).status).toBe("ACTIVE");

      // A Failed terminal event pins INTERRUPTED + UNEXPECTED_INTERRUPTION.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "Failed", failureCode: "AGENT_TIMEOUT" }, occurredAt: T3 }]
      });
      const interrupted = fixture.orchestrator.finishAttempt({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        status: "INTERRUPTED",
        finishedAt: T3
      });
      expect(interrupted).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        finishedAt: T3
      });
      expect(attemptRow(fixture.db, claim.attempt.id)).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION"
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("an unexpected interruption never becomes a cancellation", () => {
    const fixture = openFixture("orch-interruption");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      fixture.clock.set(T2);
      const claimA = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      expect(claimA.runId).toBe(first.id);

      // A wrong owner can never finish the attempt either.
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: first.id,
          attemptId: claimA.attempt.id,
          ownerToken: "owner-evil",
          status: "FINISHED"
        })
      ).toThrowError(/owned by another token/);

      // The atomic failure path writes Failed + INTERRUPTED together.
      const interrupted = fixture.orchestrator.failAttempt({
        runId: first.id,
        attemptId: claimA.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        failureCode: "VALIDATION_REJECTED",
        finishedAt: T3
      });
      expect(interrupted).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        finishedAt: T3
      });
      expect(attemptRow(fixture.db, claimA.attempt.id)).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION"
      });
      expect(attemptRow(fixture.db, claimA.attempt.id).status).not.toBe("CANCELLED");
      expect(runRow(fixture.db, first.id).status).toBe("FAILED");
    } finally {
      closeFixture(fixture);
    }
  });

  it("the designed queued-cancellation path: cancel events settle the Run, then the guarded CANCELLED finish", () => {
    // The P3-3 cancel API will mint/own the attempt for the QUEUED path; this
    // test pins the design: the cancellation pair is appended to the QUEUED
    // Run (P3-1 semantics), the Run becomes CANCELLED, and only then does the
    // guarded raw finish allow the CANCELLED attempt status.
    const fixture = openFixture("orch-queued-cancel-design");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      // The canonical event envelope requires a persisted attempt even on the
      // QUEUED path: seed the ACTIVE attempt the cancellation pair references.
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, owner_token, " +
            "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES ('attempt-queued-cancel', ?, 1, 'ACTIVE', ?, ?, ?, ?, ?, ?)"
        )
        .run(run.id, fixture.orchestrator.ownerToken, T1, T3, T1, T1, T1);

      // Before the Run is CANCELLED, the guarded raw finish refuses.
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: run.id,
          attemptId: "attempt-queued-cancel",
          ownerToken: fixture.orchestrator.ownerToken,
          status: "CANCELLED",
          finishedAt: T1
        })
      ).toThrowError(/only be finished CANCELLED when its Run is CANCELLED/);

      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: "attempt-queued-cancel",
        entries: [
          { payload: { type: "CancellationRequested", reason: "用户取消" }, occurredAt: T2 },
          { payload: { type: "CancellationConfirmed" }, occurredAt: T2 }
        ]
      });
      expect(runRow(fixture.db, run.id).status).toBe("CANCELLED");

      // The CANCELLED interruption kind is derived from the requested status.
      const cancelled = fixture.orchestrator.finishAttempt({
        runId: run.id,
        attemptId: "attempt-queued-cancel",
        ownerToken: fixture.orchestrator.ownerToken,
        status: "CANCELLED",
        finishedAt: T2
      });
      expect(cancelled).toMatchObject({ status: "CANCELLED", interruptionKind: "CANCELLED" });
      expect(attemptRow(fixture.db, "attempt-queued-cancel")).toMatchObject({
        status: "CANCELLED",
        interruption_kind: "CANCELLED",
        finished_at: T2
      });
    } finally {
      closeFixture(fixture);
    }
  });
});

describe("RunOrchestrator P3-3 atomic cancel and clarify operations", () => {
  it("cancelQueuedRun atomically cancels a QUEUED Run with a cancellation-scoped attempt and no execution", () => {
    const fixture = openFixture("orch-cancel-queued");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T2);

      const attempt = fixture.orchestrator.cancelQueuedRun({
        runId: run.id,
        reason: "用户取消",
        finishedAt: T2
      });
      expect(attempt).toMatchObject({
        runId: run.id,
        attemptSequence: 1,
        status: "CANCELLED",
        interruptionKind: "CANCELLED",
        finishedAt: T2
      });
      const row = runRow(fixture.db, run.id);
      expect(row.status).toBe("CANCELLED");
      expect(row.started_at).toBeNull();
      expect(row.model_id).toBeNull();
      expect(fixture.runs.listRunEvents(run.id).map((event) => event.type)).toEqual([
        "CancellationRequested",
        "CancellationConfirmed"
      ]);
      // The cancellation-scoped attempt is never observable as an execution attempt.
      expect(attemptRow(fixture.db, attempt.id)).toMatchObject({
        status: "CANCELLED",
        interruption_kind: "CANCELLED",
        finished_at: T2
      });
      expect(modelCount(fixture.db)).toBe(0);
      // The raw op is QUEUED-only (the coordinator owns terminal idempotency).
      expect(() => fixture.orchestrator.cancelQueuedRun({ runId: run.id })).toThrowError(
        /only a QUEUED Run/
      );
      // The queue stays claimable for the next Run with a fresh per-Run sequence.
      const second = createQueuedRun(fixture, T3);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(second.id);
      expect(claim?.attempt.attemptSequence).toBe(1);
    } finally {
      closeFixture(fixture);
    }
  });

  it("cancelQueuedRun reuses a stale ACTIVE attempt instead of minting a second one", () => {
    const fixture = openFixture("orch-cancel-queued-reuse");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      // A claim that never committed (P3-2 designed-cancel shape): the Run is
      // QUEUED with a stale ACTIVE attempt of this owner.
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, owner_token, " +
            "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES ('attempt-stale-cancel', ?, 1, 'ACTIVE', ?, ?, ?, ?, ?, ?)"
        )
        .run(run.id, fixture.orchestrator.ownerToken, T1, T3, T1, T1, T1);

      fixture.orchestrator.cancelQueuedRun({ runId: run.id, finishedAt: T2 });
      expect(attemptCount(fixture.db)).toBe(1);
      expect(attemptRow(fixture.db, "attempt-stale-cancel")).toMatchObject({
        status: "CANCELLED",
        interruption_kind: "CANCELLED",
        finished_at: T2,
        owner_token: fixture.orchestrator.ownerToken
      });
      expect(runRow(fixture.db, run.id).status).toBe("CANCELLED");
    } finally {
      closeFixture(fixture);
    }
  });

  it("cancelAttempt atomically appends CancellationConfirmed and finishes CANCELLED", () => {
    const fixture = openFixture("orch-cancel-confirm");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      // The coordinator persists CancellationRequested FIRST, referencing the
      // ACTIVE attempt, then confirms.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "CancellationRequested", reason: "用户取消" }, occurredAt: T2 }]
      });
      const cancelled = fixture.orchestrator.cancelAttempt({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        finishedAt: T3
      });
      expect(cancelled).toMatchObject({
        status: "CANCELLED",
        interruptionKind: "CANCELLED",
        finishedAt: T3
      });
      expect(runRow(fixture.db, run.id).status).toBe("CANCELLED");
      expect(fixture.runs.listRunEvents(run.id).map((event) => event.type)).toEqual([
        "CancellationRequested",
        "CancellationConfirmed"
      ]);
      expect(modelCount(fixture.db)).toBe(0);
      // A terminal attempt can never be cancelled again.
      expect(() =>
        fixture.orchestrator.cancelAttempt({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          finishedAt: T3
        })
      ).toThrowError(/only an ACTIVE attempt/);
    } finally {
      closeFixture(fixture);
    }
  });

  it("cancelAttempt re-owns a stale cross-owner ACTIVE attempt in the same transaction", () => {
    const fixture = openFixture("orch-cancel-reown");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const ownerA = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      // A second orchestrator (fresh owner, e.g. a reopened process) confirms
      // the user cancel: the ACTIVE attempt owned by the dead owner is
      // re-owned in the same transaction.
      const orchestratorB = new RunOrchestrator(fixture.db, fixture.runs, {
        now: fixture.clock.now
      });
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: ownerA.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });
      const cancelled = orchestratorB.cancelAttempt({
        runId: run.id,
        attemptId: ownerA.attempt.id,
        ownerToken: orchestratorB.ownerToken,
        finishedAt: T2
      });
      expect(cancelled).toMatchObject({ status: "CANCELLED", interruptionKind: "CANCELLED" });
      expect(attemptRow(fixture.db, ownerA.attempt.id)).toMatchObject({
        status: "CANCELLED",
        interruption_kind: "CANCELLED",
        owner_token: orchestratorB.ownerToken
      });
      expect(runRow(fixture.db, run.id).status).toBe("CANCELLED");
    } finally {
      closeFixture(fixture);
    }
  });

  it("clarifyAttempt atomically persists the request, appends ClarificationRequired and finishes FINISHED", () => {
    const fixture = openFixture("orch-clarify");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      const questions = [
        { id: "q1", type: "dimension" as const, question: "底板厚度是多少？", unit: "mm" },
        {
          id: "q2",
          type: "choice" as const,
          question: "焊缝处理方式？",
          options: [{ id: "o1", label: "无需焊缝" }]
        }
      ];
      const { attempt, clarificationRequestId } = fixture.orchestrator.clarifyAttempt({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        questions,
        finishedAt: T2
      });
      expect(attempt).toMatchObject({ status: "FINISHED", finishedAt: T2 });
      expect(attempt.interruptionKind).toBeUndefined();
      expect(runRow(fixture.db, run.id)).toMatchObject({
        status: "CLARIFICATION_REQUIRED",
        clarification_request_id: clarificationRequestId,
        completed_at: T2
      });
      expect(fixture.runs.listRunEvents(run.id).at(-1)).toMatchObject({
        type: "ClarificationRequired",
        clarificationRequestId
      });
      // The persisted request is queryable as OPEN with its questions; the
      // query never needs answers (they arrive with the IPC batch).
      const request = fixture.runs.getClarificationRequest(clarificationRequestId);
      expect(request).toMatchObject({
        id: clarificationRequestId,
        runId: run.id,
        revisionId: "revision-a1",
        status: "OPEN",
        answers: [],
        questions: [
          { type: "dimension", question: "底板厚度是多少？", unit: "mm" },
          { type: "choice", question: "焊缝处理方式？", options: [{ label: "无需焊缝" }] }
        ]
      });
      expect(request?.questions[0]?.id).toBeTruthy();
      expect(request?.questions[0]?.id).not.toBe("q1"); // ids are minted by the writer
      expect(modelCount(fixture.db)).toBe(0);
      expect(fixture.runs.getClarificationRequest("request-ghost")).toBeNull();
    } finally {
      closeFixture(fixture);
    }
  });

  it("exposes the single ACTIVE attempt of a Run and of this owner", () => {
    const fixture = openFixture("orch-active-attempt-reads");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      expect(fixture.orchestrator.getActiveAttempt(run.id)).toBeNull();
      expect(fixture.orchestrator.getActiveAttemptForOwner()).toBeNull();

      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      expect(fixture.orchestrator.getActiveAttempt(run.id)?.id).toBe(claim.attempt.id);
      expect(fixture.orchestrator.getActiveAttemptForOwner()?.id).toBe(claim.attempt.id);

      completeRun(fixture, claim, T2);
      expect(fixture.orchestrator.getActiveAttempt(run.id)).toBeNull();
      expect(fixture.orchestrator.getActiveAttemptForOwner()).toBeNull();
    } finally {
      closeFixture(fixture);
    }
  });

  it("failCancelCleanup atomically fails a cancel-cleanup failure with CANCEL_CLEANUP_PENDING", () => {
    const fixture = openFixture("orch-fail-cancel-cleanup");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });

      const interrupted = fixture.orchestrator.failCancelCleanup({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        failureMessage: "清理失败",
        finishedAt: T3
      });
      expect(interrupted).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        finishedAt: T3
      });
      const row = runRow(fixture.db, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      expect(row.status).not.toBe("CANCELLED");
      expect(fixture.runs.listRunEvents(run.id).at(-1)).toMatchObject({
        type: "Failed",
        failureCode: "CANCEL_CLEANUP_PENDING",
        failureMessage: "清理失败"
      });
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeFixture(fixture);
    }
  });

  it("a live foreign lease is never stolen: cancel ops surface LiveForeignLeaseError", () => {
    const fixture = openFixture("orch-live-foreign-lease");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const ownerA = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      // A second orchestrator (fresh owner) tries to confirm / fail the cancel
      // while A's lease is still VALID.
      const orchestratorB = new RunOrchestrator(fixture.db, fixture.runs, {
        now: fixture.clock.now
      });
      expect(() =>
        orchestratorB.cancelAttempt({
          runId: run.id,
          attemptId: ownerA.attempt.id,
          ownerToken: orchestratorB.ownerToken,
          finishedAt: T1
        })
      ).toThrowError(LiveForeignLeaseError);
      expect(() =>
        orchestratorB.failCancelCleanup({
          runId: run.id,
          attemptId: ownerA.attempt.id,
          ownerToken: orchestratorB.ownerToken,
          finishedAt: T1
        })
      ).toThrowError(LiveForeignLeaseError);
      // Nothing was touched: the attempt stays ACTIVE under owner A.
      expect(attemptRow(fixture.db, ownerA.attempt.id)).toMatchObject({
        status: "ACTIVE",
        owner_token: fixture.orchestrator.ownerToken
      });
      expect(runRow(fixture.db, run.id).status).toBe("RUNNING");

      // Once A's lease expires the SAME orchestrator re-owns and confirms.
      fixture.clock.set(T3); // past the T1 + 60s lease
      const cancelled = orchestratorB.cancelAttempt({
        runId: run.id,
        attemptId: ownerA.attempt.id,
        ownerToken: orchestratorB.ownerToken,
        finishedAt: T3
      });
      expect(cancelled).toMatchObject({ status: "CANCELLED", interruptionKind: "CANCELLED" });
      expect(attemptRow(fixture.db, ownerA.attempt.id)).toMatchObject({
        status: "CANCELLED",
        owner_token: orchestratorB.ownerToken
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("exposes the earliest ACTIVE lease deadline and the queued-run presence for the ongoing recovery", () => {
    const fixture = openFixture("orch-recovery-reads");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      void createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      expect(fixture.orchestrator.hasQueuedRuns()).toBe(true);
      expect(fixture.orchestrator.nextActiveLeaseDeadline()).toBeNull();

      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      expect(fixture.orchestrator.hasQueuedRuns()).toBe(false);
      expect(fixture.orchestrator.nextActiveLeaseDeadline()).toBe(claim.attempt.leaseDeadlineAt);

      completeRun(fixture, claim, T2);
      expect(fixture.orchestrator.nextActiveLeaseDeadline()).toBeNull();
    } finally {
      closeFixture(fixture);
    }
  });
});

describe("RunOrchestrator startup / expired-lease recovery scan", () => {
  it("resumes a proven-safe interrupted attempt after a process reopen", () => {
    const fixture = openFixture("orch-recover-resume", {
      recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
    });
    let reopenedDb: SqliteDatabase | null = null;
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      stageRun(fixture, claim, "PREPARING", "2026-08-13T09:01:30.000Z");

      // The owner process "crashes" past the lease and a fresh Runner reopens.
      const clock2 = makeClock(Date.parse("2026-08-13T09:02:30.000Z"));
      const reopened = reopen(fixture, clock2, {
        leaseDurationMs: 60_000,
        recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
      });
      reopenedDb = reopened.db;

      const result = reopened.orchestrator.recoverExpiredAttempts();
      expect(result.scannedAt).toBe("2026-08-13T09:02:30.000Z");
      expect(result.found).toBe(1);
      expect(result.entries[0]).toMatchObject({
        attemptId: claim.attempt.id,
        runId: run.id,
        outcome: "RESUMED",
        decision: "RESUME",
        stage: "PREPARING",
        failureCode: null
      });

      const resumed = reopened.orchestrator.getRunAttempt(claim.attempt.id);
      expect(resumed).toMatchObject({
        status: "ACTIVE",
        ownerToken: reopened.orchestrator.ownerToken,
        claimedAt: T1,
        recoveryDecision: "RESUME",
        heartbeatAt: "2026-08-13T09:02:30.000Z",
        leaseDeadlineAt: "2026-08-13T09:03:30.000Z"
      });
      // No events were appended: the Run stays RUNNING at its stage.
      expect(runRow(reopened.db, run.id)).toMatchObject({ status: "RUNNING", stage: "PREPARING" });
      expect(reopened.runs.listRunEvents(run.id)).toHaveLength(1);

      // The resumed owner holds a live lease and can renew it.
      expect(() =>
        reopened.orchestrator.renewAttemptLease({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: reopened.orchestrator.ownerToken
        })
      ).not.toThrow();
    } finally {
      reopenedDb?.close();
      if (fixture.db.isOpen) fixture.db.close();
      removeTempDir(fixture.dir);
    }
  });

  it("appends Failed and marks INTERRUPTED when the capability refuses (recovery unsupported)", () => {
    const fixture = openFixture("orch-recover-unsupported", {
      recoveryCapabilities: { canSafelyResume: () => false }
    });
    let reopenedDb: SqliteDatabase | null = null;
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      stageRun(fixture, claim, "ANALYZING", "2026-08-13T09:01:30.000Z");

      const clock2 = makeClock(Date.parse("2026-08-13T09:02:30.000Z"));
      const reopened = reopen(fixture, clock2, {
        recoveryCapabilities: { canSafelyResume: () => false }
      });
      reopenedDb = reopened.db;

      const entry = reopened.orchestrator.recoverExpiredAttempts().entries[0];
      expect(entry).toMatchObject({
        attemptId: claim.attempt.id,
        runId: run.id,
        outcome: "RECOVERY_UNSUPPORTED",
        decision: "RECOVERY_UNSUPPORTED",
        stage: "ANALYZING",
        failureCode: "RECOVERY_UNSUPPORTED"
      });
      expect(attemptRow(reopened.db, claim.attempt.id)).toMatchObject({
        status: "INTERRUPTED",
        finished_at: "2026-08-13T09:02:30.000Z",
        interruption_kind: "UNEXPECTED_INTERRUPTION",
        recovery_decision: "RECOVERY_UNSUPPORTED"
      });
      const row = runRow(reopened.db, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("RECOVERY_UNSUPPORTED");
      expect(row.completed_at).toBe("2026-08-13T09:02:30.000Z");
      expect(row.stage).toBeNull();
      expect(row.model_id).toBeNull();

      // The canonical event append preserved the persisted-attempt reference.
      const events = reopened.runs.listRunEvents(run.id);
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
      expect(events.at(-1)).toMatchObject({
        type: "Failed",
        attemptId: claim.attempt.id,
        failureCode: "RECOVERY_UNSUPPORTED",
        occurredAt: "2026-08-13T09:02:30.000Z"
      });
      // Never a cancellation, never a Model publish.
      expect(row.status).not.toBe("CANCELLED");
      expect(attemptRow(reopened.db, claim.attempt.id).status).not.toBe("CANCELLED");
      expect(attemptRow(reopened.db, claim.attempt.id).interruption_kind).not.toBe("CANCELLED");
      expect(modelCount(reopened.db)).toBe(0);
    } finally {
      reopenedDb?.close();
      if (fixture.db.isOpen) fixture.db.close();
      removeTempDir(fixture.dir);
    }
  });

  it("fails recovery when the injected capability probe throws (recovery failed)", () => {
    const fixture = openFixture("orch-recover-probe-failure");
    let reopenedDb: SqliteDatabase | null = null;
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      stageRun(fixture, claim, "PLANNING", "2026-08-13T09:01:30.000Z");

      const throwingCapabilities: RunRecoveryCapabilities = {
        canSafelyResume: () => {
          throw new Error("probe exploded");
        }
      };
      const clock2 = makeClock(Date.parse("2026-08-13T09:02:30.000Z"));
      const reopened = reopen(fixture, clock2, { recoveryCapabilities: throwingCapabilities });
      reopenedDb = reopened.db;

      const entry = reopened.orchestrator.recoverExpiredAttempts().entries[0];
      expect(entry).toMatchObject({
        attemptId: claim.attempt.id,
        runId: run.id,
        outcome: "RECOVERY_FAILED",
        decision: "RECOVERY_FAILED",
        stage: "PLANNING",
        failureCode: "RECOVERY_FAILED"
      });
      expect(entry?.reason).toContain("probe exploded");
      expect(attemptRow(reopened.db, claim.attempt.id)).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION",
        recovery_decision: "RECOVERY_FAILED"
      });
      expect(runRow(reopened.db, run.id)).toMatchObject({
        status: "FAILED",
        failure_code: "RECOVERY_FAILED"
      });
      expect(modelCount(reopened.db)).toBe(0);
    } finally {
      reopenedDb?.close();
      if (fixture.db.isOpen) fixture.db.close();
      removeTempDir(fixture.dir);
    }
  });

  it("a high stage without an explicit safe checkpoint fails recovery (never resumed, never cancelled)", () => {
    const fixture = openFixture("orch-recover-high-stage");
    let reopenedDb: SqliteDatabase | null = null;
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      stageRun(fixture, claim, "PREPARING", "2026-08-13T09:01:10.000Z");
      stageRun(fixture, claim, "MODELING", "2026-08-13T09:01:30.000Z");

      // canSafelyResume returns true but MODELING additionally requires an
      // explicit safe checkpoint, which is absent.
      const clock2 = makeClock(Date.parse("2026-08-13T09:02:30.000Z"));
      const reopened = reopen(fixture, clock2, {
        recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
      });
      reopenedDb = reopened.db;

      const entry = reopened.orchestrator.recoverExpiredAttempts().entries[0];
      expect(entry).toMatchObject({
        attemptId: claim.attempt.id,
        runId: run.id,
        outcome: "RECOVERY_FAILED",
        decision: "RECOVERY_FAILED",
        stage: "MODELING",
        failureCode: "RECOVERY_FAILED"
      });
      expect(entry?.reason).toContain("no explicit safe checkpoint");
      expect(attemptRow(reopened.db, claim.attempt.id)).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION"
      });
      const row = runRow(reopened.db, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("RECOVERY_FAILED");
      expect(row.model_id).toBeNull();
      expect(modelCount(reopened.db)).toBe(0);
      expect(reopened.runs.listRunEvents(run.id).at(-1)).toMatchObject({
        type: "Failed",
        attemptId: claim.attempt.id,
        failureCode: "RECOVERY_FAILED"
      });
    } finally {
      reopenedDb?.close();
      if (fixture.db.isOpen) fixture.db.close();
      removeTempDir(fixture.dir);
    }
  });

  it("resumes a high stage when an explicit safe checkpoint exists", () => {
    const fixture = openFixture("orch-recover-checkpoint");
    let reopenedDb: SqliteDatabase | null = null;
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      stageRun(fixture, claim, "PREPARING", "2026-08-13T09:01:10.000Z");
      stageRun(fixture, claim, "MODELING", "2026-08-13T09:01:30.000Z");

      const checkpointCapabilities: RunRecoveryCapabilities = {
        hasSafeCheckpoint: (context) => context.stage === "MODELING"
      };
      const clock2 = makeClock(Date.parse("2026-08-13T09:02:30.000Z"));
      const reopened = reopen(fixture, clock2, { recoveryCapabilities: checkpointCapabilities });
      reopenedDb = reopened.db;

      const entry = reopened.orchestrator.recoverExpiredAttempts().entries[0] as RecoveryScanEntry;
      expect(entry).toMatchObject({
        attemptId: claim.attempt.id,
        runId: run.id,
        outcome: "RESUMED",
        decision: "RESUME",
        stage: "MODELING",
        failureCode: null
      });
      expect(reopened.orchestrator.getRunAttempt(claim.attempt.id)).toMatchObject({
        status: "ACTIVE",
        ownerToken: reopened.orchestrator.ownerToken,
        recoveryDecision: "RESUME"
      });
      expect(runRow(reopened.db, run.id)).toMatchObject({ status: "RUNNING", stage: "MODELING" });
    } finally {
      reopenedDb?.close();
      if (fixture.db.isOpen) fixture.db.close();
      removeTempDir(fixture.dir);
    }
  });

  it("QUEUED Runs are safe: the dangling attempt is cleaned up and the Run stays claimable", () => {
    const fixture = openFixture("orch-recover-queued");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // Simulate a claim that died before the QUEUED -> RUNNING transition:
      // a persisted ACTIVE attempt whose lease has long expired.
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, owner_token, " +
            "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES ('attempt-stale', ?, 1, 'ACTIVE', 'owner-stale', ?, ?, ?, ?, ?)"
        )
        .run(run.id, T0, "2026-08-13T09:00:01.000Z", T0, T0, T0);
      fixture.clock.set(T1);

      const result = fixture.orchestrator.recoverExpiredAttempts();
      expect(result.found).toBe(1);
      expect(result.entries[0]).toMatchObject({
        attemptId: "attempt-stale",
        runId: run.id,
        outcome: "SAFE",
        decision: null,
        failureCode: null
      });
      // The Run stays QUEUED (no events) and the dangling attempt is finished.
      expect(runRow(fixture.db, run.id).status).toBe("QUEUED");
      expect(attemptRow(fixture.db, "attempt-stale")).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION",
        finished_at: T1
      });
      expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);

      // The deterministic attempt sequence continues after the cleaned row.
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      expect(claim?.attempt.attemptSequence).toBe(2);
    } finally {
      closeFixture(fixture);
    }
  });

  it("a terminal Run with a dangling ACTIVE attempt is cleaned up safely without new events", () => {
    const fixture = openFixture("orch-recover-terminal");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      // The executor crashed between appending the terminal event and
      // finishing the attempt.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [
          { payload: { type: "Failed", failureCode: "VALIDATION_REJECTED" }, occurredAt: "2026-08-13T09:01:30.000Z" }
        ]
      });
      expect(runRow(fixture.db, run.id).status).toBe("FAILED");
      expect(attemptRow(fixture.db, claim.attempt.id).status).toBe("ACTIVE");
      fixture.clock.set("2026-08-13T09:02:30.000Z"); // past the lease

      const entry = fixture.orchestrator.recoverExpiredAttempts().entries[0];
      expect(entry).toMatchObject({
        attemptId: claim.attempt.id,
        runId: run.id,
        outcome: "SAFE",
        decision: null,
        failureCode: null
      });
      // The attempt is reconciled to the already-settled Run: it ended when
      // the terminal event was persisted (completed_at), not when the scan
      // noticed the dangling row.
      expect(attemptRow(fixture.db, claim.attempt.id)).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION",
        finished_at: "2026-08-13T09:01:30.000Z"
      });
      // The settled Run read-model is untouched and no event was appended.
      expect(runRow(fixture.db, run.id).status).toBe("FAILED");
      expect(runRow(fixture.db, run.id).failure_code).toBe("VALIDATION_REJECTED");
      expect(fixture.runs.listRunEvents(run.id)).toHaveLength(1);
    } finally {
      closeFixture(fixture);
    }
  });

  it("reconciles a dangling ACTIVE attempt on an already CANCELLED Run without inventing a cancellation", () => {
    const fixture = openFixture("orch-recover-cancelled");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      // The user-cancel path settles the Run (cancellation pair appended); the
      // attempt's owner then vanished before it could finish the attempt — the
      // exact dangling-ACTIVE-on-CANCELLED state recovery must reconcile.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [
          { payload: { type: "CancellationRequested", reason: "用户取消" }, occurredAt: T2 },
          { payload: { type: "CancellationConfirmed" }, occurredAt: T2 }
        ]
      });
      expect(runRow(fixture.db, run.id).status).toBe("CANCELLED");
      expect(attemptRow(fixture.db, claim.attempt.id).status).toBe("ACTIVE");
      fixture.clock.set(T3); // past the lease

      const entry = fixture.orchestrator.recoverExpiredAttempts().entries[0];
      expect(entry).toMatchObject({
        attemptId: claim.attempt.id,
        runId: run.id,
        outcome: "SAFE",
        decision: null,
        failureCode: null
      });
      // Recovery NEVER invents a cancellation: the vanished owner's attempt is
      // reconciled as an unexpected interruption, at the Run's settled time.
      expect(attemptRow(fixture.db, claim.attempt.id)).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION",
        finished_at: T2
      });
      expect(attemptRow(fixture.db, claim.attempt.id).status).not.toBe("CANCELLED");
      expect(attemptRow(fixture.db, claim.attempt.id).interruption_kind).not.toBe("CANCELLED");
      // The settled Run read-model is untouched and no event was appended.
      const cancelledRow = fixture.db
        .prepare("SELECT status, completed_at, cancellation_confirmed_at FROM runs WHERE id = ?")
        .get(run.id) as {
        status: string;
        completed_at: string | null;
        cancellation_confirmed_at: string | null;
      };
      expect(cancelledRow.status).toBe("CANCELLED");
      expect(cancelledRow.cancellation_confirmed_at).toBe(T2);
      expect(cancelledRow.completed_at).toBe(T2);
      expect(fixture.runs.listRunEvents(run.id)).toHaveLength(2);
      // The deterministic attempt sequence continues after the reconciled row.
      const next = createQueuedRun(fixture, T3);
      const claim2 = fixture.orchestrator.claimNextQueuedRun();
      expect(claim2?.runId).toBe(next.id);
      expect(claim2?.attempt.attemptSequence).toBe(1);
    } finally {
      closeFixture(fixture);
    }
  });
});

describe("RunOrchestrator wedged-queue recovery", () => {
  it("un-wedges a RUNNING Run whose attempt was finished without a terminal Run event", () => {
    // Historical wedge (pre-guard bug): the attempt was finished FINISHED
    // while the Run stayed RUNNING — no terminal Run event was ever appended.
    // The guarded raw finish and the atomic terminal operations make this
    // unreachable today; recovery still repairs the persisted state.
    const fixture = openFixture("orch-wedge-terminal-attempt");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      const second = createQueuedRun(fixture, T1);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      fixture.db
        .prepare("UPDATE run_attempts SET status = 'FINISHED', finished_at = ? WHERE id = ?")
        .run(T2, claim.attempt.id);
      expect(runRow(fixture.db, first.id).status).toBe("RUNNING");
      fixture.clock.set(T2);

      const result = fixture.orchestrator.recoverExpiredAttempts();
      // A finished attempt is no expired-ACTIVE candidate; the wedge sweep
      // fails the RUNNING Run truthfully, referencing the persisted attempt.
      expect(result.found).toBe(0);
      expect(result.entries[0]).toMatchObject({
        attemptId: claim.attempt.id,
        runId: first.id,
        outcome: "RECOVERY_FAILED",
        decision: "RECOVERY_FAILED",
        failureCode: "AGENT_INTERRUPTED"
      });
      expect(runRow(fixture.db, first.id)).toMatchObject({
        status: "FAILED",
        failure_code: "AGENT_INTERRUPTED",
        completed_at: T2
      });
      expect(attemptRow(fixture.db, claim.attempt.id).status).toBe("FINISHED");
      expect(attemptRow(fixture.db, claim.attempt.id).status).not.toBe("CANCELLED");
      expect(fixture.runs.listRunEvents(first.id).at(-1)).toMatchObject({
        type: "Failed",
        attemptId: claim.attempt.id,
        failureCode: "AGENT_INTERRUPTED"
      });
      // The single-active slot freed: the next QUEUED Run is claimable.
      const next = fixture.orchestrator.claimNextQueuedRun();
      expect(next?.runId).toBe(second.id);
    } finally {
      closeFixture(fixture);
    }
  });

  it("un-wedges a RUNNING Run with no attempt at all by minting the canonical attempt record", () => {
    const fixture = openFixture("orch-wedge-no-attempt");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      // Historical wedge (pre-fix state): a Run became RUNNING with no attempt
      // row. The repository exposes no RUNNING transition primitive anymore;
      // recovery repairs the persisted state and mints the canonical attempt.
      insertQueuedRun(fixture.db, "run-wedged", "R01", T0);
      const second = createQueuedRun(fixture, T1);
      fixture.db
        .prepare("UPDATE runs SET status = 'RUNNING', started_at = ? WHERE id = 'run-wedged'")
        .run(T1);
      fixture.clock.set(T2);

      const result = fixture.orchestrator.recoverExpiredAttempts();
      expect(result.found).toBe(0);
      const wedge = result.entries[0];
      expect(wedge).toMatchObject({
        runId: "run-wedged",
        outcome: "RECOVERY_FAILED",
        decision: "RECOVERY_FAILED",
        failureCode: "AGENT_INTERRUPTED"
      });
      const attemptId = wedge?.attemptId;
      expect(attemptId).not.toBeNull();
      // The canonical attempt record was minted (sequence 1, INTERRUPTED with
      // the RECOVERY_FAILED decision) so the Failed event references it.
      const minted = attemptRow(fixture.db, attemptId ?? "");
      expect(minted).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION",
        recovery_decision: "RECOVERY_FAILED",
        finished_at: T2
      });
      const seq = fixture.db
        .prepare("SELECT attempt_sequence AS s FROM run_attempts WHERE id = ?")
        .get(attemptId ?? "") as { s: number };
      expect(seq.s).toBe(1);
      expect(runRow(fixture.db, "run-wedged")).toMatchObject({
        status: "FAILED",
        failure_code: "AGENT_INTERRUPTED"
      });
      expect(fixture.runs.listRunEvents("run-wedged").at(-1)).toMatchObject({
        type: "Failed",
        attemptId,
        failureCode: "AGENT_INTERRUPTED"
      });
      // The queue unblocks: the QUEUED Run is claimable now.
      const next = fixture.orchestrator.claimNextQueuedRun();
      expect(next?.runId).toBe(second.id);
    } finally {
      closeFixture(fixture);
    }
  });

  it("un-wedges a RUNNING Run whose ACTIVE attempt holds no lease", () => {
    const fixture = openFixture("orch-wedge-no-lease");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      const second = createQueuedRun(fixture, T1);
      // An ACTIVE attempt without lease timestamps can neither expire nor
      // renew: the Run has no live executor and would hold the single-active
      // slot forever.
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, created_at) " +
            "VALUES (?, ?, 1, 'ACTIVE', ?)"
        )
        .run("attempt-no-lease", first.id, T0);
      fixture.db
        .prepare(
          "UPDATE runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'"
        )
        .run(T1, first.id);
      fixture.clock.set(T2);

      const result = fixture.orchestrator.recoverExpiredAttempts();
      expect(result.found).toBe(0);
      expect(result.entries[0]).toMatchObject({
        attemptId: "attempt-no-lease",
        runId: first.id,
        outcome: "RECOVERY_FAILED",
        decision: "RECOVERY_FAILED",
        failureCode: "AGENT_INTERRUPTED"
      });
      expect(attemptRow(fixture.db, "attempt-no-lease")).toMatchObject({
        status: "INTERRUPTED",
        interruption_kind: "UNEXPECTED_INTERRUPTION",
        recovery_decision: "RECOVERY_FAILED"
      });
      expect(runRow(fixture.db, first.id).status).toBe("FAILED");
      const next = fixture.orchestrator.claimNextQueuedRun();
      expect(next?.runId).toBe(second.id);
    } finally {
      closeFixture(fixture);
    }
  });

  it("a resume blocked by the owner-uniqueness constraint is SKIPPED without aborting the scan", () => {
    const fixture = openFixture("orch-scan-skip-continues", {
      recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const queuedCancelRun = createQueuedRun(fixture, T0);
      // The P3-3 queued-cancel shape: this owner already holds an unfinished
      // EXECUTION attempt (ACTIVE, valid lease) on a QUEUED Run — it occupies
      // the execution-scoped one-active-per-owner slot (schema v3).
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, kind, owner_token, " +
            "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES ('attempt-busy', ?, 1, 'ACTIVE', 'EXECUTION', ?, ?, ?, ?, ?, ?)"
        )
        .run(queuedCancelRun.id, fixture.orchestrator.ownerToken, T0, T2, T0, T0, T0);
      // A RUNNING Run whose resumable attempt expired under a dead owner.
      insertQueuedRun(fixture.db, "run-stale", "R10", T0);
      fixture.db
        .prepare("UPDATE runs SET status = 'RUNNING', stage = 'PREPARING', started_at = ? WHERE id = 'run-stale'")
        .run(T0);
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, kind, owner_token, " +
            "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES ('attempt-stale', 'run-stale', 1, 'ACTIVE', 'EXECUTION', 'owner-dead-1', ?, ?, ?, ?, ?)"
        )
        .run(T0, "2026-08-13T09:00:30.000Z", T0, T0, T0);
      // A second expired candidate on a QUEUED Run that must still be swept
      // (its own dead owner: one unfinished attempt per owner token).
      const queuedCleanup = createQueuedRun(fixture, T1);
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, owner_token, " +
            "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES ('attempt-clean', ?, 1, 'ACTIVE', 'owner-dead-2', ?, ?, ?, ?, ?)"
        )
        .run(queuedCleanup.id, T0, "2026-08-13T09:00:45.000Z", T0, T0, T0);
      fixture.clock.set("2026-08-13T09:01:30.000Z"); // busy attempt lease (T2) still valid

      const result = fixture.orchestrator.recoverExpiredAttempts();
      // The resumable candidate is SKIPPED (this owner holds attempt-busy)...
      expect(result.entries[0]).toMatchObject({
        attemptId: "attempt-stale",
        runId: "run-stale",
        outcome: "SKIPPED",
        failureCode: null
      });
      expect(result.entries[0]?.reason).toContain("already holds another unfinished attempt");
      // ...the scan continues to the next candidate (QUEUED cleanup)...
      expect(result.entries[1]).toMatchObject({
        attemptId: "attempt-clean",
        runId: queuedCleanup.id,
        outcome: "SAFE",
        failureCode: null
      });
      // ...and the wedge sweep of the same scan fails the stale RUNNING Run
      // truthfully so the single-active slot frees (never a cancellation).
      expect(result.entries[2]).toMatchObject({
        attemptId: "attempt-stale",
        runId: "run-stale",
        outcome: "RECOVERY_FAILED",
        failureCode: "AGENT_INTERRUPTED"
      });
      expect(runRow(fixture.db, "run-stale").status).toBe("FAILED");
      expect(runRow(fixture.db, "run-stale").failure_code).toBe("AGENT_INTERRUPTED");
      expect(attemptRow(fixture.db, "attempt-stale").status).toBe("INTERRUPTED");
      expect(attemptRow(fixture.db, "attempt-stale").status).not.toBe("CANCELLED");
      // The busy owner's attempt and its QUEUED Run are untouched.
      expect(attemptRow(fixture.db, "attempt-busy").status).toBe("ACTIVE");
      expect(runRow(fixture.db, queuedCancelRun.id).status).toBe("QUEUED");
      expect(attemptRow(fixture.db, "attempt-clean").status).toBe("INTERRUPTED");
      expect(runRow(fixture.db, queuedCleanup.id).status).toBe("QUEUED");
    } finally {
      closeFixture(fixture);
    }
  });

  it("a hard per-candidate failure is isolated as SCAN_FAILED without aborting the scan", () => {
    const fixture = openFixture("orch-scan-failed-continues", {
      recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      // Candidate 1: an expired attempt on a Run whose stored stage is
      // corrupted — the stage classifier throws, which must not abort the scan.
      insertQueuedRun(fixture.db, "run-corrupt", "R10", T0);
      fixture.db
        .prepare("UPDATE runs SET stage = 'BOGUS-STAGE' WHERE id = 'run-corrupt'")
        .run();
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, owner_token, " +
            "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES ('attempt-corrupt', 'run-corrupt', 1, 'ACTIVE', 'owner-dead-1', ?, ?, ?, ?, ?)"
        )
        .run(T0, "2026-08-13T09:00:30.000Z", T0, T0, T0);
      // Candidate 2: a healthy expired attempt on a RUNNING Run at a resumable
      // stage — must still be processed after candidate 1 failed (its own dead
      // owner: one unfinished attempt per owner token).
      insertQueuedRun(fixture.db, "run-resume", "R20", T0);
      fixture.db
        .prepare("UPDATE runs SET status = 'RUNNING', stage = 'PREPARING', started_at = ? WHERE id = 'run-resume'")
        .run(T0);
      fixture.db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, owner_token, " +
            "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES ('attempt-resume', 'run-resume', 1, 'ACTIVE', 'owner-dead-2', ?, ?, ?, ?, ?)"
        )
        .run(T0, "2026-08-13T09:00:45.000Z", T0, T0, T0);
      fixture.clock.set("2026-08-13T09:01:30.000Z");

      const result = fixture.orchestrator.recoverExpiredAttempts();
      expect(result.entries[0]).toMatchObject({
        attemptId: "attempt-corrupt",
        runId: "run-corrupt",
        outcome: "SCAN_FAILED",
        failureCode: null
      });
      expect(result.entries[0]?.reason).toContain("unknown stage");
      // The healthy candidate was still processed: RESUMED with a fresh lease.
      expect(result.entries[1]).toMatchObject({
        attemptId: "attempt-resume",
        runId: "run-resume",
        outcome: "RESUMED",
        decision: "RESUME",
        stage: "PREPARING",
        failureCode: null
      });
      expect(fixture.orchestrator.getRunAttempt("attempt-resume")).toMatchObject({
        status: "ACTIVE",
        ownerToken: fixture.orchestrator.ownerToken
      });
      expect(runRow(fixture.db, "run-resume").status).toBe("RUNNING");
      // The corrupted candidate was left unchanged by the scan itself.
      expect(attemptRow(fixture.db, "attempt-corrupt").status).toBe("ACTIVE");
    } finally {
      closeFixture(fixture);
    }
  });
});

describe("RunOrchestrator Phase 5 cancellation lease fence", () => {
  it("seizeCancelCleanupOwnership atomically refreshes an expired same-owner lease and keeps the attempt ACTIVE", () => {
    const fixture = openFixture("orch-seize-refresh", { leaseDurationMs: 60_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      expect(claim.attempt.leaseDeadlineAt).toBe(T2); // T1 + 60s
      // Real cancel intent must be persisted before the fence may mint a lease.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });

      // The lease expires while the owner's claim is being stopped.
      fixture.clock.set(T3); // past the T1 + 60s lease
      const seized = fixture.orchestrator.seizeCancelCleanupOwnership({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken
      });
      // Same owner, even expired: heartbeat + lease refreshed in place; the
      // attempt stays ACTIVE with NO terminal event and NO recovery decision.
      expect(seized).toMatchObject({
        status: "ACTIVE",
        ownerToken: fixture.orchestrator.ownerToken,
        heartbeatAt: T3,
        leaseDeadlineAt: "2026-08-13T09:04:00.000Z" // T3 + 60s fresh lease
      });
      expect(seized.recoveryDecision).toBeUndefined();
      expect(seized.interruptionKind).toBeUndefined();
      expect(runRow(fixture.db, run.id).status).toBe("RUNNING");
      expect(fixture.runs.listRunEvents(run.id)).toHaveLength(1);

      // The fresh fence lease blocks a foreign recovery scan from re-owning:
      // nothing is expired anymore, so the scan finds and touches nothing.
      const foreign = new RunOrchestrator(fixture.db, fixture.runs, {
        now: fixture.clock.now,
        recoveryCapabilities: { canSafelyResume: () => true }
      });
      const scan = foreign.recoverExpiredAttempts();
      expect(scan.found).toBe(0);
      expect(scan.entries).toHaveLength(0);
      expect(attemptRow(fixture.db, claim.attempt.id)).toMatchObject({
        status: "ACTIVE",
        owner_token: fixture.orchestrator.ownerToken
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("seizeCancelCleanupOwnership rejects a live foreign lease and leaves the attempt byte-identical", () => {
    const fixture = openFixture("orch-seize-live-foreign", { leaseDurationMs: 60_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const ownerA = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      // Real cancel intent is persisted; the fence still refuses because the
      // attempt holds a LIVE foreign lease.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: ownerA.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });
      const orchestratorB = new RunOrchestrator(fixture.db, fixture.runs, {
        now: fixture.clock.now
      });
      expect(() =>
        orchestratorB.seizeCancelCleanupOwnership({
          runId: run.id,
          attemptId: ownerA.attempt.id,
          ownerToken: orchestratorB.ownerToken
        })
      ).toThrowError(LiveForeignLeaseError);
      // Nothing was touched: the attempt stays ACTIVE under owner A with the
      // exact lease, the Run stays RUNNING and no event was appended.
      expect(attemptRow(fixture.db, ownerA.attempt.id)).toMatchObject({
        status: "ACTIVE",
        owner_token: fixture.orchestrator.ownerToken,
        heartbeat_at: T1,
        lease_deadline_at: T2
      });
      expect(runRow(fixture.db, run.id).status).toBe("RUNNING");
      expect(fixture.runs.listRunEvents(run.id)).toHaveLength(1);
    } finally {
      closeFixture(fixture);
    }
  });

  it("seizeCancelCleanupOwnership re-owns a stale foreign attempt with a fresh lease and keeps the Run RUNNING", () => {
    const fixture = openFixture("orch-seize-stale-reown", { leaseDurationMs: 60_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const ownerA = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: ownerA.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });
      fixture.clock.set(T3); // past A's lease

      const orchestratorB = new RunOrchestrator(fixture.db, fixture.runs, {
        now: fixture.clock.now
      });
      const seized = orchestratorB.seizeCancelCleanupOwnership({
        runId: run.id,
        attemptId: ownerA.attempt.id,
        ownerToken: orchestratorB.ownerToken
      });
      // Stale foreign attempt: re-owned to B with a FRESH lease; still ACTIVE,
      // no recovery decision (not a RESUME), no terminal event.
      expect(seized).toMatchObject({
        status: "ACTIVE",
        ownerToken: orchestratorB.ownerToken,
        heartbeatAt: T3,
        leaseDeadlineAt: "2026-08-13T09:04:00.000Z" // T3 + 60s
      });
      expect(seized.recoveryDecision).toBeUndefined();
      expect(runRow(fixture.db, run.id).status).toBe("RUNNING");
      expect(eventTypesOf(fixture, run.id)).toEqual(["CancellationRequested"]);

      // The fresh fence lease blocks a third Runner's recovery re-own.
      const orchestratorC = new RunOrchestrator(fixture.db, fixture.runs, {
        now: fixture.clock.now,
        recoveryCapabilities: { canSafelyResume: () => true }
      });
      expect(orchestratorC.recoverExpiredAttempts().found).toBe(0);

      // B settles the cancel through the final guarded transaction.
      const cancelled = orchestratorB.cancelAttempt({
        runId: run.id,
        attemptId: ownerA.attempt.id,
        ownerToken: orchestratorB.ownerToken,
        finishedAt: T3
      });
      expect(cancelled).toMatchObject({ status: "CANCELLED", interruptionKind: "CANCELLED" });
      expect(runRow(fixture.db, run.id).status).toBe("CANCELLED");
      expect(attemptRow(fixture.db, ownerA.attempt.id)).toMatchObject({
        status: "CANCELLED",
        owner_token: orchestratorB.ownerToken
      });
    } finally {
      closeFixture(fixture);
    }
  });

  it("seizeCancelCleanupOwnership refuses to fence a Run without a persisted CancellationRequested and mutates NOTHING", () => {
    const fixture = openFixture("orch-seize-no-intent", { leaseDurationMs: 60_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      fixture.clock.set(T3); // past the lease: the attempt is stale/expired

      // No CancellationRequested has ever been persisted: the fence is bound
      // to REAL cancel intent, so it must refuse BEFORE any mutation — the
      // cleanup lease must never be minted on an uncancelled Run.
      expect(() =>
        fixture.orchestrator.seizeCancelCleanupOwnership({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken
        })
      ).toThrowError(RunnerInvariantError);
      // Byte-identical: the attempt keeps its exact owner/lease/heartbeat, the
      // Run stays RUNNING and no event was appended.
      expect(attemptRow(fixture.db, claim.attempt.id)).toMatchObject({
        status: "ACTIVE",
        owner_token: fixture.orchestrator.ownerToken,
        heartbeat_at: T1,
        lease_deadline_at: T2
      });
      expect(runRow(fixture.db, run.id).status).toBe("RUNNING");
      expect(fixture.runs.listRunEvents(run.id)).toHaveLength(0);
      // The stale attempt is still visible to the recovery scan (it holds no
      // live lease) — the fence did not touch it.
      expect(fixture.orchestrator.recoverExpiredAttempts().found).toBe(1);
    } finally {
      closeFixture(fixture);
    }
  });

  it("the cleanup fence deadline uses the cancel-cleanup minimum when the run lease is shorter", () => {
    const fixture = openFixture("orch-seize-min-lease", { leaseDurationMs: 5_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      // A 5 s run lease: the claim lease is 5 s after the claim instant.
      expect(claim.attempt.leaseDeadlineAt).toBe("2026-08-13T09:01:05.000Z");
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });
      fixture.clock.set(T3); // past the short lease
      const seized = fixture.orchestrator.seizeCancelCleanupOwnership({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken
      });
      // The fence deadline is max(run lease, minimum): the 5 s run lease can
      // never shorten the cleanup window below the 60 s minimum.
      expect(seized.leaseDeadlineAt).toBe("2026-08-13T09:04:00.000Z"); // T3 + 60s
    } finally {
      closeFixture(fixture);
    }
  });

  it("the cleanup fence deadline preserves a run lease longer than the minimum", () => {
    const fixture = openFixture("orch-seize-long-lease", { leaseDurationMs: 120_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });
      fixture.clock.set(T3); // past the 120 s lease
      const seized = fixture.orchestrator.seizeCancelCleanupOwnership({
        runId: run.id,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken
      });
      // max(120 s run lease, 60 s minimum) = 120 s: the longer duration wins.
      expect(seized.leaseDeadlineAt).toBe("2026-08-13T09:05:00.000Z"); // T3 + 120s
    } finally {
      closeFixture(fixture);
    }
  });

  it("recovery leaves a RUNNING Run with persisted CancellationRequested untouched by BOTH sweeps — never resumed, never auto-failed", () => {
    const fixture = openFixture("orch-recovery-cancel-requested", {
      leaseDurationMs: 60_000,
      // The capability would prove the interrupted work safely resumable — the
      // scan must STILL refuse to resume a cancelled Run.
      recoveryCapabilities: { canSafelyResume: () => true }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      stageRun(fixture, claim, "ANALYZING", T2);
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });
      fixture.clock.set(T3); // past the lease: the cancel's cleanup lease expired

      const scan = fixture.orchestrator.recoverExpiredAttempts();
      // The expired-attempt sweep SKIPs the attempt...
      expect(scan.entries[0]).toMatchObject({
        attemptId: claim.attempt.id,
        outcome: "SKIPPED",
        decision: null,
        failureCode: null
      });
      // ...and the wedge sweep SKIPs the wedged slot as well (no live lease).
      expect(scan.entries[1]).toMatchObject({
        runId: run.id,
        outcome: "SKIPPED",
        decision: null,
        failureCode: null
      });
      expect(scan.entries[0]?.reason).toContain("CancellationRequested");
      // Untouched: the attempt stays ACTIVE under its owner with the expired
      // lease, the Run stays RUNNING, and no Failed / CancellationConfirmed was
      // invented — only the persisted request exists.
      expect(attemptRow(fixture.db, claim.attempt.id)).toMatchObject({
        status: "ACTIVE",
        owner_token: fixture.orchestrator.ownerToken,
        lease_deadline_at: T2
      });
      expect(runRow(fixture.db, run.id).status).toBe("RUNNING");
      expect(eventTypesOf(fixture, run.id)).toEqual(["StageChanged", "CancellationRequested"]);
    } finally {
      closeFixture(fixture);
    }
  });

  it("the wedge sweep leaves a CancellationRequested RUNNING Run without a live attempt untouched (never auto-failed)", () => {
    const fixture = openFixture("orch-wedge-cancel-requested", { leaseDurationMs: 60_000 });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.clock.set(T1);
      const claim = fixture.orchestrator.claimNextQueuedRun() as RunClaim;
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim.attempt.id,
        entries: [{ payload: { type: "CancellationRequested" }, occurredAt: T2 }]
      });
      // Wedge shape: the attempt is finished WITHOUT a terminal Run event, so
      // the RUNNING Run has no live ACTIVE attempt (its executing owner died).
      fixture.db
        .prepare("UPDATE run_attempts SET status = 'FINISHED', finished_at = ? WHERE id = ?")
        .run(T2, claim.attempt.id);
      fixture.clock.set(T3);

      const scan = fixture.orchestrator.recoverExpiredAttempts();
      expect(scan.found).toBe(0); // no expired ACTIVE attempt
      expect(scan.entries).toHaveLength(1);
      expect(scan.entries[0]).toMatchObject({
        runId: run.id,
        outcome: "SKIPPED",
        decision: null,
        failureCode: null
      });
      expect(scan.entries[0]?.reason).toContain("CancellationRequested");
      // Untouched: the Run stays RUNNING, the finished attempt is unchanged and
      // no Failed / CancellationConfirmed event was invented.
      expect(runRow(fixture.db, run.id).status).toBe("RUNNING");
      expect(attemptRow(fixture.db, claim.attempt.id).status).toBe("FINISHED");
      expect(eventTypesOf(fixture, run.id)).toEqual(["CancellationRequested"]);
    } finally {
      closeFixture(fixture);
    }
  });
});

describe("Runner orchestration facade", () => {
  it("wires claim / renew / finish / recover / attempt reads through the Runner (F2 auto-claim at open)", () => {
    const dir = makeTempDir("orch-runner-facade");
    const clock = makeClock(Date.parse(T1));
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      now: clock.now,
      leaseDurationMs: 60_000
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      // Seed a QUEUED Run directly (the facade flow needs no Drawing workflow).
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      insertResolvableQueuedRun(seedDb, dir, "run-facade", "R01", T0);
      seedDb.close();
      seedDb = null;

      runner.open();
      // F2: reopening with QUEUED work auto-starts the queue, which claims the
      // Run synchronously (the opening stage trio lands in the same tick), so
      // the facade claim is wired through the Runner without a manual call.
      expect(runner.getRunDetail("run-facade").run.status).toBe("RUNNING");

      // The facade wires the orchestrator primitives on the auto-claimed
      // attempt; the attempt owner is the Runner's own token. Renewed at the
      // claim instant (T1) while the lease is still valid.
      const readDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      readDb.open();
      const attemptRow = readDb
        .prepare("SELECT id, owner_token FROM run_attempts WHERE run_id = ?")
        .get("run-facade") as { id: string; owner_token: string } | undefined;
      readDb.close();
      expect(attemptRow).toBeDefined();
      const attemptId = attemptRow?.id ?? "";
      expect(attemptRow?.owner_token).toBe(runner.runOwnerToken);

      runner.renewAttemptLease({
        runId: "run-facade",
        attemptId,
        ownerToken: runner.runOwnerToken
      });
      clock.set(T2);
      runner.appendRunEvents({
        runId: "run-facade",
        attemptId,
        entries: [{ payload: { type: "Completed" }, occurredAt: T3 }]
      });
      const finished = runner.finishRunAttempt({
        runId: "run-facade",
        attemptId,
        ownerToken: runner.runOwnerToken,
        status: "FINISHED",
        finishedAt: T3
      });
      expect(finished.status).toBe("FINISHED");
      expect(runner.getRunAttempt(attemptId)?.status).toBe("FINISHED");
      expect(runner.getRunDetail("run-facade").run.status).toBe("COMPLETED");
      // No expired lease remains: the scan finds nothing to reconsider.
      expect(runner.recoverExpiredAttempts().found).toBe(0);
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("auto-runs the recovery scan at open and exposes the result without a manual scan", () => {
    const dir = makeTempDir("orch-runner-scan");
    const clock = makeClock(Date.parse(T1));
    const runner = new Runner(dir, { runProfile: PROFILE, now: clock.now, leaseDurationMs: 1_000 });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      insertQueuedRun(seedDb, "run-scan", "R01", T0);
      seedDb.prepare(
        "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, owner_token, " +
          "claimed_at, lease_deadline_at, heartbeat_at, started_at, created_at) " +
          "VALUES ('attempt-scan', 'run-scan', 1, 'ACTIVE', 'owner-dead', ?, ?, ?, ?, ?)"
      ).run(T0, "2026-08-13T09:00:01.000Z", T0, T0, T0);
      seedDb.close();
      seedDb = null;

      // Reopening the Runner is a mandatory recovery hook: the expired-lease
      // candidate is reconsidered at open, before any manual scan.
      runner.open();
      const scan = runner.recoveryScanResult;
      expect(scan).not.toBeNull();
      expect(scan?.found).toBe(1);
      expect(scan?.entries[0]).toMatchObject({
        attemptId: "attempt-scan",
        runId: "run-scan",
        outcome: "SAFE",
        decision: null
      });
      // The candidate was consumed by the open-time scan: an explicit scan
      // now finds nothing left to reconsider.
      expect(runner.recoverExpiredAttempts().found).toBe(0);
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("reopen auto-recovery un-wedges a RUNNING Run and frees the queue before any manual scan", () => {
    const dir = makeTempDir("orch-runner-reopen-wedge");
    const clock = makeClock(Date.parse(T1));
    const runner = new Runner(dir, { runProfile: PROFILE, now: clock.now, leaseDurationMs: 60_000 });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      // A wedged RUNNING Run with no attempt (historical pre-fix state) plus a
      // healthy QUEUED Run behind it.
      insertQueuedRun(seedDb, "run-wedged", "R01", T0);
      insertResolvableQueuedRun(seedDb, dir, "run-queued", "R02", T1);
      seedDb
        .prepare("UPDATE runs SET status = 'RUNNING', started_at = ? WHERE id = 'run-wedged'")
        .run(T1);
      seedDb.close();
      seedDb = null;

      // The mandatory open-time recovery runs the moment the Runner reopens,
      // before any manual scan: the wedged Run is failed truthfully with
      // AGENT_INTERRUPTED / RECOVERY_FAILED, never CANCELLED.
      runner.open();
      const scan = runner.recoveryScanResult;
      expect(scan).not.toBeNull();
      expect(
        scan?.entries.some(
          (entry) =>
            entry.runId === "run-wedged" &&
            entry.outcome === "RECOVERY_FAILED" &&
            entry.failureCode === "AGENT_INTERRUPTED"
        )
      ).toBe(true);
      expect(runner.getRunDetail("run-wedged").run.status).toBe("FAILED");
      expect(runner.getRunDetail("run-wedged").run.failureCode).toBe("AGENT_INTERRUPTED");
      expect(runner.getRunDetail("run-wedged").run.status).not.toBe("CANCELLED");

      // The queue unblocked AND drains on its own (F2): the QUEUED Run is
      // claimed automatically by the loop the Runner started at open — no
      // manual scan or claim needed — and the claim owner is the Runner's
      // own token.
      clock.set(T2);
      expect(runner.getRunDetail("run-queued").run.status).toBe("RUNNING");
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("throws structured errors for unknown attempts and unknown Runs", () => {
    const fixture = openFixture("orch-not-found");
    try {
      expect(() =>
        fixture.orchestrator.renewAttemptLease({
          runId: "run-ghost",
          attemptId: "attempt-ghost",
          ownerToken: fixture.orchestrator.ownerToken
        })
      ).toThrowError(NotFoundError);
      expect(fixture.orchestrator.getRunAttempt("attempt-ghost")).toBeNull();
      expect(() =>
        fixture.orchestrator.finishAttempt({
          runId: "run-ghost",
          attemptId: "attempt-ghost",
          ownerToken: fixture.orchestrator.ownerToken,
          status: "FINISHED",
          finishedAt: T1
        })
      ).toThrowError(NotFoundError);
    } finally {
      closeFixture(fixture);
    }
  });
});
