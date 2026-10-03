// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CostEstimateInputSnapshot } from "@swpanel/domain";
import { WebServer } from "../../../../runner/src/server/web-server.js";
import { makeTempDir, removeTempDir, samplePdfBytes } from "../../../../runner/src/test-utils.js";
import { registerGeometryFixture } from "../../../../runner/src/testing/measured-geometry-fixture.js";
import { HttpDrawingRepository } from "./bridge-repository/http-drawing-repository.js";
import { HttpRunRepository } from "./run-repository/http-run-repository.js";
import { HttpModelRepository } from "./model-repository/http-model-repository.js";
import { HttpCostRepository } from "./cost-repository/http-cost-repository.js";
import type { SelectedDrawingFileInput } from "./bridge-repository/drawing-repository.js";
import type { RunDetailView } from "@swpanel/contracts";

const instant = "2026-10-01T10:00:00.000Z";

describe("HTTP adapters against the real Runner and SQLite", () => {
  let dataRoot: string;
  let server: WebServer;
  let baseUrl: string;
  let drawings: HttpDrawingRepository;
  let runs: HttpRunRepository;
  let models: HttpModelRepository;
  let costs: HttpCostRepository;

  beforeEach(async () => {
    dataRoot = makeTempDir("http-adapter-integration");
    // Explicit fixture execution is scoped to this disposable integration database.
    server = new WebServer({ dataRoot, port: 0, runnerConfig: {} });
    const info = await server.start();
    baseUrl = `http://${info.host}:${info.port}`;
    drawings = new HttpDrawingRepository({ baseUrl });
    runs = new HttpRunRepository({ baseUrl });
    models = new HttpModelRepository({ baseUrl });
    costs = new HttpCostRepository({ baseUrl });
  });
  afterEach(async () => {
    await server.stop();
    removeTempDir(dataRoot);
  });

  async function file(): Promise<SelectedDrawingFileInput> {
    const response = await fetch(`${baseUrl}/api/upload`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "integration.pdf", contentBase64: samplePdfBytes().toString("base64") })
    });
    const envelope = await response.json() as { ok: boolean; data: SelectedDrawingFileInput };
    expect(envelope.ok).toBe(true);
    return envelope.data;
  }
  async function importDrawing() {
    return drawings.importDrawing({ drawingNumber: "ADAPTER-001", name: "真实HTTP契约测试", file: await file(), createdAt: instant });
  }
  async function terminal(runId: string): Promise<RunDetailView> {
    let detail: RunDetailView | undefined;
    await expect.poll(async () => {
      detail = await runs.getRunDetail(runId);
      return detail.run.status;
    }, { interval: 10, timeout: 3000 }).toBe("COMPLETED");
    return detail!;
  }

  it("imports, queries routes, maintains version memory and updates current revision", async () => {
    const selectedFile = await file();
    const submission = { drawingNumber: "ADAPTER-001", name: "真实HTTP契约测试", file: selectedFile, createdAt: instant };
    const { drawing, revision } = await drawings.importDrawing(submission);
    // A lost response is retried using the same selection without importing twice.
    expect((await drawings.importDrawing({ ...submission, createdAt: "2026-10-01T10:01:00.000Z" })).drawing.id).toBe(drawing.id);
    expect(drawings.resolveDrawingParam(drawing.id)).toBe(drawing.id);
    expect((await drawings.listDrawings())[0]!.drawingId).toBe(drawing.id);
    expect((await drawings.getDrawingDetail(drawing.id)).drawing.name).toBe("真实HTTP契约测试");
    const input = { drawingId: drawing.id, revisionId: revision.id, field: "孔深", value: "12", unit: "mm", source: "USER_SUPPLEMENT" as const, clientIntentId: `swint_${"a".repeat(32)}`, createdAt: instant };
    const first = await drawings.addRevisionFact(input);
    expect((await drawings.addRevisionFact({ ...input, createdAt: "2026-10-01T10:01:00.000Z" })).id).toBe(first.id);
    expect((await drawings.addModelingFeedback({ drawingId: drawing.id, revisionId: revision.id, content: "保留台阶", clientIntentId: `swint_${"b".repeat(32)}`, createdAt: instant })).content).toBe("保留台阶");
    expect((await drawings.getRevisionDetail(drawing.id, revision.id)).facts).toHaveLength(1);
    expect((await drawings.getRevisionHistory(drawing.id, revision.id)).modelingFeedback).toHaveLength(1);
    const nextFile = await file();
    const second = await drawings.addRevision({ drawingId: drawing.id, file: nextFile, createdAt: instant });
    expect((await drawings.addRevision({ drawingId: drawing.id, file: nextFile, createdAt: "2026-10-01T10:02:00.000Z" })).revision.id).toBe(second.revision.id);
    expect((await drawings.getRevisionDetail(drawing.id, second.revision.id)).facts).toHaveLength(0);
    expect((await drawings.setCurrentRevision({ drawingId: drawing.id, revisionId: second.revision.id, updatedAt: instant })).currentRevisionId).toBe(second.revision.id);
    expect((await drawings.getDrawingHistory(drawing.id)).revisions).toHaveLength(2);
    expect((await drawings.deleteRevision({ drawingId: drawing.id, revisionId: revision.id, updatedAt: instant })).deletedRevisionId).toBe(revision.id);
    expect((await drawings.getStorageSettings()).settings.dataRoot).toBe(dataRoot);
  });

  it("uses actual review and cost APIs with immutable history and guarded deletion", async () => {
    const { drawing, revision } = await importDrawing();
    const run = await runs.createRun({ drawingId: drawing.id, revisionId: revision.id });
    const detail = await terminal(run.id);
    expect((await runs.listRuns())[0]!.runId).toBe(run.id);
    const modelId = detail.run.modelId!;
    expect((await models.getModelDetail(modelId)).model.productionVerified).toBe(false);
    expect((await models.reviewModel({ modelId, result: "APPROVED", reviewerId: "integration-reviewer", reviewedAt: instant })).model.reviewStatus).toBe("APPROVED");
    const data = await costs.getEffectiveCostData();
    const input: CostEstimateInputSnapshot = {
      drawingId: drawing.id, revisionId: revision.id, modelId, quantity: 2,
      materialId: data.materials[0]!.id, stockType: "CYLINDER", stockSpec: "Ø320 × 820 mm",
      finishedVolume: 0.031, allowances: [{ name: "直径余量", valueMm: 20 }, { name: "长度余量", valueMm: 20 }],
      costData: data, formulaVersion: "2026.08-p7", capturedAt: instant
    };
    await expect(costs.createCostReport(input, instant)).rejects.toMatchObject({ code: "MODEL_GEOMETRY_UNAVAILABLE" });
    registerGeometryFixture(dataRoot, modelId);
    const report = await costs.createCostReport(input, instant);
    const updated = await costs.updateCostData({ ...data, capturedAt: instant, materials: data.materials.map((material) => ({ ...material, purchasePrice: material.purchasePrice * 2 })) });
    expect(updated.materials[0]!.purchasePrice).toBe(data.materials[0]!.purchasePrice * 2);
    expect((await costs.getCostReportDetail(report.costReportId)).result.totalCost).toBe(report.result.totalCost);
    expect((await costs.deleteCostReport({ costReportId: report.costReportId, revisionId: revision.id })).costReportId).toBe(report.costReportId);
    await expect(costs.getCostReportDetail(report.costReportId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a model with persisted feedback and keeps it permanently rejected", async () => {
    const { drawing, revision } = await importDrawing();
    const run = await runs.createRun({ drawingId: drawing.id, revisionId: revision.id });
    const modelId = (await terminal(run.id)).run.modelId!;
    await models.reviewModel({ modelId, result: "REJECTED", reviewerId: "reviewer", reviewedAt: instant, comment: "孔深不正确" });
    expect((await drawings.getRevisionDetail(drawing.id, revision.id)).modelingFeedback[0]!.content).toContain("孔深不正确");
    await expect(models.reviewModel({ modelId, result: "APPROVED", reviewerId: "reviewer", reviewedAt: instant })).rejects.toMatchObject({ code: "DOMAIN_INVARIANT" });
  });

  it("submits structured clarification into revision facts without resuming the old Run", async () => {
    await server.stop();
    server = new WebServer({ dataRoot, port: Number(new URL(baseUrl).port), runnerConfig: { fakeExecutorScenario: "clarification" } });
    await server.start();
    const { drawing, revision } = await importDrawing();
    const run = await runs.createRun({ drawingId: drawing.id, revisionId: revision.id });
    let detail: RunDetailView | undefined;
    await expect.poll(async () => {
      detail = await runs.getRunDetail(run.id);
      return detail.run.status;
    }, { interval: 10, timeout: 3000 }).toBe("CLARIFICATION_REQUIRED");
    const requestId = detail!.run.clarificationRequestId!;
    const clarification = await runs.getClarification(requestId);
    const dimension = clarification.questions.find((question) => question.type === "dimension")!;
    const choice = clarification.questions.find((question) => question.type === "choice")!;
    const result = await runs.submitClarification({
      clarificationRequestId: requestId, answeredAt: instant, answeredBy: "integration-user",
      answers: [
        { id: "answer-dimension", questionId: dimension.questionId, value: { kind: "dimension", value: 12, unit: "mm" }, answeredAt: instant, answeredBy: "integration-user" },
        { id: "answer-choice", questionId: choice.questionId, value: { kind: "choice", optionId: choice.options[0]!.id }, answeredAt: instant, answeredBy: "integration-user" }
      ]
    });
    expect(result.status).toBe("ANSWERED");
    expect((await runs.getRunDetail(run.id)).run.status).toBe("CLARIFICATION_REQUIRED");
    expect((await runs.listRuns())).toHaveLength(1);
    expect((await drawings.getRevisionDetail(drawing.id, revision.id)).facts).toHaveLength(2);
  });
});
