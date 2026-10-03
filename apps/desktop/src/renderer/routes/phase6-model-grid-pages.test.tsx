import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import type { Model, ModelingRun } from "@swpanel/domain";

import { BridgeDrawingRepository } from "../features/bridge-repository/bridge-drawing-repository.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { BridgeModelRepository } from "../features/model-repository/bridge-model-repository.js";
import { ModelRepositoryProvider } from "../features/model-repository/model-repository-provider.js";
import { BridgeRunRepository } from "../features/run-repository/bridge-run-repository.js";
import { RunRepositoryProvider } from "../features/run-repository/run-repository-provider.js";
import { createFakeBridge, type FakeBridge } from "../test/fake-bridge.js";
import { DRAWING_IDS, REVISION_IDS } from "../fixtures/index.js";
import { buildModel, buildModelArtifacts, validationSummary } from "../fixtures/index.js";

import { DrawingModelsPage } from "./DrawingModelsPage.js";
import { DrawingOverviewPage } from "./DrawingOverviewPage.js";
import { RunDetailPage } from "./RunDetailPage.js";

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

/** Fake bridge pre-seeded with one drawing + one PENDING_REVIEW model. */
function createModelFake(options: { fail?: readonly string[] } = {}): FakeBridge {
  const fake = createFakeBridge({
    seed: [DRAWING_SEED],
    ...(options.fail === undefined ? {} : { fail: options.fail })
  });
  const model: Model = buildModel({
    id: MODEL_ID,
    number: "M03",
    drawingId: MAIN_DRAWING,
    revisionId: MAIN_REVISION,
    runId: RUN_ID,
    reviewStatus: "PENDING_REVIEW",
    generatedAt: "2026-08-13T08:00:00.000Z",
    productionVerified: false,
    validationSummary: validationSummary(6, 1),
    artifactIds: []
  });
  fake.addModel(model, buildModelArtifacts(model.runId, model.id, model.generatedAt));
  return fake;
}

function renderProduct(routes: { path: string; element: React.ReactNode }[], fake: FakeBridge, initialEntry: string) {
  const drawingRepository = new BridgeDrawingRepository(fake.api);
  const modelRepository = new BridgeModelRepository(fake.api);
  const runRepository = new BridgeRunRepository(fake.api);
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  return render(
    <DrawingRepositoryProvider repository={drawingRepository}>
      <RunRepositoryProvider repository={runRepository}>
        <ModelRepositoryProvider repository={modelRepository}>
          <RouterProvider router={router} />
        </ModelRepositoryProvider>
      </RunRepositoryProvider>
    </DrawingRepositoryProvider>
  );
}

const MODELS_ROUTE = {
  path: "/drawings/:drawingId/revisions/:revisionId/models",
  element: <DrawingModelsPage now={NOW} />
};

afterEach(cleanup);

// ── Drawing Workspace · 模型 (product mode) ─────────────────────────────────

describe("Drawing Workspace · 模型 (product mode)", () => {
  it("renders the revision's models from the Drawing revision detail and links to Model Detail", async () => {
    const fake = createModelFake();
    renderProduct([MODELS_ROUTE], fake, `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models`);

    // The model grid shows the label + review status of the real model.
    expect(await screen.findByText("M03")).toBeInTheDocument();
    expect(screen.getByText("等待审核")).toBeInTheDocument();
    // The card links to the unlocked Model Detail page.
    expect(screen.getByRole("link", { name: /M03/ })).toHaveAttribute(
      "href",
      `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models/${MODEL_ID}`
    );
    expect(fake.calls.some((call) => call.startsWith("drawings.getRevisionDetail"))).toBe(true);
  });

  it("shows the truthful empty state when the revision has no models", async () => {
    const fake = createFakeBridge({ seed: [DRAWING_SEED] });
    renderProduct([MODELS_ROUTE], fake, `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models`);

    expect(await screen.findByText("暂无模型")).toBeInTheDocument();
  });

  it("shows a structured error state with retry when the revision detail fails", async () => {
    const fake = createModelFake({ fail: ["drawings.getRevisionDetail"] });
    renderProduct([MODELS_ROUTE], fake, `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models`);

    expect(await screen.findByText("版本模型加载失败")).toBeInTheDocument();
    expect(screen.getAllByText(/未连接到 SWPanel 服务|暂时不可用/).length).toBeGreaterThanOrEqual(1);
  });
});

// ── Model navigation from Run Detail / Drawing Overview (product mode) ──────

describe("Model navigation (product mode)", () => {
  it("Run Detail links a COMPLETED run with a published model to the Model Detail page", async () => {
    const fake = createModelFake();
    const run: ModelingRun = {
      id: RUN_ID,
      number: "R05",
      drawingId: MAIN_DRAWING,
      revisionId: MAIN_REVISION,
      status: "COMPLETED",
      stage: "PACKAGING",
      inputSnapshot: {
        drawingId: MAIN_DRAWING,
        revisionId: MAIN_REVISION,
        originalFileRef: `file-${MAIN_REVISION}`,
        revisionFacts: [],
        modelingFeedback: [],
        promptTemplateVersion: "test-v1",
        skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) },
        agentConfigId: "test-config",
        createdAt: "2026-08-13T07:00:00.000Z"
      },
      createdAt: "2026-08-13T07:00:00.000Z",
      completedAt: "2026-08-13T08:00:00.000Z",
      modelId: MODEL_ID
    };
    fake.addRun(run);
    renderProduct(
      [{ path: "/runs/:runId", element: <RunDetailPage now={NOW} /> }],
      fake,
      `/runs/${RUN_ID}`
    );

    expect(await screen.findByText("R05")).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "查看模型详情" });
    expect(link).toHaveAttribute(
      "href",
      `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models/${MODEL_ID}`
    );
  });

  it("Drawing Overview links the current model card to the Model Detail page", async () => {
    const fake = createModelFake();
    renderProduct(
      [{ path: "/drawings/:drawingId/revisions/:revisionId/overview", element: <DrawingOverviewPage now={NOW} /> }],
      fake,
      `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/overview`
    );

    expect(await screen.findByText("当前模型")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "查看详情" })).toHaveAttribute(
      "href",
      `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/models/${MODEL_ID}`
    );
  });
});