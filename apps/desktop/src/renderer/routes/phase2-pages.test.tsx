import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFakeBridge, type FakeBridge } from "../test/fake-bridge.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { buildRun } from "../fixtures/runs.js";
import { DrawingMemoryPage } from "./DrawingMemoryPage.js";
import { DrawingOverviewPage } from "./DrawingOverviewPage.js";
import { DrawingsPage } from "./DrawingsPage.js";
import { SettingsPage } from "./SettingsPage.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");

const ROUTES: RouteObject[] = [
  { path: "/drawings", element: <DrawingsPage now={NOW} /> },
  { path: "/drawings/:drawingId/revisions/:revisionId/overview", element: <DrawingOverviewPage now={NOW} /> },
  { path: "/drawings/:drawingId/revisions/:revisionId/memory", element: <DrawingMemoryPage now={NOW} /> },
  { path: "/settings", element: <SettingsPage /> }
];

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "swpanel");
});

function renderApp(initialEntry: string, routes: RouteObject[] = ROUTES) {
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  return render(
    <DrawingRepositoryProvider>
      <RouterProvider router={router} />
    </DrawingRepositoryProvider>
  );
}

/** Every WP6 mutation must never touch run.* — the bridge surface has no such
 *  method, and the UI must never show a Run for Drawing-management actions. */
function expectNoRunActivity() {
  expect(bridge.calls.filter((call) => call.startsWith("run."))).toEqual([]);
  expect(screen.queryByText(/Run [R]\d/)).toBeNull();
}

/** Extracts the recorded clientIntentId values of addRevisionFact bridge calls. */
function factIntentIds(): readonly (string | undefined)[] {
  return bridge.calls
    .filter((call) => call.startsWith("drawings.addRevisionFact:"))
    .map((call) => {
      const input = JSON.parse(call.slice("drawings.addRevisionFact:".length)) as {
        clientIntentId?: string;
      };
      return input.clientIntentId;
    });
}

/** Extracts the recorded clientIntentId values of addModelingFeedback calls. */
function feedbackIntentIds(): readonly (string | undefined)[] {
  return bridge.calls
    .filter((call) => call.startsWith("drawings.addModelingFeedback:"))
    .map((call) => {
      const input = JSON.parse(call.slice("drawings.addModelingFeedback:".length)) as {
        clientIntentId?: string;
      };
      return input.clientIntentId;
    });
}

const SEED_DRAWING = {
  id: "drawing-a",
  drawingNumber: "PDJF001.01",
  name: "轧辊（一）",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  currentRevisionId: "rev-a-1",
  revisions: [
    { id: "rev-a-1", sequence: 1, fileName: "PDJF001.01.pdf", uploadedAt: "2026-08-12T00:00:00.000Z" },
    { id: "rev-a-2", sequence: 2, fileName: "PDJF001.01_V2.pdf", uploadedAt: "2026-08-12T01:00:00.000Z" }
  ]
} as const;

describe("WP6 Drawing Library (real bridge data)", () => {
  it("renders real rows with search and status filter", async () => {
    bridge = createFakeBridge({
      seed: [
        SEED_DRAWING,
        {
          id: "drawing-b",
          drawingNumber: "PDJG002.02",
          name: "阶梯轴",
          createdAt: "2026-08-12T02:00:00.000Z",
          updatedAt: "2026-08-12T02:00:00.000Z",
          revisions: [
            { id: "rev-b-1", sequence: 1, fileName: "PDJG002.02.pdf", uploadedAt: "2026-08-12T02:00:00.000Z" }
          ]
        }
      ]
    });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings");
    expect(await screen.findAllByRole("row")).toHaveLength(3);

    await user.type(screen.getByRole("searchbox", { name: "搜索图号或名称" }), "阶梯轴");
    expect(screen.getByRole("link", { name: "PDJG002.02" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "PDJF001.01" })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "搜索图号或名称" }));
    await user.click(screen.getByRole("button", { name: "尚未建模" }));
    expect(screen.getAllByText("尚未建模").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the real empty state when the Runner library is empty", async () => {
    renderApp("/drawings");
    expect(await screen.findByText("图纸库还是空的")).toBeInTheDocument();
  });

  it("shows an error state with retry, and retry recovers", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING], fail: ["drawings.list"] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings");
    expect(await screen.findByText("图纸库加载失败")).toBeInTheDocument();
    bridge.clearFailure("drawings.list");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "PDJF001.01" })).toBeInTheDocument();
  });

  it("uploads/imports a drawing through the bridge and navigates to it (no Run)", async () => {
    const user = userEvent.setup();
    renderApp("/drawings");
    expect(await screen.findByText("图纸库还是空的")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "上传图纸" })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "上传图纸" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await user.click(within(dialog).getByRole("button", { name: "选择图纸文件" }));
    expect(await within(dialog).findByText("PDJF001.01.pdf")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("图号"), "PDJF100.01");
    await user.type(within(dialog).getByLabelText("名称"), "新轧辊");
    await user.click(within(dialog).getByRole("button", { name: "导入图纸" }));

    expect(await screen.findByRole("heading", { name: "PDJF100.01" })).toBeInTheDocument();
    expect(bridge.state().drawings).toHaveLength(1);
    expect(bridge.state().revisions).toHaveLength(1);
    expect(bridge.calls.some((call) => call.startsWith("drawings.importDrawing"))).toBe(true);
    expectNoRunActivity();
  });

  it("cancelling the import dialog at any step does nothing", async () => {
    const user = userEvent.setup();
    renderApp("/drawings");
    expect(await screen.findByText("图纸库还是空的")).toBeInTheDocument();

    // Cancel before picking a file.
    await user.click(screen.getAllByRole("button", { name: "上传图纸" })[0] as HTMLElement);
    let dialog = screen.getByRole("dialog", { name: "上传图纸" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "上传图纸" })).toBeNull();

    // Cancel after picking a file.
    await user.click(screen.getAllByRole("button", { name: "上传图纸" })[0] as HTMLElement);
    dialog = screen.getByRole("dialog", { name: "上传图纸" });
    await user.click(within(dialog).getByRole("button", { name: "选择图纸文件" }));
    await within(dialog).findByText("PDJF001.01.pdf");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "上传图纸" })).toBeNull();

    expect(bridge.state().drawings).toHaveLength(0);
    expect(bridge.calls.some((call) => call.startsWith("drawings.importDrawing"))).toBe(false);
    expectNoRunActivity();
  });
});

describe("WP6 Drawing Overview (history + revisions)", () => {
  it("renders the real history with the current indicator and set-current action", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/overview");

    expect(await screen.findByText("版本历史")).toBeInTheDocument();
    // Revision labels appear in both the sidebar rail and the history card.
    expect(screen.getAllByText("V1").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("V2").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("当前")).toHaveLength(2); // sidebar + history row

    await user.click(screen.getByRole("button", { name: "设为当前版本" }));
    expect(await screen.findByText(/已设为当前版本/)).toBeInTheDocument();
    expect(bridge.state().drawings[0]?.currentRevisionId).toBe("rev-a-2");
    expect(bridge.calls.some((call) => call.startsWith("drawings.setCurrentRevision"))).toBe(true);
    expectNoRunActivity();
  });

  it("adds a Revision through the file picker without touching the current pointer (no Run)", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/overview");
    expect(await screen.findByText("版本历史")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新增版本" }));
    const dialog = screen.getByRole("dialog", { name: "新增版本" });
    await user.click(within(dialog).getByRole("button", { name: "选择图纸文件" }));
    await within(dialog).findByText("PDJF001.01.pdf");
    await user.click(within(dialog).getByRole("button", { name: "确认新增版本" }));

    expect((await screen.findAllByText("V3")).length).toBeGreaterThanOrEqual(2);
    expect(bridge.state().revisions).toHaveLength(3);
    expect(bridge.state().drawings[0]?.currentRevisionId).toBe("rev-a-1");
    expect(bridge.calls.some((call) => call.startsWith("drawings.addRevision"))).toBe(true);
    expectNoRunActivity();
  });

  it("deep-links with dynamic real ids (no fixture assumptions)", async () => {
    bridge = createFakeBridge({
      seed: [{ ...SEED_DRAWING, id: "9f8e7d6c-1234-4abc-8def-001122334455" }]
    });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    renderApp("/drawings/9f8e7d6c-1234-4abc-8def-001122334455/revisions/rev-a-1/overview");
    expect(await screen.findByRole("heading", { name: "PDJF001.01" })).toBeInTheDocument();
    expect(screen.getByText("版本历史")).toBeInTheDocument();
  });

  it("renders a structured not-found state for unknown drawings without crashing", async () => {
    renderApp("/drawings/does-not-exist/revisions/rev-x-1/overview");
    expect(await screen.findByText("图纸不存在或已被删除")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回图纸库" })).toBeInTheDocument();
  });
});

describe("WP6 Revision Memory (facts + feedback)", () => {
  it("renders real facts/feedback and adds both through the forms (no Run)", async () => {
    bridge = createFakeBridge({
      seed: [
        {
          ...SEED_DRAWING,
          revisions: [
            {
              id: "rev-a-1",
              sequence: 1,
              fileName: "PDJF001.01.pdf",
              uploadedAt: "2026-08-12T00:00:00.000Z",
              facts: [
                {
                  id: "fact-1",
                  revisionId: "rev-a-1",
                  field: "材料",
                  value: "42CrMo",
                  source: "USER_SUPPLEMENT",
                  createdAt: "2026-08-12T00:10:00.000Z"
                }
              ],
              feedback: [
                {
                  id: "fb-1",
                  revisionId: "rev-a-1",
                  content: "右侧台阶直径容易识别错误",
                  source: "USER_SUPPLEMENT",
                  createdAt: "2026-08-12T00:20:00.000Z"
                }
              ]
            }
          ]
        }
      ]
    });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/memory");

    expect(await screen.findByText("Revision Facts")).toBeInTheDocument();
    expect(screen.getByText("42CrMo")).toBeInTheDocument();
    expect(screen.getByText(/右侧台阶直径容易识别错误/)).toBeInTheDocument();

    // Add a fact with field/value/unit/source.
    await user.click(screen.getByRole("button", { name: "添加事实" }));
    let dialog = screen.getByRole("dialog", { name: "添加工程事实" });
    await user.type(within(dialog).getByLabelText("字段名称"), "中心孔深度");
    await user.type(within(dialog).getByLabelText("值"), "85 mm");
    await user.type(within(dialog).getByLabelText("单位"), "mm");
    await user.selectOptions(within(dialog).getByLabelText("来源"), "DRAWING_CONFIRMED");
    await user.click(within(dialog).getByRole("button", { name: "保存事实" }));

    expect(await screen.findByText("工程事实已保存。")).toBeInTheDocument();
    expect(screen.getByText("中心孔深度")).toBeInTheDocument();
    expect(bridge.state().facts).toHaveLength(2);

    // Add feedback.
    await user.click(screen.getByRole("button", { name: "添加反馈" }));
    dialog = screen.getByRole("dialog", { name: "添加建模反馈" });
    await user.type(within(dialog).getByLabelText("反馈内容"), "注意 R5 圆角方向");
    await user.click(within(dialog).getByRole("button", { name: "保存反馈" }));

    expect(await screen.findByText("建模反馈已保存。")).toBeInTheDocument();
    expect(screen.getByText(/注意 R5 圆角方向/)).toBeInTheDocument();
    expect(bridge.state().feedback).toHaveLength(2);
    expect(bridge.calls.some((call) => call.startsWith("drawings.addRevisionFact"))).toBe(true);
    expect(bridge.calls.some((call) => call.startsWith("drawings.addModelingFeedback"))).toBe(true);
    expectNoRunActivity();
  });

  it("validates fact/feedback forms client-side before touching the bridge", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/memory");
    await screen.findByText("Revision Facts");

    await user.click(screen.getByRole("button", { name: "添加事实" }));
    let dialog = screen.getByRole("dialog", { name: "添加工程事实" });
    await user.click(within(dialog).getByRole("button", { name: "保存事实" }));
    expect(await within(dialog).findByText("请填写字段名称。")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await user.click(screen.getByRole("button", { name: "添加反馈" }));
    dialog = screen.getByRole("dialog", { name: "添加建模反馈" });
    await user.click(within(dialog).getByRole("button", { name: "保存反馈" }));
    expect(await within(dialog).findByText("请填写反馈内容。")).toBeInTheDocument();

    expect(bridge.calls.some((call) => call.startsWith("drawings.addRevisionFact"))).toBe(false);
    expect(bridge.calls.some((call) => call.startsWith("drawings.addModelingFeedback"))).toBe(false);
  });

  it("reuses one clientIntentId for retries of the unchanged fact form and mints a new one for a deliberate duplicate", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING], fail: ["drawings.addRevisionFact"] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/memory");
    await screen.findByText("Revision Facts");

    await user.click(screen.getByRole("button", { name: "添加事实" }));
    const dialog = screen.getByRole("dialog", { name: "添加工程事实" });
    await user.type(within(dialog).getByLabelText("字段名称"), "中心孔深度");
    await user.type(within(dialog).getByLabelText("值"), "85 mm");
    await user.click(within(dialog).getByRole("button", { name: "保存事实" }));
    // First attempt fails with the simulated runner outage.
    expect(await within(dialog).findByText(/暂时不可用/)).toBeInTheDocument();
    expect(bridge.state().facts).toHaveLength(0);

    // Retry the UNCHANGED form: the same opaque intent id is reused so Main
    // can deduplicate the retry.
    bridge.clearFailure("drawings.addRevisionFact");
    await user.click(within(dialog).getByRole("button", { name: "保存事实" }));
    expect(await screen.findByText("工程事实已保存。")).toBeInTheDocument();
    expect(bridge.state().facts).toHaveLength(1);

    // A DELIBERATE identical submission is a fresh form submission: it must
    // carry a NEW intent id so it executes as a separate intent.
    await user.click(screen.getByRole("button", { name: "添加事实" }));
    const secondDialog = screen.getByRole("dialog", { name: "添加工程事实" });
    await user.type(within(secondDialog).getByLabelText("字段名称"), "中心孔深度");
    await user.type(within(secondDialog).getByLabelText("值"), "85 mm");
    await user.click(within(secondDialog).getByRole("button", { name: "保存事实" }));
    expect(await screen.findByText("工程事实已保存。")).toBeInTheDocument();
    expect(bridge.state().facts).toHaveLength(2);

    const ids = factIntentIds();
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^swint_[0-9a-f]{32}$/);
    // Retry of the unchanged form reused the id minted for the first attempt.
    expect(ids[1]).toBe(ids[0]);
    // The deliberate identical submission is a separate intent with a new id.
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("reuses one clientIntentId when retrying the unchanged feedback form", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING], fail: ["drawings.addModelingFeedback"] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/memory");
    await screen.findByText("Revision Facts");

    await user.click(screen.getByRole("button", { name: "添加反馈" }));
    const dialog = screen.getByRole("dialog", { name: "添加建模反馈" });
    await user.type(within(dialog).getByLabelText("反馈内容"), "注意 R5 圆角方向");
    await user.click(within(dialog).getByRole("button", { name: "保存反馈" }));
    expect(await within(dialog).findByText(/暂时不可用/)).toBeInTheDocument();
    expect(bridge.state().feedback).toHaveLength(0);

    bridge.clearFailure("drawings.addModelingFeedback");
    await user.click(within(dialog).getByRole("button", { name: "保存反馈" }));
    expect(await screen.findByText("建模反馈已保存。")).toBeInTheDocument();
    expect(bridge.state().feedback).toHaveLength(1);

    const ids = feedbackIntentIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^swint_[0-9a-f]{32}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it("keeps per-Revision isolation: each page shows only its own revision's memory", async () => {
    bridge = createFakeBridge({
      seed: [
        {
          ...SEED_DRAWING,
          revisions: [
            {
              id: "rev-a-1",
              sequence: 1,
              fileName: "PDJF001.01.pdf",
              uploadedAt: "2026-08-12T00:00:00.000Z",
              facts: [
                { id: "fact-1", revisionId: "rev-a-1", field: "材料", value: "42CrMo", source: "USER_SUPPLEMENT", createdAt: "2026-08-12T00:10:00.000Z" }
              ]
            },
            {
              id: "rev-a-2",
              sequence: 2,
              fileName: "PDJF001.01_V2.pdf",
              uploadedAt: "2026-08-12T01:00:00.000Z",
              facts: [
                { id: "fact-2", revisionId: "rev-a-2", field: "材料", value: "45钢", source: "USER_SUPPLEMENT", createdAt: "2026-08-12T01:10:00.000Z" }
              ]
            }
          ]
        }
      ]
    });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const first = renderApp("/drawings/drawing-a/revisions/rev-a-1/memory");
    expect(await screen.findByText("Revision Facts")).toBeInTheDocument();
    expect(screen.getByText("42CrMo")).toBeInTheDocument();
    expect(screen.queryByText("45钢")).not.toBeInTheDocument();
    first.unmount();

    renderApp("/drawings/drawing-a/revisions/rev-a-2/memory");
    expect(await screen.findByText("Revision Facts")).toBeInTheDocument();
    expect(screen.getByText("45钢")).toBeInTheDocument();
    expect(screen.queryByText("42CrMo")).not.toBeInTheDocument();
  });
});

describe("WP6 Storage settings", () => {
  it("loads real settings and saves the workspace root through the bridge", async () => {
    bridge = createFakeBridge({
      settings: {
        dataRoot: "D:\\SWPanelData",
        workspaceRoot: "D:\\SWPanelData\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-13T00:00:00.000Z"
      }
    });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/settings");

    const dataRoot = await screen.findByLabelText("数据目录");
    expect(dataRoot).toHaveValue("D:\\SWPanelData");
    expect(dataRoot).toHaveAttribute("readonly");

    // Wait for the editable draft to be seeded from the loaded settings before
    // editing (the async seed effect can otherwise land between clear and type).
    const workspace = await screen.findByLabelText("Workspace 路径");
    expect(workspace).toHaveValue("D:\\SWPanelData\\workspaces");
    await user.clear(workspace);
    await user.type(workspace, "D:\\SWPanelData\\workspaces2");
    await user.click(screen.getByRole("button", { name: "保存存储设置" }));

    expect(await screen.findByText("存储设置已保存")).toBeInTheDocument();
    expect(bridge.state().settings.workspaceRoot).toBe("D:\\SWPanelData\\workspaces2");
    expect(bridge.state().settings.dataRoot).toBe("D:\\SWPanelData");
    expect(bridge.calls.some((call) => call.startsWith("storage.updateSettings"))).toBe(true);
  });

  it("validates the workspace root and reports truthful bridge failures", async () => {
    bridge = createFakeBridge({
      fail: ["storage.updateSettings"],
      settings: {
        dataRoot: "D:\\SWPanelData",
        workspaceRoot: "D:\\SWPanelData\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-13T00:00:00.000Z"
      }
    });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/settings");
    const workspace = await screen.findByLabelText("Workspace 路径");

    // Empty draft -> client-side validation, no bridge call.
    await user.clear(workspace);
    await user.click(screen.getByRole("button", { name: "保存存储设置" }));
    expect(await screen.findByText("Workspace 路径不能为空。")).toBeInTheDocument();
    expect(bridge.state().settings.workspaceRoot).toBe("D:\\SWPanelData\\workspaces");

    // Valid draft -> bridge failure surfaced truthfully, then retry succeeds.
    await user.type(workspace, "D:\\SWPanelData\\workspaces3");
    await user.click(screen.getByRole("button", { name: "保存存储设置" }));
    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    expect(bridge.state().settings.workspaceRoot).toBe("D:\\SWPanelData\\workspaces");

    bridge.clearFailure("storage.updateSettings");
    await user.click(screen.getByRole("button", { name: "保存存储设置" }));
    expect(await screen.findByText("存储设置已保存")).toBeInTheDocument();
    expect(bridge.state().settings.workspaceRoot).toBe("D:\\SWPanelData\\workspaces3");
  });
});

describe("WP6 conservative Revision deletion (deleteRevision)", () => {
  it("deletes a NON-current revision only after explicit confirmation, then refreshes history", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/overview");
    expect(await screen.findByText("版本历史")).toBeInTheDocument();

    // Only the NON-current revision (V2) offers a delete action: the current
    // revision (V1) is protected and never shows a delete button.
    const deleteButtons = screen.getAllByRole("button", { name: "删除版本" });
    expect(deleteButtons).toHaveLength(1);

    // Explicit confirmation is required: cancelling deletes nothing.
    await user.click(deleteButtons[0] as HTMLElement);
    let dialog = screen.getByRole("dialog", { name: "删除版本" });
    // Explicit confirmation step: the destructive button must be present.
    expect(within(dialog).getByRole("button", { name: "确认删除版本" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "删除版本" })).toBeNull();
    expect(bridge.state().revisions).toHaveLength(2);

    // Confirmed delete removes the revision, refreshes history and navigates
    // back to the current revision.
    await user.click(screen.getAllByRole("button", { name: "删除版本" })[0] as HTMLElement);
    dialog = screen.getByRole("dialog", { name: "删除版本" });
    await user.click(within(dialog).getByRole("button", { name: "确认删除版本" }));

    expect(await screen.findByText(/版本已删除/)).toBeInTheDocument();
    expect(bridge.state().revisions).toHaveLength(1);
    expect(bridge.state().revisions[0]?.id).toBe("rev-a-1");
    expect(bridge.state().drawings[0]?.currentRevisionId).toBe("rev-a-1");
    expect(bridge.calls.some((call) => call.startsWith("drawings.deleteRevision"))).toBe(true);
    expectNoRunActivity();
  });

  it("shows the structured failure when the delete is refused or fails, then retry succeeds", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING], fail: ["drawings.deleteRevision"] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/overview");
    expect(await screen.findByText("版本历史")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "删除版本" })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "删除版本" });
    await user.click(within(dialog).getByRole("button", { name: "确认删除版本" }));
    expect(await within(dialog).findByText(/暂时不可用/)).toBeInTheDocument();
    expect(bridge.state().revisions).toHaveLength(2);

    bridge.clearFailure("drawings.deleteRevision");
    await user.click(within(dialog).getByRole("button", { name: "确认删除版本" }));
    expect(await screen.findByText(/版本已删除/)).toBeInTheDocument();
    expect(bridge.state().revisions).toHaveLength(1);
  });

  it("never offers deletion for the CURRENT revision even after switching", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING] });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-2/overview");
    expect(await screen.findByText("版本历史")).toBeInTheDocument();

    // V2 is not current yet: exactly one delete button (for V1).
    expect(screen.getAllByRole("button", { name: "删除版本" })).toHaveLength(1);

    // Switch current to V2: now V2 has NO delete button and V1 does.
    await user.click(screen.getAllByRole("button", { name: "设为当前版本" })[0] as HTMLElement);
    expect(await screen.findByText(/已设为当前版本/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "删除版本" })).toHaveLength(1);
  });

  it("blocks deletion of a revision that owns Runs with a disabled confirm", async () => {
    bridge = createFakeBridge({ seed: [SEED_DRAWING] });
    bridge.addRun(
      buildRun({
        id: "run-a-2",
        number: "R01",
        drawingId: "drawing-a",
        revisionId: "rev-a-2",
        status: "COMPLETED",
        stage: null,
        inputSnapshot: {
          drawingId: "drawing-a",
          revisionId: "rev-a-2",
          originalFileRef: "rev-a-2",
          revisionFacts: [],
          modelingFeedback: [],
          promptTemplateVersion: "test-v1",
          skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) },
          agentConfigId: "test-config",
          createdAt: "2026-08-12T01:30:00.000Z"
        },
        createdAt: "2026-08-12T01:30:00.000Z",
        completedAt: "2026-08-12T02:00:00.000Z"
      })
    );
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });

    const user = userEvent.setup();
    renderApp("/drawings/drawing-a/revisions/rev-a-1/overview");
    expect(await screen.findByText("版本历史")).toBeInTheDocument();

    // V2 is not current and owns a Run: the delete dialog blocks the confirm.
    await user.click(screen.getAllByRole("button", { name: "删除版本" })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "删除版本" });
    expect(await within(dialog).findByText(/不可直接删除/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/次建模记录/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认删除版本" })).toBeDisabled();
    // Nothing was deleted.
    expect(bridge.state().revisions).toHaveLength(2);
  });
});
