import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { MockRepository } from "../features/mock-repository/mock-repository.js";
import { RepositoryProvider } from "../features/repository-provider.js";
import { MockBridgeDrawingRepository } from "../features/bridge-repository/mock-bridge-repository.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { DRAWING_IDS, REVISION_IDS, type MockScenario } from "../fixtures/index.js";
import { DrawingOverviewPage } from "./DrawingOverviewPage.js";
import { DrawingsPage } from "./DrawingsPage.js";
import { WorkbenchPage } from "./WorkbenchPage.js";

afterEach(cleanup);

function renderRoute(element: React.ReactNode, initialEntry: string, repository: MockRepository, path = "*") {
  const router = createMemoryRouter([{ path, element }], { initialEntries: [initialEntry] });
  return render(<RepositoryProvider repository={repository}><RouterProvider router={router} /></RepositoryProvider>);
}

/** Drawing-management pages read through the async WP6 adapter (mock mode). */
function renderDrawingRoute(element: React.ReactNode, initialEntry: string, scenario: MockScenario, path = "*") {
  const router = createMemoryRouter([{ path, element }], { initialEntries: [initialEntry] });
  return render(
    <DrawingRepositoryProvider repository={MockBridgeDrawingRepository.create(scenario)}>
      <RouterProvider router={router} />
    </DrawingRepositoryProvider>
  );
}

describe("Phase 1 Workbench", () => {
  it("renders the canonical running task and six-stage progress", () => {
    renderRoute(<WorkbenchPage />, "/", MockRepository.create("run-running"));
    expect(screen.getByRole("heading", { name: "PDJF480.01.17C-4" })).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute("aria-valuenow", "63");
    const stages = screen.getByRole("list", { name: "建模执行阶段" });
    expect(within(stages).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getAllByRole("link", { name: /打开图纸/ })[0]).toHaveAttribute("href");
  });

  it("renders the deterministic waiting queue and attention items", () => {
    renderRoute(<WorkbenchPage />, "/", MockRepository.create("model-pending-review"));
    expect(screen.getByText("等待队列")).toBeInTheDocument();
    expect(screen.getByText("PDJF273.02.08 · V2")).toBeInTheDocument();
    expect(screen.getByText("定径辊 · R03")).toBeInTheDocument();
    expect(screen.getByText("PDJG159.01.03 · V1")).toBeInTheDocument();
    expect(screen.getByText("阶梯轴 · R01")).toBeInTheDocument();
    expect(screen.getByText("需要处理")).toBeInTheDocument();
    expect(screen.getByText("1 个模型等待审核")).toBeInTheDocument();
    expect(screen.getByText("1 个任务需要补充信息")).toBeInTheDocument();
  });

  it("shows the confirmed empty state when no run is active", () => {
    renderRoute(<WorkbenchPage />, "/", MockRepository.create("empty-drawing-library"));
    expect(screen.getByText("当前没有正在执行的建模任务")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开图纸库" })).toHaveAttribute("href", "/drawings");
  });
});

describe("Phase 1 Drawing Library", () => {
  it("searches and filters deterministic drawing rows with real links", async () => {
    const user = userEvent.setup();
    renderDrawingRoute(<DrawingsPage />, "/drawings", "run-running");
    expect(await screen.findAllByRole("row")).toHaveLength(6);

    await user.type(screen.getByRole("searchbox", { name: "搜索图号或名称" }), "阶梯轴");
    expect(screen.getByRole("link", { name: "PDJG159.01.03" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "PDJF480.01.17C-4" })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "搜索图号或名称" }));
    await user.click(screen.getByRole("button", { name: "待处理" }));
    expect(screen.getByText("需要补充信息")).toBeInTheDocument();
    const open = screen.getAllByRole("link", { name: /^打开图纸/ })[0];
    expect(open).toHaveAttribute("href", expect.stringContaining("/overview"));
  });
});

describe("Phase 1 Drawing Overview", () => {
  it("navigates revisions and dispatches a confirmed queued run", async () => {
    const user = userEvent.setup();
    const repository = MockRepository.create("model-pending-review");
    const drawingRepository = new MockBridgeDrawingRepository(repository);
    const initialRuns = repository.listRuns().length;
    const path = `/drawings/${DRAWING_IDS.main}/revisions/${REVISION_IDS.mainV3}/overview`;
    const router = createMemoryRouter(
      [{ path: "/drawings/:drawingId/revisions/:revisionId/overview", element: <DrawingOverviewPage /> }],
      { initialEntries: [path] }
    );
    render(
      <DrawingRepositoryProvider repository={drawingRepository}>
        <RouterProvider router={router} />
      </DrawingRepositoryProvider>
    );

    expect(await screen.findByRole("img", { name: "工程图纸预览" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "图纸工作区" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "V2" })).toHaveAttribute("href", expect.stringContaining(`${REVISION_IDS.mainV2}/overview`));
    expect(screen.getByText("等待人工审核")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /开始自动建模/ }));
    const dialog = screen.getByRole("dialog", { name: "确认开始自动建模" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await user.click(within(dialog).getByRole("button", { name: /确认并开始/ }));

    expect(repository.listRuns()).toHaveLength(initialRuns + 1);
    const created = repository.listRuns().at(-1);
    expect(created?.status).toBe("QUEUED");
    expect(created?.revisionId).toBe(REVISION_IDS.mainV3);
    expect(created?.inputSnapshot.revisionId).toBe(REVISION_IDS.mainV3);
    expect(await screen.findByText(/任务已加入等待队列/)).toBeInTheDocument();
  });
});
