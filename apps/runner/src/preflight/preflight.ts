import type {
  PreflightCapability,
  PreflightCheckItem,
  PreflightReport,
  PreflightScenario,
  RunFailureCode,
  SkillIdentity
} from "@swpanel/domain";
import {
  isPreflightScenario,
  PREFLIGHT_CAPABILITIES,
  PREFLIGHT_REPORT_CONTRACT_VERSION
} from "@swpanel/domain";

import { InvalidArgumentError, RunnerInvariantError } from "../errors.js";

/**
 * Phase 5 (P5-1) preflight gate of the Runner (architecture.md §9.2): a Run
 * cannot leave PREPARING unless the nine capability items hold. The gate is
 * deterministic and injectable — scenario selection exists ONLY at Runner
 * construction / test harness configuration (mirroring the Fake Executor /
 * Input Adapter scenario idiom) and is never exposed to the Renderer. The
 * boundary is a probe: `checkCapability(capability, context)` returns the
 * boolean capability result; a probe that THROWS fails that capability closed
 * (redacted) instead of crashing the serial queue.
 *
 * This batch ships the deterministic synthetic probe only: the real
 * environment is externally blocked (no controlled SolidWorks automation yet,
 * no pinned Codex App Server compatibility), so the default product path runs
 * an EXPLICITLY synthetic/unverified fixture (`synthetic: true` report) and
 * never pretends the real probes pass. SolidWorks availability is
 * version-agnostic: any installed SolidWorks that can be driven satisfies the
 * gate, and the actual version is recorded by the builder. The
 * `$solidworks-build-mechanical-models` reference stays a retained Skill text
 * reference but is NOT a gate item — it is never faked as resolved. The hash
 * gate is an EXACT allowlist: the synthetic fixture only ever accepts its own
 * fixture digest (`FAKE_PREFLIGHT_SKILL_SHA256`) — the 0*64 placeholder, any
 * well-formed custom digest and any unknown value all fail closed as
 * SKILL_HASH_MISMATCH, so a placeholder or an unverified custom profile is
 * never silently treated as a verified skill hash.
 */

/** The deterministic synthetic probe scenario of the normal product path. */
export const DEFAULT_PREFLIGHT_SCENARIO: PreflightScenario = "all-pass";

/**
 * The skill digest the synthetic fixture records as its own (the SHA-256 of
 * the marker string `swpanel-fake-preflight-skill-digest`). It is a clearly
 * synthetic value — NOT the external skill digest and NOT a production
 * verification: the default Runner profile pins it as the SOLE digest the
 * synthetic gate accepts, so the default product path passes the gate without
 * silently carrying the 0*64 placeholder — every other digest fails closed.
 */
export const FAKE_PREFLIGHT_SKILL_SHA256 =
  "3cec3dc0adb2fc6ba378f2f6bdd8824b97cc7ee4bf4f353127c69fb6adbbe451" as const;

/** Frozen Skill identity the gate verifies (name + sha256 of the Run snapshot). */
export interface PreflightProbeContext {
  skill: SkillIdentity;
  /**
   * Absolute root of the CURRENT attempt workspace (executor-owned, passed at
   * gate time). Real probes check the writable-workspace capability against
   * the actual attempt root; synthetic fixtures ignore it.
   */
  workspaceRoot?: string;
}

/**
 * The injectable capability probe boundary. Implementations return the
 * boolean capability result deterministically; a THROWN probe is a failed
 * check of that capability (fail closed, redacted). `synthetic` truthfully
 * marks fixture probes that never claim production verification.
 */
export interface PreflightProbe {
  /** True when this probe is a synthetic fixture (never production-verified). */
  readonly synthetic: boolean;
  checkCapability(capability: PreflightCapability, context: PreflightProbeContext): boolean;
}

/**
 * Result of the environment gate (the eight probe-evaluated capabilities).
 * `input_adapter_succeeded` is NOT part of it: the executor marks it only
 * after the input adaptation succeeded, completing the nine-item gate.
 */
export interface PreflightEnvironmentResult {
  /** True when every evaluated environment capability passed. */
  ok: boolean;
  /** The first failing capability of a failed gate (null when the gate passed). */
  failedCapability: PreflightCapability | null;
  /** Ordered redacted checks the gate evaluated (stops at the first failure). */
  checks: readonly PreflightCheckItem[];
}

/**
 * The eight environment capabilities the gate probes — the full nine-item gate
 * minus `input_adapter_succeeded`, which the executor marks after adaptation.
 * The canonical evaluation order of the checks. Conversion availability (e.g.
 * the PDF renderer) is NOT a preflight capability: the adapter probes its
 * renderer at conversion time and `input_adapter_succeeded` — marked by the
 * executor only after the adaptation succeeds — is the conversion gate, never
 * the preflight gate.
 */
export const PREFLIGHT_ENV_CAPABILITIES: readonly PreflightCapability[] =
  PREFLIGHT_CAPABILITIES.filter((capability) => capability !== "input_adapter_succeeded");

/**
 * True when the gate result is internally consistent: a passed result carries
 * the complete canonical eight-check environment evaluation with no failure
 * and no failed capability; a failed result carries the canonical fail-fast
 * prefix ending exactly at its first failing capability. An inconsistent
 * result must fail closed at PREPARING BEFORE adaptation — its checks are
 * unreliable (redacted or fabricated), so nothing derived from them may
 * proceed.
 */
export function isConsistentEnvironmentResult(result: PreflightEnvironmentResult): boolean {
  if (result.ok) {
    return (
      result.failedCapability === null &&
      result.checks.length === PREFLIGHT_ENV_CAPABILITIES.length &&
      result.checks.every(
        (check, index) => check.capability === PREFLIGHT_ENV_CAPABILITIES[index] && check.ok
      )
    );
  }
  if (result.failedCapability === null) return false;
  const failureIndex = PREFLIGHT_ENV_CAPABILITIES.indexOf(result.failedCapability);
  if (failureIndex === -1) return false;
  if (result.checks.length !== failureIndex + 1) return false;
  return result.checks.every((check, index) => {
    if (index === failureIndex) {
      return check.capability === result.failedCapability && check.ok === false;
    }
    return check.capability === PREFLIGHT_ENV_CAPABILITIES[index] && check.ok;
  });
}

/**
 * The injectable preflight gate boundary consumed by the executor at
 * PREPARING. `synthetic` proxies the backing probe so the persisted report can
 * truthfully mark fixture-produced reports.
 */
export interface Preflight {
  readonly synthetic: boolean;
  run(context: PreflightProbeContext): PreflightEnvironmentResult;
}

/**
 * The deterministic fail-fast gate: evaluates the eight environment
 * capabilities in canonical order through the injected probe and stops at the
 * first failure (a probe throw fails that capability closed). The ninth item,
 * `input_adapter_succeeded`, is completed by the executor after adaptation.
 */
export class PreflightGate implements Preflight {
  private readonly probe: PreflightProbe;

  constructor(probe: PreflightProbe) {
    this.probe = probe;
  }

  get synthetic(): boolean {
    return this.probe.synthetic;
  }

  run(context: PreflightProbeContext): PreflightEnvironmentResult {
    const checks: PreflightCheckItem[] = [];
    for (const capability of PREFLIGHT_CAPABILITIES) {
      if (capability === "input_adapter_succeeded") continue; // marked after adaptation
      let ok: boolean;
      try {
        ok = this.probe.checkCapability(capability, context);
      } catch {
        // A thrown probe fails THAT capability closed — the report stays
        // redacted (boolean only) and the serial queue never sees the throw.
        ok = false;
      }
      checks.push({ capability, ok });
      if (!ok) {
        return { ok: false, failedCapability: capability, checks };
      }
    }
    return { ok: true, failedCapability: null, checks };
  }
}

/**
 * Maps the first failing capability onto its accurate Run failure code. Where
 * no dedicated code exists the generic preflight failure applies; capabilities
 * with dedicated codes (runtime / skill / SolidWorks / adapter) always
 * terminate with the most specific code available.
 */
export function mapPreflightFailureCode(capability: PreflightCapability): RunFailureCode {
  switch (capability) {
    case "agent_runtime_available":
    case "agent_runtime_version_supported":
    case "agent_model_supports_image":
      // A runtime that is absent, version-unsupported or lacks image input is
      // not usable for this product: the runtime-unavailable code is the
      // accurate dedicated classification.
      return "AGENT_RUNTIME_UNAVAILABLE";
    case "modeling_skill_discovered":
      return "SKILL_NOT_FOUND";
    case "modeling_skill_hash_allowed":
      return "SKILL_HASH_MISMATCH";
    case "structured_runtime_protocol_available":
      // The runtime protocol is not available / incompatible with the product
      // raw-record protocol: the protocol-incompatible code is the accurate
      // dedicated classification.
      return "AGENT_PROTOCOL_INCOMPATIBLE";
    case "workspace_write_scope_supported":
      // No dedicated workspace-scope failure code exists: generic preflight.
      return "PREFLIGHT_FAILED";
    case "solidworks_available":
      // The gate is version-agnostic: any installed SolidWorks that can be
      // driven satisfies availability; an absent installation is the dedicated
      // unavailable classification (no version is implied or required).
      return "SOLIDWORKS_UNAVAILABLE";
    case "input_adapter_succeeded":
      // The executor marks this item after adaptation; an adapter failure
      // already terminates with the mapped INPUT_UNSUPPORTED /
      // INPUT_ADAPTER_FAILED code through the adapter path.
      return "INPUT_ADAPTER_FAILED";
  }
}

/**
 * Builds the redacted persisted report document. The checks are the evaluated
 * prefix (fail-fast) plus the post-adaptation `input_adapter_succeeded` item
 * when adaptation ran; the report NEVER carries paths, secrets or reasoning.
 * A `passed` report is only possible when all nine capabilities were evaluated
 * and every check passed — anything else is an invariant violation that fails
 * closed (the caller converts the throw into the accurate terminal failure).
 *
 * Persistence invariant: the executor persists a `passed` report ONLY after
 * the COMPLETE PREPARING pipeline succeeded (gate + input adaptation +
 * Invocation Package + prompt writes), so a passed report can never mislead
 * about a later failure. Failure reports persist at the failing point; a
 * post-gate failure (after adaptation succeeded) records all nine evaluated
 * checks with `passed: false` — the failure happened outside the gate items.
 */
export function buildPreflightReport(input: {
  checks: readonly PreflightCheckItem[];
  passed: boolean;
  synthetic: boolean;
  checkedAt: string;
}): PreflightReport {
  if (input.passed) {
    const allTrue = input.checks.every((check) => check.ok);
    if (input.checks.length !== PREFLIGHT_CAPABILITIES.length || !allTrue) {
      throw new RunnerInvariantError(
        "a passed preflight report must evaluate every capability and every check must pass"
      );
    }
  }
  return {
    contractVersion: PREFLIGHT_REPORT_CONTRACT_VERSION,
    passed: input.passed,
    checks: input.checks,
    synthetic: input.synthetic,
    checkedAt: input.checkedAt
  };
}

/** Capability each failing scenario flips (canonical scenario matrix). */
const SCENARIO_FAILING_CAPABILITY: Readonly<Partial<Record<PreflightScenario, PreflightCapability>>> = {
  "agent-runtime-unavailable": "agent_runtime_available",
  "agent-runtime-version-unsupported": "agent_runtime_version_supported",
  "agent-model-no-image-support": "agent_model_supports_image",
  "skill-not-discovered": "modeling_skill_discovered",
  "skill-hash-mismatch": "modeling_skill_hash_allowed",
  "protocol-unavailable": "structured_runtime_protocol_available",
  "workspace-write-unsupported": "workspace_write_scope_supported",
  "solidworks-unavailable": "solidworks_available"
};

export interface FakePreflightProbeOptions {
  /** Deterministic scenario matrix selection (Runner construction / test harness only). */
  scenario: PreflightScenario;
  /**
   * Capability the `probe-throws` scenario throws for (defaults to
   * `agent_runtime_available`). The throw fails that capability closed and is
   * never exposed in the report or failure message.
   */
  throwAtCapability?: PreflightCapability;
}

/**
 * The deterministic synthetic preflight probe of Phase 5 (P5-1). Every result
 * is marked `synthetic` (never production-verified): the fake cannot verify
 * the real environment, so the default path truthfully reports an
 * unverified fixture instead of pretending the real probes pass. The hash gate
 * is an EXACT allowlist: the synthetic fixture only ever accepts its own
 * fixture digest (`FAKE_PREFLIGHT_SKILL_SHA256`) — the 0*64 placeholder, any
 * well-formed custom digest and any unknown value all fail closed as
 * SKILL_HASH_MISMATCH, so a placeholder or an unverified custom profile is
 * never silently treated as a verified skill hash (M1 / P5-2 review fix).
 */
export class FakePreflightProbe implements PreflightProbe {
  readonly synthetic = true;
  private readonly scenario: PreflightScenario;
  private readonly throwAtCapability: PreflightCapability;

  constructor(options: FakePreflightProbeOptions) {
    if (!isPreflightScenario(options.scenario)) {
      throw new InvalidArgumentError(
        `preflightScenario must be a known preflight scenario, got ${String(options.scenario)}`
      );
    }
    this.scenario = options.scenario;
    this.throwAtCapability = options.throwAtCapability ?? "agent_runtime_available";
  }

  checkCapability(capability: PreflightCapability, context: PreflightProbeContext): boolean {
    // Deterministic thrown-probe simulation: fails the chosen capability
    // closed WITHOUT leaking the synthetic error content anywhere.
    if (this.scenario === "probe-throws" && capability === this.throwAtCapability) {
      throw new Error("synthetic preflight probe failure (deterministic probe-throws scenario)");
    }
    // Deterministic scenario failure (takes precedence over the data-driven
    // hash guard so each failing scenario flips exactly one capability).
    if (SCENARIO_FAILING_CAPABILITY[this.scenario] === capability) return false;
    // Data-driven hash gate: the synthetic fixture's allowlist is EXACTLY its
    // own fixture digest — anything else (the 0*64 placeholder, a custom
    // profile hash, an unknown digest) fails closed as SKILL_HASH_MISMATCH.
    if (capability === "modeling_skill_hash_allowed") {
      return context.skill.sha256 === FAKE_PREFLIGHT_SKILL_SHA256;
    }
    return true;
  }
}
