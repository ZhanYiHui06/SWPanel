import { describe, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PreflightCapability } from "@swpanel/domain";

import { makeTempDir, removeTempDir } from "../test-utils.js";
import { PreflightGate, PREFLIGHT_ENV_CAPABILITIES } from "./preflight.js";
import {
  codexVersionProbe,
  FAIL_CLOSED_RUNTIME_PROBE,
  FAIL_CLOSED_SOLIDWORKS_PROBE,
  RealPreflightProbe,
  type CommandRunner,
  type RuntimeProbe,
  type RuntimeProbeResult,
  type SolidWorksProbe,
  type SolidWorksProbeResult
} from "./real-preflight-probe.js";
import type { LiveCodexProbeResult } from "./codex-live-probe.js";
import { hashSkillDirectory } from "./skill-directory-hash.js";

const SKILL_NAME = "solidworks-build-part-from-drawing";
const FULL_RUNTIME: RuntimeProbeResult = {
  available: true,
  version: "0.147.0",
  protocol: "2",
  modelImageInputSupported: true
};
const FULL_SOLIDWORKS: SolidWorksProbeResult = { available: true, version: "2022" };

function runtimeOf(result: Partial<RuntimeProbeResult> = {}): RuntimeProbe {
  return { probe: () => ({ ...FULL_RUNTIME, ...result }) };
}

function solidworksOf(result: Partial<SolidWorksProbeResult> = {}): SolidWorksProbe {
  return { probe: () => ({ ...FULL_SOLIDWORKS, ...result }) };
}

interface SkillFixture {
  dir: string;
  /** Deterministic hash of the CURRENT tree (recompute after edits). */
  hash(): string;
}

/** Opens a temp skill root; `hash()` recomputes the digest of the live tree. */
function openSkill(prefix: string): SkillFixture {
  const dir = makeTempDir(prefix);
  return {
    dir,
    hash: () => hashSkillDirectory(dir)
  };
}

function closeSkill(skill: SkillFixture): void {
  removeTempDir(skill.dir);
}

/** The frozen Skill identity whose sha256 equals the current tree digest. */
function frozenIdentity(skill: SkillFixture, name = SKILL_NAME) {
  return { name, sha256: skill.hash() };
}

/** A REAL writable temp attempt-workspace root. */
function openWorkspace(prefix: string): string {
  const root = makeTempDir(prefix);
  mkdirSync(join(root, "attempt-001"), { recursive: true });
  return join(root, "attempt-001");
}

function probeContext(skill: { name: string; sha256: string }, workspaceRoot?: string) {
  return { skill, ...(workspaceRoot === undefined ? {} : { workspaceRoot }) };
}

function checkAll(probe: RealPreflightProbe, context: ReturnType<typeof probeContext>) {
  const results = new Map<PreflightCapability, boolean>();
  for (const capability of PREFLIGHT_ENV_CAPABILITIES) {
    results.set(capability, probe.checkCapability(capability, context));
  }
  return results;
}

describe("RealPreflightProbe (Batch D real probe, hermetic seams)", () => {
  it("is never synthetic and passes every environment capability with real seams and a matching skill tree", () => {
    const skill = openSkill("realpass-skill");
    const workspace = openWorkspace("realpass-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# solidworks-build-part-from-drawing\n", "utf8");
      writeFileSync(join(skill.dir, "capabilities.yaml"), "name: solidworks-build-part-from-drawing\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        solidworks: solidworksOf()
      });
      expect(probe.synthetic).toBe(false);
      const results = checkAll(probe, probeContext(frozenIdentity(skill), workspace));
      for (const capability of PREFLIGHT_ENV_CAPABILITIES) {
        expect(results.get(capability)).toBe(true);
      }
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("fails closed: runtime unavailable -> agent_runtime_available false", () => {
    const skill = openSkill("real-no-runtime");
    const workspace = openWorkspace("real-no-runtime-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# x\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ available: false, version: null, protocol: null }),
        solidworks: solidworksOf()
      });
      const results = checkAll(probe, probeContext(frozenIdentity(skill), workspace));
      expect(results.get("agent_runtime_available")).toBe(false);
      expect(results.get("agent_runtime_version_supported")).toBe(false);
      expect(results.get("structured_runtime_protocol_available")).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("pins the runtime version exactly: 0.148.0 never passes the 0.147.0 requirement", () => {
    const skill = openSkill("real-version-pin");
    const workspace = openWorkspace("real-version-pin-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# x\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ version: "0.148.0" }),
        solidworks: solidworksOf(),
        expectedRuntimeVersion: "0.147.0"
      });
      const results = checkAll(probe, probeContext(frozenIdentity(skill), workspace));
      expect(results.get("agent_runtime_available")).toBe(true);
      expect(results.get("agent_runtime_version_supported")).toBe(false);
      // Without an explicit pin any version is accepted.
      const unpinned = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ version: "0.148.0" }),
        solidworks: solidworksOf()
      });
      expect(checkAll(unpinned, probeContext(frozenIdentity(skill), workspace)).get("agent_runtime_version_supported")).toBe(true);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("pins the protocol exactly: an unknown protocol never passes the structured-protocol capability", () => {
    const skill = openSkill("real-protocol-pin");
    const workspace = openWorkspace("real-protocol-pin-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# x\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ protocol: null }),
        solidworks: solidworksOf()
      });
      const results = checkAll(probe, probeContext(frozenIdentity(skill), workspace));
      expect(results.get("agent_runtime_available")).toBe(true);
      expect(results.get("structured_runtime_protocol_available")).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("never fakes model image capability: unverifiable fails closed, seams/config can prove it", () => {
    const skill = openSkill("real-image");
    const workspace = openWorkspace("real-image-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# x\n", "utf8");
      // 1. No configuration, seam cannot verify -> FAILS CLOSED (never faked).
      const unverified = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ modelImageInputSupported: null }),
        solidworks: solidworksOf()
      });
      expect(
        unverified.checkCapability(
          "agent_model_supports_image",
          probeContext(frozenIdentity(skill), workspace)
        )
      ).toBe(false);

      // 2. The runtime seam verifies image support -> passes.
      const seamProven = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ modelImageInputSupported: true }),
        solidworks: solidworksOf()
      });
      expect(
        seamProven.checkCapability(
          "agent_model_supports_image",
          probeContext(frozenIdentity(skill), workspace)
        )
      ).toBe(true);

      // 3. Explicit live configuration is authoritative: `true` passes even
      //    when the seam cannot verify...
      const configProven = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ modelImageInputSupported: null }),
        solidworks: solidworksOf(),
        modelImageInputSupported: true
      });
      expect(
        configProven.checkCapability(
          "agent_model_supports_image",
          probeContext(frozenIdentity(skill), workspace)
        )
      ).toBe(true);

      // 4. ...and an explicit `false` FAILS CLOSED even when the seam proves it.
      const configDenied = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ modelImageInputSupported: true }),
        solidworks: solidworksOf(),
        modelImageInputSupported: false
      });
      expect(
        configDenied.checkCapability(
          "agent_model_supports_image",
          probeContext(frozenIdentity(skill), workspace)
        )
      ).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("discovers the skill at the exact configured path: SKILL.md must be a real regular file", () => {
    const workspace = openWorkspace("real-discovery-ws");
    try {
      // Missing directory.
      const missing = new RealPreflightProbe({
        skillRootPath: join(workspace, "no-such-skill"),
        runtime: runtimeOf(),
        solidworks: solidworksOf()
      });
      expect(missing.checkCapability("modeling_skill_discovered", probeContext({ name: SKILL_NAME, sha256: "a".repeat(64) }))).toBe(false);

      // Directory without SKILL.md.
      const bare = openSkill("real-discovery-bare");
      try {
        writeFileSync(join(bare.dir, "capabilities.yaml"), "x\n", "utf8");
        const noMarkdown = new RealPreflightProbe({
          skillRootPath: bare.dir,
          runtime: runtimeOf(),
          solidworks: solidworksOf()
        });
        expect(noMarkdown.checkCapability("modeling_skill_discovered", probeContext({ name: SKILL_NAME, sha256: "a".repeat(64) }))).toBe(false);
      } finally {
        closeSkill(bare);
      }

      // Directory WITH SKILL.md -> discovered.
      const complete = openSkill("real-discovery-complete");
      try {
        writeFileSync(join(complete.dir, "SKILL.md"), "# skill\n", "utf8");
        const discovered = new RealPreflightProbe({
          skillRootPath: complete.dir,
          runtime: runtimeOf(),
          solidworks: solidworksOf()
        });
        expect(discovered.checkCapability("modeling_skill_discovered", probeContext({ name: SKILL_NAME, sha256: "a".repeat(64) }))).toBe(true);
      } finally {
        closeSkill(complete);
      }
    } finally {
      removeTempDir(workspace);
    }
  });

  it("hash equality: exact match passes; content drift, malformed and placeholder frozen digests fail closed", () => {
    const skill = openSkill("real-hash");
    const workspace = openWorkspace("real-hash-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      writeFileSync(join(skill.dir, "capabilities.yaml"), "name: x\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        solidworks: solidworksOf()
      });
      const exact = frozenIdentity(skill);
      expect(probe.checkCapability("modeling_skill_hash_allowed", probeContext(exact, workspace))).toBe(true);

      // Content drift -> the frozen snapshot digest no longer matches.
      writeFileSync(join(skill.dir, "capabilities.yaml"), "name: y\n", "utf8");
      expect(probe.checkCapability("modeling_skill_hash_allowed", probeContext(exact, workspace))).toBe(false);

      // Malformed frozen digest -> fail closed (never a weird match).
      expect(
        probe.checkCapability(
          "modeling_skill_hash_allowed",
          probeContext({ name: SKILL_NAME, sha256: "not-a-digest" }, workspace)
        )
      ).toBe(false);

      // The 0*64 placeholder -> fail closed.
      expect(
        probe.checkCapability(
          "modeling_skill_hash_allowed",
          probeContext({ name: SKILL_NAME, sha256: "0".repeat(64) }, workspace)
        )
      ).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("a symlink in the skill tree fails the hash capability closed (never followed)", () => {
    const skill = openSkill("real-hash-symlink");
    const workspace = openWorkspace("real-hash-symlink-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const frozen = frozenIdentity(skill);
      let linked = false;
      try {
        symlinkSync(join(skill.dir, "SKILL.md"), join(skill.dir, "link.md"), "file");
        linked = lstatSync(join(skill.dir, "link.md")).isSymbolicLink();
      } catch {
        linked = false;
      }
      if (linked) {
        const probe = new RealPreflightProbe({
          skillRootPath: skill.dir,
          runtime: runtimeOf(),
          solidworks: solidworksOf()
        });
        expect(probe.checkCapability("modeling_skill_hash_allowed", probeContext(frozen, workspace))).toBe(false);
        expect(probe.checkCapability("modeling_skill_discovered", probeContext(frozen, workspace))).toBe(true);
      }
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("writable workspace: real probe file write/read/delete succeeds; absent or non-writable roots fail closed", () => {
    const skill = openSkill("real-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        solidworks: solidworksOf()
      });

      // Absent workspace root in the context -> fail closed.
      expect(probe.checkCapability("workspace_write_scope_supported", probeContext({ name: SKILL_NAME, sha256: "a".repeat(64) }))).toBe(false);

      // Non-existent root -> fail closed.
      expect(
        probe.checkCapability(
          "workspace_write_scope_supported",
          probeContext({ name: SKILL_NAME, sha256: "a".repeat(64) }, join(skill.dir, "no-such-attempt"))
        )
      ).toBe(false);

      // A root that is a FILE -> fail closed.
      expect(
        probe.checkCapability(
          "workspace_write_scope_supported",
          probeContext({ name: SKILL_NAME, sha256: "a".repeat(64) }, join(skill.dir, "SKILL.md"))
        )
      ).toBe(false);

      // A REAL writable root -> passes, and no probe file is left behind.
      const workspace = openWorkspace("real-ws-ok");
      try {
        expect(
          probe.checkCapability(
            "workspace_write_scope_supported",
            probeContext({ name: SKILL_NAME, sha256: "a".repeat(64) }, workspace)
          )
        ).toBe(true);
        const leftovers = readdirSync(workspace).filter((name: string) =>
          name.startsWith(".swpanel-write-probe-")
        );
        expect(leftovers).toEqual([]);
      } finally {
        removeTempDir(workspace);
      }
    } finally {
      closeSkill(skill);
    }
  });

  it("SolidWorks availability comes ONLY from the injected seam (unavailable or throwing fails closed)", () => {
    const skill = openSkill("real-sw");
    const workspace = openWorkspace("real-sw-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const context = probeContext(frozenIdentity(skill), workspace);

      const present = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        solidworks: solidworksOf({ available: true, version: "2022" })
      });
      expect(present.checkCapability("solidworks_available", context)).toBe(true);
      expect(present.solidworksSnapshot.version).toBe("2022");

      const absent = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        solidworks: solidworksOf({ available: false, version: null })
      });
      expect(absent.checkCapability("solidworks_available", context)).toBe(false);

      const throwing = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        solidworks: { probe: () => { throw new Error("sw probe exploded"); } }
      });
      expect(throwing.checkCapability("solidworks_available", context)).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("a throwing runtime seam fails the runtime capabilities closed (never crashes the gate)", () => {
    const skill = openSkill("real-runtime-throw");
    const workspace = openWorkspace("real-runtime-throw-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: { probe: () => { throw new Error("runtime probe exploded"); } },
        solidworks: solidworksOf()
      });
      const results = checkAll(probe, probeContext(frozenIdentity(skill), workspace));
      expect(results.get("agent_runtime_available")).toBe(false);
      expect(results.get("agent_runtime_version_supported")).toBe(false);
      expect(results.get("structured_runtime_protocol_available")).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("captures the runtime + SolidWorks snapshots ONCE at construction (deterministic per probe)", () => {
    const skill = openSkill("real-once");
    const workspace = openWorkspace("real-once-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const runtimeSpy = vi.fn(() => FULL_RUNTIME);
      const solidworksSpy = vi.fn(() => FULL_SOLIDWORKS);
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: { probe: runtimeSpy },
        solidworks: { probe: solidworksSpy }
      });
      expect(runtimeSpy).toHaveBeenCalledTimes(1);
      expect(solidworksSpy).toHaveBeenCalledTimes(1);
      // Repeated capability queries never re-probe the seams.
      const context = probeContext(frozenIdentity(skill), workspace);
      probe.checkCapability("agent_runtime_available", context);
      probe.checkCapability("solidworks_available", context);
      expect(runtimeSpy).toHaveBeenCalledTimes(1);
      expect(solidworksSpy).toHaveBeenCalledTimes(1);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("the fail-closed default runtime seam reports nothing (never guesses a runtime exists)", () => {
    expect(FAIL_CLOSED_RUNTIME_PROBE.probe()).toEqual({
      available: false,
      version: null,
      protocol: null,
      modelImageInputSupported: null
    });
  });

  it("integrated with the PreflightGate: a full real pass yields a consistent all-true environment result", () => {
    const skill = openSkill("real-gate-pass");
    const workspace = openWorkspace("real-gate-pass-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const gate = new PreflightGate(
        new RealPreflightProbe({
          skillRootPath: skill.dir,
          runtime: runtimeOf(),
          solidworks: solidworksOf()
        })
      );
      const result = gate.run({ skill: frozenIdentity(skill), workspaceRoot: workspace });
      expect(result.ok).toBe(true);
      expect(result.failedCapability).toBeNull();
      expect(result.checks.map((check) => check.capability)).toEqual(PREFLIGHT_ENV_CAPABILITIES);
      expect(result.checks.every((check) => check.ok)).toBe(true);
      expect(gate.synthetic).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("integrated with the PreflightGate: a runtime failure stops fail-fast with the accurate capability", () => {
    const skill = openSkill("real-gate-fail");
    const workspace = openWorkspace("real-gate-fail-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const gate = new PreflightGate(
        new RealPreflightProbe({
          skillRootPath: skill.dir,
          runtime: runtimeOf({ version: "0.148.0" }),
          solidworks: solidworksOf(),
          expectedRuntimeVersion: "0.147.0"
        })
      );
      const result = gate.run({ skill: frozenIdentity(skill), workspaceRoot: workspace });
      expect(result.ok).toBe(false);
      expect(result.failedCapability).toBe("agent_runtime_version_supported");
      expect(result.checks).toEqual([
        { capability: "agent_runtime_available", ok: true },
        { capability: "agent_runtime_version_supported", ok: false }
      ]);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("rejects an empty skillRootPath at construction (never guesses where the skill lives)", () => {
    expect(() => new RealPreflightProbe({ skillRootPath: "", solidworks: solidworksOf() })).toThrow(
      /skillRootPath/
    );
  });
});

describe("RealPreflightProbe with a live Codex snapshot (liveCodex seam)", () => {
  function liveSnapshot(overrides: Partial<LiveCodexProbeResult> = {}): LiveCodexProbeResult {
    return {
      available: true,
      version: "0.147.0",
      protocol: "2",
      modelImageInputSupported: true,
      skillDiscovered: true,
      skillPathVerified: true,
      codexHome: "C:\\Users\\me\\.codex",
      childPid: 42,
      childClosed: true,
      probedAt: "2026-08-14T00:00:00.000Z",
      ...overrides
    };
  }

  it("a full live snapshot is authoritative: protocol v2, runtime version, image support and exact skill-path discovery pass", () => {
    const skill = openSkill("live-pass-skill");
    const workspace = openWorkspace("live-pass-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# solidworks-build-part-from-drawing\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        // The runtime seam fails closed: the LIVE snapshot is authoritative
        // for everything the round trip proved — never a seam guess.
        runtime: FAIL_CLOSED_RUNTIME_PROBE,
        liveCodex: liveSnapshot()
      });
      const results = checkAll(probe, probeContext(frozenIdentity(skill), workspace));
      expect(results.get("agent_runtime_available")).toBe(true);
      expect(results.get("agent_runtime_version_supported")).toBe(true);
      expect(results.get("structured_runtime_protocol_available")).toBe(true);
      expect(results.get("agent_model_supports_image")).toBe(true);
      expect(results.get("modeling_skill_discovered")).toBe(true);
      expect(results.get("modeling_skill_hash_allowed")).toBe(true);
      expect(results.get("workspace_write_scope_supported")).toBe(true);
      // No SolidWorks seam injected: availability fails closed truthfully.
      expect(results.get("solidworks_available")).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("an unavailable live snapshot fails the runtime/protocol capabilities closed even when the runtime seam reports available", () => {
    const skill = openSkill("live-down-skill");
    const workspace = openWorkspace("live-down-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(), // seam claims everything — never trusted over the live truth
        liveCodex: liveSnapshot({
          available: false,
          version: null,
          protocol: null,
          skillDiscovered: false,
          skillPathVerified: false,
          codexHome: null
        })
      });
      const results = checkAll(probe, probeContext(frozenIdentity(skill), workspace));
      expect(results.get("agent_runtime_available")).toBe(false);
      expect(results.get("agent_runtime_version_supported")).toBe(false);
      expect(results.get("structured_runtime_protocol_available")).toBe(false);
      // The unavailable live snapshot cannot DISPROVE the filesystem
      // discovery — the skill really exists at the configured path.
      expect(results.get("modeling_skill_discovered")).toBe(true);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("an available live snapshot that did NOT verify the exact skill path fails the discovery closed", () => {
    const skill = openSkill("live-mismatch-skill");
    const workspace = openWorkspace("live-mismatch-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      // The skill IS on disk, but Codex's listing found it elsewhere (e.g. a
      // .codex copy) or not at all: the hashed tree and the executed tree are
      // NOT the same tree — fail closed.
      const listedElsewhere = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        liveCodex: liveSnapshot({ skillDiscovered: true, skillPathVerified: false })
      });
      expect(
        listedElsewhere.checkCapability(
          "modeling_skill_discovered",
          probeContext(frozenIdentity(skill), workspace)
        )
      ).toBe(false);

      const notListed = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        liveCodex: liveSnapshot({ skillDiscovered: false, skillPathVerified: false })
      });
      expect(
        notListed.checkCapability(
          "modeling_skill_discovered",
          probeContext(frozenIdentity(skill), workspace)
        )
      ).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("pins the runtime version exactly through the live snapshot", () => {
    const skill = openSkill("live-version-skill");
    const workspace = openWorkspace("live-version-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const probe = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf({ version: "0.147.0" }), // seam says pinned; live says otherwise
        liveCodex: liveSnapshot({ version: "0.148.0" }),
        expectedRuntimeVersion: "0.147.0"
      });
      const results = checkAll(probe, probeContext(frozenIdentity(skill), workspace));
      expect(results.get("agent_runtime_available")).toBe(true);
      expect(results.get("agent_runtime_version_supported")).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("model image support: the live snapshot proves it; explicit config stays authoritative", () => {
    const skill = openSkill("live-image-skill");
    const workspace = openWorkspace("live-image-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const context = probeContext(frozenIdentity(skill), workspace);

      // The live snapshot proves image support -> passes without config.
      const proven = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: FAIL_CLOSED_RUNTIME_PROBE,
        liveCodex: liveSnapshot({ modelImageInputSupported: true })
      });
      expect(proven.checkCapability("agent_model_supports_image", context)).toBe(true);

      // An explicit `false` configuration is authoritative over the live proof.
      const denied = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: FAIL_CLOSED_RUNTIME_PROBE,
        liveCodex: liveSnapshot({ modelImageInputSupported: true }),
        modelImageInputSupported: false
      });
      expect(denied.checkCapability("agent_model_supports_image", context)).toBe(false);

      // A live snapshot that cannot prove image support fails closed (the
      // runtime seam is fail-closed too) — never invented.
      const unproven = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: FAIL_CLOSED_RUNTIME_PROBE,
        liveCodex: liveSnapshot({ modelImageInputSupported: null })
      });
      expect(unproven.checkCapability("agent_model_supports_image", context)).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("the fail-closed SolidWorks default: absent injection reports unavailable, an injected seam reports its truth", () => {
    const skill = openSkill("live-sw-skill");
    const workspace = openWorkspace("live-sw-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const context = probeContext(frozenIdentity(skill), workspace);

      const defaulted = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        liveCodex: liveSnapshot()
      });
      expect(defaulted.checkCapability("solidworks_available", context)).toBe(false);
      expect(FAIL_CLOSED_SOLIDWORKS_PROBE.probe()).toEqual({
        available: false,
        version: null
      });

      const injected = new RealPreflightProbe({
        skillRootPath: skill.dir,
        runtime: runtimeOf(),
        liveCodex: liveSnapshot(),
        solidworks: solidworksOf({ available: true, version: "2025" })
      });
      expect(injected.checkCapability("solidworks_available", context)).toBe(true);
      expect(injected.solidworksSnapshot.version).toBe("2025");
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });

  it("integrated with the PreflightGate: a full live pass (with an injected SolidWorks seam) yields a consistent all-true environment result", () => {
    const skill = openSkill("live-gate-pass");
    const workspace = openWorkspace("live-gate-ws");
    try {
      writeFileSync(join(skill.dir, "SKILL.md"), "# skill\n", "utf8");
      const gate = new PreflightGate(
        new RealPreflightProbe({
          skillRootPath: skill.dir,
          runtime: FAIL_CLOSED_RUNTIME_PROBE,
          liveCodex: liveSnapshot(),
          solidworks: solidworksOf()
        })
      );
      const result = gate.run({ skill: frozenIdentity(skill), workspaceRoot: workspace });
      expect(result.ok).toBe(true);
      expect(result.failedCapability).toBeNull();
      expect(result.checks.map((check) => check.capability)).toEqual(PREFLIGHT_ENV_CAPABILITIES);
      expect(result.checks.every((check) => check.ok)).toBe(true);
      expect(gate.synthetic).toBe(false);
    } finally {
      removeTempDir(workspace);
      closeSkill(skill);
    }
  });
});

describe("codexVersionProbe (real bounded metadata probe, scripted runner)", () => {
  function scriptedRun(outcome: Partial<ReturnType<CommandRunner["run"]>>): CommandRunner {
    return {
      run: () => ({ status: 0, stdout: "", error: null, ...outcome })
    };
  }

  it("reports the runtime available with the pinned 0.147.0 version from the output", () => {
    const probe = codexVersionProbe({ run: scriptedRun({ stdout: "codex 0.147.0\n" }) });
    expect(probe.probe()).toEqual({
      available: true,
      version: "0.147.0",
      protocol: null,
      modelImageInputSupported: null
    });
  });

  it("reports unavailable on a non-zero exit, a spawn error or a thrown runner", () => {
    expect(codexVersionProbe({ run: scriptedRun({ status: 1 }) }).probe().available).toBe(false);
    expect(
      codexVersionProbe({ run: scriptedRun({ status: null, error: "spawn codex ENOENT" }) }).probe()
    ).toEqual({
      available: false,
      version: null,
      protocol: null,
      modelImageInputSupported: null
    });
    const throwing: CommandRunner = { run: () => { throw new Error("boom"); } };
    expect(codexVersionProbe({ run: throwing }).probe().available).toBe(false);
  });

  it("an unparsable version output never claims the pinned version (fail closed)", () => {
    const probe = codexVersionProbe({ run: scriptedRun({ stdout: "some output without a version\n" }) });
    expect(probe.probe()).toEqual({
      available: true,
      version: null,
      protocol: null,
      modelImageInputSupported: null
    });
  });

  it("honors an injected parser and command", () => {
    let seenCommand = "none";
    let seenArgs: readonly string[] | null = null;
    const probe = codexVersionProbe({
      command: "custom-codex",
      run: {
        run: (command, args) => {
          seenCommand = command;
          seenArgs = args;
          return { status: 0, stdout: "v147\n", error: null };
        }
      },
      parseVersion: (stdout) => (stdout.trim() === "v147" ? "0.147.0" : null)
    });
    expect(probe.probe().version).toBe("0.147.0");
    expect(seenCommand).toBe("custom-codex");
    expect(seenArgs).toEqual(["--version"]);
  });
});
