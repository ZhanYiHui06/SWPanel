import { describe, expect, it } from "vitest";

import {
  ALL_MAIN_CHANNELS,
  BridgeValidationError,
  MAIN_CHANNELS,
  MAIN_HANDLE_CHANNELS,
  redactPaths,
  validateAddModelingFeedback,
  validateAddRevision,
  validateAddRevisionFact,
  validateClarificationRequestId,
  validateClarificationSubmit,
  validateCostReportDelete,
  validateDeleteRevision,
  validateDrawingId,
  validateEmptyPayload,
  validateImportDrawing,
  validateModelDetailId,
  validateRevisionIds,
  validateReviewModel,
  validateRunCancel,
  validateRunCreate,
  validateRunDelete,
  validateRunDetailId,
  validateRunSubscribe,
  validateRunUnsubscribe,
  validateSelectedFileToken,
  validateSetApiKey,
  validateSetCurrentRevision,
  validateUpdateStorageSettings,
  type MainChannel
} from "./bridge-contract.js";

describe("bridge channel allowlist", () => {
  it("registers exactly the WP5 + Phase 3 allowlisted channels", () => {
    expect(ALL_MAIN_CHANNELS).toEqual([
      "swpanel:health",
      "swpanel:files:selectDrawingFile",
      "swpanel:drawings:list",
      "swpanel:drawings:history",
      "swpanel:drawings:detail",
      "swpanel:revisions:history",
      "swpanel:revisions:detail",
      "swpanel:storage:getSettings",
      "swpanel:drawings:import",
      "swpanel:drawings:addRevision",
      "swpanel:drawings:setCurrentRevision",
      "swpanel:drawings:deleteRevision",
      "swpanel:revisions:addFact",
      "swpanel:revisions:addModelingFeedback",
      "swpanel:storage:updateSettings",
      "swpanel:runs:list",
      "swpanel:runs:detail",
      "swpanel:runs:create",
      "swpanel:runs:cancel",
      "swpanel:runs:subscribe",
      "swpanel:runs:unsubscribe",
      "swpanel:runs:events",
      "swpanel:clarifications:get",
      "swpanel:clarifications:submit",
      "swpanel:models:detail",
      "swpanel:models:review",
      "swpanel:costData:get",
      "swpanel:costData:update",
      "swpanel:costReports:detail",
      "swpanel:costReports:create",
      "swpanel:runs:delete",
      "swpanel:costReports:delete",
      "swpanel:system:recoveryStatus",
      "swpanel:secrets:getStatus",
      "swpanel:secrets:setApiKey",
      "swpanel:secrets:clearApiKey"
    ]);
  });

  it("keeps the runEvents PUSH channel out of the ipcMain.handle set", () => {
    expect(MAIN_HANDLE_CHANNELS).not.toContain(MAIN_CHANNELS.runEvents);
    expect(MAIN_HANDLE_CHANNELS).toEqual(
      ALL_MAIN_CHANNELS.filter((channel) => channel !== MAIN_CHANNELS.runEvents)
    );
    expect(MAIN_HANDLE_CHANNELS).toHaveLength(ALL_MAIN_CHANNELS.length - 1);
  });

  it("has no generic, file or pipe channels", () => {
    const joined = ALL_MAIN_CHANNELS.join(" ");
    expect(joined).not.toMatch(/invoke|generic|readFile|spawn|shell|pipe/);
    expect(MAIN_CHANNELS).not.toHaveProperty("invoke");
    expect(MAIN_CHANNELS).not.toHaveProperty("readFile");
    expect(MAIN_CHANNELS).not.toHaveProperty("spawn");
  });

  it("covers every WP5 + Phase 3 capability", () => {
    expect(MAIN_CHANNELS.health).toBe("swpanel:health");
    expect(MAIN_CHANNELS.selectDrawingFile).toBe("swpanel:files:selectDrawingFile");
    expect(MAIN_CHANNELS.drawingList).toBe("swpanel:drawings:list");
    expect(MAIN_CHANNELS.drawingHistory).toBe("swpanel:drawings:history");
    expect(MAIN_CHANNELS.drawingDetail).toBe("swpanel:drawings:detail");
    expect(MAIN_CHANNELS.revisionHistory).toBe("swpanel:revisions:history");
    expect(MAIN_CHANNELS.revisionDetail).toBe("swpanel:revisions:detail");
    expect(MAIN_CHANNELS.storageGetSettings).toBe("swpanel:storage:getSettings");
    expect(MAIN_CHANNELS.importDrawing).toBe("swpanel:drawings:import");
    expect(MAIN_CHANNELS.addRevision).toBe("swpanel:drawings:addRevision");
    expect(MAIN_CHANNELS.setCurrentRevision).toBe("swpanel:drawings:setCurrentRevision");
    expect(MAIN_CHANNELS.deleteRevision).toBe("swpanel:drawings:deleteRevision");
    expect(MAIN_CHANNELS.addRevisionFact).toBe("swpanel:revisions:addFact");
    expect(MAIN_CHANNELS.addModelingFeedback).toBe("swpanel:revisions:addModelingFeedback");
    expect(MAIN_CHANNELS.updateStorageSettings).toBe("swpanel:storage:updateSettings");
    expect(MAIN_CHANNELS.runList).toBe("swpanel:runs:list");
    expect(MAIN_CHANNELS.runDetail).toBe("swpanel:runs:detail");
    expect(MAIN_CHANNELS.runCreate).toBe("swpanel:runs:create");
    expect(MAIN_CHANNELS.runCancel).toBe("swpanel:runs:cancel");
    expect(MAIN_CHANNELS.runSubscribe).toBe("swpanel:runs:subscribe");
    expect(MAIN_CHANNELS.runUnsubscribe).toBe("swpanel:runs:unsubscribe");
    expect(MAIN_CHANNELS.runEvents).toBe("swpanel:runs:events");
    expect(MAIN_CHANNELS.clarificationGet).toBe("swpanel:clarifications:get");
    expect(MAIN_CHANNELS.clarificationSubmit).toBe("swpanel:clarifications:submit");
    expect(MAIN_CHANNELS.modelDetail).toBe("swpanel:models:detail");
    expect(MAIN_CHANNELS.modelReview).toBe("swpanel:models:review");
    expect(MAIN_CHANNELS.runDelete).toBe("swpanel:runs:delete");
    expect(MAIN_CHANNELS.costReportDelete).toBe("swpanel:costReports:delete");
    expect(MAIN_CHANNELS.recoveryStatus).toBe("swpanel:system:recoveryStatus");
    expect(MAIN_CHANNELS.secretsGetStatus).toBe("swpanel:secrets:getStatus");
    expect(MAIN_CHANNELS.secretsSetApiKey).toBe("swpanel:secrets:setApiKey");
    expect(MAIN_CHANNELS.secretsClearApiKey).toBe("swpanel:secrets:clearApiKey");
  });

  it("exposes a fixed-length typed channel list", () => {
    const unique = new Set<MainChannel>(ALL_MAIN_CHANNELS);
    expect(unique.size).toBe(ALL_MAIN_CHANNELS.length);
  });
});

describe("payload validators", () => {
  it("requires the empty object for empty-payload channels", () => {
    expect(() => validateEmptyPayload({})).not.toThrow();
    expect(() => validateEmptyPayload({ extra: 1 })).toThrow(BridgeValidationError);
    expect(() => validateEmptyPayload(null)).toThrow(BridgeValidationError);
    expect(() => validateEmptyPayload("x")).toThrow(BridgeValidationError);
  });

  it("validates strict drawing ids", () => {
    expect(validateDrawingId({ drawingId: "drawing-1" })).toBe("drawing-1");
    expect(() => validateDrawingId({ drawingId: "../escape" })).toThrow(BridgeValidationError);
    expect(() => validateDrawingId({ drawingId: "C:\\Windows" })).toThrow(BridgeValidationError);
    expect(() => validateDrawingId({ drawingId: "" })).toThrow(BridgeValidationError);
    expect(() => validateDrawingId({ drawingId: 42 })).toThrow(BridgeValidationError);
    expect(() => validateDrawingId({ drawingId: "ok", extra: "x" })).toThrow(BridgeValidationError);
    expect(() => validateDrawingId({})).toThrow(BridgeValidationError);
  });

  it("validates drawing + revision id pairs", () => {
    expect(validateRevisionIds({ drawingId: "d1", revisionId: "r1" })).toEqual({
      drawingId: "d1",
      revisionId: "r1"
    });
    expect(() => validateRevisionIds({ drawingId: "d1" })).toThrow(BridgeValidationError);
    expect(() => validateRevisionIds({ drawingId: "d1", revisionId: "r1", x: 1 })).toThrow(
      BridgeValidationError
    );
  });

  it("validates the selected-file token format", () => {
    const token = `swsel_${"a".repeat(32)}`;
    expect(validateSelectedFileToken(token)).toBe(token);
    expect(() => validateSelectedFileToken("swsel_short")).toThrow(BridgeValidationError);
    expect(() => validateSelectedFileToken("other_1234567890abcdef1234567890abcdef")).toThrow(
      BridgeValidationError
    );
    expect(() => validateSelectedFileToken(42)).toThrow(BridgeValidationError);
  });

  it("validates importDrawing input with exact fields and timestamps", () => {
    const valid = validateImportDrawing({
      drawingNumber: "PDJF001.01",
      name: "轧辊",
      selectedFileToken: `swsel_${"b".repeat(32)}`,
      createdAt: "2026-08-12T00:00:00.000Z"
    });
    expect(valid.drawingNumber).toBe("PDJF001.01");
    expect(() =>
      validateImportDrawing({ drawingNumber: "", name: "x", selectedFileToken: `swsel_${"b".repeat(32)}`, createdAt: "2026-08-12T00:00:00.000Z" })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateImportDrawing({ drawingNumber: "X", name: "x", selectedFileToken: "bad", createdAt: "2026-08-12T00:00:00.000Z" })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateImportDrawing({ drawingNumber: "X", name: "x", selectedFileToken: `swsel_${"b".repeat(32)}`, createdAt: "not-a-date" })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateImportDrawing({ drawingNumber: "X", name: "x", selectedFileToken: `swsel_${"b".repeat(32)}`, createdAt: "2026-08-12T00:00:00.000Z", evil: 1 })
    ).toThrow(BridgeValidationError);
  });

  it("validates addRevision input", () => {
    const valid = validateAddRevision({
      drawingId: "d1",
      selectedFileToken: `swsel_${"c".repeat(32)}`,
      createdAt: "2026-08-12T00:00:00.000Z"
    });
    expect(valid.drawingId).toBe("d1");
    expect(() =>
      validateAddRevision({ drawingId: "d1", selectedFileToken: "bad", createdAt: "2026-08-12T00:00:00.000Z" })
    ).toThrow(BridgeValidationError);
  });

  it("validates deleteRevision input with exact fields", () => {
    const valid = validateDeleteRevision({
      drawingId: "d1",
      revisionId: "r2",
      updatedAt: "2026-08-12T00:00:00.000Z"
    });
    expect(valid.revisionId).toBe("r2");
    // Unknown keys are rejected: the delete must never honor extra fields.
    expect(() =>
      validateDeleteRevision({
        drawingId: "d1",
        revisionId: "r2",
        updatedAt: "2026-08-12T00:00:00.000Z",
        deleteWholeDrawing: true
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateDeleteRevision({ drawingId: "d1", revisionId: "r2", updatedAt: "nope" })
    ).toThrow(BridgeValidationError);
  });

  it("validates setCurrentRevision input", () => {
    const valid = validateSetCurrentRevision({
      drawingId: "d1",
      revisionId: "r1",
      updatedAt: "2026-08-12T00:00:00.000Z"
    });
    expect(valid.revisionId).toBe("r1");
    expect(() =>
      validateSetCurrentRevision({ drawingId: "d1", revisionId: "r1", updatedAt: "nope" })
    ).toThrow(BridgeValidationError);
  });

  it("validates addRevisionFact with a strict fact source", () => {
    const valid = validateAddRevisionFact({
      drawingId: "d1",
      revisionId: "r1",
      field: "中心孔深度",
      value: "85 mm",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T00:00:00.000Z",
      clientIntentId: `swint_${"a".repeat(32)}`
    });
    expect(valid.source).toBe("USER_SUPPLEMENT");
    expect(valid.clientIntentId).toBe(`swint_${"a".repeat(32)}`);
    expect(() =>
      validateAddRevisionFact({
        drawingId: "d1",
        revisionId: "r1",
        field: "f",
        value: "v",
        source: "MADE_UP",
        createdAt: "2026-08-12T00:00:00.000Z",
        clientIntentId: `swint_${"b".repeat(32)}`
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateAddRevisionFact({
        drawingId: "d1",
        revisionId: "r1",
        field: "f",
        value: "v",
        source: "CLARIFICATION",
        createdAt: "2026-08-12T00:00:00.000Z",
        clientIntentId: `swint_${"c".repeat(32)}`,
        sourceRunId: "../evil"
      })
    ).toThrow(BridgeValidationError);
  });

  it("requires an exactly-shaped clientIntentId on addRevisionFact (never unbounded strings)", () => {
    const base = {
      drawingId: "d1",
      revisionId: "r1",
      field: "f",
      value: "v",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T00:00:00.000Z"
    };
    const valid = validateAddRevisionFact({ ...base, clientIntentId: `swint_${"d".repeat(32)}` });
    expect(valid.clientIntentId).toBe(`swint_${"d".repeat(32)}`);
    const invalidIds: unknown[] = [
      undefined,
      "",
      "swint_" + "a".repeat(31),
      "swint_" + "a".repeat(33),
      "swint_" + "A".repeat(32),
      "swsel_" + "a".repeat(32),
      "swint_" + "g".repeat(32),
      "swint_" + "a".repeat(4000),
      { id: `swint_${"a".repeat(32)}` },
      123
    ];
    for (const clientIntentId of invalidIds) {
      expect(() =>
        validateAddRevisionFact({ ...base, clientIntentId })
      ).toThrow(BridgeValidationError);
    }
  });

  it("validates addModelingFeedback content", () => {
    const valid = validateAddModelingFeedback({
      drawingId: "d1",
      revisionId: "r1",
      content: "圆角应在另一个位置",
      createdAt: "2026-08-12T00:00:00.000Z",
      clientIntentId: `swint_${"e".repeat(32)}`
    });
    expect(valid.content).toContain("圆角");
    expect(valid.clientIntentId).toBe(`swint_${"e".repeat(32)}`);
    expect(() =>
      validateAddModelingFeedback({
        drawingId: "d1",
        revisionId: "r1",
        content: "",
        createdAt: "2026-08-12T00:00:00.000Z",
        clientIntentId: `swint_${"f".repeat(32)}`
      })
    ).toThrow(BridgeValidationError);
    // The intent id is required and strictly shaped: missing or malformed ids
    // are rejected before they can influence the idempotency key.
    expect(() =>
      validateAddModelingFeedback({
        drawingId: "d1",
        revisionId: "r1",
        content: "c",
        createdAt: "2026-08-12T00:00:00.000Z"
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateAddModelingFeedback({
        drawingId: "d1",
        revisionId: "r1",
        content: "c",
        createdAt: "2026-08-12T00:00:00.000Z",
        clientIntentId: "anything"
      })
    ).toThrow(BridgeValidationError);
  });

  it("validates updateStorageSettings with the fixed constraint", () => {
    const valid = validateUpdateStorageSettings({
      settings: {
        dataRoot: "C:\\data\\swpanel",
        workspaceRoot: "C:\\data\\swpanel\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    });
    expect(valid.settings.constraint).toBe("LOCAL_FIXED_NTFS");
    expect(() =>
      validateUpdateStorageSettings({
        settings: {
          dataRoot: "C:\\data",
          workspaceRoot: "C:\\data\\w",
          constraint: "REMOTE_SMB",
          updatedAt: "2026-08-12T00:00:00.000Z"
        }
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateUpdateStorageSettings({
        settings: {
          dataRoot: "C:\\data",
          workspaceRoot: "C:\\data\\w",
          constraint: "LOCAL_FIXED_NTFS",
          updatedAt: "bad"
        }
      })
    ).toThrow(BridgeValidationError);
  });

  it("validates run detail ids strictly", () => {
    expect(validateRunDetailId({ runId: "run-1" })).toEqual({ runId: "run-1" });
    expect(() => validateRunDetailId({ runId: "../escape" })).toThrow(BridgeValidationError);
    expect(() => validateRunDetailId({ runId: "", extra: 1 })).toThrow(BridgeValidationError);
  });

  it("validates run.create with EXACTLY the drawing/revision pair (no snapshot smuggling)", () => {
    expect(validateRunCreate({ drawingId: "d1", revisionId: "r1" })).toEqual({
      drawingId: "d1",
      revisionId: "r1"
    });
    // A client-supplied Input Snapshot (or any other field) is rejected.
    expect(() =>
      validateRunCreate({ drawingId: "d1", revisionId: "r1", inputSnapshot: { faked: true } })
    ).toThrow(BridgeValidationError);
    expect(() => validateRunCreate({ drawingId: "d1" })).toThrow(BridgeValidationError);
    expect(() => validateRunCreate({ drawingId: "d1", revisionId: 42 })).toThrow(
      BridgeValidationError
    );
  });

  it("validates run.cancel with an optional bounded reason", () => {
    expect(validateRunCancel({ runId: "run-1" })).toEqual({ runId: "run-1" });
    expect(validateRunCancel({ runId: "run-1", reason: "用户取消" })).toEqual({
      runId: "run-1",
      reason: "用户取消"
    });
    expect(() => validateRunCancel({ runId: "" })).toThrow(BridgeValidationError);
    expect(() => validateRunCancel({ runId: "run-1", reason: "" })).toThrow(BridgeValidationError);
    expect(() => validateRunCancel({ runId: "run-1", reason: "x".repeat(2048) })).toThrow(
      BridgeValidationError
    );
    expect(() => validateRunCancel({ runId: "run-1", scenario: "faked" })).toThrow(
      BridgeValidationError
    );
  });

  it("validates run.subscribe with a non-negative fromSequence", () => {
    expect(validateRunSubscribe({ runId: "run-1", fromSequence: 0 })).toEqual({
      runId: "run-1",
      fromSequence: 0
    });
    expect(validateRunSubscribe({ runId: "run-1", fromSequence: 42 })).toEqual({
      runId: "run-1",
      fromSequence: 42
    });
    expect(() => validateRunSubscribe({ runId: "run-1", fromSequence: -1 })).toThrow(
      BridgeValidationError
    );
    expect(() => validateRunSubscribe({ runId: "run-1", fromSequence: 1.5 })).toThrow(
      BridgeValidationError
    );
    expect(() => validateRunSubscribe({ runId: "run-1" })).toThrow(BridgeValidationError);
    expect(() => validateRunSubscribe({ runId: "run-1", fromSequence: 0, scenario: "x" })).toThrow(
      BridgeValidationError
    );
  });

  it("validates run.unsubscribe with exactly the run id", () => {
    expect(validateRunUnsubscribe({ runId: "run-1" })).toEqual({ runId: "run-1" });
    expect(() => validateRunUnsubscribe({ runId: "run-1", fromSequence: 0 })).toThrow(
      BridgeValidationError
    );
  });

  it("validates clarification request ids strictly", () => {
    expect(validateClarificationRequestId({ clarificationRequestId: "clar-1" })).toEqual({
      clarificationRequestId: "clar-1"
    });
    expect(() => validateClarificationRequestId({ clarificationRequestId: "" })).toThrow(
      BridgeValidationError
    );
    expect(() => validateClarificationRequestId({ clarificationRequestId: "C:\\x" })).toThrow(
      BridgeValidationError
    );
  });

  it("validates clarification.submit answers strictly (per-kind shapes)", () => {
    const base = {
      clarificationRequestId: "clar-1",
      answeredAt: "2026-08-13T01:00:00.000Z",
      answeredBy: "alice"
    };
    const valid = validateClarificationSubmit({
      ...base,
      answers: [
        {
          id: "ans-1",
          questionId: "dimension",
          value: { kind: "dimension", value: 12, unit: "mm" },
          answeredAt: "2026-08-13T01:00:00.000Z",
          answeredBy: "alice"
        },
        {
          id: "ans-2",
          questionId: "weld-treatment",
          value: { kind: "choice", optionId: "full" },
          answeredAt: "2026-08-13T01:00:00.000Z",
          answeredBy: "alice"
        }
      ]
    });
    expect(valid.answers).toHaveLength(2);
    expect(() => validateClarificationSubmit({ ...base, answers: [] })).toThrow(
      BridgeValidationError
    );
    expect(() => validateClarificationSubmit({ ...base, answers: "x" })).toThrow(
      BridgeValidationError
    );
    // Unknown answer field and unknown value field are both rejected.
    expect(() =>
      validateClarificationSubmit({
        ...base,
        answers: [
          {
            id: "ans-1",
            questionId: "q1",
            value: { kind: "dimension", value: 1, unit: "mm" },
            answeredAt: "2026-08-13T01:00:00.000Z",
            answeredBy: "alice",
            scenario: "faked"
          }
        ]
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateClarificationSubmit({
        ...base,
        answers: [
          {
            id: "ans-1",
            questionId: "q1",
            value: { kind: "dimension", value: 1, unit: "mm", extra: true },
            answeredAt: "2026-08-13T01:00:00.000Z",
            answeredBy: "alice"
          }
        ]
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateClarificationSubmit({
        ...base,
        answers: [
          {
            id: "ans-1",
            questionId: "q1",
            value: { kind: "text", value: "" },
            answeredAt: "2026-08-13T01:00:00.000Z",
            answeredBy: "alice"
          }
        ]
      })
    ).toThrow(BridgeValidationError);
  });
it("validates model detail ids strictly", () => {
    expect(validateModelDetailId({ modelId: "model-1" })).toBe("model-1");
    expect(() => validateModelDetailId({ modelId: "../escape" })).toThrow(BridgeValidationError);
    expect(() => validateModelDetailId({ modelId: "" })).toThrow(BridgeValidationError);
    expect(() => validateModelDetailId({ modelId: "C:\\Windows" })).toThrow(BridgeValidationError);
    expect(() => validateModelDetailId({})).toThrow(BridgeValidationError);
    expect(() => validateModelDetailId({ modelId: "m1", extra: true })).toThrow(
      BridgeValidationError
    );
  });

  it("validates model.review with a canonical ISO timestamp and a required rejection comment", () => {
    const approved = validateReviewModel({
      modelId: "model-1",
      result: "APPROVED",
      reviewerId: "alice",
      reviewedAt: "2026-08-13T01:00:00.000Z"
    });
    expect(approved.result).toBe("APPROVED");
    expect(approved.comment).toBeUndefined();

    const rejected = validateReviewModel({
      modelId: "model-1",
      result: "REJECTED",
      comment: "右侧台阶直径错误",
      reviewerId: "alice",
      reviewedAt: "2026-08-13T01:00:00.000Z"
    });
    expect(rejected.result).toBe("REJECTED");
    expect(rejected.comment).toBe("右侧台阶直径错误");

    // The main process rejects other timestamps (not canonical ISO round-trip).
    expect(() =>
      validateReviewModel({
        modelId: "model-1",
        result: "APPROVED",
        reviewerId: "alice",
        reviewedAt: "not-a-date"
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateReviewModel({
        modelId: "model-1",
        result: "APPROVED",
        reviewerId: "alice",
        reviewedAt: "2026-08-13 01:00:00"
      })
    ).toThrow(BridgeValidationError);

    // Unknown keys are rejected (the Renderer may never smuggle extra fields).
    expect(() =>
      validateReviewModel({
        modelId: "model-1",
        result: "APPROVED",
        reviewerId: "alice",
        reviewedAt: "2026-08-13T01:00:00.000Z",
        reviewId: "review-1"
      })
    ).toThrow(BridgeValidationError);

    // Result must be exactly APPROVED or REJECTED.
    expect(() =>
      validateReviewModel({
        modelId: "model-1",
        result: "PENDING_REVIEW",
        reviewerId: "alice",
        reviewedAt: "2026-08-13T01:00:00.000Z"
      })
    ).toThrow(BridgeValidationError);

    // A REJECTED model MUST carry a comment; a present comment must be non-empty.
    expect(() =>
      validateReviewModel({
        modelId: "model-1",
        result: "REJECTED",
        reviewerId: "alice",
        reviewedAt: "2026-08-13T01:00:00.000Z"
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateReviewModel({
        modelId: "model-1",
        result: "APPROVED",
        comment: "",
        reviewerId: "alice",
        reviewedAt: "2026-08-13T01:00:00.000Z"
      })
    ).toThrow(BridgeValidationError);

    // Model id and reviewer id are strictly validated.
    expect(() =>
      validateReviewModel({
        modelId: "../escape",
        result: "APPROVED",
        reviewerId: "alice",
        reviewedAt: "2026-08-13T01:00:00.000Z"
      })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateReviewModel({
        modelId: "model-1",
        result: "APPROVED",
        reviewerId: "",
        reviewedAt: "2026-08-13T01:00:00.000Z"
      })
    ).toThrow(BridgeValidationError);
  });

  it("validates run.delete with EXACTLY the run + owning drawing/revision pair", () => {
    expect(
      validateRunDelete({ runId: "run-1", drawingId: "d1", revisionId: "r1" })
    ).toEqual({ runId: "run-1", drawingId: "d1", revisionId: "r1" });
    // Unknown keys are rejected: the guarded deletion never honors extras.
    expect(() =>
      validateRunDelete({
        runId: "run-1",
        drawingId: "d1",
        revisionId: "r1",
        deleteWholeDrawing: true
      })
    ).toThrow(BridgeValidationError);
    expect(() => validateRunDelete({ runId: "run-1", drawingId: "d1" })).toThrow(
      BridgeValidationError
    );
    expect(() =>
      validateRunDelete({ runId: "../escape", drawingId: "d1", revisionId: "r1" })
    ).toThrow(BridgeValidationError);
    expect(() =>
      validateRunDelete({ runId: "run-1", drawingId: "d1", revisionId: 42 })
    ).toThrow(BridgeValidationError);
  });

  it("validates costReport.delete with the report + owning revision pair", () => {
    expect(
      validateCostReportDelete({ costReportId: "cost-report-1", revisionId: "rev-3" })
    ).toEqual({ costReportId: "cost-report-1", revisionId: "rev-3" });
    expect(() =>
      validateCostReportDelete({ costReportId: "cost-report-1", revisionId: "rev-3", force: true })
    ).toThrow(BridgeValidationError);
    expect(() => validateCostReportDelete({ costReportId: "cost-report-1" })).toThrow(
      BridgeValidationError
    );
    expect(() =>
      validateCostReportDelete({ costReportId: "C:\\Windows", revisionId: "rev-3" })
    ).toThrow(BridgeValidationError);
  });

  it("validates secrets.setApiKey as a non-empty bounded string", () => {
    expect(validateSetApiKey({ apiKey: "sk-proj-0123456789" })).toEqual({
      apiKey: "sk-proj-0123456789"
    });
    // Whitespace-only and blank keys are rejected.
    expect(() => validateSetApiKey({ apiKey: "   " })).toThrow(BridgeValidationError);
    expect(() => validateSetApiKey({ apiKey: "" })).toThrow(BridgeValidationError);
    // Non-strings and unknown fields are rejected.
    expect(() => validateSetApiKey({ apiKey: 42 })).toThrow(BridgeValidationError);
    expect(() => validateSetApiKey({ apiKey: "x", provider: "openai" })).toThrow(
      BridgeValidationError
    );
    // Overlong keys are rejected (bounds the encrypted payload).
    expect(() => validateSetApiKey({ apiKey: "x".repeat(4097) })).toThrow(BridgeValidationError);
  });

  it("uses the empty-payload validator for recoveryStatus and secrets presence channels", () => {
    expect(() => validateEmptyPayload({})).not.toThrow();
    expect(() => validateEmptyPayload({ scan: true })).toThrow(BridgeValidationError);
  });
});

describe("error sanitization", () => {
  it("redacts Windows drive paths and UNC paths from messages", () => {
    expect(
      redactPaths("Failed to read C:\\Users\\alice\\Documents\\drawing.pdf")
    ).toBe("Failed to read [path redacted]");
    expect(
      redactPaths("Stored file missing at \\\\server\\share\\drawing.dwg")
    ).toBe("Stored file missing at [path redacted]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactPaths("NOT_FOUND: Drawing d1 was not found")).toBe(
      "NOT_FOUND: Drawing d1 was not found"
    );
  });
});
