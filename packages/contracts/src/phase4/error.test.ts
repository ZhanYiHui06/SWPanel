import { describe, expect, it } from "vitest";

import {
  ERROR_CONTRACT_VERSION,
  Phase4ContractError,
  validateErrorContract,
  type ErrorContract
} from "../index.js";

function validError(): ErrorContract {
  return {
    contractVersion: ERROR_CONTRACT_VERSION,
    code: "ARTIFACT_MANIFEST_INVALID",
    message: "manifest failed schema validation",
    retryable: false,
    details: { schemaId: "swpanel://contracts/result-manifest/1" }
  };
}

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("error contract", () => {
  it("pins the contract version", () => {
    expect(ERROR_CONTRACT_VERSION).toBe(1);
  });

  it("accepts a well-formed error document and round-trips over JSON", () => {
    const error = validError();
    expect(validateErrorContract(error)).toEqual(error);
    expect(JSON.parse(JSON.stringify(validateErrorContract(error)))).toEqual(error);
  });

  it("accepts a minimal error document without optional fields", () => {
    const error: ErrorContract = {
      contractVersion: ERROR_CONTRACT_VERSION,
      code: "INPUT_ADAPTER_FAILED",
      message: "conversion failed"
    };
    expect(validateErrorContract(error)).toEqual(error);
  });

  it("rejects a contract version mismatch", () => {
    expectCode(
      () => validateErrorContract({ ...validError(), contractVersion: 2 }),
      "VERSION_MISMATCH"
    );
  });

  it("rejects unknown fields", () => {
    expectCode(
      () => validateErrorContract({ ...validError(), stack: "at ..." }),
      "UNKNOWN_FIELD"
    );
  });

  it("rejects an empty code and an empty message", () => {
    expectCode(
      () => validateErrorContract({ ...validError(), code: "" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateErrorContract({ ...validError(), message: "" }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects a non-boolean retryable flag and non-object details", () => {
    expectCode(
      () => validateErrorContract({ ...validError(), retryable: "yes" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateErrorContract({ ...validError(), details: "trace" }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects non-object documents", () => {
    expectCode(() => validateErrorContract(42), "INVALID_CONTRACT");
    expectCode(() => validateErrorContract(null), "INVALID_CONTRACT");
  });
});
