import { describe, expect, it } from "vitest";

import type { RunEventPayload } from "@swpanel/domain";
import { validateProductEventPayload } from "@swpanel/contracts";

import { RAW_AGENT_RECORDS_VERSION } from "./raw-agent-records.js";
import {
  translateRawAgentRecords,
  type RawTranslationResult
} from "./product-event-translator.js";

const T0 = "2026-08-13T09:00:00.000Z";
const T1 = "2026-08-13T09:01:00.000Z";
const T2 = "2026-08-13T09:02:00.000Z";
const CONTEXT = { attemptId: "att-1" };

function base(type: string, occurredAt = T0): Record<string, unknown> {
  return {
    recordVersion: RAW_AGENT_RECORDS_VERSION,
    type,
    occurredAt,
    threadId: "thread-1"
  };
}

/** Asserts every payload of an ok translation passes the shared strict validator. */
function expectValidated(result: RawTranslationResult): RunEventPayload[] {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok translation");
  for (const payload of result.payloads) {
    expect(() => validateProductEventPayload(payload)).not.toThrow();
  }
  return [...result.payloads];
}

describe("translateRawAgentRecords success stream", () => {
  it("maps the allowed record types onto validated product event payloads in order", () => {
    const result = translateRawAgentRecords(
      [
        base("session_started"),
        { ...base("metadata_updated"), adapterId: "codex-app-server", adapterVersion: "1", protocol: "codex-app-server", protocolVersion: "1", modelSupportsImageInput: true },
        { ...base("stage_changed", T1), stage: "MODELING", activity: "SolidWorks 建模中" },
        { ...base("activity_updated", T1), activity: "SolidWorks 建模中" },
        { ...base("progress_updated", T1), progressPercent: 66, activity: "SolidWorks 建模中" },
        { ...base("turn_completed", T2), turnId: "turn-1", summary: "technical reasoning (never a product event)" },
        { ...base("result_manifest", T2), manifestRef: "output/result-manifest.json" },
        { ...base("runtime_log", T2), level: "info", message: "technical log line" }
      ],
      CONTEXT
    );
    const payloads = expectValidated(result);
    expect(payloads.map((payload) => payload.type)).toEqual([
      "RuntimeMetadataUpdated",
      "StageChanged",
      "ActivityUpdated",
      "ProgressUpdated",
      "AgentTurnCompleted",
      "ResultManifestReceived"
    ]);
    // Technical-only records produced no product event (session_started,
    // runtime_log) and the summary never leaked into a payload.
    expect(payloads.some((payload) => JSON.stringify(payload).includes("technical reasoning"))).toBe(false);
    const metadata = payloads[0];
    if (metadata?.type !== "RuntimeMetadataUpdated") throw new Error("expected metadata payload");
    expect(metadata.metadata).toMatchObject({
      contractVersion: 1,
      runtime: { adapterId: "codex-app-server", modelSupportsImageInput: true },
      session: { threadId: "thread-1" },
      updatedAt: T0
    });
    const stage = payloads[1];
    if (stage?.type !== "StageChanged") throw new Error("expected stage payload");
    expect(stage).toMatchObject({ type: "StageChanged", stage: "MODELING", activity: "SolidWorks 建模中" });
    const manifest = payloads.at(-1);
    expect(manifest).toMatchObject({
      type: "ResultManifestReceived",
      manifestRef: "output/result-manifest.json"
    });
  });

  it("carries the resume watermark (attempt id from context, never from the record)", () => {
    const result = translateRawAgentRecords(
      [
        {
          ...base("metadata_updated"),
          adapterId: "codex-app-server",
          adapterVersion: "1",
          protocol: "codex-app-server",
          protocolVersion: "1",
          modelSupportsImageInput: false,
          resumedFromThreadId: "thread-0",
          lastAppliedSequence: 12
        }
      ],
      { attemptId: "att-9" }
    );
    const payloads = expectValidated(result);
    const metadata = payloads[0];
    if (metadata?.type !== "RuntimeMetadataUpdated") throw new Error("expected metadata payload");
    expect(metadata.metadata).toMatchObject({
      session: { threadId: "thread-1", resumedFromThreadId: "thread-0" },
      resume: { attemptId: "att-9", lastAppliedSequence: 12 }
    });
  });

  it("translates a clarification request into the ClarificationRequired payload", () => {
    const result = translateRawAgentRecords(
      [
        {
          ...base("clarification_requested"),
          clarificationRequestId: "req-1",
          questions: [{ text: "底板厚度是多少？" }]
        }
      ],
      CONTEXT
    );
    const payloads = expectValidated(result);
    expect(payloads[0]).toMatchObject({
      type: "ClarificationRequired",
      clarificationRequestId: "req-1"
    });
  });

  it("accepts an interrupted / crash stream that stops before a manifest (orchestrator owns terminality)", () => {
    const result = translateRawAgentRecords(
      [
        { ...base("stage_changed"), stage: "ANALYZING" },
        { ...base("progress_updated"), progressPercent: 33 }
      ],
      CONTEXT
    );
    expectValidated(result);
  });
});

describe("translateRawAgentRecords failures", () => {
  it("rejects an unsupported raw protocol version with RAW_RECORD_UNSUPPORTED_VERSION", () => {
    const result = translateRawAgentRecords([{ ...base("turn_completed"), recordVersion: 999, turnId: "t" }], CONTEXT);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "RAW_RECORD_UNSUPPORTED_VERSION", recordIndex: 0 }
    });
  });

  it("rejects an unknown raw type with RAW_RECORD_UNKNOWN_TYPE", () => {
    const result = translateRawAgentRecords([{ ...base("surprise_event") }], CONTEXT);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "RAW_RECORD_UNKNOWN_TYPE", recordIndex: 0 }
    });
  });

  it("rejects a non-object record as malformed", () => {
    const result = translateRawAgentRecords(["not-an-object"], CONTEXT);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "RAW_RECORD_MALFORMED", recordIndex: 0 }
    });
  });

  it("rejects malformed payloads with RAW_RECORD_MALFORMED", () => {
    const cases: unknown[] = [
      { ...base("stage_changed"), stage: "NOT_A_STAGE" },
      { ...base("activity_updated"), activity: "" },
      { ...base("progress_updated"), progressPercent: 101 },
      { ...base("progress_updated"), progressPercent: 12.5 },
      { ...base("turn_completed"), turnId: 42 },
      { ...base("metadata_updated"), adapterId: "x", adapterVersion: "1", protocol: "p", protocolVersion: "1", modelSupportsImageInput: "yes" },
      { ...base("clarification_requested") },
      { ...base("turn_completed"), occurredAt: "not-a-timestamp", turnId: "t" }
    ];
    for (const record of cases) {
      const result = translateRawAgentRecords([record], CONTEXT);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.failure.code).toBe("RAW_RECORD_MALFORMED");
      expect(result.failure.recordIndex).toBe(0);
    }
    // A manifest with an empty ref after a completed turn is MALFORMED (a
    // manifest before any turn is a separate OUT_OF_ORDER case above).
    const emptyRef = translateRawAgentRecords(
      [
        { ...base("turn_completed"), turnId: "turn-1" },
        { ...base("result_manifest"), manifestRef: "" }
      ],
      CONTEXT
    );
    expect(emptyRef).toMatchObject({
      ok: false,
      failure: { code: "RAW_RECORD_MALFORMED", recordIndex: 1 }
    });
  });

  it("rejects an out-of-order timestamp stream with RAW_RECORD_OUT_OF_ORDER", () => {
    const result = translateRawAgentRecords(
      [
        { ...base("stage_changed", T1), stage: "ANALYZING" },
        { ...base("progress_updated", T0), progressPercent: 10 }
      ],
      CONTEXT
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "RAW_RECORD_OUT_OF_ORDER", recordIndex: 1 }
    });
  });

  it("rejects a manifest claim before any completed turn with RAW_RECORD_OUT_OF_ORDER", () => {
    const result = translateRawAgentRecords(
      [{ ...base("result_manifest"), manifestRef: "output/result-manifest.json" }],
      CONTEXT
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "RAW_RECORD_OUT_OF_ORDER", recordIndex: 0 }
    });
  });

  it("fails fast at the first offending record and reports its index", () => {
    const result = translateRawAgentRecords(
      [
        { ...base("activity_updated"), activity: "ok" },
        { ...base("activity_updated"), activity: 7 },
        { ...base("turn_completed"), turnId: "never-reached" }
      ],
      CONTEXT
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "RAW_RECORD_MALFORMED", recordIndex: 1 }
    });
  });
});
