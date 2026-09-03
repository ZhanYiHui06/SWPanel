import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { CODEX_APP_SERVER_COMMAND } from "@swpanel/runner";

import {
  EMPTY_LIVE_CODEX_CONFIG,
  LIVE_CODEX_DEFAULT_SKILL_NAME,
  LIVE_CODEX_EXECUTABLE_ENV,
  LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV,
  LIVE_CODEX_SKILL_NAME_ENV,
  LIVE_CODEX_SKILL_PATH_ENV,
  LIVE_CODEX_SKILLS_FORCE_RELOAD_ENV,
  LiveCodexConfigError,
  resolveLiveCodexConfig
} from "./live-codex-config.js";

const SKILL_PATH = join("C:", "skills", "solidworks-build-part-from-drawing");

describe("resolveLiveCodexConfig (Phase 5 review-finding-9 live discovery config)", () => {
  it("returns the empty config when no variable is set (default synthetic path unchanged)", () => {
    expect(resolveLiveCodexConfig({}, { isPackaged: false })).toEqual(EMPTY_LIVE_CODEX_CONFIG);
    expect(
      resolveLiveCodexConfig({ SOME_UNRELATED_VAR: "1" }, { isPackaged: true })
    ).toEqual(EMPTY_LIVE_CODEX_CONFIG);
  });

  it("enables live discovery from the skill path with the documented defaults", () => {
    const config = resolveLiveCodexConfig(
      { [LIVE_CODEX_SKILL_PATH_ENV]: SKILL_PATH },
      { isPackaged: false }
    );
    expect(config).toEqual({
      enabled: true,
      executable: CODEX_APP_SERVER_COMMAND,
      skillName: LIVE_CODEX_DEFAULT_SKILL_NAME,
      skillPath: SKILL_PATH,
      modelImageInputSupported: undefined,
      forceReloadSkills: false
    });
  });

  it("honors the executable, skill name, image support and force-reload overrides", () => {
    const config = resolveLiveCodexConfig(
      {
        [LIVE_CODEX_EXECUTABLE_ENV]: "C:\\codex\\codex.exe",
        [LIVE_CODEX_SKILL_NAME_ENV]: "custom-skill",
        [LIVE_CODEX_SKILL_PATH_ENV]: SKILL_PATH,
        [LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV]: "true",
        [LIVE_CODEX_SKILLS_FORCE_RELOAD_ENV]: "true"
      },
      { isPackaged: false }
    );
    expect(config.executable).toBe("C:\\codex\\codex.exe");
    expect(config.skillName).toBe("custom-skill");
    expect(config.skillPath).toBe(SKILL_PATH);
    expect(config.modelImageInputSupported).toBe(true);
    expect(config.forceReloadSkills).toBe(true);
  });

  it("refuses the configuration on a packaged launch (never silently ignored)", () => {
    expect(() =>
      resolveLiveCodexConfig(
        { [LIVE_CODEX_SKILL_PATH_ENV]: SKILL_PATH },
        { isPackaged: true }
      )
    ).toThrow(LiveCodexConfigError);
    expect(() =>
      resolveLiveCodexConfig(
        { [LIVE_CODEX_SKILL_PATH_ENV]: SKILL_PATH },
        { isPackaged: true }
      )
    ).toThrow(/refused on a packaged launch/);
    expect(() =>
      resolveLiveCodexConfig(
        { [LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV]: "true" },
        { isPackaged: true }
      )
    ).toThrow(LiveCodexConfigError);
  });

  it("refuses startup when the skill path is missing, non-absolute or empty", () => {
    // Any live variable without the required skill path -> refuse.
    expect(() =>
      resolveLiveCodexConfig(
        { [LIVE_CODEX_EXECUTABLE_ENV]: "codex" },
        { isPackaged: false }
      )
    ).toThrow(/required/);

    expect(() =>
      resolveLiveCodexConfig(
        { [LIVE_CODEX_SKILL_PATH_ENV]: "relative/skill" },
        { isPackaged: false }
      )
    ).toThrow(/absolute path/);

    expect(() =>
      resolveLiveCodexConfig(
        { [LIVE_CODEX_SKILL_PATH_ENV]: "   " },
        { isPackaged: false }
      )
    ).toThrow(/absolute path/);
  });

  it("refuses malformed boolean values", () => {
    expect(() =>
      resolveLiveCodexConfig(
        {
          [LIVE_CODEX_SKILL_PATH_ENV]: SKILL_PATH,
          [LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV]: "yes"
        },
        { isPackaged: false }
      )
    ).toThrow(/true.*false/);

    expect(() =>
      resolveLiveCodexConfig(
        {
          [LIVE_CODEX_SKILL_PATH_ENV]: SKILL_PATH,
          [LIVE_CODEX_SKILLS_FORCE_RELOAD_ENV]: "1"
        },
        { isPackaged: false }
      )
    ).toThrow(/true.*false/);
  });

  it("trims surrounding whitespace of the configured values", () => {
    const config = resolveLiveCodexConfig(
      {
        [LIVE_CODEX_SKILL_PATH_ENV]: `  ${SKILL_PATH}  `,
        [LIVE_CODEX_SKILL_NAME_ENV]: "  skill-name  "
      },
      { isPackaged: false }
    );
    expect(config.skillPath).toBe(SKILL_PATH);
    expect(config.skillName).toBe("skill-name");
  });
});
