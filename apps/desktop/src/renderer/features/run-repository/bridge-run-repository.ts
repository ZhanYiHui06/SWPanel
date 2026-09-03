/**
 * Product-runtime RunRepository backed by the real `window.swpanel` Electron
 * bridge (`runs` / `clarifications` surface). Every method maps 1:1 onto an
 * allowlisted, typed bridge method and unwraps the `BridgeResult<T>` envelope
 * into data (or a structured `RunRepositoryError`). No Node imports, no
 * globals besides the frozen bridge object, no generic channel access.
 *
 * The Runner owns the Input Snapshot: `createRun` submits ONLY the
 * drawing/revision identity pair (the bridge validator rejects anything else).
 */

import type { ModelingRun } from "@swpanel/domain";
import type { ClarificationView, RunDetailView, RunListItemView } from "@swpanel/contracts";
import type {
  BridgeResult,
  RunCancelBridgeResult,
  RunDeleteBridgeResult,
  RunEventsBridgePush,
  SwpanelBridgeApi
} from "../../../main/bridge/bridge-contract.js";
import {
  RunRepositoryError,
  toRunRepositoryError,
  type CancelRunInput,
  type CreateRunInput,
  type DeleteRunInput,
  type RunEventSubscriptionInput,
  type RunRepository,
  type SubmitClarificationInput
} from "./run-repository.js";

export class BridgeRunRepository implements RunRepository {
  readonly mode = "bridge" as const;
  readonly mock = null;

  constructor(private readonly api: SwpanelBridgeApi) {}

  /** Unwraps the bridge envelope: data on ok, structured error on failure. */
  private async unwrap<T>(result: Promise<BridgeResult<T>>): Promise<T> {
    const resolved = await result;
    if (resolved.ok) return resolved.data;
    throw new RunRepositoryError(resolved.error.code, resolved.error.message);
  }

  listRuns(): Promise<readonly RunListItemView[]> {
    return this.unwrap(this.api.runs.list());
  }

  getRunDetail(runId: string): Promise<RunDetailView> {
    return this.unwrap(this.api.runs.getDetail(runId));
  }

  getClarification(clarificationRequestId: string): Promise<ClarificationView> {
    return this.unwrap(this.api.clarifications.get(clarificationRequestId));
  }

  createRun(input: CreateRunInput): Promise<ModelingRun> {
    return this.unwrap(
      this.api.runs.create({ drawingId: input.drawingId, revisionId: input.revisionId })
    );
  }

  cancelRun(input: CancelRunInput): Promise<RunCancelBridgeResult> {
    return this.unwrap(
      this.api.runs.cancel({
        runId: input.runId,
        ...(input.reason === undefined ? {} : { reason: input.reason })
      })
    );
  }

  deleteRun(input: DeleteRunInput): Promise<RunDeleteBridgeResult> {
    return this.unwrap(
      this.api.runs.delete({
        runId: input.runId,
        drawingId: input.drawingId,
        revisionId: input.revisionId
      })
    );
  }

  submitClarification(input: SubmitClarificationInput): Promise<ClarificationView> {
    return this.unwrap(
      this.api.clarifications.submit({
        clarificationRequestId: input.clarificationRequestId,
        answers: input.answers,
        answeredAt: input.answeredAt,
        answeredBy: input.answeredBy
      })
    );
  }

  subscribeRunEvents(
    input: RunEventSubscriptionInput,
    onPush: (push: RunEventsBridgePush) => void
  ): () => void {
    try {
      return this.api.runs.subscribe(
        { runId: input.runId, fromSequence: input.fromSequence },
        onPush
      );
    } catch (error) {
      // A synchronous bridge failure still surfaces deterministically as a
      // structured stream error instead of an unhandled throw.
      const structured = toRunRepositoryError(error);
      onPush({
        kind: "runEventsError",
        runId: input.runId,
        error: { code: structured.code, message: structured.message }
      });
      return () => undefined;
    }
  }
}
