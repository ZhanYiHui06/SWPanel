import { describe, expect, it } from "vitest";

import {
  AGENT_TURN_OUTPUT_CONTRACT_VERSION,
  AGENT_TURN_OUTPUT_RESULTS,
  Phase4ContractError,
  RESULT_MANIFEST_CONTRACT_VERSION,
  validateAgentTurnOutput,
  type AgentTurnOutput,
  type ResultManifest
} from "../index.js";

/** Builds a valid artifact reference whose sha256 is a real 64-char hex digest. */
function artifactRef(seed: string) {
  const hex = [...seed].map((char) => char.charCodeAt(0) % 16).map((n) => n.toString(16));
  let sha256 = "";
  while (sha256.length < 64) {
    sha256 += hex.join("");
  }
  return {
    fileName: `${seed}.png`,
    relativePath: `output/${seed}.png`,
    sizeBytes: 1024,
    sha256: sha256.slice(0, 64)
  };
}

function validManifest(): ResultManifest {
  return {
    contractVersion: RESULT_MANIFEST_CONTRACT_VERSION,
    result: "completed",
    solidWorksVersion: "2025",
    units: "mm",
    projectionDecision: "第三角投影",
    featureCount: 12,
    bodyCount: 1,
    rebuildStatus: "PASSED",
    unresolvedAssumptions: [],
    productionVerified: false,
    artifacts: {
      sldprt: artifactRef("sldprt"),
      preview: artifactRef("preview"),
      dimensionLedger: artifactRef("ledger"),
      featurePlan: artifactRef("plan"),
      buildValidationLog: artifactRef("log"),
      builderSource: artifactRef("source")
    }
  };
}

function validCompleted(): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
    result: "completed",
    completed: validManifest()
  };
}

function validClarification(): Record<string, unknown> {
  return {
    contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
    result: "clarification_required",
    questions: [
      { id: "q1", type: "dimension", question: "底板厚度是多少？", hint: "例如 12", unit: "mm" },
      {
        id: "q2",
        type: "choice",
        question: "焊缝处理方式？",
        options: [
          { id: "none", label: "无需焊缝" },
          { id: "full", label: "全周满焊" }
        ]
      }
    ]
  };
}

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("agent turn output contract", () => {
  it("pins the contract version and the two mutually exclusive terminal results", () => {
    expect(AGENT_TURN_OUTPUT_CONTRACT_VERSION).toBe(1);
    expect(AGENT_TURN_OUTPUT_RESULTS).toEqual(["completed", "clarification_required"]);
  });

  it("accepts a completed document whose embedded Result Manifest v1 is valid", () => {
    const output = validateAgentTurnOutput(validCompleted());
    expect(output).toEqual({
      contractVersion: 1,
      result: "completed",
      completed: validManifest()
    });
    // The embedded manifest is the SAME v1 document the Result Manifest
    // validator normalizes (productionVerified always carried).
    expect(output.result).toBe("completed");
    if (output.result !== "completed") throw new Error("expected completed outcome");
    expect(output.completed.productionVerified).toBe(false);
    // Round-trips over JSON.
    expect(JSON.parse(JSON.stringify(validateAgentTurnOutput(validCompleted())))).toEqual(
      validateAgentTurnOutput(validCompleted())
    );
  });

  it("keeps the Result Manifest v1 contract history-compatible (unchanged v1 document)", () => {
    // A v1 manifest document remains accepted exactly as before when embedded:
    // the Agent Turn Output contract must never alter the manifest shape.
    const manifest = validManifest();
    const output = validateAgentTurnOutput(validCompleted());
    if (output.result !== "completed") throw new Error("expected completed outcome");
    expect(output.completed).toEqual(manifest);
    expect(output.completed.contractVersion).toBe(RESULT_MANIFEST_CONTRACT_VERSION);
  });

  it("accepts a clarification document carrying ONLY the strictly validated question set", () => {
    const output = validateAgentTurnOutput(validClarification());
    expect(output).toEqual({
      contractVersion: 1,
      result: "clarification_required",
      questions: validClarification().questions
    });
  });

  it("rejects a document carrying BOTH terminal states (mutually exclusive)", () => {
    expectCode(
      () =>
        validateAgentTurnOutput({
          ...validCompleted(),
          questions: validClarification().questions
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateAgentTurnOutput({
          ...validClarification(),
          completed: validManifest()
        }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects a completed document without the embedded manifest and a clarification without questions", () => {
    const completed = validCompleted();
    delete completed.completed;
    expectCode(() => validateAgentTurnOutput(completed), "INVALID_CONTRACT");
    const clarification = validClarification();
    delete clarification.questions;
    expectCode(() => validateAgentTurnOutput(clarification), "INVALID_CONTRACT");
  });

  it("rejects an empty question set and questions that violate the strict question contract", () => {
    expectCode(
      () => validateAgentTurnOutput({ ...validClarification(), questions: [] }),
      "INVALID_CONTRACT"
    );
    // Illegal choice: a `choice` question without selectable options.
    expectCode(
      () =>
        validateAgentTurnOutput({
          ...validClarification(),
          questions: [{ id: "q1", type: "choice", question: "倒角？" }]
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateAgentTurnOutput({
          ...validClarification(),
          questions: [{ id: "q1", type: "choice", question: "倒角？", options: [] }]
        }),
      "INVALID_CONTRACT"
    );
    // Unknown question type / unknown question field.
    expectCode(
      () =>
        validateAgentTurnOutput({
          ...validClarification(),
          questions: [{ id: "q1", type: "date", question: "when?" }]
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateAgentTurnOutput({
          ...validClarification(),
          questions: [{ id: "q1", type: "text", question: "材料？", source: "agent" }]
        }),
      "UNKNOWN_FIELD"
    );
  });

  it("rejects a completed document whose embedded manifest violates Result Manifest v1", () => {
    // The embedded manifest fails the shared Result Manifest validator, so the
    // whole document is invalid — the success statement is never weakened.
    const broken = validCompleted();
    (broken.completed as Record<string, unknown>).solidWorksVersion = "";
    expectCode(() => validateAgentTurnOutput(broken), "INVALID_CONTRACT");

    const missingArtifact = validCompleted();
    delete (missingArtifact.completed as Record<string, unknown>).artifacts;
    expectCode(() => validateAgentTurnOutput(missingArtifact), "INVALID_CONTRACT");

    const badHash = validCompleted();
    (
      (badHash.completed as Record<string, unknown>).artifacts as Record<string, unknown>
    ).sldprt = { ...artifactRef("sldprt"), sha256: "not-a-digest" };
    expectCode(() => validateAgentTurnOutput(badHash), "INVALID_CONTRACT");
  });

  it("rejects unknown result values, version mismatches, unknown fields and non-objects", () => {
    expectCode(
      () => validateAgentTurnOutput({ ...validCompleted(), result: "partially-done" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateAgentTurnOutput({ ...validCompleted(), contractVersion: 2 }),
      "VERSION_MISMATCH"
    );
    expectCode(
      () => validateAgentTurnOutput({ ...validCompleted(), owner: "runner" }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () => validateAgentTurnOutput({ ...validClarification(), priority: "high" }),
      "UNKNOWN_FIELD"
    );
    expectCode(() => validateAgentTurnOutput("output"), "INVALID_CONTRACT");
    expectCode(() => validateAgentTurnOutput(null), "INVALID_CONTRACT");
  });

  it("normalizes a clarification document through the shared question validator", () => {
    // Optional hint/unit survive; the normalized shape matches the domain type.
    const output = validateAgentTurnOutput(validClarification()) as Extract<
      AgentTurnOutput,
      { result: "clarification_required" }
    >;
    expect(output.questions[0]).toMatchObject({ id: "q1", type: "dimension", unit: "mm" });
    expect(output.questions[1]?.options).toHaveLength(2);
  });
});
