import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { MockRepository } from "../features/mock-repository/mock-repository.js";
import { RepositoryProvider } from "../features/repository-provider.js";
import { RUN_IDS } from "../fixtures/index.js";

import { DrawingRunsPage } from "./DrawingRunsPage.js";
import { DrawingModelsPage } from "./DrawingModelsPage.js";
import { ModelDetailPage } from "./ModelDetailPage.js";
import { RunsPage } from "./RunsPage.js";
import { RunDetailPage } from "./RunDetailPage.js";

/** Deterministic "now" inside the fixture timeline day. */
const NOW = new Date("2026-08-10T23:40:00.000Z");

const MAIN_DRAWING = "drawing-main";
const V3 = "revision-v3";

afterEach(cleanup);

function renderWithParams(element: React.ReactNode, entry: string, repository: MockRepository) {
  return render(
    <RepositoryProvider repository={repository}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>{element}</Routes>
      </MemoryRouter>
    </RepositoryProvider>
  );
}

function drawingRoute(page: React.JSX.Element) {
  return (
    <Route path="/drawings/:drawingId/revisions/:revisionId/:tab" element={page} />
  );
}

describe("Drawing Workspace · 建模记录", () => {
  it("renders every run status on the timeline (running/clarification/cancelled/failed/completed)", () => {
    const repository = MockRepository.create("run-running");
    renderWithParams(
      drawingRoute(<DrawingRunsPage now={NOW} />),
      `/drawings/${MAIN_DRAWING}/revisions/${V3}/runs`,
      repository
    );

    const timeline = screen.getByRole("list", { name: "建模记录时间线" });
    const items = within(timeline).getAllByRole("listitem");
    expect(items).toHaveLength(5);

    // RUNNING appears in both badge and body; other statuses only in badges.
    expect(within(timeline).getAllByText("执行中").length).toBeGreaterThan(0);
    expect(within(timeline).getByText("需要补充信息")).toBeInTheDocument();
    expect(within(timeline).getByText("已取消")).toBeInTheDocument();
    expect(within(timeline).getByText("执行失败")).toBeInTheDocument();
    expect(within(timeline).getByText("已完成")).toBeInTheDocument();

    // Completed run R01 publishes M01; detail links point to the run page.
    expect(within(timeline).getAllByRole("link", { name: /查看详情/ }).length).toBeGreaterThan(0);
  });
});

describe("Drawing Workspace · 模型", () => {
  it("shows pending-review, approved and rejected models with the rejection reason", () => {
    const repository = MockRepository.create("model-pending-review");
    renderWithParams(
      drawingRoute(<DrawingModelsPage now={NOW} />),
      `/drawings/${MAIN_DRAWING}/revisions/${V3}/models`,
      repository
    );

    expect(screen.getByText("M03")).toBeInTheDocument();
    expect(screen.getByText("等待审核")).toBeInTheDocument();
    expect(screen.getByText("审核通过")).toBeInTheDocument();
    expect(screen.getByText("已退回")).toBeInTheDocument();
    expect(screen.getByText(/右侧台阶直径错误/)).toBeInTheDocument();
    expect(screen.getByText("当前正式模型")).toBeInTheDocument();
  });
});

describe("Model Detail", () => {
  it("renders model info, artifacts and the review panel for a pending-review model", () => {
    const repository = MockRepository.create("model-pending-review");
    renderWithParams(
      <Route path="/drawings/:drawingId/revisions/:revisionId/models/:modelId" element={<ModelDetailPage now={NOW} />} />,
      `/drawings/${MAIN_DRAWING}/revisions/${V3}/models/model-m03`,
      repository
    );

    expect(screen.getByText("M03")).toBeInTheDocument();
    expect(screen.getByText("等待审核")).toBeInTheDocument();
    expect(screen.getByText("来源 Run", { selector: ".property-key" })).toBeInTheDocument();
    expect(screen.getByText("Dimension Ledger")).toBeInTheDocument();
    expect(screen.getByText("Feature Plan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "审核通过" })).toBeInTheDocument();
  });

  it("approves a pending model and propagates the review through the repository", async () => {
    const user = userEvent.setup();
    const repository = MockRepository.create("model-pending-review");
    renderWithParams(
      <Route path="/drawings/:drawingId/revisions/:revisionId/models/:modelId" element={<ModelDetailPage now={NOW} />} />,
      `/drawings/${MAIN_DRAWING}/revisions/${V3}/models/model-m03`,
      repository
    );

    await user.click(screen.getByRole("button", { name: "审核通过" }));

    const model = repository.getModel("model-main-m03");
    expect(model?.reviewStatus).toBe("APPROVED");
    const revision = repository.getRevision("rev-main-v3");
    expect(revision?.currentApprovedModelId).toBe("model-main-m03");
    // UI reflects the applied command immediately.
    expect(await screen.findByText("审核通过", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "审核通过" })).not.toBeInTheDocument();
  });

  it("requires a rejection reason before rejecting", async () => {
    const user = userEvent.setup();
    const repository = MockRepository.create("model-pending-review");
    renderWithParams(
      <Route path="/drawings/:drawingId/revisions/:revisionId/models/:modelId" element={<ModelDetailPage now={NOW} />} />,
      `/drawings/${MAIN_DRAWING}/revisions/${V3}/models/model-m03`,
      repository
    );

    await user.click(screen.getByRole("button", { name: "退回" }));
    expect(screen.getByRole("textbox", { name: "退回原因" })).toBeInTheDocument();

    // Empty reason is blocked.
    await user.click(screen.getByRole("button", { name: "确认退回" }));
    expect(screen.getByRole("alert")).toHaveTextContent("退回原因不能为空");
    expect(repository.getModel("model-main-m03")?.reviewStatus).toBe("PENDING_REVIEW");

    // A filled reason rejects and writes the feedback.
    await user.type(screen.getByRole("textbox", { name: "退回原因" }), "中心孔深度错误");
    await user.click(screen.getByRole("button", { name: "确认退回" }));

    expect(repository.getModel("model-main-m03")?.reviewStatus).toBe("REJECTED");
    const feedback = repository.listFeedback().find((entry) => entry.modelId === "model-main-m03");
    expect(feedback?.content).toBe("中心孔深度错误");
    expect((await screen.findAllByText(/已退回/)).length).toBeGreaterThan(0);
  });
});

describe("建模任务 (/runs)", () => {
  it("renders the current run with six-stage progress and the waiting queue", () => {
    const repository = MockRepository.create("run-running");
    renderWithParams(<Route path="/runs" element={<RunsPage now={NOW} />} />, "/runs", repository);

    expect(screen.getAllByText("PDJF480.01.17C-4").length).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute("aria-valuenow", "63");
    const stages = screen.getByRole("list", { name: "建模执行阶段" });
    expect(within(stages).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getAllByText("正在创建主要旋转特征").length).toBeGreaterThan(0);

    // Waiting queue includes drawing A and B queued runs.
    const queueNumber = screen.getAllByText(/PDJF273\.02\.08/)[0];
    expect(queueNumber).toBeInTheDocument();
    expect(screen.getAllByText(/PDJG159\.01\.03/).length).toBeGreaterThan(0);
  });

  it("lists history runs with status filters", async () => {
    const user = userEvent.setup();
    const repository = MockRepository.create("run-running");
    renderWithParams(<Route path="/runs" element={<RunsPage now={NOW} />} />, "/runs", repository);

    // Clickable DataTable rows render as role=button.
    expect(screen.getAllByRole("button", { name: /R0[1-6]/ }).length).toBeGreaterThan(0);
    expect(screen.getByText("SolidWorks 自动重建失败")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "已完成" }));
    expect(screen.queryByText("SolidWorks 自动重建失败")).not.toBeInTheDocument();
  });

  it("cancels a queued run through the repository", async () => {
    const user = userEvent.setup();
    const repository = MockRepository.create("run-running");
    renderWithParams(<Route path="/runs" element={<RunsPage now={NOW} />} />, "/runs", repository);

    const queueMatches = screen.getAllByText(/PDJF273\.02\.08/);
    const queueItem = queueMatches[0]?.closest(".queue-item");
    expect(queueItem).not.toBeNull();
    const cancelButtons = within(queueItem as HTMLElement).getAllByRole("button", { name: "取消" });
    expect(cancelButtons.length).toBeGreaterThan(0);
    const firstCancel = cancelButtons[0];
    expect(firstCancel).toBeDefined();
    await user.click(firstCancel as HTMLElement);

    const run = repository.getRun(RUN_IDS.aR03);
    expect(run?.status).toBe("CANCELLED");
  });
});

describe("Run Detail (/runs/:runId)", () => {
  it("shows live progress for a RUNNING run", () => {
    const repository = MockRepository.create("run-running");
    renderWithParams(
      <Route path="/runs/:runId" element={<RunDetailPage now={NOW} />} />,
      "/runs/run-main-r05",
      repository
    );

    expect(screen.getByText("R05")).toBeInTheDocument();
    expect(screen.getAllByText("执行中").length).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar", { name: "当前任务进度" })).toHaveAttribute("aria-valuenow", "63");
  });

  it("renders an open clarification form and marks the request answered on submit", async () => {
    const user = userEvent.setup();
    const repository = MockRepository.create("clarification-open");
    renderWithParams(
      <Route path="/runs/:runId" element={<RunDetailPage now={NOW} />} />,
      "/runs/run-main-r04",
      repository
    );

    expect(screen.getByText("需要补充 3 项信息")).toBeInTheDocument();
    expect(screen.getByText("中心孔深度是多少？")).toBeInTheDocument();

    // Submit without answers is blocked.
    await user.click(screen.getByRole("button", { name: "提交补充信息" }));
    expect(repository.getClarificationRequest("clar-main-r04")?.status).toBe("OPEN");

    // Fill dimension + text + choice.
    await user.type(screen.getByRole("textbox", { name: "中心孔深度是多少？" }), "85");
    await user.type(screen.getByRole("textbox", { name: "R5 圆角对应哪一侧？" }), "右侧轴肩外缘");
    await user.selectOptions(screen.getByRole("combobox", { name: "图纸中的材料无法确认" }), "opt-42crmo");
    await user.click(screen.getByRole("button", { name: "提交补充信息" }));

    const request = repository.getClarificationRequest("clar-main-r04");
    expect(request?.status).toBe("ANSWERED");
    expect(request?.answers).toHaveLength(3);
    // Facts were written to the revision memory under their canonical field.
    expect(
      repository.listFacts().some((fact) => fact.revisionId === "rev-main-v3" && fact.field === "中心孔深度")
    ).toBe(true);
    // The material answer merges into the existing canonical `材料` fact.
    expect(repository.listFacts().filter((fact) => fact.field === "材料").length).toBe(1);

    expect(await screen.findByRole("button", { name: "重新自动建模" })).toBeInTheDocument();
  });

  it("renders the answered state with saved answers", () => {
    const repository = MockRepository.create("clarification-answered");
    renderWithParams(
      <Route path="/runs/:runId" element={<RunDetailPage now={NOW} />} />,
      "/runs/run-main-r04",
      repository
    );

    expect(screen.getByText("需要补充 3 项信息")).toBeInTheDocument();
    expect(screen.getByTestId("answer-C01")).toHaveTextContent("85 mm");
    expect(screen.getByTestId("answer-C03")).toHaveTextContent("42CrMo");
    expect(screen.getByRole("button", { name: "重新自动建模" })).toBeInTheDocument();
  });

  it("shows the completed model link for a COMPLETED run", () => {
    const repository = MockRepository.create("model-pending-review");
    renderWithParams(
      <Route path="/runs/:runId" element={<RunDetailPage now={NOW} />} />,
      "/runs/run-main-r05",
      repository
    );

    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "查看模型详情" })).toHaveAttribute(
      "href",
      expect.stringContaining("/models/model-main-m03")
    );
  });

  it("shows the failure message for a FAILED run", () => {
    const repository = MockRepository.create("run-failed");
    renderWithParams(
      <Route path="/runs/:runId" element={<RunDetailPage now={NOW} />} />,
      "/runs/run-main-r05",
      repository
    );

    expect(screen.getAllByText("执行失败").length).toBeGreaterThan(0);
    expect(screen.getByText("SolidWorks 自动重建失败")).toBeInTheDocument();
  });
});
