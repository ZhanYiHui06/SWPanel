import { describe, expect, it } from "vitest";

import {
  IPC_PROTOCOL_VERSION,
  IpcValidationError,
  type IpcRequestEnvelope,
  isIpcRequestEnvelope,
  validateIpcEventEnvelope,
  validateIpcHandshakeEnvelope,
  validateIpcRequestEnvelope,
  validateIpcResponseEnvelope
} from "./index.js";

function validQueryRequest(): IpcRequestEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: "req-1",
    channel: "query",
    operation: "drawing.getHistory",
    payload: { drawingId: "drawing-1" }
  };
}

// --- Phase 7 Cost Data fixtures -------------------------------------------------

/** Realistic valid company-global Cost Data snapshot used to build payloads. */
function validCostDataSnapshot(withUpdatedAt = false): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    materials: [
      {
        id: "material-42crmo",
        name: "42CrMo",
        purchasePrice: 5200,
        priceUnit: "元/吨",
        density: 7.85,
        densityUnit: "g/cm³",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-10T08:00:00.000Z"
      }
    ],
    allowances: [
      {
        id: "allowance-cylinder",
        stockType: "CYLINDER",
        allowances: [
          { name: "直径方向默认余量", valueMm: 20 },
          { name: "长度方向默认余量", valueMm: 20 }
        ],
        updatedAt: "2026-08-10T08:00:00.000Z"
      }
    ],
    fixedCosts: [
      {
        id: "fixed-processing",
        name: "基础加工成本",
        amount: 500,
        currency: "CNY",
        basis: "PER_PIECE",
        defaultEnabled: true,
        updatedAt: "2026-08-10T08:00:00.000Z"
      }
    ],
    customFields: [
      {
        id: "custom-note",
        key: "custom.note",
        name: "备注",
        value: "测试环境占位数据，不代表真实企业成本。",
        semantics: "DISPLAY_ONLY",
        updatedAt: "2026-08-10T08:00:00.000Z"
      }
    ],
    capturedAt: "2026-08-10T08:00:00.000Z"
  };
  if (withUpdatedAt) {
    snapshot.updatedAt = "2026-08-10T08:00:00.000Z";
  }
  return snapshot;
}

/** Realistic valid `costReport.create` input snapshot. */
function validCostReportInput(): Record<string, unknown> {
  return {
    drawingId: "drawing-1",
    revisionId: "rev-1",
    modelId: "model-1",
    quantity: 10,
    materialId: "material-42crmo",
    stockType: "CYLINDER",
    stockSpec: "Ø320 × 820 mm",
    finishedVolume: 0.05,
    allowances: [
      { name: "直径方向默认余量", valueMm: 20 },
      { name: "长度方向默认余量", valueMm: 20 }
    ],
    costData: validCostDataSnapshot(false),
    formulaVersion: "cost-engine@1.0.0",
    capturedAt: "2026-08-10T09:00:00.000Z"
  };
}

function costDataUpdateEnvelope(payload: Record<string, unknown>): IpcRequestEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: "req-cost-data-update",
    channel: "command",
    operation: "costData.update",
    payload: {
      command: "costData.update",
      snapshot: validCostDataSnapshot(true),
      ...payload
    }
  };
}

function costReportCreateEnvelope(payload: Record<string, unknown>): IpcRequestEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: "req-cost-report-create",
    channel: "command",
    operation: "costReport.create",
    payload: {
      command: "costReport.create",
      input: validCostReportInput(),
      createdAt: "2026-08-10T09:05:00.000Z",
      ...payload
    }
  };
}

describe("ipc envelope validation", () => {
  it("accepts a well-formed query request", () => {
    const validated = validateIpcRequestEnvelope(validQueryRequest());
    expect(validated).toEqual(validQueryRequest());
    expect(isIpcRequestEnvelope(validQueryRequest())).toBe(true);
  });

  it("rejects a mismatched protocol version", () => {
    const request = { ...validQueryRequest(), protocolVersion: 999 };
    expect(() => validateIpcRequestEnvelope(request)).toThrowError(IpcValidationError);
    try {
      validateIpcRequestEnvelope(request);
    } catch (error) {
      expect((error as IpcValidationError).code).toBe("PROTOCOL_VERSION_MISMATCH");
    }
  });

  it("rejects a missing request id", () => {
    const request = { ...validQueryRequest(), requestId: undefined };
    expect(() => validateIpcRequestEnvelope(request)).toThrowError(
      expect.objectContaining({ code: "MISSING_REQUEST_ID" })
    );
  });

  it("rejects an invalid channel", () => {
    const request = { ...validQueryRequest(), channel: "event" };
    expect(() => validateIpcRequestEnvelope(request)).toThrowError(
      expect.objectContaining({ code: "INVALID_CHANNEL" })
    );
  });

  it("rejects an unknown operation", () => {
    const request = { ...validQueryRequest(), operation: "drawing.destroy" };
    expect(() => validateIpcRequestEnvelope(request)).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_OPERATION" })
    );
  });

  it("rejects a query operation on the command channel and vice versa", () => {
    const queryAsCommand = { ...validQueryRequest(), channel: "command" };
    expect(() => validateIpcRequestEnvelope(queryAsCommand)).toThrowError(
      expect.objectContaining({ code: "CHANNEL_OPERATION_MISMATCH" })
    );
    const commandAsQuery: IpcRequestEnvelope = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-2",
      channel: "query",
      operation: "drawing.create",
      payload: { command: "drawing.create" }
    };
    expect(() => validateIpcRequestEnvelope(commandAsQuery)).toThrowError(
      expect.objectContaining({ code: "CHANNEL_OPERATION_MISMATCH" })
    );
  });

  it("rejects a malformed payload for an allowlisted operation", () => {
    const request = { ...validQueryRequest(), payload: { drawingId: 42 } };
    expect(() => validateIpcRequestEnvelope(request)).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" })
    );
    const emptyPayload = { ...validQueryRequest(), operation: "workspace.getDashboard", payload: { x: 1 } };
    expect(() => validateIpcRequestEnvelope(emptyPayload)).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" })
    );
  });

  it("rejects a command payload whose discriminator does not match the operation", () => {
    const request: IpcRequestEnvelope = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-3",
      channel: "command",
      operation: "drawing.create",
      payload: { command: "run.create" }
    };
    expect(() => validateIpcRequestEnvelope(request)).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" })
    );
  });

  it("accepts a well-formed drawing.create command payload", () => {
    const request: IpcRequestEnvelope = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-4",
      idempotencyKey: "idem-1",
      channel: "command",
      operation: "drawing.create",
      payload: {
        command: "drawing.create",
        drawingNumber: "PDJF001.01",
        name: "轧辊",
        sourceFile: {
          fileName: "PDJF001.01.pdf",
          format: "PDF",
          sizeBytes: 2048,
          sha256: "c".repeat(64)
        },
        createdAt: "2026-08-12T10:00:00.000Z"
      }
    };
    expect(validateIpcRequestEnvelope(request)).toEqual(request);
  });

  it("rejects unknown keys on a command payload", () => {
    const base = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "command",
      operation: "drawing.setCurrentRevision",
      payload: {
        command: "drawing.setCurrentRevision",
        drawingId: "d1",
        revisionId: "r1",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    };
    expect(() => validateIpcRequestEnvelope(base)).not.toThrow();
    expect(() =>
      validateIpcRequestEnvelope({
        ...base,
        payload: { ...base.payload, malicious: true }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
  });

  it("rejects unknown keys on the request envelope itself", () => {
    expect(() =>
      validateIpcRequestEnvelope({
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        channel: "query",
        operation: "storage.getSettings",
        payload: {},
        extraEnvelopeField: true
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
  });

  it("accepts a well-formed drawing.deleteRevision command payload", () => {
    const request = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "command",
      operation: "drawing.deleteRevision",
      payload: {
        command: "drawing.deleteRevision",
        drawingId: "d1",
        revisionId: "r2",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    };
    expect(validateIpcRequestEnvelope(request).operation).toBe("drawing.deleteRevision");
    expect(() =>
      validateIpcRequestEnvelope({
        ...request,
        payload: { ...request.payload, updatedAt: "" }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
  });

  it("accepts a run.create payload carrying only the drawing/revision pair", () => {
    const request = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "command",
      operation: "run.create",
      payload: {
        command: "run.create",
        drawingId: "drawing-1",
        revisionId: "rev-1"
      }
    };
    expect(validateIpcRequestEnvelope(request).operation).toBe("run.create");
    expect(() =>
      validateIpcRequestEnvelope({
        ...request,
        payload: { ...request.payload, drawingId: "" }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
    expect(() =>
      validateIpcRequestEnvelope({
        ...request,
        payload: { ...request.payload, revisionId: 42 }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
  });

  it("rejects a run.create payload that tries to smuggle an input snapshot", () => {
    const request = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "command",
      operation: "run.create",
      payload: {
        command: "run.create",
        drawingId: "drawing-1",
        revisionId: "rev-1",
        inputSnapshot: { drawingId: "drawing-1", revisionId: "rev-1" }
      }
    };
    expect(() => validateIpcRequestEnvelope(request)).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" })
    );
  });

  it("accepts a run.cancel payload with an optional non-empty reason", () => {
    const base = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "command",
      operation: "run.cancel",
      payload: {
        command: "run.cancel",
        runId: "run-1"
      }
    };
    expect(validateIpcRequestEnvelope(base).operation).toBe("run.cancel");
    const withReason = {
      ...base,
      payload: { ...base.payload, reason: "用户主动取消" }
    };
    expect(validateIpcRequestEnvelope(withReason)).toEqual(withReason);
  });

  it("rejects a malformed run.cancel payload", () => {
    const base = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "command",
      operation: "run.cancel",
      payload: {
        command: "run.cancel",
        runId: "run-1"
      }
    };
    expect(() =>
      validateIpcRequestEnvelope({
        ...base,
        payload: { ...base.payload, runId: "" }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
    expect(() =>
      validateIpcRequestEnvelope({
        ...base,
        payload: { ...base.payload, reason: "" }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
    expect(() =>
      validateIpcRequestEnvelope({
        ...base,
        payload: { ...base.payload, force: true }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
  });

  it("rejects unknown keys on a nested sourceFile object", () => {
    const sourceFile = {
      fileName: "x.pdf",
      format: "PDF",
      sizeBytes: 10,
      sha256: "a".repeat(64)
    };
    expect(() =>
      validateIpcRequestEnvelope({
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        channel: "command",
        operation: "drawing.create",
        payload: {
          command: "drawing.create",
          drawingNumber: "X",
          name: "x",
          sourceFile: { ...sourceFile, absolutePath: "C:/secret" },
          createdAt: "2026-08-12T00:00:00.000Z"
        }
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_PAYLOAD" }) as object);
  });

  it("rejects a non-string idempotency key", () => {
    const request = { ...validQueryRequest(), idempotencyKey: 7 } as never;
    expect(() => validateIpcRequestEnvelope(request)).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" })
    );
  });

  it("validates the handshake envelope", () => {
    expect(validateIpcHandshakeEnvelope({ protocolVersion: IPC_PROTOCOL_VERSION, serverInstanceId: "abc" }))
      .toEqual({ protocolVersion: IPC_PROTOCOL_VERSION, serverInstanceId: "abc" });
    expect(() =>
      validateIpcHandshakeEnvelope({ protocolVersion: 42, serverInstanceId: "abc" })
    ).toThrowError(expect.objectContaining({ code: "PROTOCOL_VERSION_MISMATCH" }));
    expect(() => validateIpcHandshakeEnvelope({ protocolVersion: IPC_PROTOCOL_VERSION })).toThrowError(
      IpcValidationError
    );
  });

  it("validates the response envelope", () => {
    const ok = validateIpcResponseEnvelope({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      ok: true,
      data: { anything: 1 }
    });
    expect(ok.ok).toBe(true);
    const failed = validateIpcResponseEnvelope({
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      ok: false,
      error: { code: "NOT_FOUND", message: "Drawing x was not found" }
    });
    expect(failed.error?.code).toBe("NOT_FOUND");
    expect(() =>
      validateIpcResponseEnvelope({
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        ok: false
      })
    ).toThrowError(IpcValidationError);
  });

  it("accepts a well-formed run.subscribe request on the subscribe channel", () => {
    const request = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 4 }
    };
    const validated = validateIpcRequestEnvelope(request);
    expect(validated.channel).toBe("subscribe");
    expect(validated.operation).toBe("run.subscribe");
    expect(isIpcRequestEnvelope(request)).toBe(true);
  });

  it("rejects run.subscribe on the query/command channels and vice versa", () => {
    const subscribe = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "query",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 0 }
    };
    expect(() => validateIpcRequestEnvelope(subscribe)).toThrowError(
      expect.objectContaining({ code: "CHANNEL_OPERATION_MISMATCH" })
    );
    expect(() =>
      validateIpcRequestEnvelope({ ...subscribe, channel: "command" })
    ).toThrowError(expect.objectContaining({ code: "CHANNEL_OPERATION_MISMATCH" }));
    expect(() =>
      validateIpcRequestEnvelope({
        ...subscribe,
        channel: "subscribe",
        operation: "run.getDetail"
      })
    ).toThrowError(expect.objectContaining({ code: "CHANNEL_OPERATION_MISMATCH" }));
  });

  it("rejects a malformed run.subscribe payload (no scenario smuggling)", () => {
    const base = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "subscribe",
      operation: "run.subscribe",
      payload: { runId: "run-1", fromSequence: 0 }
    };
    expect(() =>
      validateIpcRequestEnvelope({ ...base, payload: { runId: "", fromSequence: 0 } })
    ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    expect(() =>
      validateIpcRequestEnvelope({ ...base, payload: { runId: "run-1", fromSequence: -1 } })
    ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    expect(() =>
      validateIpcRequestEnvelope({ ...base, payload: { runId: "run-1", fromSequence: 1.5 } })
    ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    expect(() =>
      validateIpcRequestEnvelope({ ...base, payload: { runId: "run-1" } })
    ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    // A scenario / snapshot field is never accepted on a subscription.
    expect(() =>
      validateIpcRequestEnvelope({
        ...base,
        payload: { runId: "run-1", fromSequence: 0, scenario: "success" }
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
  });

  it("validates the runEvents event envelope strictly", () => {
    const envelope = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      kind: "runEvents",
      runId: "run-1",
      fromSequence: 5,
      events: [
        {
          contractVersion: 1,
          runId: "run-1",
          attemptId: "attempt-1",
          sequence: 5,
          occurredAt: "2026-08-13T00:00:00.000Z",
          type: "StageChanged",
          stage: "PREPARING"
        }
      ]
    };
    const validated = validateIpcEventEnvelope(envelope);
    expect(validated.kind).toBe("runEvents");
    expect(validated.events).toHaveLength(1);

    expect(() => validateIpcEventEnvelope({ ...envelope, protocolVersion: 99 })).toThrowError(
      expect.objectContaining({ code: "PROTOCOL_VERSION_MISMATCH" })
    );
    expect(() => validateIpcEventEnvelope({ ...envelope, kind: "other" })).toThrowError(
      expect.objectContaining({ code: "INVALID_ENVELOPE" })
    );
    expect(() => validateIpcEventEnvelope({ ...envelope, runId: "" })).toThrowError(
      expect.objectContaining({ code: "INVALID_ENVELOPE" })
    );
    expect(() => validateIpcEventEnvelope({ ...envelope, fromSequence: -1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_ENVELOPE" })
    );
    expect(() => validateIpcEventEnvelope({ ...envelope, events: "x" })).toThrowError(
      expect.objectContaining({ code: "INVALID_ENVELOPE" })
    );
    // Unknown envelope field (unknown-key rejection is INVALID_PAYLOAD).
    expect(() => validateIpcEventEnvelope({ ...envelope, extra: true })).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" })
    );
  });

  it("rejects an event envelope whose event violates the Run event contract", () => {
    const base = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      kind: "runEvents",
      runId: "run-1",
      fromSequence: 5,
      events: [
        {
          contractVersion: 1,
          runId: "run-1",
          attemptId: "attempt-1",
          sequence: 5,
          occurredAt: "2026-08-13T00:00:00.000Z",
          type: "StageChanged",
          stage: "PREPARING"
        }
      ]
    };
    expect(() =>
      validateIpcEventEnvelope({
        ...base,
        events: [{ ...base.events[0], contractVersion: 2 }]
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(() =>
      validateIpcEventEnvelope({
        ...base,
        events: [{ ...base.events[0], runId: "other-run" }]
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(() =>
      validateIpcEventEnvelope({
        ...base,
        events: [{ ...base.events[0], sequence: -2 }]
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(() =>
      validateIpcEventEnvelope({
        ...base,
        events: [{ ...base.events[0], occurredAt: "not-a-date" }]
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(() =>
      validateIpcEventEnvelope({
        ...base,
        events: [{ ...base.events[0], type: "FabricatedEvent" }]
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(() =>
      validateIpcEventEnvelope({
        ...base,
        events: [{ ...base.events[0], attemptId: "" }]
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });

  it("accepts a strictly-shaped clarification.submit command payload", () => {
    const request = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "command",
      operation: "clarification.submit",
      payload: {
        command: "clarification.submit",
        clarificationRequestId: "clar-1",
        answers: [
          {
            id: "ans-1",
            questionId: "dimension",
            value: { kind: "dimension", value: 12, unit: "mm" },
            answeredAt: "2026-08-13T01:00:00.000Z",
            answeredBy: "alice"
          }
        ],
        answeredAt: "2026-08-13T01:00:00.000Z",
        answeredBy: "alice"
      }
    };
    expect(validateIpcRequestEnvelope(request).operation).toBe("clarification.submit");
  });

  it("rejects clarification.submit smuggling and malformed answers", () => {
    const base = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      channel: "command",
      operation: "clarification.submit",
      payload: {
        command: "clarification.submit",
        clarificationRequestId: "clar-1",
        answers: [
          {
            id: "ans-1",
            questionId: "dimension",
            value: { kind: "dimension", value: 12, unit: "mm" },
            answeredAt: "2026-08-13T01:00:00.000Z",
            answeredBy: "alice"
          }
        ],
        answeredAt: "2026-08-13T01:00:00.000Z",
        answeredBy: "alice"
      }
    };
    const fails = (payload: unknown): void => {
      expect(() => validateIpcRequestEnvelope({ ...base, payload })).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    };
    // A fake scenario or run id in the payload is never accepted.
    fails({ ...base.payload, scenario: "success" });
    fails({ ...base.payload, runId: "run-1" });
    fails({ ...base.payload, answers: [] });
    fails({ ...base.payload, answers: "x" });
    // Unknown answer field.
    fails({
      ...base.payload,
      answers: [{ ...base.payload.answers[0], force: true }]
    });
    // Bad per-kind shapes.
    fails({
      ...base.payload,
      answers: [{ ...base.payload.answers[0], value: { kind: "dimension", value: "12", unit: "mm" } }]
    });
    fails({
      ...base.payload,
      answers: [{ ...base.payload.answers[0], value: { kind: "text", value: "" } }]
    });
    fails({
      ...base.payload,
      answers: [{ ...base.payload.answers[0], value: { kind: "choice", optionId: "" } }]
    });
    fails({
      ...base.payload,
      answers: [{ ...base.payload.answers[0], value: { kind: "fabricated" } }]
    });
    fails({
      ...base.payload,
      answers: [{ ...base.payload.answers[0], value: { kind: "dimension", value: 1, unit: "mm", extra: 1 } }]
    });
    fails({ ...base.payload, answeredAt: "" });
    fails({ ...base.payload, answeredBy: "" });
  });

  describe("model.review command payload validation", () => {
    function modelReviewEnvelope(payload: Record<string, unknown>): IpcRequestEnvelope {
      return {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        channel: "command",
        operation: "model.review",
        payload: {
          command: "model.review",
          modelId: "model-1",
          result: "APPROVED",
          reviewerId: "alice",
          reviewedAt: "2026-08-13T00:00:00.000Z",
          ...payload
        }
      };
    }

    it("accepts a valid APPROVED review without a comment", () => {
      const request = modelReviewEnvelope({});
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("accepts a valid APPROVED review with an optional non-empty comment", () => {
      const request = modelReviewEnvelope({ comment: "尺寸和重量核验无误" });
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("accepts a valid REJECTED review carrying a comment", () => {
      const request = modelReviewEnvelope({ result: "REJECTED", comment: "右侧台阶直径错误" });
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("rejects a payload missing modelId / reviewerId / reviewedAt / result", () => {
      // Build the payload directly (the helper's defaults would re-add
      // missing fields), so each missing/blank field is truly exercised.
      const envelope = (payload: Record<string, unknown>): IpcRequestEnvelope => ({
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        channel: "command",
        operation: "model.review",
        payload: { command: "model.review", ...payload }
      });
      const fails = (payload: Record<string, unknown>): void => {
        expect(() => validateIpcRequestEnvelope(envelope(payload))).toThrowError(
          expect.objectContaining({ code: "INVALID_PAYLOAD" })
        );
      };
      const reviewedAt = "2026-08-13T00:00:00.000Z";
      // Missing modelId / reviewerId / reviewedAt / result.
      fails({ result: "APPROVED", reviewerId: "alice", reviewedAt });
      fails({ modelId: "model-1", result: "APPROVED", reviewedAt });
      fails({ modelId: "model-1", result: "APPROVED", reviewerId: "alice" });
      fails({ modelId: "model-1", reviewerId: "alice", reviewedAt });
      // Blank values are rejected the same way.
      fails({ modelId: "", result: "APPROVED", reviewerId: "alice", reviewedAt });
      fails({ modelId: "model-1", result: "APPROVED", reviewerId: "", reviewedAt });
      fails({ modelId: "model-1", result: "APPROVED", reviewerId: "alice", reviewedAt: "" });
    });

    it("rejects a non-canonical reviewedAt", () => {
      const fails = (reviewedAt: string): void => {
        expect(() => validateIpcRequestEnvelope(modelReviewEnvelope({ reviewedAt }))).toThrowError(
          expect.objectContaining({ code: "INVALID_PAYLOAD" })
        );
      };
      // Offset timestamps and fuzzy dates are never canonical ISO strings.
      fails("2026-08-13T08:00:00.000+08:00");
      fails("not-a-date");
      fails("2026-08-13");
    });

    it("rejects an invalid result", () => {
      expect(() => validateIpcRequestEnvelope(modelReviewEnvelope({ result: "APPROVED-ish" })))
        .toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
      expect(() => validateIpcRequestEnvelope(modelReviewEnvelope({ result: "ACCEPTED" })))
        .toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    });

    it("rejects a REJECTED review without a comment", () => {
      const request = modelReviewEnvelope({ result: "REJECTED" });
      expect(() => validateIpcRequestEnvelope(request)).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    });

    it("rejects a REJECTED review with an empty comment", () => {
      const request = modelReviewEnvelope({ result: "REJECTED", comment: "" });
      expect(() => validateIpcRequestEnvelope(request)).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    });

    it("rejects extra unknown keys on the model.review payload", () => {
      expect(() => validateIpcRequestEnvelope(modelReviewEnvelope({ force: true }))).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
      expect(() => validateIpcRequestEnvelope(modelReviewEnvelope({ modelId: "model-1", extra: 1 })))
        .toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    });
  });

  describe("costData.get query payload validation", () => {
    function envelope(payload: unknown): IpcRequestEnvelope {
      return {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "req-costData-get",
        channel: "query",
        operation: "costData.get",
        payload
      };
    }

    it("accepts the empty {} payload", () => {
      expect(validateIpcRequestEnvelope(envelope({})).operation).toBe("costData.get");
    });

    it("rejects any non-empty payload", () => {
      expect(() => validateIpcRequestEnvelope(envelope({ drawingId: "drawing-1" }))).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
      expect(() => validateIpcRequestEnvelope(envelope({ stale: true }))).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    });

    it("rejects costData.get on the command channel", () => {
      expect(() =>
        validateIpcRequestEnvelope({
          ...envelope({}),
          channel: "command"
        })
      ).toThrowError(expect.objectContaining({ code: "CHANNEL_OPERATION_MISMATCH" }));
    });
  });

  describe("costReport.getDetail query payload validation", () => {
    function envelope(payload: unknown): IpcRequestEnvelope {
      return {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "req-costReport-detail",
        channel: "query",
        operation: "costReport.getDetail",
        payload
      };
    }

    it("accepts a payload carrying only the costReportId", () => {
      const request = envelope({ costReportId: "report-1" });
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("rejects a missing/blank/non-string costReportId", () => {
      const fails = (payload: unknown): void => {
        expect(() => validateIpcRequestEnvelope(envelope(payload))).toThrowError(
          expect.objectContaining({ code: "INVALID_PAYLOAD" })
        );
      };
      fails({});
      fails({ costReportId: "" });
      fails({ costReportId: 42 });
    });

    it("rejects unknown keys or an extra id field", () => {
      expect(() => validateIpcRequestEnvelope(envelope({ costReportId: "r1", extra: 1 })))
        .toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
      expect(() =>
        validateIpcRequestEnvelope(envelope({ costReportId: "r1", drawingId: "d1" }))
      ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    });
  });

  describe("costReport.listByRevision query payload validation", () => {
    function envelope(payload: unknown): IpcRequestEnvelope {
      return {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId: "req-costReport-list",
        channel: "query",
        operation: "costReport.listByRevision",
        payload
      };
    }

    it("accepts the drawing/revision identity pair", () => {
      const request = envelope({ drawingId: "drawing-1", revisionId: "rev-1" });
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("rejects a missing/blank/non-string identity field", () => {
      const fails = (payload: unknown): void => {
        expect(() => validateIpcRequestEnvelope(envelope(payload))).toThrowError(
          expect.objectContaining({ code: "INVALID_PAYLOAD" })
        );
      };
      fails({ drawingId: "drawing-1" });
      fails({ revisionId: "rev-1" });
      fails({ drawingId: "drawing-1", revisionId: "" });
      fails({ drawingId: "", revisionId: "rev-1" });
      fails({ drawingId: "drawing-1", revisionId: 42 });
    });

    it("rejects unknown extra fields", () => {
      expect(() =>
        validateIpcRequestEnvelope(
          envelope({ drawingId: "drawing-1", revisionId: "rev-1", modelId: "m1" })
        )
      ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
    });
  });

  describe("costData.update command payload validation", () => {
    const fails = (payload: Record<string, unknown>): void => {
      expect(() => validateIpcRequestEnvelope(costDataUpdateEnvelope(payload))).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    };

    it("accepts a payload carrying the full strict snapshot", () => {
      const request = costDataUpdateEnvelope({});
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("rejects a payload whose discriminator does not match the operation", () => {
      fails({ command: "costReport.create" });
    });

    it("rejects a missing or non-object snapshot", () => {
      fails({ snapshot: undefined });
      fails({ snapshot: null });
      fails({ snapshot: "nope" });
      fails({ snapshot: [] });
    });

    it("rejects a snapshot with a missing field or an unknown field", () => {
      const { capturedAt: _capturedAt, updatedAt: _updatedAt, ...withoutTimestamps } =
        validCostDataSnapshot(true);
      void _capturedAt;
      void _updatedAt;
      fails({ snapshot: withoutTimestamps });
      fails({ snapshot: { ...validCostDataSnapshot(true), priceBook: "x" } });
    });

    it("rejects non-canonical capturedAt / updatedAt timestamps", () => {
      fails({ snapshot: { ...validCostDataSnapshot(true), capturedAt: "2026-08-10" } });
      fails({
        snapshot: { ...validCostDataSnapshot(true), capturedAt: "2026-08-10T16:00:00.000+08:00" }
      });
      fails({ snapshot: { ...validCostDataSnapshot(true), capturedAt: "not-a-date" } });
      fails({ snapshot: { ...validCostDataSnapshot(true), updatedAt: "2026-08-10" } });
      fails({ snapshot: { ...validCostDataSnapshot(true), updatedAt: "not-a-date" } });
      fails({ snapshot: { ...validCostDataSnapshot(true), updatedAt: "" } });
    });

    it("rejects a material with a non-positive price or density", () => {
      const [material, ...rest] = validCostDataSnapshot(true).materials as Record<string, unknown>[];
      const withMaterial = (patch: Record<string, unknown>): Record<string, unknown> => ({
        ...validCostDataSnapshot(true),
        materials: [{ ...material, ...patch }, ...rest]
      });
      fails({ snapshot: withMaterial({ purchasePrice: 0 }) });
      fails({ snapshot: withMaterial({ purchasePrice: -1 }) });
      fails({ snapshot: withMaterial({ purchasePrice: "5200" }) });
      fails({ snapshot: withMaterial({ density: 0 }) });
      fails({ snapshot: withMaterial({ density: -7.85 }) });
      fails({ snapshot: withMaterial({ density: "7.85" }) });
    });

    it("rejects a fixed cost with a negative amount or invalid currency/basis", () => {
      const [fixedCost, ...rest] = validCostDataSnapshot(true).fixedCosts as Record<string, unknown>[];
      const withFixedCost = (patch: Record<string, unknown>): Record<string, unknown> => ({
        ...validCostDataSnapshot(true),
        fixedCosts: [{ ...fixedCost, ...patch }, ...rest]
      });
      fails({ snapshot: withFixedCost({ amount: -0.01 }) });
      fails({ snapshot: withFixedCost({ amount: "500" }) });
      fails({ snapshot: withFixedCost({ currency: "USD" }) });
      fails({ snapshot: withFixedCost({ basis: "PER_ITEM" }) });
      fails({ snapshot: withFixedCost({ defaultEnabled: "yes" }) });
    });

    it("rejects an allowance definition with an invalid stock type or negative margin", () => {
      const [allowance, ...rest] = validCostDataSnapshot(true).allowances as Record<string, unknown>[];
      const withAllowance = (patch: Record<string, unknown>): Record<string, unknown> => ({
        ...validCostDataSnapshot(true),
        allowances: [{ ...allowance, ...patch }, ...rest]
      });
      fails({ snapshot: withAllowance({ stockType: "HEX_BAR" }) });
      fails({ snapshot: withAllowance({ allowances: [{ name: "余量", valueMm: -1 }] }) });
    });

    it("rejects a custom field whose semantics is not DISPLAY_ONLY", () => {
      const [customField, ...rest] = validCostDataSnapshot(true).customFields as Record<string, unknown>[];
      fails({
        snapshot: {
          ...validCostDataSnapshot(true),
          customFields: [{ ...customField, semantics: "CALCULABLE" }, ...rest]
        }
      });
    });

    it("rejects unknown keys on the payload itself (including forged result/updatedAt)", () => {
      fails({ result: { perPieceCost: 0 } });
      fails({ updatedAt: "2026-08-10T08:00:00.000Z" });
      fails({ force: true });
    });
  });

  describe("costReport.create command payload validation", () => {
    const fails = (payload: Record<string, unknown>): void => {
      expect(() => validateIpcRequestEnvelope(costReportCreateEnvelope(payload))).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    };
    const inputPatch = (patch: Record<string, unknown>): Record<string, unknown> => ({
      ...validCostReportInput(),
      ...patch
    });

    it("accepts a payload carrying only the input snapshot and createdAt", () => {
      const request = costReportCreateEnvelope({});
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("rejects a payload whose discriminator does not match the operation", () => {
      fails({ command: "costData.update" });
    });

    it("rejects a missing/blank createdAt and a missing/non-object input", () => {
      fails({ createdAt: "" });
      fails({ createdAt: undefined });
      fails({ input: undefined });
      fails({ input: null });
      fails({ input: "nope" });
      fails({ input: [] });
    });

    it("rejects a forged result and any unknown payload field", () => {
      fails({ result: { perPieceCost: 1 } });
      fails({ result: undefined });
      fails({ inputSnapshot: validCostReportInput() });
      fails({ force: true });
    });

    it("rejects an input missing a required identity field", () => {
      const { drawingId: _d, revisionId: _r, modelId: _m, ...rest } = validCostReportInput();
      void _d;
      void _r;
      void _m;
      fails({ input: rest });
      fails({ input: inputPatch({ drawingId: "" }) });
      fails({ input: inputPatch({ revisionId: "" }) });
      fails({ input: inputPatch({ modelId: "" }) });
    });

    it("rejects a non-positive-integer quantity", () => {
      fails({ input: inputPatch({ quantity: 0 }) });
      fails({ input: inputPatch({ quantity: -3 }) });
      fails({ input: inputPatch({ quantity: 1.5 }) });
      fails({ input: inputPatch({ quantity: "10" }) });
    });

    it("rejects an invalid stockType / blank stockSpec / non-positive finishedVolume", () => {
      fails({ input: inputPatch({ stockType: "HEX_BAR" }) });
      fails({ input: inputPatch({ stockType: "" }) });
      fails({ input: inputPatch({ stockSpec: "" }) });
      fails({ input: inputPatch({ finishedVolume: 0 }) });
      fails({ input: inputPatch({ finishedVolume: -0.05 }) });
      fails({ input: inputPatch({ finishedVolume: "0.05" }) });
    });

    it("rejects malformed allowances", () => {
      fails({ input: inputPatch({ allowances: "20mm" }) });
      fails({ input: inputPatch({ allowances: [{ name: "余量", valueMm: -1 }] }) });
      fails({ input: inputPatch({ allowances: [{ name: "余量", valueMm: 20, unit: "mm" }] }) });
    });

    it("rejects an invalid costData snapshot (including a forged snapshot-level updatedAt)", () => {
      fails({ input: inputPatch({ costData: validCostDataSnapshot(true) }) });
      fails({ input: inputPatch({ costData: { capturedAt: "2026-08-10T08:00:00.000Z" } }) });
      const [material, ...rest] = validCostDataSnapshot(false).materials as Record<string, unknown>[];
      fails({
        input: inputPatch({
          costData: { ...validCostDataSnapshot(false), materials: [{ ...material, purchasePrice: 0 }, ...rest] }
        })
      });
    });

    it("rejects an empty formulaVersion and a non-canonical capturedAt", () => {
      fails({ input: inputPatch({ formulaVersion: "" }) });
      fails({ input: inputPatch({ formulaVersion: undefined }) });
      fails({ input: inputPatch({ capturedAt: "2026-08-10" }) });
      fails({ input: inputPatch({ capturedAt: "not-a-date" }) });
      fails({ input: inputPatch({ capturedAt: "2026-08-10T17:00:00.000+08:00" }) });
    });
  });
});

describe("Phase 8 command payload validation", () => {
  function commandEnvelope(
    operation: IpcRequestEnvelope["operation"],
    payload: Record<string, unknown>
  ): IpcRequestEnvelope {
    return {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: "req-p8",
      channel: "command",
      operation,
      payload
    };
  }

  describe("run.delete command payload validation", () => {
    const validPayload = (): Record<string, unknown> => ({
      command: "run.delete",
      runId: "run-1",
      drawingId: "drawing-1",
      revisionId: "rev-3"
    });
    const fails = (payload: Record<string, unknown>): void => {
      expect(() => validateIpcRequestEnvelope(commandEnvelope("run.delete", payload))).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    };

    it("accepts the run plus the owning drawing/revision identity", () => {
      const request = commandEnvelope("run.delete", validPayload());
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("rejects a payload whose discriminator does not match the operation", () => {
      fails({ command: "run.cancel", runId: "run-1", drawingId: "drawing-1", revisionId: "rev-3" });
    });

    it("rejects missing/blank/non-string identity fields", () => {
      fails({ ...validPayload(), runId: "" });
      fails({ ...validPayload(), runId: 42 });
      fails({ ...validPayload(), drawingId: "" });
      fails({ ...validPayload(), drawingId: null });
      fails({ ...validPayload(), revisionId: "" });
      fails({ ...validPayload(), revisionId: {} });
    });

    it("rejects unknown fields (no snapshot or payload smuggling)", () => {
      fails({ ...validPayload(), snapshot: { drawingId: "drawing-1" } });
      fails({ ...validPayload(), force: true });
    });
  });

  describe("costReport.delete command payload validation", () => {
    const validPayload = (): Record<string, unknown> => ({
      command: "costReport.delete",
      costReportId: "cost-report-1",
      revisionId: "rev-3"
    });
    const fails = (payload: Record<string, unknown>): void => {
      expect(() => validateIpcRequestEnvelope(commandEnvelope("costReport.delete", payload))).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    };

    it("accepts the report plus the owning revision identity", () => {
      const request = commandEnvelope("costReport.delete", validPayload());
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("rejects a mismatched discriminator", () => {
      fails({ ...validPayload(), command: "costData.update" });
    });

    it("rejects missing/blank/non-string id fields", () => {
      fails({ command: "costReport.delete", costReportId: "", revisionId: "rev-3" });
      fails({ command: "costReport.delete", costReportId: 1, revisionId: "rev-3" });
      fails({ command: "costReport.delete", costReportId: "cost-report-1", revisionId: "" });
      fails({ command: "costReport.delete", costReportId: "cost-report-1", revisionId: undefined });
    });

    it("rejects unknown fields", () => {
      fails({ ...validPayload(), drawingId: "drawing-1" });
    });
  });

  describe("secrets.setApiKey command payload validation", () => {
    const fails = (payload: Record<string, unknown>): void => {
      expect(() => validateIpcRequestEnvelope(commandEnvelope("secrets.setApiKey", payload))).toThrowError(
        expect.objectContaining({ code: "INVALID_PAYLOAD" })
      );
    };

    it("accepts a non-empty api key", () => {
      const request = commandEnvelope("secrets.setApiKey", { command: "secrets.setApiKey", apiKey: "sk-test-1234" });
      expect(validateIpcRequestEnvelope(request)).toEqual(request);
    });

    it("rejects a blank/non-string api key", () => {
      fails({ command: "secrets.setApiKey", apiKey: "" });
      fails({ command: "secrets.setApiKey", apiKey: "   " });
      fails({ command: "secrets.setApiKey", apiKey: 1234 });
      fails({ command: "secrets.setApiKey", apiKey: null });
      fails({ command: "secrets.setApiKey" });
    });

    it("rejects unknown fields", () => {
      fails({ command: "secrets.setApiKey", apiKey: "sk-test-1234", masked: "sk-te****" });
    });
  });

  describe("empty-payload command validation (secrets + system)", () => {
    const cases: Array<{
      operation: IpcRequestEnvelope["operation"];
      payload: Record<string, unknown>;
    }> = [
      { operation: "secrets.getApiKeyStatus", payload: { command: "secrets.getApiKeyStatus" } },
      { operation: "secrets.clearApiKey", payload: { command: "secrets.clearApiKey" } },
      { operation: "system.getRecoveryStatus", payload: { command: "system.getRecoveryStatus" } }
    ];

    it("accepts each discriminator-only payload", () => {
      for (const { operation, payload } of cases) {
        const request = commandEnvelope(operation, payload);
        expect(validateIpcRequestEnvelope(request)).toEqual(request);
      }
    });

    it("rejects any extra field (no sneak-in payload)", () => {
      for (const { operation } of cases) {
        expect(() =>
          validateIpcRequestEnvelope(commandEnvelope(operation, { command: operation, extra: true }))
        ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
      }
    });

    it("rejects a mismatched discriminator", () => {
      for (const { operation } of cases) {
        expect(() =>
          validateIpcRequestEnvelope(commandEnvelope(operation, { command: "run.create" }))
        ).toThrowError(expect.objectContaining({ code: "INVALID_PAYLOAD" }));
      }
    });
  });
});
