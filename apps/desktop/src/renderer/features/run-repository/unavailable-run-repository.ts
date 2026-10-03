/**
 * Error-state RunRepository for a product renderer WITHOUT the Electron bridge
 * (`window.swpanel` missing outside development). Every operation fails with a
 * truthful structured error so the Run pages render an explicit error state
 * with retry — the product runtime never silently shows Phase 1 fixture data.
 */

import type { ModelingRun } from "@swpanel/domain";
import type { ClarificationView, RunDetailView, RunListItemView } from "@swpanel/contracts";
import type {
  RunCancelBridgeResult,
  RunDeleteBridgeResult,
  RunEventsBridgePush
} from "../../../main/bridge/bridge-contract.js";
import {
  RunRepositoryError,
  type RunEventSubscriptionInput,
  type RunRepository
} from "./run-repository.js";

const UNAVAILABLE_ERROR = new RunRepositoryError(
  "RUNNER_UNAVAILABLE",
  "未连接到 SWPanel 服务，请确认后端服务已启动。"
);

export class UnavailableRunRepository implements RunRepository {
  readonly mode = "unavailable" as const;
  readonly mock = null;

  listRuns(): Promise<readonly RunListItemView[]> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  getRunDetail(): Promise<RunDetailView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  getClarification(): Promise<ClarificationView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  createRun(): Promise<ModelingRun> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  cancelRun(): Promise<RunCancelBridgeResult> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  deleteRun(): Promise<RunDeleteBridgeResult> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  submitClarification(): Promise<ClarificationView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  /** Surfaces the refusal deterministically as a structured stream error. */
  subscribeRunEvents(
    input: RunEventSubscriptionInput,
    onPush: (push: RunEventsBridgePush) => void
  ): () => void {
    onPush({
      kind: "runEventsError",
      runId: input.runId,
      error: { code: UNAVAILABLE_ERROR.code, message: UNAVAILABLE_ERROR.message }
    });
    return () => undefined;
  }
}
