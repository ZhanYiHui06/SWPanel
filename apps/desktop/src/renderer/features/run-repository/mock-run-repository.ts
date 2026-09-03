/**
 * Explicit Mock Run adapter (Batch P3-5).
 *
 * Serves the Run / Clarification surface from the Phase 1 `MockRepository` in
 * browser dev/tests and canonical scenario tests. This is an EXPLICIT adapter
 * selected by `resolveRunRepository` — the product runtime never falls back to
 * it: production without `window.swpanel` resolves to
 * `UnavailableRunRepository` (an error state, never fixture data).
 *
 * All methods are asynchronous (resolved on the microtask queue) so pages
 * exercise the same loading/error paths as the real bridge. `createRun`
 * accepts ONLY the drawing/revision identity pair and delegates to the mock
 * repository's canonical `run.create`, which freezes the Input Snapshot from
 * its own memory (the same path `createRunForRevision` uses).
 *
 * Live event subscription: the Phase 1 MockRepository has no per-Run event
 * streams, so the adapter delivers the persisted event backlog from the mock
 * run detail and registers the subscriber in a local registry. `emitEvents`
 * pushes scripted live batches to the registered subscribers (test/dev
 * convenience); mock-mode pages do not subscribe and keep their synchronous
 * fixture UI, so this registry never affects the canonical Phase 1 stories.
 */

import type { ModelingRun, RunEvent } from "@swpanel/domain";
import { DomainInvariantError } from "@swpanel/domain";
import type { ClarificationView, RunDetailView, RunListItemView } from "@swpanel/contracts";
import type {
  RunCancelBridgeResult,
  RunDeleteBridgeResult,
  RunEventsBridgePush
} from "../../../main/bridge/bridge-contract.js";
import type { MockRepository } from "../mock-repository/mock-repository.js";
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

function toRunListItem(run: ModelingRun): RunListItemView {
  return {
    runId: run.id,
    runLabel: run.number,
    status: run.status,
    stage: run.stage,
    createdAt: run.createdAt,
    modelId: run.modelId ?? null,
    clarificationRequestId: run.clarificationRequestId ?? null,
    failureCode: run.failureCode ?? null
  };
}

/** Maps mock failures into a structured repository error (never throws). */
function mapFailure(error: unknown): RunRepositoryError {
  if (error instanceof DomainInvariantError) {
    return new RunRepositoryError("INVALID_INPUT", error.message);
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: string }).code === "string"
  ) {
    return new RunRepositoryError((error as { code: string }).code, error.message);
  }
  return toRunRepositoryError(error);
}

export class MockRunRepository implements RunRepository {
  readonly mode = "mock" as const;

  private readonly subscribers = new Map<string, Set<(push: RunEventsBridgePush) => void>>();

  constructor(readonly mock: MockRepository) {}

  /** Scripted live batch push for tests/dev (mock mode has no Runner stream). */
  emitEvents(runId: string, events: readonly RunEvent[]): void {
    const subscribers = this.subscribers.get(runId);
    if (subscribers === undefined || events.length === 0) return;
    const first = events[0];
    if (first === undefined) return;
    const push: RunEventsBridgePush = {
      kind: "runEvents",
      runId,
      fromSequence: first.sequence,
      events
    };
    for (const subscriber of [...subscribers]) subscriber(push);
  }

  /** Scripted structured stream failure for tests/dev. */
  failStream(runId: string, code: string, message: string): void {
    const subscribers = this.subscribers.get(runId);
    if (subscribers === undefined) return;
    for (const subscriber of [...subscribers]) {
      subscriber({ kind: "runEventsError", runId, error: { code, message } });
    }
  }

  listRuns(): Promise<readonly RunListItemView[]> {
    return Promise.resolve(
      [...this.mock.listRuns()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(toRunListItem)
    );
  }

  getRunDetail(runId: string): Promise<RunDetailView> {
    try {
      return Promise.resolve(this.mock.getRunDetail(runId));
    } catch (error) {
      return Promise.reject(mapFailure(error));
    }
  }

  getClarification(clarificationRequestId: string): Promise<ClarificationView> {
    try {
      return Promise.resolve(this.mock.getClarification(clarificationRequestId));
    } catch (error) {
      return Promise.reject(mapFailure(error));
    }
  }

  createRun(input: CreateRunInput): Promise<ModelingRun> {
    try {
      return Promise.resolve(
        this.mock.createRun({ drawingId: input.drawingId, revisionId: input.revisionId })
      );
    } catch (error) {
      return Promise.reject(mapFailure(error));
    }
  }

  cancelRun(input: CancelRunInput): Promise<RunCancelBridgeResult> {
    try {
      const run = this.mock.getRun(input.runId);
      if (run === undefined) {
        return Promise.reject(new RunRepositoryError("NOT_FOUND", `run ${input.runId} not found`));
      }
      if (run.status === "CANCELLED") {
        return Promise.resolve({ runId: run.id, status: "CANCELLED", alreadyCancelled: true });
      }
      this.mock.cancelRun(input.runId, input.reason ?? "用户主动取消");
      return Promise.resolve({ runId: input.runId, status: "CANCELLED", alreadyCancelled: false });
    } catch (error) {
      return Promise.reject(mapFailure(error));
    }
  }

  deleteRun(input: DeleteRunInput): Promise<RunDeleteBridgeResult> {
    try {
      return Promise.resolve(this.mock.deleteRun(input));
    } catch (error) {
      return Promise.reject(mapFailure(error));
    }
  }

  submitClarification(input: SubmitClarificationInput): Promise<ClarificationView> {
    try {
      const request = this.mock.getClarificationRequest(input.clarificationRequestId);
      if (request === undefined) {
        return Promise.reject(
          new RunRepositoryError(
            "NOT_FOUND",
            `clarification request ${input.clarificationRequestId} not found`
          )
        );
      }
      this.mock.submitClarificationAnswers({
        clarificationId: input.clarificationRequestId,
        answers: input.answers,
        answeredAt: input.answeredAt,
        answeredBy: input.answeredBy
      });
      return Promise.resolve(this.mock.getClarification(input.clarificationRequestId));
    } catch (error) {
      return Promise.reject(mapFailure(error));
    }
  }

  subscribeRunEvents(
    input: RunEventSubscriptionInput,
    onPush: (push: RunEventsBridgePush) => void
  ): () => void {
    // Backlog first (like the Runner's subscribe response): the persisted
    // mock events from `fromSequence` onward are delivered synchronously, then
    // the subscriber joins the live registry.
    try {
      const detail = this.mock.getRunDetail(input.runId);
      const backlog = detail.events.filter((event) => event.sequence >= input.fromSequence);
      const first = backlog[0];
      if (first !== undefined) {
        onPush({
          kind: "runEvents",
          runId: input.runId,
          fromSequence: first.sequence,
          events: backlog
        });
      }
    } catch (error) {
      const structured = toRunRepositoryError(error);
      onPush({
        kind: "runEventsError",
        runId: input.runId,
        error: { code: structured.code, message: structured.message }
      });
      return () => undefined;
    }
    let subscribers = this.subscribers.get(input.runId);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.subscribers.set(input.runId, subscribers);
    }
    subscribers.add(onPush);
    return () => {
      const current = this.subscribers.get(input.runId);
      if (current === undefined) return;
      current.delete(onPush);
      if (current.size === 0) this.subscribers.delete(input.runId);
    };
  }
}
