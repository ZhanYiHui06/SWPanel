import { describe, expect, it } from "vitest";

import {
  INVOCATION_PACKAGE_CONTRACT_VERSION,
  Phase4ContractError,
  validateInvocationPackage,
  type InvocationPackage
} from "../index.js";

function validInvocationPackage(): InvocationPackage {
  return {
    contractVersion: INVOCATION_PACKAGE_CONTRACT_VERSION,
    runId: "run-1",
    skill: {
      name: "solidworks-build-part-from-drawing",
      sha256: "a".repeat(64)
    },
    input: {
      originalArtifactId: "artifact-1",
      imagePath: "attempts/run-1/input/page-1.png",
      imageSha256: "b".repeat(64)
    },
    memory: {
      revisionFacts: [
        {
          id: "fact-1",
          revisionId: "rev-1",
          field: "中心孔深度",
          value: "85 mm",
          source: "USER_SUPPLEMENT",
          createdAt: "2026-08-13T10:00:00.000Z"
        }
      ],
      modelingFeedback: [
        {
          id: "fb-1",
          revisionId: "rev-1",
          content: "do not invent hidden features",
          source: "USER_SUPPLEMENT",
          createdAt: "2026-08-13T10:00:00.000Z"
        }
      ]
    },
    workspace: { root: "C:\\workspace\\run-1", output: "C:\\workspace\\run-1\\out" },
    execution: { visibility: "background", recordMp4: false }
  };
}

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("invocation package contract", () => {
  it("pins the contract version", () => {
    expect(INVOCATION_PACKAGE_CONTRACT_VERSION).toBe(1);
  });

  it("accepts a well-formed package and round-trips over JSON", () => {
    const package_ = validInvocationPackage();
    expect(validateInvocationPackage(package_)).toEqual(package_);
    expect(JSON.parse(JSON.stringify(validateInvocationPackage(package_)))).toEqual(package_);
  });

  it("accepts an optional clarification-derived revision fact with sourceRunId", () => {
    const package_ = validInvocationPackage();
    package_.memory.revisionFacts = [
      {
        id: "fact-2",
        revisionId: "rev-1",
        field: "材料",
        value: "42CrMo",
        unit: "mm",
        source: "CLARIFICATION",
        sourceRunId: "run-0",
        createdAt: "2026-08-13T11:00:00.000Z",
        createdBy: "user-1"
      }
    ];
    expect(validateInvocationPackage(package_)).toEqual(package_);
  });

  it("rejects a contract version mismatch", () => {
    const package_ = { ...validInvocationPackage(), contractVersion: 2 };
    expectCode(() => validateInvocationPackage(package_), "VERSION_MISMATCH");
  });

  it("rejects unknown top-level fields", () => {
    const package_ = { ...validInvocationPackage(), prompt: "do not inject" } as unknown;
    expectCode(() => validateInvocationPackage(package_), "UNKNOWN_FIELD");
  });

  it("rejects unknown fields inside nested objects", () => {
    const package_ = validInvocationPackage();
    const withUnknownSkill = { ...package_, skill: { ...package_.skill, model: "gpt-x" } } as unknown;
    expectCode(() => validateInvocationPackage(withUnknownSkill), "UNKNOWN_FIELD");
    const withUnknownInput = { ...package_, input: { ...package_.input, password: "x" } } as unknown;
    expectCode(() => validateInvocationPackage(withUnknownInput), "UNKNOWN_FIELD");
    const withUnknownWorkspace = { ...package_, workspace: { ...package_.workspace, tmp: "/" } } as unknown;
    expectCode(() => validateInvocationPackage(withUnknownWorkspace), "UNKNOWN_FIELD");
    const withUnknownExecution = { ...package_, execution: { ...package_.execution, live: true } } as unknown;
    expectCode(() => validateInvocationPackage(withUnknownExecution), "UNKNOWN_FIELD");
  });

  it("rejects a malformed skill sha256", () => {
    const package_ = { ...validInvocationPackage(), skill: { ...validInvocationPackage().skill, sha256: "xyz" } } as unknown;
    expectCode(() => validateInvocationPackage(package_), "INVALID_CONTRACT");
  });

  it("rejects an illegal execution visibility", () => {
    const package_ = { ...validInvocationPackage(), execution: { visibility: "live", recordMp4: false } } as unknown;
    expectCode(() => validateInvocationPackage(package_), "INVALID_CONTRACT");
  });

  it("rejects an unknown revision fact field and an illegal fact source", () => {
    const package_ = validInvocationPackage();
    const factWithUnknown = {
      ...package_,
      memory: {
        ...package_.memory,
        revisionFacts: [{ ...package_.memory.revisionFacts[0], confidence: 0.9 }]
      }
    } as unknown;
    expectCode(() => validateInvocationPackage(factWithUnknown), "UNKNOWN_FIELD");
    const factWithBadSource = {
      ...package_,
      memory: {
        ...package_.memory,
        revisionFacts: [{ ...package_.memory.revisionFacts[0], source: "AGENT_GUESS" }]
      }
    } as unknown;
    expectCode(() => validateInvocationPackage(factWithBadSource), "INVALID_CONTRACT");
  });

  it("rejects an unknown modeling feedback field and an illegal feedback source", () => {
    const package_ = validInvocationPackage();
    const feedbackWithUnknown = {
      ...package_,
      memory: {
        ...package_.memory,
        modelingFeedback: [{ ...package_.memory.modelingFeedback[0], severity: "high" }]
      }
    } as unknown;
    expectCode(() => validateInvocationPackage(feedbackWithUnknown), "UNKNOWN_FIELD");
    const feedbackWithBadSource = {
      ...package_,
      memory: {
        ...package_.memory,
        modelingFeedback: [{ ...package_.memory.modelingFeedback[0], source: "SOLIDWORKS_LOG" }]
      }
    } as unknown;
    expectCode(() => validateInvocationPackage(feedbackWithBadSource), "INVALID_CONTRACT");
  });

  it("rejects memory fields that are not arrays", () => {
    const package_ = { ...validInvocationPackage(), memory: { revisionFacts: "none", modelingFeedback: [] } } as unknown;
    expectCode(() => validateInvocationPackage(package_), "INVALID_CONTRACT");
  });

  it("rejects a non-object package and empty required strings", () => {
    expectCode(() => validateInvocationPackage("package"), "INVALID_CONTRACT");
    expectCode(() => validateInvocationPackage(null), "INVALID_CONTRACT");
    const emptyRunId = { ...validInvocationPackage(), runId: "" } as unknown;
    expectCode(() => validateInvocationPackage(emptyRunId), "INVALID_CONTRACT");
  });
});
