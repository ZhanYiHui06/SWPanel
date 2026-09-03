import type { RunFailureCode } from "./run.js";
import type { RunStage } from "./status.js";

/**
 * Version of the structured Run event contract carried by every event.
 * The UI reconnect sequence reads the current snapshot, subscribes after the
 * last known event sequence and applies only valid, ordered events.
 */
export const RUN_EVENT_CONTRACT_VERSION = 1 as const;

export const RUN_EVENT_TYPES = [
  "StageChanged",
  "ActivityUpdated",
  "ProgressUpdated",
  "ClarificationRequired",
  "AgentTurnCompleted",
  "RuntimeMetadataUpdated",
  "ResultManifestReceived",
  "ArtifactValidationFailed",
  "Completed",
  "Failed",
  "CancellationRequested",
  "CancellationConfirmed"
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * Event types that end the Run with a terminal status. A Run event stream must
 * carry exactly one terminal event and it must be the last event; `appendRunEvents`
 * enforces this per batch and the fixture validator enforces it per stream.
 */
export const TERMINAL_RUN_EVENT_TYPES = [
  "Completed",
  "Failed",
  "ClarificationRequired",
  "CancellationConfirmed"
] as const;
export type TerminalRunEventType = (typeof TERMINAL_RUN_EVENT_TYPES)[number];

/** True when the event type ends the Run. */
export function isTerminalRunEventType(type: RunEventType): type is TerminalRunEventType {
  return (TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(type);
}

/** True when the event type belongs to the user-cancellation pair. */
export function isCancellationRunEventType(type: RunEventType): boolean {
  return type === "CancellationRequested" || type === "CancellationConfirmed";
}

/** Mandatory fields present on every Run event. */
export interface RunEventEnvelope {
  contractVersion: typeof RUN_EVENT_CONTRACT_VERSION;
  runId: string;
  attemptId: string;
  /** Monotonically increasing per-Run event sequence. */
  sequence: number;
  occurredAt: string;
  /** Codex thread id, when available. */
  runtimeThreadId?: string;
}

export interface RunStageChangedEvent {
  type: "StageChanged";
  stage: RunStage;
  activity?: string;
}

export interface RunActivityUpdatedEvent {
  type: "ActivityUpdated";
  activity: string;
}

export interface RunProgressUpdatedEvent {
  type: "ProgressUpdated";
  progressPercent: number;
  activity?: string;
}

export interface RunClarificationRequiredEvent {
  type: "ClarificationRequired";
  clarificationRequestId: string;
}

export interface RunAgentTurnCompletedEvent {
  type: "AgentTurnCompleted";
  turnId: string;
}

export interface RunRuntimeMetadataUpdatedEvent {
  type: "RuntimeMetadataUpdated";
  metadata: Readonly<Record<string, unknown>>;
}

export interface RunResultManifestReceivedEvent {
  type: "ResultManifestReceived";
  manifestRef: string;
}

export interface RunArtifactValidationFailedEvent {
  type: "ArtifactValidationFailed";
  failureCode: RunFailureCode;
}

/**
 * Phase 3 semantics: a Run may complete WITHOUT publishing a Model. The Fake
 * Executor `COMPLETED` path deliberately creates no `models` record, so
 * `modelId` stays unset and the event carries no synthetic dangling reference.
 * Phase 5 tightens the publish path again: every Model must trace back to a
 * COMPLETED Run whose Completed event carries the modelId.
 */
export interface RunCompletedEvent {
  type: "Completed";
  modelId?: string;
}

export interface RunFailedEvent {
  type: "Failed";
  failureCode: RunFailureCode;
  failureMessage?: string;
}

export interface RunCancellationRequestedEvent {
  type: "CancellationRequested";
  reason?: string;
}

export interface RunCancellationConfirmedEvent {
  type: "CancellationConfirmed";
}

export type RunEventPayload =
  | RunStageChangedEvent
  | RunActivityUpdatedEvent
  | RunProgressUpdatedEvent
  | RunClarificationRequiredEvent
  | RunAgentTurnCompletedEvent
  | RunRuntimeMetadataUpdatedEvent
  | RunResultManifestReceivedEvent
  | RunArtifactValidationFailedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancellationRequestedEvent
  | RunCancellationConfirmedEvent;

export type RunEvent = RunEventEnvelope & RunEventPayload;
