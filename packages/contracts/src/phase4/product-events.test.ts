import { describe, expect, it } from "vitest";

import { RUN_EVENT_CONTRACT_VERSION } from "@swpanel/domain";
import {
  Phase4ContractError,
  PRODUCT_EVENTS_CONTRACT_VERSION,
  validateProductEvent,
  validateProductEventPayload,
  type InvocationPackage,
  type RuntimeMetadata
} from "../index.js";

function envelope(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    contractVersion: PRODUCT_EVENTS_CONTRACT_VERSION,
    runId: "run-1",
    attemptId: "attempt-1",
    sequence: 3,
    occurredAt: "2026-08-13T10:00:00.000Z",
    ...payload
  };
}

function validRuntimeMetadata(): RuntimeMetadata {
  return {
    contractVersion: 1,
    runtime: {
      adapterId: "codex-app-server",
      adapterVersion: "1.0.0",
      protocol: "codex-app-server",
      protocolVersion: "1",
      modelSupportsImageInput: true
    },
    updatedAt: "2026-08-13T10:00:00.000Z"
  };
}

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("product events contract", () => {
  it("pins the product events version to the canonical run event contract version", () => {
    expect(PRODUCT_EVENTS_CONTRACT_VERSION).toBe(RUN_EVENT_CONTRACT_VERSION);
    expect(PRODUCT_EVENTS_CONTRACT_VERSION).toBe(1);
  });

  it("validates every one of the twelve payload types", () => {
    const payloads: Record<string, unknown>[] = [
      { type: "StageChanged", stage: "MODELING", activity: "创建主要旋转特征" },
      { type: "ActivityUpdated", activity: "解析标题栏" },
      { type: "ProgressUpdated", progressPercent: 42, activity: "规划特征" },
      { type: "ClarificationRequired", clarificationRequestId: "clar-1" },
      { type: "AgentTurnCompleted", turnId: "turn-1" },
      { type: "RuntimeMetadataUpdated", metadata: validRuntimeMetadata() },
      { type: "ResultManifestReceived", manifestRef: "manifest.json" },
      { type: "ArtifactValidationFailed", failureCode: "ARTIFACT_MANIFEST_INVALID" },
      { type: "Completed", modelId: "model-1" },
      { type: "Failed", failureCode: "SOLIDWORKS_UNAVAILABLE", failureMessage: "not installed" },
      { type: "CancellationRequested", reason: "user request" },
      { type: "CancellationConfirmed" }
    ];
    for (const payload of payloads) {
      expect(() => validateProductEventPayload(payload)).not.toThrow();
      expect(() => validateProductEvent(envelope(payload))).not.toThrow();
    }
  });

  it("accepts a Completed event without a modelId (Phase 3 Fake Executor path)", () => {
    const event = envelope({ type: "Completed" });
    expect(validateProductEvent(event).type).toBe("Completed");
  });

  it("round-trips a full event over JSON", () => {
    const event = envelope({
      type: "StageChanged",
      stage: "PACKAGING",
      runtimeThreadId: "thread-9"
    });
    const validated = validateProductEvent(event);
    expect(JSON.parse(JSON.stringify(validated))).toEqual(validated);
  });

  it("rejects a product event contract version mismatch", () => {
    expectCode(
      () => validateProductEvent({ ...envelope({ type: "Completed" }), contractVersion: 2 }),
      "VERSION_MISMATCH"
    );
  });

  it("rejects an unknown event type", () => {
    expectCode(() => validateProductEventPayload({ type: "MagicHappened" }), "INVALID_CONTRACT");
    expectCode(() => validateProductEvent(envelope({ type: "MagicHappened" })), "INVALID_CONTRACT");
  });

  it("rejects unknown fields on every payload type", () => {
    const mutated: Record<string, unknown>[] = [
      { ...envelope({ type: "StageChanged", stage: "ANALYZING" }), extra: 1 },
      { ...envelope({ type: "ActivityUpdated", activity: "a" }), reason: "x" },
      { ...envelope({ type: "ProgressUpdated", progressPercent: 1 }), step: 2 },
      { ...envelope({ type: "ClarificationRequired", clarificationRequestId: "c" }), priority: "high" },
      { ...envelope({ type: "AgentTurnCompleted", turnId: "t" }), tokens: 100 },
      { ...envelope({ type: "RuntimeMetadataUpdated", metadata: validRuntimeMetadata() }), cpu: 1 },
      { ...envelope({ type: "ResultManifestReceived", manifestRef: "m" }), verified: true },
      { ...envelope({ type: "ArtifactValidationFailed", failureCode: "ARTIFACT_MISSING" }), path: "p" },
      { ...envelope({ type: "Completed" }), reviewRequired: true },
      { ...envelope({ type: "Failed", failureCode: "AGENT_TIMEOUT" }), retries: 2 },
      { ...envelope({ type: "CancellationRequested" }), actor: "u" },
      { ...envelope({ type: "CancellationConfirmed" }), by: "system" }
    ];
    for (const event of mutated) {
      expectCode(() => validateProductEvent(event), "UNKNOWN_FIELD");
    }
  });

  it("rejects an unknown stage, an out-of-range progress and unknown failure codes", () => {
    expectCode(
      () => validateProductEventPayload({ type: "StageChanged", stage: "THINKING" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateProductEventPayload({ type: "ProgressUpdated", progressPercent: 101 }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateProductEventPayload({ type: "ProgressUpdated", progressPercent: -1 }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateProductEventPayload({ type: "ArtifactValidationFailed", failureCode: "REBOOTED" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateProductEventPayload({ type: "Failed", failureCode: "CLARIFICATION_REQUIRED_ANYWAY" }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects an invalid RuntimeMetadataUpdated payload", () => {
    expectCode(
      () =>
        validateProductEvent(
          envelope({ type: "RuntimeMetadataUpdated", metadata: { contractVersion: 9 } })
        ),
      "VERSION_MISMATCH"
    );
    expectCode(
      () =>
        validateProductEvent(
          envelope({ type: "RuntimeMetadataUpdated", metadata: { contractVersion: 1 } })
        ),
      "INVALID_CONTRACT"
    );
  });

  it("rejects malformed envelope fields", () => {
    expectCode(
      () => validateProductEvent(envelope({ type: "Completed", sequence: -1 })),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateProductEvent(envelope({ type: "Completed", runId: "" })),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateProductEvent(envelope({ type: "Completed", occurredAt: "not-a-date" })),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateProductEvent({ ...envelope({ type: "Completed" }), attemptId: 42 }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects non-object payloads", () => {
    expectCode(() => validateProductEventPayload("completed"), "INVALID_CONTRACT");
    expectCode(() => validateProductEvent("completed"), "INVALID_CONTRACT");
    expectCode(() => validateProductEvent(null), "INVALID_CONTRACT");
  });

  it("keeps the product events contract distinct from the invocation package", () => {
    // A valid Invocation Package carries no `type` discriminator, so it must
    // never pass the product event validator.
    const invocation = {
      contractVersion: 1,
      runId: "run-1",
      skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) },
      input: { originalArtifactId: "a", imagePath: "p.png", imageSha256: "b".repeat(64) },
      memory: { revisionFacts: [], modelingFeedback: [] },
      workspace: { root: "r", output: "o" },
      execution: { visibility: "background", recordMp4: false }
    } as InvocationPackage;
    expectCode(() => validateProductEvent(invocation), "INVALID_CONTRACT");
    expectCode(() => validateProductEventPayload(invocation), "INVALID_CONTRACT");
  });
});
