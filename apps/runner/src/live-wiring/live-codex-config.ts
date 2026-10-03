/** Server-only live Codex configuration and ownership-safe wiring. */
import { isAbsolute } from "node:path";

import { CODEX_APP_SERVER_COMMAND } from "../index.js";

export const LIVE_CODEX_EXECUTABLE_ENV = "SWPANEL_LIVE_CODEX_EXECUTABLE" as const;

export const LIVE_CODEX_SKILL_NAME_ENV = "SWPANEL_LIVE_CODEX_SKILL_NAME" as const;

export const LIVE_CODEX_SKILL_PATH_ENV = "SWPANEL_LIVE_CODEX_SKILL_PATH" as const;

export const LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV =
  "SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT" as const;

export const LIVE_CODEX_SKILLS_FORCE_RELOAD_ENV =
  "SWPANEL_LIVE_CODEX_SKILLS_FORCE_RELOAD" as const;

export const LIVE_CODEX_DEFAULT_SKILL_NAME =
  "solidworks-autobuild" as const;

export interface LiveCodexConfig {
    readonly enabled: boolean;
    readonly executable: string;
    readonly skillName: string;
    readonly skillPath: string;
    readonly modelImageInputSupported: boolean | undefined;
    readonly forceReloadSkills: boolean;
}

export const EMPTY_LIVE_CODEX_CONFIG: LiveCodexConfig = Object.freeze({
  enabled: false,
  executable: CODEX_APP_SERVER_COMMAND,
  skillName: LIVE_CODEX_DEFAULT_SKILL_NAME,
  skillPath: "",
  modelImageInputSupported: undefined,
  forceReloadSkills: false
});

export class LiveCodexConfigError extends Error {
  readonly code: "LIVE_CODEX_CONFIG_FORBIDDEN_PACKAGED" | "LIVE_CODEX_CONFIG_INVALID";

  constructor(code: LiveCodexConfigError["code"], message: string) {
    super(message);
    this.name = "LiveCodexConfigError";
    this.code = code;
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined ? undefined : value.trim();
}

function parseBoolean(raw: string, label: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new LiveCodexConfigError(
    "LIVE_CODEX_CONFIG_INVALID",
    `${label} must be "true" or "false"`
  );
}

export function resolveLiveCodexConfig(
  env: NodeJS.ProcessEnv,
  options: { isPackaged: boolean }
): LiveCodexConfig {
  const executableRaw = readEnv(env, LIVE_CODEX_EXECUTABLE_ENV);
  const skillNameRaw = readEnv(env, LIVE_CODEX_SKILL_NAME_ENV);
  const skillPathRaw = readEnv(env, LIVE_CODEX_SKILL_PATH_ENV);
  const imageSupportRaw = readEnv(env, LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV);
  const forceReloadRaw = readEnv(env, LIVE_CODEX_SKILLS_FORCE_RELOAD_ENV);

  const anySet = [
    executableRaw,
    skillNameRaw,
    skillPathRaw,
    imageSupportRaw,
    forceReloadRaw
  ].some((value) => value !== undefined);

  if (!anySet) return EMPTY_LIVE_CODEX_CONFIG;
  if (options.isPackaged) {
    throw new LiveCodexConfigError(
      "LIVE_CODEX_CONFIG_FORBIDDEN_PACKAGED",
      `${LIVE_CODEX_EXECUTABLE_ENV}/${LIVE_CODEX_SKILL_NAME_ENV}/${LIVE_CODEX_SKILL_PATH_ENV}/` +
        `${LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV}/${LIVE_CODEX_SKILLS_FORCE_RELOAD_ENV} ` +
        "are live-probe configuration and are refused on a packaged launch (never silently ignored)"
    );
  }

  // The skill path is the ONLY required key: without it live discovery has
  // nothing exact to verify and the synthetic default path must stay active.
  if (skillPathRaw === undefined) {
    throw new LiveCodexConfigError(
      "LIVE_CODEX_CONFIG_INVALID",
      `${LIVE_CODEX_SKILL_PATH_ENV} is required when any live Codex variable is set (the exact configured skill path)`
    );
  }
  if (!isAbsolute(skillPathRaw)) {
    throw new LiveCodexConfigError(
      "LIVE_CODEX_CONFIG_INVALID",
      `${LIVE_CODEX_SKILL_PATH_ENV} must be an absolute path`
    );
  }

  const executable = executableRaw ?? CODEX_APP_SERVER_COMMAND;
  if (executable.length === 0) {
    throw new LiveCodexConfigError(
      "LIVE_CODEX_CONFIG_INVALID",
      `${LIVE_CODEX_EXECUTABLE_ENV} must not be empty`
    );
  }
  const skillName = skillNameRaw ?? LIVE_CODEX_DEFAULT_SKILL_NAME;
  if (skillName.trim().length === 0) {
    throw new LiveCodexConfigError(
      "LIVE_CODEX_CONFIG_INVALID",
      `${LIVE_CODEX_SKILL_NAME_ENV} must not be empty`
    );
  }

  return {
    enabled: true,
    executable,
    skillName,
    skillPath: skillPathRaw,
    modelImageInputSupported:
      imageSupportRaw === undefined ? undefined : parseBoolean(imageSupportRaw, LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV),
    forceReloadSkills:
      forceReloadRaw === undefined ? false : parseBoolean(forceReloadRaw, LIVE_CODEX_SKILLS_FORCE_RELOAD_ENV)
  };
}
