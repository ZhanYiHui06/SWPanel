import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ToastContainer } from "@swpanel/ui";

import type { ClarificationRequest, ModelingRun } from "@swpanel/domain";

import { BridgeDrawingRepository } from "../features/bridge-repository/bridge-drawing-repository.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { BridgeRunRepository } from "../features/run-repository/bridge-run-repository.js";
import { RunRepositoryProvider } from "../features/run-repository/run-repository-provider.js";
import { RepositoryProvider } from "../features/repository-provider.js";
import { MockRepository } from "../features/mock-repository/mock-repository.js";
import {
  NotificationProvider,
  useNotifications
} from "../features/notifications/notification-context.js";
import { createFakeBridge, type FakeBridge, type FakeBridgeOptions } from "../test/fake-bridge.js";
import { DRAWING_IDS, REVISION_IDS } from "../fixtures/index.js";
import { buildRun, event, progressEvent } from "../fixtures/runs.js";

import { DrawingOverviewPage } from "./DrawingOverviewPage.js";
import { RunsPage } from "./RunsPage.js";
import { RunDetailPage } from "./RunDetailPage.js";
import { DrawingRunsPage } from "./DrawingRunsPage.js";
import { WorkbenchPage } from "./WorkbenchPage.js";

const NOW = "2026-08-13T00:00:00.000Z";
const MAIN_DRAWING = DRAWING_IDS.main;
const MAIN_REVISION = REVISION_IDS.mainV3;

afterEach(cleanup);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<ModelingRun> & { id: string }): ModelingRun {
  return buildRun({
    id: overrides.id,
    number: overrides.number ?? `R${overrides.id.replace(/[^0-9]/g, "")}`,
    drawingId: overrides.drawingId ?? MAIN_DRAWING,
    revisionId: overrides.revisionId ?? MAIN_REVISION,
    status: overrides.status ?? "QUEUED",
    stage: overrides.stage ?? null,
    inputSnapshot: overrides.inputSnapshot ?? {
      drawingId: MAIN_DRAWING,
      revisionId: MAIN_REVISION,
      originalFileRef: `file-${MAIN_REVISION}`,
      revisionFacts: [],
      modelingFeedback: [],
      promptTemplateVersion: "test-v1",
      skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) },
      agentConfigId: "test-config",
      createdAt: NOW
    },
    createdAt: overrides.createdAt ?? NOW,
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.failureCode !== undefined ? { failureCode: overrides.failureCode } : {}),
    ...(overrides.failureMessage !== undefined ? { failureMessage: overrides.failureMessage } : {}),
    ...(overrides.clarificationRequestId !== undefined
      ? { clarificationRequestId: overrides.clarificationRequestId }
      : {}),
    ...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {})
  });
}

const DRAWING_SEED = {
  id: MAIN_DRAWING,
  drawingNumber: "PDJF480.01.17C-4",
  name: "主图纸",
  createdAt: NOW,
  updatedAt: NOW,
  revisions: [{ id: MAIN_REVISION, sequence: 3, fileName: "v3.pdf", uploadedAt: NOW }]
};

/** Fake bridge pre-seeded with one drawing + one revision. */
function createSeededFake(options: FakeBridgeOptions = {}): FakeBridge {
  return createFakeBridge({ seed: [DRAWING_SEED], ...options });
}

/** Fake bridge with the full status world (running/queued/completed/failed/cancelled). */
function createRunsWorldFake(options: FakeBridgeOptions = {}): FakeBridge {
  const fake = createSeededFake(options);
  fake.addRun(
    makeRun({ id: "run-running", number: "R01", status: "RUNNING", stage: "MODELING", startedAt: NOW })
  );
  fake.addRun(
    makeRun({ id: "run-queued", number: "R02", status: "QUEUED", createdAt: "2026-08-13T00:01:00.000Z" })
  );
  fake.addRun(
    makeRun({ id: "run-completed", number: "R03", status: "COMPLETED", completedAt: NOW })
  );
  fake.addRun(
    makeRun({
      id: "run-failed",
      number: "R04",
      status: "FAILED",
      failureCode: "SOLIDWORKS_UNAVAILABLE",
      failureMessage: "SolidWorks 自动重建失败"
    })
  );
  fake.addRun(makeRun({ id: "run-cancelled", number: "R05", status: "CANCELLED", completedAt: NOW }));
  return fake;
}

function makeOpenClarification(runId: string): ClarificationRequest {
  return {
    id: `clar-${runId}`,
    runId,
    revisionId: MAIN_REVISION,
    status: "OPEN",
    questions: [
      { id: "C01", type: "dimension", question: "中心孔深度是多少？", unit: "mm" },
      { id: "C02", type: "text", question: "R5 圆角对应哪一侧？" }
    ],
    answers: [],
    createdAt: NOW
  };
}

/** Mounts the toast stack so Run deletion success toasts are visible. */
function ProductToastHost(): React.JSX.Element {
  const { toasts, dismissToast } = useNotifications();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

function renderProduct(
  routes: { path: string; element: React.ReactNode }[],
  fake: FakeBridge,
  initialEntries: string[]
) {
  const drawingRepository = new BridgeDrawingRepository(fake.api);
  const runRepository = new BridgeRunRepository(fake.api);
  const router = createMemoryRouter(routes, { initialEntries });
  return render(
    <DrawingRepositoryProvider repository={drawingRepository}>
      <RunRepositoryProvider repository={runRepository}>
        <NotificationProvider>
          <RouterProvider router={router} />
          <ProductToastHost />
        </NotificationProvider>
      </RunRepositoryProvider>
    </DrawingRepositoryProvider>
  );
}

/** Finds the queue row containing `runLabel` (the label also appears in history). */
function queueItemFor(runLabel: string): HTMLElement {
  const matches = screen
    .getAllByText(new RegExp(runLabel))
    .map((element) => element.closest(".queue-item"))
    .filter((element): element is HTMLElement => element !== null);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0] as HTMLElement;
}

const overviewPath = `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/overview`;
const OVERVIEW_ROUTE = {
  path: "/drawings/:drawingId/revisions/:revisionId/overview",
  element: <DrawingOverviewPage now={new Date(NOW)} />
};
const RUNS_ROUTE = { path: "/runs", element: <RunsPage now={new Date(NOW)} /> };
const RUN_DETAIL_ROUTE = { path: "/runs/:runId", element: <RunDetailPage now={new Date(NOW)} /> };
const DRAWING_RUNS_ROUTE = {
  path: "/drawings/:drawingId/revisions/:revisionId/runs",
  element: <DrawingRunsPage now={new Date(NOW)} />
};
const WORKBENCH_ROUTE = { path: "/", element: <WorkbenchPage now={new Date(NOW)} /> };

// ── Drawing Overview: product-mode Run creation ────────────────────────────

describe("Drawing Overview (product mode) creates Runs", () => {
  it("creates a Run through the bridge with the exact identity pair and links to it", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake();
    renderProduct([OVERVIEW_ROUTE], fake, [overviewPath]);

    expect(await screen.findByRole("button", { name: /开始自动建模/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /开始自动建模/ }));
    const dialog = screen.getByRole("dialog", { name: "确认开始自动建模" });
    await user.click(within(dialog).getByRole("button", { name: /确认并开始/ }));

    // The Runner owns the snapshot: only the drawing/revision pair is sent.
    expect(
      fake.calls.some(
        (call) =>
          call === `runs.create:${JSON.stringify({ drawingId: MAIN_DRAWING, revisionId: MAIN_REVISION })}`
      )
    ).toBe(true);
    expect(await screen.findByText(/任务已加入等待队列/)).toBeInTheDocument();
    const created = fake.state().runs.at(-1);
    expect(created?.status).toBe("QUEUED");
    expect(screen.getByRole("link", { name: "查看任务" })).toHaveAttribute("href", `/runs/${created?.id}`);
  });

  it("reports create errors truthfully and retries through the bridge", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake({ fail: ["runs.create"] });
    renderProduct([OVERVIEW_ROUTE], fake, [overviewPath]);

    await screen.findByRole("button", { name: /开始自动建模/ });
    await user.click(screen.getByRole("button", { name: /开始自动建模/ }));
    await user.click(
      within(screen.getByRole("dialog", { name: "确认开始自动建模" })).getByRole("button", {
        name: /确认并开始/
      })
    );

    // Truthful error state: the dialog stays open with a Chinese message and
    // the confirm button doubles as retry.
    expect(await screen.findByText("创建建模任务失败")).toBeInTheDocument();
    expect(screen.getByText(/未连接到 SWPanel 服务/)).toBeInTheDocument();
    const retryDialog = screen.getByRole("dialog", { name: "确认开始自动建模" });

    fake.clearFailure("runs.create");
    await user.click(within(retryDialog).getByRole("button", { name: /确认并开始/ }));
    expect(await screen.findByText(/任务已加入等待队列/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fake.state().runs).toHaveLength(1);
  });

  it("keeps the confirm button disabled while the request is in flight (no duplicate Runs)", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake();
    renderProduct([OVERVIEW_ROUTE], fake, [overviewPath]);

    await user.click(await screen.findByRole("button", { name: /开始自动建模/ }));
    const dialog = screen.getByRole("dialog", { name: "确认开始自动建模" });
    const confirm = within(dialog).getByRole("button", { name: /确认并开始/ });
    await user.dblClick(confirm);
    await screen.findByText(/任务已加入等待队列/);
    expect(fake.calls.filter((call) => call.startsWith("runs.create:"))).toHaveLength(1);
  });
});

// ── RunsPage (product mode): queue / list / detail / live / cancel ─────────

describe("建模任务 (product mode)", () => {
  it("shows the current run, queue, history and truthful model-less completion", async () => {
    const fake = createRunsWorldFake();
    renderProduct([RUNS_ROUTE], fake, ["/runs"]);

    expect((await screen.findAllByText("PDJF480.01.17C-4")).length).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar", { name: "当前任务进度" })).toBeInTheDocument();
    // Six-stage progress of the current run.
    const stages = screen.getByRole("list", { name: "建模执行阶段" });
    expect(within(stages).getAllByRole("listitem")).toHaveLength(6);
    // Waiting queue row (identity loads through the drawing query).
    expect((await screen.findAllByText("PDJF480.01.17C-4 · V3 · R02")).length).toBeGreaterThan(0);
    // History result cells: model-less COMPLETED / failure / cancelled.
    expect(await screen.findByText("已完成（未生成模型）")).toBeInTheDocument();
    expect(screen.getByText("SolidWorks 自动重建失败")).toBeInTheDocument();
    expect(screen.getByText("用户主动取消")).toBeInTheDocument();
    // No Model link exists anywhere (Phase 3 has no Model UI).
    expect(screen.queryByRole("link", { name: /查看模型详情/ })).not.toBeInTheDocument();
  });

  it("applies live progress events onto the current run card", async () => {
    const fake = createRunsWorldFake();
    renderProduct([RUNS_ROUTE], fake, ["/runs"]);

    await waitFor(() =>
      expect(screen.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute("aria-valuenow", "0")
    );
    fake.emitRunEvents("run-running", [progressEvent("run-running", 1, NOW, 63)]);
    await waitFor(() =>
      expect(screen.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute("aria-valuenow", "63")
    );
  });

  it("keeps queue/current views truthful as live runs start and complete (second queued run becomes current)", async () => {
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-1", number: "R01", status: "QUEUED", createdAt: NOW }));
    fake.addRun(
      makeRun({ id: "run-2", number: "R02", status: "QUEUED", createdAt: "2026-08-13T00:01:00.000Z" })
    );
    renderProduct([RUNS_ROUTE], fake, ["/runs"]);

    // Both queued: no current run, both in the queue.
    expect(await screen.findByText("当前没有正在执行的建模任务。")).toBeInTheDocument();
    expect(screen.getAllByText(/R01/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/R02/).length).toBeGreaterThan(0);

    // run-1 starts: the list refetches and it becomes the current run.
    fake.emitRunEvents("run-1", [
      event("run-1", 1, NOW, { type: "StageChanged", stage: "PREPARING", activity: "正在准备" })
    ]);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "查看任务" })).toHaveAttribute("href", "/runs/run-1")
    );
    expect(await screen.findByText("正在准备")).toBeInTheDocument();
    expect(screen.queryByText("当前没有正在执行的建模任务。")).not.toBeInTheDocument();

    // run-1 completes (model-less): no current run; run-2 stays queued.
    fake.emitRunEvents("run-1", [event("run-1", 2, NOW, { type: "Completed" })]);
    await waitFor(() => expect(screen.getByText("当前没有正在执行的建模任务。")).toBeInTheDocument());
    expect(fake.state().runs.find((run) => run.id === "run-1")?.status).toBe("COMPLETED");

    // The serial queue wakes run-2: it becomes the current run.
    fake.emitRunEvents("run-2", [
      event("run-2", 1, NOW, { type: "StageChanged", stage: "PREPARING", activity: "正在准备" })
    ]);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "查看任务" })).toHaveAttribute("href", "/runs/run-2")
    );
    expect(screen.getAllByText("执行中").length).toBeGreaterThan(0);
  });

  it("cancels a QUEUED run while another run is RUNNING (CANCELLED outcome)", async () => {
    const user = userEvent.setup();
    const fake = createRunsWorldFake();
    renderProduct([RUNS_ROUTE], fake, ["/runs"]);

    expect((await screen.findAllByText("PDJF480.01.17C-4")).length).toBeGreaterThan(0);
    await user.click(within(queueItemFor("R02")).getByRole("button", { name: "取消" }));

    expect(
      fake.calls.some(
        (call) => call.startsWith("runs.cancel:") && call.includes('"runId":"run-queued"')
      )
    ).toBe(true);
    expect(await screen.findByText("Run R02 已取消")).toBeInTheDocument();
    // The RUNNING run is untouched.
    expect(fake.state().runs.find((run) => run.id === "run-running")?.status).toBe("RUNNING");
  });

  it("maps CANCEL_PENDING, FAILED cleanup, alreadyCancelled and ALREADY_TERMINAL cancel outcomes", async () => {
    const user = userEvent.setup();

    const pending = createRunsWorldFake({
      cancelResult: { runId: "run-queued", status: "CANCEL_PENDING", detail: "FOREIGN_LIVE_LEASE", leaseDeadlineAt: null }
    });
    renderProduct([RUNS_ROUTE], pending, ["/runs"]);
    expect((await screen.findAllByText("PDJF480.01.17C-4")).length).toBeGreaterThan(0);
    await user.click(within(queueItemFor("R02")).getByRole("button", { name: "取消" }));
    expect(await screen.findByText("Run R02 取消待处理")).toBeInTheDocument();
    cleanup();

    const failed = createRunsWorldFake({
      cancelResult: { runId: "run-queued", status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" }
    });
    renderProduct([RUNS_ROUTE], failed, ["/runs"]);
    expect((await screen.findAllByText("PDJF480.01.17C-4")).length).toBeGreaterThan(0);
    await user.click(within(queueItemFor("R02")).getByRole("button", { name: "取消" }));
    expect(await screen.findByText("Run R02 取消未完成")).toBeInTheDocument();
    expect(screen.getByText(/清理尚未完成/)).toBeInTheDocument();
    cleanup();

    const already = createRunsWorldFake({
      cancelResult: { runId: "run-queued", status: "CANCELLED", alreadyCancelled: true }
    });
    renderProduct([RUNS_ROUTE], already, ["/runs"]);
    expect((await screen.findAllByText("PDJF480.01.17C-4")).length).toBeGreaterThan(0);
    await user.click(within(queueItemFor("R02")).getByRole("button", { name: "取消" }));
    expect(
      await screen.findByText("该任务之前已取消，未生成模型。可随时发起新的 Run。")
    ).toBeInTheDocument();
    cleanup();

    const natural = createRunsWorldFake({
      cancelResult: { runId: "run-queued", status: "ALREADY_TERMINAL", finalStatus: "COMPLETED" }
    });
    renderProduct([RUNS_ROUTE], natural, ["/runs"]);
    expect((await screen.findAllByText("PDJF480.01.17C-4")).length).toBeGreaterThan(0);
    await user.click(within(queueItemFor("R02")).getByRole("button", { name: "取消" }));
    expect(await screen.findByText("Run R02 已自然结束")).toBeInTheDocument();
    expect(screen.getByText(/未执行取消/)).toBeInTheDocument();
  });

  it("disables duplicate cancel submits while a cancel is in flight", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createRunsWorldFake({ cancelDelay: () => gate });
    renderProduct([RUNS_ROUTE], fake, ["/runs"]);

    expect((await screen.findAllByText("PDJF480.01.17C-4")).length).toBeGreaterThan(0);
    await user.click(within(queueItemFor("R02")).getByRole("button", { name: "取消" }));
    // In-flight: the button is disabled and shows 正在取消…
    await waitFor(() =>
      expect(within(queueItemFor("R02")).getByRole("button", { name: "正在取消…" })).toBeDisabled()
    );
    release();
    expect(await screen.findByText("Run R02 已取消")).toBeInTheDocument();
    const cancelCalls = fake.calls.filter((call) => call.startsWith("runs.cancel:")).length;
    expect(cancelCalls).toBe(1);
  });
});

// ── Run Detail (product mode) ──────────────────────────────────────────────

describe("Run Detail (product mode)", () => {
  it("shows live progress, stages and the event stream for a RUNNING run", async () => {
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-running", number: "R01", status: "RUNNING", stage: "MODELING", startedAt: NOW }));
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-running"]);

    expect(await screen.findByText("R01")).toBeInTheDocument();
    // Six-stage progress renders for the RUNNING run.
    expect(await screen.findByRole("list", { name: "建模执行阶段" })).toBeInTheDocument();

    fake.emitRunEvents("run-running", [
      event("run-running", 1, NOW, { type: "StageChanged", stage: "PACKAGING", activity: "正在生成结果" }),
      progressEvent("run-running", 2, NOW, 88)
    ]);
    await waitFor(() =>
      expect(screen.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute("aria-valuenow", "88")
    );
    expect(await screen.findByText("正在生成结果")).toBeInTheDocument();
    // The applied events appear in the 事件流 section.
    expect(screen.getByText("StageChanged")).toBeInTheDocument();
    expect(screen.getByText("ProgressUpdated")).toBeInTheDocument();
  });

  it("shows the waiting state for a QUEUED run with a cancel action", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-queued", number: "R01", status: "QUEUED" }));
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-queued"]);

    expect(await screen.findByText("任务已在队列中，将按顺序自动执行。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消任务" }));
    expect(await screen.findByText("Run R01 已取消")).toBeInTheDocument();
  });

  it("asks for a second confirmation before cancelling a RUNNING run", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-running", number: "R01", status: "RUNNING", stage: "MODELING", startedAt: NOW }));
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-running"]);

    await user.click(await screen.findByRole("button", { name: "取消任务" }));
    const dialog = screen.getByRole("dialog", { name: "取消正在执行的任务" });
    expect(within(dialog).getByText(/清理本次已生成的全部文件/)).toBeInTheDocument();
    expect(fake.calls.some((call) => call.startsWith("runs.cancel:"))).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "继续运行" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fake.calls.some((call) => call.startsWith("runs.cancel:"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "取消任务" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认取消任务" }));
    expect(await screen.findByText("Run R01 已取消")).toBeInTheDocument();
    expect(fake.calls.some((call) => call.startsWith("runs.cancel:"))).toBe(true);
  });

  it("explains a failure in Chinese and keeps the raw code/message as technical details", async () => {
    const fake = createSeededFake();
    fake.addRun(
      makeRun({ id: "run-failed", number: "R01", status: "FAILED", failureCode: "SOLIDWORKS_UNAVAILABLE", failureMessage: "SolidWorks 自动重建失败", completedAt: NOW })
    );
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-failed"]);
    expect(await screen.findByText(/SolidWorks 不可用，请联系管理员/)).toBeInTheDocument();
    expect(screen.getByText("技术详情")).toBeInTheDocument();
  });

  it("shows the failure message and offers a new Run for a FAILED run", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake();
    fake.addRun(
      makeRun({
        id: "run-failed",
        number: "R01",
        status: "FAILED",
        failureCode: "SOLIDWORKS_UNAVAILABLE",
        failureMessage: "SolidWorks 自动重建失败",
        completedAt: NOW
      })
    );
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-failed"]);

    expect(await screen.findByText("SolidWorks 自动重建失败")).toBeInTheDocument();
    expect(screen.getByText(/SOLIDWORKS_UNAVAILABLE/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新自动建模" }));
    expect(
      fake.calls.some(
        (call) =>
          call === `runs.create:${JSON.stringify({ drawingId: MAIN_DRAWING, revisionId: MAIN_REVISION })}`
      )
    ).toBe(true);
  });

  it("shows a truthful cancelled state", async () => {
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-cancelled", number: "R01", status: "CANCELLED", completedAt: NOW }));
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-cancelled"]);

    expect(
      await screen.findByText("用户主动取消了本次执行，未生成模型。可随时发起新的 Run。")
    ).toBeInTheDocument();
  });

  it("shows a model-less COMPLETED run truthfully and NEVER links to a Model page", async () => {
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-completed", number: "R01", status: "COMPLETED", completedAt: NOW }));
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-completed"]);

    expect(await screen.findByText("Run 已完成（未生成模型）")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /查看模型详情/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/M0\d/)).not.toBeInTheDocument();
  });

  it("submits clarification answers: the old Run stays terminal, facts are directed, a NEW Run is created", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake();
    fake.addRun(
      makeRun({
        id: "run-clar",
        number: "R01",
        status: "CLARIFICATION_REQUIRED",
        stage: "ANALYZING",
        clarificationRequestId: "clar-run-clar"
      })
    );
    fake.addClarification(makeOpenClarification("run-clar"));
    renderProduct([RUN_DETAIL_ROUTE, RUNS_ROUTE], fake, ["/runs/run-clar"]);

    expect(await screen.findByText("需要补充 2 项信息")).toBeInTheDocument();
    // Old Run stays terminal CLARIFICATION_REQUIRED (badge in header + stat strip).
    expect(screen.getAllByText("需要补充信息").length).toBeGreaterThan(0);

    await user.type(screen.getByRole("textbox", { name: "中心孔深度是多少？" }), "85");
    await user.type(screen.getByRole("textbox", { name: "R5 圆角对应哪一侧？" }), "右侧轴肩外缘");
    await user.click(screen.getByRole("button", { name: "提交补充信息" }));

    expect(await screen.findByText(/补充信息已保存至版本记忆/)).toBeInTheDocument();
    expect(
      fake.calls.some(
        (call) =>
          call.startsWith("clarifications.submit:") &&
          call.includes('"clarificationRequestId":"clar-run-clar"')
      )
    ).toBe(true);
    // The Run is never resumed: the badge stays CLARIFICATION_REQUIRED.
    expect(screen.getAllByText("需要补充信息").length).toBeGreaterThan(0);
    // Direct the user to update Facts, then start a NEW Run.
    expect(screen.getByRole("link", { name: "前往版本记忆更新 Facts" })).toHaveAttribute(
      "href",
      `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/memory`
    );

    await user.click(screen.getByRole("button", { name: "重新自动建模" }));
    expect(
      fake.calls.some(
        (call) =>
          call === `runs.create:${JSON.stringify({ drawingId: MAIN_DRAWING, revisionId: MAIN_REVISION })}`
      )
    ).toBe(true);
  });

  it("surfaces a clarification fetch failure with retry on Run Detail", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake();
    fake.addRun(
      makeRun({
        id: "run-clar",
        number: "R01",
        status: "CLARIFICATION_REQUIRED",
        clarificationRequestId: "clar-run-clar"
      })
    );
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-clar"]);

    // The request is not seeded: truthful error state with retry.
    expect(await screen.findByText("补充信息加载失败")).toBeInTheDocument();
    // Raw English server messages are never shown: the mapped Chinese one is.
    expect(screen.getByText(/请求的对象不存在或已被删除/)).toBeInTheDocument();

    fake.addClarification(makeOpenClarification("run-clar"));
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("需要补充 2 项信息")).toBeInTheDocument();
  });

  it("recovers automatically after a stream failure and keeps rendering", async () => {
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-running", number: "R01", status: "RUNNING", stage: "MODELING", startedAt: NOW }));
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-running"]);

    await screen.findByText("R01");
    fake.emitRunEvents("run-running", [progressEvent("run-running", 1, NOW, 40)]);
    await waitFor(() =>
      expect(screen.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute("aria-valuenow", "40")
    );
    fake.failRunStream("run-running", "RUN_EVENT_STREAM_LOST", "connection lost");
    // The stream refetches + resubscribes automatically and stays live. The
    // refetched snapshot is authoritative (progress comes from the Runner).
    await waitFor(() => {
      const detailCalls = fake.calls.filter((call) => call.startsWith("runs.getDetail:"));
      expect(detailCalls.length).toBeGreaterThanOrEqual(2);
      // The first recovery waits baseDelayMs (1s) before refetching.
    }, { timeout: 3000 });
    expect(screen.getByRole("heading", { name: "R01" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "建模执行阶段" })).toBeInTheDocument();
  });

  it("deletes a terminal COMPLETED run via 删除记录 and navigates back to 建模任务", async () => {
    const user = userEvent.setup();
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-completed", number: "R01", status: "COMPLETED", completedAt: NOW }));
    fake.addRun(
      makeRun({
        id: "run-failed",
        number: "R02",
        status: "FAILED",
        failureCode: "SOLIDWORKS_UNAVAILABLE",
        failureMessage: "SolidWorks 自动重建失败"
      })
    );
    renderProduct([RUN_DETAIL_ROUTE, RUNS_ROUTE], fake, ["/runs/run-completed"]);

    expect(await screen.findByRole("button", { name: "删除记录" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除记录" }));
    const dialog = screen.getByRole("dialog", { name: "删除记录" });
    await user.click(within(dialog).getByRole("button", { name: "确认删除记录" }));

    expect(await screen.findByText("Run 已删除")).toBeInTheDocument();
    expect(fake.state().runs.find((run) => run.id === "run-completed")).toBeUndefined();
    // The FAILED sibling survives.
    expect(fake.state().runs.find((run) => run.id === "run-failed")).toBeDefined();
    // Navigated back to the 建模任务 list.
    expect(await screen.findByText("当前没有正在执行的建模任务。")).toBeInTheDocument();
  });

  it("does not offer 删除记录 for non-terminal RUNNING runs", async () => {
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-running", number: "R01", status: "RUNNING", stage: "MODELING", startedAt: NOW }));
    renderProduct([RUN_DETAIL_ROUTE], fake, ["/runs/run-running"]);

    await screen.findByRole("heading", { name: "R01" });
    expect(screen.queryByRole("button", { name: "删除记录" })).not.toBeInTheDocument();
  });
});

// ── Drawing Workspace · 建模记录 (product mode) ────────────────────────────

describe("Drawing Workspace · 建模记录 (product mode)", () => {
  it("lists only the runs of the active revision as a timeline", async () => {
    const fake = createSeededFake();
    fake.addRun(makeRun({ id: "run-completed", number: "R01", status: "COMPLETED", completedAt: NOW }));
    fake.addRun(
      makeRun({
        id: "run-failed",
        number: "R02",
        status: "FAILED",
        failureCode: "SOLIDWORKS_UNAVAILABLE",
        failureMessage: "SolidWorks 自动重建失败"
      })
    );
    // A run of ANOTHER revision must not appear.
    fake.addRun(
      makeRun({ id: "run-other-revision", number: "R01", status: "RUNNING", revisionId: REVISION_IDS.mainV2 })
    );
    renderProduct([DRAWING_RUNS_ROUTE], fake, [
      `/drawings/${MAIN_DRAWING}/revisions/${MAIN_REVISION}/runs`
    ]);

    const timeline = await screen.findByRole("list", { name: "建模记录时间线" });
    const items = within(timeline).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(timeline).getByText("已完成（未生成模型）")).toBeInTheDocument();
    expect(within(timeline).getByText("SolidWorks 自动重建失败")).toBeInTheDocument();
    expect(within(timeline).getAllByRole("link", { name: /查看详情/ })).toHaveLength(2);
  });
});

// ── Workbench (product mode) ───────────────────────────────────────────────

describe("Workbench (product mode)", () => {
  it("uses the REAL clock in product mode (relative labels stay truthful)", async () => {
    const fake = createSeededFake();
    const createdAt = new Date();
    fake.addRun(
      makeRun({
        id: "run-running",
        number: "R01",
        status: "RUNNING",
        stage: "MODELING",
        createdAt: createdAt.toISOString()
      })
    );
    // No `now` prop: the product workbench must derive from the real clock.
    renderProduct([{ path: "/", element: <WorkbenchPage /> }], fake, ["/"]);
    expect(await screen.findByText(/今天 \d{2}:\d{2} 启动/)).toBeInTheDocument();
  });

  it("keeps the fixture date deterministic in mock mode", () => {
    const repository = MockRepository.create("run-running");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <RepositoryProvider repository={repository}>
          <WorkbenchPage />
        </RepositoryProvider>
      </MemoryRouter>
    );
    // DISPLAY_NOW (2026-08-10T23:40Z) renders the fixture R05 (22:31Z) as 今天.
    expect(screen.getByText("今天 06:31 启动")).toBeInTheDocument();
  });

  it("shows the live current run, waiting queue and clarification attention with NO later-phase placeholder", async () => {
    const fake = createRunsWorldFake();
    fake.addRun(
      makeRun({
        id: "run-clar",
        number: "R06",
        status: "CLARIFICATION_REQUIRED",
        clarificationRequestId: "clar-run-clar"
      })
    );
    fake.addClarification(makeOpenClarification("run-clar"));
    renderProduct([WORKBENCH_ROUTE], fake, ["/"]);

    expect((await screen.findAllByText("PDJF480.01.17C-4")).length).toBeGreaterThan(0);
    expect(screen.getByText("等待队列")).toBeInTheDocument();
    expect(screen.getByText("需要处理")).toBeInTheDocument();
    expect(screen.getByText("1 个任务需要补充信息")).toBeInTheDocument();
    expect(screen.queryByText("该能力将在后续阶段启用")).not.toBeInTheDocument();
    // Queue items link to the run detail page (identity/detail load async).
    expect((await screen.findAllByRole("link", { name: "查看" })).length).toBeGreaterThan(0);
    // The clarification attention row links to the answering page.
    expect(await screen.findByRole("link", { name: "补充" })).toHaveAttribute("href", "/runs/run-clar");
  });
});
