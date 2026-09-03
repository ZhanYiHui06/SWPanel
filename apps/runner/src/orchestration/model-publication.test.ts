import { describe, expect, it } from "vitest";
import { join } from "node:path";

import type { Drawing, DrawingRevision, RevisionSourceFile } from "@swpanel/domain";
import { RunnerInvariantError } from "../errors.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";
import { SqliteDatabase } from "../db/database.js";
import { SqliteRepository } from "../db/repository.js";
import { RunRepository, type RunProfile } from "../db/run-repository.js";
import { RunWorkspaceLedger } from "../ledger/run-workspace-ledger.js";
import {
  ArtifactValidator,
  type ArtifactValidationSuccess
} from "../artifacts/artifact-validator.js";
import { produceSyntheticResultArtifactSet } from "../artifacts/result-artifact-set.js";
import { RunOrchestrator, type RunClaim } from "./run-orchestrator.js";

const T0 = "2026-08-13T09:00:00.000Z";
const T1 = "2026-08-13T09:01:00.000Z";

const PROFILE: RunProfile = {
  promptTemplateVersion: "prompt-template-v3",
  skill: { name: "solidworks-build-part-from-drawing", sha256: "b".repeat(64) },
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
  workspace: RunWorkspaceLedger;
  validator: ArtifactValidator;
  clock: ReturnType<typeof makeClock>;
}

function openFixture(prefix: string): Fixture {
  const dir = makeTempDir(prefix);
  const dbPath = join(dir, "state", "swpanel.db");
  const db = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  const runs = new RunRepository(db, store);
  const clock = makeClock(Date.parse(T0));
  const orchestrator = new RunOrchestrator(db, runs, { now: clock.now });
  const workspace = new RunWorkspaceLedger({ workspaceRoot: join(dir, "workspaces") });
  workspace.open();
  const validator = new ArtifactValidator(workspace, { now: clock.now });
  return { dir, dbPath, db, store, runs, orchestrator, workspace, validator, clock };
}

function closeFixture(fixture: Fixture): void {
  if (fixture.db.isOpen) fixture.db.close();
  fixture.workspace.close();
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

/** Claims the next QUEUED Run of the fixture and returns it with the claim. */
function claimNextRun(fixture: Fixture): { runId: string; claim: RunClaim } {
  const run = fixture.runs.createRun({
    drawingId: "drawing-a",
    revisionId: "revision-a1",
    profile: PROFILE,
    createdAt: T0
  });
  fixture.clock.set(T1);
  const claim = fixture.orchestrator.claimNextQueuedRun();
  if (claim === null) throw new Error("expected a claim");
  expect(claim.runId).toBe(run.id);
  return { runId: run.id, claim };
}

/**
 * Produces the deterministic synthetic artifact set + Result Manifest inside
 * the attempt workspace and returns the STRICTLY validated success outcome the
 * publication transaction consumes — the same data flow as the executor's
 * Phase 5 success path.
 */
function validatedSet(
  fixture: Fixture,
  runId: string,
  attemptSequence: number,
  recordMp4 = false
): ArtifactValidationSuccess {
  const set = produceSyntheticResultArtifactSet({
    runId,
    attemptSequence,
    recordMp4,
    solidWorksVersion: "2025",
    adapterId: "codex-app-server",
    adapterVersion: "0.1.0"
  });
  for (const file of set.files) {
    fixture.workspace.writeOwnedFile({
      runId,
      attemptSequence,
      relativePath: file.relativePath,
      content: file.content
    });
  }
  const outcome = fixture.validator.validate({
    runId,
    attemptSequence,
    manifestRef: set.manifestRef,
    recordMp4Required: recordMp4
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`expected a validated set, got ${outcome.issue.code}`);
  return outcome;
}

function modelCount(fixture: Fixture): number {
  const row = fixture.db.prepare("SELECT COUNT(*) AS count FROM models").get() as { count: number };
  return row.count;
}

function artifactCount(fixture: Fixture): number {
  const row = fixture.db.prepare("SELECT COUNT(*) AS count FROM artifacts").get() as {
    count: number;
  };
  return row.count;
}

describe("RunOrchestrator model publication (Phase 5, P5-2)", () => {
  it("publishes a PENDING_REVIEW Model atomically and the Completed modelId resolves", () => {
    const fixture = openFixture("publish-success");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      const validation = validatedSet(fixture, runId, claim.attempt.attemptSequence, false);

      const publication = fixture.orchestrator.publishModelPublication({
        runId,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        validation,
        finishedAt: "2026-08-13T09:02:00.000Z"
      });

      // The published Model: M01, PENDING_REVIEW, bound to the Run/Revision,
      // and truthfully NOT production verified (the synthetic manifest always
      // claims productionVerified false — P5 truthfulness hardening).
      expect(publication.model).toMatchObject({
        number: "M01",
        drawingId: "drawing-a",
        revisionId: "revision-a1",
        runId,
        reviewStatus: "PENDING_REVIEW",
        generatedAt: "2026-08-13T09:02:00.000Z",
        productionVerified: false
      });
      expect(publication.model.artifactIds).toHaveLength(6);
      expect(publication.attempt).toMatchObject({
        id: claim.attempt.id,
        status: "FINISHED",
        finishedAt: "2026-08-13T09:02:00.000Z"
      });

      // The Run read-model resolves the Completed modelId to the Model.
      const detail = fixture.runs.getRunDetail(runId);
      expect(detail.run.status).toBe("COMPLETED");
      expect(detail.run.modelId).toBe(publication.model.id);
      expect(detail.events.at(-1)).toMatchObject({
        type: "Completed",
        modelId: publication.model.id,
        attemptId: claim.attempt.id
      });
      // The stored run row carries the pointer and the attempt is FINISHED.
      const runRow = fixture.db
        .prepare("SELECT status, model_id, completed_at FROM runs WHERE id = ?")
        .get(runId) as { status: string; model_id: string | null; completed_at: string | null };
      expect(runRow).toMatchObject({
        status: "COMPLETED",
        model_id: publication.model.id,
        completed_at: "2026-08-13T09:02:00.000Z"
      });
      const attemptRow = fixture.db
        .prepare("SELECT status, finished_at, interruption_kind FROM run_attempts WHERE id = ?")
        .get(claim.attempt.id) as {
        status: string;
        finished_at: string | null;
        interruption_kind: string | null;
      };
      expect(attemptRow).toMatchObject({
        status: "FINISHED",
        finished_at: "2026-08-13T09:02:00.000Z",
        interruption_kind: null
      });

      // The production-verification claim was persisted from the synthetic
      // manifest: production_verified = 0 on the stored row and false on the
      // read path.
      const stored = fixture.db
        .prepare("SELECT production_verified FROM models WHERE id = ?")
        .get(publication.model.id) as { production_verified: number };
      expect(stored.production_verified).toBe(0);

      // The repository query helper maps the stored row back to the domain
      // shape, including the persisted validation summary.
      const model = fixture.runs.getModel(publication.model.id);
      expect(model).not.toBeNull();
      expect(model).toMatchObject({
        id: publication.model.id,
        number: "M01",
        reviewStatus: "PENDING_REVIEW",
        productionVerified: false,
        validationSummary: {
          solidWorksVersion: validation.manifest.solidWorksVersion,
          units: "mm",
          projectionDecision: "first-angle",
          featureCount: 4,
          bodyCount: 1,
          rebuildStatus: "PASSED",
          unresolvedAssumptions: []
        }
      });
      expect(model?.artifactIds).toHaveLength(6);
      expect(model?.buildReportSummary).toBeUndefined();
    } finally {
      closeFixture(fixture);
    }
  });

  it("persists every declared artifact metadata row bound to the Model and the Run", () => {
    const fixture = openFixture("publish-artifacts");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      const validation = validatedSet(fixture, runId, claim.attempt.attemptSequence, true);

      const publication = fixture.orchestrator.publishModelPublication({
        runId,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        validation,
        buildReportSummary: "deterministic synthetic build report (test only)"
      });
      expect(artifactCount(fixture)).toBe(7);

      const rows = fixture.db
        .prepare("SELECT * FROM artifacts WHERE model_id = ? ORDER BY rowid ASC")
        .all(publication.model.id) as unknown as Array<{
        id: string;
        run_id: string;
        model_id: string;
        kind: string;
        file_name: string;
        relative_path: string;
        size_bytes: number;
        sha256: string;
        mime_type: string | null;
        created_at: string;
      }>;
      expect(rows).toHaveLength(7);
      expect(rows.map((row) => row.kind)).toEqual([
        "SLDPRT",
        "PREVIEW",
        "DIMENSION_LEDGER",
        "FEATURE_PLAN",
        "BUILD_VALIDATION_LOG",
        "BUILDER_SOURCE",
        "PROCESS_MP4"
      ]);
      for (const row of rows) {
        // Every row is bound to the Model AND the Run, stores the canonical
        // workspace-relative path of the verified bytes, the real size/hash,
        // the file name and the deterministic MIME.
        expect(row.model_id).toBe(publication.model.id);
        expect(row.run_id).toBe(runId);
        expect(row.relative_path.startsWith(`runs/${runId}/attempt-001/`)).toBe(true);
        expect(row.size_bytes).toBeGreaterThan(0);
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(row.file_name.length).toBeGreaterThan(0);
        expect(row.mime_type).not.toBeNull();
        expect(row.created_at).toBe("2026-08-13T09:01:00.000Z");
      }
      // The build report summary was persisted on the Model row.
      const model = fixture.runs.getModel(publication.model.id);
      expect(model?.buildReportSummary).toBe("deterministic synthetic build report (test only)");
    } finally {
      closeFixture(fixture);
    }
  });

  it("allocates M01/M02 per revision and restarts numbering across revisions", () => {
    const fixture = openFixture("publish-numbering");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      seedRevision(fixture, "drawing-a", "revision-a2", 2, T1);
      const numbers: string[] = [];
      for (const revisionId of ["revision-a1", "revision-a1", "revision-a2"]) {
        const run = fixture.runs.createRun({
          drawingId: "drawing-a",
          revisionId,
          profile: PROFILE,
          createdAt: T1
        });
        fixture.clock.advance(1_000);
        const claim = fixture.orchestrator.claimNextQueuedRun();
        if (claim === null) throw new Error("expected a claim");
        expect(claim.runId).toBe(run.id);
        const validation = validatedSet(fixture, run.id, claim.attempt.attemptSequence, false);
        const publication = fixture.orchestrator.publishModelPublication({
          runId: run.id,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          validation
        });
        numbers.push(publication.model.number);
      }
      // M01 then M02 on the first revision; the second revision restarts at M01.
      expect(numbers).toEqual(["M01", "M02", "M01"]);
      const rev1Numbers = fixture.db
        .prepare("SELECT number FROM models WHERE revision_id = ? ORDER BY rowid ASC")
        .all("revision-a1") as unknown as Array<{ number: string }>;
      const rev2Numbers = fixture.db
        .prepare("SELECT number FROM models WHERE revision_id = ? ORDER BY rowid ASC")
        .all("revision-a2") as unknown as Array<{ number: string }>;
      expect(rev1Numbers.map((row) => row.number)).toEqual(["M01", "M02"]);
      expect(rev2Numbers.map((row) => row.number)).toEqual(["M01"]);
      expect(modelCount(fixture)).toBe(3);
    } finally {
      closeFixture(fixture);
    }
  });

  it("rolls back every row, event, projection and attempt change when an insert fails", () => {
    const fixture = openFixture("publish-rollback-insert");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      const validation = validatedSet(fixture, runId, claim.attempt.attemptSequence, false);
      // Two declared artifacts resolving to the SAME canonical workspace file:
      // the second artifact insert collides with the unique (run_id,
      // relative_path) index and the whole transaction must roll back.
      const duplicated: ArtifactValidationSuccess = {
        ...validation,
        artifacts: [
          validation.artifacts[0]!,
          { ...validation.artifacts[1]!, relativePath: validation.artifacts[0]!.relativePath }
        ]
      };

      expect(() =>
        fixture.orchestrator.publishModelPublication({
          runId,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          validation: duplicated
        })
      ).toThrowError(/collides with an existing row/);

      // Nothing was published: no Model, no artifact row, no event, the Run
      // stays RUNNING without a model pointer and the attempt stays ACTIVE.
      expect(modelCount(fixture)).toBe(0);
      expect(artifactCount(fixture)).toBe(0);
      expect(fixture.runs.listRunEvents(runId)).toHaveLength(0);
      const runRow = fixture.db
        .prepare("SELECT status, model_id, completed_at FROM runs WHERE id = ?")
        .get(runId) as { status: string; model_id: string | null; completed_at: string | null };
      expect(runRow).toMatchObject({ status: "RUNNING", model_id: null, completed_at: null });
      const attemptRow = fixture.db
        .prepare("SELECT status, finished_at FROM run_attempts WHERE id = ?")
        .get(claim.attempt.id) as { status: string; finished_at: string | null };
      expect(attemptRow).toMatchObject({ status: "ACTIVE", finished_at: null });
    } finally {
      closeFixture(fixture);
    }
  });

  it("rolls back the publication when the terminal event append fails", () => {
    const fixture = openFixture("publish-rollback-event");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      // A wedged state: a COMPLETED Run with a live ACTIVE attempt (the Run
      // read-model is terminal, so the Completed event append must be refused —
      // terminal Runs accept no further events — while the attempt itself is
      // still ACTIVE and passes the ownership check).
      fixture.db.transaction(() => {
        fixture.db
          .prepare(
            "INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at, completed_at) " +
              "VALUES (?, 'R99', 'drawing-a', 'revision-a1', 'COMPLETED', ?, ?)"
          )
          .run("run-terminal", T0, T1);
        fixture.db
          .prepare(
            "INSERT INTO run_attempts " +
              "(id, run_id, attempt_sequence, status, kind, owner_token, created_at) " +
              "VALUES (?, ?, 1, 'ACTIVE', 'EXECUTION', ?, ?)"
          )
          .run("attempt-terminal", "run-terminal", fixture.orchestrator.ownerToken, T0);
      });
      const validation = validatedSet(fixture, "run-terminal", 1, false);

      expect(() =>
        fixture.orchestrator.publishModelPublication({
          runId: "run-terminal",
          attemptId: "attempt-terminal",
          ownerToken: fixture.orchestrator.ownerToken,
          validation
        })
      ).toThrowError(RunnerInvariantError);

      // The Model insert and artifact inserts of the same transaction were
      // rolled back together with the refused event.
      expect(modelCount(fixture)).toBe(0);
      expect(artifactCount(fixture)).toBe(0);
      expect(fixture.runs.listRunEvents("run-terminal")).toHaveLength(0);
      const attemptRow = fixture.db
        .prepare("SELECT status FROM run_attempts WHERE id = ?")
        .get("attempt-terminal") as { status: string };
      expect(attemptRow.status).toBe("ACTIVE");
    } finally {
      closeFixture(fixture);
    }
  });

  it("refuses publication for a foreign owner without any side effect", () => {
    const fixture = openFixture("publish-foreign-owner");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      const validation = validatedSet(fixture, runId, claim.attempt.attemptSequence, false);

      expect(() =>
        fixture.orchestrator.publishModelPublication({
          runId,
          attemptId: claim.attempt.id,
          ownerToken: "another-owner",
          validation
        })
      ).toThrowError(/owned by another token/);
      expect(modelCount(fixture)).toBe(0);
      expect(artifactCount(fixture)).toBe(0);
      expect(fixture.runs.listRunEvents(runId)).toHaveLength(0);
    } finally {
      closeFixture(fixture);
    }
  });

  it("refuses an empty validated artifact set before any write", () => {
    const fixture = openFixture("publish-empty");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      const validation = validatedSet(fixture, runId, claim.attempt.attemptSequence, false);
      expect(() =>
        fixture.orchestrator.publishModelPublication({
          runId,
          attemptId: claim.attempt.id,
          ownerToken: fixture.orchestrator.ownerToken,
          validation: { ...validation, artifacts: [] }
        })
      ).toThrowError(/at least one validated artifact record/);
      expect(modelCount(fixture)).toBe(0);
      expect(artifactCount(fixture)).toBe(0);
    } finally {
      closeFixture(fixture);
    }
  });

  it("normalizes null/undefined/empty build report summaries to no summary", () => {
    const fixture = openFixture("publish-build-report");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      const validation = validatedSet(fixture, runId, claim.attempt.attemptSequence, false);

      // An empty-string summary is normalized away: persisted NULL, domain
      // field omitted — identical to not passing one at all.
      const publication = fixture.orchestrator.publishModelPublication({
        runId,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        validation,
        buildReportSummary: ""
      });
      expect(publication.model.buildReportSummary).toBeUndefined();
      const stored = fixture.db
        .prepare("SELECT build_report_summary FROM models WHERE id = ?")
        .get(publication.model.id) as { build_report_summary: string | null };
      expect(stored.build_report_summary).toBeNull();
      expect(fixture.runs.getModel(publication.model.id)?.buildReportSummary).toBeUndefined();
    } finally {
      closeFixture(fixture);
    }
  });

  it("rejects a productionVerified true claim and publishes no Model (fail closed, M3)", () => {
    const fixture = openFixture("publish-production-verified-unsupported");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      // Rewrite the synthetic manifest document with a contract-valid
      // productionVerified: true claim BEFORE the independent validator reads
      // it, so the whole strict path (manifest document -> validator ->
      // publisher) is exercised — never the fake adapter itself.
      const set = produceSyntheticResultArtifactSet({
        runId,
        attemptSequence: claim.attempt.attemptSequence,
        recordMp4: false,
        solidWorksVersion: "2025",
        adapterId: "codex-app-server",
        adapterVersion: "0.1.0"
      });
      for (const file of set.files) {
        fixture.workspace.writeOwnedFile({
          runId,
          attemptSequence: claim.attempt.attemptSequence,
          relativePath: file.relativePath,
          content: file.content
        });
      }
      fixture.workspace.writeOwnedFile({
        runId,
        attemptSequence: claim.attempt.attemptSequence,
        relativePath: set.manifestRef,
        content: Buffer.from(
          JSON.stringify({ ...set.manifest, productionVerified: true }, null, 2) + "\n",
          "utf8"
        )
      });
      // The Agent manifest claim is NEVER authoritative: no independent
      // production/HIL verification record exists, so the independent
      // validator rejects the unsupported true claim with the stable manifest
      // failure code — it never reaches the publication transaction.
      const outcome = fixture.validator.validate({
        runId,
        attemptSequence: claim.attempt.attemptSequence,
        manifestRef: set.manifestRef,
        recordMp4Required: false
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a rejection, but the validator accepted the set");
      expect(outcome.issue).toMatchObject({
        code: "ARTIFACT_MANIFEST_INVALID",
        message: expect.stringContaining("productionVerified") as string
      });

      // Proof that NO Model is published from the unsupported true claim: no
      // Model row, no artifact row, no event; the Run stays RUNNING without a
      // model pointer and the attempt stays ACTIVE — the atomic publication
      // transaction never ran.
      expect(modelCount(fixture)).toBe(0);
      expect(artifactCount(fixture)).toBe(0);
      expect(fixture.runs.listRunEvents(runId)).toHaveLength(0);
      const runRow = fixture.db
        .prepare("SELECT status, model_id, completed_at FROM runs WHERE id = ?")
        .get(runId) as { status: string; model_id: string | null; completed_at: string | null };
      expect(runRow).toMatchObject({ status: "RUNNING", model_id: null, completed_at: null });
      const attemptRow = fixture.db
        .prepare("SELECT status, finished_at FROM run_attempts WHERE id = ?")
        .get(claim.attempt.id) as { status: string; finished_at: string | null };
      expect(attemptRow).toMatchObject({ status: "ACTIVE", finished_at: null });
    } finally {
      closeFixture(fixture);
    }
  });

  it("normalizes a manifest without a productionVerified claim to false on publish", () => {
    const fixture = openFixture("publish-production-verified-default");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      const set = produceSyntheticResultArtifactSet({
        runId,
        attemptSequence: claim.attempt.attemptSequence,
        recordMp4: false,
        solidWorksVersion: "2025",
        adapterId: "codex-app-server",
        adapterVersion: "0.1.0"
      });
      for (const file of set.files) {
        fixture.workspace.writeOwnedFile({
          runId,
          attemptSequence: claim.attempt.attemptSequence,
          relativePath: file.relativePath,
          content: file.content
        });
      }
      // Strip the claim: an absent productionVerified must normalize to false.
      const { productionVerified: _omitted, ...withoutClaim } = set.manifest;
      void _omitted;
      fixture.workspace.writeOwnedFile({
        runId,
        attemptSequence: claim.attempt.attemptSequence,
        relativePath: set.manifestRef,
        content: Buffer.from(JSON.stringify(withoutClaim, null, 2) + "\n", "utf8")
      });
      const outcome = fixture.validator.validate({
        runId,
        attemptSequence: claim.attempt.attemptSequence,
        manifestRef: set.manifestRef,
        recordMp4Required: false
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`expected a validated set, got ${outcome.issue.code}`);
      expect(outcome.manifest.productionVerified).toBe(false);

      const publication = fixture.orchestrator.publishModelPublication({
        runId,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        validation: outcome
      });
      expect(publication.model.productionVerified).toBe(false);
      const stored = fixture.db
        .prepare("SELECT production_verified FROM models WHERE id = ?")
        .get(publication.model.id) as { production_verified: number };
      expect(stored.production_verified).toBe(0);
    } finally {
      closeFixture(fixture);
    }
  });

  it("fails truthfully when the persisted validation summary is unparsable or malformed", () => {
    const fixture = openFixture("publish-bad-summary");
    try {
      seedRevision(fixture, "drawing-a", "revision-a1", 1, T0);
      const { runId, claim } = claimNextRun(fixture);
      const validation = validatedSet(fixture, runId, claim.attempt.attemptSequence, false);
      const publication = fixture.orchestrator.publishModelPublication({
        runId,
        attemptId: claim.attempt.id,
        ownerToken: fixture.orchestrator.ownerToken,
        validation
      });
      const modelId = publication.model.id;
      const updateSummary = fixture.db.prepare(
        "UPDATE models SET validation_summary_json = ? WHERE id = ?"
      );
      // Unparsable JSON fails truthfully.
      updateSummary.run("{not json", modelId);
      expect(() => fixture.runs.getModel(modelId)).toThrowError(RunnerInvariantError);
      // Parsable JSON that is not the domain shape fails truthfully.
      updateSummary.run(JSON.stringify({ solidWorksVersion: "2022", featureCount: "many" }), modelId);
      expect(() => fixture.runs.getModel(modelId)).toThrowError(RunnerInvariantError);
      // Domain-shaped but illegal values (non-positive count, unknown rebuild
      // status) fail truthfully instead of surfacing an unvalidated structure.
      updateSummary.run(JSON.stringify({ ...validation.manifest, featureCount: 0 }), modelId);
      expect(() => fixture.runs.getModel(modelId)).toThrowError(RunnerInvariantError);
      updateSummary.run(JSON.stringify({ ...validation.manifest, rebuildStatus: "MAYBE" }), modelId);
      expect(() => fixture.runs.getModel(modelId)).toThrowError(RunnerInvariantError);
    } finally {
      closeFixture(fixture);
    }
  });
});
