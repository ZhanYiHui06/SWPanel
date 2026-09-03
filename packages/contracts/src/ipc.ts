import type { RunEvent } from "@swpanel/domain";
import type { Command, CommandName } from "./commands.js";
import type { RunEventSubscriber } from "./events.js";

/**
 * Versioned local IPC contract used over the Windows Named Pipe between the
 * Electron Main / Renderer and the Agent Runner. Messages are JSON envelopes;
 * the pipe name carries a channel identifier, never business data.
 */
export const IPC_PROTOCOL_VERSION = 1 as const;

/** Canonical query names available over the pipe. */
export const QUERY_NAMES = [
  "drawing.getDetail",
  "drawing.getHistory",
  "revision.getDetail",
  "revision.getHistory",
  "run.getDetail",
  "run.list",
  "model.getDetail",
  "clarification.get",
  "costReport.getDetail",
  "costReport.listByRevision",
  "workspace.getDashboard",
  "costData.get",
  "storage.getSettings"
] as const;
export type QueryName = (typeof QUERY_NAMES)[number];

/** Query request payloads. */
export type QueryRequest =
  | { name: "drawing.getDetail"; payload: { drawingId: string } }
  | { name: "drawing.getHistory"; payload: { drawingId: string } }
  | { name: "revision.getDetail"; payload: { drawingId: string; revisionId: string } }
  | { name: "revision.getHistory"; payload: { drawingId: string; revisionId: string } }
  | { name: "run.getDetail"; payload: { runId: string } }
  | { name: "run.list"; payload: Record<string, never> }
  | { name: "model.getDetail"; payload: { modelId: string } }
  | { name: "clarification.get"; payload: { clarificationRequestId: string } }
  | { name: "costReport.getDetail"; payload: { costReportId: string } }
  | { name: "costReport.listByRevision"; payload: { drawingId: string; revisionId: string } }
  | { name: "workspace.getDashboard"; payload: Record<string, never> }
  | { name: "costData.get"; payload: Record<string, never> }
  | { name: "storage.getSettings"; payload: Record<string, never> };

/**
 * Canonical subscription operations available over the pipe. A subscription is
 * neither a query nor a mutation: `run.subscribe` registers a per-connection
 * per-run event stream, resolves with the persisted backlog (events at or after
 * `fromSequence`, read AFTER the registration so no committed event can be
 * missed) and then receives live batches as server-initiated
 * {@link IpcEventEnvelope} frames.
 */
export const SUBSCRIBE_NAMES = ["run.subscribe"] as const;
export type SubscribeName = (typeof SUBSCRIBE_NAMES)[number];

/** Subscription request payloads. */
export type SubscribeRequest =
  | {
      name: "run.subscribe";
      /** First event sequence the subscriber has not yet seen (0 = whole history). */
      payload: { runId: string; fromSequence: number };
    };

/**
 * Envelope of one request/response exchange. `idempotencyKey` lets the Runner
 * deduplicate repeated delivery of the same mutation over the pipe. Schemas are
 * validated before dispatch; there is no generic command execution endpoint.
 */
export interface IpcRequestEnvelope {
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  requestId: string;
  idempotencyKey?: string;
  channel: "query" | "command" | "subscribe";
  operation: QueryName | CommandName | SubscribeName;
  payload: unknown;
}

export interface IpcResponseEnvelope {
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface IpcHandshakeEnvelope {
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  serverInstanceId: string;
}

/** Server-initiated push of ordered per-run events after a subscription. */
export interface IpcEventEnvelope {
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  kind: "runEvents";
  runId: string;
  /** Sequence of the first event in `events` (or the next expected one when empty). */
  fromSequence: number;
  events: readonly RunEvent[];
}

export type IpcMessage =
  | IpcRequestEnvelope
  | IpcResponseEnvelope
  | IpcHandshakeEnvelope
  | IpcEventEnvelope;

export interface IpcTransport {
  send(message: IpcMessage): void;
  close(): void;
}

/** Runner-side IPC surface. */
export interface IpcServer {
  readonly serverInstanceId: string;
  subscribeRunEvents(runId: string, subscriber: RunEventSubscriber): () => void;
  dispatch(request: IpcRequestEnvelope): Promise<IpcResponseEnvelope>;
  handshake(): IpcHandshakeEnvelope;
  close(): void;
}

/** UI-side IPC surface. */
export interface IpcClient {
  query(name: QueryName, payload: unknown): Promise<IpcResponseEnvelope>;
  command(command: Command): Promise<IpcResponseEnvelope>;
  /**
   * Subscribes to the ordered event stream of one Run. When `fromSequence` is
   * omitted the client first reads the `run.getDetail` snapshot and subscribes
   * after its last event sequence (race-free snapshot-then-subscribe); when
   * provided it subscribes directly (catch-up via the backlog). The subscriber
   * receives the persisted backlog batch, then live batches; duplicates are
   * ignored, gaps/invalid envelopes fail the subscription with a structured
   * error (refetch + resubscribe contract) and connection close ends every
   * subscription. Returns an unsubscribe function.
   */
  subscribeRunEvents(
    runId: string,
    subscriber: RunEventSubscriber,
    options?: { fromSequence?: number }
  ): () => void;
  close(): void;
}
