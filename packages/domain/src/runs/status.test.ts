import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "../errors.js";
import {
  canCancelRun,
  isRunTerminal,
  RUN_STAGE_LABELS,
  RUN_STAGES,
  RUN_STATUS_LABELS,
  RUN_STATUSES,
  transitionRunStatus
} from "./status.js";

describe("run status", () => {
  it("exposes the exact canonical run status values", () => {
    expect(RUN_STATUSES).toEqual([
      "QUEUED",
      "RUNNING",
      "COMPLETED",
      "CLARIFICATION_REQUIRED",
      "FAILED",
      "CANCELLED"
    ]);
  });

  it("exposes the six user-visible stages in canonical order", () => {
    expect(RUN_STAGES).toEqual([
      "PREPARING",
      "ANALYZING",
      "PLANNING",
      "MODELING",
      "VALIDATING",
      "PACKAGING"
    ]);
  });

  it("centralizes the canonical user-facing status wording", () => {
    expect(RUN_STATUS_LABELS).toEqual({
      QUEUED: "等待执行",
      RUNNING: "执行中",
      COMPLETED: "已完成",
      CLARIFICATION_REQUIRED: "需要补充信息",
      FAILED: "执行失败",
      CANCELLED: "已取消"
    });
    expect(RUN_STAGE_LABELS).toEqual({
      PREPARING: "准备任务",
      ANALYZING: "分析图纸",
      PLANNING: "规划模型",
      MODELING: "SolidWorks 建模",
      VALIDATING: "检查模型",
      PACKAGING: "生成结果"
    });
  });

  it("allows every legal run transition", () => {
    expect(transitionRunStatus("QUEUED", "RUNNING")).toBe("RUNNING");
    expect(transitionRunStatus("QUEUED", "CANCELLED")).toBe("CANCELLED");
    expect(transitionRunStatus("RUNNING", "COMPLETED")).toBe("COMPLETED");
    expect(transitionRunStatus("RUNNING", "CLARIFICATION_REQUIRED")).toBe(
      "CLARIFICATION_REQUIRED"
    );
    expect(transitionRunStatus("RUNNING", "FAILED")).toBe("FAILED");
    expect(transitionRunStatus("RUNNING", "CANCELLED")).toBe("CANCELLED");
  });

  it("rejects illegal run transitions", () => {
    expect(() => transitionRunStatus("CLARIFICATION_REQUIRED", "RUNNING")).toThrow(
      DomainInvariantError
    );
    expect(() => transitionRunStatus("COMPLETED", "RUNNING")).toThrow(DomainInvariantError);
    expect(() => transitionRunStatus("QUEUED", "COMPLETED")).toThrow(DomainInvariantError);
    expect(() => transitionRunStatus("FAILED", "COMPLETED")).toThrow(DomainInvariantError);
  });

  it("treats CLARIFICATION_REQUIRED as a terminal run state that never resumes", () => {
    expect(isRunTerminal("CLARIFICATION_REQUIRED")).toBe(true);
    expect(isRunTerminal("COMPLETED")).toBe(true);
    expect(isRunTerminal("FAILED")).toBe(true);
    expect(isRunTerminal("CANCELLED")).toBe(true);
    expect(isRunTerminal("QUEUED")).toBe(false);
    expect(isRunTerminal("RUNNING")).toBe(false);
  });

  it("only allows cancelling queued or running runs", () => {
    expect(canCancelRun("QUEUED")).toBe(true);
    expect(canCancelRun("RUNNING")).toBe(true);
    expect(canCancelRun("COMPLETED")).toBe(false);
    expect(canCancelRun("CLARIFICATION_REQUIRED")).toBe(false);
    expect(canCancelRun("FAILED")).toBe(false);
    expect(canCancelRun("CANCELLED")).toBe(false);
  });
});
