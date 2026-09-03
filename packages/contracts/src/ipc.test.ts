import { describe, expect, it } from "vitest";

import {
  IPC_PROTOCOL_VERSION,
  QUERY_NAMES,
  type IpcRequestEnvelope,
  type QueryRequest
} from "./ipc.js";

describe("ipc contract", () => {
  it("pins the protocol version", () => {
    expect(IPC_PROTOCOL_VERSION).toBe(1);
  });

  it("defines the allowlisted query names", () => {
    expect(QUERY_NAMES).toEqual([
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
    ]);
  });

  it("exposes typed payloads for the drawing/history/storage queries", () => {
    const historyRequest: QueryRequest = {
      name: "drawing.getHistory",
      payload: { drawingId: "drawing-1" }
    };
    expect(historyRequest.payload).toEqual({ drawingId: "drawing-1" });
    const revisionHistoryRequest: QueryRequest = {
      name: "revision.getHistory",
      payload: { drawingId: "drawing-1", revisionId: "rev-1" }
    };
    expect(revisionHistoryRequest.payload).toEqual({ drawingId: "drawing-1", revisionId: "rev-1" });
    const storageRequest: QueryRequest = { name: "storage.getSettings", payload: {} };
    expect(storageRequest.payload).toEqual({});
  });

  it("carries request id and idempotency key on mutation envelopes", () => {
    const envelope: IpcRequestEnvelope = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      idempotencyKey: "idem-1",
      channel: "command",
      operation: "run.cancel",
      payload: { runId: "run-1", reason: "user request" }
    };
    expect(envelope.protocolVersion).toBe(1);
    expect(envelope.channel).toBe("command");
    expect(envelope.operation).toBe("run.cancel");
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it("carries the drawing.create command on the command channel", () => {
    const envelope: IpcRequestEnvelope = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-2",
      channel: "command",
      operation: "drawing.create",
      payload: {
        drawingNumber: "PDJF999.01.01",
        name: "测试图纸",
        sourceFile: {
          fileName: "PDJF999.01.01.pdf",
          format: "PDF",
          sizeBytes: 2_048_000,
          sha256: "c".repeat(64)
        },
        createdAt: "2026-08-12T10:00:00.000Z"
      }
    };
    expect(envelope.operation).toBe("drawing.create");
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });
});
