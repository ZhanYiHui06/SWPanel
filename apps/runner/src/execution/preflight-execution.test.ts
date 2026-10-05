import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  Drawing,
  DrawingRevision,
  InputAdapterScenario,
  InputAdapterSourceRef,
  PreflightScenario,
  RevisionSourceFile
} from "@swpanel/domain";
import { PLACEHOLDER_SKILL_SHA256, PREFLIGHT_CAPABILITIES } from "@swpanel/domain";

import { InvalidArgumentError } from "../errors.js";
import { makeTempDir, removeTempDir, samplePdfBytes } from "../test-utils.js";
import { SqliteDatabase } from "../db/database.js";
import { SqliteRepository } from "../db/repository.js";
import { RunRepository, type RunProfile } from "../db/run-repository.js";
import { RunOrchestrator } from "../orchestration/run-orchestrator.js";
import {
  RunWorkspaceLedger,
  type RunWorkspaceLayout,
  type StoredRunFile
} from "../ledger/run-workspace-ledger.js";
import {
  FakeExecutor,
  type AttemptWorkspace,
  type ExecutorScheduler,
  type ScheduledTask
} from "./fake-executor.js";
import type { Preflight, PreflightEnvironmentResult } from "../preflight/preflight.js";
import { FAKE_PREFLIGHT_SKILL_SHA256, PreflightGate } from "../preflight/preflight.js";
import { RealPreflightProbe } from "../preflight/real-preflight-probe.js";
import { hashSkillDirectory } from "../preflight/skill-directory-hash.js";
import { PROMPT_TEMPLATE_VERSION } from "../adaptation/prompt-template.js";

const T0 = "2026-08-14T09:00:00.000Z";

const PROFILE: RunProfile = {
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  // The synthetic gate allowlists EXACTLY its fixture digest: all-pass tests
  // freeze the fixture digest (P5-2 review fix).
  skill: { name: "solidworks-build-part-from-drawing", sha256: FAKE_PREFLIGHT_SKILL_SHA256 },
  agentConfigId: "agent-config-1"
};

/** Minimal deterministic scheduler (same idiom as the other execution tests). */
class ManualScheduler implements ExecutorScheduler {
  private tasks: Array<{ id: number; at: number; fn: () => void; cancelled: boolean }> = [];
  private nextId = 0;
  private currentMs: number;

  constructor(startMs: number) {
    this.currentMs = startMs;
  }

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

  private due(): boolean {
    return this.tasks.some((task) => !task.cancelled && task.at <= this.currentMs);
  }

  flushOne(): boolean {
    const next = this.tasks
      .filter((task) => !task.cancelled && task.at <= this.currentMs)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (next === undefined) return false;
    this.tasks = this.tasks.filter((task) => task !== next);
    next.fn();
    return true;
  }

  hasPending(): boolean {
    return this.tasks.some((task) => !task.cancelled && task.at <= this.currentMs);
  }

  drain(): void {
    while (this.due()) {
      this.flushOne();
    }
  }
}

interface FixtureOptions {
  preflightScenario?: PreflightScenario;
  inputAdapterScenario?: InputAdapterScenario;
  /** Injected custom preflight gate (overrides `preflightScenario`). */
  preflight?: Preflight;
  /** Wraps the real ledger: throws on writes of exactly this relative path. */
  failWriteRelativePath?: string;
}

interface Fixture {
  dir: string;
  dbPath: string;
  db: SqliteDatabase;
  store: SqliteRepository;
  runs: RunRepository;
  scheduler: ManualScheduler;
  workspace: RunWorkspaceLedger;
  executor: FakeExecutor;
}

function openFixture(prefix: string, options: FixtureOptions = {}): Fixture {
  const dir = makeTempDir(prefix);
  const dbPath = join(dir, "state", "swpanel.db");
  const db = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  const runs = new RunRepository(db, store);
  const scheduler = new ManualScheduler(Date.parse(T0));
  const orchestrator = new RunOrchestrator(db, runs, { now: scheduler.now });
  const ledger = new RunWorkspaceLedger({ workspaceRoot: join(dir, "workspaces") });
  ledger.open();
  const workspace: AttemptWorkspace =
    options.failWriteRelativePath === undefined ? ledger : new FailWriteWorkspace(ledger, options.failWriteRelativePath);
  const executor = new FakeExecutor({
    orchestrator,
    runs,
    workspace,
    scenario: "success",
    scheduler,
    now: scheduler.now,
    cooperativeStopTimeoutMs: 1_000,
    // P5-1: the deterministic preflight gate runs at PREPARING before the
    // Input Adapter; the runner-level default is the synthetic all-pass probe.
    ...(options.preflight !== undefined
      ? { preflight: options.preflight }
      : options.preflightScenario === undefined
        ? {}
        : { preflightScenario: options.preflightScenario }),
    // The deterministic Input Adapter runs at PREPARING (P4-1).
    ...(options.inputAdapterScenario === undefined
      ? {}
      : { inputAdapterScenario: options.inputAdapterScenario }),
    // The real source resolver: revision metadata + the file under the fixture
    // root (the Runner injects the same shape over the drawing ledger).
    resolveInputSource: (runId) => {
      const meta = runs.getRunInputSource(runId);
      if (meta === null) return null;
      const absolutePath = join(dir, ...meta.relativePath.split("/"));
      if (!existsSync(absolutePath)) return null;
      const source: InputAdapterSourceRef = {
        fileName: meta.fileName,
        format: meta.format,
        sizeBytes: meta.sizeBytes,
        sha256: meta.sha256
      };
      return { source, absolutePath };
    }
  });
  return { dir, dbPath, db, store, runs, scheduler, workspace: ledger, executor };
}

/** Ledger wrapper that throws ONLY on writes of one target relative path. */
class FailWriteWorkspace implements AttemptWorkspace {
  constructor(
    private readonly inner: RunWorkspaceLedger,
    private readonly targetRelativePath: string
  ) {}

  createAttemptWorkspace(runId: string, attemptSequence: number): RunWorkspaceLayout {
    return this.inner.createAttemptWorkspace(runId, attemptSequence);
  }

  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): StoredRunFile {
    if (input.relativePath === this.targetRelativePath) {
      throw new Error(`injected workspace write failure on ${this.targetRelativePath}`);
    }
    return this.inner.writeOwnedFile(input);
  }

  readOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): (StoredRunFile & { content: Buffer }) | null {
    return this.inner.readOwnedFile(input);
  }

  deleteAttemptWorkspace(runId: string, attemptSequence: number): void {
    this.inner.deleteAttemptWorkspace(runId, attemptSequence);
  }
}

function closeFixture(fixture: Fixture): void {
  if (fixture.db.isOpen) fixture.db.close();
  removeTempDir(fixture.dir);
}

/** Seeds a Drawing + Revision whose immutable source file really exists. */
function seedSourceRevision(
  fixture: Fixture,
  drawingId: string,
  revisionId: string
): { drawing: Drawing; revision: DrawingRevision; sourceFile: RevisionSourceFile } {
  const sourceFile: RevisionSourceFile = {
    id: `file-${revisionId}`,
    fileName: `${drawingId}.pdf`,
    format: "PDF",
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    relativePath: `library/drawings/file-${revisionId}/source/original.pdf`,
    uploadedAt: T0
  };
  const drawing: Drawing = {
    id: drawingId,
    drawingNumber: `D-${drawingId}`,
    name: `Drawing ${drawingId}`,
    currentRevisionId: null,
    createdAt: T0,
    updatedAt: T0
  };
  const revision: DrawingRevision = {
    id: revisionId,
    drawingId,
    sequence: 1,
    sourceFile,
    currentApprovedModelId: null,
    createdAt: T0,
    updatedAt: T0
  };
  fixture.db.transaction(() => {
    fixture.store.insertDrawing(drawing);
    fixture.store.insertRevisionFile(sourceFile);
    fixture.store.insertRevision(revision);
    fixture.store.setCurrentRevisionPointer(drawingId, revisionId, T0);
  });
  return { drawing, revision, sourceFile };
}

function writeSourceFile(fixture: Fixture, sourceFile: RevisionSourceFile): Buffer {
  const bytes = samplePdfBytes();
  const absolutePath = join(fixture.dir, ...sourceFile.relativePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
  return bytes;
}

function createRun(
  fixture: Fixture,
  drawingId: string,
  revisionId: string,
  profile: RunProfile = PROFILE
) {
  return fixture.runs.createRun({
    drawingId,
    revisionId,
    profile,
    createdAt: T0
  });
}

function eventTypes(fixture: Fixture, runId: string): string[] {
  return fixture.runs.listRunEvents(runId).map((event) => event.type);
}

function runRow(fixture: Fixture, runId: string) {
  return fixture.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as {
    status: string;
    failure_code: string | null;
    failure_message: string | null;
    stage: string | null;
  };
}

function attemptWorkspacePath(fixture: Fixture, runId: string, attemptSequence: number): string {
  return join(
    fixture.dir,
    "workspaces",
    "runs",
    runId,
    `attempt-${String(attemptSequence).padStart(3, "0")}`
  );
}

function readReport(fixture: Fixture, runId: string) {
  return JSON.parse(
    readFileSync(join(attemptWorkspacePath(fixture, runId, 1), "runtime", "preflight-report.json"), "utf8")
  ) as {
    contractVersion: number;
    passed: boolean;
    synthetic: boolean;
    checkedAt: string;
    checks: Array<{ capability: string; ok: boolean }>;
  };
}

/** Runs the queue to completion (all claims drained). */
async function runToCompletion(fixture: Fixture): Promise<void> {
  const queue = fixture.executor.runQueue();
  let guard = 0;
  while (fixture.scheduler.hasPending() && guard++ < 10_000) {
    fixture.scheduler.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  await queue;
}

describe("Phase 5 P5-1 preflight gate at PREPARING (synthetic fixture)", () => {
  it("the all-pass gate completes the Run and persists the redacted nine-item report", async () => {
    const fixture = openFixture("p5-preflight-pass", {
      preflightScenario: "all-pass",
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1");

      await runToCompletion(fixture);

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      // The P4-1/P4-2 preparation artifacts still exist next to the report.
      const workspace = attemptWorkspacePath(fixture, run.id, 1);
      expect(existsSync(join(workspace, "runtime", "invocation-package.json"))).toBe(true);
      expect(existsSync(join(workspace, "runtime", "prompt.md"))).toBe(true);

      const report = readReport(fixture, run.id);
      expect(report.contractVersion).toBe(2);
      expect(report.passed).toBe(true);
      expect(report.synthetic).toBe(true);
      expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(report.checks.map((check) => check.capability)).toEqual(PREFLIGHT_CAPABILITIES);
      expect(report.checks.every((check) => check.ok)).toBe(true);
      // Redacted: boolean checks only, no paths / secrets / reasoning.
      expect(JSON.stringify(report)).not.toMatch(/[A-Z]:\\|password|token|secret|error/i);
    } finally {
      closeFixture(fixture);
    }
  });

  const FAILING_SCENARIOS: Readonly<Array<{ scenario: PreflightScenario; capability: string; code: string }>> = [
    { scenario: "agent-runtime-unavailable", capability: "agent_runtime_available", code: "AGENT_RUNTIME_UNAVAILABLE" },
    { scenario: "agent-runtime-version-unsupported", capability: "agent_runtime_version_supported", code: "AGENT_RUNTIME_UNAVAILABLE" },
    { scenario: "agent-model-no-image-support", capability: "agent_model_supports_image", code: "AGENT_RUNTIME_UNAVAILABLE" },
    { scenario: "skill-not-discovered", capability: "modeling_skill_discovered", code: "SKILL_NOT_FOUND" },
    { scenario: "skill-hash-mismatch", capability: "modeling_skill_hash_allowed", code: "SKILL_HASH_MISMATCH" },
    { scenario: "protocol-unavailable", capability: "structured_runtime_protocol_available", code: "AGENT_PROTOCOL_INCOMPATIBLE" },
    { scenario: "workspace-write-unsupported", capability: "workspace_write_scope_supported", code: "PREFLIGHT_FAILED" },
    { scenario: "solidworks-unavailable", capability: "solidworks_available", code: "SOLIDWORKS_UNAVAILABLE" }
  ];

  for (const { scenario, capability, code } of FAILING_SCENARIOS) {
    it(`${scenario} fails closed with ${code}, no ANALYZING, and a redacted report`, async () => {
      const fixture = openFixture(`p5-preflight-${scenario}`, {
        preflightScenario: scenario,
        inputAdapterScenario: "single-page-pdf"
      });
      try {
        const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
        writeSourceFile(fixture, sourceFile);
        const run = createRun(fixture, "drawing-a", "revision-a1");

        await runToCompletion(fixture);

        const row = runRow(fixture, run.id);
        expect(row.status).toBe("FAILED");
        expect(row.failure_code).toBe(code);
        expect(row.failure_message).toContain(capability);
        // The gate runs BEFORE adaptation and before any stage event: the Run
        // never leaves PREPARING and no ANALYZING event exists.
        expect(row.stage).toBeNull();
        expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);
        const attempt = fixture.db
          .prepare("SELECT status, interruption_kind FROM run_attempts WHERE run_id = ?")
          .get(run.id) as { status: string; interruption_kind: string | null };
        expect(attempt).toMatchObject({
          status: "INTERRUPTED",
          interruption_kind: "UNEXPECTED_INTERRUPTION"
        });

        // The redacted report is persisted with the evaluated prefix only.
        const report = readReport(fixture, run.id);
        expect(report.passed).toBe(false);
        expect(report.synthetic).toBe(true);
        expect(report.checks.at(-1)).toEqual({ capability, ok: false });
        expect(report.checks.slice(0, -1).every((check) => check.ok)).toBe(true);
        expect(JSON.stringify(report)).not.toContain("C:");

        // File-level proof that input adaptation NEVER ran for an
        // environment-gate failure: no adapter, package or prompt artifacts.
        const workspace = attemptWorkspacePath(fixture, run.id, 1);
        expect(existsSync(join(workspace, "input", "drawing.png"))).toBe(false);
        expect(existsSync(join(workspace, "input", "adapter-result.json"))).toBe(false);
        expect(existsSync(join(workspace, "runtime", "invocation-package.json"))).toBe(false);
        expect(existsSync(join(workspace, "runtime", "prompt.md"))).toBe(false);
      } finally {
        closeFixture(fixture);
      }
    });
  }

  it("a thrown probe fails closed with the accurate code and never leaks the error", async () => {
    const fixture = openFixture("p5-preflight-probe-throws", {
      preflightScenario: "probe-throws",
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1");

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("AGENT_RUNTIME_UNAVAILABLE");
      expect(row.failure_message).not.toContain("synthetic preflight probe failure");
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);
      const report = readReport(fixture, run.id);
      expect(report.checks.at(-1)).toEqual({ capability: "agent_runtime_available", ok: false });
      expect(JSON.stringify(report)).not.toContain("synthetic preflight probe failure");
    } finally {
      closeFixture(fixture);
    }
  });

  it("marks input_adapter_succeeded false when the adaptation fails after the gate passed", async () => {
    const fixture = openFixture("p5-preflight-adapter-failure", {
      preflightScenario: "all-pass",
      inputAdapterScenario: "adapter-failure"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1");

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("INPUT_ADAPTER_FAILED");
      expect(row.stage).toBeNull();
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);
      const report = readReport(fixture, run.id);
      expect(report.passed).toBe(false);
      // The eight environment checks passed; the ninth item is the failure.
      expect(report.checks).toHaveLength(9);
      expect(report.checks.at(-1)).toEqual({ capability: "input_adapter_succeeded", ok: false });
      expect(report.checks.slice(0, -1).every((check) => check.ok)).toBe(true);
    } finally {
      closeFixture(fixture);
    }
  });

  it("the 0*64 placeholder skill hash never passes the gate (M1)", async () => {
    const fixture = openFixture("p5-preflight-placeholder", {
      preflightScenario: "all-pass",
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const placeholderProfile: RunProfile = {
        ...PROFILE,
        skill: { ...PROFILE.skill, sha256: PLACEHOLDER_SKILL_SHA256 }
      };
      const run = createRun(fixture, "drawing-a", "revision-a1", placeholderProfile);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("SKILL_HASH_MISMATCH");
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);
      const report = readReport(fixture, run.id);
      expect(report.checks.at(-1)).toEqual({ capability: "modeling_skill_hash_allowed", ok: false });
    } finally {
      closeFixture(fixture);
    }
  });

  it("a custom non-placeholder digest never passes the gate (exact allowlist)", async () => {
    const fixture = openFixture("p5-preflight-custom-digest", {
      preflightScenario: "all-pass",
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      // A well-formed 64-hex custom digest that is NOT the fixture digest:
      // only FAKE_PREFLIGHT_SKILL_SHA256 is allowlisted (P5-2 review fix).
      const customProfile: RunProfile = {
        ...PROFILE,
        skill: { ...PROFILE.skill, sha256: `${"a".repeat(63)}b` }
      };
      const run = createRun(fixture, "drawing-a", "revision-a1", customProfile);

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("SKILL_HASH_MISMATCH");
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);
      const report = readReport(fixture, run.id);
      expect(report.checks.at(-1)).toEqual({ capability: "modeling_skill_hash_allowed", ok: false });
    } finally {
      closeFixture(fixture);
    }
  });

  it("a preflight report write failure fails closed with PREFLIGHT_FAILED", async () => {
    const fixture = openFixture("p5-preflight-report-write", {
      preflightScenario: "all-pass",
      inputAdapterScenario: "single-page-pdf",
      failWriteRelativePath: "runtime/preflight-report.json"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1");

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("PREFLIGHT_FAILED");
      expect(row.failure_message).toContain("预检报告");
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);
    } finally {
      closeFixture(fixture);
    }
  });

  it("a throwing custom preflight fails closed with PREFLIGHT_FAILED, no adaptation and no stages", async () => {
    const fixture = openFixture("p5-preflight-gate-throw", {
      preflight: {
        synthetic: true,
        run(): PreflightEnvironmentResult {
          throw new Error("injected gate explosion");
        }
      },
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1");

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("PREFLIGHT_FAILED");
      expect(row.failure_message).not.toContain("injected gate explosion");
      expect(row.stage).toBeNull();
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);

      // The gate ran BEFORE adaptation: no adapter or preparation artifacts.
      const workspace = attemptWorkspacePath(fixture, run.id, 1);
      expect(existsSync(join(workspace, "input", "drawing.png"))).toBe(false);
      expect(existsSync(join(workspace, "input", "adapter-result.json"))).toBe(false);
      expect(existsSync(join(workspace, "runtime", "invocation-package.json"))).toBe(false);
      expect(existsSync(join(workspace, "runtime", "prompt.md"))).toBe(false);

      // Redacted report: no checks, no error content.
      const report = readReport(fixture, run.id);
      expect(report.passed).toBe(false);
      expect(report.checks).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("injected gate explosion");
    } finally {
      closeFixture(fixture);
    }
  });

  it("an internally inconsistent gate result fails closed before adaptation", async () => {
    const fixture = openFixture("p5-preflight-inconsistent", {
      preflight: {
        synthetic: true,
        run(): PreflightEnvironmentResult {
          // ok=false without its failing capability: internally inconsistent.
          return { ok: false, failedCapability: null, checks: [] };
        }
      },
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1");

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("PREFLIGHT_FAILED");
      expect(row.failure_message).toContain("不一致");
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);

      // Inconsistent results are not trusted: no adaptation and no checks in
      // the persisted redacted report.
      const workspace = attemptWorkspacePath(fixture, run.id, 1);
      expect(existsSync(join(workspace, "input", "drawing.png"))).toBe(false);
      expect(existsSync(join(workspace, "runtime", "invocation-package.json"))).toBe(false);
      const report = readReport(fixture, run.id);
      expect(report.passed).toBe(false);
      expect(report.checks).toEqual([]);
    } finally {
      closeFixture(fixture);
    }
  });

  it("a post-gate Invocation Package write failure leaves no misleading passed report", async () => {
    const fixture = openFixture("p5-preflight-package-failure", {
      preflightScenario: "all-pass",
      inputAdapterScenario: "single-page-pdf",
      failWriteRelativePath: "runtime/invocation-package.json"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1");

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("PREFLIGHT_FAILED");
      expect(row.failure_message).toContain("Invocation Package");
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);

      // The passed report is persisted only after the COMPLETE pipeline: the
      // post-gate failure leaves a FAILED report (never a misleading passed
      // one) that truthfully records the successful adaptation.
      const report = readReport(fixture, run.id);
      expect(report.passed).toBe(false);
      expect(report.checks).toHaveLength(9);
      expect(report.checks.at(-1)).toEqual({ capability: "input_adapter_succeeded", ok: true });
      expect(report.checks.slice(0, -1).every((check) => check.ok)).toBe(true);

      // The adapter ran (its artifacts exist), but the pipeline stopped at the
      // Invocation Package write: no package, no prompt.
      const workspace = attemptWorkspacePath(fixture, run.id, 1);
      expect(existsSync(join(workspace, "input", "drawing.png"))).toBe(true);
      expect(existsSync(join(workspace, "input", "adapter-result.json"))).toBe(true);
      expect(existsSync(join(workspace, "runtime", "invocation-package.json"))).toBe(false);
      expect(existsSync(join(workspace, "runtime", "prompt.md"))).toBe(false);
    } finally {
      closeFixture(fixture);
    }
  });

  it("rejects a preflight gate without an input adapter at construction", () => {
    const dir = makeTempDir("p5-preflight-no-adapter");
    try {
      const db = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db"), busyTimeoutMs: 5_000 });
      db.open();
      const store = new SqliteRepository(db);
      const runs = new RunRepository(db, store);
      const scheduler = new ManualScheduler(Date.parse(T0));
      const orchestrator = new RunOrchestrator(db, runs, { now: scheduler.now });
      const workspace = new RunWorkspaceLedger({ workspaceRoot: join(dir, "workspaces") });
      workspace.open();
      try {
        expect(
          () =>
            new FakeExecutor({
              orchestrator,
              runs,
              workspace,
              scenario: "success",
              scheduler,
              preflightScenario: "all-pass"
            })
        ).toThrow(InvalidArgumentError);
      } finally {
        workspace.close();
        db.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("Phase 5 Batch D real preflight gate at PREPARING (RealPreflightProbe)", () => {
  const REAL_SKILL_NAME = "solidworks-build-part-from-drawing";

  function realProbeGate(skillDir: string, overrides: { runtimeVersion?: string } = {}) {
    return new PreflightGate(
      new RealPreflightProbe({
        skillRootPath: skillDir,
        expectedRuntimeVersion: "0.147.0",
        runtime: {
          probe: () => ({
            available: true,
            version: overrides.runtimeVersion ?? "0.147.0",
            protocol: "2",
            modelImageInputSupported: true
          })
        },
        solidworks: { probe: () => ({ available: true, version: "2022" }) }
      })
    );
  }

  function realProfile(skillDir: string): RunProfile {
    return {
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      skill: { name: REAL_SKILL_NAME, sha256: hashSkillDirectory(skillDir) },
      agentConfigId: "codex-app-server"
    };
  }

  it("a real probe with a matching skill tree completes the Run and persists a synthetic:false nine-item report", async () => {
    const skillDir = makeTempDir("p5-real-skill");
    writeFileSync(join(skillDir, "SKILL.md"), "# solidworks-build-part-from-drawing\n", "utf8");
    writeFileSync(join(skillDir, "capabilities.yaml"), "name: solidworks-build-part-from-drawing\n", "utf8");
    const fixture = openFixture("p5-real-pass", {
      preflight: realProbeGate(skillDir),
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1", realProfile(skillDir));

      await runToCompletion(fixture);

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      const report = readReport(fixture, run.id);
      expect(report.passed).toBe(true);
      expect(report.synthetic).toBe(false);
      expect(report.checks.map((check) => check.capability)).toEqual(PREFLIGHT_CAPABILITIES);
      expect(report.checks.every((check) => check.ok)).toBe(true);
    } finally {
      closeFixture(fixture);
      removeTempDir(skillDir);
    }
  });

  it("a drifted skill tree fails the frozen hash with SKILL_HASH_MISMATCH (real hash gate)", async () => {
    const skillDir = makeTempDir("p5-real-drift");
    writeFileSync(join(skillDir, "SKILL.md"), "# solidworks-build-part-from-drawing\n", "utf8");
    const fixture = openFixture("p5-real-drift", {
      preflight: realProbeGate(skillDir),
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      // The frozen snapshot pins the CURRENT digest...
      const run = createRun(fixture, "drawing-a", "revision-a1", realProfile(skillDir));
      // ...then the skill tree drifts before the gate runs.
      writeFileSync(join(skillDir, "SKILL.md"), "# drift\n", "utf8");

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("SKILL_HASH_MISMATCH");
      const report = readReport(fixture, run.id);
      expect(report.synthetic).toBe(false);
      expect(report.checks.at(-1)).toEqual({ capability: "modeling_skill_hash_allowed", ok: false });
      expect(report.checks.slice(0, -1).every((check) => check.ok)).toBe(true);
    } finally {
      closeFixture(fixture);
      removeTempDir(skillDir);
    }
  });

  it("a runtime version mismatch fails closed with AGENT_RUNTIME_UNAVAILABLE (pinned 0.147.0)", async () => {
    const skillDir = makeTempDir("p5-real-version");
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\n", "utf8");
    const fixture = openFixture("p5-real-version", {
      preflight: realProbeGate(skillDir, { runtimeVersion: "0.148.0" }),
      inputAdapterScenario: "single-page-pdf"
    });
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = createRun(fixture, "drawing-a", "revision-a1", realProfile(skillDir));

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("AGENT_RUNTIME_UNAVAILABLE");
      const report = readReport(fixture, run.id);
      expect(report.synthetic).toBe(false);
      expect(report.checks.at(-1)).toEqual({
        capability: "agent_runtime_version_supported",
        ok: false
      });
    } finally {
      closeFixture(fixture);
      removeTempDir(skillDir);
    }
  });
});
