import { describe, expect, it } from "vitest";

import {
  isCancellationRunEventType,
  isTerminalRunEventType,
  RUN_EVENT_CONTRACT_VERSION,
  RUN_EVENT_TYPES,
  TERMINAL_RUN_EVENT_TYPES,
  type RunEvent
} from "./events.js";

describe("run events", () => {
  it("pins the structured event contract version", () => {
    expect(RUN_EVENT_CONTRACT_VERSION).toBe(1);
  });

  it("defines the structured product event types", () => {
    expect(RUN_EVENT_TYPES).toEqual([
      "StageChanged",
      "ActivityUpdated",
      "ProgressUpdated",
      "ClarificationRequired",
      "AgentTurnCompleted",
      "RuntimeMetadataUpdated",
      "ResultManifestReceived",
      "ArtifactValidationFailed",
      "Completed",
      "Failed",
      "CancellationRequested",
      "CancellationConfirmed"
    ]);
  });

  it("carries the mandatory envelope fields on every event", () => {
    const event: RunEvent = {
      contractVersion: RUN_EVENT_CONTRACT_VERSION,
      runId: "run-1",
      attemptId: "attempt-1",
      sequence: 3,
      occurredAt: "2026-08-10T12:00:00.000Z",
      type: "StageChanged",
      stage: "MODELING",
      activity: "正在创建主要旋转特征"
    };
    expect(event.contractVersion).toBe(1);
    expect(event.runId).toBe("run-1");
    expect(event.type).toBe("StageChanged");
    expect(event.stage).toBe("MODELING");
  });

  it("serializes events over JSON unchanged", () => {
    const event: RunEvent = {
      contractVersion: RUN_EVENT_CONTRACT_VERSION,
      runId: "run-1",
      attemptId: "attempt-1",
      sequence: 5,
      occurredAt: "2026-08-10T12:05:00.000Z",
      type: "Failed",
      failureCode: "SOLIDWORKS_UNAVAILABLE",
      failureMessage: "SolidWorks could not be started"
    };
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it("allows a Phase 3 Completed event without a modelId (Fake Executor publishes no Model)", () => {
    // The Fake Executor COMPLETED path intentionally creates no `models`
    // record; the event must not carry a synthetic dangling modelId.
    const event: RunEvent = {
      contractVersion: RUN_EVENT_CONTRACT_VERSION,
      runId: "run-1",
      attemptId: "attempt-1",
      sequence: 8,
      occurredAt: "2026-08-10T12:10:00.000Z",
      type: "Completed"
    };
    expect(event.type).toBe("Completed");
    expect("modelId" in event).toBe(false);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it("keeps the Phase 5 Completed event shape carrying the published modelId", () => {
    // Phase 5 re-tightens the publish path: a Completed event that publishes a
    // Model still carries the modelId so the Model can trace back to its Run.
    const event: RunEvent = {
      contractVersion: RUN_EVENT_CONTRACT_VERSION,
      runId: "run-1",
      attemptId: "attempt-1",
      sequence: 9,
      occurredAt: "2026-08-10T12:11:00.000Z",
      type: "Completed",
      modelId: "model-1"
    };
    expect(event.modelId).toBe("model-1");
  });

  it("pins the terminal and cancellation event types", () => {
    expect(TERMINAL_RUN_EVENT_TYPES).toEqual([
      "Completed",
      "Failed",
      "ClarificationRequired",
      "CancellationConfirmed"
    ]);
    for (const type of RUN_EVENT_TYPES) {
      expect(isTerminalRunEventType(type)).toBe(TERMINAL_RUN_EVENT_TYPES.includes(type as never));
    }
    expect(isTerminalRunEventType("Completed")).toBe(true);
    expect(isTerminalRunEventType("CancellationRequested")).toBe(false);
    expect(isCancellationRunEventType("CancellationRequested")).toBe(true);
    expect(isCancellationRunEventType("CancellationConfirmed")).toBe(true);
    expect(isCancellationRunEventType("StageChanged")).toBe(false);
  });
});
