import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

import type {
  Command,
  IpcClient as IpcClientContract,
  IpcEventEnvelope,
  IpcHandshakeEnvelope,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
  QueryName,
  RunEventCursor,
  RunEventStreamErrorCode,
  RunEventSubscriber
} from "@swpanel/contracts";
import {
  FrameCodec,
  IPC_PROTOCOL_VERSION,
  IpcValidationError,
  validateIpcEventEnvelope,
  validateIpcHandshakeEnvelope,
  validateIpcResponseEnvelope
} from "@swpanel/contracts";
import type { RunEvent } from "@swpanel/domain";

import {
  IpcClientClosedError,
  IpcClientError,
  IpcConnectError,
  IpcConnectionLostError,
  IpcInvalidResponseError,
  IpcProtocolVersionError,
  IpcRequestTimeoutError,
  IpcServerInstanceChangedError
} from "./errors.js";
import type { IpcClientTransport } from "./transport.js";

/**
 * Electron Main-side IPC client of the Agent Runner (WP4). Speaks the exact
 * wire format shared by `@swpanel/contracts`: newline-delimited JSON frames
 * with a 1 MiB cap, a handshake immediately on connect, validated
 * request/response envelopes and (requestId, idempotencyKey) replay support.
 *
 * Responsibilities:
 *
 * - `query` / `command` build versioned envelopes with a fresh request id and
 *   dispatch them over the connection;
 * - per-request timeouts reject with {@link IpcRequestTimeoutError};
 * - the connection is re-established on demand: when a connection drops,
 *   in-flight requests are invalidated with {@link IpcConnectionLostError} and
 *   the next request reconnects (up to `maxConnectAttempts`, with a
 *   `reconnectDelayMs` pause between attempts);
 * - identity: when `expectedServerInstanceId` is configured, every handshake
 *   is verified against it and a mismatch throws
 *   {@link IpcServerInstanceChangedError} so the caller can re-read snapshots;
 * - `subscribeRunEvents` (Phase 3, P3-4) implements the real per-Run event
 *   stream over the pipe: race-free snapshot-then-subscribe (or a direct
 *   `fromSequence` catch-up), the persisted backlog is delivered first, then
 *   live `runEvents` envelopes. Envelopes are validated against the contract;
 *   duplicates are ignored; a strict-monotonicity violation or a sequence gap
 *   fails the subscription with a structured error (the caller re-reads the
 *   snapshot and resubscribes) instead of silently applying. Unsubscribe and
 *   connection close clean every subscription;
 * - the raw `Duplex` is owned privately and never exposed to the Renderer or
 *   Preload; `close` terminates the connection and rejects outstanding
 *   requests.
 */

/** Default per-request timeout when the caller does not specify one. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Default connect timeout per attempt. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** Default number of connection attempts per logical connection. */
export const DEFAULT_MAX_CONNECT_ATTEMPTS = 1;
/** Default pause between connection attempts, in milliseconds. */
export const DEFAULT_RECONNECT_DELAY_MS = 250;

export interface IpcClientOptions {
  /** Connection factory; defaults to the real Windows Named Pipe transport. */
  transport: IpcClientTransport;
  /**
   * Identity the client binds to. When set, every handshake must carry this
   * `serverInstanceId`; a different value means the Runner restarted and the
   * caller must re-read its snapshot ({@link IpcServerInstanceChangedError}).
   * When unset the client accepts the first handshake and binds to it.
   */
  expectedServerInstanceId?: string;
  /** Per-request timeout in milliseconds (default 10s). */
  requestTimeoutMs?: number;
  /** Per-attempt connect timeout in milliseconds (default 5s). */
  connectTimeoutMs?: number;
  /** Connection attempts per logical connection (default 1). */
  maxConnectAttempts?: number;
  /** Pause between connection attempts in milliseconds (default 250ms). */
  reconnectDelayMs?: number;
}

export interface IpcQueryOptions {
  requestTimeoutMs?: number;
}

export interface IpcCommandOptions {
  requestTimeoutMs?: number;
  /** Replay key so the Runner deduplicates retried mutations. */
  idempotencyKey?: string;
}

export interface IpcSubscribeOptions {
  /**
   * First event sequence the subscriber has not yet seen. Omitted: the client
   * reads the `run.getDetail` snapshot and subscribes after its last event
   * sequence (race-free snapshot-then-subscribe).
   */
  fromSequence?: number;
}

interface PendingRequest {
  resolve(response: IpcResponseEnvelope): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

/**
 * One client-side per-Run event subscription. `lastApplied` is the watermark
 * of the last sequence the subscriber received; every envelope is checked
 * against it (duplicates ignored, gaps fail the subscription).
 */
interface ClientRunSubscription {
  runId: string;
  subscriber: RunEventSubscriber;
  lastApplied: number;
  active: boolean;
  /** The connection the subscription is registered on (after the backlog resolves). */
  connection: ActiveConnection | null;
}

interface ActiveConnection {
  stream: Duplex;
  codec: FrameCodec;
  serverInstanceId: string;
  closed: boolean;
  pending: Map<string, PendingRequest>;
  subscriptions: Set<ClientRunSubscription>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newRequestId(): string {
  return randomUUID();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Conforms to the shared {@link IpcClientContract} surface. */
export class IpcClientImpl implements IpcClientContract {
  private readonly transport: IpcClientTransport;
  private readonly expectedServerInstanceId: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxConnectAttempts: number;
  private readonly reconnectDelayMs: number;

  private connection: ActiveConnection | null = null;
  private connecting: Promise<ActiveConnection> | null = null;
  private closed = false;
  private currentServerInstanceId: string | undefined;

  constructor(options: IpcClientOptions) {
    this.transport = options.transport;
    this.expectedServerInstanceId = options.expectedServerInstanceId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxConnectAttempts = options.maxConnectAttempts ?? DEFAULT_MAX_CONNECT_ATTEMPTS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  /** The server instance the client is bound to, or undefined before the first handshake. */
  get serverInstanceId(): string | undefined {
    return this.currentServerInstanceId;
  }

  /** True while a connection is established and not known to be closed. */
  get isConnected(): boolean {
    return this.connection !== null && !this.connection.closed;
  }

  /**
   * Dispatches a query. The payload is passed through to the Runner's payload
   * validation, so queries with identifier fields require exactly those fields
   * and empty-payload queries require `{}`.
   */
  query(name: QueryName, payload: unknown, options: IpcQueryOptions = {}): Promise<IpcResponseEnvelope> {
    const request: IpcRequestEnvelope = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: newRequestId(),
      channel: "query",
      operation: name,
      payload
    };
    return this.dispatch(request, options.requestTimeoutMs);
  }

  /**
   * Dispatches a command. The full `Command` object travels as the envelope
   * payload (the `command` discriminator lets the Runner's payload validation
   * confirm the channel/operation pairing). Provide `idempotencyKey` to make a
   * retry safe: the Runner answers a repeated (requestId, idempotencyKey) pair
   * from cache without re-executing the mutation.
   */
  command(command: Command, options: IpcCommandOptions = {}): Promise<IpcResponseEnvelope> {
    const request: IpcRequestEnvelope = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: newRequestId(),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      channel: "command",
      operation: command.command,
      payload: command
    };
    return this.dispatch(request, options.requestTimeoutMs);
  }

  /**
   * Subscribes to the ordered event stream of one Run (Phase 3, P3-4). Without
   * `options.fromSequence` the client first reads the `run.getDetail` snapshot
   * and subscribes after its last event sequence (race-free snapshot-then-
   * subscribe); with `fromSequence` it subscribes directly and the backlog
   * catches the stream up. The subscriber receives the persisted backlog
   * batch, then live batches; duplicates are ignored, a strict-monotonicity
   * violation or a sequence gap fails the subscription with a structured error
   * (refetch + resubscribe contract) and connection close / unsubscribe ends
   * the stream.
   */
  subscribeRunEvents(
    runId: string,
    subscriber: RunEventSubscriber,
    options: IpcSubscribeOptions = {}
  ): () => void {
    const subscription: ClientRunSubscription = {
      runId,
      subscriber,
      lastApplied: -1,
      active: true,
      connection: null
    };
    void this.runSubscriptionFlow(subscription, options.fromSequence);
    return () => this.endSubscription(subscription);
  }

  /**
   * Terminates the connection, rejects every outstanding request with
   * {@link IpcClientClosedError} and fails every active subscription with
   * `RUN_EVENT_STREAM_CLOSED`. The client cannot be used afterwards.
   */
  close(): void {
    this.closed = true;
    if (this.connection !== null) {
      this.failConnection(this.connection, new IpcClientClosedError());
    }
  }

  // -------------------------------------------------------------------------
  // Request dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    request: IpcRequestEnvelope,
    perRequestTimeoutMs?: number
  ): Promise<IpcResponseEnvelope> {
    if (this.closed) {
      throw new IpcClientClosedError();
    }
    let connection: ActiveConnection;
    try {
      connection = await this.ensureConnection();
    } catch (error) {
      if (error instanceof IpcClientError) throw error;
      throw new IpcConnectError(
        error instanceof Error ? error.message : String(error),
        error
      );
    }
    if (connection.closed) {
      throw new IpcConnectionLostError(
        "The Runner connection dropped before the request could be sent"
      );
    }
    return this.sendRequest(connection, request, perRequestTimeoutMs ?? this.requestTimeoutMs);
  }

  /** Sends one envelope through the pending-request machinery of a connection. */
  private sendRequest(
    connection: ActiveConnection,
    request: IpcRequestEnvelope,
    timeoutMs: number
  ): Promise<IpcResponseEnvelope> {
    return new Promise<IpcResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = connection.pending.get(request.requestId);
        if (pending !== undefined) {
          connection.pending.delete(request.requestId);
          reject(new IpcRequestTimeoutError(request.requestId, timeoutMs));
        }
      }, timeoutMs);
      connection.pending.set(request.requestId, { resolve, reject, timer });
      try {
        connection.stream.write(FrameCodec.encode(request));
      } catch (error) {
        clearTimeout(timer);
        connection.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Run event subscription (Phase 3, P3-4)
  // -------------------------------------------------------------------------

  /**
   * The race-free subscription flow: snapshot (optional) -> connect -> send
   * `run.subscribe` -> register the subscription on the connection -> apply
   * the persisted backlog. The server registers the per-connection subscription
   * BEFORE reading the backlog and resolves the response synchronously, so the
   * backlog is always delivered before any live push and no committed event
   * can be missed.
   */
  private async runSubscriptionFlow(
    subscription: ClientRunSubscription,
    fromSequence: number | undefined
  ): Promise<void> {
    if (this.closed) {
      this.failSubscription(
        subscription,
        "RUN_EVENT_STREAM_CLOSED",
        "The IPC client is closed; the Run event stream is gone"
      );
      return;
    }
    try {
      let startSequence: number;
      if (fromSequence === undefined) {
        const snapshot = await this.query("run.getDetail", { runId: subscription.runId });
        if (!snapshot.ok) {
          this.failSubscription(
            subscription,
            "RUN_EVENT_INVALID",
            `The Run snapshot could not be read (${snapshot.error?.code ?? "UNKNOWN"}): ` +
              (snapshot.error?.message ?? "no error detail")
          );
          return;
        }
        const detail = snapshot.data as { lastEventSequence: number };
        startSequence = detail.lastEventSequence + 1;
      } else {
        startSequence = fromSequence;
      }
      if (!subscription.active) return;
      // The watermark floor: sequences below `fromSequence` are considered
      // already seen. Event sequences are 1-based, so a whole-history
      // subscription (fromSequence 0) expects its first event at 1.
      subscription.lastApplied = Math.max(startSequence - 1, 0);

      const connection = await this.ensureConnection();
      if (connection.closed) {
        this.failSubscription(
          subscription,
          "RUN_EVENT_STREAM_LOST",
          "The Runner connection dropped before the subscription could be registered"
        );
        return;
      }
      if (!subscription.active) return;
      const response = await this.sendRequest(
        connection,
        {
          protocolVersion: IPC_PROTOCOL_VERSION,
          requestId: newRequestId(),
          channel: "subscribe",
          operation: "run.subscribe",
          payload: { runId: subscription.runId, fromSequence: startSequence }
        },
        this.requestTimeoutMs
      );
      if (!subscription.active) return;
      if (!response.ok) {
        this.failSubscription(
          subscription,
          "RUN_EVENT_INVALID",
          response.error?.message ?? "The Run subscription was rejected"
        );
        return;
      }
      if (connection.closed) {
        this.failSubscription(
          subscription,
          "RUN_EVENT_STREAM_LOST",
          "The Runner connection dropped before the subscription could be registered"
        );
        return;
      }
      // Register BEFORE applying the backlog: the response is always written by
      // the server before any live push, but registering first keeps the
      // ordering guarantee airtight regardless.
      this.replaceConnectionSubscription(connection, subscription);
      const cursor = response.data as RunEventCursor;
      this.applyBatch(subscription, cursor);
    } catch (error) {
      this.failSubscription(
        subscription,
        error instanceof IpcClientClosedError ? "RUN_EVENT_STREAM_CLOSED" : "RUN_EVENT_STREAM_LOST",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /** Replaces an existing subscription of the same Run on the connection. */
  private replaceConnectionSubscription(
    connection: ActiveConnection,
    subscription: ClientRunSubscription
  ): void {
    for (const existing of connection.subscriptions) {
      if (existing.runId === subscription.runId) {
        connection.subscriptions.delete(existing);
        existing.active = false;
        existing.connection = null;
      }
    }
    subscription.connection = connection;
    connection.subscriptions.add(subscription);
  }

  /**
   * Applies one batch (backlog cursor or live envelope) against the
   * subscription watermark: duplicates are ignored, events must be strictly
   * monotonic within the batch, and the first event beyond `lastApplied + 1`
   * is a GAP that fails the subscription (refetch + resubscribe contract)
   * instead of being silently applied.
   */
  private applyBatch(subscription: ClientRunSubscription, cursor: RunEventCursor): void {
    if (!subscription.active) return;
    const applied: RunEvent[] = [];
    let firstApplied: number | null = null;
    for (const event of cursor.events) {
      if (applied.length > 0 && event.sequence <= (applied[applied.length - 1] as RunEvent).sequence) {
        this.failSubscription(
          subscription,
          "RUN_EVENT_INVALID",
          `Batch of run ${subscription.runId} is not strictly monotonic`
        );
        return;
      }
      if (event.sequence <= subscription.lastApplied) continue; // duplicate: ignore
      if (event.sequence > subscription.lastApplied + 1) {
        this.failSubscription(
          subscription,
          "RUN_EVENT_GAP",
          `Run event stream of ${subscription.runId} skipped sequence ${subscription.lastApplied + 1}: ` +
            `expected it, got ${event.sequence}; re-read the snapshot and resubscribe`
        );
        return;
      }
      subscription.lastApplied = event.sequence;
      if (firstApplied === null) firstApplied = event.sequence;
      applied.push(event);
    }
    if (applied.length === 0) return;
    subscription.subscriber.onRunEvents({
      runId: subscription.runId,
      fromSequence: firstApplied as number,
      events: applied
    });
  }

  /** Handles one server-initiated `runEvents` frame of a connection. */
  private onRunEventsEnvelope(connection: ActiveConnection, value: unknown): void {
    let envelope: IpcEventEnvelope;
    try {
      envelope = validateIpcEventEnvelope(value);
    } catch (error) {
      // A malformed event frame means the peer is not speaking the contract;
      // the connection is no longer trustworthy.
      this.failConnection(
        connection,
        new IpcInvalidResponseError(
          `Invalid runEvents frame: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }
    const first = envelope.events[0];
    if (first !== undefined && envelope.fromSequence !== first.sequence) {
      this.failConnection(
        connection,
        new IpcInvalidResponseError(
          `runEvents frame of ${envelope.runId} carries fromSequence ${envelope.fromSequence} ` +
            `but its first event sequence is ${first.sequence}`
        )
      );
      return;
    }
    for (const subscription of connection.subscriptions) {
      if (subscription.runId !== envelope.runId) continue;
      this.applyBatch(subscription, {
        runId: envelope.runId,
        fromSequence: envelope.fromSequence,
        events: envelope.events
      });
      return;
    }
    // No subscription for this run on this connection (late envelope after
    // unsubscribe): ignored.
  }

  /** Ends a subscription silently (unsubscribe). */
  private endSubscription(subscription: ClientRunSubscription): void {
    if (!subscription.active) return;
    subscription.active = false;
    const connection = subscription.connection;
    subscription.connection = null;
    if (connection !== null) {
      connection.subscriptions.delete(subscription);
    }
  }

  /** Fails a subscription with a structured stream error and removes it. */
  private failSubscription(
    subscription: ClientRunSubscription,
    code: RunEventStreamErrorCode,
    message: string
  ): void {
    if (!subscription.active) return;
    subscription.active = false;
    const connection = subscription.connection;
    subscription.connection = null;
    if (connection !== null) {
      connection.subscriptions.delete(subscription);
    }
    subscription.subscriber.onRunEventsError?.({
      code,
      runId: subscription.runId,
      message
    });
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private async ensureConnection(): Promise<ActiveConnection> {
    const existing = this.connection;
    if (existing !== null && !existing.closed) {
      return existing;
    }
    if (this.connecting !== null) {
      return this.connecting;
    }
    this.connecting = this.connectWithRetry().then(
      (connection) => {
        this.connection = connection;
        this.connecting = null;
        return connection;
      },
      (error: unknown) => {
        // Clear the rejected connecting promise so a LATER request can attempt
        // a fresh connection: a permanently rejected `connecting` would poison
        // every subsequent request even after the Runner becomes reachable.
        this.connecting = null;
        throw error;
      }
    );
    return this.connecting;
  }

  private async connectWithRetry(): Promise<ActiveConnection> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxConnectAttempts; attempt++) {
      try {
        return await this.connectOnce();
      } catch (error) {
        lastError = error;
        if (attempt < this.maxConnectAttempts) {
          await delay(this.reconnectDelayMs);
        }
      }
    }
    if (lastError instanceof IpcClientError) throw lastError;
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new IpcConnectError(message, lastError);
  }

  private async connectOnce(): Promise<ActiveConnection> {
    const stream = await this.withConnectTimeout(this.transport.connect());
    const codec = new FrameCodec();
    stream.pipe(codec);
    const connection: ActiveConnection = {
      stream,
      codec,
      serverInstanceId: "",
      closed: false,
      pending: new Map(),
      subscriptions: new Set()
    };

    // The first frame is always the handshake; consume it before treating any
    // later frame as a response.
    let handshake: IpcHandshakeEnvelope;
    try {
      handshake = await this.readHandshake(connection);
    } catch (error) {
      connection.closed = true;
      stream.destroy();
      throw error;
    }
    if (handshake.protocolVersion !== IPC_PROTOCOL_VERSION) {
      connection.closed = true;
      stream.destroy();
      throw new IpcProtocolVersionError(
        `Runner spoke protocolVersion ${JSON.stringify(handshake.protocolVersion)}; ` +
          `this client speaks protocolVersion ${String(IPC_PROTOCOL_VERSION)}`
      );
    }
    if (
      this.expectedServerInstanceId !== undefined &&
      handshake.serverInstanceId !== this.expectedServerInstanceId
    ) {
      connection.closed = true;
      stream.destroy();
      throw new IpcServerInstanceChangedError(
        this.expectedServerInstanceId,
        handshake.serverInstanceId
      );
    }
    connection.serverInstanceId = handshake.serverInstanceId;
    this.currentServerInstanceId = handshake.serverInstanceId;

    codec.on("data", (line: string) => {
      this.onFrame(connection, line);
    });
    const onFailure = (): void => {
      this.failConnection(
        connection,
        new IpcConnectionLostError("The connection to the Runner was lost")
      );
    };
    codec.on("error", onFailure);
    stream.once("end", onFailure);
    stream.once("close", onFailure);
    stream.on("error", onFailure);

    return connection;
  }

  private readHandshake(connection: ActiveConnection): Promise<IpcHandshakeEnvelope> {
    return new Promise<IpcHandshakeEnvelope>((resolve, reject) => {
      const cleanup = (): void => {
        connection.codec.off("data", onData);
        connection.codec.off("error", onError);
        connection.stream.off("end", onFailure);
        connection.stream.off("close", onFailure);
      };
      const onData = (line: string): void => {
        cleanup();
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          reject(
            new IpcInvalidResponseError(
              `The handshake frame was not valid JSON: ${String(error)}`
            )
          );
          return;
        }
        try {
          resolve(validateIpcHandshakeEnvelope(parsed));
        } catch (error) {
          // A version mismatch is a first-class failure (IpcProtocolVersionError);
          // every other invalid handshake shape is a malformed-peer failure.
          if (error instanceof IpcValidationError && error.code === "PROTOCOL_VERSION_MISMATCH") {
            reject(
              new IpcProtocolVersionError(
                `Runner spoke a different protocol version: ${error.message}`
              )
            );
            return;
          }
          reject(
            new IpcInvalidResponseError(
              `The handshake frame was invalid: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new IpcConnectionLostError(`Connection error during handshake: ${error.message}`));
      };
      const onFailure = (): void => {
        cleanup();
        reject(
          new IpcConnectionLostError("The connection closed before the handshake completed")
        );
      };
      connection.codec.on("data", onData);
      connection.codec.on("error", onError);
      connection.stream.once("end", onFailure);
      connection.stream.once("close", onFailure);
    });
  }

  private withConnectTimeout(promise: Promise<Duplex>): Promise<Duplex> {
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new IpcConnectError(
            `Connecting to the Runner pipe timed out after ${this.connectTimeoutMs}ms`
          )
        );
      }, this.connectTimeoutMs);
      promise.then(
        (stream) => {
          clearTimeout(timer);
          resolve(stream);
        },
        (error) => {
          clearTimeout(timer);
          reject(
            error instanceof IpcClientError
              ? error
              : new IpcConnectError(
                  error instanceof Error ? error.message : String(error),
                  error
                )
          );
        }
      );
    });
  }

  // -------------------------------------------------------------------------
  // Response / event-frame handling
  // -------------------------------------------------------------------------

  /** Routes one decoded frame: server-initiated runEvents or a response. */
  private onFrame(connection: ActiveConnection, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.failConnection(
        connection,
        new IpcInvalidResponseError(
          `Invalid frame: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }
    if (isRecord(parsed) && parsed.kind === "runEvents") {
      this.onRunEventsEnvelope(connection, parsed);
      return;
    }
    this.onResponse(connection, parsed);
  }

  private onResponse(connection: ActiveConnection, parsed: unknown): void {
    let response: IpcResponseEnvelope;
    try {
      response = validateIpcResponseEnvelope(parsed);
    } catch (error) {
      // A malformed response means the peer is not speaking the contract; the
      // connection is no longer trustworthy and every outstanding request is
      // invalidated.
      this.failConnection(
        connection,
        new IpcInvalidResponseError(
          `Invalid response frame: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return;
    }
    const pending = connection.pending.get(response.requestId);
    if (pending === undefined) return;
    connection.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private failConnection(connection: ActiveConnection, error: IpcClientError): void {
    if (connection.closed) return;
    connection.closed = true;
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
    // Connection close / client close ends every subscription of this
    // connection (unsubscribe / connection-close cleanup).
    const subscriptions = [...connection.subscriptions];
    connection.subscriptions.clear();
    for (const subscription of subscriptions) {
      subscription.active = false;
      subscription.connection = null;
      subscription.subscriber.onRunEventsError?.({
        code: error instanceof IpcClientClosedError ? "RUN_EVENT_STREAM_CLOSED" : "RUN_EVENT_STREAM_LOST",
        runId: subscription.runId,
        message:
          error instanceof IpcClientClosedError
            ? "The IPC client was closed; the Run event stream is gone"
            : "The connection to the Runner was lost; re-read the snapshot and resubscribe"
      });
    }
    if (this.connection === connection) {
      this.connection = null;
    }
    connection.stream.destroy();
  }
}

export type { IpcClientContract };
