/**
 * Runtime data root resolution for the Runner host (WP5).
 *
 * Production root (ADR-002): `%LOCALAPPDATA%\JANGHI\SWPanel` — the single
 * canonical root of the SQLite database, the drawing library and the per-Run
 * workspaces. The root is always derived from the OS (never from an arbitrary
 * environment variable), so `SWPANEL_DATA_ROOT` and similar overrides can never
 * point the app at an external/network location.
 *
 * Test root: the ONLY way to redirect the data root is the explicit
 * `--swpanel-test-runtime-root=<absolute-path>` CLI argument, and it is honored
 * ONLY on an unpackaged launch (dev / E2E). A packaged launch that carries the
 * argument is rejected (never silently ignored). Relative paths, UNC/network
 * roots and malformed/duplicate arguments are refused with a structured error.
 *
 * The environment is never consulted for the override: the argument must be
 * spelled exactly `--swpanel-test-runtime-root=<value>` (no separate value, no
 * alternate casing, no empty value).
 */

import os from "node:os";
import path from "node:path";

/** Base segment of the default runtime root (`%LOCALAPPDATA%\JANGHI\SWPanel`). */
export const DEFAULT_RUNTIME_ROOT_BASE = "JANGHI" as const;
/** Directory name segment of the default runtime root. */
export const DEFAULT_RUNTIME_ROOT_DIRNAME = "SWPanel" as const;

/** The dedicated strict CLI argument that opts an UNPACKAGED launch into a test root. */
export const TEST_RUNTIME_ROOT_CLI_FLAG = "--swpanel-test-runtime-root" as const;

export type RuntimeRootKind = "default" | "test";

export interface RuntimeRootConfig {
  readonly kind: RuntimeRootKind;
  /** Canonical absolute path of the data root. */
  readonly root: string;
}

/** Structured startup failure for runtime-root resolution. */
export class RuntimeRootConfigError extends Error {
  readonly code: "INVALID_DEFAULT_ROOT" | "TEST_ROOT_FORBIDDEN_PACKAGED" | "TEST_ROOT_MALFORMED";

  constructor(
    code: RuntimeRootConfigError["code"],
    message: string
  ) {
    super(message);
    this.name = "RuntimeRootConfigError";
    this.code = code;
  }
}

/**
 * True when the path is a UNC / network path (`\\server\share` or a
 * double-slash POSIX UNC). These are never acceptable for the local data root
 * (ADR-002 requires a local fixed volume).
 */
export function isUncOrNetworkPath(candidate: string): boolean {
  return candidate.startsWith("\\\\") || candidate.startsWith("//");
}

/** True when the candidate is a canonical absolute LOCAL path. */
export function isAbsoluteLocalPath(candidate: string): boolean {
  return path.isAbsolute(candidate) && !isUncOrNetworkPath(candidate);
}

/**
 * Derives the default runtime root from the OS. On win32 the root is
 * `%LOCALAPPDATA%\JANGHI\SWPanel`; `LOCALAPPDATA` must be present (Windows
 * always sets it). On other platforms a per-user home-based default is used so
 * the code stays portable for tests.
 *
 * @param getLocalAppData injectable source of `%LOCALAPPDATA%` (defaults to the process env)
 */
export function defaultRuntimeRoot(
  platform: NodeJS.Platform = process.platform,
  getLocalAppData: () => string | undefined = () => process.env.LOCALAPPDATA
): string {
  if (platform === "win32") {
    const localAppData = getLocalAppData();
    if (localAppData === undefined || localAppData.trim().length === 0) {
      throw new RuntimeRootConfigError(
        "INVALID_DEFAULT_ROOT",
        "LOCALAPPDATA is not set; cannot derive the SWPanel runtime root"
      );
    }
    return path.join(localAppData, DEFAULT_RUNTIME_ROOT_BASE, DEFAULT_RUNTIME_ROOT_DIRNAME);
  }
  return path.join(os.homedir(), ".local", "share", DEFAULT_RUNTIME_ROOT_BASE, DEFAULT_RUNTIME_ROOT_DIRNAME);
}

/**
 * Validates and canonicalizes a caller-supplied runtime root (the test-root CLI
 * value). Requires an absolute LOCAL path: relative paths, UNC/network roots
 * and NUL bytes are refused. The result is canonicalized with `path.resolve`.
 */
export function validateRuntimeRootPath(candidate: string): { ok: true; root: string } | {
  ok: false;
  reason: string;
} {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return { ok: false, reason: "the test runtime root must be a non-empty path" };
  }
  if (candidate.includes("\0")) {
    return { ok: false, reason: "the test runtime root must not contain NUL bytes" };
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, reason: "the test runtime root must be an absolute path" };
  }
  if (isUncOrNetworkPath(candidate)) {
    return { ok: false, reason: "the test runtime root must be a local path, not a network/UNC path" };
  }
  return { ok: true, root: path.resolve(candidate) };
}

/**
 * Resolves the runtime root config from the main-process argv.
 *
 * - no argument: the default OS-derived root (kind `default`);
 * - EXACTLY ONE canonical `--swpanel-test-runtime-root=<absolute-local-path>`
 *   argument on an unpackaged launch: the validated canonical test root
 *   (kind `test`);
 * - any other occurrence — duplicate arguments, variant spellings (missing
 *   `=`, empty value, separate value), an external/relative/UNC path, or the
 *   argument on a packaged launch — throws {@link RuntimeRootConfigError}.
 *
 * The environment is never consulted for an override.
 */
export function resolveRuntimeRootConfig(
  argv: readonly string[],
  options: {
    isPackaged: boolean;
    platform?: NodeJS.Platform;
    getLocalAppData?: () => string | undefined;
  }
): RuntimeRootConfig {
  const exactPrefix = `${TEST_RUNTIME_ROOT_CLI_FLAG}=`;
  const matches: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith(TEST_RUNTIME_ROOT_CLI_FLAG)) matches.push(arg);
  }

  if (matches.length === 0) {
    return {
      kind: "default",
      root: defaultRuntimeRoot(options.platform, options.getLocalAppData)
    };
  }
  if (matches.length > 1) {
    throw new RuntimeRootConfigError(
      "TEST_ROOT_MALFORMED",
      `Exactly one ${TEST_RUNTIME_ROOT_CLI_FLAG}=<path> argument is allowed`
    );
  }
  const candidateArg = matches[0] as string;
  if (candidateArg === undefined || !candidateArg.startsWith(exactPrefix)) {
    throw new RuntimeRootConfigError(
      "TEST_ROOT_MALFORMED",
      `The test runtime root must be passed as ${TEST_RUNTIME_ROOT_CLI_FLAG}=<absolute-path>`
    );
  }
  const value = candidateArg.slice(exactPrefix.length);
  if (options.isPackaged) {
    throw new RuntimeRootConfigError(
      "TEST_ROOT_FORBIDDEN_PACKAGED",
      `${TEST_RUNTIME_ROOT_CLI_FLAG} is only honored on an unpackaged launch`
    );
  }
  const validated = validateRuntimeRootPath(value);
  if (!validated.ok) {
    throw new RuntimeRootConfigError("TEST_ROOT_MALFORMED", validated.reason);
  }
  return { kind: "test", root: validated.root };
}
