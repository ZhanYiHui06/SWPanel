/* eslint-disable @typescript-eslint/require-await -- bridge stubs intentionally mirror Promise-returning preload methods. */
import { expect, test, type Page } from "@playwright/test";

async function installSettingsBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const bridgeResult = (data: unknown) => ({ ok: true, data });
    const settings = {
      dataRoot: "C:\\SWPanelData",
      workspaceRoot: "C:\\SWPanelData\\workspaces",
      constraint: "LOCAL_FIXED_NTFS",
      updatedAt: "2026-08-18T00:00:00.000Z"
    };
    let apiKey: string | null = null;
    const bridge = {
      metadata: { platform: "win32", versions: { chrome: "128", electron: "43" } },
      health: { get: async () => bridgeResult({ status: "READY", serverInstanceId: "phase8-browser" }) },
      files: { selectDrawingFile: async () => bridgeResult(null) },
      storage: {
        getSettings: async () => bridgeResult({ settings: { ...settings } }),
        updateSettings: async (next: typeof settings) => bridgeResult({ settings: { ...next } })
      },
      drawings: {
        list: async () => bridgeResult([]),
        getDetail: async () => bridgeResult({ drawing: { drawingId: "drawing-a", drawingNumber: "D-A", name: "测试图纸", currentRevisionId: "rev-a", createdAt: settings.updatedAt, updatedAt: settings.updatedAt }, revisions: [] }),
        getHistory: async () => bridgeResult({ revisions: [] }),
        getRevisionDetail: async () => bridgeResult({ revision: {}, runs: [], models: [], costReports: [], facts: [], modelingFeedback: [] }),
        getRevisionHistory: async () => bridgeResult({ facts: [], modelingFeedback: [] })
      },
      models: { getDetail: async () => bridgeResult({}) , review: async () => bridgeResult({}) },
      runs: { list: async () => bridgeResult([]), getDetail: async () => bridgeResult({}), create: async () => bridgeResult({}), cancel: async () => bridgeResult({}), subscribe: () => () => undefined, delete: async () => bridgeResult({}) },
      clarifications: { get: async () => bridgeResult(null), submit: async () => bridgeResult(null) },
      cost: { getEffectiveCostData: async () => bridgeResult({}), updateCostData: async (value: unknown) => bridgeResult(value), getReportDetail: async () => bridgeResult({}), createReport: async () => bridgeResult({}), deleteReport: async () => bridgeResult({}) },
      system: { getRecoveryStatus: async () => bridgeResult(null) },
      secrets: {
        getStatus: async () => bridgeResult({ hasApiKey: apiKey !== null, maskedApiKey: apiKey === null ? null : `${apiKey.slice(0, 3)}****${apiKey.slice(-4)}` }),
        setApiKey: async (value: string) => { apiKey = value; return bridgeResult({ hasApiKey: true, maskedApiKey: `${value.slice(0, 3)}****${value.slice(-4)}` }); },
        clearApiKey: async () => { apiKey = null; return bridgeResult({ hasApiKey: false, maskedApiKey: null }); }
      }
    };
    Object.defineProperty(window, "swpanel", { configurable: true, value: bridge });
  });
}

test.describe("Phase 8 notifications, secrets, and deletion safeguards", () => {
  test("Notifications & Toasts opens the drawer and dismisses a toast", async ({ page }) => {
    await installSettingsBridge(page);
    await page.goto("/#/settings", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "通知" }).click();
    const drawer = page.getByRole("dialog", { name: "通知中心" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("暂无通知")).toBeVisible();
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.locator(".notification-overlay").click({ position: { x: 5, y: 5 } });
    await expect(drawer).toBeHidden();

    await page.getByRole("textbox", { name: "新 Agent API Key" }).fill("sk-toast-1234");
    await page.getByRole("button", { name: "保存密钥" }).click();
    const toast = page.getByRole("status").filter({ hasText: "API Key 已保存" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "关闭通知" }).click();
    await expect(toast).toBeHidden();
  });

  test("Settings API Key configuration saves a masked key and clears it", async ({ page }) => {
    await installSettingsBridge(page);
    await page.goto("/#/settings", { waitUntil: "networkidle" });
    await expect(page.getByText("API Key 状态")).toBeVisible();
    await expect(page.getByText("未配置", { exact: true }).first()).toBeVisible();
    await page.getByRole("textbox", { name: "新 Agent API Key" }).fill("sk-phase8-secret-1234");
    await page.getByRole("button", { name: "保存密钥" }).click();
    await expect(page.getByText("sk-****1234", { exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "API Key 已保存" })).toBeVisible();
    await page.getByRole("button", { name: "清除密钥" }).click();
    await expect(page.getByText("未配置", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "API Key 已清除" })).toBeVisible();
  });

  test("Deletion & Cascade Protection blocks dependent revisions and confirms terminal deletions", async ({ page }) => {
    await page.goto("/?scenario=cost-report-generated#/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/overview", { waitUntil: "networkidle" });
    await expect(page.getByText("版本历史")).toBeVisible();
    // The current revision is protected: only historical revisions expose deletion.
    await expect(page.getByRole("button", { name: "删除版本" })).toHaveCount(2);
    const revisionDelete = page.getByRole("button", { name: "删除版本" }).first();
    await revisionDelete.click();
    const revisionDialog = page.getByRole("dialog", { name: "删除版本" });
    await expect(revisionDialog).toBeVisible();
    await expect(revisionDialog.getByRole("button", { name: "确认删除版本" })).toBeEnabled();
    await revisionDialog.getByRole("button", { name: "取消" }).click();

    await page.goto("/?scenario=cost-report-generated#/runs/run-main-r05", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "删除记录" }).click();
    const runDialog = page.getByRole("dialog", { name: "删除记录" });
    await expect(runDialog).toBeVisible();
    await runDialog.getByRole("button", { name: "确认删除记录" }).click();
    await expect(page).toHaveURL(/#\/runs$/);

    await page.goto("/?scenario=cost-report-generated#/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/costs", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "删除报告" }).first().click();
    const reportDialog = page.getByRole("dialog", { name: "删除报告" });
    await expect(reportDialog).toBeVisible();
    await reportDialog.getByRole("button", { name: "确认删除报告" }).click();
    await expect(page.getByRole("status").filter({ hasText: "报告已删除" })).toBeVisible();
  });
});
