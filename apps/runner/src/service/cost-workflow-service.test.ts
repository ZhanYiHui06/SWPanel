import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { CostDataSnapshot, CostEstimateInputSnapshot } from "@swpanel/domain";

import { SqliteDatabase } from "../db/database.js";
import { SqliteRepository } from "../db/repository.js";
import { RunRepository } from "../db/run-repository.js";
import { CostWorkflowService } from "./cost-workflow-service.js";
import { DrawingWorkflowService } from "./drawing-workflow-service.js";
import { DrawingFileLedger } from "../ledger/drawing-file-ledger.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";
import { NotFoundError } from "../errors.js";
import { writeFileSync, mkdirSync } from "node:fs";

describe("CostWorkflowService", () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: SqliteRepository;
  let runs: RunRepository;
  let ledger: DrawingFileLedger;
  let drawingService: DrawingWorkflowService;
  let costService: CostWorkflowService;

  beforeAll(() => {
    dir = makeTempDir("cost-workflow");
    db = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db") });
    db.open();
    repo = new SqliteRepository(db);
    runs = new RunRepository(db, repo);
    ledger = new DrawingFileLedger({ dataRoot: dir });
    ledger.open();
    drawingService = new DrawingWorkflowService(repo, ledger, runs);
    // Explicit test-only geometry seam; synthetic DB fixtures contain no CAD bytes.
    costService = new CostWorkflowService(repo, runs, () => ({
      finishedVolumeM3: 0.031, boundingBoxMm: null, sourceArtifactId: "test-geometry"
    }));
  });

  afterAll(() => {
    ledger.close();
    db.close();
    removeTempDir(dir);
  });

  it("reads and updates company-global cost data basis", () => {
    const initial = costService.getEffectiveCostData();
    expect(initial.materials.length).toBeGreaterThanOrEqual(3);
    expect(initial.materials.some((m) => m.name === "42CrMo")).toBe(true);

    const updatedSnapshot: CostDataSnapshot = {
      materials: [
        {
          id: "mat-custom",
          name: "Titanium Gr5",
          purchasePrice: 180000,
          priceUnit: "元/吨",
          density: 4.43,
          densityUnit: "g/cm³",
          effectiveFrom: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z"
        }
      ],
      allowances: initial.allowances,
      fixedCosts: initial.fixedCosts,
      customFields: initial.customFields,
      capturedAt: "2026-08-18T00:00:00.000Z"
    };

    const result = costService.updateCostData(updatedSnapshot);
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]!.name).toBe("Titanium Gr5");

    const readBack = costService.getEffectiveCostData();
    expect(readBack.materials[0]!.name).toBe("Titanium Gr5");
  });

  it("creates cost reports, computes deterministic results and isolates historical snapshots", () => {
    // 1. Create a drawing and revision
    const sourceDir = join(dir, "sources");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "test.pdf");
    writeFileSync(sourcePath, "%PDF-1.4 test");

    const { drawing, revision } = drawingService.importDrawing({
      drawingNumber: "DWG-COST-001",
      name: "Cost Test Part",
      sourceFile: {
        sourcePath,
        fileName: "test.pdf",
        format: "PDF",
        uploadedAt: "2026-08-18T01:00:00.000Z"
      },
      createdAt: "2026-08-18T01:00:00.000Z"
    });

    // 2. Create Run and Model
    const run = runs.createRun({
      drawingId: drawing.id,
      revisionId: revision.id,
      createdAt: "2026-08-18T01:01:00.000Z",
      profile: {
        promptTemplateVersion: "2026.08-p5",
        skill: { name: "test", sha256: "0".repeat(64) },
        agentConfigId: "codex"
      }
    });

    db.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
        "VALUES (?, 'M01', ?, ?, ?, 'PENDING_REVIEW', ?)"
    ).run(
      "model-cost-test-1",
      drawing.id,
      revision.id,
      run.id,
      "2026-08-18T01:02:00.000Z"
    );
    const model = { id: "model-cost-test-1" };

    // Attempting to generate cost report before model is approved must fail
    const costData = costService.getEffectiveCostData();
    const input: CostEstimateInputSnapshot = {
      drawingId: drawing.id,
      revisionId: revision.id,
      modelId: model.id,
      quantity: 5,
      materialId: costData.materials[0]!.id,
      stockType: "CYLINDER",
      stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031,
      allowances: [
        { name: "直径方向默认余量", valueMm: 20 },
        { name: "长度方向默认余量", valueMm: 20 }
      ],
      costData,
      formulaVersion: "2026.08-p7",
      capturedAt: "2026-08-18T01:03:00.000Z"
    };

    expect(() => costService.createCostReport(input, "2026-08-18T01:03:00.000Z")).toThrowError(
      /not eligible/
    );

    // Approve the model
    runs.reviewModel({
      modelId: model.id,
      result: "APPROVED",
      reviewerId: "user-alice",
      reviewedAt: "2026-08-18T01:04:00.000Z"
    });

    // Generate Q01 report
    costService.updateCostData({ ...costData, materials: costData.materials.map((material) =>
      material.id === input.materialId ? { ...material, density: Number.MAX_VALUE, purchasePrice: Number.MAX_VALUE } : material) });
    expect(() => costService.createCostReport(input, "2026-08-18T01:05:00.000Z")).toThrow(/overflowed/);
    expect(costService.listCostReportsByRevision(drawing.id, revision.id)).toHaveLength(0);
    costService.updateCostData(costData);
    expect(() => new CostWorkflowService(repo, runs).createCostReport(input, "2026-08-18T01:05:00.000Z")).toThrow(/MODEL_GEOMETRY_UNAVAILABLE/);
    const report1 = costService.createCostReport(input, "2026-08-18T01:05:00.000Z");
    expect(report1.label).toBe("Q01");
    expect(report1.quantity).toBe(5);
    expect(report1.result.perPieceCost).toBeGreaterThan(0);
    expect(report1.result.totalCost).toBeGreaterThan(0);
    // Client-supplied geometry, prices and calculation metadata cannot override server evidence.
    const forged = costService.createCostReport({ ...input, finishedVolume: 999,
      costData: { ...costData, materials: [] }, formulaVersion: "forged", capturedAt: "forged" }, "2026-08-18T01:05:01.000Z");
    expect(forged.snapshot.input.finishedVolume).toBe(0.031);
    expect(forged.snapshot.input.costData.materials).toEqual(costData.materials);
    expect(forged.snapshot.input.capturedAt).toBe("2026-08-18T01:05:01.000Z");
    costService.deleteCostReport(forged.costReportId, revision.id);

    // List reports for revision
    const list = costService.listCostReportsByRevision(drawing.id, revision.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("Q01");

    // Modify global cost data (raise material price)
    const modifiedSnapshot: CostDataSnapshot = {
      ...costData,
      materials: [
        {
          ...costData.materials[0]!,
          purchasePrice: 999999,
          updatedAt: "2026-08-18T02:00:00.000Z"
        }
      ],
      capturedAt: "2026-08-18T02:00:00.000Z"
    };
    costService.updateCostData(modifiedSnapshot);

    // Q01 report must retain its historical cost calculation
    const report1Read = costService.getCostReportDetail(report1.costReportId);
    expect(report1Read.result.perPieceCost).toBe(report1.result.perPieceCost);
    expect(report1Read.snapshot.input.costData.materials[0]!.purchasePrice).toBe(180000);

    // Generate Q02 report with new cost data
    const input2: CostEstimateInputSnapshot = {
      ...input,
      costData: costService.getEffectiveCostData(),
      capturedAt: "2026-08-18T02:05:00.000Z"
    };
    const report2 = costService.createCostReport(input2, "2026-08-18T02:05:00.000Z");
    expect(report2.label).toBe("Q02");
    expect(report2.result.perPieceCost).toBeGreaterThan(report1.result.perPieceCost);

    // Deleting Q01 must not overwrite Q02 or reuse a deleted report's identity.
    costService.deleteCostReport(report1.costReportId, revision.id);
    const report3 = costService.createCostReport(input2, "2026-08-18T02:06:00.000Z");
    expect(report3.label).toBe("Q03");
    expect(report3.costReportId).not.toBe(report1.costReportId);
    expect(costService.getCostReportDetail(report2.costReportId).result).toEqual(report2.result);

    // BE-12: quantity is capped.
    expect(() => costService.createCostReport({ ...input2, quantity: 1_000_001 }, "2026-08-18T02:07:00.000Z")).toThrow(
      /not greater than/
    );
    // BE-11: a unit glued to the number is parsed once, by the shared parser, and
    // the frozen rawStockVolume is the real volume (never a 1e-9 mm fallback).
    const glued = costService.createCostReport({ ...input2, stockSpec: "Ø0.32×0.82m" }, "2026-08-18T02:08:00.000Z");
    expect(glued.result.rawStockVolume).toBeCloseTo((Math.PI * 0.16 * 0.16 * 0.82), 9);
    const gluedMm = costService.createCostReport({ ...input2, stockSpec: "Ø320×820MM" }, "2026-08-18T02:09:00.000Z");
    expect(gluedMm.result.rawStockVolume).toBeCloseTo(Math.PI * 0.16 * 0.16 * 0.82, 9);
    expect(() => costService.createCostReport({ ...input2, stockSpec: "Ø320×820" }, "2026-08-18T02:10:00.000Z")).toThrow(
      /explicit positive dimensions/
    );
  });

  it("deletes a Cost Report of its owning Revision and guards the identity pair", () => {
    const sourceDir = join(dir, "sources");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "del.pdf");
    writeFileSync(sourcePath, "%PDF-1.4 test");

    const { drawing, revision } = drawingService.importDrawing({
      drawingNumber: "DWG-COST-DEL",
      name: "Cost Delete Part",
      sourceFile: {
        sourcePath,
        fileName: "del.pdf",
        format: "PDF",
        uploadedAt: "2026-08-18T01:00:00.000Z"
      },
      createdAt: "2026-08-18T01:00:00.000Z"
    });

    const run = runs.createRun({
      drawingId: drawing.id,
      revisionId: revision.id,
      createdAt: "2026-08-18T01:01:00.000Z",
      profile: {
        promptTemplateVersion: "2026.08-p5",
        skill: { name: "test", sha256: "0".repeat(64) },
        agentConfigId: "codex"
      }
    });

    db.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
        "VALUES (?, 'M01', ?, ?, ?, 'PENDING_REVIEW', ?)"
    ).run("model-cost-del-1", drawing.id, revision.id, run.id, "2026-08-18T01:02:00.000Z");

    runs.reviewModel({
      modelId: "model-cost-del-1",
      result: "APPROVED",
      reviewerId: "user-alice",
      reviewedAt: "2026-08-18T01:04:00.000Z"
    });

    const costData = costService.getEffectiveCostData();
    const input: CostEstimateInputSnapshot = {
      drawingId: drawing.id,
      revisionId: revision.id,
      modelId: "model-cost-del-1",
      quantity: 5,
      materialId: costData.materials[0]!.id,
      stockType: "CYLINDER",
      stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031,
      allowances: [
        { name: "直径方向默认余量", valueMm: 20 },
        { name: "长度方向默认余量", valueMm: 20 }
      ],
      costData,
      formulaVersion: "2026.08-p7",
      capturedAt: "2026-08-18T01:05:00.000Z"
    };
    const report = costService.createCostReport(input, "2026-08-18T01:05:00.000Z");
    expect(costService.listCostReportsByRevision(drawing.id, revision.id)).toHaveLength(1);

    // An unknown report is a structured NOT_FOUND.
    expect(() => costService.deleteCostReport("report-ghost", revision.id)).toThrowError(NotFoundError);

    // A mismatched revision pair is an invariant error and leaves the report.
    expect(() => costService.deleteCostReport(report.costReportId, "revision-other")).toThrowError(
      expect.objectContaining({ code: "DOMAIN_INVARIANT" })
    );
    expect(costService.listCostReportsByRevision(drawing.id, revision.id)).toHaveLength(1);

    // The correct pair deletes cleanly.
    const result = costService.deleteCostReport(report.costReportId, revision.id);
    expect(result).toEqual({ costReportId: report.costReportId });
    expect(costService.listCostReportsByRevision(drawing.id, revision.id)).toHaveLength(0);

    // Repeating the deletion is a structured NOT_FOUND, never a silent no-op.
    expect(() => costService.deleteCostReport(report.costReportId, revision.id)).toThrowError(
      NotFoundError
    );
  });
});
