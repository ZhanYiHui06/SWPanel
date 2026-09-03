import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { IPC_PROTOCOL_VERSION } from "@swpanel/contracts";
import type { IpcMessage, IpcRequestEnvelope, IpcResponseEnvelope, RunEventSubscriber } from "@swpanel/contracts";
import type { RunEvent } from "@swpanel/domain";

import { makeTempDir, removeTempDir } from "../test-utils.js";
import { writePipeDaclEvidence } from "./acl.js";
import { FrameCodec } from "./frame-codec.js";
import type { IpcRequestHandler } from "./request-handler.js";
import { IpcServer, type IpcEventStream } from "./server.js";

class StubHandler implements IpcRequestHandler {
  handle(request: IpcRequestEnvelope): Promise<IpcResponseEnvelope> {
    return Promise.resolve({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      data: { operation: request.operation }
    });
  }
}

/** Deterministic persisted RunEvent for the live subscription exchange. */
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

/** Scriptable after-commit event stream (mirrors the Runner's commit hook). */
class FakeEventStream implements IpcEventStream {
  subscriber: RunEventSubscriber | null = null;
  unsubscribed = 0;

  subscribeRunEvents(_runId: string, subscriber: RunEventSubscriber): () => void {
    this.subscriber = subscriber;
    return () => {
      this.unsubscribed += 1;
      this.subscriber = null;
    };
  }

  listRunEventsFrom(_runId: string, fromSequence: number): readonly RunEvent[] {
    if (_runId !== "run-live") {
      throw Object.assign(new Error(`Run ${_runId} was not found`), { code: "NOT_FOUND" });
    }
    return [runEvent(_runId, 1), runEvent(_runId, 2)].filter((event) => event.sequence >= fromSequence);
  }

  push(runId: string, events: readonly RunEvent[]): void {
    const first = events[0];
    this.subscriber?.onRunEvents({
      runId,
      fromSequence: first === undefined ? 0 : first.sequence,
      events
    });
  }
}

/**
 * Connects to a live named pipe with a raw `net.Socket`, consumes the
 * handshake, sends one query and resolves with both frames. Used to prove the
 * server speaks the real wire protocol to an unassisted peer (no in-process
 * duplex pair involved).
 */
function connectAndExchange(
  pipePath: string
): Promise<{ handshake: { protocolVersion: number; serverInstanceId: string }; response: IpcResponseEnvelope }> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    socket.setNoDelay(true);
    const codec = new FrameCodec();
    socket.pipe(codec);
    const messages: unknown[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("live named-pipe exchange timed out"));
    }, 10_000);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    codec.on("data", (line: string) => {
      messages.push(JSON.parse(line));
      if (messages.length === 2) {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          handshake: messages[0] as { protocolVersion: number; serverInstanceId: string },
          response: messages[1] as IpcResponseEnvelope
        });
      }
    });
    socket.on("connect", () => {
      const query: IpcRequestEnvelope = {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "live-1",
        channel: "query",
        operation: "storage.getSettings",
        payload: {}
      };
      socket.write(FrameCodec.encode(query));
    });
  });
}

/**
 * LIVE Windows named-pipe integration test. Runs only on win32; on every other
 * platform the suite is skipped (there is no named pipe to test).
 *
 * CROSS-USER LIMIT: this host has a single interactive account, so a true
 * second-user deny test cannot be executed here. What CAN be proven is the
 * actual pipe DACL: it is read back from the OS (raw evidence, written to a
 * file) and strictly verified to contain exactly {current user SID, SYSTEM}
 * with no broad SIDs. That is the security boundary — pipe-name obscurity is
 * not relied on. A real second-account deny test is a precisely documented
 * manual test (run SWPanel as account A, attempt to read the pipe as account
 * B): the DACL evidence must show only A and SYSTEM.
 */
describe.skipIf(process.platform !== "win32")(
  "IpcServer live Windows named pipe",
  () => {
    it("starts on a real pipe, strictly enforces the DACL, writes raw evidence, and answers a live query", async () => {
      const root = makeTempDir("live-pipe");
      const server = new IpcServer(new StubHandler(), {
        pipePath: `\\\\.\\pipe\\swpanel.test.live.${randomUUID()}`
      });
      try {
        const start = await server.start();
        expect(start.pipePath).toMatch(/^\\\\\.\\pipe\\swpanel\.test\.live\./);
        expect(start.acl).not.toBeNull();

        // Strict enforcement: status must be APPLIED and the read-back ACE list
        // must contain exactly {current user SID, SYSTEM} — no Everyone, no
        // ANONYMOUS LOGON, no other broad SID.
        const acl = start.acl;
        expect(acl?.status).toBe("WINDOWS_ACL_APPLIED");
        expect(acl?.ownerSid).toBeTypeOf("string");
        const sids = (acl?.aces ?? []).map((ace) => ace.sid).sort();
        expect(sids).toHaveLength(2);
        expect(sids).toContain("S-1-5-18"); // SYSTEM
        expect(sids).toContain(acl?.ownerSid);

        // Raw evidence file: the read-only capture must agree with the applied
        // DACL byte for byte on the ACE list.
        const evidenceFile = join(root, "pipe-dacl-evidence.json");
        const evidence = await writePipeDaclEvidence(server.pipePath, evidenceFile);
        expect(existsSync(evidenceFile)).toBe(true);
        expect(evidence.aces).toHaveLength(2);
        expect(evidence.ownerSid).toBe(acl?.ownerSid);
        expect(evidence.systemSid).toBe("S-1-5-18");
        const onDisk = JSON.parse(readFileSync(evidenceFile, "utf8")) as {
          aces: readonly { sid: string; mask: number }[];
        };
        expect(onDisk.aces).toEqual(evidence.aces);

        // Live wire exchange with a raw net.Socket: handshake then response.
        const { handshake, response } = await connectAndExchange(server.pipePath);
        expect(handshake).toEqual({
          protocolVersion: IPC_PROTOCOL_VERSION,
          serverInstanceId: server.serverInstanceId
        });
        expect(response.requestId).toBe("live-1");
        expect(response.ok).toBe(true);
        expect(response.data).toEqual({ operation: "storage.getSettings" });

        // The ACL probe connection (opens the pipe and closes without writing)
        // is tolerated as a no-op and does not tear down the server.
        await new Promise<void>((resolve, reject) => {
          const probe = connect(server.pipePath);
          probe.on("error", reject);
          probe.on("connect", () => {
            probe.destroy();
            resolve();
          });
        });
      } finally {
        await server.close();
        removeTempDir(root);
      }
    });

    it("serves a real run.subscribe exchange over the pipe: backlog response then live pushes, cleanup on disconnect", async () => {
      const root = makeTempDir("live-pipe-sub");
      const stream = new FakeEventStream();
      const server = new IpcServer(new StubHandler(), {
        pipePath: `\\\\.\\pipe\\swpanel.test.live.sub.${randomUUID()}`,
        eventStream: stream
      });
      try {
        await server.start();

        // Raw-socket client: handshake, then a run.subscribe request.
        const messages: IpcMessage[] = [];
        const done = new Promise<void>((resolve, reject) => {
          const socket = connect(server.pipePath);
          socket.setNoDelay(true);
          const codec = new FrameCodec();
          socket.pipe(codec);
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("live subscribe exchange timed out"));
          }, 10_000);
          socket.on("error", reject);
          codec.on("data", (line: string) => {
            messages.push(JSON.parse(line) as IpcMessage);
            if (messages.length === 2) {
              clearTimeout(timer);
              // After the backlog response, push one live batch (as the
              // Runner's after-commit hook would) and then close.
              stream.push("run-live", [runEvent("run-live", 3)]);
              setTimeout(() => {
                socket.destroy();
                resolve();
              }, 50);
            }
          });
          socket.on("connect", () => {
            socket.write(
              FrameCodec.encode({
                protocolVersion: IPC_PROTOCOL_VERSION,
                requestId: "live-sub-1",
                channel: "subscribe",
                operation: "run.subscribe",
                payload: { runId: "run-live", fromSequence: 2 }
              } satisfies IpcRequestEnvelope)
            );
          });
        });
        await done;

        const response = messages[1] as IpcResponseEnvelope;
        expect(response.ok).toBe(true);
        expect(response.data).toEqual({
          runId: "run-live",
          fromSequence: 2,
          events: [runEvent("run-live", 2)]
        });

        // The live push after the subscribe response.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        const pushed = messages[2];
        expect(pushed).toEqual({
          protocolVersion: IPC_PROTOCOL_VERSION,
          kind: "runEvents",
          runId: "run-live",
          fromSequence: 3,
          events: [runEvent("run-live", 3)]
        });

        // Disconnect cleanup: the raw client closed; the shared event-stream
        // subscription must be released.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(stream.unsubscribed).toBe(1);
      } finally {
        await server.close();
        removeTempDir(root);
      }
    });
  }
);
