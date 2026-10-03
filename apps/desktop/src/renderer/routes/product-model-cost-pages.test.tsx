import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ModelDetailView } from "@swpanel/contracts";
import { BridgeDrawingRepository } from "../features/bridge-repository/bridge-drawing-repository.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { BridgeModelRepository } from "../features/model-repository/bridge-model-repository.js";
import { ModelRepositoryProvider } from "../features/model-repository/model-repository-provider.js";
import { HttpModelRepository } from "../features/model-repository/http-model-repository.js";
import { HttpDrawingRepository } from "../features/bridge-repository/http-drawing-repository.js";
import { BridgeCostRepository } from "../features/cost-repository/bridge-cost-repository.js";
import { CostRepositoryProvider } from "../features/cost-repository/cost-repository-provider.js";
import { createFakeBridge } from "../test/fake-bridge.js";
import { buildModel, buildModelArtifacts, validationSummary } from "../fixtures/index.js";
import { CostParamsPage } from "./CostParamsPage.js";
import { ModelDetailPage } from "./ModelDetailPage.js";
import { DrawingOverviewPage } from "./DrawingOverviewPage.js";

const modelId = "model-real";
const drawingId = "drawing-real";
const revisionId = "revision-real";
const rootPath = `/drawings/${drawingId}/revisions/${revisionId}`;
const geometry: NonNullable<ModelDetailView["geometry"]> = {
  finishedVolumeM3: 0.00123,
  boundingBoxMm: { length: 100, width: 150, height: 200 },
  sourceArtifactId: "geometry-real"
};

async function setup(geometryData: ModelDetailView["geometry"] = geometry, path = "/costs/new") {
  const fake = createFakeBridge({ seed: [{ id: drawingId, drawingNumber: "REAL-1", name: "真实图纸", currentRevisionId: revisionId,
    revisions: [{ id: revisionId, sequence: 1, fileName: "real.pdf", uploadedAt: "2026-10-01T00:00:00Z" }] }] });
  const model = buildModel({ id: modelId, number: "M01", drawingId, revisionId, runId: "run-real", reviewStatus: "PENDING_REVIEW",
    generatedAt: "2026-10-01T00:00:00Z", productionVerified: true, validationSummary: validationSummary(5, 1) });
  fake.addModel(model, buildModelArtifacts(model.runId, model.id, model.generatedAt));
  await fake.api.models.review({ modelId, result: "APPROVED", reviewerId: "test", reviewedAt: "2026-10-01T00:01:00Z" });
  const modelRepo = new BridgeModelRepository(fake.api);
  const getDetail = modelRepo.getModelDetail.bind(modelRepo);
  modelRepo.getModelDetail = async (id) => ({ ...await getDetail(id), geometry: geometryData });
  const modelAdapter = Object.assign(modelRepo, { artifactUrl: new HttpModelRepository({ baseUrl: "http://localhost:3001" }).artifactUrl.bind(new HttpModelRepository({ baseUrl: "http://localhost:3001" })) });
  const drawingAdapter = Object.assign(new BridgeDrawingRepository(fake.api), { sourceFileUrl: new HttpDrawingRepository({ baseUrl: "http://localhost:3001" }).sourceFileUrl.bind(new HttpDrawingRepository({ baseUrl: "http://localhost:3001" })) });
  const costRepo = new BridgeCostRepository(fake.api);
  const create = vi.spyOn(costRepo, "createCostReport").mockRejectedValue(new Error("测试捕获参数"));
  render(<DrawingRepositoryProvider repository={drawingAdapter}><ModelRepositoryProvider repository={modelAdapter}>
    <CostRepositoryProvider repository={costRepo}><MemoryRouter initialEntries={[`${rootPath}${path}`]}><Routes>
      <Route path="/drawings/:drawingId/revisions/:revisionId/costs/new" element={<CostParamsPage />} />
      <Route path="/drawings/:drawingId/revisions/:revisionId/models/:modelId" element={<ModelDetailPage />} />
      <Route path="/drawings/:drawingId/revisions/:revisionId/overview" element={<DrawingOverviewPage />} />
    </Routes></MemoryRouter></CostRepositoryProvider></ModelRepositoryProvider></DrawingRepositoryProvider>);
  return { create, costData: await costRepo.getEffectiveCostData() };
}

afterEach(cleanup);

describe("真实模型和成本参数", () => {
  it("缺少可信模型体积时禁止成本报告，并且不使用示例毛坯或默认材料", async () => {
    const { create } = await setup(null);
    const button = await screen.findByRole("button", { name: "生成成本测算报告" });
    expect(button).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "毛坯规格" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "材料选择" })).toHaveValue("");
    expect(await screen.findByText(/当前正式模型缺少可信的精加工体积/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("确认明确毛坯尺寸后采用真实模型体积和企业余量", async () => {
    const user = userEvent.setup();
    const { create, costData } = await setup();
    const button = await screen.findByRole("button", { name: "生成成本测算报告" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.selectOptions(screen.getByRole("combobox", { name: "材料选择" }), costData.materials[0]!.id);
    await user.type(screen.getByRole("textbox", { name: "毛坯规格" }), "Ø300 × 400");
    await user.click(button);
    expect(await screen.findByText(/请填写直径 × 长度及单位/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "毛坯规格" }), " mm");
    await user.click(button);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]![0].finishedVolume).toBe(geometry.finishedVolumeM3);
    expect(create.mock.calls[0]![0].allowances).toEqual(costData.allowances.find((entry) => entry.stockType === "CYLINDER")!.allowances);
    expect(screen.getByText(/模型包围盒参考：100 × 150 × 200 mm/)).toBeInTheDocument();
  });

  it("显示真实预览，所有技术文件可下载，图片加载失败给出清楚提示", async () => {
    await setup(geometry, `/models/${modelId}`);
    const preview = await screen.findByRole("img", { name: "M01 模型预览" });
    expect(preview.tagName).toBe("IMG");
    expect(preview).toHaveAttribute("src", expect.stringContaining(`/api/models/${modelId}/artifacts/`));
    expect(screen.getByRole("link", { name: "下载 SolidWorks 模型" })).toHaveAttribute("href", expect.stringContaining("?download=1"));
    expect(screen.getByText(/浏览器中请先下载 SLDPRT/)).toBeInTheDocument();
    fireEvent.error(preview);
    expect(screen.getByText("模型预览图无法加载，请下载模型检查。")).toBeInTheDocument();
  });

  it("原图使用文件endpoint显示并下载", async () => {
    await setup(geometry, "/overview");
    const download = await screen.findByRole("link", { name: "下载原图" });
    expect(download).toHaveAttribute("href", `http://localhost:3001/api/drawings/${drawingId}/revisions/${revisionId}/source?download=1`);
    expect(screen.getByLabelText("工程图纸预览")).toHaveAttribute("data", `http://localhost:3001/api/drawings/${drawingId}/revisions/${revisionId}/source`);
  });
});
