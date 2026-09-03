import type { SkillIdentity } from "@swpanel/domain";

/**
 * Deterministic mock execution configuration frozen into every Run input
 * snapshot. Values are placeholders until Phase 3/4/5 wire the real Agent
 * Runner, Skill version and Agent runtime configuration.
 */
export const MOCK_SKILL: SkillIdentity = Object.freeze({
  name: "solidworks-build-part-from-drawing",
  sha256: "d3adbeefc0ffee00000000000000000000000000000000000000000000000000"
});

export const MOCK_PROMPT_TEMPLATE_VERSION = "1.0.0";

export const MOCK_AGENT_CONFIG_ID = "codex-app-server";

/**
 * Trusted reviewer identity snapshot used by mock reviews. The MVP records the
 * current Windows user; the mock keeps a single stable placeholder.
 */
export const MOCK_REVIEWER_ID = "current-windows-user";

/** Single deterministic Agent attempt id used by all mock Run events. */
export const MOCK_ATTEMPT_ID = "attempt-1";

/**
 * Formula version stamped on mock cost snapshots. This is a visual-only mock
 * label; the deterministic cost engine (Phase 7) owns the real formula version.
 */
export const MOCK_FORMULA_VERSION = "visual-mock-1";
