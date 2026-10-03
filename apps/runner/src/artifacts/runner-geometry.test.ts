import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Runner } from "../runner.js";
import { SqliteDatabase } from "../db/database.js";
import { RunWorkspaceLedger } from "../ledger/run-workspace-ledger.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";

describe("Runner measured geometry", () => {
  it("reads measured geometry independently of industrial verification and rejects mismatched validation", () => {
    const root = makeTempDir("runner-geometry");
    const runner = new Runner(root); runner.open();
    const db = new SqliteDatabase({ dbPath: join(root, "state", "swpanel.db") }); db.open();
    const ledger = new RunWorkspaceLedger({ workspaceRoot: join(root, "workspaces") }); ledger.open();
    try {
      const sourcePath = join(root, "original.pdf"); writeFileSync(sourcePath, "%PDF-1.4 test");
      const { drawing, revision } = runner.importDrawing({ drawingNumber: "GEO-1", name: "Geometry test", sourceFile: { sourcePath, fileName: "test.pdf", format: "PDF", uploadedAt: "2026-08-18T01:00:00.000Z" }, createdAt: "2026-08-18T01:00:00.000Z" });
      const run = runner.createRun({ drawingId: drawing.id, revisionId: revision.id });
      ledger.createAttemptWorkspace(run.id, 1);
      const writeLog = (version: string) => ledger.writeOwnedFile({ runId: run.id, attemptSequence: 1, relativePath: "output/build-validation.json", content: Buffer.from(JSON.stringify({ solidWorksVersion: version, rebuildStatus: "PASSED", geometry: { schemaVersion: 1, source: "solidworks-mass-properties", volume: { value: 1000000, unit: "mm3" } } })) });
      const file = writeLog("2026");
      db.prepare("INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at, production_verified, validation_summary_json) VALUES ('model-geo','M01',?,?,?,'PENDING_REVIEW','2026-08-18T01:00:00.000Z',0,?)").run(drawing.id, revision.id, run.id, JSON.stringify({ solidWorksVersion: "2026", units: "mm", projectionDecision: "first-angle", featureCount: 1, bodyCount: 1, rebuildStatus: "PASSED", unresolvedAssumptions: [] }));
      db.prepare("INSERT INTO artifacts (id, run_id, model_id, kind, file_name, relative_path, size_bytes, sha256, created_at) VALUES ('geometry-log',?,'model-geo','BUILD_VALIDATION_LOG','build-validation.json',?,?,?,'2026-08-18T01:00:00.000Z')").run(run.id, file.relativePath, file.sizeBytes, file.sha256);
      expect(runner.getModelDetail("model-geo").model.productionVerified).toBe(false);
      expect(runner.getModelGeometry("model-geo")).toEqual({ finishedVolumeM3: 0.001, boundingBoxMm: null, sourceArtifactId: "geometry-log" });
      const mismatch = writeLog("2025");
      db.prepare("UPDATE artifacts SET size_bytes=?,sha256=? WHERE id='geometry-log'").run(mismatch.sizeBytes, mismatch.sha256);
      expect(runner.getModelGeometry("model-geo")).toBeNull();
      writeLog("2026"); // Changed bytes without metadata registration remain unavailable.
      expect(runner.getModelGeometry("model-geo")).toBeNull();
    } finally { ledger.close(); db.close(); runner.close(); removeTempDir(root); }
  });
});
