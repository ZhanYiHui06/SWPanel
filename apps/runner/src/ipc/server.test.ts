import { afterEach, describe, expect, it } from "vitest";
import type { Duplex } from "node:stream";

import type {
  IpcMessage,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
  RunEventSubscriber
} from "@swpanel/contracts";
import { IPC_PROTOCOL_VERSION } from "@swpanel/contracts";
import type { RunEvent } from "@swpanel/domain";

import { createDuplexPipePair } from "./duplex-pair.js";
import { FrameCodec } from "./frame-codec.js";
import type { IpcRequestHandler } from "./request-handler.js";
import { IpcServer, MAX_FRAME_BYTES, SHUTDOWN_ERROR_CODE, type IpcEventStream } from "./server.js";

/** Records every dispatched envelope so tests can assert idempotency. */
class RecordingHandler implements IpcRequestHandler {
  readonly calls: IpcRequestEnvelope[] = [];

  handle(request: IpcRequestEnvelope): Promise<IpcResponseEnvelope> {
    this.calls.push(request);
    return Promise.resolve({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      data: { operation: request.operation, echo: request.payload }
    });
  }
}

/** Deterministic persisted RunEvent for subscription tests. */
function runEvent(runId: string, sequence: number): RunEvent {
  return {
    contractVersion: 1,
    runId,
    attemptId: "attempt-1",
    sequence,
    occurredAt: "2026-08-13T00:00:00.000Z",
    type: "StageChanged",
    stage: "PREPARING"
  };
}

/**
 * Scriptable after-commit event stream: the test seeds the persisted backlog
 * and pushes live batches through the captured subscriber, mirroring the
 * Runner's commit hook.
 */
class FakeEventStream implements IpcEventStream {
  readonly backlog: Map<string, readonly RunEvent[]> = new Map();
  readonly subscribeCalls: string[] = [];
  readonly listCalls: Array<{ runId: string; fromSequence: number }> = [];
  subscriber: RunEventSubscriber | null = null;
  unsubscribed = 0;

  subscribeRunEvents(runId: string, subscriber: RunEventSubscriber): () => void {
    this.subscribeCalls.push(runId);
    this.subscriber = subscriber;
    return () => {
      this.unsubscribed += 1;
      this.subscriber = null;
    };
  }

  listRunEventsFrom(runId: string, fromSequence: number): readonly RunEvent[] {
    this.listCalls.push({ runId, fromSequence });
    const events = this.backlog.get(runId);
    if (events === undefined) {
      // Mirror the Runner repository: unknown Runs are a structured NOT_FOUND.
      throw Object.assign(new Error(`Run ${runId} was not found`), { code: "NOT_FOUND" });
    }
    return events.filter((event) => event.sequence >= fromSequence);
  }

  /** Pushes a committed batch to the live subscriber (after-commit delivery). */
  push(runId: string, events: readonly RunEvent[]): void {
    const first = events[0];
    this.subscriber?.onRunEvents({
      runId,
      fromSequence: first === undefined ? 0 : first.sequence,
      events
    });
  }
}

function queryRequest(
  requestId: string,
  operation = "storage.getSettings",
  payload: unknown = {}
): IpcRequestEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    channel: "query",
    operation: operation as IpcRequestEnvelope["operation"],
    payload
  };
}

function commandRequest(
  requestId: string,
  operation = "storage.updateSettings",
  payload: unknown = { command: "storage.updateSettings" },
  idempotencyKey?: string
): IpcRequestEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    channel: "command",
    operation: operation as IpcRequestEnvelope["operation"],
    payload
  };
}

/** In-memory pipe peer that speaks the shared framing over a duplex pair. */
class PipeTestClient {
  readonly stream: Duplex;
  private readonly codec = new FrameCodec();
  private readonly queue: IpcMessage[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(server: IpcServer) {
    const pair = createDuplexPipePair();
    server.attach(pair.server);
    this.stream = pair.client;
    this.stream.pipe(this.codec);
    this.codec.on("data", (line: string) => {
      this.queue.push(JSON.parse(line) as IpcMessage);
      this.notify();
    });
  }

  private notify(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  async next(timeoutMs = 2_000): Promise<IpcMessage> {
    const existing = this.queue.shift();
    if (existing !== undefined) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the next IPC message")),
        timeoutMs
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        const message = this.queue.shift();
        if (message === undefined) return;
        resolve(message);
      });
    });
  }

  write(message: IpcMessage): void {
    this.stream.write(FrameCodec.encode(message));
  }

  writeRaw(chunk: Buffer): void {
    this.stream.write(chunk);
  }

  destroy(): void {
    this.stream.destroy();
  }
}

describe("IpcServer (in-process duplex transport)", () => {
  const servers: IpcServer[] = [];
  const clients: PipeTestClient[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.destroy();
    }
    while (servers.length > 0) {
      const server = servers.pop();
      void server?.close();
    }
  });

  function newServer(
    handler: IpcRequestHandler = new RecordingHandler(),
    options: { eventStream?: IpcEventStream } = {}
  ): IpcServer {
    const server = new IpcServer(handler, {
      pipePath: "\\\\.\\pipe\\swpanel.test.in-memory",
      platform: "win32",
      ...(options.eventStream === undefined ? {} : { eventStream: options.eventStream })
    });
    servers.push(server);
    return server;
  }

  function connect(server: IpcServer): PipeTestClient {
    const client = new PipeTestClient(server);
    clients.push(client);
    return client;
  }

  it("sends the handshake immediately on connect", async () => {
    const server = newServer();
    const client = connect(server);
    const handshake = await client.next();
    expect(handshake).toEqual({
      protocolVersion: IPC_PROTOCOL_VERSION,
      serverInstanceId: server.serverInstanceId
    });
  });

  it("dispatches a validated query and returns the response", async () => {
    const handler = new RecordingHandler();
    const server = newServer(handler);
    const client = connect(server);
    await client.next(); // handshake

    client.write(queryRequest("req-1"));
    const response = (await client.next()) as IpcResponseEnvelope;
    expect(response.requestId).toBe("req-1");
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({
      operation: "storage.getSettings",
      echo: {}
    });
    expect(handler.calls).toHaveLength(1);
  });

  it("rejects an unknown operation with a structured error and keeps the connection open", async () => {
    const handler = new RecordingHandler();
    const server = newServer(handler);
    const client = connect(server);
    await client.next(); // handshake

    client.write(queryRequest("req-1", "drawing.destroy", { drawingId: "d-1" }));
    const response = (await client.next()) as IpcResponseEnvelope;
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("UNKNOWN_OPERATION");
    expect(handler.calls).toHaveLength(0);

    // The connection survives: a subsequent valid request still works.
    client.write(queryRequest("req-2"));
    const followUp = (await client.next()) as IpcResponseEnvelope;
    expect(followUp.requestId).toBe("req-2");
    expect(followUp.ok).toBe(true);
  });

  it("rejects a malformed JSON frame by disconnecting (no protocol-invalid empty-requestId response)", async () => {
    const server = newServer();
    const client = connect(server);
    await client.next(); // handshake

    // A frame with no recoverable request id cannot be answered with a valid
    // response envelope; the server terminates the connection instead of
    // emitting an invalid empty-requestId response the client would reject.
    client.writeRaw(Buffer.from("{not valid json}\n"));
    await expect(client.next(500)).rejects.toThrow(/timed out waiting/);
  });

  it("rejects a MISSING_REQUEST_ID envelope by disconnecting (no recoverable request id)", async () => {
    const server = newServer();
    const client = connect(server);
    await client.next(); // handshake

    client.writeRaw(
      Buffer.from(
        `${JSON.stringify({
          protocolVersion: IPC_PROTOCOL_VERSION,
          requestId: "",
          channel: "query",
          operation: "storage.getSettings",
          payload: {}
        })}\n`
      )
    );
    await expect(client.next(500)).rejects.toThrow(/timed out waiting/);
  });

  it("rejects a channel/operation mismatch with CHANNEL_OPERATION_MISMATCH", async () => {
    const handler = new RecordingHandler();
    const server = newServer(handler);
    const client = connect(server);
    await client.next(); // handshake

    const asCommand = { ...queryRequest("req-1"), channel: "command" } as IpcRequestEnvelope;
    client.write(asCommand);
    const response = (await client.next()) as IpcResponseEnvelope;
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("CHANNEL_OPERATION_MISMATCH");
    expect(handler.calls).toHaveLength(0);
  });

  it("disconnects on an oversized frame instead of emitting an invalid empty-requestId response", async () => {
    const server = newServer();
    const client = connect(server);
    await client.next(); // handshake

    const oversized = Buffer.from("x".repeat(1_048_576 + 1) + "\n");
    client.writeRaw(oversized);
    // The codec error path terminates the connection; no response frame is
    // emitted (a response with an empty request id would be protocol-invalid).
    await expect(client.next(500)).rejects.toThrow(/timed out waiting/);
  });

  it("answers a repeated (requestId, idempotencyKey) command from cache without re-executing", async () => {
    const handler = new RecordingHandler();
    const server = newServer(handler);
    const client = connect(server);
    await client.next(); // handshake

    const request = commandRequest("cmd-1", "storage.updateSettings", {
      command: "storage.updateSettings",
      settings: {
        dataRoot: "C:\\data",
        workspaceRoot: "C:\\data\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    }, "idem-1");

    client.write(request);
    const first = (await client.next()) as IpcResponseEnvelope;
    expect(first.ok).toBe(true);
    expect(handler.calls).toHaveLength(1);

    // Identical requestId + idempotencyKey: answered from cache, handler not called again.
    client.write(request);
    const second = (await client.next()) as IpcResponseEnvelope;
    expect(second.requestId).toBe("cmd-1");
    expect(second.ok).toBe(true);
    expect(handler.calls).toHaveLength(1);
  });

  it("deduplicates the SAME idempotencyKey with a FRESH requestId and re-echoes the current request id", async () => {
    const handler = new RecordingHandler();
    const server = newServer(handler);
    const client = connect(server);
    await client.next(); // handshake

    const payload = {
      command: "storage.updateSettings",
      settings: {
        dataRoot: "C:\\data",
        workspaceRoot: "C:\\data\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    };

    client.write(commandRequest("cmd-1", "storage.updateSettings", payload, "stable-intent-1"));
    const first = (await client.next()) as IpcResponseEnvelope;
    expect(first.ok).toBe(true);
    expect(first.requestId).toBe("cmd-1");
    expect(handler.calls).toHaveLength(1);

    // A retry with a NEW request id but the SAME stable intent key must not
    // re-execute; the cached response is re-echoed with the current request id.
    client.write(commandRequest("cmd-2", "storage.updateSettings", payload, "stable-intent-1"));
    const replay = (await client.next()) as IpcResponseEnvelope;
    expect(replay.ok).toBe(true);
    expect(replay.requestId).toBe("cmd-2");
    expect(handler.calls).toHaveLength(1);

    // A DIFFERENT intent key still executes normally.
    client.write(commandRequest("cmd-3", "storage.updateSettings", payload, "stable-intent-2"));
    const fresh = (await client.next()) as IpcResponseEnvelope;
    expect(fresh.ok).toBe(true);
    expect(handler.calls).toHaveLength(2);
  });

  it("does not deduplicate queries (only commands are cached)", async () => {
    const handler = new RecordingHandler();
    const server = newServer(handler);
    const client = connect(server);
    await client.next(); // handshake

    const request = queryRequest("q-1");
    client.write(request);
    await client.next();
    client.write(request);
    await client.next();
    expect(handler.calls).toHaveLength(2);
  });

  it("does not cache FAILED commands: a later retry with the same idempotencyKey executes (B1)", async () => {
    let calls = 0;
    const handler: IpcRequestHandler = {
      handle: (request) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            protocolVersion: IPC_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: false,
            error: { code: "NOT_FOUND", message: "Run run-1 was not found" }
          });
        }
        return Promise.resolve({
          protocolVersion: IPC_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          data: { runId: "run-1", status: "CANCELLED" }
        });
      }
    };
    const server = newServer(handler);
    const payload = { command: "run.cancel", runId: "run-1" };
    const first = await server.dispatch(
      commandRequest("c-1", "run.cancel", payload, "intent:cancel-1")
    );
    expect(first.ok).toBe(false);
    // The FAILED response must NOT have been cached: the same key retried
    // (fresh request id) re-executes and can succeed.
    const retry = await server.dispatch(
      commandRequest("c-2", "run.cancel", payload, "intent:cancel-1")
    );
    expect(retry.ok).toBe(true);
    expect(retry.data).toEqual({ runId: "run-1", status: "CANCELLED" });
    expect(calls).toBe(2);
    // And a SUCCESSFUL command IS still deduplicated afterwards.
    const replay = await server.dispatch(
      commandRequest("c-3", "run.cancel", payload, "intent:cancel-1")
    );
    expect(replay.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("never pushes another Run's committed events into a subscription; the connection stays healthy (B2)", async () => {
    const stream = new FakeEventStream();
    stream.backlog.set("run-1", [runEvent("run-1", 1)]);
    const server = newServer(new RecordingHandler(), { eventStream: stream });
    const client = connect(server);
    await client.next(); // handshake

    client.write({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "sub-1",
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 0 }
    });
    await client.next(); // backlog response

    // A commit batch of ANOTHER Run reaches the shared event-stream subscriber
    // (the Runner's after-commit hook is global): the server must filter it
    // out of the run-1 stream instead of emitting a mismatched envelope.
    stream.push("run-2", [runEvent("run-2", 1), runEvent("run-2", 2)]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The connection is healthy: the next frame is the query RESPONSE, never
    // a cross-run envelope.
    client.write(queryRequest("q-after-cross-run"));
    const response = (await client.next()) as IpcResponseEnvelope;
    expect(response.requestId).toBe("q-after-cross-run");
    expect(response.ok).toBe(true);

    // The run-1 live batch still arrives untouched.
    stream.push("run-1", [runEvent("run-1", 2)]);
    const pushed = await client.next();
    expect((pushed as { events: readonly RunEvent[] }).events).toEqual([runEvent("run-1", 2)]);
  });

  it("returns SERVER_SHUTDOWN from dispatch() once closed and refuses new attachments", async () => {
    const server = newServer();
    const client = connect(server);
    await client.next(); // handshake

    await server.close();

    // The contract-level guarantee: dispatch() always answers with a structured
    // shutdown error after close, even for a previously unknown request id.
    const response = await server.dispatch(queryRequest("req-after-close"));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe(SHUTDOWN_ERROR_CODE);

    // A live connection destroyed by close() surfaces as an end on the peer
    // (mirroring a real socket close), not as a structured response.
    client.write(queryRequest("req-2"));
    await expect(client.next(500)).rejects.toThrow(/timed out waiting/);

    // Attaching a fresh peer after close destroys the stream (no handshake).
    const pair = createDuplexPipePair();
    let closed = false;
    pair.server.on("close", () => {
      closed = true;
    });
    server.attach(pair.server);
    pair.server.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(true);
  });

  it("dispatch() validates the envelope and rejects malformed input structurally", async () => {
    const handler = new RecordingHandler();
    const server = newServer(handler);

    const invalid = await server.dispatch({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "",
      channel: "query",
      operation: "storage.getSettings",
      payload: {}
    } as unknown as IpcRequestEnvelope);
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("MISSING_REQUEST_ID");

    const valid = await server.dispatch(queryRequest("direct-1"));
    expect(valid.ok).toBe(true);
    expect(valid.requestId).toBe("direct-1");
    expect(handler.calls).toHaveLength(1);
  });

  it("implements the shared IpcServer contract surface (handshake, subscribe, dispatch)", async () => {
    const server = newServer();
    const contract: import("@swpanel/contracts").IpcServer = server;
    expect(contract.serverInstanceId).toBe(server.serverInstanceId);
    expect(contract.handshake().serverInstanceId).toBe(server.serverInstanceId);

    const events: string[] = [];
    const subscriber: RunEventSubscriber = {
      onRunEvents: (batch) => events.push(JSON.stringify(batch))
    };
    const unsubscribe = contract.subscribeRunEvents("run-1", subscriber);
    expect(events).toEqual([
      JSON.stringify({ runId: "run-1", fromSequence: 0, events: [] })
    ]);
    expect(typeof unsubscribe).toBe("function");

    const response = await contract.dispatch(queryRequest("contract-1"));
    expect(response.ok).toBe(true);
  });

  it("start() refuses to start on a non-Windows platform with a truthful error", async () => {
    const server = new IpcServer(new RecordingHandler(), {
      pipePath: "/tmp/swpanel-test.sock",
      platform: "linux"
    });
    await expect(server.start()).rejects.toThrow(/Windows Named Pipes are only available on win32/);
  });

  it("exposes the shared 1 MiB frame-size cap used by both ends", () => {
    expect(MAX_FRAME_BYTES).toBe(1_048_576);
  });

  it("subscribes over the wire: registers first, resolves the backlog, then pushes live envelopes", async () => {
    const stream = new FakeEventStream();
    stream.backlog.set("run-1", [runEvent("run-1", 1), runEvent("run-1", 2), runEvent("run-1", 3)]);
    const server = newServer(new RecordingHandler(), { eventStream: stream });
    const client = connect(server);
    await client.next(); // handshake

    // Subscribe from sequence 3: the persisted backlog slice resolves the
    // response cursor; the registration happened BEFORE the backlog read
    // (listRunEventsFrom is called after subscribeRunEvents).
    client.write({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "sub-1",
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 3 }
    });
    const response = (await client.next()) as IpcResponseEnvelope;
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({
      runId: "run-1",
      fromSequence: 3,
      events: [runEvent("run-1", 3)]
    });
    expect(stream.subscribeCalls).toEqual(["run-1"]);
    expect(stream.listCalls).toEqual([{ runId: "run-1", fromSequence: 3 }]);

    // A committed batch after the subscription is pushed as a runEvents frame.
    stream.push("run-1", [runEvent("run-1", 4), runEvent("run-1", 5)]);
    const pushed = (await client.next());
    expect(pushed).toEqual({
      protocolVersion: IPC_PROTOCOL_VERSION,
      kind: "runEvents",
      runId: "run-1",
      fromSequence: 4,
      events: [runEvent("run-1", 4), runEvent("run-1", 5)]
    });
  });

  it("answers a structured NOT_FOUND for a subscribe to an unknown Run and releases the registration", async () => {
    const stream = new FakeEventStream();
    const server = newServer(new RecordingHandler(), { eventStream: stream });
    const client = connect(server);
    await client.next(); // handshake

    client.write({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "sub-1",
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "missing", fromSequence: 0 }
    });
    const response = (await client.next()) as IpcResponseEnvelope;
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("NOT_FOUND");

    // The just-registered stream subscription must not leak.
    expect(stream.subscribeCalls).toEqual(["missing"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stream.unsubscribed).toBe(1);
  });

  it("delivers the whole history for a fromSequence-0 subscription and streams live", async () => {
    const stream = new FakeEventStream();
    stream.backlog.set("run-1", [runEvent("run-1", 1)]);
    const server = newServer(new RecordingHandler(), { eventStream: stream });
    const client = connect(server);
    await client.next(); // handshake

    client.write({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "sub-0",
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 0 }
    });
    const response = (await client.next()) as IpcResponseEnvelope;
    expect((response.data as { events: readonly unknown[] }).events).toEqual([runEvent("run-1", 1)]);

    stream.push("run-1", [runEvent("run-1", 2)]);
    const pushed = await client.next();
    expect((pushed as { events: readonly RunEvent[] }).events).toEqual([runEvent("run-1", 2)]);
  });

  it("cleans the per-Run subscription when its connection closes", async () => {
    const stream = new FakeEventStream();
    stream.backlog.set("run-1", [runEvent("run-1", 1)]);
    const server = newServer(new RecordingHandler(), { eventStream: stream });
    const client = connect(server);
    await client.next(); // handshake

    client.write({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "sub-1",
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 0 }
    });
    await client.next(); // backlog response
    expect(stream.unsubscribed).toBe(0);

    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stream.unsubscribed).toBe(1);
  });

  it("releasing the last subscriber of a Run releases the shared event-stream subscription", async () => {
    const stream = new FakeEventStream();
    stream.backlog.set("run-1", [runEvent("run-1", 1)]);
    const server = newServer(new RecordingHandler(), { eventStream: stream });
    const clientA = connect(server);
    const clientB = connect(server);
    await clientA.next(); // handshake A
    await clientB.next(); // handshake B

    const subscribe = (requestId: string): IpcRequestEnvelope => ({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId,
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 0 }
    });
    clientA.write(subscribe("sub-a"));
    clientB.write(subscribe("sub-b"));
    await clientA.next(); // backlog A
    await clientB.next(); // backlog B
    expect(stream.subscribeCalls).toEqual(["run-1"]); // ONE shared stream sub

    clientA.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stream.unsubscribed).toBe(0); // client B still subscribed

    clientB.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stream.unsubscribed).toBe(1); // last subscriber released the stream
  });

  it("implements the in-process subscribeRunEvents with backlog + live delivery", () => {
    const stream = new FakeEventStream();
    stream.backlog.set("run-1", [runEvent("run-1", 1), runEvent("run-1", 2)]);
    const server = newServer(new RecordingHandler(), { eventStream: stream });

    const batches: Array<{ runId: string; fromSequence: number; events: readonly RunEvent[] }> = [];
    const unsubscribe = server.subscribeRunEvents("run-1", {
      onRunEvents: (batch) => batches.push(batch)
    });
    // Backlog from 0 delivered synchronously, then live batches.
    expect(batches).toEqual([
      { runId: "run-1", fromSequence: 0, events: [runEvent("run-1", 1), runEvent("run-1", 2)] }
    ]);
    stream.push("run-1", [runEvent("run-1", 3)]);
    expect(batches[1]?.events).toEqual([runEvent("run-1", 3)]);

    unsubscribe();
    expect(stream.unsubscribed).toBe(1);
    stream.push("run-1", [runEvent("run-1", 4)]);
    expect(batches).toHaveLength(2);
  });

  it("releases every subscription on server close", async () => {
    const stream = new FakeEventStream();
    const server = newServer(new RecordingHandler(), { eventStream: stream });
    const client = connect(server);
    await client.next(); // handshake

    client.write({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "sub-1",
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 0 }
    });
    await client.next(); // backlog

    await server.close();
    expect(stream.unsubscribed).toBe(1);
  });
});
