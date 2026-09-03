/**
 * Live Codex App Server probe configuration for the Runner host (Phase 5,
 * review-finding-9 real discovery wiring).
 *
 * The ONLY sanctioned channel to enable the LIVE Codex preflight discovery is
 * these environment variables, read ONCE in the Main process before the
 * Runner host is constructed (the Renderer can never reach them — no IPC
 * payload, bridge method or renderer channel carries them):
 *
 * - `SWPANEL_LIVE_CODEX_EXECUTABLE` — optional; the codex executable the
 *   app-server child is spawned with (default `codex`; a Windows `.cmd`
 *   shim is refused by the child transport, never executed);
 * - `SWPANEL_LIVE_CODEX_SKILL_NAME` — optional; the exact skill name
 *   `skills/list` must verify (default `solidworks-build-part-from-drawing`);
 * - `SWPANEL_LIVE_CODEX_SKILL_PATH` — REQUIRED to enable live discovery; the
 *   exact configured absolute path of the modeling Skill DIRECTORY. The
 *   configured input is explicitly the directory (the same path the turn
 *   adapter receives and the directory digest hashes): the live probe
 *   requires `skills/list` to report the skill manifest INSIDE it —
 *   `<directory>\SKILL.md` (canonical Windows-safe comparison, never a
 *   sibling or a differently-shaped path);
 * - `SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT` — optional `true`/`false`; the
 *   authoritative explicit live configuration of model image-input support
 *   (never invented by the probe);
 * - `SWPANEL_LIVE_CODEX_SKILLS_FORCE_RELOAD` — optional `true`/`false`;
 *   bypasses the skills cache of `skills/list`.
 *
 * Fail-closed posture (mirrors the test-executor-config contract):
 *
 * - the environment is NEVER consulted on a packaged launch: a packaged app
 *   that carries any of the variables refuses startup with a structured error
 *   instead of silently running a live probe;
 * - an unpackaged launch with a malformed/unknown value refuses startup
 *   (a non-absolute skill path, a non-boolean image-support value, ...);
 * - with no variable set the resolver returns the EMPTY config and the Runner
 *   keeps its deterministic SYNTHETIC preflight path unchanged.
 */
import { isAbsolute } from "node:path";

import { CODEX_APP_SERVER_COMMAND } from "@swpanel/runner";

/** Env var selecting the codex executable of the live app-server child. */
export const LIVE_CODEX_EXECUTABLE_ENV = "SWPANEL_LIVE_CODEX_EXECUTABLE" as const;

/** Env var selecting the exact skill name `skills/list` must verify. */
export const LIVE_CODEX_SKILL_NAME_ENV = "SWPANEL_LIVE_CODEX_SKILL_NAME" as const;

/** Env var enabling live discovery with the exact configured skill path. */
export const LIVE_CODEX_SKILL_PATH_ENV = "SWPANEL_LIVE_CODEX_SKILL_PATH" as const;

/** Env var setting the authoritative model image-input support config. */
export const LIVE_CODEX_MODEL_IMAGE_SUPPORT_ENV =
  "SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT" as const;

/** Env var forcing a skills-cache bypass in `skills/list`. */
export const LIVE_CODEX_SKILLS_FORCE_RELOAD_ENV =
  "SWPANEL_LIVE_CODEX_SKILLS_FORCE_RELOAD" as const;

/** The modeling Skill name the live discovery verifies by default. */
export const LIVE_CODEX_DEFAULT_SKILL_NAME =
  "solidworks-autobuild" as const;

export interface LiveCodexConfig {
  /** True when live discovery is enabled (a skill path was configured). */
  readonly enabled: boolean;
  /** The codex executable of the spawned app-server child. */
  readonly executable: string;
  /** The exact skill name `skills/list` must verify. */
  readonly skillName: string;
  /**
   * The exact configured absolute path of the modeling Skill DIRECTORY
   * (`""` when disabled). The live probe verifies that `skills/list` reports
   * its `SKILL.md` inside it — the directory itself is never the reported
   * shape.
   */
  readonly skillPath: string;
  /** Authoritative image-input support config, or undefined (never invented). */
  readonly modelImageInputSupported: boolean | undefined;
  /** Bypass the skills cache of `skills/list`. */
  readonly forceReloadSkills: boolean;
}

/** Empty config: the Runner keeps the deterministic synthetic preflight path. */
export const EMPTY_LIVE_CODEX_CONFIG: LiveCodexConfig = Object.freeze({
  enabled: false,
  executable: CODEX_APP_SERVER_COMMAND,
  skillName: LIVE_CODEX_DEFAULT_SKILL_NAME,
  skillPath: "",
  modelImageInputSupported: undefined,
  forceReloadSkills: false
});

/** Structured startup failure of the live Codex probe configuration. */
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

/** Parses one strict boolean env value (`true`/`false`). */
function parseBoolean(raw: string, label: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new LiveCodexConfigError(
    "LIVE_CODEX_CONFIG_INVALID",
    `${label} must be "true" or "false"`
  );
}

/**
 * Resolves the live Codex probe configuration from the process environment.
 * Returns the EMPTY config when no variable is set (the default synthetic
 * preflight path stays untouched). Throws {@link LiveCodexConfigError} when:
 * - any variable is set on a PACKAGED launch (fail closed — never silently
 *   ignored, mirroring the test-executor-config contract);
 * - an unpackaged launch carries a non-absolute skill path, a non-boolean
 *   image-support / force-reload value or an empty executable/skill name.
 */
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
