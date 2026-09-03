/**
 * Codex App Server client over a strict NDJSON JSON-RPC transport (Phase 5,
 * P5-3). The client speaks ONLY the used subset of the 0.147.0 app-server
 * protocol, pinned to codex-cli 0.147.0 / protocol v2 (no invented wire
 * version — the 0.147.0 envelopes carry no `jsonrpc` version field):
 *
 * - handshake: `initialize` request with `clientInfo` + `capabilities`
 *   (`experimentalApi: false`), the response MUST carry
 *   `codexHome` / `platformFamily` / `platformOs` / `userAgent` (the actual
 *   0.147.0 `InitializeResponse` contract), then the `initialized`
 *   notification is sent;
 * - requests: `thread/start`, `thread/resume`, `turn/start`,
 *   `turn/interrupt`, `skills/list` with id correlation, per-request
 *   timeouts, JSON-RPC error responses and child-process exit propagation;
 * - notifications: dispatched to registered listeners in arrival order; ONLY
 *   `turn/completed` notifications are retained (bounded, fail-closed on
 *   overflow) — every other notification (deltas, stages, ...) is delivered to
 *   listeners and never accumulates, so a long-lived connection streaming
 *   thousands of them stays healthy; `waitForTurnCompleted` consumes the
 *   retained + live stream until the matching `turn/completed` arrives (or
 *   times out);
 * - inbound server→client REQUESTS (e.g. approval requests) are reported to
 *   content-free `onServerRequest` observers (fixed protocol method name only,
 *   never params) and then fail the whole connection closed — they are
 *   outside the used subset.
 *
 * The transport IS the process boundary: it is fully injectable, so tests
 * script an in-memory transport and NEVER spawn a real Codex App Server. The
 * child-process stdio transport (`codex-child-transport.ts`) ships in Batch C
 * and is hermetic-tested with scripted Node children, never HIL-verified; the
 * product wiring (transport factory → client → adapter) remains a later
 * batch. Everything here is contract-tested, NOT HIL-verified.
 */
import {
  decodeJsonRpcLine,
  encodeJsonRpcLine,
  JSON_RPC_DEFAULT_MAX_LINE_BYTES,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type JsonRpcRequestId,
  type JsonRpcResponse
} from "./jsonrpc-codec.js";
import { CODEX_CLIENT_INFO } from "./builders.js";

/** One NDJSON line written by the client (no delimiter — the transport delimits). */
export interface CodexTransport {
  writeLine(line: string): void;
  /** Registers the line sink; exactly one handler per transport lifetime. */
  setLineHandler(handler: (line: string) => void): void;
  /** Registers the child-exit sink (transports without a child omit it). */
  setExitHandler?(handler: (exit: { code: number | null; signal: string | null }) => void): void;
  close(): void;
}

/**
 * The live-spawn seam: a factory producing the transport of a spawned Codex
 * App Server process. Batch C ships the child-process implementation
 * (`codex-child-transport.ts`, {@link codexChildTransportFactory}); the
 * product wiring of the factory into a client/adapter remains a later batch.
 */
export type CodexTransportFactory = () => CodexTransport;

/** Structured client failure (never raw peer content in the message). */
export type CodexClientErrorCode =
  | "NOT_INITIALIZED"
  | "TIMEOUT"
  | "CHILD_EXIT"
  | "PROTOCOL"
  | "RPC_ERROR"
  | "TRANSPORT"
  | "CLOSED";

export class CodexClientError extends Error {
  readonly code: CodexClientErrorCode;
  /** Structured context (affected ids / paths), never user input. */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: CodexClientErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "CodexClientError";
    this.code = code;
    this.details = details;
  }
}

/** The validated 0.147.0 `initialize` response of the used subset. */
export interface CodexInitializeResult {
  /** Absolute path to the server's $CODEX_HOME directory. */
  codexHome: string;
  /** e.g. "unix" | "windows". */
  platformFamily: string;
  /** e.g. "macos" | "linux" | "windows". */
  platformOs: string;
  userAgent: string;
}

/** The validated `turn/completed` params of the used subset. */
export interface CodexTurnCompleted {
  threadId: string;
  turn: {
    id: string;
    status: string;
    /** Present when the turn failed (never surfaced verbatim). */
    errorMessage?: string;
  };
}

export interface CodexThreadStartedResult {
  thread: { id: string; [key: string]: unknown };
}

export interface CodexTurnStartedResult {
  turn: { id: string; [key: string]: unknown };
}

/** One `SkillErrorInfo` of a 0.147.0 `skills/list` entry. */
export interface CodexSkillErrorInfo {
  message: string;
  path: string;
}

/** The validated 0.147.0 `SkillMetadata` of the used subset. */
export interface CodexSkillMetadata {
  name: string;
  description: string;
  enabled: boolean;
  /** Absolute path of the skill (the `AbsolutePathBuf` of the schema). */
  path: string;
  scope: CodexSkillScope;
  /** Optional legacy `short_description` (prefer `interface` when present). */
  shortDescription?: string;
}

/** One `SkillsListEntry` of the 0.147.0 `skills/list` response. */
export interface CodexSkillsListEntry {
  cwd: string;
  errors: readonly CodexSkillErrorInfo[];
  skills: readonly CodexSkillMetadata[];
}

/** The validated 0.147.0 `skills/list` response of the used subset. */
export interface CodexSkillsListResult {
  data: readonly CodexSkillsListEntry[];
}

export interface CodexAppServerClientOptions {
  transport: CodexTransport;
  /** Per-request timeout in milliseconds (default 30s). */
  requestTimeoutMs?: number;
  /** Default turn-wait timeout in milliseconds (default 15 minutes). */
  turnWaitTimeoutMs?: number;
  /** Maximum NDJSON line size in bytes (default 8 MiB). */
  maxLineBytes?: number;
  /** Maximum retained turn/completed notifications before the connection fails closed (default 1024). */
  bufferMax?: number;
  /** Client identity of the handshake (defaults to the SWPanel identity). */
  clientInfo?: { name: string; version: string };
}

export const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 30_000 as const;
export const DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS = 7_200_000 as const;
/** Default cap of retained turn/completed notifications; overflow fails the connection closed. */
export const DEFAULT_CODEX_NOTIFICATION_BUFFER_MAX = 1_024 as const;
/** Cap of remembered expired request ids (late responses are ignored). */
export const MAX_EXPIRED_REQUEST_IDS = 256 as const;

const INITIALIZE_METHOD = "initialize" as const;
const INITIALIZED_NOTIFICATION = "initialized" as const;
const THREAD_START_METHOD = "thread/start" as const;
const THREAD_RESUME_METHOD = "thread/resume" as const;
const TURN_START_METHOD = "turn/start" as const;
const TURN_INTERRUPT_METHOD = "turn/interrupt" as const;
const TURN_COMPLETED_METHOD = "turn/completed" as const;
const SKILLS_LIST_METHOD = "skills/list" as const;

/** The four 0.147.0 `TurnStatus` values. */
const TURN_STATUSES = ["completed", "interrupted", "failed", "inProgress"] as const;

/** The four 0.147.0 `SkillScope` values. */
const SKILL_SCOPES = ["user", "repo", "system", "admin"] as const;
export type CodexSkillScope = (typeof SKILL_SCOPES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: CodexClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TurnWaiter {
  threadId: string;
  turnId: string;
  resolve: (completed: CodexTurnCompleted) => void;
  reject: (error: CodexClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One retained turn/completed notification; `consumed` entries are pruned on the next push. */
interface BufferedNotification {
  message: JsonRpcNotification;
  consumed: boolean;
}

/**
 * Strict JSON-RPC client of the used 0.147.0 subset. All requests are
 * correlated by id; a malformed wire message, an unsupported server request,
 * a response to an UNKNOWN request or a codec violation fails the whole
 * connection closed (PROTOCOL) — the adapter maps that onto
 * AGENT_PROTOCOL_INCOMPATIBLE and never exposes raw content. Two exceptions
 * keep the connection healthy under benign races:
 *
 * - a LATE response to a request that already timed out is ignored (the
 *   expired ids are remembered in a bounded set — the connection is NOT
 *   failed by the response to a request the client already settled);
 * - the notification buffer retains ONLY unconsumed turn/completed
 *   notifications (the ones a later wait can need); consumed entries are
 *   pruned on every push, the retained set is bounded and an overflow fails
 *   the connection closed (fail-closed, never silent growth). All other
 *   notifications are dispatched to listeners and dropped immediately.
 */
export class CodexAppServerClient {
  private readonly transport: CodexTransport;
  private readonly requestTimeoutMs: number;
  private readonly turnWaitTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly bufferMax: number;
  private readonly clientInfo: { name: string; version: string };

  private state: "idle" | "initialized" | "closed" = "idle";
  private failed: CodexClientError | null = null;
  private cachedInitializeResult: CodexInitializeResult | null = null;
  private nextId = 0;
  private readonly pending = new Map<JsonRpcRequestId, PendingRequest>();
  private readonly expiredRequestIds = new Set<JsonRpcRequestId>();
  private readonly buffer: BufferedNotification[] = [];
  private readonly turnWaiters: TurnWaiter[] = [];
  private readonly listeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly serverRequestObservers = new Set<(method: string) => void>();
  private lastChildExit: { code: number | null; signal: string | null } | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.transport = options.transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
    this.turnWaitTimeoutMs = options.turnWaitTimeoutMs ?? DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? JSON_RPC_DEFAULT_MAX_LINE_BYTES;
    this.bufferMax = options.bufferMax ?? DEFAULT_CODEX_NOTIFICATION_BUFFER_MAX;
    this.clientInfo = options.clientInfo ?? CODEX_CLIENT_INFO;
    this.transport.setLineHandler((line) => this.onLine(line));
    this.transport.setExitHandler?.((exit) => this.onChildExit(exit));
  }

  /** True once the handshake completed. */
  get initialized(): boolean {
    return this.state === "initialized";
  }

  /** The validated handshake result (null before initialize). */
  get handshakeResult(): CodexInitializeResult | null {
    return this.cachedInitializeResult;
  }

  /** The last observed child exit of the transport, or null. */
  get childExit(): { code: number | null; signal: string | null } | null {
    return this.lastChildExit;
  }

  /**
   * Registers a notification listener; returns the unsubscribe function.
   * Listeners are invoked synchronously in arrival order, BEFORE the
   * notification enters the wait buffer, so a listener registered before
   * `turn/start` can never miss the deltas of its own turn.
   */
  onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /**
   * Registers a content-free observer of inbound server→client REQUESTS (e.g.
   * approval requests). The handler receives ONLY the fixed protocol method
   * name (never params / payload / raw content) and is invoked BEFORE the
   * connection is failed closed — every server→client request is outside the
   * used subset, so the client always rejects it as a protocol violation. The
   * adapter reduces the method onto a fixed safe category and never persists
   * it; an observer failure never breaks the connection. Returns the
   * unsubscribe function.
   */
  onServerRequest(handler: (method: string) => void): () => void {
    this.serverRequestObservers.add(handler);
    return () => {
      this.serverRequestObservers.delete(handler);
    };
  }

  /**
   * Performs the handshake (idempotent): sends `initialize` with `clientInfo`
   * + `capabilities.experimentalApi: false`, requires the four fields of the
   * 0.147.0 `InitializeResponse` (`codexHome`, `platformFamily`, `platformOs`,
   * `userAgent`), then sends the `initialized` notification. A transport
   * failure while sending the `initialized` notification rejects the
   * handshake immediately (TRANSPORT) and fails the connection closed — the
   * client NEVER resolves "initialized" on a notification it could not
   * deliver.
   */
  async initialize(timeoutMs = this.requestTimeoutMs): Promise<CodexInitializeResult> {
    this.assertUsable();
    if (this.state === "initialized") {
      const cached = this.cachedInitializeResult;
      if (cached !== null) return cached;
    }
    const result = await this.request<unknown>(
      INITIALIZE_METHOD,
      {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: false }
      },
      timeoutMs
    );
    const validated = validateInitializeResult(result);
    this.notify(INITIALIZED_NOTIFICATION);
    this.state = "initialized";
    this.cachedInitializeResult = validated;
    return validated;
  }

  /**
   * Sends a client notification (e.g. the `initialized` handshake step). A
   * transport write failure fails the connection closed and THROWS
   * TRANSPORT — a notification is never silently dropped.
   */
  notify(method: string, params?: unknown): void {
    this.assertUsable();
    const line = encodeJsonRpcLine(
      params === undefined ? { method } : { method, params },
      this.maxLineBytes
    );
    this.writeLineOrFail(line);
  }

  /**
   * Sends a request and awaits its correlated response. Rejects with a
   * {@link CodexClientError}: NOT_INITIALIZED before the handshake, TIMEOUT
   * when no response arrived within the bound, RPC_ERROR on a JSON-RPC error
   * response, PROTOCOL on a wire violation, CHILD_EXIT when the runtime
   * process exited, TRANSPORT on a write failure, CLOSED after close().
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    this.assertUsable();
    if (method !== INITIALIZE_METHOD && this.state !== "initialized") {
      throw new CodexClientError(
        "NOT_INITIALIZED",
        `request ${method} requires the completed initialize handshake`
      );
    }
    const id = ++this.nextId;
    const line = encodeJsonRpcLine(
      params === undefined ? { id, method } : { id, method, params },
      this.maxLineBytes
    );
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Remember the id so a LATE response is ignored instead of failing
        // the whole connection (bounded set, FIFO eviction).
        this.rememberExpiredId(id);
        reject(new CodexClientError("TIMEOUT", `request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer
      });
      try {
        this.transport.writeLine(line);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.rememberExpiredId(id);
        reject(
          new CodexClientError("TRANSPORT", `transport failed to write request ${method}`, {
            cause: error instanceof Error ? error.message : String(error)
          })
        );
      }
    });
  }

  /** `thread/start` — the result must carry a thread id (0.147.0 response contract). */
  async threadStart(
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<CodexThreadStartedResult> {
    const result = await this.request<unknown>(THREAD_START_METHOD, params, timeoutMs);
    const thread = threadRefOf(result, THREAD_START_METHOD);
    return { thread };
  }

  /** `thread/resume` — the result must carry a thread id (0.147.0 response contract). */
  async threadResume(
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<CodexThreadStartedResult> {
    const result = await this.request<unknown>(THREAD_RESUME_METHOD, params, timeoutMs);
    const thread = threadRefOf(result, THREAD_RESUME_METHOD);
    return { thread };
  }

  /** `turn/start` — the result must carry a turn id (0.147.0 response contract). */
  async turnStart(
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<CodexTurnStartedResult> {
    const result = await this.request<unknown>(TURN_START_METHOD, params, timeoutMs);
    if (!isRecord(result) || !isRecord(result.turn) || !isNonEmptyString(result.turn.id)) {
      throw new CodexClientError(
        "PROTOCOL",
        `${TURN_START_METHOD} response must carry a turn object with an id`
      );
    }
    return { turn: { ...result.turn, id: result.turn.id } };
  }

  /** `turn/interrupt` — the 0.147.0 response is an object (never null). */
  async turnInterrupt(
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<void> {
    const result = await this.request<unknown>(TURN_INTERRUPT_METHOD, params, timeoutMs);
    if (!isRecord(result)) {
      throw new CodexClientError(
        "PROTOCOL",
        `${TURN_INTERRUPT_METHOD} response must be an object`
      );
    }
  }

  /**
   * `skills/list` — the strict 0.147.0 `SkillsListResponse` contract: the
   * result MUST carry a `data` array; every entry MUST carry a non-empty
   * `cwd`, an `errors` array of `{ message, path }` objects and a `skills`
   * array; every skill MUST carry the required `SkillMetadata` fields with a
   * canonical `scope` (`user | repo | system | admin`). A malformed response
   * rejects the request with PROTOCOL AND fails the whole connection closed
   * (a listing whose shape cannot be trusted could hide a real skill — the
   * preflight gate must never evaluate a partial or invented listing).
   */
  async skillsList(
    params?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<CodexSkillsListResult> {
    const result = await this.request<unknown>(
      SKILLS_LIST_METHOD,
      params === undefined ? {} : params,
      timeoutMs
    );
    try {
      return validateSkillsListResult(result);
    } catch (error) {
      if (error instanceof CodexClientError && error.code === "PROTOCOL") {
        // The malformed listing is a protocol violation of the used subset:
        // the connection must never stay healthy on an untrustworthy listing.
        this.failConnection(error);
      }
      throw error;
    }
  }

  /**
   * Waits for the `turn/completed` notification of the given turn (consuming
   * the buffered + live notification stream). Rejects with TIMEOUT when the
   * turn did not complete within the bound, CHILD_EXIT when the runtime
   * process exited, PROTOCOL on a malformed completion or on a foreign
   * same-thread completion while waiting.
   */
  async waitForTurnCompleted(input: {
    threadId: string;
    turnId: string;
    timeoutMs?: number;
  }): Promise<CodexTurnCompleted> {
    this.assertUsable();
    const timeoutMs = input.timeoutMs ?? this.turnWaitTimeoutMs;
    // Consume the already-buffered stream first (a turn may complete
    // synchronously after turn/start, before the wait is registered).
    const buffered = this.takeBufferedTurnCompleted(input.threadId, input.turnId);
    if (buffered !== null) return buffered;
    return new Promise<CodexTurnCompleted>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.turnWaiters.findIndex(
          (waiter) => waiter.turnId === input.turnId && waiter.threadId === input.threadId
        );
        if (index !== -1) this.turnWaiters.splice(index, 1);
        reject(
          new CodexClientError(
            "TIMEOUT",
            `turn ${input.turnId} did not complete within ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.turnWaiters.push({
        threadId: input.threadId,
        turnId: input.turnId,
        resolve,
        reject,
        timer
      });
    });
  }

  /**
   * Closes the client + transport: pending requests and turn waits reject with
   * CLOSED; further calls throw CLOSED.
   */
  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    const error = new CodexClientError("CLOSED", "the Codex App Server client is closed");
    this.rejectAll(error);
    this.transport.close();
  }

  /**
   * Permanently POISONS the client (fail-closed, non-reusable): the transport
   * is closed and every further call throws the given CLOSED error. Used when
   * a turn's wait timed out and the interrupt outcome could NOT be confirmed —
   * the server-side turn state is unknown, so the connection state is
   * ambiguous and a LATE `turn/completed` of the old turn could otherwise
   * corrupt a later turn on the same thread. The reason is an adapter-owned
   * fixed category label (never raw peer content). Idempotent: a closed or
   * already-failed client stays as it is.
   */
  poison(reason: string): void {
    if (this.state === "closed" || this.failed !== null) return;
    this.failConnection(
      new CodexClientError(
        "CLOSED",
        `the Codex App Server client is not reusable: ${reason}`
      )
    );
  }

  // -------------------------------------------------------------------------
  // Transport wiring
  // -------------------------------------------------------------------------

  private onLine(line: string): void {
    if (this.state === "closed" || this.failed !== null) return;
    let decoded;
    try {
      decoded = decodeJsonRpcLine(line, this.maxLineBytes);
    } catch (error) {
      this.failConnection(
        new CodexClientError(
          "PROTOCOL",
          `malformed JSON-RPC line from the server: ${errorMessage(error)}`
        )
      );
      return;
    }
    switch (decoded.kind) {
      case "response":
        this.onResponse(decoded.message as JsonRpcResponse);
        return;
      case "error_response":
        this.onErrorResponse(decoded.message as JsonRpcErrorResponse);
        return;
      case "request":
        // Server→client requests are outside the used subset. The content-free
        // observers are told the FIXED protocol method name first (never the
        // params), then the connection is failed closed.
        this.dispatchServerRequest((decoded.message as { method: string }).method);
        this.failConnection(
          new CodexClientError(
            "PROTOCOL",
            `unsupported server request ${(decoded.message as { method: string }).method} (outside the used subset)`
          )
        );
        return;
      case "notification":
        this.onNotificationMessage(decoded.message as JsonRpcNotification);
        return;
    }
  }

  private onResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      if (this.expiredRequestIds.has(message.id)) {
        // A LATE response to a request that already timed out: the request was
        // settled; the response is dropped and the connection stays healthy.
        this.expiredRequestIds.delete(message.id);
        return;
      }
      this.failConnection(
        new CodexClientError(
          "PROTOCOL",
          `response for unknown request id ${JSON.stringify(message.id)}`
        )
      );
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message.result);
  }

  private onErrorResponse(message: JsonRpcErrorResponse): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      if (this.expiredRequestIds.has(message.id)) {
        // Late error response to an already-timed-out request: dropped.
        this.expiredRequestIds.delete(message.id);
        return;
      }
      this.failConnection(
        new CodexClientError(
          "PROTOCOL",
          `error response for unknown request id ${JSON.stringify(message.id)}`
        )
      );
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.reject(
      new CodexClientError("RPC_ERROR", `request failed with JSON-RPC error ${message.error.code}`, {
        rpcCode: message.error.code,
        rpcMessage: message.error.message
      })
    );
  }

  private onNotificationMessage(message: JsonRpcNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A listener failure never breaks the connection.
      }
    }
    // ONLY turn/completed notifications are retained: they are the only
    // notifications a LATER waitForTurnCompleted can need (a turn may complete
    // before its wait is registered). Every other notification — deltas,
    // stages, ... — was delivered to the listeners synchronously above and is
    // dropped here: a long-lived connection streaming thousands of them must
    // neither grow the buffer nor fail closed over connection lifetime.
    if (message.method !== TURN_COMPLETED_METHOD) return;
    // Prune consumed entries FIRST, then fail closed on overflow — the retained
    // set never grows without bound and a flooding peer cannot exhaust memory.
    this.pruneConsumedNotifications();
    if (this.buffer.length >= this.bufferMax) {
      this.failConnection(
        new CodexClientError(
          "PROTOCOL",
          `retained turn/completed notification buffer overflow (max ${this.bufferMax} pending notifications)`
        )
      );
      return;
    }
    this.buffer.push({ message, consumed: false });
    this.settleTurnWaiters(message);
  }

  /** Invokes the content-free server-request observers; a failure never breaks the connection. */
  private dispatchServerRequest(method: string): void {
    for (const observer of this.serverRequestObservers) {
      try {
        observer(method);
      } catch {
        // observer failure never affects connection handling
      }
    }
  }

  private settleTurnWaiters(message: JsonRpcNotification): void {
    const completed = validateTurnCompleted(message.params);
    if (completed === null) {
      this.failConnection(
        new CodexClientError(
          "PROTOCOL",
          `malformed ${TURN_COMPLETED_METHOD} notification params`
        )
      );
      return;
    }
    const matching = this.turnWaiters.filter(
      (waiter) => waiter.threadId === completed.threadId && waiter.turnId === completed.turn.id
    );
    const foreignSameThread = this.turnWaiters.some(
      (waiter) =>
        waiter.threadId === completed.threadId && waiter.turnId !== completed.turn.id
    );
    if (foreignSameThread && matching.length === 0) {
      // A turn we did not start completed on the same thread while we wait:
      // outside the used subset (one turn per thread at a time).
      this.failConnection(
        new CodexClientError(
          "PROTOCOL",
          `turn/completed for foreign turn ${JSON.stringify(completed.turn.id)} on the waiting thread`
        )
      );
      return;
    }
    for (const waiter of matching) {
      clearTimeout(waiter.timer);
      const index = this.turnWaiters.indexOf(waiter);
      if (index !== -1) this.turnWaiters.splice(index, 1);
      waiter.resolve(completed);
    }
    if (matching.length > 0) {
      // The just-arrived completion was consumed by the waiters: mark it for
      // pruning (it is the newest buffer entry).
      const last = this.buffer[this.buffer.length - 1];
      if (last !== undefined && last.message === message) last.consumed = true;
    }
  }

  private takeBufferedTurnCompleted(
    threadId: string,
    turnId: string
  ): CodexTurnCompleted | null {
    for (const entry of this.buffer) {
      if (entry.consumed || entry.message.method !== TURN_COMPLETED_METHOD) continue;
      const completed = validateTurnCompleted(entry.message.params);
      if (completed !== null && completed.threadId === threadId && completed.turn.id === turnId) {
        entry.consumed = true;
        return completed;
      }
    }
    return null;
  }

  /** Removes every consumed buffer entry (called before each push). */
  private pruneConsumedNotifications(): void {
    for (let index = this.buffer.length - 1; index >= 0; index--) {
      if (this.buffer[index]?.consumed === true) this.buffer.splice(index, 1);
    }
  }

  /**
   * Remembers an expired request id (bounded FIFO): its late response is then
   * ignored instead of failing the connection.
   */
  private rememberExpiredId(id: JsonRpcRequestId): void {
    this.expiredRequestIds.add(id);
    if (this.expiredRequestIds.size <= MAX_EXPIRED_REQUEST_IDS) return;
    for (const oldest of this.expiredRequestIds) {
      this.expiredRequestIds.delete(oldest);
      if (this.expiredRequestIds.size <= MAX_EXPIRED_REQUEST_IDS) break;
    }
  }

  private onChildExit(exit: { code: number | null; signal: string | null }): void {
    this.lastChildExit = exit;
    this.failConnection(
      new CodexClientError("CHILD_EXIT", "the Codex App Server process exited", {
        code: exit.code,
        signal: exit.signal
      })
    );
  }

  /** Fails the connection closed on a transport write failure AND rethrows. */
  private writeLineOrFail(line: string): void {
    try {
      this.transport.writeLine(line);
    } catch (error) {
      const failure = new CodexClientError(
        "TRANSPORT",
        `transport write failed: ${errorMessage(error)}`
      );
      this.failConnection(failure);
      throw failure;
    }
  }

  /** Fails the whole connection closed with the given structured error. */
  private failConnection(error: CodexClientError): void {
    if (this.failed !== null) return;
    this.failed = error;
    this.rejectAll(error);
    try {
      this.transport.close();
    } catch {
      // closing a broken transport is best-effort
    }
  }

  private rejectAll(error: CodexClientError): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.turnWaiters.length = 0;
  }

  private assertUsable(): void {
    if (this.failed !== null) {
      throw this.failed;
    }
    if (this.state === "closed") {
      throw new CodexClientError("CLOSED", "the Codex App Server client is closed");
    }
  }
}

/** The four required 0.147.0 `InitializeResponse` fields, strictly validated. */
function validateInitializeResult(result: unknown): CodexInitializeResult {
  if (
    !isRecord(result) ||
    !isNonEmptyString(result.codexHome) ||
    !isNonEmptyString(result.platformFamily) ||
    !isNonEmptyString(result.platformOs) ||
    !isNonEmptyString(result.userAgent)
  ) {
    throw new CodexClientError(
      "PROTOCOL",
      "initialize response must carry codexHome / platformFamily / platformOs / userAgent"
    );
  }
  return {
    codexHome: result.codexHome,
    platformFamily: result.platformFamily,
    platformOs: result.platformOs,
    userAgent: result.userAgent
  };
}

/** Validates a `turn/completed` params object; null = malformed shape. */
function validateTurnCompleted(params: unknown): CodexTurnCompleted | null {
  if (!isRecord(params) || !isNonEmptyString(params.threadId)) return null;
  if (!isRecord(params.turn) || !isNonEmptyString(params.turn.id)) return null;
  if (
    typeof params.turn.status !== "string" ||
    !(TURN_STATUSES as readonly string[]).includes(params.turn.status)
  ) {
    return null;
  }
  return {
    threadId: params.threadId,
    turn: {
      id: params.turn.id,
      status: params.turn.status,
      ...(params.turn.error !== undefined &&
      isRecord(params.turn.error) &&
      typeof params.turn.error.message === "string"
        ? { errorMessage: params.turn.error.message }
        : {})
    }
  };
}

/** The strict 0.147.0 `SkillsListResponse` validation of the used subset. */
function validateSkillsListResult(result: unknown): CodexSkillsListResult {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    throw new CodexClientError(
      "PROTOCOL",
      `${SKILLS_LIST_METHOD} response must carry a data array`
    );
  }
  const data: CodexSkillsListEntry[] = [];
  for (const entry of result.data) {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.cwd) ||
      !Array.isArray(entry.errors) ||
      !Array.isArray(entry.skills)
    ) {
      throw new CodexClientError(
        "PROTOCOL",
        `${SKILLS_LIST_METHOD} entry must carry a cwd, an errors array and a skills array`
      );
    }
    const errors: CodexSkillErrorInfo[] = [];
    for (const error of entry.errors) {
      if (
        !isRecord(error) ||
        typeof error.message !== "string" ||
        typeof error.path !== "string"
      ) {
        throw new CodexClientError(
          "PROTOCOL",
          `${SKILLS_LIST_METHOD} entry error must carry message and path strings`
        );
      }
      errors.push({ message: error.message, path: error.path });
    }
    const skills: CodexSkillMetadata[] = [];
    for (const skill of entry.skills) {
      if (
        !isRecord(skill) ||
        !isNonEmptyString(skill.name) ||
        typeof skill.description !== "string" ||
        typeof skill.enabled !== "boolean" ||
        typeof skill.path !== "string" ||
        typeof skill.scope !== "string" ||
        !(SKILL_SCOPES as readonly string[]).includes(skill.scope)
      ) {
        throw new CodexClientError(
          "PROTOCOL",
          `${SKILLS_LIST_METHOD} skill must carry name, description, enabled, path and a canonical scope`
        );
      }
      const metadata: CodexSkillMetadata = {
        name: skill.name,
        description: skill.description,
        enabled: skill.enabled,
        path: skill.path,
        // `scope` was validated as a canonical enum value above; the cast
        // narrows the checked string onto the literal union.
        scope: skill.scope as CodexSkillScope
      };
      if (typeof skill.shortDescription === "string") {
        metadata.shortDescription = skill.shortDescription;
      }
      skills.push(metadata);
    }
    data.push({ cwd: entry.cwd, errors, skills });
  }
  return { data };
}

function threadRefOf(
  result: unknown,
  method: string
): { id: string; [key: string]: unknown } {
  if (!isRecord(result) || !isRecord(result.thread) || !isNonEmptyString(result.thread.id)) {
    throw new CodexClientError(
      "PROTOCOL",
      `${method} response must carry a thread object with an id`
    );
  }
  return { ...result.thread, id: result.thread.id };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
