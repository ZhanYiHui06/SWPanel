import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import type { Drawing, DrawingRevision, FakeExecutorScenario, InputAdapterResult, RevisionSourceFile, RunEvent, RunStage } from "@swpanel/domain";
import type { ResultManifest } from "@swpanel/contracts";
import { RunnerInvariantError } from "../errors.js";
import { makeTempDir, removeTempDir, samplePdfBytes, sha256Of } from "../test-utils.js";
import { SqliteDatabase } from "../db/database.js";
import { SqliteRepository } from "../db/repository.js";
import { RunRepository, type RunProfile } from "../db/run-repository.js";
import { RunOrchestrator, type RunRecoveryCapabilities } from "../orchestration/run-orchestrator.js";
import { RunWorkspaceLedger, type RunWorkspaceLayout, type StoredRunFile } from "../ledger/run-workspace-ledger.js";
import { Runner } from "../runner.js";
import {
  FakeExecutor,
  type AttemptWorkspace,
  type ExecutorScheduler,
  type ScheduledTask,
  type SolidWorksOwnershipSurface
} from "./fake-executor.js";
import {
  buildOwnershipRecord,
  pidOf,
  SolidWorksOwnershipGuard,
  type SolidWorksIdentity,
  type SolidWorksIdentityCloser
} from "./ownership/solidworks-ownership-guard.js";
import {
  SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
  SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION
} from "./ownership/solidworks-ownership-registry.js";
import { WorkspaceSolidWorksOwnershipSurface } from "./ownership/workspace-solidworks-ownership-surface.js";
import {
  decideThreadResume,
  hasSafeCheckpoint,
  isPinnedThreadSessionProtocol,
  PINNED_THREAD_SESSION_PROTOCOL,
  PINNED_THREAD_SESSION_PROTOCOL_VERSION,
  type ThreadSessionLike
} from "./recovery/thread-session-recovery.js";
import { threadSessionRecoveryCapabilities } from "./recovery/thread-session-recovery-capabilities.js";
import { FakeAgentAdapter, type AgentResultInput, type RawAgentAdapter } from "../agent/fake-agent-adapter.js";
import {
  AgentTurnError,
  type AgentTurnAdapter,
  type AgentTurnInput,
  type AgentTurnOutcome
} from "../agent/agent-turn-adapter.js";
import { CodexAppServerAdapter, CODEX_APP_SERVER_ADAPTER_ID } from "../agent/codex/codex-app-server-adapter.js";
import {
  CODEX_CLI_VERSION,
  CODEX_PROTOCOL_VERSION
} from "../agent/codex/builders.js";
import { CodexAppServerClient, type CodexTransport } from "../agent/codex/codex-app-server-client.js";
import {
  decodeJsonRpcLine,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest
} from "../agent/codex/jsonrpc-codec.js";
import { RAW_AGENT_LOG_RELATIVE_PATH, RAW_AGENT_RECORDS_VERSION, type RawAgentRecord } from "../agent/raw-agent-records.js";
import {
  AGENT_SESSION_FILE_RELATIVE_PATH,
  buildAgentSessionRecord,
  readAgentSessionRecord,
  validateAgentSessionRecord,
  writeAgentSessionRecord
} from "../agent/codex/agent-session.js";
import { produceSyntheticResultArtifactSet } from "../artifacts/result-artifact-set.js";
import { ArtifactValidator } from "../artifacts/artifact-validator.js";
import { FAKE_PREFLIGHT_SKILL_SHA256 } from "../preflight/preflight.js";
import {
  FakeInputAdapter,
  type InputAdapter,
  type InputAdapterContext,
  type InputAdapterSource
} from "../adaptation/input-adapter.js";

const T0 = "2026-08-13T09:00:00.000Z";
const T1 = "2026-08-13T09:01:00.000Z";

const PROFILE: RunProfile = {
  promptTemplateVersion: "prompt-template-v3",
  // The Runner ALWAYS gates PREPARING with the synthetic preflight fixture
  // (P5-1): the all-pass path requires the fixture's EXACT digest, so
  // Runner-based tests freeze the fixture digest, never an arbitrary hash.
  skill: { name: "solidworks-build-part-from-drawing", sha256: FAKE_PREFLIGHT_SKILL_SHA256 },
  agentConfigId: "agent-config-1"
};

const ALL_STAGES: readonly RunStage[] = [
  "PREPARING",
  "ANALYZING",
  "PLANNING",
  "MODELING",
  "VALIDATING",
  "PACKAGING"
];

/**
 * Provider-wire Agent Turn Output document of a completed turn: all four
 * top-level fields present with the required nullable sentinels (questions
 * null; artifacts.processMp4 null when the optional recording artifact is
 * absent). The Codex adapter's strict projector maps it back onto the
 * canonical shape — the canonical registered root-oneOf document is never
 * emitted on the wire.
 */
function completedTurnOutputJson(manifest: ResultManifest): string {
  return JSON.stringify({
    contractVersion: 1,
    result: "completed",
    completed: {
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        ...(manifest.artifacts.processMp4 === undefined ? { processMp4: null } : {})
      }
    },
    questions: null
  });
}

/**
 * Deterministic manual scheduler: tasks run ONLY when the test flushes them
 * AND their delay has elapsed (delay-aware), so the executor's interleaving
 * with cancel / recovery / lease expiry is fully scripted. The scheduler owns
 * the shared clock (`now`), which the orchestrator and the executor both read;
 * `advance(ms)` moves the clock, which makes delayed tasks (recovery wake-ups,
 * stop timeouts) due.
 */
class ManualExecutorScheduler implements ExecutorScheduler {
  private tasks: Array<{ id: number; at: number; fn: () => void; cancelled: boolean }> = [];
  private nextId = 0;
  private currentMs: number;

  constructor(startMs: number) {
    this.currentMs = startMs;
  }

  /** Arrow field: safe to detach and hand to the orchestrator as `now`. */
  now = (): Date => new Date(this.currentMs);

  schedule(fn: () => void, delayMs: number): ScheduledTask {
    const id = ++this.nextId;
    const at = this.currentMs + Math.max(0, delayMs);
    const task = { id, at, fn, cancelled: false };
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

  getMs(): number {
    return this.currentMs;
  }

  /** True when at least one DUE task (delay elapsed) is pending. */
  hasPending(): boolean {
    return this.tasks.some((task) => !task.cancelled && task.at <= this.currentMs);
  }

  /** Runs exactly one due task (earliest deadline, FIFO tie-break). */
  flushOne(): boolean {
    const next = this.tasks
      .filter((task) => !task.cancelled && task.at <= this.currentMs)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (next === undefined) return false;
    this.tasks = this.tasks.filter((task) => task !== next);
    next.fn();
    return true;
  }

  /** Runs every currently-due task synchronously (one microtask batch). */
  flushAll(): void {
    while (this.flushOne()) {
      // synchronous
    }
  }
}

/** Runs every due task and drains the microtask chains they release. */
async function drainScheduler(scheduler: ManualExecutorScheduler): Promise<void> {
  let guard = 0;
  while (scheduler.hasPending() && guard++ < 10_000) {
    scheduler.flushAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface ExecFixture {
  dir: string;
  dbPath: string;
  db: SqliteDatabase;
  store: SqliteRepository;
  runs: RunRepository;
  orchestrator: RunOrchestrator;
  workspace: AttemptWorkspace;
  scheduler: ManualExecutorScheduler;
  executor: FakeExecutor;
}

function openExecFixture(
  prefix: string,
  options: {
    scenario?: FakeExecutorScenario;
    leaseDurationMs?: number;
    cooperativeStopTimeoutMs?: number;
    recoveryCapabilities?: RunRecoveryCapabilities;
    workspace?: AttemptWorkspace;
    start?: string;
    agent?: RawAgentAdapter | AgentTurnAdapter;
    ownsAgent?: boolean;
    artifactValidator?: ArtifactValidator;
    recordMp4?: boolean;
    publishModel?: boolean;
    inputAdapter?: InputAdapter | null;
    resolveInputSource?: ((runId: string) => InputAdapterSource | null) | null;
    skillResolvedPath?: string;
    ownership?: SolidWorksOwnershipSurface | null;
  } = {}
): ExecFixture {
  const dir = makeTempDir(prefix);
  const dbPath = join(dir, "state", "swpanel.db");
  const db = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  const runs = new RunRepository(db, store);
  const scheduler = new ManualExecutorScheduler(Date.parse(options.start ?? T0));
  const orchestrator = new RunOrchestrator(db, runs, {
    now: scheduler.now,
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    ...(options.recoveryCapabilities === undefined
      ? {}
      : { recoveryCapabilities: options.recoveryCapabilities })
  });
  let workspace: AttemptWorkspace;
  if (options.workspace !== undefined) {
    workspace = options.workspace;
  } else {
    const ledger = new RunWorkspaceLedger({ workspaceRoot: join(dir, "workspaces") });
    ledger.open();
    workspace = ledger;
  }
  const executor = new FakeExecutor({
    orchestrator,
    runs,
    workspace,
    scenario: options.scenario ?? "success",
    scheduler,
    now: scheduler.now,
    cooperativeStopTimeoutMs: options.cooperativeStopTimeoutMs ?? 1_000,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.ownsAgent === undefined ? {} : { ownsAgent: options.ownsAgent }),
    ...(options.artifactValidator === undefined ? {} : { artifactValidator: options.artifactValidator }),
    ...(options.recordMp4 === undefined ? {} : { recordMp4: options.recordMp4 }),
    ...(options.publishModel === undefined ? {} : { publishModel: options.publishModel }),
    ...(options.inputAdapter === undefined ? {} : { inputAdapter: options.inputAdapter }),
    ...(options.resolveInputSource === undefined ? {} : { resolveInputSource: options.resolveInputSource }),
    ...(options.skillResolvedPath === undefined ? {} : { skillResolvedPath: options.skillResolvedPath }),
    ...(options.ownership === undefined ? {} : { ownership: options.ownership })
  });
  return { dir, dbPath, db, store, runs, orchestrator, workspace, scheduler, executor };
}

function closeExecFixture(fixture: ExecFixture): void {
  if (fixture.db.isOpen) fixture.db.close();
  removeTempDir(fixture.dir);
}

/** Reopens the same database file as a fresh Runner process would. */
function reopenExecFixture(
  fixture: ExecFixture,
  startAt: string,
  options: {
    scenario?: FakeExecutorScenario;
    leaseDurationMs?: number;
    recoveryCapabilities?: RunRecoveryCapabilities;
  } = {}
): ExecFixture {
  fixture.db.close();
  const db = new SqliteDatabase({ dbPath: fixture.dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  const runs = new RunRepository(db, store);
  const scheduler = new ManualExecutorScheduler(Date.parse(startAt));
  const orchestrator = new RunOrchestrator(db, runs, {
    now: scheduler.now,
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    ...(options.recoveryCapabilities === undefined
      ? {}
      : { recoveryCapabilities: options.recoveryCapabilities })
  });
  const ledger = new RunWorkspaceLedger({ workspaceRoot: join(fixture.dir, "workspaces") });
  ledger.open();
  const executor = new FakeExecutor({
    orchestrator,
    runs,
    workspace: ledger,
    scenario: options.scenario ?? "success",
    scheduler,
    now: scheduler.now,
    cooperativeStopTimeoutMs: 1_000
  });
  return { ...fixture, db, store, runs, orchestrator, workspace: ledger, scheduler, executor };
}

/** Seeds a Drawing + Revision through the low-level store primitives. */
function seedRevision(
  fixture: ExecFixture,
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

function createQueuedRun(fixture: ExecFixture, createdAt = T0) {
  return fixture.runs.createRun({
    drawingId: "drawing-a",
    revisionId: "revision-a1",
    profile: PROFILE,
    createdAt
  });
}

function runRow(fixture: ExecFixture, runId: string) {
  return fixture.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as {
    status: string;
    stage: string | null;
    started_at: string | null;
    completed_at: string | null;
    failure_code: string | null;
    failure_message: string | null;
    model_id: string | null;
    clarification_request_id: string | null;
    cancellation_requested_at: string | null;
    cancellation_confirmed_at: string | null;
  };
}

function attemptRow(fixture: ExecFixture, attemptId: string) {
  return fixture.db.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId) as {
    status: string | null;
    owner_token: string | null;
    claimed_at: string | null;
    lease_deadline_at: string | null;
    heartbeat_at: string | null;
    finished_at: string | null;
    interruption_kind: string | null;
    recovery_decision: string | null;
  };
}

function scalar(db: SqliteDatabase, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

function modelCount(db: SqliteDatabase): number {
  return scalar(db, "SELECT COUNT(*) AS count FROM models");
}

function artifactCount(db: SqliteDatabase): number {
  return scalar(db, "SELECT COUNT(*) AS count FROM artifacts");
}

function eventsOf(fixture: ExecFixture, runId: string): RunEvent[] {
  return fixture.runs.listRunEvents(runId);
}

function eventTypes(fixture: ExecFixture, runId: string): string[] {
  return eventsOf(fixture, runId).map((event) => event.type);
}

function stageSequence(fixture: ExecFixture, runId: string): RunStage[] {
  return eventsOf(fixture, runId)
    .filter((event): event is RunEvent & { type: "StageChanged"; stage: RunStage } => event.type === "StageChanged")
    .map((event) => event.stage);
}

function attemptWorkspacePath(fixture: ExecFixture, runId: string, attemptSequence: number): string {
  const label = `attempt-${String(attemptSequence).padStart(3, "0")}`;
  return join(fixture.dir, "workspaces", "runs", runId, label);
}

/**
 * Input Adapter that THROWS on its FIRST conversion (an "adaptation IO
 * exception" a real adapter could surface) and then delegates to the
 * deterministic fake adapter, so a LATER claim of the same queue executes
 * normally — proving one thrown adaptation error never kills the serial queue.
 */
class ThrowingOnceInputAdapter implements InputAdapter {
  private thrown = false;
  private readonly delegate = new FakeInputAdapter({
    scenario: "single-page-pdf",
    now: () => new Date(T0),
    readSourceBytes: () => samplePdfBytes()
  });

  adapt(context: InputAdapterContext): InputAdapterResult {
    if (!this.thrown) {
      this.thrown = true;
      throw new Error("injected adapter throw: conversion crashed");
    }
    return this.delegate.adapt(context);
  }
}

/**
 * Attempt workspace that throws on the FIRST attempt-scoped write (a "workspace
 * IO exception") and then delegates every operation to the real ledger, so the
 * next claim writes normally — the interrupted claim is left for the
 * lease-deadline-aware recovery while the queue itself keeps running.
 */
class ThrowingWriteWorkspace implements AttemptWorkspace {
  private threwFor: string | null = null;

  constructor(private readonly delegate: AttemptWorkspace) {}

  createAttemptWorkspace(runId: string, attemptSequence: number): RunWorkspaceLayout {
    return this.delegate.createAttemptWorkspace(runId, attemptSequence);
  }

  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): StoredRunFile {
    if (this.threwFor === null) {
      this.threwFor = input.runId;
      throw new Error("injected workspace write failure");
    }
    return this.delegate.writeOwnedFile(input);
  }

  readOwnedFile(input: { runId: string; attemptSequence: number; relativePath: string }) {
    return this.delegate.readOwnedFile(input);
  }

  deleteAttemptWorkspace(runId: string, attemptSequence: number): void {
    this.delegate.deleteAttemptWorkspace(runId, attemptSequence);
  }
}

/** Starts the queue and drains it fully (used by terminal scenarios). */
async function runToCompletion(fixture: ExecFixture): Promise<void> {
  const queue = fixture.executor.runQueue();
  await drainScheduler(fixture.scheduler);
  await queue;
}

/**
 * Agent adapter that delegates the deterministic Fake Agent Adapter and then —
 * for the FIRST produced result only — rewrites the persisted Result Manifest
 * so TWO manifest keys (`preview` and `sldprt`) declare the SAME canonical
 * file path. The independent validator must reject the aliased manifest as
 * ARTIFACT_MANIFEST_INVALID before any file verification; later claims produce
 * clean sets, so the serial queue demonstrably continues after the rejection.
 */
class DuplicatePathAgentAdapter implements RawAgentAdapter {
  private readonly delegate = new FakeAgentAdapter();
  private aliasedOnce = false;
  get adapterId(): string {
    return this.delegate.adapterId;
  }
  get adapterVersion(): string {
    return this.delegate.adapterVersion;
  }
  get protocol(): string {
    return this.delegate.protocol;
  }
  get protocolVersion(): string {
    return this.delegate.protocolVersion;
  }
  threadIdFor(runId: string): string {
    return this.delegate.threadIdFor(runId);
  }
  produceResult(input: AgentResultInput): readonly RawAgentRecord[] {
    const records = this.delegate.produceResult(input);
    if (this.aliasedOnce) return records;
    this.aliasedOnce = true;
    // Rebuild the manifest document the delegate wrote and alias `preview`
    // onto the sldprt path (duplicate canonical path). The event reference
    // still points at `output/result-manifest.json`.
    const manifest = produceSyntheticResultArtifactSet({
      runId: input.runId,
      attemptSequence: input.attemptSequence,
      recordMp4: input.recordMp4,
      solidWorksVersion: "2025",
      adapterId: this.adapterId,
      adapterVersion: this.adapterVersion
    }).manifest;
    const aliased = {
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        preview: {
          ...manifest.artifacts.preview,
          relativePath: manifest.artifacts.sldprt.relativePath
        }
      }
    };
    input.workspace.writeOwnedFile({
      runId: input.runId,
      attemptSequence: input.attemptSequence,
      relativePath: "output/result-manifest.json",
      content: Buffer.from(JSON.stringify(aliased, null, 2) + "\n", "utf8")
    });
    return records;
  }
}

/**
 * Agent adapter that delegates the deterministic Fake Agent Adapter and then —
 * for the FIRST produced result only — rewrites the persisted Result Manifest
 * so it claims `productionVerified: true`. The Agent claim is never
 * authoritative: no independent production/HIL verification record exists, so
 * the independent validator must reject the manifest as
 * ARTIFACT_MANIFEST_INVALID (fail closed) and no Model may be published; later
 * claims produce clean sets, so the serial queue demonstrably continues.
 */
class ProductionVerifiedClaimAgentAdapter implements RawAgentAdapter {
  private readonly delegate = new FakeAgentAdapter();
  private claimedOnce = false;
  get adapterId(): string {
    return this.delegate.adapterId;
  }
  get adapterVersion(): string {
    return this.delegate.adapterVersion;
  }
  get protocol(): string {
    return this.delegate.protocol;
  }
  get protocolVersion(): string {
    return this.delegate.protocolVersion;
  }
  threadIdFor(runId: string): string {
    return this.delegate.threadIdFor(runId);
  }
  produceResult(input: AgentResultInput): readonly RawAgentRecord[] {
    const records = this.delegate.produceResult(input);
    if (this.claimedOnce) return records;
    this.claimedOnce = true;
    const manifest = produceSyntheticResultArtifactSet({
      runId: input.runId,
      attemptSequence: input.attemptSequence,
      recordMp4: input.recordMp4,
      solidWorksVersion: "2025",
      adapterId: this.adapterId,
      adapterVersion: this.adapterVersion
    }).manifest;
    input.workspace.writeOwnedFile({
      runId: input.runId,
      attemptSequence: input.attemptSequence,
      relativePath: "output/result-manifest.json",
      content: Buffer.from(
        JSON.stringify({ ...manifest, productionVerified: true }, null, 2) + "\n",
        "utf8"
      )
    });
    return records;
  }
}

describe("FakeExecutor success scenario", () => {
  it("walks all six stages in order, completes without a Model and finishes the attempt", async () => {
    const fixture = openExecFixture("exec-success", { scenario: "success" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("COMPLETED");
      expect(row.stage).toBeNull();
      expect(row.completed_at).toBe(T0);
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);

      // The exact ordered event stream: one StageChanged + ActivityUpdated +
      // ProgressUpdated trio per stage, then the terminal Completed.
      const types = eventTypes(fixture, run.id);
      const expectedTrio: string[] = [];
      for (let index = 0; index < ALL_STAGES.length; index++) {
        expectedTrio.push("StageChanged", "ActivityUpdated", "ProgressUpdated");
      }
      // The Phase 4 result phase appends the translated raw records
      // (metadata / turn / manifest) before the orchestrator-owned Completed.
      expect(types).toEqual([
        ...expectedTrio,
        "RuntimeMetadataUpdated",
        "AgentTurnCompleted",
        "ResultManifestReceived",
        "Completed"
      ]);
      expect(stageSequence(fixture, run.id)).toEqual(ALL_STAGES);
      const progress = eventsOf(fixture, run.id).filter((event) => event.type === "ProgressUpdated");
      expect(progress.map((event) => event.progressPercent)).toEqual([17, 33, 50, 67, 83, 100]);
      // Every event references the ACTIVE attempt of this claim.
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).not.toBeNull();
      expect(eventsOf(fixture, run.id).every((event) => event.attemptId === attempt?.id)).toBe(true);
      expect(attempt).toMatchObject({ status: "FINISHED", finishedAt: T0 });
      expect(attempt?.interruptionKind).toBeUndefined();
      // The isolated attempt workspace was created and holds the fake result.
      const workspace = attemptWorkspacePath(fixture, run.id, attempt?.attemptSequence ?? 1);
      expect(existsSync(workspace)).toBe(true);
      expect(
        existsSync(join(workspace, "output", "fake-result.txt"))
      ).toBe(true);
      // P4-5: the produced synthetic artifact set + Result Manifest are on
      // disk and the manifest reference of the event resolves to a file.
      expect(existsSync(join(workspace, "output", "result-manifest.json"))).toBe(true);
      expect(existsSync(join(workspace, "output", "fake-model.sldprt"))).toBe(true);
      expect(existsSync(join(workspace, "logs", "agent-raw.log"))).toBe(true);
      const manifestEvent = eventsOf(fixture, run.id).find(
        (event) => event.type === "ResultManifestReceived"
      );
      expect(manifestEvent).toMatchObject({
        type: "ResultManifestReceived",
        manifestRef: "output/result-manifest.json"
      });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("claims Runs serially: exactly one RUNNING Run and one claim at a time", async () => {
    const fixture = openExecFixture("exec-serial", { scenario: "success" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      const second = createQueuedRun(fixture, T1);
      // The executor is never started: both Runs stay QUEUED.
      expect(runRow(fixture, first.id).status).toBe("QUEUED");
      expect(runRow(fixture, second.id).status).toBe("QUEUED");
      expect(scalar(fixture.db, "SELECT COUNT(*) AS count FROM run_attempts")).toBe(0);

      await runToCompletion(fixture);

      // FIFO: the first Run was claimed and completed before the second.
      expect(runRow(fixture, first.id).status).toBe("COMPLETED");
      expect(runRow(fixture, second.id).status).toBe("COMPLETED");
      const attempts = fixture.db
        .prepare("SELECT run_id, attempt_sequence, status FROM run_attempts")
        .all() as unknown as Array<{ run_id: string; attempt_sequence: number; status: string }>;
      expect(attempts).toHaveLength(2);
      const attemptByRun = new Map(attempts.map((attempt) => [attempt.run_id, attempt]));
      expect(attemptByRun.get(first.id)).toMatchObject({ attempt_sequence: 1, status: "FINISHED" });
      expect(attemptByRun.get(second.id)).toMatchObject({ attempt_sequence: 1, status: "FINISHED" });
      // Both isolated workspaces exist.
      expect(existsSync(attemptWorkspacePath(fixture, first.id, 1))).toBe(true);
      expect(existsSync(attemptWorkspacePath(fixture, second.id, 1))).toBe(true);
      expect(
        scalar(fixture.db, "SELECT COUNT(*) AS count FROM runs WHERE status = 'RUNNING'")
      ).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor clarification scenario", () => {
  it("stops BEFORE MODELING with a persisted, queryable OPEN clarification request, no Model and no manifest claim", async () => {
    const fixture = openExecFixture("exec-clarification", { scenario: "clarification" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("CLARIFICATION_REQUIRED");
      expect(row.stage).toBeNull();
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      expect(artifactCount(fixture.db)).toBe(0);
      // Clarification happens before MODELING: only three stages were walked.
      expect(stageSequence(fixture, run.id)).toEqual(["PREPARING", "ANALYZING", "PLANNING"]);
      const types = eventTypes(fixture, run.id);
      expect(types.at(-1)).toBe("ClarificationRequired");
      expect(types).not.toContain("Completed");
      // The terminal ClarificationRequired event is EXACTLY ONE: the raw
      // stream of the clarification turn carries no clarification_requested
      // record, so the translator could never have produced a duplicate.
      expect(types.filter((type) => type === "ClarificationRequired")).toHaveLength(1);
      // The runtime events of the turn were translated and persisted FIRST
      // (P5 dispatch: translate/persist, then clarifyAttempt), and NO manifest
      // claim / validation was ever attempted.
      expect(types.indexOf("RuntimeMetadataUpdated")).toBeGreaterThanOrEqual(0);
      expect(types.indexOf("AgentTurnCompleted")).toBeGreaterThan(
        types.indexOf("RuntimeMetadataUpdated")
      );
      expect(types.indexOf("ClarificationRequired")).toBeGreaterThan(
        types.indexOf("AgentTurnCompleted")
      );
      expect(types).not.toContain("ResultManifestReceived");
      expect(types).not.toContain("ArtifactValidationFailed");

      const requestId = row.clarification_request_id;
      expect(requestId).not.toBeNull();
      // The persisted clarification is queryable as OPEN with the questions the
      // AGENT turn produced (fake adapter); answers are not needed (they arrive
      // with the IPC batch, P3-4).
      const request = fixture.runs.getClarificationRequest(requestId ?? "");
      expect(request).toMatchObject({
        id: requestId,
        runId: run.id,
        revisionId: "revision-a1",
        status: "OPEN",
        answers: [],
        questions: [
          { type: "dimension", question: "底板厚度是多少？", unit: "mm" },
          { type: "choice", question: "焊缝处理方式？", options: [{ label: "无需焊缝" }, { label: "全周满焊" }] }
        ]
      });
      expect(request?.questions[0]?.id).toBeTruthy();
      expect(request?.questions[1]?.options?.[0]?.id).toBeTruthy();

      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "FINISHED" });
      expect(attempt?.interruptionKind).toBeUndefined();
      // No result manifest was produced by the clarification turn.
      const manifestPath = attemptWorkspacePath(fixture, run.id, 1);
      expect(existsSync(join(manifestPath, "output", "result-manifest.json"))).toBe(false);
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor terminal-outcome dispatch (Phase 5)", () => {
  /** Injected turn adapter that always settles with the clarification outcome. */
  class ClarificationOutcomeAgentAdapter implements AgentTurnAdapter {
    readonly adapterId = "stub-clarification";
    readonly adapterVersion = "1";
    readonly protocol = "stub";
    readonly protocolVersion = "1";

    threadIdFor(runId: string): string {
      return `thread-${runId}`;
    }

    runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
      const occurredAt = input.nowIso();
      return Promise.resolve({
        kind: "clarification",
        records: [
          {
            recordVersion: RAW_AGENT_RECORDS_VERSION,
            type: "metadata_updated",
            occurredAt,
            threadId: this.threadIdFor(input.runId),
            adapterId: this.adapterId,
            adapterVersion: this.adapterVersion,
            protocol: this.protocol,
            protocolVersion: this.protocolVersion,
            modelSupportsImageInput: true
          },
          {
            recordVersion: RAW_AGENT_RECORDS_VERSION,
            type: "turn_completed",
            occurredAt,
            threadId: this.threadIdFor(input.runId),
            turnId: `turn-${input.runId}-1`
          }
        ],
        questions: [{ id: "q1", type: "text", question: "材料是什么？" }]
      });
    }
  }

  /** Injected turn adapter that claims completion WITHOUT any manifest record. */
  class ManifestlessCompletedOutcomeAgentAdapter implements AgentTurnAdapter {
    readonly adapterId = "stub-manifestless";
    readonly adapterVersion = "1";
    readonly protocol = "stub";
    readonly protocolVersion = "1";

    threadIdFor(runId: string): string {
      return `thread-${runId}`;
    }

    runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
      const occurredAt = input.nowIso();
      return Promise.resolve({
        kind: "completed",
        records: [
          {
            recordVersion: RAW_AGENT_RECORDS_VERSION,
            type: "metadata_updated",
            occurredAt,
            threadId: this.threadIdFor(input.runId),
            adapterId: this.adapterId,
            adapterVersion: this.adapterVersion,
            protocol: this.protocol,
            protocolVersion: this.protocolVersion,
            modelSupportsImageInput: true
          },
          {
            recordVersion: RAW_AGENT_RECORDS_VERSION,
            type: "turn_completed",
            occurredAt,
            threadId: this.threadIdFor(input.runId),
            turnId: `turn-${input.runId}-1`
          }
        ]
      });
    }
  }

  it("a success-scenario run whose injected agent settles with the clarification outcome ends CLARIFICATION_REQUIRED without manifest validation or Model publication", async () => {
    const fixture = openExecFixture("exec-outcome-clarify", {
      agent: new ClarificationOutcomeAgentAdapter()
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("CLARIFICATION_REQUIRED");
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      expect(artifactCount(fixture.db)).toBe(0);
      const types = eventTypes(fixture, run.id);
      // Runtime events persisted first, then the SINGLE orchestrator-owned
      // ClarificationRequired; no manifest claim, no validation, no Model.
      expect(types).not.toContain("Completed");
      expect(types).not.toContain("ResultManifestReceived");
      expect(types).not.toContain("ArtifactValidationFailed");
      expect(types.filter((type) => type === "ClarificationRequired")).toHaveLength(1);
      expect(types.at(-1)).toBe("ClarificationRequired");
      expect(types).toContain("RuntimeMetadataUpdated");
      expect(types).toContain("AgentTurnCompleted");

      const request = fixture.runs.getClarificationRequest(row.clarification_request_id ?? "");
      // The orchestrator mints request/question ids; the QUESTION CONTENT comes
      // from the agent outcome verbatim.
      expect(request).toMatchObject({
        status: "OPEN",
        answers: [],
        questions: [{ type: "text", question: "材料是什么？" }]
      });
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "FINISHED" });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a completed outcome WITHOUT a manifest claim fails closed ARTIFACT_MANIFEST_INVALID (never a silent success)", async () => {
    const fixture = openExecFixture("exec-outcome-nomanifest", {
      agent: new ManifestlessCompletedOutcomeAgentAdapter()
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("ARTIFACT_MANIFEST_INVALID");
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      const types = eventTypes(fixture, run.id);
      expect(types).toContain("ArtifactValidationFailed");
      expect(types.at(-1)).toBe("Failed");
      expect(types).not.toContain("Completed");
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor clarification pre-CAD runtime guard (F5)", () => {
  /**
   * Turn adapter that writes the given runtime ownership-registry content into
   * the attempt workspace and then settles with the clarification outcome —
   * exactly what a misbehaving Agent would do (register ownership before
   * requesting clarification).
   */
  function clarificationAdapterWritingRegistry(
    buildRegistry: (input: AgentTurnInput) => string
  ): AgentTurnAdapter {
    const delegate = new FakeAgentAdapter();
    return {
      adapterId: delegate.adapterId,
      adapterVersion: delegate.adapterVersion,
      protocol: delegate.protocol,
      protocolVersion: delegate.protocolVersion,
      threadIdFor: (runId) => delegate.threadIdFor(runId),
      runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
        input.workspace.writeOwnedFile({
          runId: input.runId,
          attemptSequence: input.attemptSequence,
          relativePath: SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
          content: Buffer.from(buildRegistry(input), "utf8")
        });
        const occurredAt = input.nowIso();
        return Promise.resolve({
          kind: "clarification",
          records: [
            {
              recordVersion: RAW_AGENT_RECORDS_VERSION,
              type: "metadata_updated",
              occurredAt,
              threadId: delegate.threadIdFor(input.runId),
              adapterId: delegate.adapterId,
              adapterVersion: delegate.adapterVersion,
              protocol: delegate.protocol,
              protocolVersion: delegate.protocolVersion,
              modelSupportsImageInput: true
            },
            {
              recordVersion: RAW_AGENT_RECORDS_VERSION,
              type: "turn_completed",
              occurredAt,
              threadId: delegate.threadIdFor(input.runId),
              turnId: `turn-${input.runId}-1`
            }
          ],
          questions: [{ id: "q1", type: "text", question: "材料是什么？" }]
        });
      }
    };
  }

  /** The shared assertions of the fail-closed protocol-violation outcome. */
  function expectProtocolViolation(fixture: ExecFixture, runId: string): void {
    const row = runRow(fixture, runId);
    expect(row.status).toBe("FAILED");
    expect(row.failure_code).toBe("AGENT_PROTOCOL_INCOMPATIBLE");
    expect(row.clarification_request_id).toBeNull();
    expect(row.model_id).toBeNull();
    expect(modelCount(fixture.db)).toBe(0);
    expect(artifactCount(fixture.db)).toBe(0);
    const types = eventTypes(fixture, runId);
    expect(types).not.toContain("ClarificationRequired");
    expect(types).not.toContain("Completed");
    expect(types).not.toContain("ResultManifestReceived");
    expect(types).not.toContain("ArtifactValidationFailed");
    expect(types.filter((type) => type === "Failed")).toHaveLength(1);
    expect(types.at(-1)).toBe("Failed");
    // The failure message stays generic and path-free.
    expect(row.failure_message).toContain("AGENT_PROTOCOL_INCOMPATIBLE");
    expect(row.failure_message).not.toContain("solidworks-ownership.json");
    const attempt = fixture.orchestrator.getRunAttempt(
      eventsOf(fixture, runId)[0]?.attemptId ?? ""
    );
    expect(attempt).toMatchObject({ status: "INTERRUPTED" });
  }

  it("a clarification outcome with a VALID runtime ownership registry fails AGENT_PROTOCOL_INCOMPATIBLE (fail closed, workspace retained)", async () => {
    const fixture = openExecFixture("exec-clarify-f5-valid-registry", {
      scenario: "success",
      agent: clarificationAdapterWritingRegistry((input) =>
        JSON.stringify({
          schemaVersion: SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION,
          runId: input.runId,
          attemptId: input.attemptId,
          attemptSequence: input.attemptSequence,
          updatedAt: input.nowIso(),
          documents: ["working/plate.sldprt"]
        })
      )
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      expectProtocolViolation(fixture, run.id);
      // The workspace is retained for manual inspection — the registry the
      // adapter wrote is still on disk, nothing was cleaned up or closed.
      const layout = fixture.workspace.createAttemptWorkspace(run.id, 1);
      expect(existsSync(join(layout.absoluteRoot, SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH))).toBe(
        true
      );
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a clarification outcome with a MALFORMED runtime ownership registry fails AGENT_PROTOCOL_INCOMPATIBLE (untrusted, fail closed)", async () => {
    const fixture = openExecFixture("exec-clarify-f5-malformed-registry", {
      scenario: "success",
      agent: clarificationAdapterWritingRegistry((input) =>
        JSON.stringify({
          schemaVersion: SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION + 1,
          runId: input.runId,
          attemptId: input.attemptId,
          attemptSequence: input.attemptSequence,
          updatedAt: input.nowIso(),
          documents: ["working/plate.sldprt"]
        })
      )
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      expectProtocolViolation(fixture, run.id);
      const layout = fixture.workspace.createAttemptWorkspace(run.id, 1);
      expect(existsSync(join(layout.absoluteRoot, SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH))).toBe(
        true
      );
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor failure scenario", () => {
  it("fails with a structured code, finishes the attempt INTERRUPTED and publishes nothing", async () => {
    const fixture = openExecFixture("exec-failure", { scenario: "failure" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("AGENT_RUNTIME_UNAVAILABLE");
      expect(row.failure_message).toBe("Fake 场景：模拟 Agent 运行时不可用");
      expect(row.stage).toBeNull();
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      expect(eventTypes(fixture, run.id).at(-1)).toBe("Failed");
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor cooperative-cancel scenario", () => {
  it("persists CancellationRequested first, stops later work, cleans the workspace and confirms atomically", async () => {
    const fixture = openExecFixture("exec-cooperative-cancel", { scenario: "cooperative-cancel" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      const queue = fixture.executor.runQueue();
      // Two flushes: PREPARING + ANALYZING trios emitted; the executor awaits
      // its third step tick when the cancellation arrives.
      expect(fixture.scheduler.flushOne()).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.scheduler.flushOne()).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "PLANNING" });

      const cancel = fixture.executor.cancelRun(run.id, "用户取消");
      await drainScheduler(fixture.scheduler);
      const result = await cancel;

      expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("CANCELLED");
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      // No later work ever ran: no MODELING stage, no terminal execution event.
      expect(stageSequence(fixture, run.id)).toEqual(["PREPARING", "ANALYZING", "PLANNING"]);
      const types = eventTypes(fixture, run.id);
      expect(types).toEqual([
        "StageChanged", "ActivityUpdated", "ProgressUpdated",
        "StageChanged", "ActivityUpdated", "ProgressUpdated",
        "StageChanged", "ActivityUpdated", "ProgressUpdated",
        "CancellationRequested", "CancellationConfirmed"
      ]);
      expect(types.at(-2)).toBe("CancellationRequested");
      expect(types.at(-1)).toBe("CancellationConfirmed");
      // The attempt ended CANCELLED with the CANCELLED interruption kind.
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "CANCELLED", interruptionKind: "CANCELLED" });
      // The allowlisted attempt workspace was cleaned up entirely.
      expect(existsSync(attemptWorkspacePath(fixture, run.id, 1))).toBe(false);
      // The queue drained: the executor loop ended after the cooperative stop.
      await queue;

      // Terminal repeat is stable and structured: no new events, same result.
      const repeat = await fixture.executor.cancelRun(run.id);
      expect(repeat).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: true });
      expect(eventsOf(fixture, run.id)).toHaveLength(11);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("cancelling a COMPLETED Run is a structured error and never touches history", async () => {
    const fixture = openExecFixture("exec-cancel-completed", { scenario: "success" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      await runToCompletion(fixture);
      const before = eventsOf(fixture, run.id);

      await expect(fixture.executor.cancelRun(run.id)).rejects.toThrowError(
        RunnerInvariantError
      );
      await expect(fixture.executor.cancelRun(run.id)).rejects.toThrowError(/COMPLETED/);
      expect(eventsOf(fixture, run.id)).toEqual(before);
      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("concurrent RUNNING cancels are serialized: one CancellationRequested, all callers share the stable result", async () => {
    const fixture = openExecFixture("exec-concurrent-cancel", {
      scenario: "cooperative-cancel"
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      const queue = fixture.executor.runQueue();
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "PLANNING" });

      // Two callers race: the second shares the first caller's in-flight
      // outcome and never appends a second request event.
      const first = fixture.executor.cancelRun(run.id, "并发取消");
      const second = fixture.executor.cancelRun(run.id, "并发取消重试");
      await drainScheduler(fixture.scheduler);
      const result1 = await first;
      const result2 = await second;

      expect(result1).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      expect(result2).toEqual(result1);
      const types = eventTypes(fixture, run.id);
      expect(types.filter((type) => type === "CancellationRequested")).toHaveLength(1);
      expect(types.filter((type) => type === "CancellationConfirmed")).toHaveLength(1);
      expect(types.at(-2)).toBe("CancellationRequested");
      expect(types.at(-1)).toBe("CancellationConfirmed");
      // A later repeat is the stable terminal outcome with no new events.
      const repeat = await fixture.executor.cancelRun(run.id);
      expect(repeat).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: true });
      expect(eventsOf(fixture, run.id)).toHaveLength(types.length);
      await queue;
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a retried cancel after an interrupted cancel persists exactly one CancellationRequested", async () => {
    const fixture = openExecFixture("exec-retry-cancel", { scenario: "success" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // The user's first cancel "crashed" mid-flight: CancellationRequested was
      // persisted but the process died before confirming.
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim?.attempt.id ?? "",
        entries: [
          { payload: { type: "CancellationRequested", reason: "中断的取消" }, occurredAt: T1 }
        ]
      });
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      // Move the clock past the request timestamp (and past the claim lease,
      // which is irrelevant for the owned attempt) before the retried cancel.
      fixture.scheduler.advance(61_000);

      // The retried cancel must NOT append a second request event.
      const result = await fixture.executor.cancelRun(run.id, "重试取消");
      expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      const types = eventTypes(fixture, run.id);
      expect(types.filter((type) => type === "CancellationRequested")).toHaveLength(1);
      expect(types.at(-1)).toBe("CancellationConfirmed");
      expect(runRow(fixture, run.id).status).toBe("CANCELLED");
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor hang scenario", () => {
  it("cancelling a hung Run persists CancellationRequested first, settles the claim and confirms CANCELLED", async () => {
    const fixture = openExecFixture("exec-hang-cancel", {
      scenario: "hang",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      const queue = fixture.executor.runQueue();
      // Two flushes: the executor hangs after the ANALYZING trio.
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });

      // The user cancels the hung Run: CancellationRequested is persisted
      // immediately, the cooperative-abort signal settles the hung claim, and
      // the cancellation is confirmed atomically.
      const cancel = fixture.executor.cancelRun(run.id, "挂起取消");
      await drainScheduler(fixture.scheduler);
      const result = await cancel;

      expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("CANCELLED");
      expect(row.cancellation_requested_at).toBe(T0);
      expect(row.cancellation_confirmed_at).toBe(T0);
      const types = eventTypes(fixture, run.id);
      expect(types).toEqual([
        "StageChanged", "ActivityUpdated", "ProgressUpdated",
        "StageChanged", "ActivityUpdated", "ProgressUpdated",
        "CancellationRequested", "CancellationConfirmed"
      ]);
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "CANCELLED", interruptionKind: "CANCELLED" });
      expect(modelCount(fixture.db)).toBe(0);
      // The hung claim settled: the queue loop drained and its promise
      // resolved (no wedge left behind).
      await queue;
      // The attempt workspace existed (created at claim) but held no files:
      // the cancel cleanup removed the allowlisted subtree.
      expect(existsSync(attemptWorkspacePath(fixture, run.id, 1))).toBe(false);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("after a hang cancellation the executor settles and the next queued Run executes", async () => {
    const fixture = openExecFixture("exec-hang-cancel-next", {
      scenario: "hang",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const hung = createQueuedRun(fixture, T0);
      const next = createQueuedRun(fixture, T1);
      const queue = fixture.executor.runQueue();
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runRow(fixture, hung.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });

      const cancel = fixture.executor.cancelRun(hung.id, "挂起取消");
      await drainScheduler(fixture.scheduler);
      await cancel;
      await drainScheduler(fixture.scheduler);
      // The claim settled; the loop continued and executed the next queued Run.
      await queue;

      expect(runRow(fixture, hung.id).status).toBe("CANCELLED");
      expect(runRow(fixture, next.id).status).toBe("COMPLETED");
      const attempts = fixture.db
        .prepare("SELECT run_id, status FROM run_attempts")
        .all() as unknown as Array<{ run_id: string; status: string }>;
      const byRun = new Map(attempts.map((attempt) => [attempt.run_id, attempt.status]));
      expect(byRun.get(hung.id)).toBe("CANCELLED");
      expect(byRun.get(next.id)).toBe("FINISHED");
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("an uncancelled hang expires its lease and recovery fails it — never CANCELLED", async () => {
    const fixture = openExecFixture("exec-hang-recovery", {
      scenario: "hang",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      void fixture.executor.runQueue();
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const attemptId = eventsOf(fixture, run.id)[0]?.attemptId ?? "";

      // The clock passes the lease with no heartbeat: the attempt is stale.
      fixture.scheduler.advance(61_000);
      const scan = fixture.orchestrator.recoverExpiredAttempts();
      expect(scan.found).toBe(1);
      expect(scan.entries[0]).toMatchObject({
        attemptId,
        runId: run.id,
        outcome: "RECOVERY_UNSUPPORTED",
        decision: "RECOVERY_UNSUPPORTED",
        stage: "ANALYZING",
        failureCode: "RECOVERY_UNSUPPORTED"
      });
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("RECOVERY_UNSUPPORTED");
      expect(row.status).not.toBe("CANCELLED");
      expect(eventTypes(fixture, run.id)).not.toContain("CancellationRequested");
      const attempt = fixture.orchestrator.getRunAttempt(attemptId);
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        recoveryDecision: "RECOVERY_UNSUPPORTED"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor crash scenario", () => {
  it("an unexpected crash leaves no terminal event and in-process lease expiry auto-recovers it — never CANCELLED", async () => {
    const fixture = openExecFixture("exec-crash", {
      scenario: "crash",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      const next = createQueuedRun(fixture, T1);
      // The executor walks PREPARING..MODELING and then stops without any
      // terminal event (simulated process death); the loop goes idle and
      // schedules a lease-deadline-aware recovery wake-up (no busy loop).
      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("RUNNING");
      expect(row.stage).toBe("MODELING");
      const types = eventTypes(fixture, run.id);
      expect(types).not.toContain("Completed");
      expect(types).not.toContain("Failed");
      expect(types).not.toContain("CancellationRequested");
      const attemptId = eventsOf(fixture, run.id)[0]?.attemptId ?? "";
      expect(attemptRow(fixture, attemptId).status).toBe("ACTIVE");
      // Partial workspace files from the interrupted work remain.
      expect(existsSync(join(attemptWorkspacePath(fixture, run.id, 1), "working", "partial.txt"))).toBe(true);
      // Nothing has run yet and the queue is still blocked: the idle loop
      // scheduled the lease-deadline wake-up (not due while the lease is
      // valid), so the loop is NOT spinning.
      expect(runRow(fixture, next.id).status).toBe("QUEUED");
      expect(fixture.orchestrator.nextActiveLeaseDeadline()).not.toBeNull();
      expect(fixture.executor.isRunning).toBe(true);

      // In-process lease expiry: the ongoing recovery wake-up fires and the
      // scan classifies the crash truthfully (no safe checkpoint at MODELING).
      fixture.scheduler.advance(61_000);
      await drainScheduler(fixture.scheduler);
      await queue;

      const failed = runRow(fixture, run.id);
      expect(failed.status).toBe("FAILED");
      expect(failed.failure_code).toBe("RECOVERY_FAILED");
      expect(failed.status).not.toBe("CANCELLED");
      const attempt = fixture.orchestrator.getRunAttempt(attemptId);
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        recoveryDecision: "RECOVERY_FAILED"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
      expect(modelCount(fixture.db)).toBe(0);
      // The queue unblocked: the next queued Run executed automatically.
      expect(runRow(fixture, next.id).status).toBe("COMPLETED");
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a user cancel of a crashed (not yet recovered) Run still cancels it and cleans its workspace", async () => {
    const fixture = openExecFixture("exec-crash-then-cancel", {
      scenario: "crash",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // The executor crashes (no terminal event); the loop goes idle awaiting
      // the lease-deadline wake-up — the queue loop stays pending.
      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      const workspace = attemptWorkspacePath(fixture, run.id, 1);
      expect(existsSync(join(workspace, "working", "partial.txt"))).toBe(true);

      const result = await fixture.executor.cancelRun(run.id, "崩溃后取消");
      expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      const types = eventTypes(fixture, run.id);
      expect(types.at(-2)).toBe("CancellationRequested");
      expect(types.at(-1)).toBe("CancellationConfirmed");
      expect(modelCount(fixture.db)).toBe(0);
      // The allowlisted workspace was cleaned by the cancel.
      expect(existsSync(workspace)).toBe(false);
      // The cancel settled the blocking attempt: the idle loop woke up and the
      // queue loop settled without waiting for the lease deadline.
      await queue;
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor recovery scenarios", () => {
  it("recovery-supported: in-process lease expiry resumes the interrupted attempt and completes", async () => {
    const fixture = openExecFixture("exec-recovery-supported", {
      scenario: "recovery-supported",
      leaseDurationMs: 60_000,
      recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // The executor walks PREPARING + ANALYZING and then stops without a
      // terminal event (interrupted work the scenario declares resumable); the
      // idle loop schedules the lease-deadline wake-up.
      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });
      expect(eventsOf(fixture, run.id)).toHaveLength(6);
      const attemptId = eventsOf(fixture, run.id)[0]?.attemptId ?? "";

      // In-process lease expiry: the ongoing recovery wake-up reconsiders the
      // interrupted attempt and RESUMES it through the injected capability.
      fixture.scheduler.advance(61_000);
      await drainScheduler(fixture.scheduler);
      await queue;

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("COMPLETED");
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      expect(stageSequence(fixture, run.id)).toEqual([
        "PREPARING", "ANALYZING", "PLANNING", "MODELING", "VALIDATING", "PACKAGING"
      ]);
      expect(eventTypes(fixture, run.id).at(-1)).toBe("Completed");
      // Exactly one attempt row: the resume continued it, no re-claim happened.
      expect(scalar(fixture.db, "SELECT COUNT(*) AS count FROM run_attempts")).toBe(1);
      expect(fixture.orchestrator.getRunAttempt(attemptId)).toMatchObject({
        status: "FINISHED",
        recoveryDecision: "RESUME"
      });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("recovery-unsupported: in-process lease expiry fails the refused interruption, never CANCELLED", async () => {
    const fixture = openExecFixture("exec-recovery-unsupported", {
      scenario: "recovery-unsupported",
      leaseDurationMs: 60_000,
      recoveryCapabilities: { canSafelyResume: () => false, hasSafeCheckpoint: () => false }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "PLANNING" });
      const attemptId = eventsOf(fixture, run.id)[0]?.attemptId ?? "";

      fixture.scheduler.advance(61_000);
      await drainScheduler(fixture.scheduler);
      await queue;

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("RECOVERY_UNSUPPORTED");
      expect(row.status).not.toBe("CANCELLED");
      const attempt = fixture.orchestrator.getRunAttempt(attemptId);
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        recoveryDecision: "RECOVERY_UNSUPPORTED"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
      expect(eventTypes(fixture, run.id).at(-1)).toBe("Failed");
      // 3 stage trios + the terminal Failed interruption event.
      expect(eventsOf(fixture, run.id)).toHaveLength(10);
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor artifact-validation-failure scenario", () => {
  it("emits ArtifactValidationFailed then Failed with no artifact or model publication", async () => {
    const fixture = openExecFixture("exec-artifact-failure", {
      scenario: "artifact-validation-failure"
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("VALIDATION_REJECTED");
      const types = eventTypes(fixture, run.id);
      expect(types.at(-2)).toBe("ArtifactValidationFailed");
      expect(types.at(-1)).toBe("Failed");
      const validation = eventsOf(fixture, run.id).at(-2);
      expect(validation).toMatchObject({ type: "ArtifactValidationFailed", failureCode: "ARTIFACT_MISSING" });
      const failed = eventsOf(fixture, run.id).at(-1);
      expect(failed).toMatchObject({ type: "Failed", failureCode: "VALIDATION_REJECTED" });
      expect(stageSequence(fixture, run.id)).toEqual([
        "PREPARING", "ANALYZING", "PLANNING", "MODELING", "VALIDATING"
      ]);
      // No artifact and no model were ever published.
      expect(artifactCount(fixture.db)).toBe(0);
      expect(modelCount(fixture.db)).toBe(0);
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor queued cancellation", () => {
  it("cancels a QUEUED Run without any execution attempt, workspace or Model", async () => {
    const fixture = openExecFixture("exec-queued-cancel", { scenario: "success" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      expect(existsSync(join(fixture.dir, "workspaces", "runs", run.id))).toBe(false);

      const result = await fixture.executor.cancelRun(run.id, "排队取消");
      expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("CANCELLED");
      expect(row.started_at).toBeNull();
      expect(row.model_id).toBeNull();
      expect(row.stage).toBeNull();
      // No execution attempt was ever created: only the cancellation pair.
      expect(eventTypes(fixture, run.id)).toEqual([
        "CancellationRequested",
        "CancellationConfirmed"
      ]);
      const attempts = fixture.db
        .prepare("SELECT * FROM run_attempts WHERE run_id = ?")
        .all(run.id) as unknown as Array<{ status: string; interruption_kind: string | null; finished_at: string | null; attempt_sequence: number }>;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        status: "CANCELLED",
        interruption_kind: "CANCELLED",
        attempt_sequence: 1,
        finished_at: T0
      });
      expect(modelCount(fixture.db)).toBe(0);
      // No workspace was ever created for the cancelled Run.
      expect(existsSync(join(fixture.dir, "workspaces", "runs", run.id))).toBe(false);

      // Terminal repeat is stable: the second cancel returns alreadyCancelled
      // without appending anything.
      const repeat = await fixture.executor.cancelRun(run.id);
      expect(repeat).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: true });
      expect(eventsOf(fixture, run.id)).toHaveLength(2);

      // The queue remains healthy: a later Run claims and executes normally.
      const next = createQueuedRun(fixture, T1);
      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      await queue;
      expect(runRow(fixture, next.id).status).toBe("COMPLETED");
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor cancel cleanup", () => {
  it("a cleanup failure never claims a full cancellation: FAILED with CANCEL_CLEANUP_PENDING", async () => {
    const fixture = openExecFixture("exec-cleanup-failure", {
      scenario: "cooperative-cancel",
      workspace: {
        createAttemptWorkspace: () => {
          throw new Error("unreachable");
        },
        writeOwnedFile: () => {
          throw new Error("unreachable");
        },
        readOwnedFile: () => {
          throw new Error("unreachable");
        },
        deleteAttemptWorkspace: () => {
          throw new RunnerInvariantError("simulated cleanup failure");
        }
      }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // The workspace stub fails on createAttemptWorkspace too, so drive the
      // RUNNING cancel without the queue: claim manually, append a stage, then
      // cancel (the executor is not running, so no cooperative wait).
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);

      const result = await fixture.executor.cancelRun(run.id, "清理失败场景");
      expect(result).toEqual({ runId: run.id, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" });

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      expect(row.status).not.toBe("CANCELLED");
      const types = eventTypes(fixture, run.id);
      expect(types).toContain("CancellationRequested");
      expect(types).not.toContain("CancellationConfirmed");
      expect(types.at(-1)).toBe("Failed");
      // The attempt is INTERRUPTED (never CANCELLED): the cancel did not complete.
      const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("cleans only the current Run/attempt workspace and never touches other attempts", async () => {
    const fixture = openExecFixture("exec-cleanup-isolation", { scenario: "cooperative-cancel" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      const queue = fixture.executor.runQueue();
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "PLANNING" });

      // Plant a SIBLING attempt directory of the same Run: the cancel cleanup
      // must only delete the CURRENT attempt subtree (attempt-001).
      const sibling = attemptWorkspacePath(fixture, run.id, 2);
      mkdirSync(join(sibling, "working"), { recursive: true });
      writeFileSync(join(sibling, "working", "keep.txt"), "not the current attempt\n");

      const cancel = fixture.executor.cancelRun(run.id);
      await drainScheduler(fixture.scheduler);
      await cancel;

      expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      expect(existsSync(attemptWorkspacePath(fixture, run.id, 1))).toBe(false);
      // The sibling attempt subtree survives untouched.
      expect(existsSync(join(sibling, "working", "keep.txt"))).toBe(true);
      await queue;
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor foreign-owner cancel safety", () => {
  /** A second executor over the same store, owned by a FRESH orchestrator. */
  function foreignExecutor(
    fixture: ExecFixture,
    workspace: AttemptWorkspace
  ): { executor: FakeExecutor; orchestrator: RunOrchestrator } {
    const orchestrator = new RunOrchestrator(fixture.db, fixture.runs, {
      now: fixture.scheduler.now
    });
    return {
      executor: new FakeExecutor({
        orchestrator,
        runs: fixture.runs,
        workspace,
        scenario: "success",
        scheduler: fixture.scheduler,
        now: fixture.scheduler.now,
        cooperativeStopTimeoutMs: 1_000
      }),
      orchestrator
    };
  }

  function failingCleanupWorkspace(): AttemptWorkspace {
    return {
      createAttemptWorkspace: () => {
        throw new Error("unreachable");
      },
      writeOwnedFile: () => {
        throw new Error("unreachable");
      },
      readOwnedFile: () => {
        throw new Error("unreachable");
      },
      deleteAttemptWorkspace: () => {
        throw new RunnerInvariantError("simulated cleanup failure");
      }
    };
  }

  it("a cleanup failure on a foreign-owned STALE attempt re-owns safely and fails with CANCEL_CLEANUP_PENDING", async () => {
    const fixture = openExecFixture("exec-foreign-stale-cleanup", {
      scenario: "success",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // Orchestrator A claims the run (the attempt is owned by A) and its
      // lease expires while A is gone.
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      fixture.scheduler.advance(61_000);

      // Executor B (fresh owner) cancels; the workspace cleanup fails. The
      // stale foreign attempt is re-owned safely inside the transaction and
      // the Run fails with CANCEL_CLEANUP_PENDING — never a throw, never a
      // false CANCELLED.
      const foreign = foreignExecutor(fixture, failingCleanupWorkspace());
      const result = await foreign.executor.cancelRun(run.id, "外部取消");
      expect(result).toEqual({ runId: run.id, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" });

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      expect(row.status).not.toBe("CANCELLED");
      const types = eventTypes(fixture, run.id);
      expect(types).toEqual(["CancellationRequested", "Failed"]);
      const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
      // The attempt was re-owned by B inside the cleanup-failure transaction.
      const rowAttempt = attemptRow(fixture, claim?.attempt.id ?? "");
      expect(rowAttempt.owner_token).toBe(foreign.orchestrator.ownerToken);
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a live foreign lease is never stolen: cancel persists the request and returns CANCEL_PENDING", async () => {
    const fixture = openExecFixture("exec-foreign-live-lease", {
      scenario: "success",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // Orchestrator A claims the run: the attempt is owned by A with a VALID
      // lease. Give it a workspace file so the "not deleted" assertion is real.
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      const workspacePath = attemptWorkspacePath(fixture, run.id, 1);
      mkdirSync(join(workspacePath, "working"), { recursive: true });
      writeFileSync(join(workspacePath, "working", "partial.txt"), "live foreign work\n");

      // Executor B cancels while A's lease is still valid.
      const foreign = foreignExecutor(fixture, fixture.workspace);
      const result = await foreign.executor.cancelRun(run.id, "外部取消");
      expect(result).toMatchObject({
        runId: run.id,
        status: "CANCEL_PENDING",
        detail: "FOREIGN_LIVE_LEASE"
      });
      if (result.status === "CANCEL_PENDING") {
        expect(result.leaseDeadlineAt).toBe(claim?.attempt.leaseDeadlineAt);
      }

      // The cancellation stays requested; nothing was stolen or deleted.
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("RUNNING");
      expect(row.cancellation_requested_at).toBe(T0);
      expect(eventTypes(fixture, run.id)).toEqual(["CancellationRequested"]);
      const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
      expect(attempt).toMatchObject({ status: "ACTIVE" });
      expect(attempt?.ownerToken).toBe(fixture.orchestrator.ownerToken);
      expect(attempt?.interruptionKind).toBeUndefined();
      expect(existsSync(join(workspacePath, "working", "partial.txt"))).toBe(true);

      // A retried cancel stays pending and still persists only ONE request.
      const retry = await foreign.executor.cancelRun(run.id, "外部取消重试");
      expect(retry.status).toBe("CANCEL_PENDING");
      expect(
        eventTypes(fixture, run.id).filter((type) => type === "CancellationRequested")
      ).toHaveLength(1);
      expect(eventTypes(fixture, run.id)).toHaveLength(1);
      expect(modelCount(fixture.db)).toBe(0);

      // After the foreign lease expires, automatic recovery leaves the
      // cancellation-requested RUNNING Run untouched (never auto-failed, never
      // an invented cancellation): the explicit cancel retry owns the
      // aftermath.
      fixture.scheduler.advance(61_000);
      const scan = fixture.orchestrator.recoverExpiredAttempts();
      expect(scan.entries[0]?.outcome).toBe("SKIPPED");
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      expect(runRow(fixture, run.id).status).not.toBe("CANCELLED");
      expect(fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "")).toMatchObject({
        status: "ACTIVE"
      });
      // The explicit cancel retry re-owns the stale attempt and settles.
      const settle = await foreign.executor.cancelRun(run.id, "外部取消重试2");
      expect(settle).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      expect(
        eventTypes(fixture, run.id).filter((type) => type === "CancellationRequested")
      ).toHaveLength(1);
      expect(eventTypes(fixture, run.id).at(-1)).toBe("CancellationConfirmed");
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("automatic recovery leaves a CancellationRequested RUNNING Run untouched; an explicit cancel retry later re-owns and settles CANCELLED", async () => {
    const fixture = openExecFixture("exec-cancel-retry-settles", {
      scenario: "success",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // Orchestrator A claimed the run and its cancel process "crashed" after
      // persisting CancellationRequested: the attempt stays ACTIVE with an
      // expiring lease and no terminal event — exactly the interrupted-cancel
      // shape a fresh Runner reopens into.
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      fixture.scheduler.advance(1_000);
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim?.attempt.id ?? "",
        entries: [
          {
            payload: { type: "CancellationRequested", reason: "中断的取消" },
            occurredAt: fixture.scheduler.now().toISOString()
          }
        ]
      });
      const workspacePath = attemptWorkspacePath(fixture, run.id, 1);
      mkdirSync(join(workspacePath, "working"), { recursive: true });
      writeFileSync(join(workspacePath, "working", "partial.txt"), "interrupted cancel work\n");
      // The cleanup lease expires while A is gone.
      fixture.scheduler.advance(61_000);

      // Automatic recovery must NOT resume nor auto-fail the cancelled Run:
      // both sweeps leave it untouched for the explicit cancel retry (no
      // RESUME decision, no Failed event, no invented cancellation).
      const scan = fixture.orchestrator.recoverExpiredAttempts();
      expect(scan.entries.length).toBeGreaterThan(0);
      expect(scan.entries.every((entry) => entry.outcome === "SKIPPED")).toBe(true);
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      expect(fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "")).toMatchObject({
        status: "ACTIVE"
      });
      expect(eventTypes(fixture, run.id)).toEqual(["CancellationRequested"]);

      // A later explicit cancel retry re-owns the stale attempt (fresh fence
      // lease) and settles CANCELLED, deleting the workspace it owns.
      const foreign = foreignExecutor(fixture, fixture.workspace);
      const retry = await foreign.executor.cancelRun(run.id, "重试取消");
      expect(retry).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("CANCELLED");
      expect(row.cancellation_requested_at).not.toBeNull();
      expect(eventTypes(fixture, run.id)).toEqual(["CancellationRequested", "CancellationConfirmed"]);
      const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
      expect(attempt).toMatchObject({ status: "CANCELLED", interruptionKind: "CANCELLED" });
      expect(attempt?.ownerToken).toBe(foreign.orchestrator.ownerToken);
      expect(existsSync(join(workspacePath, "working", "partial.txt"))).toBe(false);
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("the idle loop does not busy-loop on a CancellationRequested RUNNING Run; the cancel retry unblocks the queue", async () => {
    const fixture = openExecFixture("exec-cancel-requested-loop", {
      scenario: "success",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const cancelled = createQueuedRun(fixture, T0);
      const next = createQueuedRun(fixture, T1);
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(cancelled.id);
      fixture.runs.appendRunEvents({
        runId: cancelled.id,
        attemptId: claim?.attempt.id ?? "",
        entries: [
          {
            payload: { type: "CancellationRequested", reason: "中断的取消" },
            occurredAt: fixture.scheduler.now().toISOString()
          }
        ]
      });
      // The cleanup lease expires while the cancel process is gone.
      fixture.scheduler.advance(61_000);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      // The idle loop reconsidered the expired attempt once, left the
      // cancelled Run untouched (never resumed, never auto-failed) and parked
      // on the bounded rescan wait — NO due task is pending, so the loop
      // cannot spin on the same past deadline (a busy loop would keep the
      // scheduler due and drainScheduler would never terminate).
      expect(runRow(fixture, cancelled.id).status).toBe("RUNNING");
      expect(runRow(fixture, next.id).status).toBe("QUEUED");
      expect(fixture.scheduler.hasPending()).toBe(false);

      // The explicit cancel retry re-owns the stale attempt and settles it.
      const foreign = foreignExecutor(fixture, fixture.workspace);
      const retry = await foreign.executor.cancelRun(cancelled.id, "重试取消");
      expect(retry).toEqual({ runId: cancelled.id, status: "CANCELLED", alreadyCancelled: false });
      expect(runRow(fixture, cancelled.id).status).toBe("CANCELLED");

      // The parked loop's bounded rescan wait fires and the queue proceeds
      // with the next Run entirely on its own.
      fixture.scheduler.advance(60_000);
      await drainScheduler(fixture.scheduler);
      await queue;
      expect(runRow(fixture, cancelled.id).status).toBe("CANCELLED");
      expect(runRow(fixture, next.id).status).toBe("COMPLETED");
      expect(
        eventTypes(fixture, cancelled.id).filter((type) => type === "CancellationRequested")
      ).toHaveLength(1);
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      await fixture.executor.stop();
      closeExecFixture(fixture);
    }
  });

  it("a CancellationRequested RUNNING wedge with no ACTIVE lease uses the bounded rescan wait instead of hot-looping", async () => {
    const fixture = openExecFixture("exec-cancel-requested-wedge-backoff", {
      scenario: "success",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const cancelled = createQueuedRun(fixture, T0);
      const next = createQueuedRun(fixture, T1);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(cancelled.id);
      fixture.runs.appendRunEvents({
        runId: cancelled.id,
        attemptId: claim?.attempt.id ?? "",
        entries: [
          {
            payload: { type: "CancellationRequested", reason: "中断的取消" },
            occurredAt: fixture.scheduler.now().toISOString()
          }
        ]
      });
      // Defensive historical/corruption shape: the cancellation-requested Run
      // remains RUNNING but its attempt was finished without a terminal event,
      // so no ACTIVE lease exists for nextActiveLeaseDeadline() to expose.
      fixture.db
        .prepare("UPDATE run_attempts SET status = 'FINISHED', finished_at = ? WHERE id = ?")
        .run(fixture.scheduler.now().toISOString(), claim?.attempt.id ?? "");

      // The queue cannot claim the next Run while the first Run still occupies
      // the RUNNING slot. Recovery SKIPs the cancellation-requested wedge and
      // boundRecoveryRescan must park for 60 s rather than immediately sweeping
      // the same wedge forever.
      void fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, cancelled.id).status).toBe("RUNNING");
      expect(runRow(fixture, next.id).status).toBe("QUEUED");
      expect(eventTypes(fixture, cancelled.id)).toEqual(["CancellationRequested"]);
      expect(fixture.scheduler.hasPending()).toBe(false);

      // One bounded retry fires, observes the same defensive wedge and re-parks;
      // no terminal event is invented and there is still no hot loop.
      fixture.scheduler.advance(60_000);
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, cancelled.id).status).toBe("RUNNING");
      expect(runRow(fixture, next.id).status).toBe("QUEUED");
      expect(eventTypes(fixture, cancelled.id)).toEqual(["CancellationRequested"]);
      expect(fixture.scheduler.hasPending()).toBe(false);
    } finally {
      await fixture.executor.stop();
      closeExecFixture(fixture);
    }
  });

  it("a persistent recovery SCAN_FAILED schedules a bounded retry wait instead of hot-looping on the expired lease", async () => {
    const fixture = openExecFixture("exec-scan-failed-backoff", {
      scenario: "success",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      // The lease expires AND the persisted stage becomes unreadable, so every
      // recovery scan fails closed on the candidate (and on the wedged slot):
      // SCAN_FAILED leaves the attempt ACTIVE with the already-expired lease.
      fixture.scheduler.advance(61_000);
      fixture.db
        .prepare("UPDATE runs SET stage = 'BOGUS' WHERE id = ?")
        .run(run.id);
      const scan = fixture.orchestrator.recoverExpiredAttempts();
      expect(scan.entries.some((entry) => entry.outcome === "SCAN_FAILED")).toBe(true);
      expect(attemptRow(fixture, claim?.attempt.id ?? "").status).toBe("ACTIVE");

      // The idle loop is started but never awaited: it parks on the bounded
      // retry wait and `stop()` in the finally settles it.
      void fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      // The idle loop reconsidered the expired attempt once, the scan failed
      // closed (SCAN_FAILED — nothing was resolved, no Failed event invented)
      // and the loop parked on the bounded retry wait: NO due task is pending,
      // so the loop cannot spin on the same past deadline (a busy loop would
      // keep the scheduler due and drainScheduler would never terminate).
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      expect(attemptRow(fixture, claim?.attempt.id ?? "").status).toBe("ACTIVE");
      expect(eventTypes(fixture, run.id)).toHaveLength(0);
      expect(fixture.scheduler.hasPending()).toBe(false);

      // The bounded retry fires, the scan fails again (still SCAN_FAILED) and
      // the loop schedules ANOTHER bounded wait — still never a busy loop and
      // still no invented terminal event.
      fixture.scheduler.advance(60_000);
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      expect(attemptRow(fixture, claim?.attempt.id ?? "").status).toBe("ACTIVE");
      expect(eventTypes(fixture, run.id)).toHaveLength(0);
      expect(fixture.scheduler.hasPending()).toBe(false);
    } finally {
      await fixture.executor.stop();
      closeExecFixture(fixture);
    }
  });

  it("a quick restart inside the lease auto-recovers at the deadline and unblocks the next Run", async () => {
    const fixture = openExecFixture("exec-quick-restart", {
      scenario: "success",
      leaseDurationMs: 60_000
    });
    let reopened: ExecFixture | null = null;
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const interrupted = createQueuedRun(fixture, T0);
      const next = createQueuedRun(fixture, T1);
      // Process 1 claims and interrupts mid-claim (a Runner close), leaving the
      // attempt ACTIVE with a still-valid lease.
      const queue1 = fixture.executor.runQueue();
      fixture.scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runRow(fixture, interrupted.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });
      const stop = fixture.executor.stop();
      await stop;
      await queue1;
      expect(runRow(fixture, interrupted.id).status).toBe("RUNNING");
      expect(runRow(fixture, next.id).status).toBe("QUEUED");

      // Process 2 reopens INSIDE the lease: the open-time scan finds nothing
      // expired, the idle loop schedules the lease-deadline wake-up, and the
      // automatic later recovery unblocks the queue.
      reopened = reopenExecFixture(fixture, T0, {
        scenario: "success",
        leaseDurationMs: 60_000
      });
      const queue2 = reopened.executor.runQueue();
      await drainScheduler(reopened.scheduler);
      expect(reopened.orchestrator.recoverExpiredAttempts().found).toBe(0);
      expect(runRow(reopened, interrupted.id).status).toBe("RUNNING");

      reopened.scheduler.advance(61_000);
      await drainScheduler(reopened.scheduler);
      await queue2;

      const failed = runRow(reopened, interrupted.id);
      expect(failed.status).toBe("FAILED");
      expect(failed.failure_code).toBe("RECOVERY_UNSUPPORTED");
      expect(failed.status).not.toBe("CANCELLED");
      // The queue unblocked: the next queued Run executed automatically.
      expect(runRow(reopened, next.id).status).toBe("COMPLETED");
      expect(modelCount(reopened.db)).toBe(0);
    } finally {
      reopened?.db.close();
      if (fixture.db.isOpen) fixture.db.close();
      removeTempDir(fixture.dir);
    }
  });
});

describe("FakeExecutor event contract enforcement", () => {
  it("rejects execution events after the attempt became terminal", () => {
    const fixture = openExecFixture("exec-event-after-terminal", { scenario: "success" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // Claim manually and emit one stage; then finish the attempt WITHOUT a
      // terminal Run event (raw finish — the wedge shape): the Run stays
      // RUNNING while the attempt is FINISHED.
      const claim = fixture.orchestrator.claimNextQueuedRun();
      const attemptId = claim?.attempt.id ?? "";
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId,
        entries: [{ payload: { type: "StageChanged", stage: "PREPARING" }, occurredAt: T0 }]
      });
      fixture.db
        .prepare("UPDATE run_attempts SET status = 'FINISHED', finished_at = ? WHERE id = ?")
        .run(T1, attemptId);
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      expect(fixture.orchestrator.getRunAttempt(attemptId)?.status).toBe("FINISHED");

      // Non-terminal execution events must reference the ACTIVE attempt.
      expect(() =>
        fixture.runs.appendRunEvents({
          runId: run.id,
          attemptId,
          entries: [{ payload: { type: "StageChanged", stage: "ANALYZING" }, occurredAt: T1 }]
        })
      ).toThrowError(/requires the ACTIVE attempt .* which is FINISHED/);
      expect(() =>
        fixture.runs.appendRunEvents({
          runId: run.id,
          attemptId,
          entries: [{ payload: { type: "ProgressUpdated", progressPercent: 10 }, occurredAt: T1 }]
        })
      ).toThrowError(/requires the ACTIVE attempt/);
      expect(eventsOf(fixture, run.id)).toHaveLength(1);
      expect(eventsOf(fixture, run.id)[0]?.type).toBe("StageChanged");
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor production default", () => {
  it("the default scenario is success and completes without declaring recovery", async () => {
    const fixture = openExecFixture("exec-default-scenario");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      await runToCompletion(fixture);
      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      expect(stageSequence(fixture, run.id)).toEqual(ALL_STAGES);
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor model publication (Phase 5, P5-2)", () => {
  it("publishes a PENDING_REVIEW Model atomically when publishModel is enabled", async () => {
    const fixture = openExecFixture("exec-publish", { scenario: "success", publishModel: true });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("COMPLETED");
      expect(row.model_id).not.toBeNull();
      expect(modelCount(fixture.db)).toBe(1);
      // Exactly one Model row: M01, PENDING_REVIEW, with the persisted
      // validation summary derived from the strictly validated manifest and
      // the truthful production-verification claim (the synthetic path always
      // persists production_verified = 0 — P5 truthfulness hardening).
      const modelRow = fixture.db.prepare("SELECT * FROM models").get() as {
        id: string;
        number: string;
        revision_id: string;
        review_status: string;
        validation_summary_json: string | null;
        build_report_summary: string | null;
        production_verified: number;
      };
      expect(modelRow.id).toBe(row.model_id);
      expect(modelRow.number).toBe("M01");
      expect(modelRow.review_status).toBe("PENDING_REVIEW");
      expect(modelRow.revision_id).toBe("revision-a1");
      expect(modelRow.build_report_summary).toBeNull();
      expect(modelRow.production_verified).toBe(0);
      const summary = JSON.parse(modelRow.validation_summary_json ?? "{}") as {
        solidWorksVersion: string;
        units: string;
        rebuildStatus: string;
      };
      expect(summary).toMatchObject({ solidWorksVersion: "2025", units: "mm", rebuildStatus: "PASSED" });
      // The Completed event carries the published Model id.
      const completed = eventsOf(fixture, run.id).at(-1);
      expect(completed).toMatchObject({ type: "Completed", modelId: row.model_id });
      // The repository query helper resolves the Model with its artifacts.
      const model = fixture.runs.getModel(row.model_id ?? "");
      expect(model).toMatchObject({ number: "M01", reviewStatus: "PENDING_REVIEW", productionVerified: false });
      expect(model?.artifactIds).toHaveLength(6);
      expect(artifactCount(fixture.db)).toBe(6);
      const artifactRows = fixture.db
        .prepare("SELECT kind, run_id, model_id FROM artifacts")
        .all() as unknown as Array<{ kind: string; run_id: string; model_id: string }>;
      expect(artifactRows.map((artifact) => artifact.kind).sort()).toEqual([
        "BUILDER_SOURCE",
        "BUILD_VALIDATION_LOG",
        "DIMENSION_LEDGER",
        "FEATURE_PLAN",
        "PREVIEW",
        "SLDPRT"
      ]);
      for (const artifact of artifactRows) {
        expect(artifact.run_id).toBe(run.id);
        expect(artifact.model_id).toBe(row.model_id);
      }
      // The attempt finished FINISHED without an interruption kind.
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "FINISHED" });
      expect(attempt?.interruptionKind).toBeUndefined();
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("publishes the PROCESS_MP4 artifact only when recording was requested", async () => {
    const fixture = openExecFixture("exec-publish-mp4", {
      scenario: "success",
      publishModel: true,
      recordMp4: true
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      createQueuedRun(fixture, T0);
      await runToCompletion(fixture);

      expect(artifactCount(fixture.db)).toBe(7);
      const kinds = fixture.db
        .prepare("SELECT kind FROM artifacts")
        .all() as unknown as Array<{ kind: string }>;
      expect(kinds.map((row) => row.kind)).toContain("PROCESS_MP4");
      expect(modelCount(fixture.db)).toBe(1);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("publishes nothing when the independent validation rejects, even with publishModel enabled", async () => {
    const fixture = openExecFixture("exec-publish-reject", {
      scenario: "artifact-validation-failure",
      publishModel: true
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      await runToCompletion(fixture);

      // The Agent claimed completion with a defective workspace: the Run is
      // failed with the accurate code and NO Model is ever published.
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("VALIDATION_REJECTED");
      expect(row.model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      expect(artifactCount(fixture.db)).toBe(0);
      expect(eventsOf(fixture, run.id).at(-1)).toMatchObject({ type: "Failed" });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("rejects an aliased-manifest as ARTIFACT_MANIFEST_INVALID and never wedges the queue (P5-2 review fix)", async () => {
    const fixture = openExecFixture("exec-publish-duplicate-path", {
      scenario: "success",
      publishModel: true,
      agent: new DuplicatePathAgentAdapter()
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      const second = createQueuedRun(fixture, T1);

      await runToCompletion(fixture);

      // First Run: terminated IMMEDIATELY — ArtifactValidationFailed with the
      // accurate code, then the terminal Failed; nothing was published for it.
      const row = runRow(fixture, first.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("ARTIFACT_MANIFEST_INVALID");
      expect(row.model_id).toBeNull();
      expect(
        scalar(fixture.db, "SELECT COUNT(*) AS count FROM models WHERE run_id = ?", first.id)
      ).toBe(0);
      expect(
        scalar(fixture.db, "SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ?", first.id)
      ).toBe(0);
      const types = eventTypes(fixture, first.id);
      expect(types).toContain("ArtifactValidationFailed");
      expect(types.at(-1)).toBe("Failed");
      const validationEvent = eventsOf(fixture, first.id).find(
        (event) => event.type === "ArtifactValidationFailed"
      );
      expect(validationEvent).toMatchObject({ failureCode: "ARTIFACT_MANIFEST_INVALID" });
      // The serial queue was NOT wedged: the second Run completes through the
      // same loop and publishes its own Model.
      expect(runRow(fixture, second.id).status).toBe("COMPLETED");
      expect(runRow(fixture, second.id).model_id).not.toBeNull();
      expect(modelCount(fixture.db)).toBe(1);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("rejects a productionVerified true claim, publishes no Model and never wedges the queue (M3 fail closed)", async () => {
    const fixture = openExecFixture("exec-publish-production-verified-claim", {
      scenario: "success",
      publishModel: true,
      agent: new ProductionVerifiedClaimAgentAdapter()
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      const second = createQueuedRun(fixture, T1);

      await runToCompletion(fixture);

      // First Run: the Agent manifest's productionVerified: true claim is
      // NEVER authoritative (no independent production/HIL verification
      // record) — the Run is failed closed with the stable manifest code and
      // NO Model is published from the unsupported claim.
      const row = runRow(fixture, first.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("ARTIFACT_MANIFEST_INVALID");
      expect(row.model_id).toBeNull();
      expect(
        scalar(fixture.db, "SELECT COUNT(*) AS count FROM models WHERE run_id = ?", first.id)
      ).toBe(0);
      expect(
        scalar(fixture.db, "SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ?", first.id)
      ).toBe(0);
      const types = eventTypes(fixture, first.id);
      expect(types).toContain("ArtifactValidationFailed");
      expect(types.at(-1)).toBe("Failed");
      const validationEvent = eventsOf(fixture, first.id).find(
        (event) => event.type === "ArtifactValidationFailed"
      );
      expect(validationEvent).toMatchObject({ failureCode: "ARTIFACT_MANIFEST_INVALID" });
      // The unsupported true claim published nothing for the first Run, and
      // no stored Model row anywhere carries production_verified = 1.
      expect(
        scalar(fixture.db, "SELECT COUNT(*) AS count FROM models WHERE run_id = ?", first.id)
      ).toBe(0);
      expect(
        scalar(fixture.db, "SELECT COUNT(*) AS count FROM models WHERE production_verified = 1")
      ).toBe(0);
      // The serial queue was NOT wedged: the second Run's truthful false-claim
      // manifest completes and publishes its own unverified Model.
      expect(runRow(fixture, second.id).status).toBe("COMPLETED");
      expect(runRow(fixture, second.id).model_id).not.toBeNull();
      expect(modelCount(fixture.db)).toBe(1);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("the legacy default (publishModel unset) keeps the Phase 3/4 model-less completion", async () => {
    const fixture = openExecFixture("exec-publish-off", { scenario: "success" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      await runToCompletion(fixture);
      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      expect(runRow(fixture, run.id).model_id).toBeNull();
      expect(modelCount(fixture.db)).toBe(0);
      expect(artifactCount(fixture.db)).toBe(0);
      expect(eventsOf(fixture, run.id).at(-1)).toMatchObject({ type: "Completed" });
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("Runner Fake Executor facade (Phase 3, P3-3)", () => {
  /**
   * Seeds a real Drawing + Revision + immutable ledger source file and a QUEUED
   * Run over them. Phase 4 (P4-1) input preparation runs at PREPARING on every
   * claim, so the facade flows must reference a REAL resolvable source file
   * (the injected Runner resolver verifies the ledger copy against the
   * recorded size/hash — an unresolvable source would fail the Run closed).
   */
  function seedQueuedRunnerRun(
    db: SqliteDatabase,
    dir: string,
    id: string,
    number: string,
    createdAt: string,
    skill: { name: string; sha256: string } = PROFILE.skill
  ): void {
    const store = new SqliteRepository(db);
    const drawingId = `drawing-${id}`;
    const revisionId = `revision-${id}`;
    const relativePath = `library/drawings/file-${id}/source/original.pdf`;
    const sourceBytes = samplePdfBytes();
    const sourceDir = join(dir, "library", "drawings", `file-${id}`, "source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "original.pdf"), sourceBytes);
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
          skill,
          agentConfigId: PROFILE.agentConfigId,
          createdAt
        })
      );
    });
  }

  it("runQueue drives the serial success scenario through the Runner and publishes a Model", async () => {
    const dir = makeTempDir("exec-runner-success");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "success",
      scheduler
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-1", "R01", T0);
      seedQueuedRunnerRun(seedDb, dir, "run-facade-2", "R02", T1);
      seedDb.close();
      seedDb = null;

      runner.open();
      const queue = runner.runQueue();
      await drainScheduler(scheduler);
      await queue;

      // The Runner product default (P5-2) publishes a PENDING_REVIEW Model for
      // every completed Run.
      expect(runner.getRunDetail("run-facade-1").run.status).toBe("COMPLETED");
      expect(runner.getRunDetail("run-facade-2").run.status).toBe("COMPLETED");
      expect(runner.getRunDetail("run-facade-1").run.modelId).not.toBeNull();
      expect(runner.getRunDetail("run-facade-2").run.modelId).not.toBeNull();
      expect(runner.getRunDetail("run-facade-1").run.stage).toBeNull();
      expect(runner.getRunDetail("run-facade-2").run.stage).toBeNull();
      const readDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db") });
      readDb.open();
      try {
        expect(modelCount(readDb)).toBe(2);
      } finally {
        readDb.close();
      }
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("forwards the attested expected SolidWorks version: an exact match completes the Run and the attempt prompt carries the authoritative version", async () => {
    const dir = makeTempDir("exec-runner-version-match");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "success",
      scheduler,
      // The deterministic Fake Agent records exactly this version; the Runner
      // must forward it into the DEFAULT artifact validator (exact match) and
      // into the controlled prompt (turn visibility).
      expectedSolidWorksVersion: "2025"
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-version-match", "R01", T0);
      seedDb.close();
      seedDb = null;

      runner.open();
      const queue = runner.runQueue();
      await drainScheduler(scheduler);
      await queue;

      expect(runner.getRunDetail("run-facade-version-match").run.status).toBe("COMPLETED");
      // The same authoritative value reached the Agent's turn input: the
      // rendered prompt (read back as `promptText`) carries the version line.
      const prompt = readFileSync(
        join(dir, "workspaces", "runs", "run-facade-version-match", "attempt-001", "runtime", "prompt.md"),
        "utf8"
      );
      expect(prompt).toContain("- expected SolidWorks version: 2025");
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("forwards the attested expected SolidWorks version: a mismatch fails the Run closed with ARTIFACT_MANIFEST_INVALID", async () => {
    const dir = makeTempDir("exec-runner-version-mismatch");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "success",
      scheduler,
      // The deterministic Fake Agent records "2025"; the attested expectation
      // is "2024" — the DEFAULT validator must fail the manifest closed
      // (ARTIFACT_MANIFEST_INVALID, before artifact reads) and no Model may be
      // published.
      expectedSolidWorksVersion: "2024"
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-version-mismatch", "R01", T0);
      seedDb.close();
      seedDb = null;

      runner.open();
      const queue = runner.runQueue();
      await drainScheduler(scheduler);
      await queue;

      const detail = runner.getRunDetail("run-facade-version-mismatch");
      expect(detail.run.status).toBe("FAILED");
      expect(detail.run.failureCode).toBe("ARTIFACT_MANIFEST_INVALID");
      expect(detail.run.modelId).toBeNull();
      const types = detail.events.map((event) => event.type);
      expect(types).toContain("ArtifactValidationFailed");
      expect(types).toContain("Failed");
      expect(types).not.toContain("Completed");
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("runQueue completes model-less when publishModel is explicitly false (Phase 3/4 compatibility)", async () => {
    const dir = makeTempDir("exec-runner-publish-off");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "success",
      scheduler,
      publishModel: false
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-publish-off", "R01", T0);
      seedDb.close();
      seedDb = null;

      runner.open();
      const queue = runner.runQueue();
      await drainScheduler(scheduler);
      await queue;

      // The explicit opt-out restores the Phase 3/4 model-less completion: the
      // Run completes but no Model row and no Completed modelId exist.
      const detail = runner.getRunDetail("run-publish-off");
      expect(detail.run.status).toBe("COMPLETED");
      expect(detail.run.modelId).toBeNull();
      const readDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db") });
      readDb.open();
      try {
        expect(modelCount(readDb)).toBe(0);
        expect(artifactCount(readDb)).toBe(0);
      } finally {
        readDb.close();
      }
      expect(detail.events.at(-1)).toMatchObject({ type: "Completed" });
      expect((detail.events.at(-1) as { modelId?: string }).modelId).toBeUndefined();
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("an injected custom skill profile fails closed at PREPARING with SKILL_HASH_MISMATCH", async () => {
    const dir = makeTempDir("exec-runner-custom-profile");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "success",
      scheduler
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      // The frozen snapshot carries a well-formed but NON-fixture digest (an
      // injected custom profile): the synthetic preflight gate allowlists
      // EXACTLY the fixture digest (P5-2 review fix), so the Run must fail
      // closed at PREPARING instead of silently passing the gate.
      seedQueuedRunnerRun(
        seedDb,
        dir,
        "run-custom-profile",
        "R01",
        T0,
        { name: "solidworks-build-part-from-drawing", sha256: "b".repeat(64) }
      );
      seedDb.close();
      seedDb = null;

      runner.open();
      const queue = runner.runQueue();
      await drainScheduler(scheduler);
      await queue;

      const detail = runner.getRunDetail("run-custom-profile");
      expect(detail.run.status).toBe("FAILED");
      expect(detail.run.failureCode).toBe("SKILL_HASH_MISMATCH");
      expect(detail.run.stage).toBeNull();
      expect(detail.run.modelId).toBeNull();
      expect(detail.events.map((event) => event.type)).toEqual(["Failed"]);
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("cancelRun cancels a reopened auto-claimed Run through the facade with stable terminal repeats", async () => {
    const dir = makeTempDir("exec-runner-queued-cancel");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, { runProfile: PROFILE, scheduler });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-cancel", "R01", T0);
      seedDb.close();
      seedDb = null;

      // F2: the loop the Runner starts at open claims the seeded QUEUED Run
      // immediately (the claim and its opening stage trio are synchronous;
      // the walk then parks on the manual scheduler), so the cooperative
      // RUNNING-cancel path applies deterministically.
      runner.open();
      expect(runner.getRunDetail("run-facade-cancel").run.status).toBe("RUNNING");
      const pending = runner.cancelRun("run-facade-cancel", "用户取消");
      // Flush the parked walk's due step: the cooperative stop signal ends the
      // claim, then the cancel cleans the workspace and confirms atomically.
      await drainScheduler(scheduler);
      const result = await pending;
      expect(result).toEqual({ runId: "run-facade-cancel", status: "CANCELLED", alreadyCancelled: false });
      const detail = runner.getRunDetail("run-facade-cancel");
      expect(detail.run.status).toBe("CANCELLED");
      expect(detail.events.at(-1)?.type).toBe("CancellationConfirmed");
      // Exactly ONE CancellationRequested + Confirmation pair, appended after
      // the walk's opening stage trio — a retried cancel never duplicates.
      expect(detail.events.filter((event) => event.type === "CancellationRequested")).toHaveLength(1);
      expect(detail.events.filter((event) => event.type === "CancellationConfirmed")).toHaveLength(1);
      const repeat = await runner.cancelRun("run-facade-cancel");
      expect(repeat).toEqual({ runId: "run-facade-cancel", status: "CANCELLED", alreadyCancelled: true });
      expect(runner.getRunDetail("run-facade-cancel").events).toHaveLength(detail.events.length);
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("wires the ownership surface factory with the REAL Runner-bound workspace seams (P5-4/B2)", async () => {
    const dir = makeTempDir("exec-runner-ownership-factory");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const closed: SolidWorksIdentity[] = [];
    let factoryCalls = 0;
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "crash", // walks to MODELING and stops without a terminal event
      scheduler,
      buildOwnershipSurface: (context) => {
        factoryCalls++;
        expect(typeof context.stageOf).toBe("function");
        expect(typeof context.attemptSequenceOf).toBe("function");
        expect(typeof context.attemptRootOf).toBe("function");
        expect(typeof context.readAttemptFile).toBe("function");
        return new WorkspaceSolidWorksOwnershipSurface({
          workspace: context,
          closer: {
            close: (identity) => {
              closed.push(identity);
            }
          }
        });
      }
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      expect(factoryCalls).toBe(1); // exactly once per open (first open)
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-ownership", "R01", T0);
      seedDb.close();
      seedDb = null;

      // The factory is called EXACTLY once per open, with the real seams bound.
      runner.open();
      expect(factoryCalls).toBe(2);
      // The crash scenario walks to MODELING and stops: the persisted stage is
      // MODELING and the attempt workspace exists on disk.
      await drainScheduler(scheduler);
      expect(runner.getRunDetail("run-facade-ownership").run.stage).toBe("MODELING");
      expect(runner.getRunDetail("run-facade-ownership").run.status).toBe("RUNNING");

      // The Agent's registry: attempt-scoped runtime file with the REAL saved
      // workspace-relative document path (Unicode, case-insensitive ext).
      const runtimeDir = join(
        dir,
        "workspaces",
        "runs",
        "run-facade-ownership",
        "attempt-001",
        "runtime"
      );
      mkdirSync(runtimeDir, { recursive: true });
      const attemptId =
        runner.getRunDetail("run-facade-ownership").events.at(-1)?.attemptId ?? "";
      writeFileSync(
        join(runtimeDir, "solidworks-ownership.json"),
        JSON.stringify({
          schemaVersion: SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION,
          runId: "run-facade-ownership",
          attemptId,
          attemptSequence: 1,
          updatedAt: "2026-08-16T09:00:00.000Z",
          documents: ["working/底板-法兰.sldprt"]
        }),
        "utf8"
      );

      const result = await runner.cancelRun("run-facade-ownership");
      expect(result).toEqual({
        runId: "run-facade-ownership",
        status: "CANCELLED",
        alreadyCancelled: false
      });
      // The Runner-bound surface read the REAL persisted stage + registry and
      // the guard closed the attested document identity.
      expect(closed).toHaveLength(1);
      expect(closed[0]).toEqual({
        kind: "document",
        documentIdentity: join(
          dir,
          "workspaces",
          "runs",
          "run-facade-ownership",
          "attempt-001",
          "working",
          "底板-法兰.sldprt"
        )
      });
      const detail = runner.getRunDetail("run-facade-ownership");
      expect(detail.run.status).toBe("CANCELLED");
      expect(detail.events.at(-1)?.type).toBe("CancellationConfirmed");
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("reopen auto-starts the queue and drains a QUEUED Run without a manual runQueue() (F2)", async () => {
    const dir = makeTempDir("exec-runner-reopen-queued");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, { runProfile: PROFILE, scheduler });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-reopen-queued", "R01", T0);
      seedDb.close();
      seedDb = null;

      // F2: reopen with QUEUED work — the loop the Runner starts at open
      // claims the Run immediately (no manual runQueue() call needed)...
      runner.open();
      expect(runner.getRunDetail("run-reopen-queued").run.status).toBe("RUNNING");
      // ...and drains it once the deterministic scheduler flushes, publishing
      // a PENDING_REVIEW Model through the Runner product default (P5-2).
      await drainScheduler(scheduler);
      const detail = runner.getRunDetail("run-reopen-queued");
      expect(detail.run.status).toBe("COMPLETED");
      expect(detail.run.modelId).not.toBeNull();
      expect(detail.events.at(-1)?.type).toBe("Completed");
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("the clarification scenario persists a queryable request through the facade", async () => {
    const dir = makeTempDir("exec-runner-clarify");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "clarification",
      scheduler
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-clarify", "R01", T0);
      seedDb.close();
      seedDb = null;

      runner.open();
      const queue = runner.runQueue();
      await drainScheduler(scheduler);
      await queue;

      const detail = runner.getRunDetail("run-facade-clarify");
      expect(detail.run.status).toBe("CLARIFICATION_REQUIRED");
      const requestId = detail.run.clarificationRequestId;
      expect(requestId).not.toBeNull();
      const request = runner.getClarificationRequest(requestId ?? "");
      expect(request).toMatchObject({ status: "OPEN", answers: [], questions: [{ type: "dimension" }, { type: "choice" }] });
      expect(detail.run.modelId).toBeNull();
    } finally {
      runner.close();
      seedDb?.close();
      removeTempDir(dir);
    }
  });

  it("a quick restart inside the lease auto-recovers through the Runner's scenario-based capability", async () => {
    const dir = makeTempDir("exec-runner-recovery");
    const scheduler1 = new ManualExecutorScheduler(Date.parse(T0));
    const runner1 = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "recovery-supported",
      leaseDurationMs: 60_000,
      scheduler: scheduler1
    });
    let seedDb: SqliteDatabase | null = null;
    let runner2: Runner | null = null;
    try {
      runner1.open();
      runner1.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-recovery", "R01", T0);
      seedDb.close();
      seedDb = null;

      // Process 1: the executor walks PREPARING + ANALYZING and stops without
      // a terminal event (interrupted work the scenario declares resumable);
      // the queue loop goes idle with a still-valid lease.
      runner1.open();
      const queue1 = runner1.runQueue();
      void queue1;
      await drainScheduler(scheduler1);
      expect(runner1.getRunDetail("run-facade-recovery").run).toMatchObject({
        status: "RUNNING",
        stage: "ANALYZING"
      });
      runner1.close();

      // Process 2 reopens INSIDE the lease: the open-time scan finds nothing
      // expired, and the idle loop's lease-deadline wake-up automatically
      // RESUMES the attempt through the scenario-based default capability
      // (only recovery-supported proves safe resumption) and completes it.
      const scheduler2 = new ManualExecutorScheduler(Date.parse(T0));
      runner2 = new Runner(dir, {
        runProfile: PROFILE,
        fakeExecutorScenario: "recovery-supported",
        leaseDurationMs: 60_000,
        scheduler: scheduler2
      });
      runner2.open();
      expect(runner2.recoveryScanResult?.found).toBe(0);

      const queue2 = runner2.runQueue();
      await drainScheduler(scheduler2);
      expect(runner2.getRunDetail("run-facade-recovery").run.status).toBe("RUNNING");

      scheduler2.advance(61_000);
      await drainScheduler(scheduler2);
      await queue2;
      const detail = runner2.getRunDetail("run-facade-recovery");
      expect(detail.run.status).toBe("COMPLETED");
      // The resumed Run completes through the P5-2 success path and publishes.
      expect(detail.run.modelId).not.toBeNull();
      expect(detail.events.at(-1)?.type).toBe("Completed");
    } finally {
      runner2?.close();
      seedDb?.close();
      if (runner1.isOpen) runner1.close();
      removeTempDir(dir);
    }
  });

  it("close() settles an in-flight queue loop and the interruption is never a cancellation", async () => {
    const dir = makeTempDir("exec-runner-close");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const runner = new Runner(dir, { runProfile: PROFILE, scheduler });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-close", "R01", T0);
      seedDb.close();
      seedDb = null;

      runner.open();
      const queue = runner.runQueue();
      // One step only: the claim is mid-flight (ANALYZING emitted), awaiting
      // its next tick when close() arrives.
      scheduler.flushOne();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runner.getRunDetail("run-facade-close").run.status).toBe("RUNNING");

      // close() stops the executor: the queue-loop promise settles and the
      // in-flight attempt is left ACTIVE (an unexpected interruption), never
      // a cancellation.
      runner.close();
      await queue;
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      const row = seedDb
        .prepare("SELECT status, stage FROM runs WHERE id = ?")
        .get("run-facade-close") as { status: string; stage: string | null };
      const events = seedDb
        .prepare("SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY sequence ASC")
        .all("run-facade-close") as unknown as Array<{ payload_json: string }>;
      seedDb.close();
      seedDb = null;
      expect(row.status).toBe("RUNNING");
      expect(row.status).not.toBe("CANCELLED");
      expect(row.stage).toBe("ANALYZING");
      expect(
        events.some((event) => (JSON.parse(event.payload_json) as { type: string }).type === "CancellationRequested")
      ).toBe(false);
    } finally {
      seedDb?.close();
      if (runner.isOpen) runner.close();
      removeTempDir(dir);
    }
  });

  it("a configured Codex adapter wires the pinned thread-session recovery: the resumed attempt resumes the persisted thread (P5-4)", async () => {
    const dir = makeTempDir("exec-runner-session-resume");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const server = new ScriptedExecutorServer();
    const client = new CodexAppServerClient({
      transport: server.transport,
      requestTimeoutMs: 1_000
    });
    const adapter = new CodexAppServerAdapter({ client, turnTimeoutMs: 5_000 });
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "recovery-supported",
      leaseDurationMs: 60_000,
      scheduler,
      agent: adapter,
      skillResolvedPath: "C:\\skills\\solidworks-build-part-from-drawing"
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-session-resume", "R01", T0);
      seedDb.close();
      seedDb = null;

      // The executor walks PREPARING + ANALYZING and stops without a terminal
      // event; the queue goes idle with a still-valid lease.
      runner.open();
      const queue = runner.runQueue();
      await drainScheduler(scheduler);
      expect(runner.getRunDetail("run-facade-session-resume").run).toMatchObject({
        status: "RUNNING",
        stage: "ANALYZING"
      });

      // The prior interrupted adapter run left a PINNED session behind in the
      // attempt workspace (the layout the ledger reads on resume).
      const attemptRoot = join(dir, "workspaces", "runs", "run-facade-session-resume", "attempt-001");
      const sessionDir = join(attemptRoot, "runtime");
      const priorThreadId = "thread-prior-7";
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "agent-session.json"),
        JSON.stringify(
          buildAgentSessionRecord({
            threadId: priorThreadId,
            status: "interrupted",
            adapterId: "codex-app-server",
            adapterVersion: "0.147.0",
            protocol: PINNED_THREAD_SESSION_PROTOCOL,
            protocolVersion: PINNED_THREAD_SESSION_PROTOCOL_VERSION,
            nowIso: () => T0
          }),
          null,
          2
        ) + "\n",
        "utf8"
      );

      // Lease expiry: the RUNNER's session-backed recovery capability (wired
      // because the Codex adapter is configured) proves the resume through the
      // persisted pinned session, and the resumed claim RESUMES the same
      // thread through the adapter.
      scheduler.advance(61_000);
      await drainScheduler(scheduler);
      expect(server.requestMethods()).toEqual(["initialize", "thread/resume", "turn/start"]);
      expect(server.lastRequestParams("thread/resume")).toMatchObject({ threadId: priorThreadId });

      // Truthful artifact bytes for the manifest the turn will produce, then
      // complete the turn.
      const set = produceSyntheticResultArtifactSet({
        runId: "run-facade-session-resume",
        attemptSequence: 1,
        recordMp4: false,
        solidWorksVersion: "2025",
        adapterId: "codex-app-server",
        adapterVersion: "0.147.0"
      });
      for (const file of set.files) {
        if (file.relativePath === set.manifestRef) continue;
        const target = join(attemptRoot, ...file.relativePath.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
      server.emitAgentMessageDelta(completedTurnOutputJson(set.manifest));
      server.emitTurnCompleted("completed");
      await queue;

      const detail = runner.getRunDetail("run-facade-session-resume");
      expect(detail.run.status).toBe("COMPLETED");
      // The Runner product default publishes the Model through the atomic path.
      expect(detail.run.modelId).not.toBeNull();
      // Metadata resume marker: the persisted session AND the raw log record
      // the resumed-from thread of the prior session.
      const session = validateAgentSessionRecord(
        JSON.parse(readFileSync(join(sessionDir, "agent-session.json"), "utf8"))
      );
      expect(session?.threadId).toBe(priorThreadId);
      expect(session?.resumedFromThreadId).toBe(priorThreadId);
      const rawLog = readFileSync(join(attemptRoot, "logs", "agent-raw.log"), "utf8");
      const records = rawLog
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const metadata = records.find((record) => record.type === "metadata_updated");
      expect(metadata?.resumedFromThreadId).toBe(priorThreadId);
    } finally {
      seedDb?.close();
      if (runner.isOpen) runner.close();
      removeTempDir(dir);
    }
  });

  it("a configured Codex adapter refuses recovery without a persisted pinned session (RECOVERY_UNSUPPORTED, no thread/resume)", async () => {
    const dir = makeTempDir("exec-runner-session-refusal");
    const scheduler = new ManualExecutorScheduler(Date.parse(T0));
    const server = new ScriptedExecutorServer();
    const client = new CodexAppServerClient({
      transport: server.transport,
      requestTimeoutMs: 1_000
    });
    const adapter = new CodexAppServerAdapter({ client, turnTimeoutMs: 5_000 });
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      fakeExecutorScenario: "recovery-supported",
      leaseDurationMs: 60_000,
      scheduler,
      agent: adapter,
      skillResolvedPath: "C:\\skills\\solidworks-build-part-from-drawing"
    });
    let seedDb: SqliteDatabase | null = null;
    try {
      runner.open();
      runner.close();
      seedDb = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      seedDb.open();
      seedQueuedRunnerRun(seedDb, dir, "run-facade-session-refusal", "R01", T0);
      seedDb.close();
      seedDb = null;

      runner.open();
      const queue = runner.runQueue();
      await drainScheduler(scheduler);
      expect(runner.getRunDetail("run-facade-session-refusal").run).toMatchObject({
        status: "RUNNING",
        stage: "ANALYZING"
      });
      // NO session was ever persisted: the strict ledger read finds nothing,
      // so the session-backed capability refuses the resume truthfully.
      scheduler.advance(61_000);
      await drainScheduler(scheduler);
      await queue;

      const detail = runner.getRunDetail("run-facade-session-refusal");
      expect(detail.run.status).toBe("FAILED");
      expect(detail.run.failureCode).toBe("RECOVERY_UNSUPPORTED");
      expect(detail.run.status).not.toBe("CANCELLED");
      expect(detail.events.at(-1)).toMatchObject({
        type: "Failed",
        failureCode: "RECOVERY_UNSUPPORTED"
      });
      const attempt = runner.getRunAttempt(detail.events[0]?.attemptId ?? "");
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        recoveryDecision: "RECOVERY_UNSUPPORTED"
      });
      // The Codex adapter was NEVER invoked: no thread/resume request exists.
      expect(server.requestMethods()).toEqual([]);
    } finally {
      seedDb?.close();
      if (runner.isOpen) runner.close();
      removeTempDir(dir);
    }
  });
});

describe("FakeExecutor Phase 4 result phase (P4-3 + P4-5)", () => {
  it("gates completion on the independent validator and re-validates the workspace set", async () => {
    const fixture = openExecFixture("exec-p4-success-gate", { scenario: "success" });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      await runToCompletion(fixture);

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      // The produced set independently validates against the real workspace.
      const attemptSequence = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      )?.attemptSequence ?? 1;
      const validator = new ArtifactValidator(fixture.workspace, { now: () => new Date(T0) });
      const outcome = validator.validate({
        runId: run.id,
        attemptSequence,
        manifestRef: "output/result-manifest.json",
        recordMp4Required: false
      });
      expect(outcome.ok).toBe(true);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("recordMp4 makes processMp4 a required, validated artifact", async () => {
    const fixture = openExecFixture("exec-p4-mp4", { scenario: "success", recordMp4: true });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      await runToCompletion(fixture);

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      const attemptSequence = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      )?.attemptSequence ?? 1;
      expect(
        existsSync(
          join(
            attemptWorkspacePath(fixture, run.id, attemptSequence),
            "output",
            "process.mp4"
          )
        )
      ).toBe(true);
      const validator = new ArtifactValidator(fixture.workspace, { now: () => new Date(T0) });
      const outcome = validator.validate({
        runId: run.id,
        attemptSequence,
        manifestRef: "output/result-manifest.json",
        recordMp4Required: true
      });
      expect(outcome.ok).toBe(true);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("an incompatible raw stream fails with AGENT_PROTOCOL_INCOMPATIBLE and never claims a manifest", async () => {
    const brokenAgent: RawAgentAdapter = {
      adapterId: "broken-adapter",
      adapterVersion: "1",
      protocol: "broken",
      protocolVersion: "1",
      threadIdFor: (runId) => `thread-${runId}`,
      produceResult: (input: AgentResultInput): readonly RawAgentRecord[] => {
        void input;
        // The raw runtime emitted an UNKNOWN record type (type-level lie, as a
        // real runtime stream could).
        return [
          {
            recordVersion: RAW_AGENT_RECORDS_VERSION,
            type: "surprise_event",
            occurredAt: T0,
            threadId: "thread-broken"
          }
        ] as unknown as readonly RawAgentRecord[];
      }
    };
    const fixture = openExecFixture("exec-p4-protocol", {
      scenario: "success",
      agent: brokenAgent
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("AGENT_PROTOCOL_INCOMPATIBLE");
      const types = eventTypes(fixture, run.id);
      // The raw reasoning never surfaced: no manifest claim, no product event
      // derived from the broken record, and the failure message stays generic.
      expect(types).toEqual([
        ...(() => {
          const trio: string[] = [];
          for (let index = 0; index < ALL_STAGES.length; index++) {
            trio.push("StageChanged", "ActivityUpdated", "ProgressUpdated");
          }
          return trio;
        })(),
        "Failed"
      ]);
      const failed = eventsOf(fixture, run.id).at(-1);
      expect(failed).toMatchObject({
        type: "Failed",
        failureCode: "AGENT_PROTOCOL_INCOMPATIBLE",
        failureMessage: "Agent 运行时输出与产品事件合同不兼容，Run 已失败"
      });
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "INTERRUPTED" });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a validator rejection appends ArtifactValidationFailed with the accurate code and fails with it", async () => {
    // The adapter submits a manifest whose artifact path escapes the workspace;
    // the independent validator must reject with ARTIFACT_OUTSIDE_WORKSPACE and
    // the Run terminates with the SAME accurate code (not a generic failure).
    class EscapingAdapter extends FakeAgentAdapter {
      produceResult(input: AgentResultInput): readonly RawAgentRecord[] {
        return super.produceResult({
          ...input,
          resultDefect: { kind: "path-escape" }
        });
      }
    }
    const fixture = openExecFixture("exec-p4-path-escape", {
      scenario: "success",
      agent: new EscapingAdapter()
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("ARTIFACT_OUTSIDE_WORKSPACE");
      const types = eventTypes(fixture, run.id);
      expect(types.at(-2)).toBe("ArtifactValidationFailed");
      expect(types.at(-1)).toBe("Failed");
      expect(eventsOf(fixture, run.id).at(-2)).toMatchObject({
        type: "ArtifactValidationFailed",
        failureCode: "ARTIFACT_OUTSIDE_WORKSPACE"
      });
      expect(eventsOf(fixture, run.id).at(-1)).toMatchObject({
        type: "Failed",
        failureCode: "ARTIFACT_OUTSIDE_WORKSPACE"
      });
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor per-claim error boundary (M2)", () => {
  it("a thrown Input Adapter error fails the Run closed with INPUT_ADAPTER_FAILED and the queue continues to the next Run", async () => {
    const fixture = openExecFixture("exec-m2-adapter-throw", {
      scenario: "success",
      inputAdapter: new ThrowingOnceInputAdapter(),
      resolveInputSource: () => ({
        source: { fileName: "drawing-a.pdf", format: "PDF", sizeBytes: 1024, sha256: "a".repeat(64) },
        absolutePath: "/unused/fake-source.pdf"
      })
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      const second = createQueuedRun(fixture, T1);

      // Before the fix the thrown adapter error propagated out of the claim,
      // rejected the queue-loop promise and killed the serial queue.
      //
      // NOTE: this flow cannot use the shared `drainScheduler` helper: the
      // preparation failure settles the first claim synchronously inside the
      // queue's microtask chain, so the first stage tick of the SECOND Run is
      // scheduled only after the initial microtask drain — the helper's
      // `while (hasPending)` check would miss it and `await queue` would hang.
      const queue = fixture.executor.runQueue();
      let guard = 0;
      while (guard++ < 10_000) {
        fixture.scheduler.flushAll();
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!fixture.scheduler.hasPending()) break;
      }
      await queue;

      // The thrown adaptation error is an accurate structured terminal
      // failure of the claim: FAILED with INPUT_ADAPTER_FAILED, exactly one
      // terminal event, no stage was ever walked, and the attempt is
      // INTERRUPTED (never CANCELLED).
      const firstRow = runRow(fixture, first.id);
      expect(firstRow.status).toBe("FAILED");
      expect(firstRow.failure_code).toBe("INPUT_ADAPTER_FAILED");
      expect(firstRow.failure_message).toContain("injected adapter throw");
      expect(eventTypes(fixture, first.id)).toEqual(["Failed"]);
      const firstAttempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, first.id)[0]?.attemptId ?? ""
      );
      expect(firstAttempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      expect(firstAttempt?.status).not.toBe("CANCELLED");
      // The serial queue was NOT killed: the later Run claimed and completed
      // through the same loop with the deterministic adapter.
      expect(runRow(fixture, second.id).status).toBe("COMPLETED");
      expect(stageSequence(fixture, second.id)).toEqual(ALL_STAGES);
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a thrown workspace write leaves the claim for recovery and the queue still continues to the next Run", async () => {
    const dir = makeTempDir("exec-m2-write-throw");
    try {
      const ledger = new RunWorkspaceLedger({ workspaceRoot: join(dir, "workspaces") });
      ledger.open();
      const fixture = openExecFixture("exec-m2-write-throw", {
        scenario: "success",
        leaseDurationMs: 60_000,
        workspace: new ThrowingWriteWorkspace(ledger)
      });
      try {
        seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
        const first = createQueuedRun(fixture, T0);
        const second = createQueuedRun(fixture, T1);

        // Before the fix the thrown workspace write propagated out of the
        // claim, rejected the queue-loop promise and stalled the queue with
        // the attempt left ACTIVE under a live lease.
        const queue = fixture.executor.runQueue();
        await drainScheduler(fixture.scheduler);

        // The mid-execution IO failure aborted the claim WITHOUT a terminal
        // event: the attempt stays ACTIVE (owned, live lease) and the loop
        // went idle at the lease-deadline recovery wake-up — the loop itself
        // did NOT die and is NOT spinning.
        const firstRow = runRow(fixture, first.id);
        expect(firstRow.status).toBe("RUNNING");
        expect(firstRow.stage).toBe("PACKAGING");
        const firstTypes = eventTypes(fixture, first.id);
        expect(firstTypes).not.toContain("Failed");
        expect(firstTypes).not.toContain("Completed");
        expect(firstTypes).not.toContain("CancellationRequested");
        const firstAttemptId = eventsOf(fixture, first.id)[0]?.attemptId ?? "";
        expect(attemptRow(fixture, firstAttemptId).status).toBe("ACTIVE");
        expect(fixture.executor.isRunning).toBe(true);
        expect(runRow(fixture, second.id).status).toBe("QUEUED");

        // In-process lease expiry: the ongoing recovery wake-up classifies the
        // interrupted claim truthfully (no safe checkpoint at PACKAGING →
        // RECOVERY_FAILED, never CANCELLED) and the queue then claims and
        // completes the next Run automatically.
        fixture.scheduler.advance(61_000);
        await drainScheduler(fixture.scheduler);
        await queue;

        const failed = runRow(fixture, first.id);
        expect(failed.status).toBe("FAILED");
        expect(failed.failure_code).toBe("RECOVERY_FAILED");
        expect(failed.status).not.toBe("CANCELLED");
        const firstAttempt = fixture.orchestrator.getRunAttempt(firstAttemptId);
        expect(firstAttempt).toMatchObject({
          status: "INTERRUPTED",
          interruptionKind: "UNEXPECTED_INTERRUPTION",
          recoveryDecision: "RECOVERY_FAILED"
        });
        expect(firstAttempt?.status).not.toBe("CANCELLED");
        expect(eventTypes(fixture, first.id).at(-1)).toBe("Failed");
        // The serial queue survived the thrown workspace write: the later Run
        // completed normally through the SAME executor loop and workspace.
        expect(runRow(fixture, second.id).status).toBe("COMPLETED");
        expect(stageSequence(fixture, second.id)).toEqual(ALL_STAGES);
        expect(modelCount(fixture.db)).toBe(0);
      } finally {
        closeExecFixture(fixture);
      }
    } finally {
      removeTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 5 (P5-3): Codex App Server turn adapter through the executor
// ---------------------------------------------------------------------------

const INITIALIZE_RESULT = {
  codexHome: "C:\\Users\\me\\.codex",
  platformFamily: "windows",
  platformOs: "windows",
  userAgent: "codex-app-server/0.147.0"
};

/**
 * Two-sided in-process Codex transport: client writes deliver to the scripted
 * server (peer side); server messages deliver to the client handler. No real
 * Codex App Server process is ever spawned.
 */
class ScriptedExecutorTransport implements CodexTransport {
  private clientHandler: ((line: string) => void) | null = null;
  private peerHandler: ((line: string) => void) | null = null;

  writeLine(line: string): void {
    this.peerHandler?.(line);
  }

  setLineHandler(handler: (line: string) => void): void {
    this.clientHandler = handler;
  }

  registerPeer(handler: (line: string) => void): void {
    this.peerHandler = handler;
  }

  close(): void {
    // no-op
  }

  receiveMessage(message: JsonRpcMessage): void {
    this.clientHandler?.(JSON.stringify(message));
  }
}

/** Auto-answering scripted server of the used 0.147.0 subset. */
class ScriptedExecutorServer {
  readonly transport = new ScriptedExecutorTransport();
  readonly seen: Array<{ kind: "request" | "notification"; method: string; params?: unknown }> = [];
  private threadCounter = 0;
  private turnCounter = 0;
  private lastThreadId = "thread-none";
  private lastTurnId = "turn-none";
  private readonly interruptBehavior: "respond" | "ignore" | "error";

  constructor(options: { interruptBehavior?: "respond" | "ignore" | "error" } = {}) {
    this.interruptBehavior = options.interruptBehavior ?? "respond";
    this.transport.registerPeer((line) => {
      const decoded = decodeJsonRpcLine(line);
      if (decoded.kind === "notification") {
        const message = decoded.message as JsonRpcNotification;
        this.seen.push({ kind: "notification", method: message.method, params: message.params });
        return;
      }
      if (decoded.kind !== "request") return;
      const message = decoded.message as JsonRpcRequest;
      this.seen.push({ kind: "request", method: message.method, params: message.params });
      switch (message.method) {
        case "initialize":
          this.transport.receiveMessage({ id: message.id, result: INITIALIZE_RESULT });
          return;
        case "thread/start":
          this.threadCounter += 1;
          this.lastThreadId = `thread-${this.threadCounter}`;
          this.transport.receiveMessage({ id: message.id, result: { thread: { id: this.lastThreadId } } });
          return;
        case "thread/resume": {
          this.lastThreadId = (message.params as { threadId: string }).threadId;
          this.transport.receiveMessage({ id: message.id, result: { thread: { id: this.lastThreadId } } });
          return;
        }
        case "turn/start":
          this.turnCounter += 1;
          this.lastTurnId = `turn-${this.turnCounter}`;
          this.transport.receiveMessage({ id: message.id, result: { turn: { id: this.lastTurnId } } });
          return;
        case "turn/interrupt":
          if (this.interruptBehavior === "ignore") return; // left pending
          if (this.interruptBehavior === "error") {
            this.transport.receiveMessage({
              id: message.id,
              error: { code: -32603, message: "interrupt refused" }
            });
            return;
          }
          this.transport.receiveMessage({ id: message.id, result: {} });
          return;
        default:
          return; // left pending: timeout scenarios
      }
    });
  }

  requestMethods(): string[] {
    return this.seen.filter((entry) => entry.kind === "request").map((entry) => entry.method);
  }

  lastRequestParams(method: string): unknown {
    const matches = this.seen.filter((entry) => entry.kind === "request" && entry.method === method);
    return matches.at(-1)?.params;
  }

  emitAgentMessageDelta(delta: string): void {
    this.transport.receiveMessage({
      method: "item/agentMessage/delta",
      params: { threadId: this.lastThreadId, turnId: this.lastTurnId, itemId: "item-final", delta }
    });
  }

  emitTurnCompleted(status: "completed" | "interrupted" | "failed"): void {
    this.transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: this.lastThreadId, turn: { id: this.lastTurnId, status } }
    });
  }
}

/** The Codex adapter over a scripted server, ready to inject into a fixture. */
function openCodexAdapterFixture(
  prefix: string,
  options: {
    turnTimeoutMs?: number;
    interruptGraceTimeoutMs?: number;
    requestTimeoutMs?: number;
    interruptBehavior?: "respond" | "ignore" | "error";
    publishModel?: boolean;
    scenario?: FakeExecutorScenario;
    recoveryCapabilities?: RunRecoveryCapabilities;
  } = {}
): { fixture: ExecFixture; server: ScriptedExecutorServer } {
  const server = new ScriptedExecutorServer({
    ...(options.interruptBehavior === undefined
      ? {}
      : { interruptBehavior: options.interruptBehavior })
  });
  const client = new CodexAppServerClient({
    transport: server.transport,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000
  });
  const adapter = new CodexAppServerAdapter({
    client,
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    ...(options.interruptGraceTimeoutMs === undefined
      ? {}
      : { interruptGraceTimeoutMs: options.interruptGraceTimeoutMs })
  });
  const fixture = openExecFixture(prefix, {
    scenario: options.scenario ?? "success",
    agent: adapter,
    ...(options.recoveryCapabilities === undefined
      ? {}
      : { recoveryCapabilities: options.recoveryCapabilities }),
    // The PREPARING pipeline must produce prompt.md + invocation-package.json
    // + input/drawing.png so the turn input is complete.
    inputAdapter: new FakeInputAdapter({
      scenario: "single-page-pdf",
      now: () => new Date(T0),
      readSourceBytes: () => samplePdfBytes()
    }),
    resolveInputSource: () => ({
      source: { fileName: "drawing-a.pdf", format: "PDF", sizeBytes: 1024, sha256: "a".repeat(64) },
      absolutePath: "/unused/fake-source.pdf"
    }),
    skillResolvedPath: "C:\\skills\\solidworks-build-part-from-drawing",
    ...(options.publishModel === undefined ? {} : { publishModel: options.publishModel })
  });
  return { fixture, server };
}

describe("FakeExecutor result phase with the Codex turn adapter (P5-3)", () => {
  it("completes a transcript run through the translator + independent validator + atomic Model publication", async () => {
    const { fixture, server } = openCodexAdapterFixture("exec-p5-transcript", {
      publishModel: true
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      // The synthetic artifact set provides the truthful file bytes the final
      // agentMessage manifest will declare; ONLY the artifact files are
      // pre-written (the adapter writes the manifest itself).
      const set = produceSyntheticResultArtifactSet({
        runId: run.id,
        attemptSequence: 1,
        recordMp4: false,
        solidWorksVersion: "2025",
        adapterId: "codex-app-server",
        adapterVersion: "0.147.0"
      });
      for (const file of set.files) {
        if (file.relativePath === set.manifestRef) continue;
        fixture.workspace.writeOwnedFile({
          runId: run.id,
          attemptSequence: 1,
          relativePath: file.relativePath,
          content: file.content
        });
      }

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      // The claim reached the turn wait; the handshake + thread/start +
      // turn/start requests were already recorded against the REAL runtime
      // protocol subset.
      expect(server.requestMethods()).toEqual([
        "initialize",
        "thread/start",
        "turn/start"
      ]);
      expect(server.lastRequestParams("turn/start")).toMatchObject({
        threadId: "thread-1",
        outputSchema: { title: "SWPanel Agent Turn Output (Codex provider wire schema)" }
      });

      server.emitAgentMessageDelta(completedTurnOutputJson(set.manifest));
      server.emitTurnCompleted("completed");
      await queue;

      // Terminal events stay orchestrator-owned: Completed is written through
      // the atomic publication, never derived from the raw records.
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("COMPLETED");
      expect(row.model_id).not.toBeNull();
      expect(modelCount(fixture.db)).toBe(1);
      expect(artifactCount(fixture.db)).toBe(6);
      const types = eventTypes(fixture, run.id);
      expect(types.slice(-3)).toEqual(["AgentTurnCompleted", "ResultManifestReceived", "Completed"]);
      expect(types.filter((type) => type === "Completed").length).toBe(1);
      expect(types).not.toContain("Failed");
      // The adapter's session + raw log exist in the attempt workspace.
      const layout = fixture.workspace.createAttemptWorkspace(run.id, 1);
      expect(existsSync(join(layout.absoluteRoot, "runtime", "agent-session.json"))).toBe(true);
      expect(existsSync(join(layout.absoluteRoot, "logs", "agent-raw.log"))).toBe(true);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("maps a turn timeout onto AGENT_TIMEOUT through the orchestrator (terminal event stays owned)", async () => {
    const { fixture, server } = openCodexAdapterFixture("exec-p5-timeout", {
      turnTimeoutMs: 30,
      // After the wait timeout the adapter interrupts the turn and waits a
      // SHORT grace for the confirmation (no completion ever arrives): keep
      // the bounded recovery short so the test settles fast.
      interruptGraceTimeoutMs: 40
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(server.requestMethods()).toContain("turn/start");
      // NO completion is ever emitted: the bounded turn wait expires.
      await queue;

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("AGENT_TIMEOUT");
      const types = eventTypes(fixture, run.id);
      expect(types.at(-1)).toBe("Failed");
      expect(types.filter((type) => type === "Failed").length).toBe(1);
      const failed = eventsOf(fixture, run.id).at(-1);
      expect(failed).toMatchObject({ type: "Failed", failureCode: "AGENT_TIMEOUT" });
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "INTERRUPTED" });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("running cancel interrupts the in-flight Codex turn BEFORE the bounded wait settles it", async () => {
    const { fixture, server } = openCodexAdapterFixture("exec-p5-interrupt");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(server.requestMethods()).toContain("turn/start");

      // RUNNING cancel: the executor asks the adapter to interrupt the turn
      // BEFORE the bounded wait — the turn/interrupt request is already on
      // the wire while the claim is still blocked in the turn wait.
      const cancel = fixture.executor.cancelRun(run.id);
      expect(server.requestMethods().at(-1)).toBe("turn/interrupt");
      expect(runRow(fixture, run.id).status).toBe("RUNNING");

      // The runtime reports the interrupted completion; the claim unwinds
      // WITHOUT a second terminal event (the cancel flow owns the terminal).
      server.emitTurnCompleted("interrupted");
      await cancel;
      await queue;

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("CANCELLED");
      const types = eventTypes(fixture, run.id);
      // The stage walk preceded the cancel; the terminal pair stays
      // orchestrator-owned and exactly one CancellationRequested exists.
      expect(types.slice(-2)).toEqual(["CancellationRequested", "CancellationConfirmed"]);
      expect(types.filter((type) => type === "CancellationRequested").length).toBe(1);
      expect(types.filter((type) => type === "Failed").length).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a RUNNING Run that reaches its own terminal state during the cooperative wait resolves ALREADY_TERMINAL instead of throwing DOMAIN_INVARIANT", async () => {
    // Gated turn: the claim blocks inside runTurn until the test releases it,
    // so the cancel call is deterministically INSIDE the bounded wait when the
    // turn completes NATURALLY (the runtime answers success despite the
    // interrupt). The claim then translates + validates + completes the Run
    // itself — the exact natural-settle race of review finding M1.
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const delegate = new FakeAgentAdapter();
    const gated: AgentTurnAdapter = {
      adapterId: delegate.adapterId,
      adapterVersion: delegate.adapterVersion,
      protocol: delegate.protocol,
      protocolVersion: delegate.protocolVersion,
      threadIdFor: (runId) => delegate.threadIdFor(runId),
      async runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
        await turnGate;
        return { kind: "completed", records: delegate.produceResult(input) };
      },
      interruptTurn: () => Promise.resolve()
    };
    const fixture = openExecFixture("exec-cancel-natural-terminal", {
      scenario: "success",
      agent: gated
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      // The claim walked all six stages and is blocked inside the gated turn;
      // the Run is RUNNING.
      expect(runRow(fixture, run.id).status).toBe("RUNNING");

      const cancel = fixture.executor.cancelRun(run.id);
      // The cancel persisted CancellationRequested, delivered the interrupt and
      // is now inside the bounded claim-stop wait.
      expect(runRow(fixture, run.id).status).toBe("RUNNING");

      // The turn completes naturally; the claim settles the Run as COMPLETED
      // while the cancel still waits.
      releaseTurn();
      await drainScheduler(fixture.scheduler);

      // Stable structured outcome — never a thrown DOMAIN_INVARIANT.
      const result = await cancel;
      expect(result).toEqual({ runId: run.id, status: "ALREADY_TERMINAL", finalStatus: "COMPLETED" });
      await queue;

      // The natural terminal state wins: no CancellationConfirmed, no CANCELLED
      // attempt, no workspace deletion — the terminal Run owns its output.
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("COMPLETED");
      const types = eventTypes(fixture, run.id);
      expect(types.filter((type) => type === "CancellationRequested").length).toBe(1);
      expect(types).not.toContain("CancellationConfirmed");
      expect(types.at(-1)).toBe("Completed");
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "FINISHED" });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a FAILED interrupt delivery with the claim settling COMPLETED during the wait resolves ALREADY_TERMINAL (F1 settle race)", async () => {
    // interruptTurn REJECTS (delivery failure) while the gated turn completes
    // NATURALLY during the bounded wait: the claim settles the Run itself, so
    // the interrupted-delivery branch must RE-READ first and return the stable
    // ALREADY_TERMINAL outcome — a now-terminal Run can no longer be routed
    // through failCancelCleanup (which could only throw a raw invariant).
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const delegate = new FakeAgentAdapter();
    const gated: AgentTurnAdapter = {
      adapterId: delegate.adapterId,
      adapterVersion: delegate.adapterVersion,
      protocol: delegate.protocol,
      protocolVersion: delegate.protocolVersion,
      threadIdFor: (runId) => delegate.threadIdFor(runId),
      async runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
        await turnGate;
        return { kind: "completed", records: delegate.produceResult(input) };
      },
      interruptTurn: () => Promise.reject(new Error("interrupt delivery failed"))
    };
    const fixture = openExecFixture("exec-cancel-f1-interrupt-race", {
      scenario: "success",
      agent: gated
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      // The claim walked all six stages and is blocked inside the gated turn;
      // the Run is RUNNING.
      expect(runRow(fixture, run.id).status).toBe("RUNNING");

      const cancel = fixture.executor.cancelRun(run.id);
      // The cancel persisted CancellationRequested, the interrupt delivery
      // FAILED and the bounded claim-stop wait is in flight.
      expect(runRow(fixture, run.id).status).toBe("RUNNING");

      // The turn completes naturally; the claim settles the Run as COMPLETED
      // while the cancel still waits.
      releaseTurn();
      await drainScheduler(fixture.scheduler);

      // Stable structured outcome — never a raw invariant from failing the
      // now-terminal Run's cleanup.
      const result = await cancel;
      expect(result).toEqual({ runId: run.id, status: "ALREADY_TERMINAL", finalStatus: "COMPLETED" });
      await queue;

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("COMPLETED");
      const types = eventTypes(fixture, run.id);
      expect(types.filter((type) => type === "CancellationRequested").length).toBe(1);
      expect(types).not.toContain("CancellationConfirmed");
      expect(types).not.toContain("Failed");
      expect(types.at(-1)).toBe("Completed");
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "FINISHED" });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("the serial queue continues after one turn adapter failure (AGENT_TIMEOUT on the first claim)", async () => {
    // A custom async turn adapter that fails ONLY the first claim with a typed
    // AgentTurnError and then delegates to the deterministic fake.
    let failedOnce = false;
    const delegate = new FakeAgentAdapter();
    const flaky: AgentTurnAdapter = {
      adapterId: delegate.adapterId,
      adapterVersion: delegate.adapterVersion,
      protocol: delegate.protocol,
      protocolVersion: delegate.protocolVersion,
      threadIdFor: (runId) => delegate.threadIdFor(runId),
      async runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
        if (!failedOnce) {
          failedOnce = true;
          throw new AgentTurnError("AGENT_TIMEOUT", "scripted first-turn timeout (technical)");
        }
        return delegate.runTurn(input);
      }
    };
    const fixture = openExecFixture("exec-p5-queue-continue", {
      scenario: "success",
      agent: flaky,
      publishModel: true
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const first = createQueuedRun(fixture, T0);
      const second = createQueuedRun(fixture, T1);

      await runToCompletion(fixture);

      const firstRow = runRow(fixture, first.id);
      expect(firstRow.status).toBe("FAILED");
      expect(firstRow.failure_code).toBe("AGENT_TIMEOUT");
      const secondRow = runRow(fixture, second.id);
      expect(secondRow.status).toBe("COMPLETED");
      expect(secondRow.model_id).not.toBeNull();
      expect(modelCount(fixture.db)).toBe(1);
      // Exactly one terminal event per Run, all orchestrator-owned.
      expect(eventTypes(fixture, first.id).filter((type) => type === "Failed").length).toBe(1);
      expect(eventTypes(fixture, second.id).filter((type) => type === "Completed").length).toBe(1);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a live (owned) agent does not get the scripted stage walk and its sanitized failure detail reaches the message", async () => {
    const delegate = new FakeAgentAdapter();
    const failing: AgentTurnAdapter = {
      adapterId: delegate.adapterId,
      adapterVersion: delegate.adapterVersion,
      protocol: delegate.protocol,
      protocolVersion: delegate.protocolVersion,
      threadIdFor: (runId) => delegate.threadIdFor(runId),
      runTurn(): Promise<AgentTurnOutcome> {
        return Promise.reject(new AgentTurnError("AGENT_RUNTIME_UNAVAILABLE", "turn failed", "model not supported"));
      }
    };
    const fixture = openExecFixture("exec-live-agent-progress", {
      scenario: "success",
      agent: failing,
      ownsAgent: true
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const events = eventsOf(fixture, run.id);
      const stages = events.filter((event) => event.type === "StageChanged");
      expect(stages.map((event) => (event.type === "StageChanged" ? event.stage : ""))).toEqual(["PREPARING", "ANALYZING"]);
      const progress = events.filter((event) => event.type === "ProgressUpdated");
      expect(progress.every((event) => event.type === "ProgressUpdated" && event.progressPercent < 100)).toBe(true);
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("AGENT_RUNTIME_UNAVAILABLE");
      expect(String(row.failure_message)).toContain("model not supported");
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("live agent activity is published as real, capped progress while the turn runs", async () => {
    const delegate = new FakeAgentAdapter();
    const reporting: AgentTurnAdapter = {
      adapterId: delegate.adapterId,
      adapterVersion: delegate.adapterVersion,
      protocol: delegate.protocol,
      protocolVersion: delegate.protocolVersion,
      threadIdFor: (runId) => delegate.threadIdFor(runId),
      runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
        input.onActivity?.({ commandCount: 40, fileChangeCount: 5, toolCount: 10, messageCount: 3 });
        return delegate.runTurn(input);
      }
    };
    const fixture = openExecFixture("exec-live-agent-activity", {
      scenario: "success",
      agent: reporting,
      ownsAgent: true,
      publishModel: true
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      await runToCompletion(fixture);

      const events = eventsOf(fixture, run.id);
      const percents = events.flatMap((event) => (event.type === "ProgressUpdated" ? [event.progressPercent] : []));
      const live = percents.filter((value) => value > 20 && value <= 90);
      expect(live.length).toBeGreaterThan(0);
      expect(events.some((event) => event.type === "StageChanged" && event.stage === "MODELING")).toBe(true);
      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a turn that never stops prevents the cancel confirmation: FAILED/CANCEL_CLEANUP_PENDING, workspace preserved, never CANCELLED", async () => {
    // The runtime IGNORES turn/interrupt (the request times out): the interrupt
    // was never delivered, so the cancellation must not confirm — ownership is
    // never closed, the workspace is never deleted, CANCELLED never written.
    const { fixture, server } = openCodexAdapterFixture("exec-p5-cancel-unstopped", {
      turnTimeoutMs: 80,
      requestTimeoutMs: 40,
      interruptBehavior: "ignore"
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(server.requestMethods()).toContain("turn/start");

      const cancel = fixture.executor.cancelRun(run.id);
      await expect(cancel).resolves.toEqual({
        runId: run.id,
        status: "FAILED",
        failureCode: "CANCEL_CLEANUP_PENDING"
      });
      // The claim's own turn wait also expires: it unwinds without a terminal
      // event (the cancel flow owns the aftermath).
      await queue;

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      const types = eventTypes(fixture, run.id);
      expect(types.filter((type) => type === "CancellationRequested").length).toBe(1);
      expect(types).not.toContain("CancellationConfirmed");
      expect(types.filter((type) => type === "Failed").length).toBe(1);
      // The attempt workspace was NEVER deleted (a live adapter may still write).
      const prompt = fixture.workspace.readOwnedFile({
        runId: run.id,
        attemptSequence: 1,
        relativePath: "runtime/prompt.md"
      });
      expect(prompt).not.toBeNull();
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({ status: "INTERRUPTED" });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a failed turn/interrupt delivery also prevents the cancel confirmation (workspace preserved)", async () => {
    // The runtime answers turn/interrupt with a JSON-RPC ERROR: the delivery
    // failed, so the cancellation must never confirm either.
    const { fixture, server } = openCodexAdapterFixture("exec-p5-cancel-interrupt-failed", {
      turnTimeoutMs: 80,
      requestTimeoutMs: 40,
      interruptBehavior: "error"
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(server.requestMethods()).toContain("turn/start");

      const cancel = fixture.executor.cancelRun(run.id);
      await expect(cancel).resolves.toEqual({
        runId: run.id,
        status: "FAILED",
        failureCode: "CANCEL_CLEANUP_PENDING"
      });
      await queue;

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      const types = eventTypes(fixture, run.id);
      expect(types).not.toContain("CancellationConfirmed");
      const prompt = fixture.workspace.readOwnedFile({
        runId: run.id,
        attemptSequence: 1,
        relativePath: "runtime/prompt.md"
      });
      expect(prompt).not.toBeNull();
    } finally {
      closeExecFixture(fixture);
    }
  });
});

describe("FakeExecutor ownership-safe cancel (P5-4)", () => {
  /** The fake agent plus a cooperative interruptTurn that records its call. */
  function interruptibleAgent(calls: string[]): AgentTurnAdapter {
    const delegate = new FakeAgentAdapter();
    return {
      adapterId: delegate.adapterId,
      adapterVersion: delegate.adapterVersion,
      protocol: delegate.protocol,
      protocolVersion: delegate.protocolVersion,
      threadIdFor: (runId) => delegate.threadIdFor(runId),
      runTurn: (input) =>
        Promise.resolve({ kind: "completed", records: delegate.produceResult(input) }),
      interruptTurn: (input) => {
        void input;
        calls.push("interrupt");
        return Promise.resolve();
      }
    };
  }

  /** Delegates to a real ledger but records the attempt-workspace cleanup. */
  function observingWorkspace(
    ledger: RunWorkspaceLedger,
    calls: string[]
  ): AttemptWorkspace {
    return {
      createAttemptWorkspace: (runId, attemptSequence) =>
        ledger.createAttemptWorkspace(runId, attemptSequence),
      writeOwnedFile: (input) => ledger.writeOwnedFile(input),
      readOwnedFile: (input) => ledger.readOwnedFile(input),
      deleteAttemptWorkspace: (runId, attemptSequence) => {
        calls.push("delete");
        ledger.deleteAttemptWorkspace(runId, attemptSequence);
      }
    };
  }

  /** A second executor over the same store with an injected ownership surface. */
  function foreignExecutorWithOwnership(
    fixture: ExecFixture,
    workspace: AttemptWorkspace,
    ownership: SolidWorksOwnershipSurface
  ): { executor: FakeExecutor; orchestrator: RunOrchestrator } {
    const orchestrator = new RunOrchestrator(fixture.db, fixture.runs, {
      now: fixture.scheduler.now
    });
    return {
      executor: new FakeExecutor({
        orchestrator,
        runs: fixture.runs,
        workspace,
        scenario: "success",
        scheduler: fixture.scheduler,
        now: fixture.scheduler.now,
        cooperativeStopTimeoutMs: 1_000,
        ownership
      }),
      orchestrator
    };
  }

  it("orders a RUNNING cancel: request persisted, agent interrupt, claim-stop wait, ownership close, workspace delete, terminal confirm", async () => {
    const calls: string[] = [];
    const close = vi.fn<(identity: SolidWorksIdentity) => void>((identity) => {
      calls.push(
        `close:${identity.kind}:${identity.kind === "pid" ? identity.pid : identity.documentIdentity}`
      );
    });
    const guard = new SolidWorksOwnershipGuard({ closer: { close } });
    const surface: SolidWorksOwnershipSurface = {
      snapshotRecord: (input) => {
        calls.push("snapshot");
        return guard.snapshotRecord(input);
      },
      closeOnlyOwned: (record) => {
        calls.push("close");
        return guard.closeOnlyOwned(record);
      }
    };
    const ledgerDir = makeTempDir("exec-ownership-order-ledger");
    const ledger = new RunWorkspaceLedger({ workspaceRoot: join(ledgerDir, "workspaces") });
    ledger.open();
    const fixture = openExecFixture("exec-ownership-order", {
      scenario: "success",
      agent: interruptibleAgent(calls),
      workspace: observingWorkspace(ledger, calls),
      ownership: surface
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      // The attempt attests exactly its two SolidWorks processes.
      guard.record({
        runId: run.id,
        attemptId: claim?.attempt.id ?? "",
        pids: [101, 202]
      });

      const result = await fixture.executor.cancelRun(run.id, "所有权顺序");
      expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });

      // Interrupt BEFORE the ownership close, close BEFORE the workspace
      // delete; the terminal pair is persisted last (steps are structural).
      expect(calls).toEqual([
        "interrupt",
        "snapshot",
        "close",
        "close:pid:101",
        "close:pid:202",
        "delete"
      ]);
      // The closer received ONLY the individually attested identities, one per
      // call — never a batch, never anything unattested.
      expect(close).toHaveBeenCalledTimes(2);
      expect(close.mock.calls).toEqual([
        [{ kind: "pid", pid: 101 }],
        [{ kind: "pid", pid: 202 }]
      ]);
      const types = eventTypes(fixture, run.id);
      expect(types).toEqual(["CancellationRequested", "CancellationConfirmed"]);
      expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      expect(fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "")).toMatchObject({
        status: "CANCELLED"
      });
    } finally {
      closeExecFixture(fixture);
      removeTempDir(ledgerDir);
    }
  });

  it("a claim that stops in the SAME tick as the stop-timeout is not falsely failed: the timeout's post-race recheck sees the settled claim and the cancel confirms normally (F2)", async () => {
    const calls: string[] = [];
    const ledgerDir = makeTempDir("exec-stop-race-ledger");
    const ledger = new RunWorkspaceLedger({ workspaceRoot: join(ledgerDir, "workspaces") });
    ledger.open();
    const fixture = openExecFixture("exec-stop-race", {
      scenario: "success",
      workspace: observingWorkspace(ledger, calls)
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // The claim walks PREPARING and then parks at its first scheduled step
      // tick (never flushed): the Run is RUNNING with a live in-memory claim.
      const queue = fixture.executor.runQueue();
      expect(runRow(fixture, run.id).status).toBe("RUNNING");

      // RUNNING cancel: CancellationRequested persisted, the abort signalled;
      // the parked claim can only honor it when its step tick fires, so the
      // cancel enters the bounded claim-stop wait with the timeout task
      // scheduled at +1000ms.
      const cancel = fixture.executor.cancelRun(run.id);
      // Drain the interrupt-delivery microtask so the claim-stop wait is
      // entered and its timeout task is scheduled on the shared clock.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Make BOTH the parked step tick and the stop-timeout due in ONE flush.
      // `flushAll` resolves them SYNCHRONOUSLY, one after the other: the step
      // tick resolves the claim's park (its cooperative-stop check and the
      // executeClaim finally still run as NESTED microtasks afterwards) and
      // the timeout task fires right after, resolving the bounded wait's race
      // to `false` BEFORE any of those microtasks ran. The timeout
      // continuation therefore starts while the claim's unwind microtasks are
      // still pending and schedules the F2 zero-delay recheck; the claim's
      // `done` settles in the same tick, so the recheck race reports the stop
      // (the recheck task is then cancelled before it ever fires) — the cancel
      // must NOT falsely fail as CANCEL_CLEANUP_PENDING.
      fixture.scheduler.advance(1_000);
      fixture.scheduler.flushAll();

      const result = await cancel;
      expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      await queue;
      expect(calls).toContain("delete");
      const types = eventTypes(fixture, run.id);
      expect(types.slice(-2)).toEqual(["CancellationRequested", "CancellationConfirmed"]);
      expect(types).not.toContain("Failed");
      expect(runRow(fixture, run.id).status).toBe("CANCELLED");
    } finally {
      closeExecFixture(fixture);
      removeTempDir(ledgerDir);
    }
  });

  it("a claim that stays live through the full stop-timeout AND the zero-delay recheck fails the cancel CANCEL_CLEANUP_PENDING with no destructive work (F2 opposite branch)", async () => {
    // Gated turn: the claim parks INSIDE runTurn on an external promise that
    // never resolves while the cancel runs — a genuinely unresolved claim, with
    // NO pending scheduler task that could accidentally settle it. The
    // cooperative abort is signalled and the interrupt is delivered, but the
    // claim simply never stops.
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const delegate = new FakeAgentAdapter();
    const gated: AgentTurnAdapter = {
      adapterId: delegate.adapterId,
      adapterVersion: delegate.adapterVersion,
      protocol: delegate.protocol,
      protocolVersion: delegate.protocolVersion,
      threadIdFor: (runId) => delegate.threadIdFor(runId),
      async runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
        await turnGate;
        return { kind: "completed", records: delegate.produceResult(input) };
      },
      interruptTurn: () => Promise.resolve()
    };
    const surfaceCalls: string[] = [];
    const surface: SolidWorksOwnershipSurface = {
      snapshotRecord: (input) => {
        void input;
        surfaceCalls.push("snapshot");
        return null;
      },
      closeOnlyOwned: () => {
        surfaceCalls.push("close");
        throw new Error("unreachable: the ownership surface must never be consulted");
      }
    };
    const calls: string[] = [];
    const ledgerDir = makeTempDir("exec-f2-unresolved-claim-ledger");
    const ledger = new RunWorkspaceLedger({ workspaceRoot: join(ledgerDir, "workspaces") });
    ledger.open();
    const fixture = openExecFixture("exec-f2-unresolved-claim", {
      scenario: "success",
      agent: gated,
      ownership: surface,
      workspace: observingWorkspace(ledger, calls),
      cooperativeStopTimeoutMs: 1_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // The queue loop promise is settled only in the finally (after the gate
      // is released); never awaited inside the test body.
      void fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      // The claim walked all six stages and is blocked inside the gated turn;
      // the Run is RUNNING with a live in-memory claim.
      expect(runRow(fixture, run.id).status).toBe("RUNNING");

      const cancel = fixture.executor.cancelRun(run.id);
      // The cancel persisted CancellationRequested, delivered the interrupt and
      // entered the bounded claim-stop wait; the timeout task is scheduled at
      // +1000ms and the claim is still blocked (the gate never opened).
      await new Promise<void>((resolve) => setImmediate(resolve));
      fixture.scheduler.advance(1_000);
      // Fire ONLY the stop-timeout (the claim has no scheduler task pending —
      // it is parked on the external turn gate), so the timeout resolves the
      // race to `false`.
      expect(fixture.scheduler.flushOne()).toBe(true);
      // The timeout continuation schedules the F2 zero-delay recheck; drain
      // the microtask chain, then drive that second task EXPLICITLY so the
      // recheck race resolves and the wait cannot hang.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.scheduler.flushOne()).toBe(true);

      // The claim never stopped: the cancel must NOT confirm, must NOT consult
      // ownership and must NOT delete the workspace — the stable cleanup-
      // failure outcome with the attempt INTERRUPTED (never CANCELLED).
      const result = await cancel;
      expect(result).toEqual({ runId: run.id, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" });
      expect(surfaceCalls).toEqual([]);
      expect(calls).toEqual([]);
      const types = eventTypes(fixture, run.id);
      // The walked stage trios precede the terminal pair; the terminal pair is
      // exactly the request + the cleanup-failure, never a confirmation.
      expect(types.slice(-2)).toEqual(["CancellationRequested", "Failed"]);
      expect(types).not.toContain("CancellationConfirmed");
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      expect(row.status).not.toBe("CANCELLED");
      const attempt = fixture.orchestrator.getRunAttempt(
        eventsOf(fixture, run.id)[0]?.attemptId ?? ""
      );
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
      expect(modelCount(fixture.db)).toBe(0);
      // NOTE: the queue loop is NOT awaited here — the claim is still blocked
      // on the gated turn; the finally releases the gate and stops the loop.
    } finally {
      // Release the gated turn so the parked claim can unwind and the queue
      // loop settles (its late completion is absorbed by the M2 boundary: the
      // attempt is already INTERRUPTED, so no second terminal event is ever
      // written).
      releaseTurn();
      await fixture.executor.stop();
      closeExecFixture(fixture);
      removeTempDir(ledgerDir);
    }
  });

  it("a foreign takeover between the claim-stop wait and the ownership close is never destroyed: the pre-destructive re-validation returns CANCEL_PENDING (F1)", async () => {
    const surfaceCalls: string[] = [];
    const surface: SolidWorksOwnershipSurface = {
      snapshotRecord: (input) => {
        surfaceCalls.push("snapshot");
        return buildOwnershipRecord({
          runId: input.runId,
          attemptId: input.attemptId,
          identities: [pidOf(999)]
        });
      },
      closeOnlyOwned: () => {
        surfaceCalls.push("close");
        throw new Error("unreachable: the ownership surface must never be consulted");
      }
    };
    const calls: string[] = [];
    const ledgerDir = makeTempDir("exec-f1-takeover-ledger");
    const ledger = new RunWorkspaceLedger({ workspaceRoot: join(ledgerDir, "workspaces") });
    ledger.open();
    const fixture = openExecFixture("exec-f1-takeover", {
      scenario: "success",
      leaseDurationMs: 60_000,
      ownership: surface,
      workspace: observingWorkspace(ledger, calls)
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // The claim walks PREPARING and parks at its first step tick (never
      // flushed): the Run is RUNNING and the attempt is owned by THIS
      // orchestrator with a valid lease. The queue loop is never awaited: it
      // parks on the foreign lease deadline and `stop()` in the finally
      // settles it.
      void fixture.executor.runQueue();
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      const captured = fixture.orchestrator.getActiveAttempt(run.id);
      expect(captured?.ownerToken).toBe(fixture.orchestrator.ownerToken);
      const attemptRoot = join(ledgerDir, "workspaces", "runs", run.id, "attempt-001");
      expect(existsSync(attemptRoot)).toBe(true);

      // The attempt's lease expires while the claim is parked (its owner's
      // heartbeat stopped), exactly like a dead process.
      fixture.scheduler.advance(61_000);

      // RUNNING cancel: request persisted, the abort signalled; the parked
      // claim still holds the bounded stop wait open (its step tick has not
      // fired yet).
      const cancel = fixture.executor.cancelRun(run.id, "外部接管取消");

      // The claim stops cooperatively when its parked step tick fires (NO
      // terminal event; the Run stays RUNNING) — and THEN orchestrator B's
      // cancel wins the atomic lease fence first: it seizes the expired
      // attempt with a FRESH fence lease, i.e. the takeover lands between the
      // claim's stop and the cancel's destructive phase (ownership close /
      // workspace delete). (A recovery-resume takeover is no longer possible
      // here by design: the scan must never resume a RUNNING Run with a
      // persisted CancellationRequested — it SKIPs it.)
      fixture.scheduler.flushOne();
      const foreign = new RunOrchestrator(fixture.db, fixture.runs, {
        now: fixture.scheduler.now
      });
      const seized = foreign.seizeCancelCleanupOwnership({
        runId: run.id,
        attemptId: captured?.id ?? "",
        ownerToken: foreign.ownerToken
      });
      expect(seized).toMatchObject({
        status: "ACTIVE",
        ownerToken: foreign.ownerToken
      });
      expect(Date.parse(seized.leaseDeadlineAt ?? "")).toBeGreaterThan(
        Date.parse(fixture.scheduler.now().toISOString())
      );

      const result = await cancel;
      // The atomic fence sees no longer the same ACTIVE attempt owned by this
      // orchestrator — it now holds a LIVE foreign lease — so the stable
      // pending outcome is returned.
      expect(result).toMatchObject({
        runId: run.id,
        status: "CANCEL_PENDING",
        detail: "FOREIGN_LIVE_LEASE"
      });
      if (result.status === "CANCEL_PENDING") {
        expect(result.leaseDeadlineAt).toBe(foreign.getActiveAttempt(run.id)?.leaseDeadlineAt);
      }
      // Nothing destructive happened: the ownership surface was NEVER
      // consulted, the workspace was NOT deleted and the old cancel wrote no
      // CancellationConfirmed / Failed terminal event.
      expect(surfaceCalls).toEqual([]);
      expect(calls).toEqual([]);
      expect(existsSync(attemptRoot)).toBe(true);
      const types = eventTypes(fixture, run.id);
      expect(types).not.toContain("CancellationConfirmed");
      expect(types).not.toContain("Failed");
      expect(types.filter((type) => type === "CancellationRequested")).toHaveLength(1);
      expect(runRow(fixture, run.id).status).toBe("RUNNING");
      // The foreign ACTIVE attempt and its live fence lease remain intact (no
      // recovery decision — the fence writes none, it is not a resume).
      const takenOver = fixture.orchestrator.getRunAttempt(captured?.id ?? "");
      expect(takenOver).toMatchObject({
        status: "ACTIVE",
        ownerToken: foreign.ownerToken
      });
      expect(takenOver?.recoveryDecision).toBeUndefined();
      expect(takenOver?.interruptionKind).toBeUndefined();
      expect(Date.parse(takenOver?.leaseDeadlineAt ?? "")).toBeGreaterThan(
        Date.parse(fixture.scheduler.now().toISOString())
      );
    } finally {
      await fixture.executor.stop();
      closeExecFixture(fixture);
      removeTempDir(ledgerDir);
    }
  });

  it("a cross-Runner cancel cannot consult ownership or delete the workspace while the cleanup lease is live", async () => {
    const surfaceCalls: string[] = [];
    const surface: SolidWorksOwnershipSurface = {
      snapshotRecord: (input) => {
        void input;
        surfaceCalls.push("snapshot");
        return null;
      },
      closeOnlyOwned: () => {
        surfaceCalls.push("close");
        throw new Error("unreachable: the ownership surface must never be consulted");
      }
    };
    const fixture = openExecFixture("exec-cleanup-lease-fence", {
      scenario: "success",
      leaseDurationMs: 60_000,
      ownership: surface
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.scheduler.advance(1_000);
      // Owner A claims the run; its lease then expires while A's cancel is
      // stopped (the exact shape where A's cleanup is about to run).
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      // Real cancel intent is persisted first — the cleanup fence is bound to
      // a persisted CancellationRequested and refuses to mint a lease without
      // one.
      fixture.runs.appendRunEvents({
        runId: run.id,
        attemptId: claim?.attempt.id ?? "",
        entries: [
          {
            payload: { type: "CancellationRequested" },
            occurredAt: fixture.scheduler.now().toISOString()
          }
        ]
      });
      fixture.scheduler.advance(61_000);
      const workspacePath = attemptWorkspacePath(fixture, run.id, 1);
      mkdirSync(join(workspacePath, "working"), { recursive: true });
      writeFileSync(join(workspacePath, "working", "partial.txt"), "cleanup-fenced work\n");

      // A's in-flight cancel establishes the cleanup lease (the mid-cleanup
      // point between the atomic fence and the terminal confirm).
      const seized = fixture.orchestrator.seizeCancelCleanupOwnership({
        runId: run.id,
        attemptId: claim?.attempt.id ?? "",
        ownerToken: fixture.orchestrator.ownerToken
      });
      expect(seized).toMatchObject({ status: "ACTIVE", ownerToken: fixture.orchestrator.ownerToken });
      expect(Date.parse(seized.leaseDeadlineAt ?? "")).toBeGreaterThan(
        Date.parse(fixture.scheduler.now().toISOString())
      );

      // B's cross-Runner cancel arrives while the cleanup lease is LIVE: it
      // must return the stable CANCEL_PENDING outcome WITHOUT consulting the
      // ownership surface and WITHOUT deleting the workspace — the fence lease
      // is exactly what a plain re-read could not guarantee.
      const foreign = foreignExecutorWithOwnership(fixture, fixture.workspace, surface);
      const pending = await foreign.executor.cancelRun(run.id, "外部取消");
      expect(pending).toMatchObject({
        runId: run.id,
        status: "CANCEL_PENDING",
        detail: "FOREIGN_LIVE_LEASE"
      });
      if (pending.status === "CANCEL_PENDING") {
        expect(pending.leaseDeadlineAt).toBe(seized.leaseDeadlineAt);
      }
      expect(surfaceCalls).toEqual([]);
      expect(existsSync(join(workspacePath, "working", "partial.txt"))).toBe(true);
      expect(eventTypes(fixture, run.id)).toEqual(["CancellationRequested"]);
      expect(fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "")).toMatchObject({
        status: "ACTIVE",
        ownerToken: fixture.orchestrator.ownerToken
      });

      // A's in-flight cancel then settles through the final guarded
      // transaction: CANCELLED, exactly one terminal pair.
      const confirmed = fixture.orchestrator.cancelAttempt({
        runId: run.id,
        attemptId: claim?.attempt.id ?? "",
        ownerToken: fixture.orchestrator.ownerToken,
        finishedAt: fixture.scheduler.now().toISOString()
      });
      expect(confirmed).toMatchObject({ status: "CANCELLED", interruptionKind: "CANCELLED" });
      expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      expect(eventTypes(fixture, run.id)).toEqual(["CancellationRequested", "CancellationConfirmed"]);
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a nothing-owned close (nothing attested) still cancels normally and never calls the closer", async () => {
    const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
      void _identity;
    });
    const guard = new SolidWorksOwnershipGuard({ closer: { close } });
    const fixture = openExecFixture("exec-ownership-nothing", {
      scenario: "success",
      ownership: guard
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);

      const result = await fixture.executor.cancelRun(run.id);
      expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
      expect(close).not.toHaveBeenCalled();
      expect(eventTypes(fixture, run.id)).toEqual(["CancellationRequested", "CancellationConfirmed"]);
      expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("an unproven ownership record routes through the cleanup failure: FAILED / CANCEL_CLEANUP_PENDING, never CANCELLED", async () => {
    const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
      void _identity;
    });
    const guard = new SolidWorksOwnershipGuard({ closer: { close } });
    // The record is forged (built, never attested through the guard): the
    // close is refused as ownership-unproven and the closer is never invoked.
    const surface: SolidWorksOwnershipSurface = {
      snapshotRecord: (input) =>
        buildOwnershipRecord({
          runId: input.runId,
          attemptId: input.attemptId,
          identities: [pidOf(999)]
        }),
      closeOnlyOwned: (record) => guard.closeOnlyOwned(record)
    };
    const deleteCalls: string[] = [];
    const fixture = openExecFixture("exec-ownership-unproven", {
      scenario: "success",
      ownership: surface,
      workspace: {
        createAttemptWorkspace: () => {
          throw new Error("unreachable");
        },
        writeOwnedFile: () => {
          throw new Error("unreachable");
        },
        readOwnedFile: () => {
          throw new Error("unreachable");
        },
        deleteAttemptWorkspace: () => {
          deleteCalls.push("delete");
        }
      }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);

      const result = await fixture.executor.cancelRun(run.id, "所有权未证明");
      expect(result).toEqual({ runId: run.id, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" });
      // The closer and the workspace cleanup are never reached.
      expect(close).not.toHaveBeenCalled();
      expect(deleteCalls).toEqual([]);
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      expect(row.status).not.toBe("CANCELLED");
      const types = eventTypes(fixture, run.id);
      expect(types).toEqual(["CancellationRequested", "Failed"]);
      expect(types).not.toContain("CancellationConfirmed");
      const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      expect(attempt?.status).not.toBe("CANCELLED");
      expect(modelCount(fixture.db)).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a partial ownership close fails the cancel with CANCEL_CLEANUP_PENDING (never CANCELLED)", async () => {
    const close = vi.fn((identity: SolidWorksIdentity): void => {
      if (identity.kind === "pid" && identity.pid === 202) {
        throw new Error("close rejected for 202");
      }
    });
    const guard = new SolidWorksOwnershipGuard({ closer: { close } });
    const fixture = openExecFixture("exec-ownership-partial", {
      scenario: "success",
      ownership: guard
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      guard.record({ runId: run.id, attemptId: claim?.attempt.id ?? "", pids: [101, 202] });

      const result = await fixture.executor.cancelRun(run.id);
      expect(result).toEqual({ runId: run.id, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" });
      // Both proven identities were still attempted (best-effort), one per call.
      expect(close).toHaveBeenCalledTimes(2);
      expect(close.mock.calls).toEqual([
        [{ kind: "pid", pid: 101 }],
        [{ kind: "pid", pid: 202 }]
      ]);
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      expect(row.status).not.toBe("CANCELLED");
      expect(eventTypes(fixture, run.id)).toEqual(["CancellationRequested", "Failed"]);
      const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
      expect(attempt).toMatchObject({ status: "INTERRUPTED" });
      expect(attempt?.status).not.toBe("CANCELLED");
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a failed close (every identity throws) and a THROWN close both fail with CANCEL_CLEANUP_PENDING", async () => {
    // Every proven identity throws -> the structured `failed` outcome.
    const throwingCloser = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
      void _identity;
      throw new Error("boom");
    });
    const guard = new SolidWorksOwnershipGuard({ closer: { close: throwingCloser } });
    const fixture = openExecFixture("exec-ownership-failed", {
      scenario: "success",
      ownership: guard
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      guard.record({ runId: run.id, attemptId: claim?.attempt.id ?? "", pids: [101] });

      const result = await fixture.executor.cancelRun(run.id);
      expect(result).toEqual({ runId: run.id, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" });
      expect(runRow(fixture, run.id).status).toBe("FAILED");
      expect(runRow(fixture, run.id).status).not.toBe("CANCELLED");
    } finally {
      closeExecFixture(fixture);
    }

    // A THROWN closeOnlyOwned (injected surface programming error) is a
    // cleanup failure too: the cancellation is never confirmed.
    const throwingSurface: SolidWorksOwnershipSurface = {
      snapshotRecord: () =>
        buildOwnershipRecord({
          runId: "run-1",
          attemptId: "attempt-1",
          identities: [pidOf(101)]
        }),
      closeOnlyOwned: () => {
        throw new Error("injected close throw");
      }
    };
    const second = openExecFixture("exec-ownership-thrown-close", {
      scenario: "success",
      ownership: throwingSurface
    });
    try {
      seedRevision(second, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(second, T0);
      second.scheduler.advance(1_000);
      const claim = second.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);

      const result = await second.executor.cancelRun(run.id);
      expect(result).toEqual({ runId: run.id, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" });
      const types = eventTypes(second, run.id);
      expect(types).toEqual(["CancellationRequested", "Failed"]);
      expect(types).not.toContain("CancellationConfirmed");
      expect(runRow(second, run.id).status).toBe("FAILED");
      expect(runRow(second, run.id).status).not.toBe("CANCELLED");
    } finally {
      closeExecFixture(second);
    }
  });

  it("second race: the Run settles between the cancel re-read and the cleanup failure resolves ALREADY_TERMINAL (F1)", async () => {
    // No live claim, so the cancel's stop wait resolves immediately and the
    // pipeline reaches the ownership snapshot with the Run still RUNNING. The
    // injected surface settles the Run itself (COMPLETED) and THEN throws —
    // the settle happens between the cancel's re-read and
    // orchestrator.failCancelCleanup, which rejects the now-finished attempt.
    // The hardened cleanup path re-reads and returns the stable terminal
    // outcome instead of propagating the raw RunnerInvariantError.
    const fixture = openExecFixture("exec-cancel-f1-second-race", {
      scenario: "success",
      ownership: {
        snapshotRecord: (input) => {
          fixture.orchestrator.completeAttempt({
            runId: input.runId,
            attemptId: input.attemptId,
            ownerToken: fixture.orchestrator.ownerToken
          });
          throw new Error("injected ownership snapshot failure");
        },
        closeOnlyOwned: () => {
          throw new Error("unreachable");
        }
      }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);

      const result = await fixture.executor.cancelRun(run.id);
      expect(result).toEqual({ runId: run.id, status: "ALREADY_TERMINAL", finalStatus: "COMPLETED" });
      // The natural terminal state wins: no CancellationConfirmed, no Failed.
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("COMPLETED");
      const types = eventTypes(fixture, run.id);
      expect(types.filter((type) => type === "CancellationRequested").length).toBe(1);
      expect(types).not.toContain("CancellationConfirmed");
      expect(types).not.toContain("Failed");
      const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
      expect(attempt).toMatchObject({ status: "FINISHED" });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("persisted cancel-cleanup failure messages are path-redacted (F2): no user home / OS temp path leaks", async () => {
    // The ownership snapshot throws an error whose message embeds an absolute
    // path under the OS temp dir and the user home; the persisted Failed event
    // must expose neither (fixed placeholders instead) — the message flows
    // through the shared cleanup-failure choke point of the cancel path.
    const secretPath = join(os.tmpdir(), "swpanel-secret", "owned.sldprt");
    const fixture = openExecFixture("exec-cancel-f2-redaction", {
      scenario: "success",
      ownership: {
        snapshotRecord: () => {
          throw new Error(
            `cannot verify ownership record at ${secretPath} (under user home ${os.homedir()})`
          );
        },
        closeOnlyOwned: () => {
          throw new Error("unreachable");
        }
      }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.scheduler.advance(1_000);
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);

      const result = await fixture.executor.cancelRun(run.id);
      expect(result).toEqual({ runId: run.id, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" });

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
      expect(row.failure_message).toBeDefined();
      expect(row.failure_message).not.toContain(secretPath);
      expect(row.failure_message).not.toContain(os.tmpdir());
      expect(row.failure_message).not.toContain(os.homedir());
      expect(row.failure_message).toContain("<os-temp-dir>");
      expect(row.failure_message).toContain("<user-home>");
      // The persisted Failed event carries the same redacted message.
      const failed = eventsOf(fixture, run.id).find((event) => event.type === "Failed");
      expect(failed).toBeDefined();
      const message = (failed as { failureMessage?: string }).failureMessage ?? "";
      expect(message).not.toContain(secretPath);
      expect(message).not.toContain(os.tmpdir());
      expect(message).not.toContain(os.homedir());
      expect(message).toContain("<os-temp-dir>");
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a live foreign lease never consults the ownership surface", async () => {
    const fixture = openExecFixture("exec-ownership-foreign", {
      scenario: "success",
      leaseDurationMs: 60_000
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // Orchestrator A claims the run: the attempt is owned by A with a VALID
      // lease. Give it a workspace file so the "not deleted" assertion is real.
      const claim = fixture.orchestrator.claimNextQueuedRun();
      expect(claim?.runId).toBe(run.id);
      const workspacePath = attemptWorkspacePath(fixture, run.id, 1);
      mkdirSync(join(workspacePath, "working"), { recursive: true });
      writeFileSync(join(workspacePath, "working", "partial.txt"), "live foreign work\n");

      const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
        void _identity;
      });
      const surfaceCalls: string[] = [];
      const surface: SolidWorksOwnershipSurface = {
        snapshotRecord: (input) => {
          surfaceCalls.push("snapshot");
          return buildOwnershipRecord({
            runId: input.runId,
            attemptId: input.attemptId,
            identities: [pidOf(999)]
          });
        },
        closeOnlyOwned: (record) => {
          surfaceCalls.push("close");
          return new SolidWorksOwnershipGuard({ closer: { close } }).closeOnlyOwned(record);
        }
      };
      // Executor B (fresh owner) cancels while A's lease is still valid: the
      // cancel stays pending and the ownership surface is NEVER consulted.
      const foreign = foreignExecutorWithOwnership(fixture, fixture.workspace, surface);
      const result = await foreign.executor.cancelRun(run.id, "外部取消");
      expect(result.status).toBe("CANCEL_PENDING");
      if (result.status === "CANCEL_PENDING") {
        expect(result.detail).toBe("FOREIGN_LIVE_LEASE");
        expect(result.leaseDeadlineAt).toBe(claim?.attempt.leaseDeadlineAt);
      }
      expect(surfaceCalls).toEqual([]);
      expect(close).not.toHaveBeenCalled();
      expect(eventTypes(fixture, run.id)).toEqual(["CancellationRequested"]);
      expect(existsSync(join(workspacePath, "working", "partial.txt"))).toBe(true);
      expect(fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "")).toMatchObject({
        status: "ACTIVE"
      });
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("high-stage recovery (MODELING) is refused despite a pinned thread session", async () => {
    let runId = "";
    const pinnedModeling: ThreadSessionLike = {
      stage: "MODELING",
      protocol: PINNED_THREAD_SESSION_PROTOCOL,
      protocolVersion: PINNED_THREAD_SESSION_PROTOCOL_VERSION
    };
    const fixture = openExecFixture("exec-ownership-high-stage-recovery", {
      scenario: "crash",
      leaseDurationMs: 60_000,
      recoveryCapabilities: threadSessionRecoveryCapabilities((lookedUpRunId) =>
        lookedUpRunId === runId ? pinnedModeling : null
      )
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      runId = run.id;
      // The crash scenario walks to MODELING and stops without a terminal
      // event; the attempt stays ACTIVE with an expiring lease.
      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "MODELING" });
      const attemptId = eventsOf(fixture, run.id)[0]?.attemptId ?? "";
      expect(attemptRow(fixture, attemptId).status).toBe("ACTIVE");

      // Lease expiry: the scan consults the session-backed capabilities. Even
      // a PINNED MODELING session proves NO safe checkpoint (hard pin) — the
      // attempt is failed truthfully, never resumed, never CANCELLED.
      fixture.scheduler.advance(61_000);
      const scan = fixture.orchestrator.recoverExpiredAttempts();
      expect(scan.entries[0]?.outcome).toBe("RECOVERY_FAILED");
      expect(scan.entries[0]?.decision).not.toBe("RESUME");
      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("RECOVERY_FAILED");
      expect(row.status).not.toBe("CANCELLED");
      const attempt = fixture.orchestrator.getRunAttempt(attemptId);
      expect(attempt).toMatchObject({
        status: "INTERRUPTED",
        interruptionKind: "UNEXPECTED_INTERRUPTION",
        recoveryDecision: "RECOVERY_FAILED"
      });
      expect(modelCount(fixture.db)).toBe(0);
      await fixture.executor.stop();
      await queue;
    } finally {
      closeExecFixture(fixture);
    }
  });

  describe("workspace-backed ownership surface end-to-end (P5-4/B2)", () => {
    /** The attempt-relative registry payload the Agent writes. */
    function registryPayload(
      runId: string,
      attemptId: string,
      documents: readonly string[]
    ): string {
      return JSON.stringify({
        schemaVersion: SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION,
        runId,
        attemptId,
        attemptSequence: 1,
        updatedAt: "2026-08-16T09:00:00.000Z",
        documents
      });
    }

    /** Persists the run stage + the ownership registry of attempt-001. */
    function persistStageAndRegistry(
      fixture: ExecFixture,
      ledger: RunWorkspaceLedger,
      runId: string,
      attemptId: string,
      stage: RunStage,
      registry: string | null
    ): void {
      fixture.runs.appendRunEvents({
        runId,
        attemptId,
        entries: [
          {
            payload: { type: "StageChanged", stage, activity: `stage ${stage}` },
            occurredAt: fixture.scheduler.now().toISOString()
          }
        ]
      });
      ledger.createAttemptWorkspace(runId, 1);
      if (registry !== null) {
        ledger.writeOwnedFile({
          runId,
          attemptSequence: 1,
          relativePath: SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
          content: Buffer.from(registry, "utf8")
        });
      }
      // A partial-work marker the cancel cleanup must only remove on a NORMAL
      // cancellation; a failed (CANCEL_CLEANUP_PENDING) cancel must leave it.
      ledger.writeOwnedFile({
        runId,
        attemptSequence: 1,
        relativePath: "working/partial.txt",
        content: Buffer.from("partial work before the interruption\n", "utf8")
      });
    }

    /** A fixture whose executor carries the REAL workspace-backed surface. */
    function workspaceOwnershipFixture(
      prefix: string,
      closer: SolidWorksIdentityCloser
    ): { fixture: ExecFixture; ledger: RunWorkspaceLedger } {
      const ledgerDir = makeTempDir(`${prefix}-ledger`);
      const ledger = new RunWorkspaceLedger({ workspaceRoot: join(ledgerDir, "workspaces") });
      ledger.open();
      const holder: { runs: RunRepository | null; orchestrator: RunOrchestrator | null } = {
        runs: null,
        orchestrator: null
      };
      const surface = new WorkspaceSolidWorksOwnershipSurface({
        workspace: {
          stageOf: (runId) => holder.runs?.getRun(runId)?.stage ?? null,
          attemptSequenceOf: (runId, attemptId) => {
            const attempt = holder.orchestrator?.getActiveAttempt(runId) ?? null;
            return attempt !== null && attempt.id === attemptId ? attempt.attemptSequence : null;
          },
          attemptRootOf: (runId, attemptSequence) =>
            ledger.workspaceLayout(runId, attemptSequence).absoluteRoot,
          readAttemptFile: (input) => {
            const file = ledger.readOwnedFile(input);
            return file === null ? null : file.content;
          }
        },
        closer
      });
      const fixture = openExecFixture(prefix, {
        scenario: "success",
        workspace: ledger,
        ownership: surface
      });
      holder.runs = fixture.runs;
      holder.orchestrator = fixture.orchestrator;
      return { fixture, ledger };
    }

    it("pre-CAD cancel with NO registry stays a normal CANCELLED (nothing owned)", async () => {
      const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
        void _identity;
      });
      const { fixture, ledger } = workspaceOwnershipFixture("exec-ws-ownership-low-empty", {
        close
      });
      try {
        seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
        const run = createQueuedRun(fixture, T0);
        fixture.scheduler.advance(1_000);
        const claim = fixture.orchestrator.claimNextQueuedRun();
        expect(claim?.runId).toBe(run.id);
        persistStageAndRegistry(
          fixture,
          ledger,
          run.id,
          claim?.attempt.id ?? "",
          "ANALYZING",
          null
        );

        const result = await fixture.executor.cancelRun(run.id);
        expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
        // The surface returned null (nothing owned): the closer was never
        // consulted and the cancellation was confirmed normally.
        expect(close).not.toHaveBeenCalled();
        expect(eventTypes(fixture, run.id)).toEqual([
          "StageChanged",
          "CancellationRequested",
          "CancellationConfirmed"
        ]);
        expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      } finally {
        closeExecFixture(fixture);
      }
    });

    it("a VALID plan registry before MODELING is still nothing-owned (CANCELLED normally)", async () => {
      const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
        void _identity;
      });
      const { fixture, ledger } = workspaceOwnershipFixture("exec-ws-ownership-low-plan", {
        close
      });
      try {
        seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
        const run = createQueuedRun(fixture, T0);
        fixture.scheduler.advance(1_000);
        const claim = fixture.orchestrator.claimNextQueuedRun();
        expect(claim?.runId).toBe(run.id);
        persistStageAndRegistry(
          fixture,
          ledger,
          run.id,
          claim?.attempt.id ?? "",
          "ANALYZING",
          registryPayload(run.id, claim?.attempt.id ?? "", ["working/plate.sldprt"])
        );

        const result = await fixture.executor.cancelRun(run.id);
        expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
        expect(close).not.toHaveBeenCalled();
        expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      } finally {
        closeExecFixture(fixture);
      }
    });

    it("cancel at MODELING with a VALID registry closes the attested document and confirms", async () => {
      const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
        void _identity;
      });
      const { fixture, ledger } = workspaceOwnershipFixture("exec-ws-ownership-modeling-valid", {
        close
      });
      try {
        seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
        const run = createQueuedRun(fixture, T0);
        fixture.scheduler.advance(1_000);
        const claim = fixture.orchestrator.claimNextQueuedRun();
        expect(claim?.runId).toBe(run.id);
        const attemptId = claim?.attempt.id ?? "";
        persistStageAndRegistry(
          fixture,
          ledger,
          run.id,
          attemptId,
          "MODELING",
          registryPayload(run.id, attemptId, ["working/底板-法兰.sldprt"])
        );

        const result = await fixture.executor.cancelRun(run.id);
        expect(result).toEqual({ runId: run.id, status: "CANCELLED", alreadyCancelled: false });
        // The surface attested the registry as ONE absolute document identity
        // (resolved against the REAL attempt workspace root) and the guard
        // closed it (a normal cancellation may proceed).
        expect(close).toHaveBeenCalledTimes(1);
        const identity = close.mock.calls[0]?.[0];
        const root = ledger.workspaceLayout(run.id, 1).absoluteRoot;
        expect(identity).toEqual({
          kind: "document",
          documentIdentity: join(root, "working", "底板-法兰.sldprt")
        });
        expect(eventTypes(fixture, run.id)).toEqual([
          "StageChanged",
          "CancellationRequested",
          "CancellationConfirmed"
        ]);
        expect(runRow(fixture, run.id).status).toBe("CANCELLED");
      } finally {
        closeExecFixture(fixture);
      }
    });

    it("REGRESSION: cancel at MODELING with a MISSING registry never deletes the workspace and never writes CANCELLED", async () => {
      const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
        void _identity;
      });
      const { fixture, ledger } = workspaceOwnershipFixture(
        "exec-ws-ownership-modeling-missing",
        { close }
      );
      try {
        seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
        const run = createQueuedRun(fixture, T0);
        fixture.scheduler.advance(1_000);
        const claim = fixture.orchestrator.claimNextQueuedRun();
        expect(claim?.runId).toBe(run.id);
        persistStageAndRegistry(
          fixture,
          ledger,
          run.id,
          claim?.attempt.id ?? "",
          "MODELING",
          null
        );

        const result = await fixture.executor.cancelRun(run.id);
        expect(result).toEqual({
          runId: run.id,
          status: "FAILED",
          failureCode: "CANCEL_CLEANUP_PENDING"
        });
        // The closer and the workspace cleanup were NEVER reached.
        expect(close).not.toHaveBeenCalled();
        const workspacePath = join(ledger.workspaceLayout(run.id, 1).absoluteRoot, "working", "partial.txt");
        expect(existsSync(workspacePath)).toBe(true);
        const row = runRow(fixture, run.id);
        expect(row.status).toBe("FAILED");
        expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
        expect(row.status).not.toBe("CANCELLED");
        const types = eventTypes(fixture, run.id);
        expect(types).toEqual(["StageChanged", "CancellationRequested", "Failed"]);
        expect(types).not.toContain("CancellationConfirmed");
        const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
        expect(attempt).toMatchObject({
          status: "INTERRUPTED",
          interruptionKind: "UNEXPECTED_INTERRUPTION"
        });
        expect(attempt?.status).not.toBe("CANCELLED");
        expect(modelCount(fixture.db)).toBe(0);
      } finally {
        closeExecFixture(fixture);
      }
    });

    it("REGRESSION: cancel at MODELING with a MALFORMED registry never deletes the workspace and never writes CANCELLED", async () => {
      const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
        void _identity;
      });
      const { fixture, ledger } = workspaceOwnershipFixture(
        "exec-ws-ownership-modeling-malformed",
        { close }
      );
      try {
        seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
        const run = createQueuedRun(fixture, T0);
        fixture.scheduler.advance(1_000);
        const claim = fixture.orchestrator.claimNextQueuedRun();
        expect(claim?.runId).toBe(run.id);
        persistStageAndRegistry(
          fixture,
          ledger,
          run.id,
          claim?.attempt.id ?? "",
          "MODELING",
          registryPayload(run.id, claim?.attempt.id ?? "", ["../escaped.sldprt"])
        );

        const result = await fixture.executor.cancelRun(run.id);
        expect(result).toEqual({
          runId: run.id,
          status: "FAILED",
          failureCode: "CANCEL_CLEANUP_PENDING"
        });
        expect(close).not.toHaveBeenCalled();
        const workspacePath = join(ledger.workspaceLayout(run.id, 1).absoluteRoot, "working", "partial.txt");
        expect(existsSync(workspacePath)).toBe(true);
        const row = runRow(fixture, run.id);
        expect(row.status).toBe("FAILED");
        expect(row.failure_code).toBe("CANCEL_CLEANUP_PENDING");
        expect(row.status).not.toBe("CANCELLED");
        const types = eventTypes(fixture, run.id);
        expect(types).toEqual(["StageChanged", "CancellationRequested", "Failed"]);
        expect(types).not.toContain("CancellationConfirmed");
        const attempt = fixture.orchestrator.getRunAttempt(claim?.attempt.id ?? "");
        expect(attempt).toMatchObject({ status: "INTERRUPTED" });
        expect(attempt?.status).not.toBe("CANCELLED");
      } finally {
        closeExecFixture(fixture);
      }
    });
  });
});

describe("FakeExecutor thread-session resume wiring (P5-4)", () => {
  /** A pinned (repo-protocol) technical session record of a prior interrupted turn. */
  function pinnedSession(threadId: string): ReturnType<typeof buildAgentSessionRecord> {
    return buildAgentSessionRecord({
      threadId,
      status: "interrupted",
      adapterId: "codex-app-server",
      adapterVersion: "0.147.0",
      protocol: PINNED_THREAD_SESSION_PROTOCOL,
      protocolVersion: PINNED_THREAD_SESSION_PROTOCOL_VERSION,
      nowIso: () => T0
    });
  }

  /**
   * Persists the pinned session + the truthful artifact bytes of a prior
   * interrupted adapter run into attempt-001, so the resumed claim finds a
   * resumable thread AND the validator later accepts the manifest the turn
   * will produce.
   */
  function persistPriorTurnFiles(
    fixture: ExecFixture,
    runId: string,
    session: ReturnType<typeof buildAgentSessionRecord>
  ): ReturnType<typeof produceSyntheticResultArtifactSet> {
    fixture.workspace.createAttemptWorkspace(runId, 1);
    writeAgentSessionRecord(fixture.workspace, { runId, attemptSequence: 1, record: session });
    const set = produceSyntheticResultArtifactSet({
      runId,
      attemptSequence: 1,
      recordMp4: false,
      solidWorksVersion: "2025",
      adapterId: "codex-app-server",
      adapterVersion: "0.147.0"
    });
    for (const file of set.files) {
      if (file.relativePath === set.manifestRef) continue;
      fixture.workspace.writeOwnedFile({
        runId,
        attemptSequence: 1,
        relativePath: file.relativePath,
        content: file.content
      });
    }
    return set;
  }

  it("a resumed low-stage attempt loads the persisted pinned session: thread/resume with the SAME thread id + metadata resume marker", async () => {
    const { fixture, server } = openCodexAdapterFixture("exec-p5-session-resume", {
      scenario: "recovery-supported",
      // The executor-level gate under test: recovery approval is permissive,
      // the executor itself must load the persisted session through the ledger
      // and hand it to the adapter ONLY when the strict read + the pinned
      // protocol hold.
      recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      const priorThreadId = "thread-prior-9";
      const set = persistPriorTurnFiles(fixture, run.id, pinnedSession(priorThreadId));

      // First claim: walks PREPARING + ANALYZING and stops without a terminal
      // event; the interrupted attempt stays ACTIVE with an expiring lease.
      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });

      // Lease expiry: recovery approves, the resumed claim loads the persisted
      // pinned session and the Codex adapter RESUMES the SAME thread — never a
      // fresh thread/start.
      fixture.scheduler.advance(61_000);
      await drainScheduler(fixture.scheduler);
      expect(server.requestMethods()).toEqual(["initialize", "thread/resume", "turn/start"]);
      expect(server.lastRequestParams("thread/resume")).toMatchObject({ threadId: priorThreadId });

      server.emitAgentMessageDelta(completedTurnOutputJson(set.manifest));
      server.emitTurnCompleted("completed");
      await queue;

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("COMPLETED");
      expect(modelCount(fixture.db)).toBe(0);
      // Metadata resume marker: the persisted session of the resumed attempt
      // AND the technical raw log both record the resumed-from thread.
      const session = readAgentSessionRecord(fixture.workspace, {
        runId: run.id,
        attemptSequence: 1
      });
      expect(session?.threadId).toBe(priorThreadId);
      expect(session?.resumedFromThreadId).toBe(priorThreadId);
      const rawLog = fixture.workspace.readOwnedFile({
        runId: run.id,
        attemptSequence: 1,
        relativePath: RAW_AGENT_LOG_RELATIVE_PATH
      });
      const records = (rawLog?.content.toString("utf8") ?? "")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const metadata = records.find((record) => record.type === "metadata_updated");
      expect(metadata?.resumedFromThreadId).toBe(priorThreadId);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("regression: an adapter-produced session (protocolVersion = CODEX_PROTOCOL_VERSION) passes recovery + executor load and resumes the thread; high stage stays refused", async () => {
    // The prior session EXACTLY as CodexAppServerAdapter.runTurn persists it
    // (the adapter's OWN constants, never the recovery pin): protocol = the
    // adapter id, protocolVersion = the app-server protocol major the adapter
    // writes into every AgentSessionRecord, adapterVersion = the CLI release.
    // Regression: executor recovery/load rejected such a session because the
    // recovery pin held the CLI release (0.147.0) while the session protocol
    // field holds the app-server protocol major ("2").
    const adapterProduced = buildAgentSessionRecord({
      threadId: "thread-adapter-produced-3",
      status: "interrupted",
      adapterId: CODEX_APP_SERVER_ADAPTER_ID,
      adapterVersion: CODEX_CLI_VERSION,
      protocol: CODEX_APP_SERVER_ADAPTER_ID,
      protocolVersion: CODEX_PROTOCOL_VERSION,
      nowIso: () => T0
    });
    // The recovery/load gate must accept the adapter-produced session...
    expect(isPinnedThreadSessionProtocol(adapterProduced)).toBe(true);
    // ...while the high-stage hard pin stays: MODELING with the SAME adapter
    // protocol is never a safe checkpoint and never resumes.
    const highStageView: ThreadSessionLike = {
      stage: "MODELING",
      protocol: adapterProduced.protocol,
      protocolVersion: adapterProduced.protocolVersion
    };
    expect(hasSafeCheckpoint(highStageView)).toBe(false);
    expect(
      decideThreadResume({ runId: "run-high-stage", lookupSession: () => highStageView }).resume
    ).toBe(false);

    // Integration (executor path): recovery approval AND executor load are
    // both driven by the persisted adapter-produced session (the lookup
    // mirrors the Runner's lookupThreadSession: Run stage + session protocol
    // fields); the resumed claim must reach thread/resume with the SAME
    // thread id — never a fresh thread/start.
    let runId = "";
    const { fixture, server } = openCodexAdapterFixture("exec-p5-adapter-protocol-regression", {
      scenario: "recovery-supported",
      recoveryCapabilities: threadSessionRecoveryCapabilities((lookedUpRunId) => {
        if (lookedUpRunId !== runId) return null;
        // The lookup runs only during the recovery scan (after the fixture is
        // constructed), so referencing `fixture` here is safe.
        const persisted = readAgentSessionRecord(fixture.workspace, {
          runId,
          attemptSequence: 1
        });
        if (persisted === null) return null;
        return {
          stage: fixture.runs.getRun(runId)?.stage ?? null,
          protocol: persisted.protocol,
          protocolVersion: persisted.protocolVersion
        };
      })
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      runId = run.id;
      const set = persistPriorTurnFiles(fixture, run.id, adapterProduced);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });

      fixture.scheduler.advance(61_000);
      await drainScheduler(fixture.scheduler);
      expect(server.requestMethods()).toEqual(["initialize", "thread/resume", "turn/start"]);
      expect(server.lastRequestParams("thread/resume")).toMatchObject({
        threadId: adapterProduced.threadId
      });

      server.emitAgentMessageDelta(completedTurnOutputJson(set.manifest));
      server.emitTurnCompleted("completed");
      await queue;

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      // Round-trip: the session the ADAPTER persisted for the resumed turn
      // carries the SAME protocol fields recovery approved, and the resume
      // marker points at the interrupted thread.
      const session = readAgentSessionRecord(fixture.workspace, {
        runId: run.id,
        attemptSequence: 1
      });
      expect(session?.protocol).toBe(CODEX_APP_SERVER_ADAPTER_ID);
      expect(session?.protocolVersion).toBe(CODEX_PROTOCOL_VERSION);
      expect(session?.resumedFromThreadId).toBe(adapterProduced.threadId);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("an unpinned persisted session is never passed to the adapter: fresh thread/start instead of thread/resume", async () => {
    const { fixture, server } = openCodexAdapterFixture("exec-p5-session-unpinned", {
      scenario: "recovery-supported",
      recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      // A WELL-FORMED session of a FOREIGN protocol: the strict store read
      // accepts it, but the repo-pinned protocol check must treat it as absent
      // — the adapter may only ever resume a pinned thread.
      const foreign = buildAgentSessionRecord({
        threadId: "thread-foreign-3",
        status: "interrupted",
        adapterId: "codex-cli",
        adapterVersion: "1.0.0",
        protocol: "codex-cli",
        protocolVersion: "1.0.0",
        nowIso: () => T0
      });
      const set = persistPriorTurnFiles(fixture, run.id, foreign);

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });

      fixture.scheduler.advance(61_000);
      await drainScheduler(fixture.scheduler);
      // Recovery approved the attempt, but the unpinned session is NEVER
      // handed to the adapter: a FRESH thread/start is issued instead.
      expect(server.requestMethods()).toEqual(["initialize", "thread/start", "turn/start"]);
      expect(server.seen.some((entry) => entry.method === "thread/resume")).toBe(false);

      server.emitAgentMessageDelta(completedTurnOutputJson(set.manifest));
      server.emitTurnCompleted("completed");
      await queue;

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      const session = readAgentSessionRecord(fixture.workspace, {
        runId: run.id,
        attemptSequence: 1
      });
      // The fresh thread id of the scripted server; no resume marker.
      expect(session?.threadId).toBe("thread-1");
      expect(session?.resumedFromThreadId).toBeUndefined();
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("a malformed persisted session file is never resumed: strict store read -> fresh thread/start", async () => {
    const { fixture, server } = openCodexAdapterFixture("exec-p5-session-malformed", {
      scenario: "recovery-supported",
      recoveryCapabilities: { canSafelyResume: () => true, hasSafeCheckpoint: () => false }
    });
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const run = createQueuedRun(fixture, T0);
      fixture.workspace.createAttemptWorkspace(run.id, 1);
      fixture.workspace.writeOwnedFile({
        runId: run.id,
        attemptSequence: 1,
        relativePath: AGENT_SESSION_FILE_RELATIVE_PATH,
        content: Buffer.from("{not-json", "utf8")
      });
      const set = produceSyntheticResultArtifactSet({
        runId: run.id,
        attemptSequence: 1,
        recordMp4: false,
        solidWorksVersion: "2025",
        adapterId: "codex-app-server",
        adapterVersion: "0.147.0"
      });
      for (const file of set.files) {
        if (file.relativePath === set.manifestRef) continue;
        fixture.workspace.writeOwnedFile({
          runId: run.id,
          attemptSequence: 1,
          relativePath: file.relativePath,
          content: file.content
        });
      }

      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });

      fixture.scheduler.advance(61_000);
      await drainScheduler(fixture.scheduler);
      // The malformed file reads as NO session (strict store validation): the
      // adapter starts a fresh thread and never issues thread/resume.
      expect(server.requestMethods()).toEqual(["initialize", "thread/start", "turn/start"]);
      expect(server.seen.some((entry) => entry.method === "thread/resume")).toBe(false);

      server.emitAgentMessageDelta(completedTurnOutputJson(set.manifest));
      server.emitTurnCompleted("completed");
      await queue;

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("refuses recovery without a pinned well-formed session and never issues thread/resume", async () => {
    const malformedView = {
      stage: "EXPLORING",
      protocol: PINNED_THREAD_SESSION_PROTOCOL,
      protocolVersion: PINNED_THREAD_SESSION_PROTOCOL_VERSION
    } as unknown as ThreadSessionLike;
    const cases: Array<{ name: string; view: ThreadSessionLike | null }> = [
      { name: "missing", view: null },
      { name: "malformed", view: malformedView },
      { name: "unpinned", view: { stage: "ANALYZING", protocol: "codex-cli", protocolVersion: "1.0.0" } }
    ];
    for (const testCase of cases) {
      let runId = "";
      const { fixture, server } = openCodexAdapterFixture(`exec-p5-session-refusal-${testCase.name}`, {
        scenario: "recovery-supported",
        recoveryCapabilities: threadSessionRecoveryCapabilities((lookedUpRunId) =>
          lookedUpRunId === runId ? testCase.view : null
        )
      });
      try {
        seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
        const run = createQueuedRun(fixture, T0);
        runId = run.id;
        const queue = fixture.executor.runQueue();
        await drainScheduler(fixture.scheduler);
        expect(runRow(fixture, run.id)).toMatchObject({ status: "RUNNING", stage: "ANALYZING" });
        const attemptId = eventsOf(fixture, run.id)[0]?.attemptId ?? "";

        fixture.scheduler.advance(61_000);
        await drainScheduler(fixture.scheduler);
        await queue;

        // Accurate recovery refusal: the session-backed capability proves no
        // resume, the attempt is INTERRUPTED with RECOVERY_UNSUPPORTED and the
        // Codex adapter was NEVER invoked (no initialize, no thread/resume).
        const row = runRow(fixture, run.id);
        expect(row.status).toBe("FAILED");
        expect(row.failure_code).toBe("RECOVERY_UNSUPPORTED");
        expect(row.status).not.toBe("CANCELLED");
        expect(fixture.orchestrator.getRunAttempt(attemptId)).toMatchObject({
          status: "INTERRUPTED",
          interruptionKind: "UNEXPECTED_INTERRUPTION",
          recoveryDecision: "RECOVERY_UNSUPPORTED"
        });
        expect(server.requestMethods()).toEqual([]);
        expect(modelCount(fixture.db)).toBe(0);
      } finally {
        closeExecFixture(fixture);
      }
    }
  });
});

describe("Batch C lifecycle: owned agent close on a never-started executor / Runner", () => {
  function closeSpyAgent(onClose: () => void): AgentTurnAdapter {
    return {
      adapterId: "test-close-spy",
      adapterVersion: "1",
      protocol: "test",
      protocolVersion: "1",
      threadIdFor: (runId) => `thread-${runId}`,
      runTurn: () => Promise.resolve({ kind: "completed", records: [] }),
      close: onClose
    };
  }

  it("stop() closes an OWNED agent even when the queue loop never started (live transport never orphaned)", async () => {
    let closed = 0;
    const fixture = openExecFixture("exec-owned-never-started", {
      agent: closeSpyAgent(() => {
        closed += 1;
      }),
      ownsAgent: true
    });
    try {
      // No runQueue() was ever called: the eagerly spawned transport of an
      // owned live adapter must still be closed by stop().
      await fixture.executor.stop();
      expect(closed).toBe(1);
      // A repeated stop re-closes the owned adapter: the adapter close
      // contract is idempotent (the transport close is), so this is safe.
      await fixture.executor.stop();
      expect(closed).toBe(2);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("stop() closes an OWNED agent after a started queue loop too", async () => {
    let closed = 0;
    const fixture = openExecFixture("exec-owned-started", {
      agent: closeSpyAgent(() => {
        closed += 1;
      }),
      ownsAgent: true
    });
    try {
      // The queue loop runs once (nothing claimable: it drains immediately) —
      // the started-loop close path must behave like the never-started one.
      const queue = fixture.executor.runQueue();
      await drainScheduler(fixture.scheduler);
      await queue;
      await fixture.executor.stop();
      expect(closed).toBe(1);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("stop() never closes a caller-injected agent without explicit ownership (reuse preserved)", async () => {
    let closed = 0;
    const adapter = closeSpyAgent(() => {
      closed += 1;
    });
    const fixture = openExecFixture("exec-caller-owned", { agent: adapter });
    try {
      await fixture.executor.stop();
      expect(closed).toBe(0);
      // The adapter stays USABLE after stop: a shared/reused adapter can be
      // handed to the next executor after a reopen.
      await expect(
        adapter.runTurn({
          runId: "run-x",
          attemptId: "attempt-x",
          attemptSequence: 1,
          workspace: fixture.workspace,
          nowIso: () => new Date(T0).toISOString(),
          recordMp4: false,
          workspaceRoot: "/unused",
          promptText: "",
          localImageAbsolutePath: "",
          skill: { name: "test", resolvedPath: "" }
        })
      ).resolves.toEqual({ kind: "completed", records: [] });
      expect(closed).toBe(0);
    } finally {
      closeExecFixture(fixture);
    }
  });

  it("Runner.shutdown() closes an OWNED never-started live adapter through the async seam", async () => {
    const dir = makeTempDir("exec-runner-owned-shutdown");
    let closed = 0;
    const runner = new Runner(dir, {
      runProfile: PROFILE,
      agent: closeSpyAgent(() => {
        closed += 1;
      }),
      ownsAgent: true
    });
    try {
      runner.open();
      // The queue never started: the eagerly spawned live transport must be
      // closed by the awaitable shutdown seam, and the teardown is complete
      // only when the promise settles.
      await runner.shutdown();
      expect(closed).toBe(1);
      expect(runner.isOpen).toBe(false);
    } finally {
      if (runner.isOpen) runner.close();
      removeTempDir(dir);
    }
  });

  it("Runner.close() stays synchronous and a caller-injected agent survives open/close/reopen", () => {
    const dir = makeTempDir("exec-runner-reuse-reopen");
    let closed = 0;
    const adapter = closeSpyAgent(() => {
      closed += 1;
    });
    const runner = new Runner(dir, { runProfile: PROFILE, agent: adapter });
    try {
      runner.open();
      runner.close();
      // Same-tick reopen is safe (the resource teardown is synchronous) and
      // the SAME caller-injected adapter is reused — it was never closed.
      runner.open();
      runner.close();
      expect(closed).toBe(0);
      expect(runner.isOpen).toBe(false);
    } finally {
      if (runner.isOpen) runner.close();
      removeTempDir(dir);
    }
  });
});
