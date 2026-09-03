import { describe, expect, it } from "vitest";
import type { Duplex } from "node:stream";

import type {
  IpcEventEnvelope,
  IpcHandshakeEnvelope,
  IpcMessage,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
  RunEventCursor,
  RunEventStreamError
} from "@swpanel/contracts";
import { FrameCodec, IPC_PROTOCOL_VERSION } from "@swpanel/contracts";
import type { RunEvent } from "@swpanel/domain";
import { createDuplexPipePair } from "@swpanel/runner";

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
import { IpcClientImpl } from "./client.js";

interface FakePipe {
  /** Server end driven by the test: write handshakes/responses here. */
  server: Duplex;
  serverCodec: FrameCodec;
}

interface TestFixture {
  client: IpcClientImpl;
  pipes: FakePipe[];
  nextRequest: () => Promise<IpcRequestEnvelope>;
  waitForPipe: () => Promise<FakePipe>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` holds (or fails after ~1s). */
async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Deterministic RunEvent for subscription tests. */
function runEvent(sequence: number, type: RunEvent["type"] = "StageChanged", runId = "run-1"): RunEvent {
  return {
    contractVersion: 1,
    runId,
    attemptId: "attempt-1",
    sequence,
    occurredAt: "2026-08-13T00:00:00.000Z",
    type,
    ...(type === "StageChanged" ? { stage: "PREPARING" as const } : {})
  };
}

function eventEnvelope(runId: string, events: readonly RunEvent[]): IpcEventEnvelope {
  const first = events[0];
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    kind: "runEvents",
    runId,
    fromSequence: first === undefined ? 0 : first.sequence,
    events
  };
}

/**
 * A fake transport that hands out a fresh in-memory duplex pair (the same
 * one-directional pair the Runner unit tests use) per connection attempt.
 * Requests sent by the client are captured so the test can drive responses.
 */
function makeFixture(options: {
  expectedServerInstanceId?: string;
  maxConnectAttempts?: number;
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
} = {}): TestFixture {
  const pipes: FakePipe[] = [];
  const requests: IpcRequestEnvelope[] = [];
  const transport: IpcClientTransport = {
    connect(): Promise<Duplex> {
      const pair = createDuplexPipePair();
      const serverCodec = new FrameCodec();
      pair.server.pipe(serverCodec);
      serverCodec.on("data", (line: string) => {
        const message = JSON.parse(line) as IpcMessage;
        if ("channel" in message && typeof message.requestId === "string" && message.requestId !== "") {
          requests.push(message);
        }
      });
      pipes.push({ server: pair.server, serverCodec });
      return Promise.resolve(pair.client);
    }
  };
  const client = new IpcClientImpl({
    transport,
    ...(options.expectedServerInstanceId === undefined
      ? {}
      : { expectedServerInstanceId: options.expectedServerInstanceId }),
    maxConnectAttempts: options.maxConnectAttempts ?? 1,
    reconnectDelayMs: options.reconnectDelayMs ?? 10,
    requestTimeoutMs: options.requestTimeoutMs ?? 500
  });
  const waitForPipe = async (): Promise<FakePipe> => {
    for (let i = 0; i < 100; i++) {
      const latest = pipes[pipes.length - 1];
      if (latest !== undefined) return latest;
      await sleep(5);
    }
    throw new Error("no connection established");
  };
  return {
    client,
    pipes,
    nextRequest: async (): Promise<IpcRequestEnvelope> => {
      for (let i = 0; i < 100; i++) {
        const existing = requests.shift();
        if (existing !== undefined) return existing;
        await sleep(5);
      }
      throw new Error("no request arrived");
    },
    waitForPipe
  };
}

/**
 * Starts the handshake (so the client finishes connecting), then waits for the
 * request the client sends. This ordering matters: the client only sends its
 * request after the handshake is consumed.
 */
async function handshakeThenRequest(
  fixture: TestFixture,
  serverInstanceId = "server-1"
): Promise<IpcRequestEnvelope> {
  const pipe = await fixture.waitForPipe();
  sendHandshake(pipe, serverInstanceId);
  return fixture.nextRequest();
}

function sendHandshake(pipe: FakePipe, serverInstanceId = "server-1"): void {
  const handshake: IpcHandshakeEnvelope = {
    protocolVersion: IPC_PROTOCOL_VERSION,
    serverInstanceId
  };
  pipe.server.write(FrameCodec.encode(handshake));
}

function sendResponse(pipe: FakePipe, response: IpcResponseEnvelope): void {
  pipe.server.write(FrameCodec.encode(response));
}

function okResponse(requestId: string, data: unknown): IpcResponseEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    ok: true,
    data
  };
}

function failEnvelope(requestId: string, code: string, message: string): IpcResponseEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message }
  };
}

describe("IpcClientImpl", () => {
  it("performs a handshake before dispatching and returns the query response", async () => {
    const fixture = makeFixture();
    const query = fixture.client.query("storage.getSettings", {});
    const request = await handshakeThenRequest(fixture);
    expect(request.channel).toBe("query");
    expect(request.operation).toBe("storage.getSettings");
    expect(request.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
    expect(request.requestId).toBeTypeOf("string");

    sendResponse(fixture.pipes[0] as FakePipe, okResponse(request.requestId, { settings: {} }));
    const response = await query;
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe(request.requestId);
  });

  it("accepts the first handshake when no identity is expected and binds to it", async () => {
    const fixture = makeFixture();
    const query = fixture.client.query("storage.getSettings", {});
    const request = await handshakeThenRequest(fixture, "runner-instance-abc");
    sendResponse(fixture.pipes[0] as FakePipe, okResponse(request.requestId, { settings: {} }));
    await query;
    expect(fixture.client.serverInstanceId).toBe("runner-instance-abc");
    expect(fixture.client.isConnected).toBe(true);
  });

  it("rejects with PROTOCOL_VERSION_MISMATCH when the handshake version differs", async () => {
    const fixture = makeFixture();
    const query = fixture.client.query("storage.getSettings", {});
    const pipe = await fixture.waitForPipe();
    pipe.server.write(FrameCodec.encode({ protocolVersion: 999, serverInstanceId: "s" }));
    await expect(query).rejects.toBeInstanceOf(IpcProtocolVersionError);
  });

  it("rejects with SERVER_INSTANCE_CHANGED when the handshake identity differs", async () => {
    const fixture = makeFixture({ expectedServerInstanceId: "expected-instance" });
    const query = fixture.client.query("storage.getSettings", {});
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe, "different-instance");
    await expect(query).rejects.toBeInstanceOf(IpcServerInstanceChangedError);
    expect(fixture.client.serverInstanceId).toBeUndefined();
  });

  it("rejects with CONNECTION_LOST when the connection drops before the handshake", async () => {
    const fixture = makeFixture();
    const query = fixture.client.query("storage.getSettings", {});
    const pipe = await fixture.waitForPipe();
    pipe.server.destroy();
    await expect(query).rejects.toBeInstanceOf(IpcConnectionLostError);
  });

  it("rejects with REQUEST_TIMEOUT when no response arrives in time", async () => {
    const fixture = makeFixture({ requestTimeoutMs: 60 });
    const query = fixture.client.query("storage.getSettings", {});
    await handshakeThenRequest(fixture);
    await expect(query).rejects.toBeInstanceOf(IpcRequestTimeoutError);
  });

  it("honours the per-request timeout option when provided", async () => {
    const fixture = makeFixture();
    const query = fixture.client.query("storage.getSettings", {}, { requestTimeoutMs: 60 });
    await handshakeThenRequest(fixture);
    await expect(query).rejects.toBeInstanceOf(IpcRequestTimeoutError);
  });

  it("rejects in-flight requests with CONNECTION_LOST when the pipe drops", async () => {
    const fixture = makeFixture();
    const first = fixture.client.query("storage.getSettings", {});
    await handshakeThenRequest(fixture);
    const second = fixture.client.query("costData.get", {});
    await sleep(20);
    (fixture.pipes[0] as FakePipe).server.destroy();
    await expect(first).rejects.toBeInstanceOf(IpcConnectionLostError);
    await expect(second).rejects.toBeInstanceOf(IpcConnectionLostError);
  });

  it("reconnects on the next request after a drop", async () => {
    const fixture = makeFixture();
    // First request round trip.
    const first = fixture.client.query("storage.getSettings", {});
    const firstRequest = await handshakeThenRequest(fixture);
    sendResponse(fixture.pipes[0] as FakePipe, okResponse(firstRequest.requestId, {}));
    await first;

    // Drop the connection.
    (fixture.pipes[0] as FakePipe).server.destroy();
    await sleep(20);

    // Second request reconnects on a fresh pair.
    const second = fixture.client.query("costData.get", {});
    const secondRequest = await handshakeThenRequest(fixture);
    expect(fixture.pipes).toHaveLength(2);
    sendResponse(fixture.pipes[1] as FakePipe, okResponse(secondRequest.requestId, { costData: {} }));
    const response = await second;
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe(secondRequest.requestId);
  });

  it("retries a failing connect attempt and succeeds on the second", async () => {
    const pipes: FakePipe[] = [];
    let attempts = 0;
    const transport: IpcClientTransport = {
      connect(): Promise<Duplex> {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(new Error("first connect refused"));
        }
        const pair = createDuplexPipePair();
        const serverCodec = new FrameCodec();
        pair.server.pipe(serverCodec);
        pipes.push({ server: pair.server, serverCodec });
        return Promise.resolve(pair.client);
      }
    };
    const client = new IpcClientImpl({
      transport,
      maxConnectAttempts: 2,
      reconnectDelayMs: 5,
      requestTimeoutMs: 500
    });
    const query = client.query("storage.getSettings", {});

    // Wait for the second (successful) connection to be established, then send
    // the handshake BEFORE waiting for the request (the client only sends its
    // request after the handshake is consumed).
    for (let i = 0; i < 100 && pipes.length === 0; i++) {
      await sleep(5);
    }
    const pipe = pipes[0] as FakePipe;
    sendHandshake(pipe);
    const request = await new Promise<IpcRequestEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no request arrived")), 2000);
      const handler = (line: string): void => {
        const message = JSON.parse(line) as IpcMessage;
        if ("requestId" in message && message.requestId !== "") {
          clearTimeout(timer);
          pipe.serverCodec.off("data", handler);
          resolve(message as IpcRequestEnvelope);
        }
      };
      pipe.serverCodec.on("data", handler);
    });

    sendResponse(pipe, okResponse(request.requestId, {}));
    const response = await query;
    expect(response.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("fails with CONNECT_FAILED when all connect attempts are exhausted", async () => {
    let attempts = 0;
    const transport: IpcClientTransport = {
      connect(): Promise<Duplex> {
        attempts++;
        return Promise.reject(new Error(`refused (${attempts})`));
      }
    };
    const client = new IpcClientImpl({
      transport,
      maxConnectAttempts: 2,
      reconnectDelayMs: 5,
      requestTimeoutMs: 500
    });
    await expect(client.query("storage.getSettings", {})).rejects.toBeInstanceOf(IpcConnectError);
    expect(attempts).toBe(2);
  });

  it("clears the rejected connecting promise so a later request can connect successfully", async () => {
    let attempts = 0;
    const pipes: FakePipe[] = [];
    const transport: IpcClientTransport = {
      connect(): Promise<Duplex> {
        attempts++;
        if (attempts === 1) {
          // First logical connection fails (transport refuses).
          return Promise.reject(new Error("first connect refused"));
        }
        const pair = createDuplexPipePair();
        const serverCodec = new FrameCodec();
        pair.server.pipe(serverCodec);
        pipes.push({ server: pair.server, serverCodec });
        return Promise.resolve(pair.client);
      }
    };
    const client = new IpcClientImpl({
      transport,
      maxConnectAttempts: 1,
      reconnectDelayMs: 5,
      requestTimeoutMs: 500
    });

    // First request exhausts the single attempt and rejects.
    await expect(client.query("storage.getSettings", {})).rejects.toBeInstanceOf(IpcConnectError);
    expect(attempts).toBe(1);

    // REGRESSION: the rejected `connecting` promise must have been cleared, so
    // this second request performs a fresh transport call and succeeds.
    const query = client.query("costData.get", {});
    for (let i = 0; i < 100 && pipes.length === 0; i++) {
      await sleep(5);
    }
    expect(pipes).toHaveLength(1);
    const pipe = pipes[0] as FakePipe;
    sendHandshake(pipe);
    const request = await new Promise<IpcRequestEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no request arrived")), 2000);
      const handler = (line: string): void => {
        const message = JSON.parse(line) as IpcMessage;
        if ("requestId" in message && message.requestId !== "") {
          clearTimeout(timer);
          pipe.serverCodec.off("data", handler);
          resolve(message as IpcRequestEnvelope);
        }
      };
      pipe.serverCodec.on("data", handler);
    });
    sendResponse(pipe, okResponse(request.requestId, {}));
    const response = await query;
    expect(response.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("sends commands on the command channel with the operation discriminator", async () => {
    const fixture = makeFixture();
    const commandPromise = fixture.client.command({
      command: "storage.updateSettings",
      settings: {
        dataRoot: "C:\\data",
        workspaceRoot: "C:\\data\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    });
    const request = await handshakeThenRequest(fixture);
    expect(request.channel).toBe("command");
    expect(request.operation).toBe("storage.updateSettings");
    expect((request.payload as { command: string }).command).toBe("storage.updateSettings");

    sendResponse(fixture.pipes[0] as FakePipe, okResponse(request.requestId, { settings: {} }));
    await commandPromise;
  });

  it("carries the idempotency key on commands when provided", async () => {
    const fixture = makeFixture();
    const commandPromise = fixture.client.command(
      { command: "storage.updateSettings", settings: { dataRoot: "C:\\d" } as never },
      { idempotencyKey: "idem-1" }
    );
    const request = await handshakeThenRequest(fixture);
    expect(request.idempotencyKey).toBe("idem-1");
    void commandPromise.catch(() => {});
    fixture.client.close();
  });

  it("rejects with INVALID_RESPONSE when the response envelope is malformed", async () => {
    const fixture = makeFixture();
    const query = fixture.client.query("storage.getSettings", {});
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const request = await fixture.nextRequest();
    void request;
    pipe.server.write(
      FrameCodec.encode({ protocolVersion: IPC_PROTOCOL_VERSION, bogus: true })
    );
    await expect(query).rejects.toBeInstanceOf(IpcInvalidResponseError);
  });

  it("ignores responses whose request id is unknown and resolves the matching one", async () => {
    const fixture = makeFixture();
    const query = fixture.client.query("storage.getSettings", {});
    const request = await handshakeThenRequest(fixture);
    const pipe = fixture.pipes[0] as FakePipe;
    // A response with an unknown request id is dropped.
    sendResponse(pipe, okResponse("unknown-request", {}));
    await sleep(20);
    // The matching response resolves the pending query.
    sendResponse(pipe, okResponse(request.requestId, { settings: {} }));
    const response = await query;
    expect(response.requestId).toBe(request.requestId);
    expect(response.ok).toBe(true);
  });

  it("rejects requests made after close with CLIENT_CLOSED", async () => {
    const fixture = makeFixture();
    fixture.client.close();
    await expect(fixture.client.query("storage.getSettings", {})).rejects.toBeInstanceOf(
      IpcClientClosedError
    );
  });

  it("rejects outstanding requests when close() is called mid-flight", async () => {
    const fixture = makeFixture();
    const query = fixture.client.query("storage.getSettings", {});
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    await fixture.nextRequest();
    fixture.client.close();
    await expect(query).rejects.toBeInstanceOf(IpcClientClosedError);
  });

  it("establishes an empty-backlog subscription and delivers only live batches", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    const errors: RunEventStreamError[] = [];
    const unsubscribe = fixture.client.subscribeRunEvents("run-1", {
      onRunEvents: (batch) => batches.push(batch),
      onRunEventsError: (error) => errors.push(error)
    });
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    // Snapshot read first (race-free snapshot-then-subscribe).
    const snapshotRequest = await fixture.nextRequest();
    expect(snapshotRequest.operation).toBe("run.getDetail");
    sendResponse(pipe, okResponse(snapshotRequest.requestId, { lastEventSequence: 0 }));
    // Then the subscribe request after the last known sequence.
    const subscribeRequest = await fixture.nextRequest();
    expect(subscribeRequest.channel).toBe("subscribe");
    expect(subscribeRequest.operation).toBe("run.subscribe");
    expect(subscribeRequest.payload).toEqual({ runId: "run-1", fromSequence: 1 });
    // An EMPTY backlog establishes the stream without delivering a batch...
    sendResponse(pipe, okResponse(subscribeRequest.requestId, { runId: "run-1", fromSequence: 1, events: [] }));
    await waitFor(() => fixture.client.isConnected, "subscription established");
    expect(batches).toEqual([]);
    expect(errors).toEqual([]);
    expect(typeof unsubscribe).toBe("function");
    // ... and live batches then flow normally.
    pipe.server.write(FrameCodec.encode(eventEnvelope("run-1", [runEvent(1)])));
    await waitFor(() => batches.length === 1, "first live batch");
    expect(batches[0]?.events.map((event) => event.sequence)).toEqual([1]);
  });

  it("subscribes from an explicit fromSequence without a snapshot query", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: (batch) => batches.push(batch),
        onRunEventsError: () => {}
      },
      { fromSequence: 4 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    expect(subscribeRequest.operation).toBe("run.subscribe");
    expect(subscribeRequest.payload).toEqual({ runId: "run-1", fromSequence: 4 });
    sendResponse(pipe, okResponse(subscribeRequest.requestId, {
      runId: "run-1",
      fromSequence: 4,
      events: [runEvent(4), runEvent(5)]
    }));
    await waitFor(() => batches.length === 1, "backlog");
    expect(batches[0]?.events.map((event) => event.sequence)).toEqual([4, 5]);
  });

  it("delivers the persisted backlog then live batches in sequence order", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: (batch) => batches.push(batch),
        onRunEventsError: () => {}
      },
      { fromSequence: 4 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, {
      runId: "run-1",
      fromSequence: 4,
      events: [runEvent(4)]
    }));
    await waitFor(() => batches.length === 1, "backlog");

    pipe.server.write(FrameCodec.encode(eventEnvelope("run-1", [runEvent(5), runEvent(6)])));
    await waitFor(() => batches.length === 2, "live batch");
    expect(batches[1]?.events.map((event) => event.sequence)).toEqual([5, 6]);
    expect(batches[1]?.fromSequence).toBe(5);
  });

  it("ignores duplicate sequences and applies only the unseen tail", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: (batch) => batches.push(batch),
        onRunEventsError: () => {}
      },
      { fromSequence: 4 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, {
      runId: "run-1",
      fromSequence: 4,
      events: [runEvent(4), runEvent(5)]
    }));
    await waitFor(() => batches.length === 1, "backlog");

    // A live batch re-delivering 5 (already applied) plus the new 6: only 6 is
    // applied — duplicates are ignored, never re-applied.
    pipe.server.write(FrameCodec.encode(eventEnvelope("run-1", [runEvent(5), runEvent(6)])));
    await waitFor(() => batches.length === 2, "deduped batch");
    expect(batches[1]?.events.map((event) => event.sequence)).toEqual([6]);
    expect(batches[1]?.fromSequence).toBe(6);
  });

  it("fails the subscription with RUN_EVENT_GAP instead of silently applying", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    const errors: RunEventStreamError[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: (batch) => batches.push(batch),
        onRunEventsError: (error) => errors.push(error)
      },
      { fromSequence: 4 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, {
      runId: "run-1",
      fromSequence: 4,
      events: [runEvent(4)]
    }));
    await waitFor(() => batches.length === 1, "backlog");

    // Sequence 5 is skipped: 6 is a gap and must NOT be applied.
    pipe.server.write(FrameCodec.encode(eventEnvelope("run-1", [runEvent(6)])));
    await waitFor(() => errors.length === 1, "gap error");
    expect(errors[0]?.code).toBe("RUN_EVENT_GAP");
    expect(errors[0]?.runId).toBe("run-1");
    expect(errors[0]?.message).toContain("5");
    expect(batches).toHaveLength(1);

    // The subscription is dead: a later (now contiguous) batch is ignored.
    pipe.server.write(FrameCodec.encode(eventEnvelope("run-1", [runEvent(7)])));
    await sleep(30);
    expect(batches).toHaveLength(1);
  });

  it("fails the subscription with RUN_EVENT_INVALID on a non-monotonic batch", async () => {
    const fixture = makeFixture();
    const errors: RunEventStreamError[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: () => {},
        onRunEventsError: (error) => errors.push(error)
      },
      { fromSequence: 1 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, { runId: "run-1", fromSequence: 1, events: [] }));
    await waitFor(() => fixture.client.isConnected, "connected");

    // A duplicate within one batch violates strict monotonicity: INVALID.
    pipe.server.write(FrameCodec.encode(eventEnvelope("run-1", [runEvent(1), runEvent(1)])));
    await waitFor(() => errors.length === 1, "invalid error");
    expect(errors[0]?.code).toBe("RUN_EVENT_INVALID");
  });

  it("fails subscriptions with STREAM_LOST when the connection drops and never re-applies", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    const errors: RunEventStreamError[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: (batch) => batches.push(batch),
        onRunEventsError: (error) => errors.push(error)
      },
      { fromSequence: 1 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, { runId: "run-1", fromSequence: 1, events: [] }));
    await waitFor(() => fixture.client.isConnected, "connected");

    pipe.server.destroy();
    await waitFor(() => errors.length === 1, "stream lost error");
    expect(errors[0]?.code).toBe("RUN_EVENT_STREAM_LOST");
    expect(batches).toEqual([]);
  });

  it("ends subscriptions with STREAM_CLOSED on client close", async () => {
    const fixture = makeFixture();
    const errors: RunEventStreamError[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: () => {},
        onRunEventsError: (error) => errors.push(error)
      },
      { fromSequence: 1 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, { runId: "run-1", fromSequence: 1, events: [] }));
    await waitFor(() => fixture.client.isConnected, "connected");
    fixture.client.close();
    await waitFor(() => errors.length === 1, "closed error");
    expect(errors[0]?.code).toBe("RUN_EVENT_STREAM_CLOSED");
  });

  it("unsubscribe stops delivery and ignores later envelopes", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    const unsubscribe = fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: (batch) => batches.push(batch),
        onRunEventsError: () => {}
      },
      { fromSequence: 1 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, { runId: "run-1", fromSequence: 1, events: [runEvent(1)] }));
    await waitFor(() => batches.length === 1, "backlog");

    unsubscribe();
    pipe.server.write(FrameCodec.encode(eventEnvelope("run-1", [runEvent(2)])));
    await sleep(30);
    expect(batches).toHaveLength(1);
  });

  it("fails the subscription when the snapshot read is rejected", async () => {
    const fixture = makeFixture();
    const errors: RunEventStreamError[] = [];
    fixture.client.subscribeRunEvents("run-1", {
      onRunEvents: () => {},
      onRunEventsError: (error) => errors.push(error)
    });
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const snapshotRequest = await fixture.nextRequest();
    sendResponse(pipe, failEnvelope(snapshotRequest.requestId, "NOT_FOUND", "Run run-1 was not found"));
    await waitFor(() => errors.length === 1, "snapshot error");
    expect(errors[0]?.code).toBe("RUN_EVENT_INVALID");
    expect(errors[0]?.message).toContain("NOT_FOUND");
  });

  it("fails the connection on a malformed runEvents frame (never applies it)", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    const errors: RunEventStreamError[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: (batch) => batches.push(batch),
        onRunEventsError: (error) => errors.push(error)
      },
      { fromSequence: 1 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, { runId: "run-1", fromSequence: 1, events: [] }));
    await waitFor(() => fixture.client.isConnected, "connected");

    // Wrong protocol version on the event frame: connection-level failure.
    pipe.server.write(
      FrameCodec.encode({ ...eventEnvelope("run-1", [runEvent(2)]), protocolVersion: 999 })
    );
    await waitFor(() => errors.length === 1, "invalid frame error");
    expect(errors[0]?.code).toBe("RUN_EVENT_STREAM_LOST");
    expect(batches).toEqual([]);
  });

  it("ignores runEvents frames for runs it never subscribed to", async () => {
    const fixture = makeFixture();
    const batches: RunEventCursor[] = [];
    fixture.client.subscribeRunEvents(
      "run-1",
      {
        onRunEvents: (batch) => batches.push(batch),
        onRunEventsError: () => {}
      },
      { fromSequence: 1 }
    );
    const pipe = await fixture.waitForPipe();
    sendHandshake(pipe);
    const subscribeRequest = await fixture.nextRequest();
    sendResponse(pipe, okResponse(subscribeRequest.requestId, { runId: "run-1", fromSequence: 1, events: [] }));
    await waitFor(() => fixture.client.isConnected, "connected");

    pipe.server.write(
      FrameCodec.encode(eventEnvelope("other-run", [runEvent(1, "StageChanged", "other-run")]))
    );
    await sleep(30);
    expect(batches).toEqual([]);
    expect(fixture.client.isConnected).toBe(true);
  });

  it("surfaces stable structured error codes", () => {
    expect(new IpcClientClosedError().code).toBe("CLIENT_CLOSED");
    expect(new IpcConnectError("boom").code).toBe("CONNECT_FAILED");
    expect(new IpcProtocolVersionError("boom").code).toBe("PROTOCOL_VERSION_MISMATCH");
    expect(new IpcRequestTimeoutError("r", 5).code).toBe("REQUEST_TIMEOUT");
    expect(new IpcConnectionLostError("boom").code).toBe("CONNECTION_LOST");
    expect(new IpcInvalidResponseError("boom").code).toBe("INVALID_RESPONSE");
    const instanceChanged = new IpcServerInstanceChangedError("a", "b");
    expect(instanceChanged.code).toBe("SERVER_INSTANCE_CHANGED");
    expect(instanceChanged.message).toContain("a");
    expect(instanceChanged.message).toContain("b");
    expect(new IpcClientError("CLIENT_CLOSED", "x").name).toBe("IpcClientError");
  });
});
