import { DomainInvariantError } from "../errors.js";

/**
 * Canonical Modeling Run business statuses. Status expresses lifecycle truth;
 * user-visible progress is expressed separately by `RunStage`.
 */
export const RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "CLARIFICATION_REQUIRED",
  "FAILED",
  "CANCELLED"
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The six user-visible execution stages. Agent-internal fine-grained logs do
 * not extend this list and never become product status.
 */
export const RUN_STAGES = [
  "PREPARING",
  "ANALYZING",
  "PLANNING",
  "MODELING",
  "VALIDATING",
  "PACKAGING"
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

/** Canonical user-visible wording for every Run status. */
export const RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  QUEUED: "等待执行",
  RUNNING: "执行中",
  COMPLETED: "已完成",
  CLARIFICATION_REQUIRED: "需要补充信息",
  FAILED: "执行失败",
  CANCELLED: "已取消"
};

/** Canonical user-visible wording for every Run stage. */
export const RUN_STAGE_LABELS: Readonly<Record<RunStage, string>> = {
  PREPARING: "准备任务",
  ANALYZING: "分析图纸",
  PLANNING: "规划模型",
  MODELING: "SolidWorks 建模",
  VALIDATING: "检查模型",
  PACKAGING: "生成结果"
};

/**
 * Terminal states. `CLARIFICATION_REQUIRED` is terminal: a Run never resumes
 * after answers are submitted; a new Run is created instead.
 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "COMPLETED",
  "CLARIFICATION_REQUIRED",
  "FAILED",
  "CANCELLED"
];

export function isRunTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Users may only cancel QUEUED or RUNNING Runs. */
export function canCancelRun(status: RunStatus): boolean {
  return status === "QUEUED" || status === "RUNNING";
}

const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["COMPLETED", "CLARIFICATION_REQUIRED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  CLARIFICATION_REQUIRED: [],
  FAILED: [],
  CANCELLED: []
};

/**
 * Returns `next` when the transition is legal, otherwise throws
 * `DomainInvariantError`. Rejecting the same status is a no-op.
 */
export function transitionRunStatus(current: RunStatus, next: RunStatus): RunStatus {
  if (current === next) return current;
  if (!RUN_STATUS_TRANSITIONS[current].includes(next)) {
    throw new DomainInvariantError(`Illegal run status transition: ${current} -> ${next}`);
  }
  return next;
}
