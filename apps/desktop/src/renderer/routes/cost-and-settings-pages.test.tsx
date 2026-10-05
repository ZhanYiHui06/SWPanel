import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContainer } from "@swpanel/ui";

import { MockRepository } from "../features/mock-repository/mock-repository.js";
import { RepositoryProvider } from "../features/repository-provider.js";
import { MockBridgeDrawingRepository } from "../features/bridge-repository/mock-bridge-repository.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import {
  NotificationProvider,
  useNotifications
} from "../features/notifications/notification-context.js";
import { createFakeBridge } from "../test/fake-bridge.js";
import { REVISION_IDS, REPORT_IDS } from "../fixtures/index.js";
import { CostDataPage } from "./CostDataPage.js";
import { CostParamsPage } from "./CostParamsPage.js";
import { CostReportPage } from "./CostReportPage.js";
import { DrawingCostsPage } from "./DrawingCostsPage.js";
import { DrawingMemoryPage } from "./DrawingMemoryPage.js";
import { SettingsPage } from "./SettingsPage.js";

/** Fixed baseline so relative dates render deterministically. */
const NOW = new Date("2026-08-10T23:59:00.000Z");

import { MockCostRepository } from "../features/cost-repository/mock-cost-repository.js";
import { CostRepositoryProvider } from "../features/cost-repository/cost-repository-provider.js";

function renderRoute(repository: MockRepository, path: string, element: React.ReactElement) {
  const pattern =
    path.startsWith("/drawings/drawing-main/revisions/revision-v3/costs/")
      ? "/drawings/:drawingId/revisions/:revisionId/costs/:reportId"
      : path.includes("/costs/new")
        ? "/drawings/:drawingId/revisions/:revisionId/costs/new"
        : path.endsWith("/costs")
          ? "/drawings/:drawingId/revisions/:revisionId/costs"
          : path.endsWith("/memory")
            ? "/drawings/:drawingId/revisions/:revisionId/memory"
            : path;
  return render(
    <DrawingRepositoryProvider repository={new MockBridgeDrawingRepository(repository)}>
      <CostRepositoryProvider repository={new MockCostRepository(repository)}>
        <RepositoryProvider repository={repository}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
            </Routes>
          </MemoryRouter>
        </RepositoryProvider>
      </CostRepositoryProvider>
    </DrawingRepositoryProvider>
  );
}

/** Mounts the notify toast stack so SettingsPage API-key feedback is visible. */
function SettingsToastHost(): React.JSX.Element {
  const { toasts, dismissToast } = useNotifications();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

/** Renders SettingsPage inside the NotificationProvider with a toast host. */
function renderSettingsWithToasts(repository: MockRepository): void {
  render(
    <DrawingRepositoryProvider repository={new MockBridgeDrawingRepository(repository)}>
      <CostRepositoryProvider repository={new MockCostRepository(repository)}>
        <RepositoryProvider repository={repository}>
          <NotificationProvider>
            <SettingsToastHost />
            <MemoryRouter initialEntries={["/settings"]}>
              <Routes>
                <Route path="/settings" element={<SettingsPage now={NOW} />} />
              </Routes>
            </MemoryRouter>
          </NotificationProvider>
        </RepositoryProvider>
      </CostRepositoryProvider>
    </DrawingRepositoryProvider>
  );
}

const V3_MEMORY_PATH = "/drawings/drawing-main/revisions/revision-v3/memory";const V3_COSTS_PATH = "/drawings/drawing-main/revisions/revision-v3/costs";
const V3_PARAMS_PATH = "/drawings/drawing-main/revisions/revision-v3/costs/new";
const V3_REPORT_Q03_PATH = "/drawings/drawing-main/revisions/revision-v3/costs/report-q03";

afterEach(() => {
  cleanup();
});

describe("Drawing Workspace · 版本记忆", () => {
  it("renders revision facts with their source labels and source run", async () => {
    const repository = MockRepository.create("clarification-answered");
    render(
      <DrawingRepositoryProvider repository={new MockBridgeDrawingRepository(repository)}>
        <MemoryRouter initialEntries={[V3_MEMORY_PATH]}>
          <Routes>
            <Route path="/drawings/:drawingId/revisions/:revisionId/memory" element={<DrawingMemoryPage now={NOW} />} />
          </Routes>
        </MemoryRouter>
      </DrawingRepositoryProvider>
    );

    expect(await screen.findByText("Revision Facts")).toBeInTheDocument();
    expect(screen.getByText("中心孔深度")).toBeInTheDocument();
    expect(screen.getByText("85 mm")).toBeInTheDocument();
    expect(screen.getByText("材料")).toBeInTheDocument();
    expect(screen.getByText("42CrMo")).toBeInTheDocument();
    expect(screen.getByText("R5 圆角位置")).toBeInTheDocument();
    expect(screen.getByText("右侧轴肩外缘")).toBeInTheDocument();
    // The canonical clarification upsert replaces the drawing-confirmed `材料`
    // fact with one CLARIFICATION-sourced fact by stable field identity, so
    // every fact on the answered revision renders as a user supplement sourced
    // from Run R04 — never a coexisting `图纸确认` duplicate.
    expect(screen.getAllByText("来源：用户补充")).toHaveLength(3);
    expect(screen.queryByText("来源：图纸确认")).not.toBeInTheDocument();
    expect(screen.getAllByText("R04")).toHaveLength(3);
    const materialFacts = repository
      .listFacts()
      .filter((fact) => fact.revisionId === REVISION_IDS.mainV3 && fact.field === "材料");
    expect(materialFacts).toHaveLength(1);
    expect(materialFacts[0]?.source).toBe("CLARIFICATION");
    expect(materialFacts[0]?.value).toBe("42CrMo");
  });

  it("renders modeling feedback with model labels from rejected reviews", async () => {
    const repository = MockRepository.create("model-rejected");
    render(
      <DrawingRepositoryProvider repository={new MockBridgeDrawingRepository(repository)}>
        <MemoryRouter initialEntries={[V3_MEMORY_PATH]}>
          <Routes>
            <Route path="/drawings/:drawingId/revisions/:revisionId/memory" element={<DrawingMemoryPage now={NOW} />} />
          </Routes>
        </MemoryRouter>
      </DrawingRepositoryProvider>
    );

    expect(await screen.findByText("Modeling Feedback")).toBeInTheDocument();
    expect(screen.getAllByText("来源：模型审核退回").length).toBe(2);
    expect(screen.getByText("M02")).toBeInTheDocument();
    expect(screen.getByText("M03")).toBeInTheDocument();
    expect(screen.getByText(/右侧台阶直径识别错误/)).toBeInTheDocument();
  });
});

describe("Drawing Workspace · 成本测算", () => {
  it("offers report generation only for the current approved model", () => {
    const repository = MockRepository.create("cost-report-generated");
    renderRoute(repository, V3_COSTS_PATH, <DrawingCostsPage now={NOW} />);

    expect(screen.getByText("当前正式模型")).toBeInTheDocument();
    expect(screen.getByText("审核通过")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "生成成本测算报告" })).toBeInTheDocument();
  });

  it("shows the empty state when the revision has no current approved model", () => {
    const repository = MockRepository.create("no-current-approved-model");
    renderRoute(repository, V3_COSTS_PATH, <DrawingCostsPage now={NOW} />);

    expect(screen.getByText("当前版本暂无正式模型")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "生成成本测算报告" })).not.toBeInTheDocument();
  });

  it("lists the historical reports Q01/Q02/Q03 with costs", () => {
    const repository = MockRepository.create("cost-report-generated");
    renderRoute(repository, V3_COSTS_PATH, <DrawingCostsPage now={NOW} />);

    expect(screen.getByText("历史报告")).toBeInTheDocument();
    expect(screen.getByText("Q03")).toBeInTheDocument();
    expect(screen.getByText("Q02")).toBeInTheDocument();
    expect(screen.getByText("Q01")).toBeInTheDocument();
    // Canonical synthetic totals from the deterministic fixture calculator
    // (Q03 = quantity 10, Q02 = quantity 1, Q01 = quantity 5).
    expect(screen.getByText("¥18,734.20")).toBeInTheDocument();
    // Q02 has quantity 1, so per-piece and total both render as ¥1,945.
    expect(screen.getAllByText("¥1,945.42")).toHaveLength(2);
    expect(screen.getByText("¥9,407.10")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "查看详情" })).toHaveLength(3);
    expect(screen.getByText(/不构成最终对客报价/)).toBeInTheDocument();
  });
});

describe("成本测算参数确认 (New Report)", () => {
  it("creates a report through the repository with the confirmed quantity", async () => {
    const repository = MockRepository.create("cost-report-generated");
    const user = userEvent.setup();
    renderRoute(repository, V3_PARAMS_PATH, <CostParamsPage now={NOW} />);

    expect(screen.getByText("模型信息")).toBeInTheDocument();
    expect(screen.getByText("MODEL M03")).toBeInTheDocument();
    expect(screen.getByText("成本数据摘要")).toBeInTheDocument();
    expect(screen.getAllByText(/42CrMo/)[0]).toBeInTheDocument();

    const quantity = screen.getByLabelText("数量");
    await user.clear(quantity);
    await user.type(quantity, "5");
    await user.click(screen.getByRole("button", { name: "生成成本测算报告" }));

    const reports = repository.listReports();
    expect(reports).toHaveLength(4);
    const created = reports[3];
    expect(created?.label).toBe("Q04");
    expect(created?.snapshot.input.quantity).toBe(5);
    expect(created?.snapshot.input.materialId).toBe("material-42crmo");
    expect(created?.snapshot.input.stockType).toBe("CYLINDER");
    expect(created?.modelId).toBe("model-main-m03");
  });

  it("blocks report creation when the revision has no approved model", () => {
    const repository = MockRepository.create("no-current-approved-model");
    renderRoute(repository, V3_PARAMS_PATH, <CostParamsPage now={NOW} />);

    expect(screen.getByText("当前版本暂无正式模型")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成成本测算报告" })).not.toBeInTheDocument();
  });
});

describe("成本测算报告详情", () => {
  it("renders the five report sections from the frozen snapshot", () => {
    const repository = MockRepository.create("cost-report-generated");
    renderRoute(repository, V3_REPORT_Q03_PATH, <CostReportPage now={NOW} />);

    expect(screen.getByText("Q03")).toBeInTheDocument();
    expect(screen.getByText("内部参考")).toBeInTheDocument();
    expect(screen.getByText("零件与模型信息")).toBeInTheDocument();
    expect(screen.getByText("毛坯与原料参数")).toBeInTheDocument();
    expect(screen.getByText("成本计算依据")).toBeInTheDocument();
    expect(screen.getByText("成本明细")).toBeInTheDocument();
    expect(screen.getByText("成本测算结果")).toBeInTheDocument();
    expect(screen.getByText("PDJF480.01.17C-4")).toBeInTheDocument();
    expect(screen.getByText("Ø320 × 820 mm")).toBeInTheDocument();
    // Q03 canonical synthetic result (quantity 10): per-piece ¥1,873 / total ¥18,734.
    expect(screen.getByText("¥1,873.42")).toBeInTheDocument();
    expect(screen.getByText("总估算成本（10 件）")).toBeInTheDocument();
    expect(screen.getByText("¥18,734.20")).toBeInTheDocument();
    expect(screen.getByText(/不构成最终对客报价/)).toBeInTheDocument();
  });

  it("redirects to the drawings library for an unknown report id", () => {
    const repository = MockRepository.create("cost-report-generated");
    render(
      <RepositoryProvider repository={repository}>
        <MemoryRouter
          initialEntries={["/drawings/drawing-main/revisions/revision-v3/costs/report-unknown"]}
        >
          <Routes>
            <Route
              path="/drawings/:drawingId/revisions/:revisionId/costs/:reportId"
              element={<CostReportPage now={NOW} />}
            />
            <Route path="/drawings" element={<div>图纸库</div>} />
          </Routes>
        </MemoryRouter>
      </RepositoryProvider>
    );

    expect(screen.getByText("图纸库")).toBeInTheDocument();
  });
});

describe("成本报告删除 (Step 4)", () => {
  it("deletes a report from its detail page and navigates back to the costs list", async () => {
    const repository = MockRepository.create("cost-report-generated");
    const user = userEvent.setup();
    render(
      <DrawingRepositoryProvider repository={new MockBridgeDrawingRepository(repository)}>
        <CostRepositoryProvider repository={new MockCostRepository(repository)}>
          <RepositoryProvider repository={repository}>
            <NotificationProvider>
              <SettingsToastHost />
              <MemoryRouter initialEntries={[V3_REPORT_Q03_PATH]}>
                <Routes>
                  <Route
                    path="/drawings/:drawingId/revisions/:revisionId/costs/:reportId"
                    element={<CostReportPage now={NOW} />}
                  />
                  <Route
                    path="/drawings/:drawingId/revisions/:revisionId/costs"
                    element={<DrawingCostsPage now={NOW} />}
                  />
                </Routes>
              </MemoryRouter>
            </NotificationProvider>
          </RepositoryProvider>
        </CostRepositoryProvider>
      </DrawingRepositoryProvider>
    );

    expect(await screen.findByText("Q03")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除报告" }));
    await user.click(screen.getByRole("button", { name: "确认删除报告" }));

    expect(await screen.findByText("报告已删除")).toBeInTheDocument();
    // Navigated back to the costs list; Q03 is gone from the repository + table.
    expect(await screen.findByText("历史报告")).toBeInTheDocument();
    expect(repository.listReports().some((report) => report.id === REPORT_IDS.q03)).toBe(false);
    expect(screen.queryByText("Q03")).toBeNull();
  });

  it("deletes a report directly from the history table", async () => {
    const repository = MockRepository.create("cost-report-generated");
    const user = userEvent.setup();
    render(
      <DrawingRepositoryProvider repository={new MockBridgeDrawingRepository(repository)}>
        <CostRepositoryProvider repository={new MockCostRepository(repository)}>
          <RepositoryProvider repository={repository}>
            <NotificationProvider>
              <SettingsToastHost />
              <MemoryRouter initialEntries={[V3_COSTS_PATH]}>
                <Routes>
                  <Route
                    path="/drawings/:drawingId/revisions/:revisionId/costs"
                    element={<DrawingCostsPage now={NOW} />}
                  />
                </Routes>
              </MemoryRouter>
            </NotificationProvider>
          </RepositoryProvider>
        </CostRepositoryProvider>
      </DrawingRepositoryProvider>
    );

    expect(await screen.findByText("历史报告")).toBeInTheDocument();
    // Q01/Q02/Q03 rows each expose a 删除报告 action.
    const deleteButtons = screen.getAllByRole("button", { name: "删除报告" });
    expect(deleteButtons.length).toBe(3);

    // Delete the first row (Q01).
    await user.click(deleteButtons[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "确认删除报告" }));

    expect(await screen.findByText("报告已删除")).toBeInTheDocument();
    expect(repository.listReports().some((report) => report.id === REPORT_IDS.q01)).toBe(false);
    expect(screen.queryByText("Q01")).toBeNull();
    expect(screen.getByText("Q03")).toBeInTheDocument();
  });
});

describe("成本数据", () => {
  it("edits a material price through the repository", async () => {
    const repository = MockRepository.create("run-running");
    const user = userEvent.setup();
    renderRoute(repository, "/cost-data", <CostDataPage now={NOW} />);

    expect(screen.getByText("材料数据")).toBeInTheDocument();
    expect(screen.getByText("42CrMo")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const price = screen.getByLabelText("采购价格");
    await user.clear(price);
    await user.type(price, "5300");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const material = repository
      .getCostData()
      .materials.find((candidate) => candidate.id === "material-42crmo");
    expect(material?.purchasePrice).toBe(5300);
  });

  it("switches between the three cost data tabs", async () => {
    const repository = MockRepository.create("run-running");
    const user = userEvent.setup();
    renderRoute(repository, "/cost-data", <CostDataPage now={NOW} />);

    await user.click(screen.getByRole("tab", { name: "加工余量" }));
    // The cylinder allowance definition carries two rows (直径/长度), both
    // labelled 圆柱毛坯 with the same default allowance.
    expect(screen.getAllByText("圆柱毛坯")).toHaveLength(2);
    expect(screen.getAllByText("+20 mm")).toHaveLength(5);

    await user.click(screen.getByRole("tab", { name: "固定成本" }));
    expect(screen.getByText("基础加工成本")).toBeInTheDocument();
    expect(screen.getByText("包装成本")).toBeInTheDocument();
    expect(screen.getByText(/默认参与每次成本测算/)).toBeInTheDocument();
  });
});

describe("设置", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const data = path.endsWith("/runtime") ? { platform: "darwin", modelingConfigured: false, solidWorksVersion: null, skillName: null, baseUrl: "https://api.openai.com/v1", model: null, reason: "建模执行器未配置" } : path.endsWith("test-connection") ? { connected: true } : { hasApiKey: false, maskedApiKey: null };
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it("renders the confirmed settings groups", () => {
    const repository = MockRepository.create("run-running");
    renderRoute(repository, "/settings", <SettingsPage now={NOW} />);

    expect(screen.getByText("SolidWorks")).toBeInTheDocument();
    expect(screen.getByText("文件存储")).toBeInTheDocument();
    expect(screen.getByText("Agent / API")).toBeInTheDocument();
    expect(screen.getByText("高级设置")).toBeInTheDocument();
    // Mock (demo) mode never claims a real platform/key state.
    expect(screen.getByLabelText("SolidWorks 程序路径")).toHaveValue(
      "当前为演示数据模式，不连接真实服务，也不会读取或保存密钥。"
    );
    expect(screen.getByLabelText("新 Agent API Key")).toHaveAttribute("type", "password");
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
  });

  it("lets the Web user switch between an API key and the local Codex CLI login", async () => {
    window.history.pushState({}, "", "/?mode=http");
    let authStatus = { authMode: "api_key", codexLogin: { loggedIn: false, method: null as string | null } };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let data: unknown = { hasApiKey: false, maskedApiKey: null };
      if (path.endsWith("/runtime")) data = { platform: "darwin", modelingConfigured: false, solidWorksVersion: null, skillName: null, baseUrl: "https://api.openai.com/v1", model: null, reason: "建模执行器未配置" };
      else if (path.endsWith("/auth-mode")) {
        if (init?.method === "POST") authStatus = { ...authStatus, authMode: (JSON.parse(init.body as string) as { authMode: string }).authMode };
        data = authStatus;
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
    }));
    try {
      const user = userEvent.setup();
      renderSettingsWithToasts(MockRepository.create("run-running"));
      const apiKeyOption = await screen.findByRole("radio", { name: "使用 API Key" });
      expect(apiKeyOption).toBeChecked();
      expect(screen.getByLabelText("新 Agent API Key")).toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "使用本机 Codex CLI 登录" }));
      expect(await screen.findByText("认证方式已切换")).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "使用本机 Codex CLI 登录" })).toBeChecked();
      expect(screen.queryByLabelText("新 Agent API Key")).not.toBeInTheDocument();
      expect(screen.getAllByText("未登录").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/codex login/)).toBeInTheDocument();
      expect(screen.getByText("将使用服务器所有者的订阅额度")).toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: "使用 API Key" }));
      expect(await screen.findByLabelText("新 Agent API Key")).toBeInTheDocument();
      expect(screen.queryByText("将使用服务器所有者的订阅额度")).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("checks the available models and saves the selected one", async () => {
    window.history.pushState({}, "", "/?mode=http");
    let status = { model: null as string | null, source: "default" };
    const saved: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let data: unknown = { hasApiKey: true, maskedApiKey: "••••1234" };
      if (path.endsWith("/runtime")) data = { platform: "win32", modelingConfigured: false, solidWorksVersion: null, skillName: null, baseUrl: "https://api.openai.com/v1", model: null, reason: "x" };
      else if (path.endsWith("/auth-mode")) data = { authMode: "api_key", codexLogin: { loggedIn: false, method: null } };
      else if (path.endsWith("/api/settings/models")) data = { ...status, authMode: "api_key", models: [
        { id: "vision-1", displayName: "Vision 1", description: "supports images", supportsImage: true, isDefault: true },
        { id: "text-1", displayName: "Text 1", description: null, supportsImage: false, isDefault: false }
      ] };
      else if (path.endsWith("/api/settings/model")) {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as { model: string | null };
          saved.push(body);
          status = { model: body.model, source: body.model === null ? "default" : "setting" };
        }
        data = status;
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
    }));
    try {
      const user = userEvent.setup();
      renderSettingsWithToasts(MockRepository.create("run-running"));
      expect(screen.queryByLabelText("选择模型")).not.toBeInTheDocument();
      await user.click(await screen.findByRole("button", { name: "检查可用模型" }));
      const select = await screen.findByLabelText("选择模型");
      expect(screen.getByText("检测到 2 个可用模型")).toBeInTheDocument();

      await user.selectOptions(select, "text-1");
      expect(await screen.findByText("该模型不支持图片输入")).toBeInTheDocument();
      await user.selectOptions(select, "vision-1");
      expect(screen.queryByText("该模型不支持图片输入")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "保存模型" }));
      expect(await screen.findByText("模型已保存")).toBeInTheDocument();
      expect(saved).toEqual([{ model: "vision-1" }]);
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("expands the collapsed advanced group", async () => {
    const repository = MockRepository.create("run-running");
    const user = userEvent.setup();
    renderRoute(repository, "/settings", <SettingsPage now={NOW} />);

    const trigger = screen.getByRole("button", { name: "高级设置" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Prompt Template")).toBeInTheDocument();
    expect(screen.getAllByText("由服务端配置").length).toBeGreaterThanOrEqual(5);
  });

  it("saves and clears the API key through window.swpanel.secrets", async () => {
    const bridge = createFakeBridge({ apiKeyStatus: { hasApiKey: false, maskedApiKey: null } });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });
    const user = userEvent.setup();
    const repository = MockRepository.create("run-running");

    renderSettingsWithToasts(repository);

    // Unconfigured initially.
    expect((await screen.findAllByText("未配置")).length).toBeGreaterThanOrEqual(1);

    // Save a new key.
    await user.type(screen.getByLabelText("新 Agent API Key"), "sk-test-abcd1234");
    await user.click(screen.getByRole("button", { name: "保存密钥" }));

    await waitFor(() => expect(bridge.state().apiKeyStatus.hasApiKey).toBe(true));
    expect(await screen.findByText("sk-****1234")).toBeInTheDocument();
    expect(await screen.findByText("API Key 已保存")).toBeInTheDocument();
    expect(bridge.calls.some((call) => call.startsWith("secrets.setApiKey"))).toBe(true);

    // A stored key alone cannot prove a connection.
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(call => typeof call[0] === "string" && call[0].endsWith("/api/settings/test-connection"))).toBe(true);

    // Clear the key: the masked preview disappears and the status reverts.
    await user.click(screen.getByRole("button", { name: "清除密钥" }));
    // Clearing is destructive: a confirmation dialog must be accepted first.
    await user.click(await screen.findByRole("button", { name: "确认清除" }));
    await waitFor(() => expect(bridge.state().apiKeyStatus.hasApiKey).toBe(false));
    expect(await screen.findByText("API Key 已清除")).toBeInTheDocument();
    expect(bridge.calls.some((call) => call.startsWith("secrets.clearApiKey"))).toBe(true);
    expect(screen.getAllByText("未配置").length).toBeGreaterThanOrEqual(1);

    Reflect.deleteProperty(window, "swpanel");
  });

  it("shows real API test failure instead of claiming stored credentials are connected", async () => {
    const bridge = createFakeBridge({ apiKeyStatus: { hasApiKey: true, maskedApiKey: "sk-****abcd" } });
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code: "API_AUTH_FAILED", message: "Agent API 验证失败（HTTP 401）" } }), { status: 401 })));
    renderSettingsWithToasts(MockRepository.create("run-running"));
    await screen.findByText("sk-****abcd");
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "测试连接" }));
    expect((await screen.findAllByText("Agent API 验证失败（HTTP 401）")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("连接成功")).not.toBeInTheDocument();
    Reflect.deleteProperty(window, "swpanel");
  });

  it("loading a configured key shows the masked preview", async () => {
    const bridge = createFakeBridge({ apiKeyStatus: { hasApiKey: true, maskedApiKey: "sk-****abcd" } });
    Reflect.deleteProperty(window, "swpanel");
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });
    const repository = MockRepository.create("run-running");

    renderRoute(repository, "/settings", <SettingsPage now={NOW} />);

    expect(await screen.findByText("sk-****abcd")).toBeInTheDocument();
    expect(screen.getByText("已配置")).toBeInTheDocument();
    expect(bridge.calls.some((call) => call.startsWith("secrets.getStatus"))).toBe(true);

    Reflect.deleteProperty(window, "swpanel");
  });
});
