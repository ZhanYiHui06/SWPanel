/**
 * Phase 3 async Run / Clarification repository surface (Batch P3-5).
 *
 * This is the runtime data contract behind every Run page (Workbench,
 * 建模任务, Drawing Workspace · 建模记录, Run Detail) plus the Run creation
 * action on the Drawing Overview page. It is deliberately asynchronous so the
 * SAME conceptual surface runs against:
 *
 * - the real `window.swpanel.runs` / `window.swpanel.clarifications` bridge
 *   (`BridgeRunRepository`) in the packaged/desktop product runtime — data
 *   comes from the real Runner (SQLite run repository + serial Fake Executor
 *   queue), never from Phase 1 fixtures;
 * - an explicit `MockRunRepository` adapter in browser dev/tests — this is the
 *   ONLY place the Phase 1 `MockRepository` may serve Run pages, and it is an
 *   explicit, documented adapter, never a silent product fallback;
 * - `UnavailableRunRepository` when the product renderer has no bridge (an
 *   error state, never fixture data).
 *
 * Subscription lifecycle (see `useRunEventStream` in the provider module):
 * snapshot-then-subscribe from `lastEventSequence`, strict ordered application
 * (duplicates ignored), gap / invalid / lost stream errors trigger a refetch of
 * the `run.getDetail` snapshot and a resubscribe from the new last sequence,
 * and every subscription is torn down on route unmount / runId change.
 *
 * Mutations NEVER forge the Input Snapshot: `createRun` accepts ONLY the
 * drawing/revision identity pair and the Runner freezes the snapshot itself.
 */

import type { ClarificationAnswer, ModelingRun, RunEvent } from "@swpanel/domain";
import type { ClarificationView, RunDetailView, RunListItemView } from "@swpanel/contracts";
import type {
  RunCancelBridgeResult,
  RunDeleteBridgeResult,
  RunEventsBridgePush
} from "../../../main/bridge/bridge-contract.js";
import type { MockRepository } from "../mock-repository/mock-repository.js";

/** Structured repository error carrying the stable bridge/runner error code. */
export class RunRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunRepositoryError";
    this.code = code;
  }
}

/** Converts any thrown value into a structured run repository error. */
export function toRunRepositoryError(error: unknown): RunRepositoryError {
  if (error instanceof RunRepositoryError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return new RunRepositoryError((error as { code: string }).code, error.message);
  }
  return new RunRepositoryError("UNKNOWN", error instanceof Error ? error.message : String(error));
}

/** True when the error is the structured NOT_FOUND business failure. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof RunRepositoryError && error.code === "NOT_FOUND";
}

export interface CreateRunInput {
  readonly drawingId: string;
  readonly revisionId: string;
}

export interface CancelRunInput {
  readonly runId: string;
  readonly reason?: string;
}

/** Deletion input: the Run plus its owning drawing/revision identity pair. */
export interface DeleteRunInput {
  readonly runId: string;
  readonly drawingId: string;
  readonly revisionId: string;
}

/** One clarification answer as submitted to the Runner (id may be minted by the form). */
export interface ClarificationAnswerInput {
  readonly id: string;
  readonly questionId: string;
  readonly value: ClarificationAnswer["value"];
  readonly answeredAt: string;
  readonly answeredBy: string;
}

export interface SubmitClarificationInput {
  readonly clarificationRequestId: string;
  readonly answers: readonly ClarificationAnswerInput[];
  readonly answeredAt: string;
  readonly answeredBy: string;
}

export interface RunEventSubscriptionInput {
  readonly runId: string;
  /** First event sequence not yet seen by the caller (0 = whole history). */
  readonly fromSequence: number;
}

/**
 * Async data + command surface consumed by the Run pages. Implementations:
 * `BridgeRunRepository` (product), `MockRunRepository` (explicit dev/test
 * adapter), `UnavailableRunRepository` (error state).
 */
export interface RunRepository {
  /** Which runtime the adapter represents (documented separation). */
  readonly mode: "bridge" | "mock" | "unavailable";
  /** The Phase 1 MockRepository backing this adapter, or null. */
  readonly mock: MockRepository | null;

  // ── Reads ─────────────────────────────────────────────────────────────────
  /** Workspace-wide Run list (newest first). */
  listRuns(): Promise<readonly RunListItemView[]>;
  getRunDetail(runId: string): Promise<RunDetailView>;
  getClarification(clarificationRequestId: string): Promise<ClarificationView>;

  // ── Run commands ──────────────────────────────────────────────────────────
  /**
   * Creates a QUEUED Modeling Run for the drawing/revision identity pair. The
   * caller submits ONLY the pair: the Runner (or mock standing in for it)
   * freezes the Input Snapshot from its own memory at creation time.
   */
  createRun(input: CreateRunInput): Promise<ModelingRun>;
  /**
   * Cancels a QUEUED or RUNNING Run. Resolves the structured cancel outcome
   * (CANCELLED / CANCEL_PENDING / FAILED cleanup pending / ALREADY_TERMINAL)
   * echoed from the Runner's cancel coordinator.
   */
  cancelRun(input: CancelRunInput): Promise<RunCancelBridgeResult>;
  /**
   * Deletes ONE terminal Run (COMPLETED / FAILED / CANCELLED): the delegate
   * (Runner or mock) guards the owning drawing/revision scope and removes the
   * Run record plus its workspace/event history at the attempt scope.
   */
  deleteRun(input: DeleteRunInput): Promise<RunDeleteBridgeResult>;

  // ── Clarification commands ────────────────────────────────────────────────
  /**
   * Persists answers on the OLD (terminal CLARIFICATION_REQUIRED) Run's
   * request. The Run is never resumed; the returned view reflects the answered
   * request.
   */
  submitClarification(input: SubmitClarificationInput): Promise<ClarificationView>;

  // ── Live event subscription ───────────────────────────────────────────────
  /**
   * Subscribes to the ordered event stream of one Run starting at
   * `fromSequence`. `onPush` receives already-main-side-validated batches and
   * structured stream failures; the caller applies events strictly ordered
   * (duplicates ignored) and refetches + resubscribes on stream errors. The
   * returned function unsubscribes and must be called on unmount / runId
   * change.
   */
  subscribeRunEvents(
    input: RunEventSubscriptionInput,
    onPush: (push: RunEventsBridgePush) => void
  ): () => void;
}

// ---------------------------------------------------------------------------
// Pure event application (snapshot + ordered events -> merged detail)
// ---------------------------------------------------------------------------

/**
 * Applies ONE ordered Run event onto a `RunDetailView`, producing the next
 * merged detail. The first execution event (StageChanged / ActivityUpdated /
 * ProgressUpdated) infers the QUEUED -> RUNNING transition and records
 * `startedAt`; later events never overwrite it. Terminal events update the run
 * status truthfully (a Phase 3 `Completed` event may carry NO modelId — the run
 * then completes model-less).
 */
export function applyRunEventToDetail(
  detail: RunDetailView,
  event: RunEvent
): RunDetailView {
  const run = { ...detail.run };
  switch (event.type) {
    case "StageChanged":
      startIfQueued(run, event.occurredAt);
      run.stage = event.stage;
      if (event.activity !== undefined) run.activity = event.activity;
      break;
    case "ActivityUpdated":
      startIfQueued(run, event.occurredAt);
      run.activity = event.activity;
      break;
    case "ProgressUpdated":
      startIfQueued(run, event.occurredAt);
      run.progressPercent = event.progressPercent;
      if (event.activity !== undefined) run.activity = event.activity;
      break;
    case "ClarificationRequired":
      // Terminal event: the Run ends here and is never resumed.
      run.status = "CLARIFICATION_REQUIRED";
      run.clarificationRequestId = event.clarificationRequestId;
      run.completedAt = event.occurredAt;
      break;
    case "Completed":
      run.status = "COMPLETED";
      run.completedAt = event.occurredAt;
      if (event.modelId !== undefined) run.modelId = event.modelId;
      break;
    case "Failed":
      run.status = "FAILED";
      run.failureCode = event.failureCode;
      if (event.failureMessage !== undefined) run.failureMessage = event.failureMessage;
      run.completedAt = event.occurredAt;
      break;
    case "CancellationConfirmed":
      run.status = "CANCELLED";
      run.completedAt = event.occurredAt;
      break;
    default:
      // AgentTurnCompleted / RuntimeMetadataUpdated / ResultManifestReceived /
      // ArtifactValidationFailed / CancellationRequested carry no
      // user-visible run fields (a cancellation only lands once confirmed).
      break;
  }
  return { run, events: [...detail.events, event], lastEventSequence: event.sequence };
}

/** First execution event of a QUEUED run starts it (RUNNING + startedAt). */
function startIfQueued(
  run: RunDetailView["run"],
  occurredAt: string
): void {
  if (run.status === "QUEUED") {
    run.status = "RUNNING";
    run.startedAt = occurredAt;
  }
}
