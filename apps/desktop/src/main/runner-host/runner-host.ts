/**
 * Main-owned Runner host (WP5).
 *
 * Owns the real Runner lifecycle inside the Electron Main process: the Runner
 * opens the SQLite WAL store + ledger under the resolved data root, a real
 * Windows Named Pipe server (with the current-user-only DACL) is started and
 * the Main-side IpcClient connects to it and verifies identity + a probe query.
 * Raw Runner objects / sockets never enter the Renderer.
 *
 * Start order: Runner -> pipe server -> IpcClient -> probe `storage.getSettings`
 * -> READY. On any failure the partial stack is closed, the state is `FAILED`
 * (a sanitized health state is exposed; there is NO silent fallback to the Mock
 * Repository) and `start()` rejects with a structured error for the caller to
 * log.
 *
 * Close order: IpcClient -> pipe server -> Runner (the Runner's awaitable
 * shutdown seam, so an eagerly spawned live Codex child process is closed and
 * never orphaned), guarded so concurrent `before-quit` / window shutdown paths
 * cannot race.
 */

import type {
  Command,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
  QueryName,
  RunEventSubscriber
} from "@swpanel/contracts";
import {
  IpcServer,
  Runner,
  RunnerRequestHandler,
  type PipeDaclResult
} from "@swpanel/runner";

import type { RunnerHealthState } from "../bridge/bridge-contract.js";
import { redactPaths } from "../bridge/bridge-contract.js";
import { IpcClientImpl, createNetPipeTransport, IpcClientError } from "../ipc-client/index.js";

export type RunnerHostState = "idle" | "starting" | "ready" | "closing" | "closed" | "failed";

export interface RunnerHostServerLike {
  readonly pipePath: string;
  readonly serverInstanceId: string;
  /**
   * DACL application result of the last successful `IpcServer.start()`, or
   * null when no DACL application was attempted. A Windows server that claims
   * a real named pipe MUST report `WINDOWS_ACL_APPLIED` here; anything else
   * (including a missing/null result) fails the RunnerHost startup closed.
   */
  readonly acl: PipeDaclResult | null;
  /**
   * Explicit declaration that this adapter bound a REAL Windows Named Pipe.
   * In-memory/test adapters that never bind a pipe declare `false` and are
   * exempt from the ACL verification; every other value (including an omitted
   * property) counts as claiming a real pipe so a silent adapter can never
   * weaken the security check.
   */
  readonly claimsWindowsPipe?: boolean;
  dispatch(request: IpcRequestEnvelope): Promise<IpcResponseEnvelope>;
  close(): Promise<void>;
}

export interface RunnerHostClientLike {
  readonly serverInstanceId: string | undefined;
  query(name: QueryName, payload: unknown): Promise<IpcResponseEnvelope>;
  command(command: Command, options?: { idempotencyKey?: string }): Promise<IpcResponseEnvelope>;
  subscribeRunEvents(
    runId: string,
    subscriber: RunEventSubscriber,
    options?: { fromSequence?: number }
  ): () => void;
  close(): void;
}

export interface RunnerHostDependencies {
  /**
   * Creates the Runner application facade. Defaults to a plain `new Runner`.
   * Tests inject a configured Runner (run profile, deterministic clock /
   * scheduler, Fake Executor scenario).
   */
  createRunner?: (dataRoot: string) => Runner;
  /**
   * Creates and starts the pipe server. Defaults to the real Windows Named Pipe
   * server with the Runner request handler and the current-user-only DACL. The
   * factory may return the started server synchronously (test rigs) or as a
   * promise (the default real pipe start).
   */
  createServer?: (runner: Runner) => RunnerHostServerLike | Promise<RunnerHostServerLike>;
  /** Creates the Main-side IPC client bound to the server identity. */
  createClient?: (options: {
    pipePath: string;
    expectedServerInstanceId: string;
  }) => RunnerHostClientLike;
  /** Per-request timeout used by the default client. */
  requestTimeoutMs?: number;
  /** Platform override for tests (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Structured logger; defaults to `console`. */
  logger?: Pick<Console, "error">;
}

export interface RunnerHostOptions {
  /** Canonical absolute data root (see `runtime-root.ts`). */
  dataRoot: string;
  dependencies?: RunnerHostDependencies;
}

/** Structured startup failure; `message` never contains paths or stacks. */
export class RunnerHostStartError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunnerHostStartError";
    this.code = code;
  }
}

/** Structured runtime failure when the host is not READY for a request. */
export class RunnerHostNotReadyError extends Error {
  readonly code = "HOST_NOT_READY" as const;

  constructor() {
    super("The Runner host is not ready");
    this.name = "RunnerHostNotReadyError";
  }
}

async function defaultCreateServer(runner: Runner): Promise<RunnerHostServerLike> {
  const server = new IpcServer(new RunnerRequestHandler(runner), {
    // The server's real per-Run event subscriptions read the persisted backlog
    // from the Runner and subscribe to the Runner's after-commit event stream
    // (Phase 3, P3-4): events are only ever observed after their write
    // transaction committed. Commit batches are filtered by the SUBSCRIBED
    // runId so one Run's commits can never leak into another Run's stream.
    eventStream: {
      subscribeRunEvents: (runId, subscriber) =>
        runner.subscribeRunEventCommits((events) => {
          const owned = events.filter((event) => event.runId === runId);
          const first = owned[0];
          if (first === undefined) return;
          subscriber.onRunEvents({ runId, fromSequence: first.sequence, events: owned });
        }),
      listRunEventsFrom: (runId, fromSequence) => runner.listRunEventsFrom(runId, fromSequence)
    }
  });
  const started = await server.start();
  return {
    pipePath: server.pipePath,
    serverInstanceId: started.serverInstanceId,
    acl: started.acl,
    claimsWindowsPipe: true,
    dispatch: (request) => server.dispatch(request),
    close: () => server.close()
  };
}

/** Stable failure code when the named-pipe ACL could not be proven applied. */
export const PIPE_ACL_FAILED_CODE = "PIPE_ACL_FAILED" as const;

/**
 * Strict, fail-closed ACL gate for a started pipe server. On win32, a server
 * that claims a real Windows Named Pipe must have applied the current-user-only
 * DACL (`WINDOWS_ACL_APPLIED`); a missing, null or failed ACL result refuses
 * startup. Non-Windows hosts and adapters that explicitly declare no real pipe
 * (`claimsWindowsPipe === false`, in-memory test rigs) are exempt.
 */
function assertWindowsPipeAclApplied(
  platform: NodeJS.Platform,
  server: RunnerHostServerLike
): void {
  if (platform !== "win32") return;
  if (server.claimsWindowsPipe === false) return;
  const acl = server.acl;
  if (acl === null || acl === undefined || acl.status !== "WINDOWS_ACL_APPLIED") {
    throw new RunnerHostStartError(
      PIPE_ACL_FAILED_CODE,
      "The Runner named-pipe ACL could not be verified as applied; startup was refused"
    );
  }
}

export class RunnerHost {
  private readonly dataRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly dependencies: {
    createRunner: (dataRoot: string) => Runner;
    createServer: (runner: Runner) => RunnerHostServerLike | Promise<RunnerHostServerLike>;
    createClient: (options: {
      pipePath: string;
      expectedServerInstanceId: string;
    }) => RunnerHostClientLike;
    requestTimeoutMs?: number;
  };
  private readonly logger: Pick<Console, "error">;

  private runner: Runner | null = null;
  private server: RunnerHostServerLike | null = null;
  private client: RunnerHostClientLike | null = null;
  private status: RunnerHostState = "idle";
  private failure: { code: string; message: string } | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: RunnerHostOptions) {
    this.dataRoot = options.dataRoot;
    const deps = options.dependencies ?? {};
    this.platform = deps.platform ?? process.platform;
    this.dependencies = {
      createRunner: deps.createRunner ?? ((dataRoot) => new Runner(dataRoot)),
      createServer: deps.createServer ?? defaultCreateServer,
      createClient:
        deps.createClient ??
        (({ pipePath, expectedServerInstanceId }) =>
          new IpcClientImpl({
            transport: createNetPipeTransport(pipePath),
            expectedServerInstanceId,
            ...(deps.requestTimeoutMs === undefined
              ? {}
              : { requestTimeoutMs: deps.requestTimeoutMs })
          })),
      ...(deps.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: deps.requestTimeoutMs })
    };
    this.logger = deps.logger ?? console;
  }

  get state(): RunnerHostState {
    return this.status;
  }

  /** Sanitized health state exposed over the bridge. */
  get health(): RunnerHealthState {
    switch (this.status) {
      case "ready":
        return {
          status: "READY",
          serverInstanceId: this.server?.serverInstanceId ?? null,
          error: null
        };
      case "starting":
        return { status: "STARTING", serverInstanceId: null, error: null };
      case "failed":
        return {
          status: "FAILED",
          serverInstanceId: null,
          error: this.failure ?? { code: "RUNNER_START_FAILED", message: "The Runner failed to start" }
        };
      default:
        return { status: "CLOSED", serverInstanceId: null, error: null };
    }
  }

  /**
   * Starts Runner + pipe server + client and probes the wire. Idempotent:
   * calling while READY/STARTING is a no-op. On failure the partial stack is
   * closed, state becomes `FAILED`, a structured error is logged and the error
   * is thrown (sanitized) for the caller.
   */
  async start(): Promise<void> {
    if (this.status === "ready" || this.status === "starting") return;
    this.status = "starting";
    this.failure = null;
    let runner: Runner | null = null;
    let server: RunnerHostServerLike | null = null;
    let client: RunnerHostClientLike | null = null;
    try {
      runner = this.dependencies.createRunner(this.dataRoot);
      runner.open();
      server = await this.dependencies.createServer(runner);
      // Fail closed on Windows: a real pipe MUST prove its per-user DACL was
      // applied. On failure the catch block below closes the partial stack and
      // the health state becomes FAILED with a sanitized code/message — there
      // is no READY product service without an ACL-verified pipe.
      assertWindowsPipeAclApplied(this.platform, server);
      client = this.dependencies.createClient({
        pipePath: server.pipePath,
        expectedServerInstanceId: server.serverInstanceId
      });
      const probe = await client.query("storage.getSettings", {});
      if (!probe.ok) {
        throw new RunnerHostStartError(
          "PROBE_FAILED",
          `The Runner probe failed (${probe.error?.code ?? "UNKNOWN"})`
        );
      }
      this.runner = runner;
      this.server = server;
      this.client = client;
      this.status = "ready";
    } catch (error) {
      // Best-effort partial teardown WITHOUT mutating state (must stay FAILED).
      try {
        client?.close();
      } catch {
        // best effort
      }
      try {
        await server?.close();
      } catch {
        // best effort
      }
      try {
        // The async shutdown seam settles the executor stop (a never-started
        // OWNED live Codex child process is closed, never orphaned) before the
        // partial stack teardown finishes.
        await runner?.shutdown();
      } catch {
        // best effort
      }
      this.status = "failed";
      this.failure = toStructuredFailure(error);
      this.logger.error(
        `SWPanel Runner startup failed (code=${this.failure.code}): ${this.failure.message}`,
        { code: this.failure.code, dataRoot: this.dataRoot }
      );
      throw new RunnerHostStartError(this.failure.code, this.failure.message);
    }
  }

  /**
   * Closes client -> server -> Runner exactly once. Idempotent and race-safe:
   * concurrent callers share a single close promise. A FAILED host was already
   * torn down during `start()`; calling close marks it CLOSED.
   */
  close(): Promise<void> {
    if (this.status === "idle" || this.status === "closed") return Promise.resolve();
    if (this.closePromise !== null) return this.closePromise;
    this.status = "closing";
    this.closePromise = (async () => {
      const client = this.client;
      this.client = null;
      const server = this.server;
      this.server = null;
      const runner = this.runner;
      this.runner = null;
      try {
        client?.close();
      } catch {
        // best effort
      }
      try {
        await server?.close();
      } catch {
        // best effort
      }
      try {
        // Runner async shutdown seam: the executor stop is AWAITED so no
        // orphaned Codex child process (e.g. an eagerly spawned, never-used
        // transport) survives the host close.
        await runner?.shutdown();
      } catch {
        // best effort
      }
      this.status = "closed";
    })().finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }

  /** Registers a validated source file with the Runner (by sha256). */
  registerSourceFile(sha256: string, absolutePath: string): void {
    this.requireReady();
    (this.runner as Runner).registerSourceFile(sha256, absolutePath);
  }

  async runQuery(name: QueryName, payload: unknown): Promise<IpcResponseEnvelope> {
    this.requireReady();
    return (this.client as RunnerHostClientLike).query(name, payload);
  }

  async runCommand(
    command: Command,
    options?: { idempotencyKey?: string }
  ): Promise<IpcResponseEnvelope> {
    this.requireReady();
    return (this.client as RunnerHostClientLike).command(command, options);
  }

  /**
   * Subscribes the Main-side client to the ordered event stream of one Run
   * (Phase 3, P3-4). The subscriber receives the persisted backlog, then live
   * batches; the client validates envelopes, ignores duplicates and fails the
   * subscription with a structured error on gaps/invalid frames instead of
   * silently applying. Returns an unsubscribe function.
   */
  subscribeRunEvents(
    runId: string,
    subscriber: RunEventSubscriber,
    options?: { fromSequence?: number }
  ): () => void {
    this.requireReady();
    return (this.client as RunnerHostClientLike).subscribeRunEvents(runId, subscriber, options);
  }

  private requireReady(): void {
    if (this.status !== "ready" || this.client === null) {
      throw new RunnerHostNotReadyError();
    }
  }
}

function toStructuredFailure(error: unknown): { code: string; message: string } {
  if (error instanceof RunnerHostStartError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof IpcClientError) {
    return { code: "RUNNER_UNAVAILABLE", message: "The Runner connection could not be established" };
  }
  if (error instanceof Error) {
    // Never leak paths or stacks in the exposed health state.
    return {
      code: "RUNNER_START_FAILED",
      message: redactPaths(error.message).split("\n")[0] ?? "The Runner failed to start"
    };
  }
  return { code: "RUNNER_START_FAILED", message: "The Runner failed to start" };
}
