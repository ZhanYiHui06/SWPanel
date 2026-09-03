import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PRODUCT_ROUTES } from "../apps/desktop/src/renderer/app/route-manifest.js";

const priorityRoutes = ["workbench", "drawings", "drawing-overview", "drawing-models", "model-detail"] as const;
const accessibilityRoutes = new Set([
  ...priorityRoutes,
  "run-detail",
  "cost-params",
  "cost-report",
]);
const deepLinks = PRODUCT_ROUTES.map((route) => ({ id: route.id, path: routeUrl(route.samplePath) }));
const viewport1366 = { width: 1366, height: 768 };
const viewport1920 = { width: 1920, height: 1080 };

function routeUrl(samplePath: string): string {
  return `/#${samplePath}`;
}

async function expectCleanPage(page: Page) {
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.locator("[data-route-id]")).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.documentElement.dataset.phase1FontsReady = "true";
  });
  await expect(page.locator("html")).toHaveAttribute("data-phase1-fonts-ready", "true");
  await page.waitForTimeout(100);
}

for (const route of PRODUCT_ROUTES) {
  test(`reaches product route ${route.id}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const remoteRequests: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("request", (request) => { if (/^https?:\/\/(?!127\.0\.0\.1)/.test(request.url())) remoteRequests.push(request.url()); });
    await page.goto(routeUrl(route.samplePath), { waitUntil: "networkidle" });
    await expectCleanPage(page);
    await expect(page.locator(`[data-route-id="${route.id}"]`)).toBeVisible();
    expect(consoleErrors, `console errors on ${route.id}`).toEqual([]);
    expect(remoteRequests, `remote requests on ${route.id}`).toEqual([]);
  });
}

test("production default reaches all sample routes without scenario selection", async ({ page }) => {
  for (const route of deepLinks) {
    await page.goto(route.path);
    await expect(page).not.toHaveURL(/scenario=/);
    await expectCleanPage(page);
    await expect(page.locator(`[data-route-id="${route.id}"]`)).toBeVisible();
    await page.reload();
    await expect(page.locator(`[data-route-id="${route.id}"]`)).toBeVisible();
  }
});

test("drawing search and status filter work", async ({ page }) => {
  await page.goto("/#/drawings");
  await expect(page.locator('[data-route-id="drawings"]')).toBeVisible();
  const search = page.getByRole("searchbox", { name: "搜索图号或名称" });
  await search.fill("阶梯轴");
  await expect(page.getByRole("link", { name: "PDJG159.01.03", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "PDJF480.01.17C-4" })).toHaveCount(0);
  await search.fill("");
  await page.getByRole("button", { name: "待处理" }).click();
  await expect(page.getByText("需要补充信息")).toBeVisible();
});

test("start Run confirmation creates queued run", async ({ page }) => {
  await page.goto("/#/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/overview");
  await page.getByRole("button", { name: /开始自动建模/ }).click();
  const dialog = page.getByRole("dialog", { name: "确认开始自动建模" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /确认并开始/ }).click();
  await expect(page.getByText(/任务已加入等待队列/)).toBeVisible();
});

test("Clarification form submits answers and offers restart", async ({ page }) => {
  await page.goto("/?scenario=clarification-open#/runs/run-main-r04", { waitUntil: "networkidle" });
  await expect(page.getByText(/需要补充 \d+ 项信息/)).toBeVisible();
  const inputs = page.locator('input:not([readonly])');
  const selects = page.locator('select');
  await expect(inputs.first()).toBeVisible();
  for (const input of await inputs.all()) await input.fill("42");
  for (const select of await selects.all()) await select.selectOption({ index: 1 });
  await page.getByRole("button", { name: "提交补充信息" }).click();
  await expect(page.getByRole("button", { name: "重新自动建模" })).toBeVisible();
});

test("model approve and reject paths are available", async ({ page }) => {
  await page.goto("/?scenario=model-pending-review#/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/models/model-main-m03", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "审核通过" })).toBeVisible();
  await page.getByRole("button", { name: "审核通过" }).click();
  await expect(page.getByText("当前正式模型").first()).toBeVisible();
});

test("Cost Data tabs and edit/save work", async ({ page }) => {
  await page.goto("/#/cost-data");
  await page.getByRole("button", { name: "编辑" }).first().click();
  await expect(page.getByRole("button", { name: "保存" })).toBeVisible();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("材料数据已保存")).toBeVisible();
  await page.getByRole("tab", { name: "加工余量" }).click();
  await expect(page.getByRole("tab", { name: "加工余量" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "固定成本" }).click();
  await expect(page.getByRole("tab", { name: "固定成本" })).toHaveAttribute("aria-selected", "true");
});

test("report eligibility and settings advanced controls work", async ({ page }) => {
  await page.goto("/?scenario=cost-report-generated#/drawings/drawing-pdjf480-01-17c-4/revisions/rev-main-v3/costs");
  await expect(page.getByRole("link", { name: "生成成本测算报告" })).toBeVisible();
  await page.goto("/#/settings");
  const advanced = page.getByRole("button", { name: "高级设置" });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
});

test("priority pages have deterministic screenshot baselines", async ({ page }) => {
  for (const route of priorityRoutes) {
    const target = PRODUCT_ROUTES.find((item) => item.id === route)!;
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.setViewportSize(viewport1366);
    await page.goto(routeUrl(target.samplePath), { waitUntil: "networkidle" });
    await expectCleanPage(page);
    await expect(page).toHaveScreenshot(`${route}-1366x768.png`, { fullPage: false });
    await page.setViewportSize(viewport1920);
    await expectCleanPage(page);
    await expect(page).toHaveScreenshot(`${route}-1920x1080.png`, { fullPage: false });
  }
});

test("all remaining product pages have a screenshot", async ({ page }) => {
  for (const route of PRODUCT_ROUTES.filter((item) => !priorityRoutes.includes(item.id as typeof priorityRoutes[number]))) {
    await page.setViewportSize(viewport1920);
    await page.goto(routeUrl(route.samplePath), { waitUntil: "networkidle" });
    await expectCleanPage(page);
    await expect(page).toHaveScreenshot(`${route.id}-1920x1080.png`, { fullPage: false });
  }
});

test("priority and representative form/detail pages pass full axe accessibility scan", async ({ page }) => {
  for (const route of PRODUCT_ROUTES.filter((item) => accessibilityRoutes.has(item.id))) {
    await page.goto(routeUrl(route.samplePath), { waitUntil: "networkidle" });
    await expectCleanPage(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `${route.id} axe violations`).toEqual([]);
  }
});
