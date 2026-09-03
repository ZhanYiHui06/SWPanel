import type {
  ClarificationRequest,
  CostDataSnapshot,
  Drawing,
  DrawingRevision,
  ModelingRun,
  ModelReview,
  Model,
  RevisionFact,
  RunEvent
} from "@swpanel/domain";
import type { RunEventCursor, RunEventSubscriber } from "@swpanel/contracts";

/**
 * Phase 1 reserved boundary for the Agent Runner process. These interfaces keep
 * their original reserved shape for the future IPC surface: the Phase 2
 * implementation satisfies the aggregate reads and the transactional write
 * primitive, while the Run event stream arrives with the Phase 3 Run
 * orchestrator.
 */

/** Future application-layer read surface to be implemented by the Runner. */
export interface RunnerApplicationReadModel {
  getDrawing(drawingId: string): Drawing;
  getRevision(revisionId: string): DrawingRevision;
  getRun(runId: string): ModelingRun;
  getModel(modelId: string): Model;
  getModelReview(reviewId: string): ModelReview;
  getClarificationRequest(requestId: string): ClarificationRequest;
  getRevisionFact(factId: string): RevisionFact;
  getCostDataSnapshot(): CostDataSnapshot;
}

/** Future persistence layer owned exclusively by the Runner process. */
export interface RunnerPersistence {
  transaction<T>(work: () => T): T;
  appendRunEvent(event: RunEvent): void;
}

/** Future subscription service for the per-Run ordered event stream. */
export interface RunnerEventStream {
  subscribeRunEvents(runId: string, subscriber: RunEventSubscriber): () => void;
  latestCursor(runId: string): RunEventCursor;
}

/**
 * Reserved facade the Runner exposes to UI clients once the real IPC server
 * exists. Phase 2 does not implement the full surface (Run event streaming and
 * Run persistence land in Phase 3).
 */
export interface RunnerService
  extends RunnerApplicationReadModel,
    RunnerPersistence,
    RunnerEventStream {}

/**
 * Marker proving the reserved boundary compiles against domain and contracts
 * without pulling in any concrete IPC transport.
 */
export const RUNNER_BOUNDARY_VERSION = 1 as const;
