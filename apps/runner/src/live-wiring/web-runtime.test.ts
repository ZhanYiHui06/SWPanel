import { describe, expect, it } from "vitest";
import { configureWebRuntime } from "./web-runtime.js";
describe("web runtime configuration", () => {
  it("leaves default production worker unconfigured", async () => {
    const result = await configureWebRuntime({}, "darwin");
    expect(result.runnerConfig).toBeUndefined();
    expect(result.runtime.modelingConfigured).toBe(false);
  });
  it("refuses a live CAD worker on macOS without spawning processes", async () => {
    const result = await configureWebRuntime({ SWPANEL_LIVE_CODEX_SKILL_PATH: "/nonexistent/server-controlled-skill", SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT: "true" }, "darwin");
    expect(result.runnerConfig).toBeUndefined();
    expect(result.runtime.reason).toContain("Windows");
  });
  it("rejects malformed server configuration", async () => {
    await expect(configureWebRuntime({ SWPANEL_LIVE_CODEX_SKILL_PATH: "relative-path" }, "darwin")).rejects.toThrow("absolute path");
  });
});
