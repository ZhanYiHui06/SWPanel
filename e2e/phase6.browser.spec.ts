import { expect, test, type Page } from "@playwright/test";

type ModelRecord = {
  modelId: string;
  modelLabel: string;
  drawingId: string;
  revisionId: string;
  runId: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  isCurrentApproved: boolean;
  generatedAt: string;
  productionVerified: boolean;
  validationSummary: {
    solidWorksVersion: string;
    featureCount: number;
    bodyCount: number;
    rebuildStatus: string;
  } | null;
  buildReportSummary: string | null;
};

type ArtifactRecord = {
  artifactId: string;
  kind: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
};

type ReviewRecord = {
  reviewId: string;
  result: string;
  reviewerId: string;
  comment: string | null;
  createdAt: string;
};

type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

type FakeApi = {
  models: {
    getDetail: (modelId: string) => Promise<BridgeResult<{ model: ModelRecord; artifacts: ArtifactRecord[]; reviews: ReviewRecord[] }>>;
    review: (input: { modelId: string; result: "APPROVED" | "REJECTED"; comment?: string; reviewerId: string; reviewedAt: string }) => Promise<BridgeResult<{ model: ModelRecord; artifacts: ArtifactRecord[]; reviews: ReviewRecord[] }>>;
  };
  drawings: {
    list: () => Promise<BridgeResult<unknown>>;
    getDetail: (id: string) => Promise<BridgeResult<unknown>>;
    getHistory: (id: string) => Promise<BridgeResult<unknown>>;
    getRevisionDetail: (drawingId: string, revisionId: string) => Promise<BridgeResult<unknown>>;
    getRevisionHistory: (drawingId: string, revisionId: string) => Promise<BridgeResult<unknown>>;
  };
  runs: {
    list: () => Promise<BridgeResult<unknown>>;
    getDetail: (id: string) => Promise<BridgeResult<unknown>>;
    create: (input: unknown) => Promise<BridgeResult<unknown>>;
    cancel: () => Promise<BridgeResult<never>>;
    subscribe: () => () => void;
  };
  metadata: unknown;
  health: unknown;
  files: unknown;
  storage: unknown;
};

type FakeHook = { calls: string[] };

const drawing = {
  id: "drawing-p6",
  drawingNumber: "P6-001",
  name: "Phase 6 Review fixture",
  currentRevisionId: "revision-p6",
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z"
};

const initialModel: ModelRecord = {
  modelId: "model-p6-01",
  modelLabel: "M01",
  drawingId: drawing.id,
  revisionId: drawing.currentRevisionId,
  runId: "run-p6-01",
  reviewStatus: "PENDING_REVIEW",
  isCurrentApproved: false,
  generatedAt: "2026-08-14T00:05:00.000Z",
  productionVerified: false,
  validationSummary: {
    solidWorksVersion: "33.0.0.5050",
    featureCount: 8,
    bodyCount: 1,
    rebuildStatus: "PASSED"
  },
  buildReportSummary: "Model built cleanly with 8 features."
};

const artifacts: ArtifactRecord[] = [
  {
    artifactId: "art-01",
    kind: "SLDPRT",
    fileName: "P6-001.SLDPRT",
    sizeBytes: 1048576,
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  {
    artifactId: "art-02",
    kind: "PREVIEW",
    fileName: "preview.png",
    sizeBytes: 204800,
    sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
];

type BridgeInit = {
  drawing: typeof drawing;
  initialModel: typeof initialModel;
  artifacts: typeof artifacts;
};

function installBridge(init: BridgeInit): void {
  const drawing = init.drawing;
  const initialModel = init.initialModel;
  const artifacts = init.artifacts;
  const calls: string[] = [];
  const modelState = structuredClone(initialModel);
  const reviews: ReviewRecord[] = [];
  let currentApprovedModelId: string | null = null;

  const ok = <T,>(data: T): Promise<BridgeResult<T>> => Promise.resolve({ ok: true, data });
  const fail = <T,>(code: string, message = "error"): Promise<BridgeResult<T>> => Promise.resolve({ ok: false, error: { code, message } });

  const api: FakeApi = {
    metadata: { versions: { electron: "1", chrome: "1" } },
    health: {},
    files: {},
    storage: {},
    models: {
      getDetail: (modelId: string) => {
        calls.push(`models.getDetail:${modelId}`);
        if (modelId !== modelState.modelId) return fail("NOT_FOUND", "Model not found");
        return ok({
          model: { ...modelState, isCurrentApproved: currentApprovedModelId === modelState.modelId },
          artifacts,
          reviews: structuredClone(reviews)
        });
      },
      review: (input) => {
        calls.push(`models.review:${JSON.stringify(input)}`);
        if (input.modelId !== modelState.modelId) return fail("NOT_FOUND", "Model not found");
        if (modelState.reviewStatus !== "PENDING_REVIEW") {
          return fail("RUNNER_INVARIANT_ERROR", "Only PENDING_REVIEW model can be reviewed");
        }
        modelState.reviewStatus = input.result;
        if (input.result === "APPROVED") {
          currentApprovedModelId = modelState.modelId;
          modelState.isCurrentApproved = true;
        } else {
          modelState.isCurrentApproved = false;
        }
        const reviewRow: ReviewRecord = {
          reviewId: `rev-${Date.now()}`,
          result: input.result,
          reviewerId: input.reviewerId,
          comment: input.comment ?? null,
          createdAt: input.reviewedAt
        };
        reviews.push(reviewRow);
        return ok({
          model: { ...modelState, isCurrentApproved: currentApprovedModelId === modelState.modelId },
          artifacts,
          reviews: structuredClone(reviews)
        });
      }
    },
    drawings: {
      list: () => ok([]),
      getDetail: () => ok({
        drawing: {
          drawingId: drawing.id,
          drawingNumber: drawing.drawingNumber,
          name: drawing.name,
          currentRevisionId: drawing.currentRevisionId,
          createdAt: drawing.createdAt,
          updatedAt: drawing.updatedAt
        },
        revisions: [{
          revisionId: drawing.currentRevisionId,
          revisionLabel: "V1",
          isCurrent: true,
          currentApprovedModelId,
          isCurrentApprovedModel: currentApprovedModelId !== null
        }]
      }),
      getHistory: () => ok({
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        name: drawing.name,
        currentRevisionId: drawing.currentRevisionId,
        revisions: []
      }),
      getRevisionDetail: () => ok({
        revision: {
          revisionId: drawing.currentRevisionId,
          revisionLabel: "V1",
          drawingId: drawing.id,
          drawingNumber: drawing.drawingNumber,
          drawingName: drawing.name,
          isCurrent: true,
          currentApprovedModelId,
          sourceFile: { fileName: "P6-001.pdf", format: "PDF", sizeBytes: 1024, uploadedAt: drawing.createdAt },
          createdAt: drawing.createdAt
        },
        runs: [{
          runId: modelState.runId,
          runLabel: "R01",
          status: "COMPLETED",
          stage: null,
          createdAt: drawing.createdAt,
          modelId: modelState.modelId,
          clarificationRequestId: null,
          failureCode: null
        }],
        models: [{
          modelId: modelState.modelId,
          modelLabel: modelState.modelLabel,
          reviewStatus: modelState.reviewStatus,
          isCurrentApproved: currentApprovedModelId === modelState.modelId,
          generatedAt: modelState.generatedAt,
          runId: modelState.runId
        }],
        costReports: [],
        facts: [],
        modelingFeedback: reviews.filter(r => r.result === "REJECTED").map(r => ({
          id: `fb-${r.reviewId}`,
          revisionId: drawing.currentRevisionId,
          modelId: modelState.modelId,
          reviewId: r.reviewId,
          content: r.comment ?? "",
          source: "MODEL_REVIEW_REJECTED",
          createdAt: r.createdAt
        }))
      }),
      getRevisionHistory: () => ok({
        revisionId: drawing.currentRevisionId,
        revisionLabel: "V1",
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        isCurrent: true,
        facts: [],
        modelingFeedback: []
      })
    },
    runs: {
      list: () => ok([]),
      getDetail: () => ok({
        run: {
          runId: modelState.runId,
          runLabel: "R01",
          drawingId: drawing.id,
          revisionId: drawing.currentRevisionId,
          status: "COMPLETED",
          stage: null,
          activity: null,
          progressPercent: null,
          createdAt: drawing.createdAt,
          startedAt: drawing.createdAt,
          completedAt: modelState.generatedAt,
          failureCode: null,
          failureMessage: null,
          modelId: modelState.modelId,
          clarificationRequestId: null
        },
        events: [],
        lastEventSequence: 0
      }),
      create: () => fail("NOT_IMPLEMENTED"),
      cancel: () => fail("NOT_IMPLEMENTED"),
      subscribe: () => () => undefined
    }
  };

  const target = globalThis as unknown as { swpanel: FakeApi; __swpanelFake: FakeHook };
  target.swpanel = api;
  target.__swpanelFake = { calls };
}

async function openPage(page: Page, route: string): Promise<void> {
  page.on("pageerror", (error) => console.log(`phase6 pageerror: ${error.message}`));
  await page.addInitScript(installBridge, { drawing, initialModel, artifacts });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(route, { waitUntil: "networkidle" });
  await expect(page.locator("[data-route-id]")).toBeVisible();
}

test.describe("Phase 6 Model Review closed loop in bridge mode", () => {
  test("displays Model in Drawing Models tab without placeholder blocking", async ({ page }) => {
    await openPage(page, `/#/drawings/${drawing.id}/revisions/${drawing.currentRevisionId}/models`);
    await expect(page.getByText("M01", { exact: true })).toBeVisible();
    await expect(page.getByText("等待审核", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("模型生成与审核将在后续阶段提供")).toHaveCount(0);
  });

  test("approves a Model and updates current approved formal status", async ({ page }) => {
    await openPage(page, `/#/drawings/${drawing.id}/revisions/${drawing.currentRevisionId}/models/${initialModel.modelId}`);
    await expect(page.getByText("M01", { exact: true })).toBeVisible();
    await expect(page.getByText("等待审核", { exact: true }).first()).toBeVisible();

    // Click approve button
    const approveBtn = page.getByRole("button", { name: "审核通过" });
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // Expect status badge to update to 审核通过 and show formal approved marker
    await expect(page.getByText("审核通过", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("当前正式模型", { exact: true })).toBeVisible();

    const hook = await page.evaluate(() => (globalThis as unknown as { __swpanelFake: FakeHook }).__swpanelFake);
    expect(hook.calls.some((call) => call.includes('"result":"APPROVED"'))).toBe(true);
  });
});
