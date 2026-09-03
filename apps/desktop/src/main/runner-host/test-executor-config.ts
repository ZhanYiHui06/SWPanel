/**
 * Test-only Fake Executor configuration for the Runner host (Phase 3, P3-6).
 *
 * The deterministic E2E harness may slow down / script the Fake Executor so
 * tests can observe every stage transition, the serial queue and the
 * interruption/recovery behavior live. The ONLY sanctioned channels are these
 * two environment variables:
 *
 * - `SWPANEL_TEST_FAKE_EXECUTOR_SCENARIO` — one of `@swpanel/domain`
 *   `FAKE_EXECUTOR_SCENARIOS` (`success`, `clarification`, `failure`,
 *   `cooperative-cancel`, `hang`, `crash`, `recovery-supported`,
 *   `recovery-unsupported`, `artifact-validation-failure`);
 * - `SWPANEL_TEST_FAKE_EXECUTOR_STEP_DELAY_MS` — a bounded non-negative
 *   integer (<= 5000) delaying each scenario step on the wall clock;
 * - `SWPANEL_TEST_RUN_LEASE_MS` — a bounded positive integer (100..120000)
 *   shortening the Run attempt lease so a quick restart recovers
 *   deterministically instead of waiting the 60s production default.
 *
 * Fail-closed posture (mirrors the `--swpanel-test-runtime-root` contract):
 *
 * - the environment is NEVER consulted on a packaged launch: a packaged app
 *   that carries any of the variables refuses startup with a structured error
 *   instead of silently running a scripted executor;
 * - an unpackaged launch with a malformed/unknown value refuses startup;
 * - with no variable set the resolver returns the empty config and the Runner
 *   keeps its production default (`success`, instant steps, 60s lease).
 *
 * The Renderer can never reach this configuration: no IPC payload, bridge
 * method or renderer channel carries a scenario, delay or lease; the values
 * are read once in the Main process before the Runner host is constructed.
 */

import { FAKE_EXECUTOR_SCENARIOS, type FakeExecutorScenario } from "@swpanel/domain";

/** Env var selecting the deterministic Fake Executor scenario (test launches only). */
export const FAKE_EXECUTOR_SCENARIO_ENV = "SWPANEL_TEST_FAKE_EXECUTOR_SCENARIO" as const;

/** Env var slowing each Fake Executor scenario step (test launches only). */
export const FAKE_EXECUTOR_STEP_DELAY_ENV = "SWPANEL_TEST_FAKE_EXECUTOR_STEP_DELAY_MS" as const;

/** Env var shortening the Run attempt lease for quick-restart recovery tests. */
export const RUN_LEASE_ENV = "SWPANEL_TEST_RUN_LEASE_MS" as const;

/** Upper bound of the accepted step delay (protects against unbounded waits). */
export const MAX_TEST_STEP_DELAY_MS = 5_000 as const;

/** Bounds of the accepted test lease length. */
export const MIN_TEST_LEASE_MS = 100 as const;
export const MAX_TEST_LEASE_MS = 120_000 as const;

export interface TestExecutorConfig {
  readonly scenario: FakeExecutorScenario | undefined;
  readonly stepDelayMs: number | undefined;
  readonly leaseDurationMs: number | undefined;
}

/** Empty config: the Runner keeps the production default (success, instant). */
export const EMPTY_TEST_EXECUTOR_CONFIG: TestExecutorConfig = Object.freeze({
  scenario: undefined,
  stepDelayMs: undefined,
  leaseDurationMs: undefined
});

/** Structured startup failure of the test-only executor configuration. */
export class TestExecutorConfigError extends Error {
  readonly code: "TEST_EXECUTOR_CONFIG_FORBIDDEN_PACKAGED" | "TEST_EXECUTOR_CONFIG_INVALID";

  constructor(code: TestExecutorConfigError["code"], message: string) {
    super(message);
    this.name = "TestExecutorConfigError";
    this.code = code;
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined ? undefined : value.trim();
}

/** Parses one strict bounded integer env value. */
function parseBoundedInt(
  raw: string,
  label: string,
  min: number,
  max: number
): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new TestExecutorConfigError(
      "TEST_EXECUTOR_CONFIG_INVALID",
      `${label} must be a non-negative integer`
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TestExecutorConfigError(
      "TEST_EXECUTOR_CONFIG_INVALID",
      `${label} must be between ${min} and ${max}`
    );
  }
  return parsed;
}

/**
 * Resolves the test-only Fake Executor configuration from the process
 * environment. Returns the empty config when no variable is set. Throws
 * {@link TestExecutorConfigError} when:
 * - any variable is set on a PACKAGED launch (fail closed — never silently
 *   ignore, mirroring the runtime-root contract);
 * - an unpackaged launch carries an unknown scenario name, a non-integer or
 *   out-of-bounds step delay or lease length.
 */
export function resolveTestExecutorConfig(
  env: NodeJS.ProcessEnv,
  options: { isPackaged: boolean }
): TestExecutorConfig {
  const scenarioRaw = readEnv(env, FAKE_EXECUTOR_SCENARIO_ENV);
  const delayRaw = readEnv(env, FAKE_EXECUTOR_STEP_DELAY_ENV);
  const leaseRaw = readEnv(env, RUN_LEASE_ENV);

  if (scenarioRaw === undefined && delayRaw === undefined && leaseRaw === undefined) {
    return EMPTY_TEST_EXECUTOR_CONFIG;
  }
  if (options.isPackaged) {
    throw new TestExecutorConfigError(
      "TEST_EXECUTOR_CONFIG_FORBIDDEN_PACKAGED",
      `${FAKE_EXECUTOR_SCENARIO_ENV}/${FAKE_EXECUTOR_STEP_DELAY_ENV}/${RUN_LEASE_ENV} ` +
        "are test-only and are refused on a packaged launch (never silently ignored)"
    );
  }

  let scenario: FakeExecutorScenario | undefined;
  if (scenarioRaw !== undefined) {
    if (!FAKE_EXECUTOR_SCENARIOS.includes(scenarioRaw as FakeExecutorScenario)) {
      throw new TestExecutorConfigError(
        "TEST_EXECUTOR_CONFIG_INVALID",
        `${FAKE_EXECUTOR_SCENARIO_ENV} must be one of ${FAKE_EXECUTOR_SCENARIOS.join(", ")}`
      );
    }
    scenario = scenarioRaw as FakeExecutorScenario;
  }

  let stepDelayMs: number | undefined;
  if (delayRaw !== undefined) {
    stepDelayMs = parseBoundedInt(delayRaw, FAKE_EXECUTOR_STEP_DELAY_ENV, 0, MAX_TEST_STEP_DELAY_MS);
  }

  let leaseDurationMs: number | undefined;
  if (leaseRaw !== undefined) {
    leaseDurationMs = parseBoundedInt(leaseRaw, RUN_LEASE_ENV, MIN_TEST_LEASE_MS, MAX_TEST_LEASE_MS);
  }

  return { scenario, stepDelayMs, leaseDurationMs };
}
