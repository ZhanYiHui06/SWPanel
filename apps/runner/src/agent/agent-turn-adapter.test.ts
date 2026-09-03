import { describe, expect, it } from "vitest";

import {
  AgentTurnError,
  toAgentTurnAdapter,
  type AgentTurnInput,
  type SyncResultAdapter
} from "./agent-turn-adapter.js";
import { FakeAgentAdapter } from "./fake-agent-adapter.js";
import { RAW_AGENT_RECORDS_VERSION, type RawAgentRecord } from "./raw-agent-records.js";

const RUN = "run-seam-1";
const ATTEMPT_ID = "att-1";
const NOW = "2026-08-14T09:30:00.000Z";

/** Minimal write surface stub. */
const WORKSPACE = {
  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }) {
    return {
      relativePath: input.relativePath,
      absolutePath: `memory://${input.relativePath}`,
      sha256: "0".repeat(64),
      sizeBytes: input.content.byteLength
    };
  }
};

function turnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    runId: RUN,
    attemptId: ATTEMPT_ID,
    attemptSequence: 1,
    workspace: WORKSPACE,
    nowIso: () => NOW,
    recordMp4: false,
    workspaceRoot: "C:\\workspaces\\runs\\run-seam-1\\attempt-001",
    promptText: "prompt",
    localImageAbsolutePath: "C:\\workspaces\\runs\\run-seam-1\\attempt-001\\input\\drawing.png",
    skill: { name: "solidworks-build-part-from-drawing", resolvedPath: "C:\\skills\\skill" },
    ...overrides
  };
}

describe("AgentTurnAdapter seam (P5-3)", () => {
  it("FakeAgentAdapter.runTurn settles with the SAME deterministic records as produceResult in a completed outcome", async () => {
    const adapter = new FakeAgentAdapter();
    const outcome = await adapter.runTurn(turnInput());
    const sync = adapter.produceResult(turnInput());
    expect(outcome).toEqual({ kind: "completed", records: sync });
    expect(outcome.kind).toBe("completed");
    expect(outcome.records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
    // interruptTurn of the instantaneous fake turn is a no-op.
    await expect(adapter.interruptTurn?.({ runId: RUN, attemptId: ATTEMPT_ID })).resolves.toBeUndefined();
  });

  it("FakeAgentAdapter.runTurn settles with the clarification outcome when the harness requests it", async () => {
    const adapter = new FakeAgentAdapter();
    const outcome = await adapter.runTurn(turnInput({ produceClarification: true }));
    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") throw new Error("expected clarification outcome");
    // Runtime records WITHOUT a manifest claim and WITHOUT a
    // clarification_requested record (the orchestrator owns the terminal
    // event, never duplicated from raw content).
    expect(outcome.records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed"
    ]);
    expect(outcome.questions.map((question) => question.type)).toEqual(["dimension", "choice"]);
    expect(outcome.questions[0]).toMatchObject({ question: "底板厚度是多少？", unit: "mm" });
  });

  it("toAgentTurnAdapter wraps a legacy synchronous adapter with an immediately-resolved completed outcome", async () => {
    const syncAdapter: SyncResultAdapter = {
      adapterId: "legacy",
      adapterVersion: "1",
      protocol: "legacy",
      protocolVersion: "1",
      threadIdFor: (runId) => `thread-${runId}`,
      produceResult: (input): readonly RawAgentRecord[] => [
        {
          recordVersion: RAW_AGENT_RECORDS_VERSION,
          type: "turn_completed",
          occurredAt: input.nowIso(),
          threadId: "thread-legacy",
          turnId: "turn-legacy"
        }
      ]
    };
    const turnAdapter = toAgentTurnAdapter(syncAdapter);
    expect("runTurn" in turnAdapter).toBe(true);
    expect("interruptTurn" in turnAdapter).toBe(false); // legacy adapters carry none
    const outcome = await turnAdapter.runTurn(turnInput());
    // A legacy adapter only ever claims completion, never clarification.
    expect(outcome).toEqual({ kind: "completed", records: [expect.any(Object)] });
    expect(outcome.kind).toBe("completed");
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0]).toMatchObject({ type: "turn_completed", turnId: "turn-legacy" });
  });

  it("toAgentTurnAdapter passes an AgentTurnAdapter through unchanged", () => {
    const adapter = new FakeAgentAdapter();
    expect(toAgentTurnAdapter(adapter)).toBe(adapter);
  });

  it("AgentTurnError carries the stable structured code", () => {
    const error = new AgentTurnError("AGENT_TIMEOUT", "the turn timed out");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("AGENT_TIMEOUT");
    expect(error.message).not.toContain("raw reasoning");
  });
});
