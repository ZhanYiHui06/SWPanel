import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RUN_STAGE_LABELS } from "@swpanel/domain";

import { StageProgress } from "./StageProgress.js";
import { RunStatusBadge } from "./RunStatusBadge.js";
import { RunTimeline, toRunTimelineItem } from "./RunTimeline.js";
import { validateDimensionInput } from "./ClarificationForm.js";
import { SIX_STAGES, stageIndex } from "../status.js";

const NOW = new Date("2026-08-10T23:40:00.000Z");

afterEach(cleanup);

describe("StageProgress (six stages)", () => {
  it("lists all six canonical stages", () => {
    render(<StageProgress stage="MODELING" live />);
    const stages = screen.getByRole("list", { name: "建模执行阶段" });
    expect(within(stages).getAllByRole("listitem")).toHaveLength(6);
    for (const stage of SIX_STAGES) {
      expect(screen.getByText(stage.label)).toBeInTheDocument();
    }
  });

  it("marks reached stages completed and the current stage active while running", () => {
    render(<StageProgress stage="MODELING" live />);
    const stages = within(screen.getByRole("list", { name: "建模执行阶段" })).getAllByRole("listitem");
    expect(stages[0]).toHaveClass("completed");
    expect(stages[1]).toHaveClass("completed");
    expect(stages[2]).toHaveClass("completed");
    expect(stages[3]).toHaveClass("active");
    expect(stages[4]).toHaveClass("pending");
    expect(stages[5]).toHaveClass("pending");
  });

  it("uses canonical stage labels", () => {
    expect(SIX_STAGES.map((stage) => stage.label)).toEqual([
      RUN_STAGE_LABELS.PREPARING,
      RUN_STAGE_LABELS.ANALYZING,
      RUN_STAGE_LABELS.PLANNING,
      RUN_STAGE_LABELS.MODELING,
      RUN_STAGE_LABELS.VALIDATING,
      RUN_STAGE_LABELS.PACKAGING
    ]);
    expect(stageIndex("MODELING")).toBe(3);
    expect(stageIndex(null)).toBe(-1);
  });
});

describe("RunStatusBadge", () => {
  it("renders the canonical label for every run status", () => {
    for (const status of ["QUEUED", "RUNNING", "COMPLETED", "CLARIFICATION_REQUIRED", "FAILED", "CANCELLED"]) {
      const { container } = render(<RunStatusBadge status={status} />);
      expect(container.textContent).toMatch(/等待执行|执行中|已完成|需要补充信息|执行失败|已取消/);
    }
  });
});

describe("RunTimeline", () => {
  it("maps every run status to a body hint", () => {
    const items = [
      { runId: "run-1", runLabel: "R01", status: "COMPLETED", createdAt: NOW.toISOString(), modelId: "model-m01", modelLabel: "M01", clarificationRequestId: null },
      { runId: "run-2", runLabel: "R02", status: "FAILED", createdAt: NOW.toISOString(), modelId: null, clarificationRequestId: null, failureMessage: "SolidWorks 自动重建失败", failureCode: "SOLIDWORKS_UNAVAILABLE" },
      { runId: "run-3", runLabel: "R03", status: "CANCELLED", createdAt: NOW.toISOString(), modelId: null, clarificationRequestId: null },
      { runId: "run-4", runLabel: "R04", status: "CLARIFICATION_REQUIRED", createdAt: NOW.toISOString(), modelId: null, clarificationRequestId: "clar-1" },
      { runId: "run-5", runLabel: "R05", status: "RUNNING", createdAt: NOW.toISOString(), modelId: null, clarificationRequestId: null }
    ].map((item) => toRunTimelineItem(item));

    render(<RunTimeline items={items} now={NOW} />);
    const timeline = screen.getByRole("list", { name: "建模记录时间线" });
    expect(within(timeline).getByText("生成模型 M01")).toBeInTheDocument();
    // Chinese summary from the failure code; raw code/message stay as technical details.
    expect(within(timeline).getByText(/SolidWorks 不可用，请联系管理员/)).toBeInTheDocument();
    expect(within(timeline).getByText("SolidWorks 自动重建失败")).toBeInTheDocument();
    expect(within(timeline).getByText("用户主动取消")).toBeInTheDocument();
    expect(within(timeline).getByText("问题待确认")).toBeInTheDocument();
    // RUNNING appears twice: in the badge and in the body hint.
    expect(within(timeline).getAllByText("执行中").length).toBeGreaterThan(0);
  });

  it("renders detail links only when provided", () => {
    render(<RunTimeline items={[toRunTimelineItem({ runId: "run-1", runLabel: "R01", status: "COMPLETED", createdAt: NOW.toISOString(), modelId: "model-m01", clarificationRequestId: null })]} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("RunTimeline / StageProgress accessibility", () => {
  it("renders QUEUED as a static queued dot (not the pulsing running dot)", () => {
    const item = toRunTimelineItem({ runId: "run-q", runLabel: "R09", status: "QUEUED", createdAt: NOW.toISOString(), modelId: null, clarificationRequestId: null });
    const { container } = render(<RunTimeline items={[item]} now={NOW} />);
    const dot = container.querySelector(".timeline-item-dot");
    expect(dot).toHaveClass("queued");
    expect(dot).not.toHaveClass("running");
  });

  it("marks the active stage with aria-current and spells out every stage state", () => {
    render(<StageProgress stage="MODELING" live />);
    const stages = within(screen.getByRole("list", { name: "建模执行阶段" })).getAllByRole("listitem");
    expect(stages[3]).toHaveAttribute("aria-current", "step");
    expect(stages[0]).not.toHaveAttribute("aria-current");
    expect(within(stages[0] as HTMLElement).getByText("（已完成）")).toBeInTheDocument();
    expect(within(stages[3] as HTMLElement).getByText("（进行中）")).toBeInTheDocument();
    expect(within(stages[5] as HTMLElement).getByText("（待处理）")).toBeInTheDocument();
  });
});

describe("validateDimensionInput", () => {
  it("accepts positive plain decimals", () => {
    for (const ok of ["85", "12.5", "0.5", " 7 "]) expect(validateDimensionInput(ok)).toBeNull();
  });
  it("rejects empty, zero, negative, hex, exponent and non-numeric input", () => {
    for (const bad of ["", "0", "0.0", "-5", "0x10", "1e3", "Infinity", "1,5", "abc", ".5", "5."]) {
      expect(validateDimensionInput(bad)).not.toBeNull();
    }
  });
});
