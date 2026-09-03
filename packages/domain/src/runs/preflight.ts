/**
 * Pure data model of the Phase 5 (P5-1) preflight capability gate
 * (architecture.md §9.2). A Run cannot leave PREPARING unless every required
 * capability is true; the first failing capability terminates the attempt with
 * the accurate Run failure code BEFORE input adaptation runs, and
 * `input_adapter_succeeded` is marked true only AFTER the adaptation succeeds.
 *
 * This module is intentionally dependency-free and purely descriptive: the
 * Runner implements the probe behaviour (deterministic synthetic fixture for
 * this batch), the fail-fast gate evaluation and the failure-code mapping; the
 * persisted report document follows the shapes below.
 */

/**
 * The nine capability-gate items in canonical evaluation order (the exact list
 * of architecture.md §9.2, version-agnostic SolidWorks). `input_adapter_succeeded`
 * is the only item the probes do NOT evaluate: it is marked by the executor
 * after input adaptation succeeds, so the gate physically runs BEFORE
 * adaptation for the other eight.
 *
 * `mechanical_execution_dependency_resolved` is deliberately NOT a gate item:
 * the `$solidworks-build-mechanical-models` reference is retained in the Skill
 * text but is not a blocking SWPanel check — it is never faked as resolved.
 * SolidWorks is version-agnostic: the gate requires any available SolidWorks
 * that can be driven, and the actual version is recorded by the builder.
 */
export const PREFLIGHT_CAPABILITIES = [
  "agent_runtime_available",
  "agent_runtime_version_supported",
  "agent_model_supports_image",
  "modeling_skill_discovered",
  "modeling_skill_hash_allowed",
  "structured_runtime_protocol_available",
  "workspace_write_scope_supported",
  "solidworks_available",
  "input_adapter_succeeded"
] as const;
export type PreflightCapability = (typeof PREFLIGHT_CAPABILITIES)[number];

/** True when the value is a canonical preflight capability item. */
export function isPreflightCapability(value: unknown): value is PreflightCapability {
  return (
    typeof value === "string" &&
    (PREFLIGHT_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * Version of the redacted preflight report document persisted at
 * `runtime/preflight-report.json` inside the attempt workspace. v2 = the
 * version-agnostic SolidWorks gate (nine items); v1 reports from older
 * attempts remain historical and are never rewritten.
 */
export const PREFLIGHT_REPORT_CONTRACT_VERSION = 2 as const;

/**
 * One evaluated capability of the gate. Boolean result only: the report NEVER
 * carries paths, secrets or raw reasoning — a failed probe is recorded as
 * `ok: false` without the underlying error content.
 */
export interface PreflightCheckItem {
  capability: PreflightCapability;
  ok: boolean;
}

/**
 * The redacted preflight report persisted at `runtime/preflight-report.json`.
 * Checks are ordered and the gate stops at the first failure (fail-fast), so a
 * failed report contains exactly the evaluated prefix; `passed` is true only
 * when every required capability was evaluated and every check passed.
 */
export interface PreflightReport {
  contractVersion: typeof PREFLIGHT_REPORT_CONTRACT_VERSION;
  passed: boolean;
  checks: readonly PreflightCheckItem[];
  /**
   * True when a synthetic fixture probe produced the report. The default
   * product path of this batch runs the deterministic synthetic probe, so its
   * reports are always marked synthetic and never claim production
   * verification (M1) — the real environment probes are a later batch.
   */
  synthetic: boolean;
  checkedAt: string;
}

/**
 * The explicit 0*64 placeholder digest. The synthetic hash gate fails any Run
 * frozen with it: a placeholder must NEVER be silently treated as a verified
 * skill hash (M1). The default Runner profile therefore pins the synthetic
 * fixture digest, not this placeholder.
 */
export const PLACEHOLDER_SKILL_SHA256 = "0".repeat(64);

/**
 * Deterministic scenarios of the Phase 5 fake preflight probe (P5-1). Scenario
 * selection is injected through Runner construction / test harness
 * configuration, never exposed to the Renderer, and mirrors the Fake Executor /
 * Input Adapter scenario idiom. Each failing scenario flips exactly ONE
 * capability; `probe-throws` simulates a probe that throws for the capability
 * `throwAtCapability` (default `agent_runtime_available`).
 */
export const PREFLIGHT_SCENARIOS = [
  "all-pass",
  "agent-runtime-unavailable",
  "agent-runtime-version-unsupported",
  "agent-model-no-image-support",
  "skill-not-discovered",
  "skill-hash-mismatch",
  "protocol-unavailable",
  "workspace-write-unsupported",
  "solidworks-unavailable",
  "probe-throws"
] as const;
export type PreflightScenario = (typeof PREFLIGHT_SCENARIOS)[number];

/** True when the scenario is a canonical preflight probe scenario. */
export function isPreflightScenario(value: unknown): value is PreflightScenario {
  return (
    typeof value === "string" &&
    (PREFLIGHT_SCENARIOS as readonly string[]).includes(value)
  );
}
