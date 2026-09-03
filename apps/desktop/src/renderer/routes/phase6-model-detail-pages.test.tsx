import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import type { Model } from "@swpanel/domain";

import { BridgeDrawingRepository } from "../features/bridge-repository/bridge-drawing-repository.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { BridgeModelRepository } from "../features/model-repository/bridge-model-repository.js";
import { ModelRepositoryError, type ModelRepository } from "../features/model-repository/model-repository.js";
import { ModelRepositoryProvider } from "../features/model-repository/model-repository-provider.js";
import { createFakeBridge, type FakeBridge } from "../test/fake-bridge.js";
import { DRAWING_IDS, REVISION_IDS } from "../fixtures/index.js";
import { buildModel, buildModelArtifacts, buildModelReview, validationSummary } from "../fixtures/index.js";

import { ModelDetailPage } from "./ModelDetailPage.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const MAIN_DRAWING = DRAWING_IDS.main;
const MAIN_REVISION = REVISION_IDS.mainV3;
const MODEL_ID = "model-main-m03";
const RUN_ID = "run-main-r05";

const DRAWING_SEED = {
  id: MAIN_DRAWING,
  drawingNumber: "PDJF480.01.17C-4",
  name: "主图纸",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  currentRevisionId: MAIN_REVISION,
  revisions: [
    { id: MAIN_REVISION, sequence: 3, fileName: "PDJF480.01.17C-4_V3.pdf", uploadedAt: "2026-08-12T01:00:00.000Z" }
  ]
} as const;

function buildPendingModel(overrides: Partial<Model> = {}): Model {
  return buildModel({
    id: MODEL_ID,
    number: "M03",
    drawingId: MAIN_DRAWING,
    revisionId: MAIN_REVISION,
    runId: RUN_ID,
    reviewStatus: "PENDING_REVIEW",
    generatedAt: "2026-08-13T08:00:00.000Z",
    productionVerified: false,
    validationSummary: validationSummary(6, 1),
    buildReportSummary: "模型基于当前 V3 图纸与版本记忆生成，主要结构采用旋转特征完成。",
    artifactIds: ["artifact-model-main-m03-sldprt", "artifact-model-main-m03-dimension_ledger"],
    ...overrides
  });
}

/** Fake bridge pre-seeded with one drawing + one PENDING_REVIEW model. */
function createModelFake(options: { fail?: readonly string[] } = {}): FakeBridge {
  const fake = createFakeBridge({
    seed: [DRAWING_SEED],
    ...(options.fail === undefined ? {} : { fail: options.fail })
  });
  const model = buildPendingModel();
  fake.addModel(model, buildModelArtifacts(model.runId, model.id, model.generatedAt));
  return fake;
}

function renderProduct(fake: FakeBridge, initialEntry: string) {
  const drawingRepository = new BridgeDrawingRepository(fake.api);
  const modelRepository = new BridgeModelRepository(fake.api);
  const routes: RouteObject[] = [
    { path: "/drawings/:drawingId/revisions/:revisionId/models/:modelId", element: <ModelDetailPage now={NOW} /> }
  ];
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  return render(
    <DrawingRepositoryProvider repository={drawingRepository}>
      <ModelRepositoryProvider repository={modelRepository}>
        <RouterProvider router={router} />
      </ModelRepositoryProvider>
    </DrawingRepositoryProvider>
  );
}

const detailPath = `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models/${MODEL_ID}`;

afterEach(cleanup);

describe("Model Detail (product mode)", () => {
  it("renders real model info, artifacts and the review panel for a PENDING_REVIEW model", async () => {
    const fake = createModelFake();
    renderProduct(fake, detailPath);

    expect(await screen.findByText("M03")).toBeInTheDocument();
    expect(screen.getByText("等待审核")).toBeInTheDocument();
    // The drawing identity resolves through the cached Drawing query.
    expect(await screen.findByText("PDJF480.01.17C-4 · V3 · 主图纸")).toBeInTheDocument();
    expect(screen.getByText("来源 Run", { selector: ".property-key" })).toBeInTheDocument();
    expect(screen.getByText("构建摘要")).toBeInTheDocument();
    expect(screen.getByText("Dimension Ledger")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "审核通过" })).toBeInTheDocument();
    expect(fake.calls.some((call) => call.startsWith("models.getDetail"))).toBe(true);
  });

  it("approves a PENDING_REVIEW model through models.review and refreshes the detail", async () => {
    const user = userEvent.setup();
    const fake = createModelFake();
    renderProduct(fake, detailPath);

    await user.click(await screen.findByRole("button", { name: "审核通过" }));

    // The review command reached the bridge with the semantic decision.
    expect(
      fake.calls.some((call) => call.startsWith("models.review:") && call.includes('"result":"APPROVED"'))
    ).toBe(true);
    // The persisted model transitioned and the revision repointed.
    expect(fake.state().models.find((model) => model.id === MODEL_ID)?.reviewStatus).toBe("APPROVED");
    expect(fake.state().revisions.find((revision) => revision.id === MAIN_REVISION)?.currentApprovedModelId).toBe(
      MODEL_ID
    );
    // The refreshed detail renders the approved state (badge, no review buttons).
    expect(await screen.findByText("审核通过", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "审核通过" })).not.toBeInTheDocument();
    expect(screen.getByText("当前正式模型")).toBeInTheDocument();
  });

  it("rejects a PENDING_REVIEW model with a required reason and records the feedback", async () => {
    const user = userEvent.setup();
    const fake = createModelFake();
    renderProduct(fake, detailPath);

    await user.click(await screen.findByRole("button", { name: "退回" }));
    const reasonBox = screen.getByRole("textbox", { name: "退回原因" });

    // Empty reason is blocked client-side.
    await user.click(screen.getByRole("button", { name: "确认退回" }));
    expect(screen.getByRole("alert")).toHaveTextContent("退回原因不能为空");
    expect(fake.state().models.find((model) => model.id === MODEL_ID)?.reviewStatus).toBe("PENDING_REVIEW");

    // A filled reason rejects and persists the review + feedback.
    await user.type(reasonBox, "右侧台阶直径错误，应为 Ø120");
    await user.click(screen.getByRole("button", { name: "确认退回" }));

    expect(
      fake.calls.some((call) => call.startsWith("models.review:") && call.includes('"result":"REJECTED"'))
    ).toBe(true);
    expect(fake.state().models.find((model) => model.id === MODEL_ID)?.reviewStatus).toBe("REJECTED");
    const review = fake.state().reviews.find((candidate) => candidate.modelId === MODEL_ID);
    expect(review?.result).toBe("REJECTED");
    expect(review?.comment).toBe("右侧台阶直径错误，应为 Ø120");
    const feedback = fake.state().feedback.find((entry) => entry.modelId === MODEL_ID);
    expect(feedback?.content).toBe("右侧台阶直径错误，应为 Ø120");
    expect((await screen.findAllByText(/已退回/)).length).toBeGreaterThan(0);
  });

  it("renders the persisted review history of an already-reviewed model", async () => {
    const fake = createModelFake();
    fake.addModel(
      buildPendingModel({ id: "model-main-m02", number: "M02", reviewStatus: "APPROVED" }),
      []
    );
    fake.addModelReview(
      buildModelReview({
        id: "review-2",
        modelId: "model-main-m02",
        result: "APPROVED",
        reviewerId: "alice",
        createdAt: "2026-08-13T09:30:00.000Z"
      })
    );
    renderProduct(fake, `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models/model-main-m02`);

    expect(await screen.findByText("M02")).toBeInTheDocument();
    expect(await screen.findByText(/审核通过 · alice/)).toBeInTheDocument();
    expect(screen.getByText("历史正式模型")).toBeInTheDocument();
  });

  it("renders a structured not-found state for an unknown model id", async () => {
    const fake = createModelFake();
    renderProduct(fake, `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models/model-does-not-exist`);

    expect(await screen.findByText("模型不存在或已被删除")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回图纸库" })).toBeInTheDocument();
  });

  it("surfaces a bridge failure with retry on the model detail query", async () => {
    const user = userEvent.setup();
    const fake = createModelFake({ fail: ["models.getDetail"] });
    renderProduct(fake, detailPath);

    expect(await screen.findByText("模型详情加载失败")).toBeInTheDocument();

    fake.clearFailure("models.getDetail");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("M03")).toBeInTheDocument();
  });
});

describe("Model Detail without a bridge (error state, never fixtures)", () => {
  it("shows the truthful unavailable error when the repository is unavailable", async () => {
    const fake = createFakeBridge({ seed: [DRAWING_SEED] });
    const drawingRepository = new BridgeDrawingRepository(fake.api);
    const unavailableRepository: ModelRepository = {
      mode: "unavailable",
      mock: null,
      getModelDetail: () =>
        Promise.reject(
          new ModelRepositoryError(
            "RUNNER_UNAVAILABLE",
            "SWPanel 桌面桥接不可用：请通过 Electron 桌面应用启动，并确认图纸处理服务（Runner）已就绪。"
          )
        ),
      reviewModel: () =>
        Promise.reject(
          new ModelRepositoryError(
            "RUNNER_UNAVAILABLE",
            "SWPanel 桌面桥接不可用：请通过 Electron 桌面应用启动，并确认图纸处理服务（Runner）已就绪。"
          )
        )
    };
    const router = createMemoryRouter(
      [{ path: "/drawings/:drawingId/revisions/:revisionId/models/:modelId", element: <ModelDetailPage now={NOW} /> }],
      { initialEntries: [detailPath] }
    );
    render(
      <DrawingRepositoryProvider repository={drawingRepository}>
        <ModelRepositoryProvider repository={unavailableRepository}>
          <RouterProvider router={router} />
        </ModelRepositoryProvider>
      </DrawingRepositoryProvider>
    );

    expect(await screen.findByText("模型详情加载失败")).toBeInTheDocument();
    expect(screen.queryByText("M03")).not.toBeInTheDocument();
  });
});