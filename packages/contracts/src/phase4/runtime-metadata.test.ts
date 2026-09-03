import { describe, expect, it } from "vitest";

import {
  Phase4ContractError,
  RUNTIME_METADATA_CONTRACT_VERSION,
  validateRuntimeMetadata,
  type RuntimeMetadata
} from "../index.js";

function validRuntimeMetadata(): RuntimeMetadata {
  return {
    contractVersion: RUNTIME_METADATA_CONTRACT_VERSION,
    runtime: {
      adapterId: "codex-app-server",
      adapterVersion: "1.0.0",
      protocol: "codex-app-server",
      protocolVersion: "1",
      modelId: "codex-mini",
      modelSupportsImageInput: true
    },
    session: { threadId: "thread-1", resumedFromThreadId: "thread-0" },
    resume: { attemptId: "attempt-1", lastAppliedSequence: 7 },
    updatedAt: "2026-08-13T10:00:00.000Z"
  };
}

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("runtime metadata contract", () => {
  it("pins the contract version", () => {
    expect(RUNTIME_METADATA_CONTRACT_VERSION).toBe(1);
  });

  it("accepts a well-formed document and round-trips over JSON", () => {
    const metadata = validRuntimeMetadata();
    expect(validateRuntimeMetadata(metadata)).toEqual(metadata);
    expect(JSON.parse(JSON.stringify(validateRuntimeMetadata(metadata)))).toEqual(metadata);
  });

  it("accepts a minimal document without session and resume", () => {
    const metadata: RuntimeMetadata = {
      contractVersion: RUNTIME_METADATA_CONTRACT_VERSION,
      runtime: {
        adapterId: "codex-app-server",
        adapterVersion: "1.0.0",
        protocol: "codex-app-server",
        protocolVersion: "1",
        modelSupportsImageInput: false
      },
      updatedAt: "2026-08-13T10:00:00.000Z"
    };
    expect(validateRuntimeMetadata(metadata)).toEqual(metadata);
  });

  it("rejects a contract version mismatch", () => {
    const metadata = { ...validRuntimeMetadata(), contractVersion: 2 };
    expectCode(() => validateRuntimeMetadata(metadata), "VERSION_MISMATCH");
  });

  it("rejects unknown fields at every level", () => {
    const metadata = validRuntimeMetadata();
    expectCode(() => validateRuntimeMetadata({ ...metadata, latencyMs: 5 }), "UNKNOWN_FIELD");
    expectCode(
      () => validateRuntimeMetadata({ ...metadata, runtime: { ...metadata.runtime, capabilities: [] } }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () => validateRuntimeMetadata({ ...metadata, session: { ...metadata.session, workspace: "x" } }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () => validateRuntimeMetadata({ ...metadata, resume: { ...metadata.resume, dirty: true } }),
      "UNKNOWN_FIELD"
    );
  });

  it("rejects a missing image-input capability flag", () => {
    const metadata = { ...validRuntimeMetadata(), runtime: { ...validRuntimeMetadata().runtime, modelSupportsImageInput: undefined } } as unknown;
    expectCode(() => validateRuntimeMetadata(metadata), "INVALID_CONTRACT");
  });

  it("rejects a negative resume watermark", () => {
    const metadata = { ...validRuntimeMetadata(), resume: { ...validRuntimeMetadata().resume, lastAppliedSequence: -1 } } as unknown;
    expectCode(() => validateRuntimeMetadata(metadata), "INVALID_CONTRACT");
  });

  it("rejects a non-integer resume watermark", () => {
    const metadata = { ...validRuntimeMetadata(), resume: { ...validRuntimeMetadata().resume, lastAppliedSequence: 1.5 } } as unknown;
    expectCode(() => validateRuntimeMetadata(metadata), "INVALID_CONTRACT");
  });

  it("rejects an invalid updatedAt timestamp", () => {
    const metadata = { ...validRuntimeMetadata(), updatedAt: "yesterday" };
    expectCode(() => validateRuntimeMetadata(metadata), "INVALID_CONTRACT");
  });

  it("rejects non-object documents", () => {
    expectCode(() => validateRuntimeMetadata([]), "INVALID_CONTRACT");
    expectCode(() => validateRuntimeMetadata("metadata"), "INVALID_CONTRACT");
  });
});
