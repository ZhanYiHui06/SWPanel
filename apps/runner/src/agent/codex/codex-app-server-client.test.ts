import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  type CodexTransport
} from "./codex-app-server-client.js";
import {
  decodeJsonRpcLine,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest
} from "./jsonrpc-codec.js";

/**
 * Scripted in-memory Codex App Server transport: the client NEVER spawns a
 * real process. The test feeds lines/messages explicitly and inspects every
 * line the client wrote, in order.
 */
class ScriptedTransport implements CodexTransport {
  readonly written: string[] = [];
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandler: ((exit: { code: number | null; signal: string | null }) => void) | null =
    null;
  closed = false;

  writeLine(line: string): void {
    this.written.push(line);
  }

  setLineHandler(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  setExitHandler(handler: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitHandler = handler;
  }

  close(): void {
    this.closed = true;
  }

  /** Feeds one full NDJSON line to the client (as the server would). */
  receive(line: string): void {
    this.lineHandler?.(line);
  }

  /** Feeds one JSON-RPC message to the client. */
  receiveMessage(message: JsonRpcMessage): void {
    this.receive(JSON.stringify(message));
  }

  /** Emits the child-exit signal. */
  exit(code: number | null, signal: string | null): void {
    this.exitHandler?.({ code, signal });
  }

  /** The decoded requests the client sent, in order. */
  requests(): Array<{ id: number; method: string; params?: unknown }> {
    return this.written
      .map((line) => decodeJsonRpcLine(line))
      .filter((decoded) => decoded.kind === "request")
      .map((decoded) => decoded.message as JsonRpcRequest)
      .map((message) => ({
        id: message.id as number,
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params })
      }));
  }

  /** The decoded notifications the client sent, in order. */
  notifications(): Array<{ method: string; params?: unknown }> {
    return this.written
      .map((line) => decodeJsonRpcLine(line))
      .filter((decoded) => decoded.kind === "notification")
      .map((decoded) => decoded.message as JsonRpcNotification)
      .map((message) => ({
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params })
      }));
  }
}

const INITIALIZE_RESULT = {
  codexHome: "C:\\Users\\me\\.codex",
  platformFamily: "windows",
  platformOs: "windows",
  userAgent: "codex-app-server/0.147.0"
};

function openClient(
  transport: ScriptedTransport,
  options: {
    requestTimeoutMs?: number;
    turnWaitTimeoutMs?: number;
    bufferMax?: number;
  } = {}
): CodexAppServerClient {
  return new CodexAppServerClient({
    transport,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.turnWaitTimeoutMs === undefined ? {} : { turnWaitTimeoutMs: options.turnWaitTimeoutMs }),
    ...(options.bufferMax === undefined ? {} : { bufferMax: options.bufferMax })
  });
}


/** Starts the handshake and feeds the scripted initialize response while in flight. */
async function initializeClient(
  client: CodexAppServerClient,
  transport: ScriptedTransport
): Promise<void> {
  const handshake = client.initialize();
  transport.receiveMessage({ id: 1, result: INITIALIZE_RESULT });
  await handshake;
}

/** Normalizes a synchronous throw into a rejected promise for `rejects` assertions. */
function attempt(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

describe("CodexAppServerClient (0.147.0 used subset, scripted transport)", () => {
  it("performs the handshake in order: initialize request with experimentalApi false, then initialized notification", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);

    const handshake = client.initialize();
    const requests = transport.requests();
    expect(requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(requests[0]?.params).toEqual({
      clientInfo: { name: "swpanel", version: "0.1.0" },
      capabilities: { experimentalApi: false }
    });
    expect(client.initialized).toBe(false);

    transport.receiveMessage({ id: requests[0]!.id, result: INITIALIZE_RESULT });
    await expect(handshake).resolves.toEqual(INITIALIZE_RESULT);

    expect(client.initialized).toBe(true);
    expect(transport.notifications()).toEqual([{ method: "initialized" }]);
  });

  it("rejects initialize immediately when sending the initialized notification fails (TRANSPORT, fail-closed)", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    const handshake = client.initialize();
    const request = transport.requests()[0]!;
    // The initialize RESPONSE is valid, but the transport now fails every
    // write (e.g. stdin EPIPE): the initialized notification cannot be
    // delivered — the handshake must REJECT, never resolve "initialized"
    // over a notification it could not send.
    transport.writeLine = () => {
      throw new Error("EPIPE: stdin closed");
    };
    transport.receiveMessage({ id: request.id, result: INITIALIZE_RESULT });
    await expect(handshake).rejects.toMatchObject({
      name: "CodexClientError",
      code: "TRANSPORT"
    });
    expect(client.initialized).toBe(false);
    expect(transport.closed).toBe(true);
    // The connection is failed closed: later calls throw the same error.
    await expect(attempt(() => client.threadStart({}))).rejects.toMatchObject({
      code: "TRANSPORT"
    });
  });

  it("rejects an initialize response missing the required fields as PROTOCOL", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    const handshake = client.initialize();
    const request = transport.requests()[0]!;
    transport.receiveMessage({ id: request.id, result: { codexHome: "only-one" } });
    await expect(handshake).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("refuses requests before the handshake with NOT_INITIALIZED", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await expect(client.threadStart({})).rejects.toMatchObject({
      name: "CodexClientError",
      code: "NOT_INITIALIZED"
    });
  });

  it("correlates concurrent requests by id even when responses arrive out of order", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const first = client.request("thread/start", { tag: "a" });
    const second = client.request("turn/start", { tag: "b" });
    const requests = transport.requests().slice(1);
    expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
    const [threadId, turnId] = [requests[0]!.id, requests[1]!.id];

    // Out-of-order responses: the SECOND request answers first.
    transport.receiveMessage({ id: turnId, result: { turn: { id: "turn-2" } } });
    await expect(second).resolves.toEqual({ turn: { id: "turn-2" } });
    transport.receiveMessage({ id: threadId, result: { thread: { id: "thread-1" } } });
    await expect(first).resolves.toEqual({ thread: { id: "thread-1" } });
  });

  it("rejects a request whose response never arrives (TIMEOUT)", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport, { requestTimeoutMs: 20 });
    await initializeClient(client, transport);

    const pending = client.request("thread/start", {});
    await expect(pending).rejects.toMatchObject({
      name: "CodexClientError",
      code: "TIMEOUT"
    });
  });

  it("ignores a late response after a synchronous request write failure and keeps the connection healthy", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const healthyWriteLine = transport.writeLine.bind(transport);
    transport.writeLine = (line) => {
      transport.written.push(line);
      throw new Error("EPIPE after partial write");
    };
    const failed = client.request("thread/start", {});
    const failedRequest = transport.requests().at(-1)!;
    await expect(failed).rejects.toMatchObject({
      name: "CodexClientError",
      code: "TRANSPORT"
    });

    transport.receiveMessage({ id: failedRequest.id, result: { thread: { id: "late" } } });
    transport.writeLine = healthyWriteLine;
    const next = client.threadStart({});
    const nextRequest = transport.requests().at(-1)!;
    transport.receiveMessage({ id: nextRequest.id, result: { thread: { id: "next" } } });
    await expect(next).resolves.toMatchObject({ thread: { id: "next" } });
  });

  it("surfaces JSON-RPC error responses as RPC_ERROR", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const pending = client.request("turn/start", {});
    const request = transport.requests().at(-1)!;
    transport.receiveMessage({
      id: request.id,
      error: { code: -32601, message: "method not found" }
    });
    await expect(pending).rejects.toMatchObject({
      name: "CodexClientError",
      code: "RPC_ERROR",
      details: { rpcCode: -32601 }
    });
  });

  it("surfaces the native -32600 gated-field rejection (runtimeWorkspaceRoots requires experimentalApi) as RPC_ERROR", async () => {
    // The exact regression the stable-protocol fix prevents: native Codex
    // 0.147.0 rejects thread/start with JSON-RPC -32600 when a gated field
    // (runtimeWorkspaceRoots) is sent under experimentalApi:false. The client
    // must surface it as the structured RPC_ERROR the adapter maps onto
    // AGENT_PROTOCOL_INCOMPATIBLE — never a silent success.
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const pending = client.threadStart({ cwd: "C:\\w", sandbox: "workspace-write" });
    const request = transport.requests().at(-1)!;
    transport.receiveMessage({
      id: request.id,
      error: {
        code: -32600,
        message: "thread/start.runtimeWorkspaceRoots requires experimentalApi capability"
      }
    });
    await expect(pending).rejects.toMatchObject({
      name: "CodexClientError",
      code: "RPC_ERROR",
      details: { rpcCode: -32600 }
    });
  });

  it("pins the STABLE thread/start wire params: the gated runtimeWorkspaceRoots field is never sent", async () => {
    // The wire-level companion of the -32600 rejection: with experimentalApi
    // false the client's thread-open request carries ONLY the stable fields —
    // exactly what the builder emits (cwd + sandbox + approvalPolicy "never"),
    // never a gated field.
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const pending = client.threadStart({
      cwd: "C:\\workspaces\\runs\\run-1\\attempt-001",
      sandbox: "workspace-write",
      approvalPolicy: "never"
    });
    const request = transport.requests().at(-1)!;
    transport.receiveMessage({ id: request.id, result: { thread: { id: "thread-1" } } });
    await expect(pending).resolves.toEqual({ thread: { id: "thread-1" } });

    expect(request.params).toEqual({
      cwd: "C:\\workspaces\\runs\\run-1\\attempt-001",
      sandbox: "workspace-write",
      approvalPolicy: "never"
    });
    expect(request.params).not.toHaveProperty("runtimeWorkspaceRoots");
  });

  it("fails the connection closed on child exit: pending requests reject CHILD_EXIT", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const pending = client.request("thread/start", {});
    transport.exit(1, null);
    await expect(pending).rejects.toMatchObject({
      name: "CodexClientError",
      code: "CHILD_EXIT"
    });
    expect(transport.closed).toBe(true);
    expect(client.childExit).toEqual({ code: 1, signal: null });
    // Every later call, including initialize's cached-handshake path, fails fast
    // with the same structured error.
    await expect(client.initialize()).rejects.toMatchObject({ code: "CHILD_EXIT" });
    await expect(attempt(() => client.request("turn/start", {}))).rejects.toMatchObject({ code: "CHILD_EXIT" });
  });

  it("fails the connection on a malformed wire line (PROTOCOL) and on unknown response ids", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    transport.receive("{not json");
    await expect(attempt(() => client.request("thread/start", {}))).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });

    const transport2 = new ScriptedTransport();
    const client2 = openClient(transport2);
    await initializeClient(client2, transport2);
    // A response for a request this client never sent is a protocol violation.
    transport2.receiveMessage({ id: 999, result: {} });
    await expect(attempt(() => client2.request("thread/start", {}))).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("rejects an incoming server request (outside the used subset) as PROTOCOL", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);
    transport.receiveMessage({ id: 42, method: "serverRequest/resolved", params: {} });
    await expect(attempt(() => client.request("thread/start", {}))).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("delivers ONLY the fixed method name to content-free onServerRequest observers before failing the connection", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const methods: string[] = [];
    const unsubscribe = client.onServerRequest((method) => methods.push(method));
    // An approval server request arrives while the client is idle.
    transport.receiveMessage({
      id: 7,
      method: "item/permissions/requestApproval",
      params: { permissions: [{ path: "C:\\secret", mode: "write" }] }
    });
    // The observer was invoked with the fixed method name ONLY (never params).
    expect(methods).toEqual(["item/permissions/requestApproval"]);
    // The params never reached the observer.
    expect(JSON.stringify(methods)).not.toContain("C:\\secret");
    // The request still fails the whole connection closed afterwards.
    await expect(attempt(() => client.request("thread/start", {}))).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });

    const unsubscribe2 = client.onServerRequest(() => methods.push("second"));
    // The connection is already failed: later server requests are dropped and
    // the observer is not invoked for them.
    transport.receiveMessage({ id: 8, method: "item/tool/call", params: {} });
    expect(methods).toEqual(["item/permissions/requestApproval"]);
    unsubscribe();
    unsubscribe2();
  });

  it("waits for turn/completed from the buffered stream (instant turn)", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    // The completion arrives BEFORE the wait is registered.
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    });
    await expect(
      client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" })
    ).resolves.toEqual({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    });
  });

  it("waits for turn/completed from the live stream and dispatches deltas to listeners in order", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const deltas: string[] = [];
    client.onNotification((notification) => {
      if (notification.method === "item/agentMessage/delta") {
        const params = notification.params as { delta: string };
        deltas.push(params.delta);
      }
    });
    const waiting = client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" });
    transport.receiveMessage({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "{\"result\":" }
    });
    transport.receiveMessage({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "\"completed\"}" }
    });
    expect(deltas).toEqual(['{"result":', '"completed"}']);
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    });
    await expect(waiting).resolves.toMatchObject({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    });
  });

  it("parses the native turn.error.message into the completed errorMessage field", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const waiting = client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" });
    transport.receiveMessage({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "failed", error: { message: "native skill turn failed" } }
      }
    });
    await expect(waiting).resolves.toEqual({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "failed", errorMessage: "native skill turn failed" }
    });
  });

  it("leaves errorMessage absent when a failed turn carries no error object", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const waiting = client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" });
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } }
    });
    await expect(waiting).resolves.toEqual({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "failed" }
    });
  });

  it("rejects a turn/completed with an unknown status as PROTOCOL", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const waiting = client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" });
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "mystery" } }
    });
    await expect(waiting).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("times out while waiting for a turn that never completes", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport, { turnWaitTimeoutMs: 20 });
    await initializeClient(client, transport);

    await expect(
      client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" })
    ).rejects.toMatchObject({
      name: "CodexClientError",
      code: "TIMEOUT"
    });
  });

  it("keeps the shared client usable for a later turn wait after a turn-wait timeout", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport, { turnWaitTimeoutMs: 20 });
    await initializeClient(client, transport);

    await expect(
      client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-timeout" })
    ).rejects.toMatchObject({
      name: "CodexClientError",
      code: "TIMEOUT"
    });

    const next = client.waitForTurnCompleted({
      threadId: "thread-1",
      turnId: "turn-next",
      timeoutMs: 1_000
    });
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-next", status: "completed" } }
    });
    await expect(next).resolves.toEqual({
      threadId: "thread-1",
      turn: { id: "turn-next", status: "completed" }
    });
  });

  it("validates typed request results (thread/turn ids) strictly", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const thread = client.threadStart({});
    transport.receiveMessage({ id: 2, result: { thread: { id: "" } } });
    await expect(thread).rejects.toMatchObject({ code: "PROTOCOL" });

    const turn = client.turnStart({});
    transport.receiveMessage({ id: 3, result: {} });
    await expect(turn).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("rejects a foreign same-thread turn completion while waiting as PROTOCOL", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const waiting = client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" });
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-OTHER", status: "completed" } }
    });
    await expect(waiting).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("ignores a LATE response to an already-timed-out request and keeps the connection healthy", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport, { requestTimeoutMs: 20 });
    await initializeClient(client, transport);

    const pending = client.request("thread/start", {});
    const request = transport.requests().at(-1)!;
    await expect(pending).rejects.toMatchObject({ name: "CodexClientError", code: "TIMEOUT" });

    // The late response arrives AFTER the timeout: dropped, connection stays up.
    transport.receiveMessage({ id: request.id, result: { thread: { id: "late" } } });
    const next = client.threadStart({});
    const nextRequest = transport.requests().at(-1)!;
    transport.receiveMessage({ id: nextRequest.id, result: { thread: { id: "next" } } });
    await expect(next).resolves.toMatchObject({ thread: { id: "next" } });

    // A response for an id that NEVER had a request still fails the connection.
    transport.receiveMessage({ id: 999_999, result: {} });
    await expect(attempt(() => client.request("thread/start", {}))).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("fails the connection closed when the retained notification buffer overflows", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport, { bufferMax: 2 });
    await initializeClient(client, transport);

    // Only turn/completed notifications are retained: unconsumed completions
    // of turns nobody waits on count against the cap.
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } }
    });
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-b", turn: { id: "turn-b", status: "completed" } }
    });
    // Exactly at the cap: the connection is still healthy.
    const probe = client.request("thread/start", {});
    const probeRequest = transport.requests().at(-1)!;
    transport.receiveMessage({ id: probeRequest.id, result: { thread: { id: "ok" } } });
    await expect(probe).resolves.toMatchObject({ thread: { id: "ok" } });

    // One more retained notification overflows: fail closed, never silent growth.
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-c", turn: { id: "turn-c", status: "completed" } }
    });
    await expect(attempt(() => client.request("thread/start", {}))).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("prunes consumed turn/completed entries so the retained buffer can be reused", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport, { bufferMax: 2 });
    await initializeClient(client, transport);

    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-0", turn: { id: "turn-0", status: "completed" } }
    }); // [c0]
    const waiting = client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" });
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    }); // [c0, c1(consumed)]
    await expect(waiting).resolves.toMatchObject({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    });

    // Without pruning the next push would overflow (3 > 2); the consumed
    // completion is pruned first, so this push stays within the cap.
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-2", turn: { id: "turn-2", status: "completed" } }
    }); // [c0, c2]
    const probe = client.request("thread/start", {});
    const probeRequest = transport.requests().at(-1)!;
    transport.receiveMessage({ id: probeRequest.id, result: { thread: { id: "alive" } } });
    await expect(probe).resolves.toMatchObject({ thread: { id: "alive" } });

    // The next push has nothing to prune: overflow fails closed.
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-3", turn: { id: "turn-3", status: "completed" } }
    });
    await expect(attempt(() => client.request("thread/start", {}))).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("does not retain or fail closed on more than bufferMax irrelevant/delta notifications", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport); // default bufferMax 1024
    await initializeClient(client, transport);

    // >1024 delta/stage notifications: dispatched to listeners, never
    // retained, never fail the connection — the buffer must NOT accumulate
    // them over connection lifetime.
    const seenDeltas: string[] = [];
    client.onNotification((notification) => {
      if (notification.method === "item/agentMessage/delta") {
        const params = notification.params as { delta: string };
        seenDeltas.push(params.delta);
      }
    });
    for (let index = 0; index < 1100; index++) {
      if (index % 5 === 0) {
        transport.receiveMessage({ method: "item/tool/started", params: { index } });
      }
      transport.receiveMessage({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: `d${index}` }
      });
    }
    expect(seenDeltas).toHaveLength(1100);

    // The connection is still healthy: a retained completion still resolves
    // its waiter and a request still round-trips.
    const waiting = client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" });
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    });
    await expect(waiting).resolves.toMatchObject({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    });
    const probe = client.request("thread/start", {});
    const probeRequest = transport.requests().at(-1)!;
    transport.receiveMessage({ id: probeRequest.id, result: { thread: { id: "ok" } } });
    await expect(probe).resolves.toMatchObject({ thread: { id: "ok" } });
  });

  it("consumes a retained turn/completed and frees the slot for the next retained completion", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport, { bufferMax: 1 });
    await initializeClient(client, transport);

    // The completion arrives BEFORE the wait is registered: retained.
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
    });
    await expect(
      client.waitForTurnCompleted({ threadId: "thread-1", turnId: "turn-1" })
    ).resolves.toMatchObject({
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    });

    // The consumed entry is pruned on the next push, so a SECOND retained
    // completion fits within the cap of 1 (no fail-closed) and is served.
    transport.receiveMessage({
      method: "turn/completed",
      params: { threadId: "thread-2", turn: { id: "turn-2", status: "completed" } }
    });
    await expect(
      client.waitForTurnCompleted({ threadId: "thread-2", turnId: "turn-2" })
    ).resolves.toMatchObject({
      threadId: "thread-2",
      turn: { id: "turn-2", status: "completed" }
    });
  });

  it("rejects a null turn/interrupt response as PROTOCOL (0.147.0 response must be an object)", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const pending = client.turnInterrupt({ threadId: "thread-1", turnId: "turn-1" });
    const request = transport.requests().at(-1)!;
    transport.receiveMessage({ id: request.id, result: null });
    await expect(pending).rejects.toMatchObject({
      name: "CodexClientError",
      code: "PROTOCOL"
    });
  });

  it("poison() permanently makes the client non-reusable: transport closed, later calls throw CLOSED, idempotent", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    client.poison("a fixed safe reason");
    expect(transport.closed).toBe(true);
    await expect(attempt(() => client.initialize())).rejects.toMatchObject({
      name: "CodexClientError",
      code: "CLOSED"
    });
    await expect(
      attempt(() => client.turnInterrupt({ threadId: "t", turnId: "t" }))
    ).rejects.toMatchObject({
      name: "CodexClientError",
      code: "CLOSED"
    });
    await expect(
      attempt(() => client.waitForTurnCompleted({ threadId: "t", turnId: "t" }))
    ).rejects.toMatchObject({
      name: "CodexClientError",
      code: "CLOSED"
    });

    // Idempotent: poisoning again (or a normal close afterwards) is a no-op.
    client.poison("another fixed safe reason");
    client.close();
    await expect(attempt(() => client.initialize())).rejects.toMatchObject({
      name: "CodexClientError",
      code: "CLOSED"
    });
  });
});

describe("CodexAppServerClient skills/list (0.147.0 strict SkillsListResponse)", () => {
  const SKILL_ENTRY = {
    cwd: "C:\\workspaces\\runs\\run-1\\attempt-001",
    errors: [],
    skills: [
      {
        name: "solidworks-build-part-from-drawing",
        description: "Build a part from a drawing",
        enabled: true,
        path: "C:\\skills\\solidworks-build-part-from-drawing",
        scope: "user",
        shortDescription: "2D -> 3D"
      }
    ]
  };

  it("sends skills/list with the built params and validates the strict response", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const pending = client.skillsList({
      cwds: ["C:\\workspaces\\run-1"],
      forceReload: true
    });
    const requests = transport.requests();
    expect(requests.at(-1)?.method).toBe("skills/list");
    expect(requests.at(-1)?.params).toEqual({
      cwds: ["C:\\workspaces\\run-1"],
      forceReload: true
    });

    transport.receiveMessage({
      id: requests.at(-1)!.id,
      result: { data: [SKILL_ENTRY] }
    });
    await expect(pending).resolves.toEqual({
      data: [
        {
          cwd: SKILL_ENTRY.cwd,
          errors: [],
          skills: [
            {
              name: "solidworks-build-part-from-drawing",
              description: "Build a part from a drawing",
              enabled: true,
              path: "C:\\skills\\solidworks-build-part-from-drawing",
              scope: "user",
              shortDescription: "2D -> 3D"
            }
          ]
        }
      ]
    });
  });

  it("sends an empty params object when called without params", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const pending = client.skillsList();
    const requests = transport.requests();
    expect(requests.at(-1)?.method).toBe("skills/list");
    expect(requests.at(-1)?.params).toEqual({});

    transport.receiveMessage({ id: requests.at(-1)!.id, result: { data: [] } });
    await expect(pending).resolves.toEqual({ data: [] });
  });

  it("tolerates optional SkillMetadata fields absent and unknown extra fields", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await initializeClient(client, transport);

    const pending = client.skillsList();
    const request = transport.requests().at(-1)!;
    transport.receiveMessage({
      id: request.id,
      result: {
        data: [
          {
            cwd: "C:\\w",
            errors: [{ message: "no SKILL.md", path: "C:\\w\\x" }],
            skills: [{ name: "s", description: "d", enabled: false, path: "C:\\s", scope: "repo", extra: 42 }]
          }
        ]
      }
    });
    await expect(pending).resolves.toEqual({
      data: [
        {
          cwd: "C:\\w",
          errors: [{ message: "no SKILL.md", path: "C:\\w\\x" }],
          skills: [{ name: "s", description: "d", enabled: false, path: "C:\\s", scope: "repo" }]
        }
      ]
    });
  });

  it("requires the completed handshake before skills/list (NOT_INITIALIZED)", async () => {
    const transport = new ScriptedTransport();
    const client = openClient(transport);
    await expect(attempt(() => client.skillsList())).rejects.toMatchObject({
      name: "CodexClientError",
      code: "NOT_INITIALIZED"
    });
  });

  const MALFORMED_RESPONSES: ReadonlyArray<{ label: string; result: unknown }> = [
    { label: "missing data", result: {} },
    { label: "data not an array", result: { data: "x" } },
    { label: "entry missing cwd", result: { data: [{ errors: [], skills: [] }] } },
    { label: "entry errors not an array", result: { data: [{ cwd: "C:\\w", errors: "x", skills: [] }] } },
    { label: "entry skills not an array", result: { data: [{ cwd: "C:\\w", errors: [], skills: "x" }] } },
    { label: "error missing path", result: { data: [{ cwd: "C:\\w", errors: [{ message: "m" }], skills: [] }] } },
    { label: "skill missing name", result: { data: [{ cwd: "C:\\w", errors: [], skills: [{ description: "d", enabled: true, path: "C:\\s", scope: "user" }] }] } },
    { label: "skill missing enabled", result: { data: [{ cwd: "C:\\w", errors: [], skills: [{ name: "s", description: "d", path: "C:\\s", scope: "user" }] }] } },
    { label: "skill scope outside the enum", result: { data: [{ cwd: "C:\\w", errors: [], skills: [{ name: "s", description: "d", enabled: true, path: "C:\\s", scope: "global" }] }] } },
    { label: "skill path not a string", result: { data: [{ cwd: "C:\\w", errors: [], skills: [{ name: "s", description: "d", enabled: true, path: 42, scope: "user" }] }] } }
  ];

  for (const { label, result } of MALFORMED_RESPONSES) {
    it(`fails the connection closed with PROTOCOL on a malformed response: ${label}`, async () => {
      const transport = new ScriptedTransport();
      const client = openClient(transport);
      await initializeClient(client, transport);

      const pending = client.skillsList();
      const request = transport.requests().at(-1)!;
      transport.receiveMessage({ id: request.id, result });
      await expect(pending).rejects.toMatchObject({
        name: "CodexClientError",
        code: "PROTOCOL"
      });
      // The connection is failed closed: a follow-up request throws PROTOCOL.
      await expect(attempt(() => client.skillsList())).rejects.toMatchObject({
        name: "CodexClientError",
        code: "PROTOCOL"
      });
    });
  }
});
