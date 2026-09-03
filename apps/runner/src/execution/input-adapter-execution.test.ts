import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  Drawing,
  DrawingRevision,
  InputAdapterScenario,
  InputAdapterSourceRef,
  RevisionSourceFile
} from "@swpanel/domain";
import {
  validateInputAdapterResult,
  validateInvocationPackage
} from "@swpanel/contracts";
import { makeTempDir, removeTempDir, samplePdfBytes } from "../test-utils.js";
import { SqliteDatabase } from "../db/database.js";
import { SqliteRepository } from "../db/repository.js";
import { RunRepository, type RunProfile } from "../db/run-repository.js";
import { RunOrchestrator } from "../orchestration/run-orchestrator.js";
import { RunWorkspaceLedger } from "../ledger/run-workspace-ledger.js";
import { FakeExecutor, type ExecutorScheduler, type ScheduledTask } from "./fake-executor.js";
import { PROMPT_TEMPLATE_VERSION } from "../adaptation/prompt-template.js";
import { TEST_ONLY_INPUT_ADAPTER_ID } from "../adaptation/input-adapter.js";

const T0 = "2026-08-13T09:00:00.000Z";

const PROFILE: RunProfile = {
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  skill: { name: "solidworks-build-part-from-drawing", sha256: "b".repeat(64) },
  agentConfigId: "agent-config-1"
};

/** Minimal deterministic scheduler (same idiom as fake-executor.test.ts). */
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

  /** True when at least one DUE task (delay elapsed) is pending. */
  hasPending(): boolean {
    return this.tasks.some((task) => !task.cancelled && task.at <= this.currentMs);
  }

  drain(): void {
    while (this.due()) {
      this.flushOne();
    }
  }
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

function openFixture(
  prefix: string,
  inputAdapterScenario: InputAdapterScenario
): Fixture {
  const dir = makeTempDir(prefix);
  const dbPath = join(dir, "state", "swpanel.db");
  const db = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  const runs = new RunRepository(db, store);
  const scheduler = new ManualScheduler(Date.parse(T0));
  const orchestrator = new RunOrchestrator(db, runs, { now: scheduler.now });
  const workspace = new RunWorkspaceLedger({ workspaceRoot: join(dir, "workspaces") });
  workspace.open();
  const executor = new FakeExecutor({
    orchestrator,
    runs,
    workspace,
    scenario: "success",
    scheduler,
    now: scheduler.now,
    cooperativeStopTimeoutMs: 1_000,
    // The deterministic Input Adapter runs at PREPARING (P4-1).
    inputAdapterScenario,
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
  return { dir, dbPath, db, store, runs, scheduler, workspace, executor };
}

function closeFixture(fixture: Fixture): void {
  if (fixture.db.isOpen) fixture.db.close();
  removeTempDir(fixture.dir);
}

/**
 * Seeds a Drawing + Revision whose immutable source file really exists at the
 * ledger-relative path under the fixture root (the resolver verifies reads).
 */
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

describe("Phase 4 P4-1/P4-2 input preparation at PREPARING", () => {
  it("adapts the immutable source at PREPARING and writes provenance, Invocation Package and prompt into the attempt workspace", async () => {
    const fixture = openFixture("p4-prepare-success", "single-page-pdf");
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      const originalBytes = writeSourceFile(fixture, sourceFile);
      const run = fixture.runs.createRun({
        drawingId: "drawing-a",
        revisionId: "revision-a1",
        profile: PROFILE,
        createdAt: T0
      });

      await runToCompletion(fixture);

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      const workspace = attemptWorkspacePath(fixture, run.id, 1);
      expect(existsSync(join(workspace, "input", "drawing.png"))).toBe(true);
      expect(existsSync(join(workspace, "input", "preview.png"))).toBe(true);
      expect(existsSync(join(workspace, "runtime", "invocation-package.json"))).toBe(true);
      expect(existsSync(join(workspace, "runtime", "prompt.md"))).toBe(true);

      // The persisted adapter envelope is strictly contract-valid and records
      // the conversion provenance of the ORIGINAL file. The fake never
      // inspects the source, so the default PDF path records no invented page
      // selection and never claims production verification (M1/M2).
      const envelope: unknown = JSON.parse(
        readFileSync(join(workspace, "input", "adapter-result.json"), "utf8")
      );
      const validated = validateInputAdapterResult(envelope);
      expect(validated.ok).toBe(true);
      if (validated.ok) {
        expect(validated.provenance.sourceFileSha256).toBe(sourceFile.sha256);
        expect(validated.provenance.pageSelection).toBeUndefined();
        expect(validated.provenance.productionVerified).toBe(false);
        expect(validated.provenance.warnings.join(" ")).toContain(
          "synthetic conversion, not production-verified"
        );
        expect(validated.provenance.output.relativePath).toBe("input/drawing.png");
      }

      // The Invocation Package is generated from the frozen snapshot + adapter
      // provenance + workspace and is strictly contract-valid.
      const pkg: unknown = JSON.parse(
        readFileSync(join(workspace, "runtime", "invocation-package.json"), "utf8")
      );
      const validatedPkg = validateInvocationPackage(pkg);
      expect(validatedPkg.runId).toBe(run.id);
      expect(validatedPkg.input.originalArtifactId).toBe(sourceFile.relativePath);
      expect(validatedPkg.input.imagePath).toBe("input/drawing.png");
      expect(validatedPkg.input.imageSha256).toBe(
        validated.ok ? validated.provenance.output.sha256 : ""
      );
      expect(validatedPkg.skill).toEqual(PROFILE.skill);
      expect(validatedPkg.workspace.output).toBe(join(workspace, "output"));
      expect(validatedPkg.execution).toEqual({ visibility: "visible", recordMp4: false });

      // The rendered prompt carries the controlled template version + run id
      // and truthfully exposes the synthetic, unverified conversion (no page
      // selection line, productionVerified: false).
      const prompt = readFileSync(join(workspace, "runtime", "prompt.md"), "utf8");
      expect(prompt).toContain(`Template ${PROMPT_TEMPLATE_VERSION}`);
      expect(prompt).toContain(run.id);
      expect(prompt).toContain("input/drawing.png");
      expect(prompt).toContain("productionVerified: false");
      expect(prompt).not.toContain("page selection:");

      // The ORIGINAL drawing file was never modified by the adapter.
      expect(readFileSync(join(fixture.dir, ...sourceFile.relativePath.split("/")))).toEqual(
        originalBytes
      );
    } finally {
      closeFixture(fixture);
    }
  });

  it("fails the Run closed when the adapter conversion fails, with no stage events", async () => {
    const fixture = openFixture("p4-prepare-failure", "adapter-failure");
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = fixture.runs.createRun({
        drawingId: "drawing-a",
        revisionId: "revision-a1",
        profile: PROFILE,
        createdAt: T0
      });

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("INPUT_ADAPTER_FAILED");
      expect(row.stage).toBeNull();
      expect(eventTypes(fixture, run.id)).toEqual(["Failed"]);
      const attempt = fixture.db
        .prepare("SELECT status, interruption_kind FROM run_attempts WHERE run_id = ?")
        .get(run.id) as { status: string; interruption_kind: string | null };
      expect(attempt).toMatchObject({ status: "INTERRUPTED", interruption_kind: "UNEXPECTED_INTERRUPTION" });
    } finally {
      closeFixture(fixture);
    }
  });

  it("fails closed for a multi-page PDF without an explicit page selection", async () => {
    const fixture = openFixture("p4-prepare-multipage", "multi-page-pdf-no-page-selected");
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = fixture.runs.createRun({
        drawingId: "drawing-a",
        revisionId: "revision-a1",
        profile: PROFILE,
        createdAt: T0
      });

      await runToCompletion(fixture);

      const row = runRow(fixture, run.id);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("INPUT_ADAPTER_FAILED");
      expect(row.failure_message).toContain("PAGE_SELECTION_REQUIRED");
    } finally {
      closeFixture(fixture);
    }
  });

  it("marks the synthetic DWG/DXF conversion test-only in the persisted provenance", async () => {
    const fixture = openFixture("p4-prepare-dwgdxf", "dwg-dxf-synthetic-test-only");
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      writeSourceFile(fixture, sourceFile);
      const run = fixture.runs.createRun({
        drawingId: "drawing-a",
        revisionId: "revision-a1",
        profile: PROFILE,
        createdAt: T0
      });

      await runToCompletion(fixture);

      expect(runRow(fixture, run.id).status).toBe("COMPLETED");
      const envelope: unknown = JSON.parse(
        readFileSync(
          join(attemptWorkspacePath(fixture, run.id, 1), "input", "adapter-result.json"),
          "utf8"
        )
      );
      const validated = validateInputAdapterResult(envelope);
      expect(validated.ok).toBe(true);
      if (validated.ok) {
        expect(validated.provenance.adapterId).toBe(TEST_ONLY_INPUT_ADAPTER_ID);
        expect(validated.provenance.productionVerified).toBe(false);
        expect(validated.provenance.warnings.join(" ")).toContain("synthetic conversion");
      }
    } finally {
      closeFixture(fixture);
    }
  });

  it("fails closed when the frozen snapshot's source cannot be resolved", async () => {
    const fixture = openFixture("p4-prepare-unresolvable", "single-page-pdf");
    try {
      // A QUEUED Run whose snapshot references a Revision that does not exist:
      // the resolver returns null and the attempt fails closed at PREPARING.
      const runId = "run-unresolvable";
      fixture.db.transaction(() => {
        fixture.db
          .prepare(
            "INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) " +
              "VALUES (?, 'R01', 'drawing-missing', 'revision-missing', 'QUEUED', ?)"
          )
          .run(runId, T0);
        fixture.db
          .prepare("INSERT INTO run_input_snapshots (run_id, payload_json) VALUES (?, ?)")
          .run(
            runId,
            JSON.stringify({
              drawingId: "drawing-missing",
              revisionId: "revision-missing",
              originalFileRef: "library/drawings/file-missing/source/original.pdf",
              revisionFacts: [],
              modelingFeedback: [],
              promptTemplateVersion: PROFILE.promptTemplateVersion,
              skill: PROFILE.skill,
              agentConfigId: PROFILE.agentConfigId,
              createdAt: T0
            })
          );
      });

      await runToCompletion(fixture);

      const row = runRow(fixture, runId);
      expect(row.status).toBe("FAILED");
      expect(row.failure_code).toBe("INPUT_ADAPTER_FAILED");
      expect(eventTypes(fixture, runId)).toEqual(["Failed"]);
    } finally {
      closeFixture(fixture);
    }
  });

  it("never touches the original file when the adapter fails", async () => {
    const fixture = openFixture("p4-prepare-preserve", "adapter-failure");
    try {
      const { sourceFile } = seedSourceRevision(fixture, "drawing-a", "revision-a1");
      const originalBytes = writeSourceFile(fixture, sourceFile);
      const run = fixture.runs.createRun({
        drawingId: "drawing-a",
        revisionId: "revision-a1",
        profile: PROFILE,
        createdAt: T0
      });

      await runToCompletion(fixture);

      expect(runRow(fixture, run.id).status).toBe("FAILED");
      expect(readFileSync(join(fixture.dir, ...sourceFile.relativePath.split("/")))).toEqual(
        originalBytes
      );
    } finally {
      closeFixture(fixture);
    }
  });
});
