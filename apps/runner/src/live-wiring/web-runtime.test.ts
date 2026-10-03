import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configureWebRuntime } from "./web-runtime.js";
// Hermetic: never look at the real home directory or the repository skills.
const NO_SKILLS = { bundledRoot: null, homeDir: "/nonexistent-home", cwd: "/nonexistent-cwd" } as const;

describe("web runtime configuration", () => {
  it("leaves default production worker unconfigured", async () => {
    const result = await configureWebRuntime({}, "darwin", "api_key", NO_SKILLS);
    expect(result.runnerConfig).toBeUndefined();
    expect(result.runtime.modelingConfigured).toBe(false);
  });
  it("refuses a live CAD worker on macOS without spawning processes", async () => {
    const result = await configureWebRuntime({ SWPANEL_LIVE_CODEX_SKILL_PATH: "/nonexistent/server-controlled-skill", SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT: "true" }, "darwin", "api_key", NO_SKILLS);
    expect(result.runnerConfig).toBeUndefined();
    expect(result.runtime.reason).toContain("Windows");
    expect(result.runtime.skillPathSource).toBe("configured");
  });
  it("rejects malformed server configuration", async () => {
    await expect(configureWebRuntime({ SWPANEL_LIVE_CODEX_SKILL_PATH: "relative-path" }, "darwin", "api_key", NO_SKILLS)).rejects.toThrow("absolute path");
  });
  it("auto-detects the skill in an agent skills folder when no path is configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "swpanel-runtime-home-"));
    try {
      const skill = join(home, ".agents", "skills", "solidworks-autobuild");
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), "---\nname: solidworks-autobuild\n---\n");
      const result = await configureWebRuntime({}, "darwin", "api_key", { bundledRoot: null, homeDir: home, cwd: "/nonexistent-cwd" });
      expect(result.runtime.skillPath).toBe(skill);
      expect(result.runtime.skillPathSource).toBe("auto-detected");
      expect(result.runtime.reason).toContain("Windows");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("lets an explicit skill path win over detection", async () => {
    const result = await configureWebRuntime({ SWPANEL_LIVE_CODEX_SKILL_PATH: "/explicit/skill" }, "darwin", "api_key", NO_SKILLS);
    expect(result.runtime.skillPath).toBe("/explicit/skill");
    expect(result.runtime.skillPathSource).toBe("configured");
  });
});
