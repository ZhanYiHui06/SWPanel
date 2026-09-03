import type { RunEvent } from "@swpanel/domain";

/**
 * Subscription contract used by the UI reconnect sequence:
 * 1. read the current snapshot,
 * 2. subscribe after the last known event sequence,
 * 3. apply only valid, ordered events.
 */
export interface RunSubscription {
  unsubscribe(): void;
}

/** Ordered per-run event stream with the next expected sequence number. */
export interface RunEventCursor {
  runId: string;
  /** Sequence of the first event the subscriber has not yet seen. */
  fromSequence: number;
  events: readonly RunEvent[];
}

/**
 * Stable codes of a failed Run event stream. The receiver must NOT silently
 * keep applying events after one of these: the snapshot must be re-read and the
 * stream re-subscribed from the last known sequence.
 */
export const RUN_EVENT_STREAM_ERROR_CODES = [
  /** The stream skipped a sequence the receiver has not seen. */
  "RUN_EVENT_GAP",
  /** The peer delivered an envelope/event that violates the contract. */
  "RUN_EVENT_INVALID",
  /** The underlying connection was lost before the subscription ended. */
  "RUN_EVENT_STREAM_LOST",
  /** The client was closed; the subscription is gone. */
  "RUN_EVENT_STREAM_CLOSED"
] as const;
export type RunEventStreamErrorCode = (typeof RUN_EVENT_STREAM_ERROR_CODES)[number];

/** Structured failure of one per-run event subscription. */
export interface RunEventStreamError {
  readonly code: RunEventStreamErrorCode;
  readonly runId: string;
  readonly message: string;
}

export interface RunEventSubscriber {
  /**
   * Pushes a batch of events for one run. Events are delivered in ascending
   * sequence order; the receiver must ignore sequences already applied.
   */
  onRunEvents(batch: RunEventCursor): void;
  /**
   * The subscription failed (gap / invalid envelope / connection lost /
   * closed). The receiver must stop applying events, re-read the current
   * snapshot and re-subscribe from the last known sequence. Optional so
   * one-shot subscribers can ignore stream failures.
   */
  onRunEventsError?(error: RunEventStreamError): void;
}
