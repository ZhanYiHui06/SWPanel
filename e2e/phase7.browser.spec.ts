import { expect, test, type Page } from "@playwright/test";

type CostDataSnapshot = {
  materials: {
    id: string;
    name: string;
    purchasePrice: number;
    priceUnit: string;
    density?: number;
    densityUnit?: string;
    effectiveFrom: string;
    updatedAt: string;
  }[];
  allowances: {
    id: string;
    stockType: string;
    allowances: { name: string; valueMm: number }[];
    updatedAt: string;
  }[];
  fixedCosts: {
    id: string;
    name: string;
    amount: number;
    currency: string;
    basis: string;
    defaultEnabled: boolean;
    updatedAt: string;
  }[];
  customFields: {
    id: string;
    key: string;
    name: string;
    value: string;
    unit?: string;
    semantics: string;
    updatedAt: string;
  }[];
  capturedAt: string;
};

type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

// The fake bridge faithfully mirrors the real Promise-returning bridge surface,
// while keeping the helper `ok()` sync-friendly for the query stubs below.
type MaybeAsyncResult<T> = Promise<BridgeResult<T>> | BridgeResult<T>;

type CostReportResultRecord = {
  rawStockVolume: number;
  materialCost: number;
  fixedCostLines: readonly { name: string; amount: number; basis: string; subtotal: number }[];
  perPieceCost: number;
  totalCost: number;
  currency: string;
};

type CostReportRecord = {
  costReportId: string;
  label: string;
  drawingId: string;
  revisionId: string;
  modelId: string;
  quantity: number;
  createdAt: string;
  snapshot: unknown;
  result: CostReportResultRecord;
};

type CostReportInput = {
  drawingId: string;
  revisionId: string;
  modelId: string;
  quantity: number;
  materialId: string;
  stockType: string;
  stockSpec: string;
  finishedVolume: number;
  allowances: readonly { name: string; valueMm: number }[];
  costData: CostDataSnapshot;
  formulaVersion: string;
  capturedAt: string;
};

type FakeApi = {
  cost: {
    getEffectiveCostData: () => Promise<BridgeResult<CostDataSnapshot>>;
    updateCostData: (snapshot: CostDataSnapshot) => Promise<BridgeResult<CostDataSnapshot>>;
    getReportDetail: (costReportId: string) => Promise<BridgeResult<CostReportRecord>>;
    createReport: (input: { input: CostReportInput; createdAt: string }) => Promise<BridgeResult<CostReportRecord>>;
  };
  drawings: {
    list: () => MaybeAsyncResult<unknown>;
    getDetail: (id: string) => MaybeAsyncResult<unknown>;
    getHistory: (id: string) => MaybeAsyncResult<unknown>;
    getRevisionDetail: (drawingId: string, revisionId: string) => MaybeAsyncResult<unknown>;
    getRevisionHistory: (drawingId: string, revisionId: string) => MaybeAsyncResult<unknown>;
  };
  models: {
    getDetail: (id: string) => MaybeAsyncResult<unknown>;
  };
  runs: {
    list: () => MaybeAsyncResult<unknown>;
    getDetail: (id: string) => MaybeAsyncResult<unknown>;
    create: (input: unknown) => MaybeAsyncResult<unknown>;
    cancel: () => Promise<BridgeResult<never>>;
    subscribe: () => () => void;
  };
  metadata: unknown;
  health: unknown;
};

type FakeHook = {
  calls: string[];
};

const drawing = {
  id: "drawing-cost-001",
  drawingNumber: "DWG-COST-001",
  name: "法兰轴套",
  currentRevisionId: "rev-cost-001",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z"
};

const initialModel = {
  modelId: "model-cost-001",
  modelLabel: "M01",
  drawingId: drawing.id,
  revisionId: drawing.currentRevisionId,
  runId: "run-cost-001",
  reviewStatus: "APPROVED" as const,
  isCurrentApproved: true,
  generatedAt: "2026-08-18T01:00:00.000Z",
  productionVerified: false
};

const initialCostData: CostDataSnapshot = {
  materials: [
    {
      id: "material-42crmo",
      name: "42CrMo",
      purchasePrice: 5200,
      priceUnit: "元/吨",
      density: 7.85,
      densityUnit: "g/cm³",
      effectiveFrom: "2026-08-10T08:00:00.000Z",
      updatedAt: "2026-08-10T08:00:00.000Z"
    }
  ],
  allowances: [
    {
      id: "allowance-cylinder",
      stockType: "CYLINDER",
      allowances: [
        { name: "直径方向默认余量", valueMm: 20 },
        { name: "长度方向默认余量", valueMm: 20 }
      ],
      updatedAt: "2026-08-10T08:00:00.000Z"
    }
  ],
  fixedCosts: [
    {
      id: "fixed-basic-processing",
      name: "基础加工成本",
      amount: 500,
      currency: "CNY",
      basis: "PER_PIECE",
      defaultEnabled: true,
      updatedAt: "2026-08-10T08:00:00.000Z"
    },
    {
      id: "fixed-packaging",
      name: "包装成本",
      amount: 80,
      currency: "CNY",
      basis: "PER_BATCH",
      defaultEnabled: true,
      updatedAt: "2026-08-10T08:00:00.000Z"
    }
  ],
  customFields: [
    {
      id: "custom-note",
      key: "note.general",
      name: "备注",
      value: "常规加工工艺",
      semantics: "DISPLAY_ONLY",
      updatedAt: "2026-08-10T08:00:00.000Z"
    }
  ],
  capturedAt: "2026-08-10T08:00:00.000Z"
};

function installBridge(init: {
  drawing: typeof drawing;
  initialModel: typeof initialModel;
  costData: CostDataSnapshot;
}): void {
  const calls: string[] = [];
  let costState = JSON.parse(JSON.stringify(init.costData)) as CostDataSnapshot;
  const reports: CostReportRecord[] = [];

  const ok = <T>(data: T): BridgeResult<T> => ({ ok: true, data });

  const api: FakeApi = {
    metadata: { platform: "win32", versions: { chrome: "128", electron: "32" } },
    health: { get: () => Promise.resolve(ok({ status: "READY", serverInstanceId: "fake", error: null })) },
    cost: {
      getEffectiveCostData: () => {
        calls.push("cost.getEffectiveCostData");
        return Promise.resolve(ok(costState));
      },
      updateCostData: (snapshot) => {
        calls.push(`cost.updateCostData:${JSON.stringify(snapshot)}`);
        costState = snapshot;
        return Promise.resolve(ok(costState));
      },
      getReportDetail: (costReportId) => {
        calls.push(`cost.getReportDetail:${costReportId}`);
        const found = reports.find((r) => r.costReportId === costReportId);
        if (found) return Promise.resolve(ok(found));
        // Return default Q01 detail
        return Promise.resolve(ok({
          costReportId,
          label: "Q01",
          drawingId: init.drawing.id,
          revisionId: init.drawing.currentRevisionId,
          modelId: init.initialModel.modelId,
          quantity: 5,
          createdAt: "2026-08-18T02:00:00.000Z",
          snapshot: {
            input: {
              drawingId: init.drawing.id,
              revisionId: init.drawing.currentRevisionId,
              modelId: init.initialModel.modelId,
              quantity: 5,
              materialId: costState.materials[0]?.id ?? "",
              stockType: "CYLINDER",
              stockSpec: "Ø320 × 820 mm",
              finishedVolume: 0.031,
              allowances: [{ name: "直径方向默认余量", valueMm: 20 }, { name: "长度方向默认余量", valueMm: 20 }],
              costData: costState,
              formulaVersion: "2026.08-p7",
              capturedAt: "2026-08-18T02:00:00.000Z"
            },
            result: {
              rawStockVolume: 0.0659,
              materialCost: 6327.1,
              fixedCostLines: [
                { name: "基础加工成本", amount: 500, basis: "PER_PIECE", subtotal: 500 },
                { name: "包装成本", amount: 80, basis: "PER_BATCH", subtotal: 80 }
              ],
              perPieceCost: 1781.42,
              totalCost: 8907.1,
              currency: "CNY"
            },
            createdAt: "2026-08-18T02:00:00.000Z"
          },
          result: {
            rawStockVolume: 0.0659,
            materialCost: 6327.1,
            fixedCostLines: [
              { name: "基础加工成本", amount: 500, basis: "PER_PIECE", subtotal: 500 },
              { name: "包装成本", amount: 80, basis: "PER_BATCH", subtotal: 80 }
            ],
            perPieceCost: 1781.42,
            totalCost: 8907.1,
            currency: "CNY"
          }
        }));
      },
      createReport: ({ input, createdAt }) => {
        calls.push(`cost.createReport:${JSON.stringify(input)}`);
        const report = {
          costReportId: "report-rev-cost-001-q01",
          label: "Q01",
          drawingId: input.drawingId,
          revisionId: input.revisionId,
          modelId: input.modelId,
          quantity: input.quantity,
          createdAt,
          snapshot: {
            input,
            result: {
              rawStockVolume: 0.0659,
              materialCost: 6327.1,
              fixedCostLines: [
                { name: "基础加工成本", amount: 500, basis: "PER_PIECE", subtotal: 500 },
                { name: "包装成本", amount: 80, basis: "PER_BATCH", subtotal: 80 }
              ],
              perPieceCost: 1781.42,
              totalCost: 8907.1,
              currency: "CNY"
            },
            createdAt
          },
          result: {
            rawStockVolume: 0.0659,
            materialCost: 6327.1,
            fixedCostLines: [
              { name: "基础加工成本", amount: 500, basis: "PER_PIECE", subtotal: 500 },
              { name: "包装成本", amount: 80, basis: "PER_BATCH", subtotal: 80 }
            ],
            perPieceCost: 1781.42,
            totalCost: 8907.1,
            currency: "CNY"
          }
        };
        reports.push(report);
        return Promise.resolve(ok(report));
      }
    },
    drawings: {
      list: () => ok([
        {
          drawingId: init.drawing.id,
          drawingNumber: init.drawing.drawingNumber,
          name: init.drawing.name,
          currentRevisionId: init.drawing.currentRevisionId,
          currentRevisionLabel: "V1",
          currentApprovedModelId: init.initialModel.modelId,
          runStatus: "COMPLETED",
          updatedAt: init.drawing.updatedAt,
          totalRevisionCount: 1,
          latestRevisionLabel: "V1",
          hasOpenClarification: false
        }
      ]),
      getDetail: (id) => ok({
        drawing: {
          drawingId: id,
          drawingNumber: init.drawing.drawingNumber,
          name: init.drawing.name,
          currentRevisionId: init.drawing.currentRevisionId,
          createdAt: init.drawing.createdAt,
          updatedAt: init.drawing.updatedAt
        },
        revisions: [
          {
            revisionId: init.drawing.currentRevisionId,
            revisionLabel: "V1",
            isCurrent: true,
            currentApprovedModelId: init.initialModel.modelId,
            createdAt: init.drawing.createdAt,
            updatedAt: init.drawing.updatedAt
          }
        ]
      }),
      getHistory: (id) => ok({
        drawingId: id,
        drawingNumber: init.drawing.drawingNumber,
        name: init.drawing.name,
        currentRevisionId: init.drawing.currentRevisionId,
        revisions: []
      }),
      getRevisionDetail: (_drawingId, revisionId) => ok({
        revision: {
          revisionId,
          revisionLabel: "V1",
          drawingId: init.drawing.id,
          drawingNumber: init.drawing.drawingNumber,
          drawingName: init.drawing.name,
          isCurrent: true,
          currentApprovedModelId: init.initialModel.modelId,
          sourceFile: {
            fileName: "test.pdf",
            format: "PDF",
            sizeBytes: 1024,
            uploadedAt: init.drawing.createdAt
          },
          createdAt: init.drawing.createdAt
        },
        runs: [],
        models: [
          {
            modelId: init.initialModel.modelId,
            modelLabel: init.initialModel.modelLabel,
            reviewStatus: init.initialModel.reviewStatus,
            isCurrentApproved: true,
            generatedAt: init.initialModel.generatedAt,
            runId: init.initialModel.runId
          }
        ],
        costReports: [
          {
            costReportId: "report-rev-cost-001-q01",
            label: "Q01",
            quantity: 5,
            perPieceCost: 1781.42,
            totalCost: 8907.1,
            currency: "CNY",
            createdAt: "2026-08-18T02:00:00.000Z"
          }
        ],
        facts: [],
        modelingFeedback: []
      }),
      getRevisionHistory: () => ok({ facts: [], modelingFeedback: [] })
    },
    models: {
      getDetail: (id) => ok({
        model: { ...init.initialModel, modelId: id },
        artifacts: [],
        reviews: []
      })
    },
    runs: {
      list: () => ok([]),
      getDetail: () => ok({
        run: {
          runId: "run-cost-001",
          runLabel: "R01",
          drawingId: init.drawing.id,
          revisionId: init.drawing.currentRevisionId,
          status: "COMPLETED",
          stage: null,
          activity: null,
          progressPercent: null,
          createdAt: init.drawing.createdAt,
          startedAt: init.drawing.createdAt,
          completedAt: init.initialModel.generatedAt,
          failureCode: null,
          failureMessage: null,
          modelId: init.initialModel.modelId,
          clarificationRequestId: null
        },
        events: [],
        lastEventSequence: 0
      }),
      create: () => Promise.resolve(ok({})),
      cancel: () => Promise.resolve(ok({}) as never),
      subscribe: () => () => undefined
    }
  };

  const target = globalThis as unknown as { swpanel: FakeApi; __swpanelFake: FakeHook };
  target.swpanel = api;
  target.__swpanelFake = { calls };
}

async function openPage(page: Page, route: string): Promise<void> {
  page.on("pageerror", (error) => console.log(`phase7 pageerror: ${error.message}`));
  await page.addInitScript(installBridge, { drawing, initialModel, costData: initialCostData });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(route, { waitUntil: "networkidle" });
  await expect(page.locator("[data-route-id]")).toBeVisible();
}

test.describe("Phase 7 Cost Data and Cost Estimate in bridge mode", () => {
  test("displays cost data and allows editing in Cost Data page", async ({ page }) => {
    await openPage(page, "/#/cost-data");
    await expect(page.getByRole("heading", { name: "成本数据" })).toBeVisible();
    await expect(page.getByText("42CrMo")).toBeVisible();
    await expect(page.getByText("材料、余量与固定成本的版本化定义将在后续阶段提供")).toHaveCount(0);

    // Edit material price
    const editBtn = page.getByRole("button", { name: "编辑" }).first();
    await editBtn.click();
    const priceInput = page.locator("#edit-material-price");
    await priceInput.fill("5600");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("材料数据已保存")).toBeVisible();
  });

  test("displays cost reports list and approved model in Drawing Costs tab", async ({ page }) => {
    await openPage(page, `/#/drawings/${drawing.id}/revisions/${drawing.currentRevisionId}/costs`);
    await expect(page.getByText("当前正式模型", { exact: true })).toBeVisible();
    await expect(page.getByText("Q01", { exact: true })).toBeVisible();
    await expect(page.getByText("成本测算将在后续阶段提供")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "生成成本测算报告" })).toBeVisible();
  });

  test("generates new report from parameters confirmation page", async ({ page }) => {
    await openPage(page, `/#/drawings/${drawing.id}/revisions/${drawing.currentRevisionId}/costs/new`);
    await expect(page.getByRole("heading", { name: "成本测算参数确认" })).toBeVisible();
    await expect(page.getByText("成本测算参数确认将在后续阶段提供")).toHaveCount(0);

    const generateBtn = page.getByRole("button", { name: "生成成本测算报告" });
    await expect(generateBtn).toBeVisible();
    await generateBtn.click();

    // Navigates to report detail page
    await expect(page.locator('[data-route-id="cost-report"]')).toBeVisible();
    await expect(page.getByText("Q01", { exact: true })).toBeVisible();
    await expect(page.getByText("版本化成本测算报告及其输入快照将在后续阶段提供")).toHaveCount(0);
  });
});
