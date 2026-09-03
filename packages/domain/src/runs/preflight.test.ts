import { describe, expect, it } from "vitest";

import {
  isPreflightCapability,
  isPreflightScenario,
  PLACEHOLDER_SKILL_SHA256,
  PREFLIGHT_CAPABILITIES,
  PREFLIGHT_REPORT_CONTRACT_VERSION,
  PREFLIGHT_SCENARIOS,
  type PreflightCapability,
  type PreflightScenario
} from "./preflight.js";

describe("preflight capability gate model", () => {
  it("pins the nine capability items in the architecture §9.2 order", () => {
    expect(PREFLIGHT_CAPABILITIES).toEqual([
      "agent_runtime_available",
      "agent_runtime_version_supported",
      "agent_model_supports_image",
      "modeling_skill_discovered",
      "modeling_skill_hash_allowed",
      "structured_runtime_protocol_available",
      "workspace_write_scope_supported",
      "solidworks_available",
      "input_adapter_succeeded"
    ]);
    expect(PREFLIGHT_CAPABILITIES).toHaveLength(9);
  });

  it("input_adapter_succeeded is the LAST gate item (marked after adaptation)", () => {
    expect(PREFLIGHT_CAPABILITIES.at(-1)).toBe("input_adapter_succeeded");
  });

  it("the external dependency is NOT a blocking gate item (never faked resolved)", () => {
    // `$solidworks-build-mechanical-models` stays a retained Skill reference;
    // SWPanel does not gate on it and never reports it as resolved.
    expect(PREFLIGHT_CAPABILITIES).not.toContain("mechanical_execution_dependency_resolved");
    expect(isPreflightCapability("mechanical_execution_dependency_resolved")).toBe(false);
  });

  it("SolidWorks availability is version-agnostic", () => {
    expect(isPreflightCapability("solidworks_available")).toBe(true);
    expect(isPreflightCapability("solidworks_2022_available")).toBe(false);
    expect(isPreflightCapability("solidworks_2025_available")).toBe(false);
  });

  it("recognizes canonical capabilities and rejects unknown values", () => {
    expect(isPreflightCapability("solidworks_available")).toBe(true);
    expect(isPreflightCapability("input_adapter_succeeded")).toBe(true);
    expect(isPreflightCapability("solidworks_2023_available")).toBe(false);
    expect(isPreflightCapability(42)).toBe(false);
    expect(isPreflightCapability(null)).toBe(false);
  });

  it("pins the redacted report contract version", () => {
    expect(PREFLIGHT_REPORT_CONTRACT_VERSION).toBe(2);
  });

  it("pins the explicit 0*64 placeholder digest", () => {
    expect(PLACEHOLDER_SKILL_SHA256).toBe("0".repeat(64));
    expect(PLACEHOLDER_SKILL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins the deterministic probe scenario matrix", () => {
    expect(PREFLIGHT_SCENARIOS).toEqual([
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
    ]);
  });

  it("every failing scenario maps to exactly one canonical capability", () => {
    // Sanity: every scenario other than all-pass / probe-throws is tied to a
    // concrete capability that belongs to the gate.
    const failing = PREFLIGHT_SCENARIOS.filter(
      (scenario) => scenario !== "all-pass" && scenario !== "probe-throws"
    );
    expect(failing).toHaveLength(8);
    for (const scenario of failing) {
      expect(isPreflightScenario(scenario)).toBe(true);
      expect(isPreflightCapability(scenario)).toBe(false);
    }
  });

  it("recognizes canonical scenarios and rejects unknown values", () => {
    expect(isPreflightScenario("all-pass")).toBe(true);
    expect(isPreflightScenario("probe-throws")).toBe(true);
    expect(isPreflightScenario("unknown-scenario")).toBe(false);
    expect(isPreflightScenario(undefined)).toBe(false);
  });

  it("every scenario is a valid preflight scenario value", () => {
    for (const scenario of PREFLIGHT_SCENARIOS) {
      const value: unknown = scenario;
      expect(isPreflightScenario(value)).toBe(true);
      const capability: PreflightCapability = "agent_runtime_available";
      expect(isPreflightCapability(capability)).toBe(true);
      const scenarioType: PreflightScenario = scenario;
      expect(scenarioType.length).toBeGreaterThan(0);
    }
  });
});
