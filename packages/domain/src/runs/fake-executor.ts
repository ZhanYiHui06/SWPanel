/**
 * Scenario matrix of the Phase 3 first-class Fake Executor. Scenario selection
 * is injected exclusively through Runner construction/test harness
 * configuration and is never exposed to the production Renderer as an
 * "arbitrary execution scenario" interface; the normal product path uses the
 * default `success` scenario and the Exit Gate drives the matrix
 * deterministically in tests.
 */
export const FAKE_EXECUTOR_SCENARIOS = [
  "success",
  "clarification",
  "failure",
  "cooperative-cancel",
  "hang",
  "crash",
  "recovery-supported",
  "recovery-unsupported",
  "artifact-validation-failure"
] as const;
export type FakeExecutorScenario = (typeof FAKE_EXECUTOR_SCENARIOS)[number];

/**
 * Scenarios in which the Fake Executor declares its interrupted work safely
 * resumable. Only these may continue from PREPARING/ANALYZING/PLANNING after a
 * recovery decision; every other interrupted attempt fails as an interruption.
 */
export function declaresSafeRecovery(scenario: FakeExecutorScenario): boolean {
  return scenario === "recovery-supported";
}
