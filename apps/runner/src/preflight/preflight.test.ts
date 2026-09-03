import { describe, expect, it } from "vitest";

import type { PreflightCapability, PreflightScenario } from "@swpanel/domain";
import {
  PLACEHOLDER_SKILL_SHA256,
  PREFLIGHT_CAPABILITIES,
  RUN_FAILURE_CODES
} from "@swpanel/domain";

import { InvalidArgumentError, RunnerInvariantError } from "../errors.js";
import {
  buildPreflightReport,
  DEFAULT_PREFLIGHT_SCENARIO,
  FAKE_PREFLIGHT_SKILL_SHA256,
  FakePreflightProbe,
  isConsistentEnvironmentResult,
  mapPreflightFailureCode,
  PREFLIGHT_ENV_CAPABILITIES,
  PreflightGate,
  type Preflight
} from "./preflight.js";

/** Deterministic skill identity the gate verifies (non-placeholder digest). */
const SKILL = { name: "solidworks-build-part-from-drawing", sha256: FAKE_PREFLIGHT_SKILL_SHA256 };

/** The canonical all-true eight-check environment evaluation. */
const ALL_ENV_CHECKS = PREFLIGHT_ENV_CAPABILITIES.map((capability) => ({ capability, ok: true }));

describe("Phase 5 P5-1 preflight gate", () => {
  it("the default product scenario is the synthetic all-pass fixture", () => {
    expect(DEFAULT_PREFLIGHT_SCENARIO).toBe("all-pass");
  });

  it("all-pass evaluates the eight environment capabilities and passes", () => {
    const gate = new PreflightGate(new FakePreflightProbe({ scenario: "all-pass" }));
    const result = gate.run({ skill: SKILL });
    expect(result.ok).toBe(true);
    expect(result.failedCapability).toBeNull();
    expect(result.checks.map((check) => check.capability)).toEqual([
      "agent_runtime_available",
      "agent_runtime_version_supported",
      "agent_model_supports_image",
      "modeling_skill_discovered",
      "modeling_skill_hash_allowed",
      "structured_runtime_protocol_available",
      "workspace_write_scope_supported",
      "solidworks_available"
    ]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("the gate NEVER probes input_adapter_succeeded (marked after adaptation)", () => {
    // A probe that throws on input_adapter_succeeded must never be consulted.
    const probe = {
      synthetic: true,
      checkCapability(capability: PreflightCapability): boolean {
        if (capability === "input_adapter_succeeded") throw new Error("must never be probed");
        return true;
      }
    };
    const gate = new PreflightGate(probe);
    expect(gate.run({ skill: SKILL }).ok).toBe(true);
  });

  it("the synthetic probe is always marked synthetic (never production-verified)", () => {
    expect(new FakePreflightProbe({ scenario: "all-pass" }).synthetic).toBe(true);
    expect(new PreflightGate(new FakePreflightProbe({ scenario: "all-pass" })).synthetic).toBe(
      true
    );
  });

  it("rejects an unknown scenario at construction", () => {
    expect(
      () => new FakePreflightProbe({ scenario: "unknown-scenario" as PreflightScenario })
    ).toThrow(InvalidArgumentError);
  });

  it("the 0*64 placeholder digest NEVER passes the hash gate (M1)", () => {
    const gate = new PreflightGate(new FakePreflightProbe({ scenario: "all-pass" }));
    const result = gate.run({ skill: { name: SKILL.name, sha256: PLACEHOLDER_SKILL_SHA256 } });
    expect(result.ok).toBe(false);
    expect(result.failedCapability).toBe("modeling_skill_hash_allowed");
    expect(result.checks).toEqual([
      { capability: "agent_runtime_available", ok: true },
      { capability: "agent_runtime_version_supported", ok: true },
      { capability: "agent_model_supports_image", ok: true },
      { capability: "modeling_skill_discovered", ok: true },
      { capability: "modeling_skill_hash_allowed", ok: false }
    ]);
  });

  it("the synthetic fixture accepts EXACTLY its own digest and nothing else (P5-2 review fix)", () => {
    const gate = new PreflightGate(new FakePreflightProbe({ scenario: "all-pass" }));
    // The fixture digest is the allowlist: the all-pass gate holds for it.
    expect(gate.run({ skill: SKILL }).ok).toBe(true);
    // Any other digest — a well-formed custom profile hash, the 0*64
    // placeholder, an arbitrary/unknown value — fails closed as
    // SKILL_HASH_MISMATCH, never silently passing the gate.
    for (const digest of [
      "b".repeat(64),
      "c".repeat(64),
      "0".repeat(64),
      "not-a-sha256-digest"
    ]) {
      const result = gate.run({ skill: { name: SKILL.name, sha256: digest } });
      expect(result.ok).toBe(false);
      expect(result.failedCapability).toBe("modeling_skill_hash_allowed");
    }
  });
});

describe("Phase 5 P5-1 gate result consistency", () => {
  it("the environment capability list is the nine-item gate minus input_adapter_succeeded", () => {
    expect(PREFLIGHT_ENV_CAPABILITIES).toHaveLength(8);
    expect(PREFLIGHT_ENV_CAPABILITIES).not.toContain("input_adapter_succeeded");
    expect(PREFLIGHT_ENV_CAPABILITIES).not.toContain("mechanical_execution_dependency_resolved");
    expect([...PREFLIGHT_ENV_CAPABILITIES, "input_adapter_succeeded"]).toEqual(
      PREFLIGHT_CAPABILITIES
    );
  });

  it("accepts a passed result with the complete canonical evaluation", () => {
    expect(
      isConsistentEnvironmentResult({ ok: true, failedCapability: null, checks: ALL_ENV_CHECKS })
    ).toBe(true);
  });

  it("rejects a passed result carrying a failure, missing checks or a failed capability", () => {
    expect(
      isConsistentEnvironmentResult({
        ok: true,
        failedCapability: "solidworks_available",
        checks: ALL_ENV_CHECKS
      })
    ).toBe(false);
    expect(
      isConsistentEnvironmentResult({
        ok: true,
        failedCapability: null,
        checks: ALL_ENV_CHECKS.slice(0, 7)
      })
    ).toBe(false);
    expect(
      isConsistentEnvironmentResult({
        ok: true,
        failedCapability: null,
        checks: ALL_ENV_CHECKS.map((check, index) =>
          index === 0 ? { ...check, ok: false } : check
        )
      })
    ).toBe(false);
    expect(
      isConsistentEnvironmentResult({ ok: true, failedCapability: null, checks: [] })
    ).toBe(false);
  });

  it("accepts a failed result with the canonical fail-fast prefix", () => {
    const prefix = ALL_ENV_CHECKS.slice(0, 4).map((check, index) =>
      index === 3 ? { ...check, ok: false } : check
    );
    expect(
      isConsistentEnvironmentResult({
        ok: false,
        failedCapability: "modeling_skill_discovered",
        checks: prefix
      })
    ).toBe(true);
    // First-capability failure is a single-element prefix.
    expect(
      isConsistentEnvironmentResult({
        ok: false,
        failedCapability: "agent_runtime_available",
        checks: [{ capability: "agent_runtime_available", ok: false }]
      })
    ).toBe(true);
  });

  it("rejects a failed result without its failing capability or with a broken prefix", () => {
    expect(
      isConsistentEnvironmentResult({
        ok: false,
        failedCapability: null,
        checks: [{ capability: "agent_runtime_available", ok: false }]
      })
    ).toBe(false);
    expect(
      isConsistentEnvironmentResult({
        ok: false,
        failedCapability: "agent_runtime_available",
        checks: []
      })
    ).toBe(false);
    // The failure item is not the last evaluated check.
    expect(
      isConsistentEnvironmentResult({
        ok: false,
        failedCapability: "agent_runtime_available",
        checks: [
          { capability: "agent_runtime_available", ok: false },
          { capability: "agent_runtime_version_supported", ok: true }
        ]
      })
    ).toBe(false);
    // The failing check itself claims ok.
    expect(
      isConsistentEnvironmentResult({
        ok: false,
        failedCapability: "agent_runtime_available",
        checks: [{ capability: "agent_runtime_available", ok: true }]
      })
    ).toBe(false);
    // Wrong order / length for the declared failing capability.
    expect(
      isConsistentEnvironmentResult({
        ok: false,
        failedCapability: "agent_runtime_version_supported",
        checks: [{ capability: "agent_runtime_available", ok: false }]
      })
    ).toBe(false);
    // A capability the gate never probes cannot be the declared failure.
    expect(
      isConsistentEnvironmentResult({
        ok: false,
        failedCapability: "input_adapter_succeeded",
        checks: [{ capability: "input_adapter_succeeded", ok: false }]
      })
    ).toBe(false);
  });
});

describe("Phase 5 P5-1 failing scenarios (fail-fast)", () => {
  const SCENARIO_CAPABILITY: Readonly<Record<string, PreflightCapability>> = {
    "agent-runtime-unavailable": "agent_runtime_available",
    "agent-runtime-version-unsupported": "agent_runtime_version_supported",
    "agent-model-no-image-support": "agent_model_supports_image",
    "skill-not-discovered": "modeling_skill_discovered",
    "skill-hash-mismatch": "modeling_skill_hash_allowed",
    "protocol-unavailable": "structured_runtime_protocol_available",
    "workspace-write-unsupported": "workspace_write_scope_supported",
    "solidworks-unavailable": "solidworks_available"
  };

  for (const [scenario, capability] of Object.entries(SCENARIO_CAPABILITY)) {
    it(`${scenario} fails exactly ${capability} and stops at it`, () => {
      const gate = new PreflightGate(
        new FakePreflightProbe({ scenario: scenario as PreflightScenario })
      );
      const result = gate.run({ skill: SKILL });
      expect(result.ok).toBe(false);
      expect(result.failedCapability).toBe(capability);
      // Fail-fast: the checks stop at the first failure — later capabilities
      // were never evaluated.
      const expectedCount = PREFLIGHT_CAPABILITIES.indexOf(capability) + 1;
      expect(result.checks).toHaveLength(expectedCount);
      expect(result.checks.at(-1)).toEqual({ capability, ok: false });
      expect(result.checks.slice(0, -1).every((check) => check.ok)).toBe(true);
    });
  }
});

describe("Phase 5 P5-1 accurate failure mapping", () => {
  const MAPPING: Readonly<Record<PreflightCapability, string>> = {
    agent_runtime_available: "AGENT_RUNTIME_UNAVAILABLE",
    agent_runtime_version_supported: "AGENT_RUNTIME_UNAVAILABLE",
    agent_model_supports_image: "AGENT_RUNTIME_UNAVAILABLE",
    modeling_skill_discovered: "SKILL_NOT_FOUND",
    modeling_skill_hash_allowed: "SKILL_HASH_MISMATCH",
    structured_runtime_protocol_available: "AGENT_PROTOCOL_INCOMPATIBLE",
    workspace_write_scope_supported: "PREFLIGHT_FAILED",
    solidworks_available: "SOLIDWORKS_UNAVAILABLE",
    input_adapter_succeeded: "INPUT_ADAPTER_FAILED"
  };

  for (const capability of PREFLIGHT_CAPABILITIES) {
    it(`maps ${capability} to ${MAPPING[capability]}`, () => {
      expect(mapPreflightFailureCode(capability)).toBe(MAPPING[capability]);
    });
  }

  it("every mapped code is a canonical Run failure code", () => {
    for (const capability of PREFLIGHT_CAPABILITIES) {
      expect(RUN_FAILURE_CODES).toContain(mapPreflightFailureCode(capability));
    }
  });

  it("each failing scenario maps to the accurate dedicated code", () => {
    const gate = new PreflightGate(new FakePreflightProbe({ scenario: "solidworks-unavailable" }));
    const result = gate.run({ skill: SKILL });
    expect(result.ok).toBe(false);
    expect(mapPreflightFailureCode(result.failedCapability as PreflightCapability)).toBe(
      "SOLIDWORKS_UNAVAILABLE"
    );
  });
});

describe("Phase 5 P5-1 thrown probe fails closed", () => {
  it("a throwing probe fails the thrown capability redacted (no error content)", () => {
    const gate = new PreflightGate(
      new FakePreflightProbe({ scenario: "probe-throws", throwAtCapability: "modeling_skill_discovered" })
    );
    const result = gate.run({ skill: SKILL });
    expect(result.ok).toBe(false);
    expect(result.failedCapability).toBe("modeling_skill_discovered");
    // The failed check is boolean-only: no message, no path, no reasoning.
    expect(result.checks.at(-1)).toEqual({ capability: "modeling_skill_discovered", ok: false });
    expect(JSON.stringify(result.checks)).not.toContain("synthetic preflight probe failure");
  });

  it("probe-throws defaults to agent_runtime_available", () => {
    const gate = new PreflightGate(new FakePreflightProbe({ scenario: "probe-throws" }));
    const result = gate.run({ skill: SKILL });
    expect(result.failedCapability).toBe("agent_runtime_available");
    expect(mapPreflightFailureCode(result.failedCapability as PreflightCapability)).toBe(
      "AGENT_RUNTIME_UNAVAILABLE"
    );
  });

  it("a fully throwing gate is an invariant failure of the caller (PREFLIGHT_FAILED)", () => {
    const gate: Preflight = {
      synthetic: true,
      run(): never {
        throw new Error("gate exploded");
      }
    };
    expect(() => gate.run({ skill: SKILL })).toThrow("gate exploded");
  });
});

describe("Phase 5 P5-1 redacted report builder", () => {
  const CHECKS = PREFLIGHT_CAPABILITIES.map((capability) => ({ capability, ok: true }));
  const CHECKED_AT = "2026-08-14T09:00:00.000Z";

  it("builds the redacted report shape for a passed nine-item gate", () => {
    const report = buildPreflightReport({
      checks: CHECKS,
      passed: true,
      synthetic: true,
      checkedAt: CHECKED_AT
    });
    expect(report).toEqual({
      contractVersion: 2,
      passed: true,
      checks: CHECKS,
      synthetic: true,
      checkedAt: CHECKED_AT
    });
  });

  it("never carries paths, secrets or reasoning (boolean checks only)", () => {
    const report = buildPreflightReport({
      checks: [{ capability: "agent_runtime_available", ok: false }],
      passed: false,
      synthetic: true,
      checkedAt: CHECKED_AT
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/[A-Z]:\\/i); // windows absolute paths
    expect(serialized).not.toMatch(/password|token|secret/i);
    expect(serialized).not.toMatch(/C:/i);
    expect(Object.keys(report).sort()).toEqual(
      ["checkedAt", "checks", "contractVersion", "passed", "synthetic"].sort()
    );
  });

  it("a passed report with missing checks is an invariant violation (fails closed)", () => {
    expect(() =>
      buildPreflightReport({
        checks: CHECKS.slice(0, 8),
        passed: true,
        synthetic: true,
        checkedAt: CHECKED_AT
      })
    ).toThrow(RunnerInvariantError);
    expect(() =>
      buildPreflightReport({
        checks: CHECKS.map((check, index) => (index === 0 ? { ...check, ok: false } : check)),
        passed: true,
        synthetic: true,
        checkedAt: CHECKED_AT
      })
    ).toThrow(RunnerInvariantError);
  });

  it("a failed report may carry the evaluated prefix only (fail-fast)", () => {
    const report = buildPreflightReport({
      checks: [
        { capability: "agent_runtime_available", ok: true },
        { capability: "modeling_skill_hash_allowed", ok: false }
      ],
      passed: false,
      synthetic: true,
      checkedAt: CHECKED_AT
    });
    expect(report.passed).toBe(false);
    expect(report.checks).toHaveLength(2);
  });
});
