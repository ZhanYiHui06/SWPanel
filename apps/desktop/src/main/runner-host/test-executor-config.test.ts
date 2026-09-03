import { describe, expect, it } from "vitest";

import {
  EMPTY_TEST_EXECUTOR_CONFIG,
  FAKE_EXECUTOR_SCENARIO_ENV,
  FAKE_EXECUTOR_STEP_DELAY_ENV,
  MAX_TEST_LEASE_MS,
  MAX_TEST_STEP_DELAY_MS,
  MIN_TEST_LEASE_MS,
  resolveTestExecutorConfig,
  RUN_LEASE_ENV,
  TestExecutorConfigError
} from "./test-executor-config.js";

const SCENARIO_ENV = FAKE_EXECUTOR_SCENARIO_ENV;
const DELAY_ENV = FAKE_EXECUTOR_STEP_DELAY_ENV;
const LEASE_ENV = RUN_LEASE_ENV;

describe("resolveTestExecutorConfig (Phase 3 P3-6 test-only harness config)", () => {
  it("returns the empty config when no variable is set (production default)", () => {
    expect(resolveTestExecutorConfig({}, { isPackaged: false })).toEqual(
      EMPTY_TEST_EXECUTOR_CONFIG
    );
    expect(resolveTestExecutorConfig({ SOME_OTHER_VAR: "1" }, { isPackaged: true })).toEqual(
      EMPTY_TEST_EXECUTOR_CONFIG
    );
  });

  it("accepts every canonical Fake Executor scenario on an unpackaged launch", () => {
    for (const scenario of [
      "success",
      "clarification",
      "failure",
      "cooperative-cancel",
      "hang",
      "crash",
      "recovery-supported",
      "recovery-unsupported",
      "artifact-validation-failure"
    ] as const) {
      expect(resolveTestExecutorConfig({ [SCENARIO_ENV]: scenario }, { isPackaged: false })).toEqual(
        { scenario, stepDelayMs: undefined, leaseDurationMs: undefined }
      );
    }
  });

  it("accepts a bounded step delay and trims whitespace", () => {
    expect(
      resolveTestExecutorConfig(
        { [SCENARIO_ENV]: "success", [DELAY_ENV]: "  300  " },
        { isPackaged: false }
      )
    ).toEqual({ scenario: "success", stepDelayMs: 300, leaseDurationMs: undefined });
    expect(resolveTestExecutorConfig({ [DELAY_ENV]: "0" }, { isPackaged: false })).toEqual({
      scenario: undefined,
      stepDelayMs: 0,
      leaseDurationMs: undefined
    });
    expect(
      resolveTestExecutorConfig({ [DELAY_ENV]: String(MAX_TEST_STEP_DELAY_MS) }, { isPackaged: false })
    ).toEqual({ scenario: undefined, stepDelayMs: MAX_TEST_STEP_DELAY_MS, leaseDurationMs: undefined });
  });

  it("accepts a bounded lease length (alone or combined)", () => {
    expect(resolveTestExecutorConfig({ [LEASE_ENV]: "1500" }, { isPackaged: false })).toEqual({
      scenario: undefined,
      stepDelayMs: undefined,
      leaseDurationMs: 1500
    });
    expect(
      resolveTestExecutorConfig(
        { [SCENARIO_ENV]: "recovery-supported", [LEASE_ENV]: String(MIN_TEST_LEASE_MS) },
        { isPackaged: false }
      )
    ).toEqual({ scenario: "recovery-supported", stepDelayMs: undefined, leaseDurationMs: MIN_TEST_LEASE_MS });
    expect(
      resolveTestExecutorConfig(
        { [DELAY_ENV]: "250", [LEASE_ENV]: String(MAX_TEST_LEASE_MS) },
        { isPackaged: false }
      )
    ).toEqual({ scenario: undefined, stepDelayMs: 250, leaseDurationMs: MAX_TEST_LEASE_MS });
  });

  it("fails closed on a packaged launch carrying any variable", () => {
    for (const env of [
      { [SCENARIO_ENV]: "success" },
      { [DELAY_ENV]: "300" },
      { [LEASE_ENV]: "1500" },
      { [SCENARIO_ENV]: "failure", [DELAY_ENV]: "100", [LEASE_ENV]: "2000" }
    ]) {
      expect(() => resolveTestExecutorConfig(env, { isPackaged: true })).toThrow(
        TestExecutorConfigError
      );
      expect(() => resolveTestExecutorConfig(env, { isPackaged: true })).toThrow(
        /refused on a packaged launch/
      );
    }
  });

  it.each([
    ["unknown scenario", { [SCENARIO_ENV]: "teleport" }],
    ["non-numeric delay", { [DELAY_ENV]: "fast" }],
    ["negative delay", { [DELAY_ENV]: "-5" }],
    ["fractional delay", { [DELAY_ENV]: "1.5" }],
    ["out-of-bounds delay", { [DELAY_ENV]: String(MAX_TEST_STEP_DELAY_MS + 1) }],
    ["huge delay", { [DELAY_ENV]: "99999999999999999999" }],
    ["zero lease", { [LEASE_ENV]: "0" }],
    ["negative lease", { [LEASE_ENV]: "-100" }],
    ["non-numeric lease", { [LEASE_ENV]: "fast" }],
    ["out-of-bounds lease", { [LEASE_ENV]: String(MAX_TEST_LEASE_MS + 1) }]
  ])("rejects an invalid value: %s", (_label, env) => {
    expect(() => resolveTestExecutorConfig(env, { isPackaged: false })).toThrow(
      TestExecutorConfigError
    );
    expect(() => resolveTestExecutorConfig(env, { isPackaged: false })).toThrow(/must be/);
  });
});
