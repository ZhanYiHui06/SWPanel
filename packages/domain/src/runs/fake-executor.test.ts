import { describe, expect, it } from "vitest";

import { declaresSafeRecovery, FAKE_EXECUTOR_SCENARIOS, type FakeExecutorScenario } from "./fake-executor.js";

describe("fake executor scenarios", () => {
  it("pins the deterministic scenario matrix", () => {
    expect(FAKE_EXECUTOR_SCENARIOS).toEqual([
      "success",
      "clarification",
      "failure",
      "cooperative-cancel",
      "hang",
      "crash",
      "recovery-supported",
      "recovery-unsupported",
      "artifact-validation-failure"
    ]);
  });

  it("only the recovery-supported scenario declares safe recovery", () => {
    const scenarios = FAKE_EXECUTOR_SCENARIOS.filter(declaresSafeRecovery);
    expect(scenarios).toEqual(["recovery-supported"]);
  });

  it("the default product scenario completes without declaring recovery", () => {
    const scenario: FakeExecutorScenario = "success";
    expect(FAKE_EXECUTOR_SCENARIOS.includes(scenario)).toBe(true);
    expect(declaresSafeRecovery(scenario)).toBe(false);
  });
});
