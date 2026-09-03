import type { Socket, Server as NetServer } from "node:net";
import { createServer as createNetServer } from "node:net";
import { Duplex } from "node:stream";

import type {
  IpcHandshakeEnvelope,
  IpcMessage,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
  IpcServer as IpcServerContract,
  RunEventCursor,
  RunEventSubscriber
} from "@swpanel/contracts";
import {
  IPC_PROTOCOL_VERSION,
  IpcValidationError,
  validateIpcRequestEnvelope
} from "@swpanel/contracts";
import type { RunEvent } from "@swpanel/domain";

import type { PipeDaclResult } from "./acl.js";
import { applyPipeDaclToServer } from "./acl.js";
import { FrameCodec, MAX_IPC_FRAME_BYTES } from "./frame-codec.js";
import type { IpcRequestHandler } from "./request-handler.js";
import { IdempotencyCache } from "./idempotency-cache.js";
import { newServerInstanceId, pipePathForServerInstance, supportsWindowsPipes } from "./pipe-name.js";

/**
 * Windows Named Pipe IPC server of the Agent Runner (WP4 / architecture.md
 * §12.1). The server implements the runner-side {@link IpcServerContract}
 * surface and additionally:
 *
 * - listens on `\\.\pipe\swpanel.runner.<lowercase-username>.<instanceId>`;
 * - applies a current-user-only DACL to the pipe on Windows and strictly
 *   verifies the result (see acl.ts);
 * - sends an {@link IpcHandshakeEnvelope} immediately on connect;
 * - validates every request envelope before dispatch (protocol version, request
 *   id, channel/operation allowlist, payload shape) with no generic command
 *   endpoint — `dispatch` is the single validated entry point shared by the
 *   wire path and in-process hosts;
 * - deduplicates repeated commands with the same stable idempotencyKey via a
 *   bounded LRU/TTL cache (independent of the per-attempt requestId);
 * - implements real per-Run event subscriptions (Phase 3, P3-4): the
 *   `run.subscribe` request registers a per-CONNECTION, per-Run subscription in
 *   a registry, resolves with the persisted backlog (events at or after
 *   `fromSequence`, read AFTER the registration so no committed event can be
 *   missed) and then pushes live committed batches as
 *   {@link IpcEventEnvelope} frames. Subscriptions are cleaned when their
 *   connection closes and when the server closes. The injected
 *   {@link IpcEventStream} is the Runner's after-commit event stream — events
 *   are only ever observed after their write transaction committed;
 * - closes gracefully: stops listening, terminates live sockets and resolves
 *   outstanding requests with structured shutdown errors.
 */

/** Structured error code for requests that arrived while the server is closing. */
export const SHUTDOWN_ERROR_CODE = "SERVER_SHUTDOWN" as const;

/** Frame-size cap echoed by the client so both ends agree (1 MiB). */
export const MAX_FRAME_BYTES = MAX_IPC_FRAME_BYTES;

/**
 * The Runner-owned event stream the server subscribes to (Phase 3, P3-4).
 * `subscribeRunEvents` registers a live subscriber that receives committed
 * batches ONLY after their write transaction committed; `listRunEventsFrom`
 * returns the persisted ordered backlog of one Run starting at a sequence.
 */
export interface IpcEventStream {
  subscribeRunEvents(runId: string, subscriber: RunEventSubscriber): () => void;
  listRunEventsFrom(runId: string, fromSequence: number): readonly RunEvent[];
}

export interface IpcServerOptions {
  /**
   * Caller-provided pipe path. Used by tests; when absent the server derives
   * the per-user pipe name from the current process.
   */
  pipePath?: string;
  /** Platform override for tests (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Idempotency cache tuning; see {@link IdempotencyCache}. */
  idempotency?: { capacity?: number; ttlMs?: number; now?: () => number };
  /**
   * Runner-owned after-commit Run event stream. When absent the server still
   * answers `run.subscribe` with an empty backlog (no events can be pushed),
   * preserving the sequence contract without fabricating events.
   */
  eventStream?: IpcEventStream;
}

export interface IpcServerStartResult {
  pipePath: string;
  serverInstanceId: string;
  acl: PipeDaclResult | null;
}

interface LiveConnection {
  socket: Socket;
  codec: FrameCodec;
  closed: boolean;
}

/** One registered per-connection, per-Run subscription. */
interface RunSubscriptionEntry {
  runId: string;
  /** First backlog sequence the subscriber asked for (echoed in the response). */
  fromSequence: number;
}

/**
 * Runner-side IPC server. Implemented on `node:net` with the shared wire format
 * defined by `@swpanel/contracts`.
 */
export class IpcServer implements IpcServerContract {
  readonly serverInstanceId: string;
  readonly pipePath: string;

  private readonly handler: IpcRequestHandler;
  private readonly idempotency: IdempotencyCache;
  private readonly platform: NodeJS.Platform;
  private readonly eventStream: IpcEventStream | undefined;
  private netServer: NetServer | null = null;
  private readonly connections = new Set<LiveConnection>();
  private aclResult: PipeDaclResult | null = null;
  private closed = false;
  /**
   * Per-Run subscription registry: runId -> (connection -> subscription). One
   * shared event-stream subscription per Run fans the committed batches out to
   * every live connection subscribed to that Run. Entries are removed when
   * their connection closes, when the client unsubscribes, and on server close.
   */
  private readonly subscriptionsByRun = new Map<string, Map<LiveConnection, RunSubscriptionEntry>>();
  private readonly streamUnsubscribers = new Map<string, () => void>();

  constructor(handler: IpcRequestHandler, options: IpcServerOptions = {}) {
    this.handler = handler;
    this.platform = options.platform ?? process.platform;
    this.serverInstanceId = newServerInstanceId();
    this.pipePath = options.pipePath ?? pipePathForServerInstance(this.serverInstanceId);
    this.idempotency = new IdempotencyCache(options.idempotency);
    this.eventStream = options.eventStream;
  }

  /** Starts listening and (on Windows) applies the current-user-only DACL. */
  async start(): Promise<IpcServerStartResult> {
    if (this.netServer !== null) {
      throw new Error("IpcServer is already listening");
    }
    if (this.closed) {
      throw new Error("IpcServer has been closed and cannot be restarted");
    }
    if (!supportsWindowsPipes(this.platform)) {
      throw new Error(
        `Windows Named Pipes are only available on win32 (platform=${this.platform}). ` +
          "The Runner IPC server cannot start here; no ACL claim is made."
      );
    }
    this.netServer = createNetServer((socket) => this.attach(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.netServer as NetServer;
      server.once("error", reject);
      server.listen(this.pipePath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    // Apply the DACL after the pipe exists; the helper opens the pipe with
    // READ_CONTROL | WRITE_DAC to install the per-user ACL in place.
    if (this.platform === "win32") {
      this.aclResult = await applyPipeDaclToServer(this.pipePath, { platform: this.platform });
    } else {
      this.aclResult = null;
    }
    return {
      pipePath: this.pipePath,
      serverInstanceId: this.serverInstanceId,
      acl: this.aclResult
    };
  }

  /** The DACL result from the last successful start, or null. */
  get acl(): PipeDaclResult | null {
    return this.aclResult;
  }

  /** True while the server is listening. */
  get isListening(): boolean {
    return this.netServer !== null;
  }

  /** The handshake envelope sent immediately on connect. */
  handshake(): IpcHandshakeEnvelope {
    return { protocolVersion: IPC_PROTOCOL_VERSION, serverInstanceId: this.serverInstanceId };
  }

  /**
   * The single validated request entry point shared by the wire path and
   * in-process hosts. Validates the envelope (protocol version, request id,
   * channel/operation allowlist, payload shape), answers repeated commands with
   * the same idempotencyKey from cache and otherwise dispatches to
   * the {@link IpcRequestHandler}. Never executes an operation the contract
   * does not allow — there is no generic command endpoint.
   */
  async dispatch(request: IpcRequestEnvelope): Promise<IpcResponseEnvelope> {
    if (this.closed) {
      return this.shutdownEnvelope(request.requestId);
    }
    let validated: IpcRequestEnvelope;
    try {
      validated = validateIpcRequestEnvelope(request);
    } catch (error) {
      const code = error instanceof IpcValidationError ? error.code : "INVALID_ENVELOPE";
      const message = error instanceof Error ? error.message : String(error);
      return {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: { code, message }
      };
    }

    // Idempotent replay: repeated commands carrying the SAME idempotencyKey
    // return the cached response without re-executing the mutation. The stored
    // envelope is re-echoed with the CURRENT request id so the response always
    // matches the pending request the caller is waiting for.
    if (validated.idempotencyKey !== undefined) {
      const cached = this.idempotency.get(validated.idempotencyKey);
      if (cached !== undefined) {
        return { ...cached, requestId: validated.requestId };
      }
    }

    const response = await this.handler.handle(validated);
    // ONLY successful responses are cached (P3-4 review fix): a FAILED command
    // mutated nothing, so a later retry with the same idempotencyKey must be
    // able to execute instead of being poisoned by the stale failure.
    if (
      validated.idempotencyKey !== undefined &&
      validated.channel === "command" &&
      response.ok
    ) {
      this.idempotency.set(validated.idempotencyKey, response);
    }
    if (this.closed) {
      return this.shutdownEnvelope(validated.requestId);
    }
    return response;
  }

  /**
   * Attaches a connected peer to the server: a live `net.Socket` (Windows
   * named pipe) or an in-process duplex pair (unit tests / in-process host).
   * The server treats both exactly the same: handshake first, then validated
   * request/response exchange. Every subscription registered by this
   * connection is removed when the connection closes.
   */
  attach(stream: Duplex): void {
    if (this.closed) {
      stream.destroy();
      return;
    }
    const socket = stream as Socket;
    const connection: LiveConnection = {
      socket,
      codec: new FrameCodec(),
      closed: false
    };
    this.connections.add(connection);
    const send = (message: IpcMessage): void => {
      if (connection.closed || socket.destroyed) return;
      socket.write(FrameCodec.encode(message));
    };
    // The ACL helper (and any stray probe) opens the pipe as a client; those
    // handles connect, write nothing and close immediately. Treat them as
    // no-ops: send the handshake and let the socket end.
    socket.pipe(connection.codec);
    send(this.handshake());
    connection.codec.on("data", (line: string) => {
      void this.onFrame(connection, send, line);
    });
    connection.codec.on("error", (error) => {
      // A codec-level failure (oversized/garbage frame) can no longer be
      // attributed to a valid request id. Emitting an envelope with an empty
      // requestId here would be an INVALID response shape the client's
      // validation rejects (protocol asymmetry); instead the connection is
      // terminated and the client surfaces a structured connection-lost error.
      connection.closed = true;
      socket.destroy();
      void error;
    });
    const onClose = (): void => {
      connection.closed = true;
      this.connections.delete(connection);
      // Clean every subscription this connection registered (disconnect
      // cleanup): the shared per-Run event-stream subscription is released
      // when the last subscriber of a Run goes away.
      this.removeConnectionSubscriptions(connection);
    };
    // `close` (real sockets) AND `end` (peer half-close / in-process duplex
    // peers signal EOF instead of a full close) both end the connection.
    socket.once("close", onClose);
    socket.once("end", onClose);
    socket.once("error", onClose);
  }

  /**
   * Real per-Run event subscription (Phase 3, P3-4): the subscriber first
   * receives the persisted backlog (from sequence 0, i.e. the whole history)
   * and then every committed batch. The live subscription is registered BEFORE
   * the backlog is read, so a commit landing in between is pushed live and the
   * receiver's dedupe absorbs it — no event can be missed. With no injected
   * event stream the subscriber receives one empty backlog batch (nothing can
   * ever be pushed), preserving the sequence contract without fabricating
   * events.
   */
  subscribeRunEvents(runId: string, subscriber: RunEventSubscriber): () => void {
    const stream = this.eventStream;
    if (stream === undefined) {
      subscriber.onRunEvents({ runId, fromSequence: 0, events: [] });
      return () => {};
    }
    const unsubscribe = stream.subscribeRunEvents(runId, {
      onRunEvents: (batch) => subscriber.onRunEvents(batch),
      onRunEventsError: (error) => subscriber.onRunEventsError?.(error)
    });
    let backlog: readonly RunEvent[];
    try {
      backlog = stream.listRunEventsFrom(runId, 0);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    subscriber.onRunEvents({ runId, fromSequence: 0, events: backlog });
    return unsubscribe;
  }

  /**
   * Stops listening, terminates live sockets and drains outstanding requests.
   * Live sockets are destroyed BEFORE awaiting `netServer.close` so the close
   * callback can never hang on a peer that stays connected. Every registered
   * subscription is released (the shared event-stream subscriptions are
   * unsubscribed and the registry is cleared).
   */
  async close(): Promise<void> {
    this.closed = true;
    const server = this.netServer;
    this.netServer = null;
    for (const connection of this.connections) {
      connection.closed = true;
      connection.socket.destroy();
    }
    this.connections.clear();
    this.removeAllSubscriptions();
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private async onFrame(
    connection: LiveConnection,
    send: (message: IpcMessage) => void,
    line: string
  ): Promise<void> {
    if (this.closed) {
      this.sendShutdownResponse(send, "");
      return;
    }
    let request: IpcRequestEnvelope;
    try {
      request = validateIpcRequestEnvelope(JSON.parse(line));
    } catch (error) {
      // JSON.parse failures are SyntaxErrors; envelope-shape failures are
      // IpcValidationError. Both map to a stable machine-readable code.
      const code = error instanceof IpcValidationError ? error.code : "INVALID_ENVELOPE";
      const message = error instanceof Error ? error.message : String(error);
      // A valid protocol-level error response requires the peer's request id.
      // When the frame does not carry a recoverable non-empty request id there
      // is NO valid response shape to send — disconnect instead of emitting an
      // invalid empty-requestId envelope the client would reject. When the
      // request id IS recoverable the connection stays open (the peer may be
      // mid-sequence) and the structured error resolves the matching request.
      const recoverableRequestId = recoverRequestId(line);
      if (recoverableRequestId === null) {
        connectionSafeDestroy(connection.socket);
        return;
      }
      send({
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: recoverableRequestId,
        ok: false,
        error: { code, message }
      });
      return;
    }
    if (request.channel === "subscribe") {
      this.handleSubscribeRequest(connection, request, send);
      return;
    }
    const response = await this.dispatch(request);
    if (this.closed) {
      this.sendShutdownResponse(send, request.requestId);
      return;
    }
    send(response);
  }

  /**
   * Handles one validated `run.subscribe` request of a live connection. The
   * per-connection, per-Run subscription is registered FIRST (so a commit can
   * never fall between the registration and the backlog read), then the
   * persisted backlog (events at or after `fromSequence`) is resolved as the
   * response cursor; commits after that point are pushed live as
   * {@link IpcEventEnvelope} frames. An unknown Run maps to a structured
   * NOT_FOUND response and the just-registered subscription is removed.
   */
  private handleSubscribeRequest(
    connection: LiveConnection,
    request: IpcRequestEnvelope,
    send: (message: IpcMessage) => void
  ): void {
    const payload = request.payload as { runId: string; fromSequence: number };
    try {
      this.registerSubscription(connection, payload.runId, payload.fromSequence);
      const backlog = this.eventStream?.listRunEventsFrom(payload.runId, payload.fromSequence) ?? [];
      send({
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        data: { runId: payload.runId, fromSequence: payload.fromSequence, events: backlog }
      });
    } catch (error) {
      // A failed backlog read (e.g. unknown Run) must not leave the shared
      // event-stream subscription behind.
      this.removeConnectionRunSubscriptions(connection, payload.runId);
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL_ERROR";
      const message = error instanceof Error ? error.message : String(error);
      send({
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: { code, message }
      });
    }
  }

  // -------------------------------------------------------------------------
  // Subscription registry
  // -------------------------------------------------------------------------

  /**
   * Registers one connection's Run subscription. One shared event-stream
   * subscription per Run is created on first use; its callback fans every
   * committed batch out to each live connection subscribed to that Run,
   * filtered to the events the subscriber has not yet seen.
   */
  private registerSubscription(
    connection: LiveConnection,
    runId: string,
    fromSequence: number
  ): void {
    let connections = this.subscriptionsByRun.get(runId);
    if (connections === undefined) {
      connections = new Map();
      this.subscriptionsByRun.set(runId, connections);
      const stream = this.eventStream;
      const unsubscribe =
        stream === undefined
          ? () => {}
          : stream.subscribeRunEvents(runId, this.streamSubscriberFor(runId));
      this.streamUnsubscribers.set(runId, unsubscribe);
    }
    connections.set(connection, { runId, fromSequence });
  }

  /**
   * Builds the shared per-Run live subscriber that fans out committed batches.
   * Defense in depth: only events whose runId matches the subscribed Run are
   * pushed (B2) — a commit batch can never leak into another Run's stream or
   * produce an envelope whose events disagree with its runId (which the client
   * would treat as a protocol violation).
   */
  private streamSubscriberFor(runId: string): RunEventSubscriber {
    return {
      onRunEvents: (batch: RunEventCursor) => {
        if (this.closed) return;
        const owned = batch.events.filter((event) => event.runId === runId);
        const first = owned[0];
        if (first === undefined) return;
        const envelope: IpcMessage = {
          protocolVersion: IPC_PROTOCOL_VERSION,
          kind: "runEvents",
          runId,
          fromSequence: first.sequence,
          events: owned
        };
        const connections = this.subscriptionsByRun.get(runId);
        if (connections === undefined) return;
        for (const connection of connections.keys()) {
          if (connection.closed) continue;
          connection.socket.write(FrameCodec.encode(envelope));
        }
      }
    };
  }

  /** Removes every subscription of one connection (disconnect cleanup). */
  private removeConnectionSubscriptions(connection: LiveConnection): void {
    for (const runId of [...this.subscriptionsByRun.keys()]) {
      this.removeConnectionRunSubscriptions(connection, runId);
    }
  }

  /** Removes one connection's subscription of one Run, releasing the shared stream on the last subscriber. */
  private removeConnectionRunSubscriptions(connection: LiveConnection, runId: string): void {
    const connections = this.subscriptionsByRun.get(runId);
    if (connections === undefined) return;
    connections.delete(connection);
    if (connections.size === 0) {
      this.removeAllRunSubscriptions(runId);
    }
  }

  /** Releases the shared event-stream subscription of one Run and clears its registry. */
  private removeAllRunSubscriptions(runId: string): void {
    this.subscriptionsByRun.delete(runId);
    const unsubscribe = this.streamUnsubscribers.get(runId);
    if (unsubscribe !== undefined) {
      this.streamUnsubscribers.delete(runId);
      unsubscribe();
    }
  }

  /** Releases every registered subscription (server close). */
  private removeAllSubscriptions(): void {
    this.subscriptionsByRun.clear();
    for (const unsubscribe of this.streamUnsubscribers.values()) {
      unsubscribe();
    }
    this.streamUnsubscribers.clear();
  }

  private sendShutdownResponse(send: (message: IpcMessage) => void, requestId: string): void {
    send(this.shutdownEnvelope(requestId));
  }

  private shutdownEnvelope(requestId: string): IpcResponseEnvelope {
    return {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: SHUTDOWN_ERROR_CODE,
        message: "The Runner IPC server is shutting down"
      }
    };
  }
}

/**
 * Extracts a usable request id from a frame that failed envelope validation.
 * Only a non-empty string request id makes a protocol-valid error response
 * possible; anything else returns null and the peer must be disconnected.
 */
function recoverRequestId(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const requestId = (parsed as Record<string, unknown>).requestId;
    if (typeof requestId === "string" && requestId !== "") return requestId;
  }
  return null;
}

/** Destroys a socket without emitting a protocol-invalid response frame. */
function connectionSafeDestroy(socket: Socket): void {
  if (!socket.destroyed) socket.destroy();
}

export type { PipeDaclResult };
