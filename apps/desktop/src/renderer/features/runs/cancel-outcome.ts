/**
 * User-visible cancel outcome mapping (Batch P3-5).
 *
 * The Runner's cancel coordinator resolves a structured outcome: CANCELLED
 * (possibly alreadyCancelled), CANCEL_PENDING (foreign live lease), FAILED
 * (CANCEL_CLEANUP_PENDING) or ALREADY_TERMINAL (the Run reached its own
 * terminal state while the cancel was in flight). Pages map it to a notice;
 * duplicate submissions are guarded by the callers (in-flight state disables
 * the button).
 */

import type { RunCancelBridgeResult } from "../../../main/bridge/bridge-contract.js";
import { runStatusLabel } from "../status.js";

export interface CancelNotice {
  readonly id: number;
  readonly tone: "success" | "info" | "warning" | "error";
  readonly title: string;
  readonly text: string;
}

/** Maps a structured cancel outcome to a user-visible notice. */
export function cancelOutcomeNotice(
  outcome: RunCancelBridgeResult,
  runLabel: string,
  id: number
): CancelNotice {
  switch (outcome.status) {
    case "CANCELLED":
      return outcome.alreadyCancelled
        ? {
            id,
            tone: "info",
            title: `Run ${runLabel} 已取消`,
            text: "该任务之前已取消，未生成模型。可随时发起新的 Run。"
          }
        : {
            id,
            tone: "success",
            title: `Run ${runLabel} 已取消`,
            text: "用户主动取消了本次执行，未生成模型。可随时发起新的 Run。"
          };
    case "CANCEL_PENDING":
      return {
        id,
        tone: "warning",
        title: `Run ${runLabel} 取消待处理`,
        text:
          outcome.detail === "FOREIGN_LIVE_LEASE"
            ? "该任务正在其他运行实例上执行；等待执行租约释放后会自动完成取消。"
            : "取消请求已受理，正在等待执行环境释放。"
      };
    case "FAILED":
      return {
        id,
        tone: "error",
        title: `Run ${runLabel} 取消未完成`,
        text:
          outcome.failureCode === "CANCEL_CLEANUP_PENDING"
            ? "清理尚未完成，请稍后重试取消。"
            : "取消未完成，请稍后重试。"
      };
    case "ALREADY_TERMINAL":
      return {
        id,
        tone: "info",
        title: `Run ${runLabel} 已自然结束`,
        text: `取消请求提交时任务已结束（${runStatusLabel(outcome.finalStatus)}），未执行取消。`
      };
  }
}
