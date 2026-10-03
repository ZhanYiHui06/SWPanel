/**
 * User-facing presentation of Run failures and Run event types.
 *
 * The Runner reports an English `failureMessage` plus a stable `failureCode`.
 * Pages show a Chinese explanation derived from the CODE (with a next step) as
 * the primary text and keep the original code/message as secondary "技术详情".
 */

import { messageForErrorCode } from "../error-messages.js";

const GENERIC_FAILURE = "建模未能完成，请重新发起建模；若多次失败请联系管理员";

/** Chinese primary text for a failed Run (never an English engineering sentence). */
export function runFailureSummary(failureCode: string | null | undefined): string {
  if (failureCode === null || failureCode === undefined || failureCode === "") return GENERIC_FAILURE;
  return messageForErrorCode(failureCode) ?? GENERIC_FAILURE;
}

/** Chinese labels for the structured Run event types shown in the event list. */
export const RUN_EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  StageChanged: "阶段变更",
  ActivityUpdated: "活动更新",
  ProgressUpdated: "进度更新",
  ClarificationRequired: "需要补充信息",
  AgentTurnCompleted: "建模代理完成一轮分析",
  RuntimeMetadataUpdated: "运行信息更新",
  ResultManifestReceived: "收到建模结果清单",
  ArtifactValidationFailed: "建模结果校验未通过",
  Completed: "任务完成",
  Failed: "任务失败",
  CancellationRequested: "已请求取消",
  CancellationConfirmed: "取消已确认"
};

export function runEventTypeLabel(type: string): string {
  return RUN_EVENT_TYPE_LABELS[type] ?? "其他事件";
}
