import { randomUUID } from "node:crypto";

/**
 * Windows Named Pipe path derivation (architecture.md §12.1). The pipe name
 * carries an installation/channel identifier, the lowercase Windows username
 * (per-user isolation) and a fresh server instance id; it never carries
 * business data.
 *
 * Format: `\\.\pipe\swpanel.runner.<lowercase-username>.<serverInstanceId>`
 *
 * The pipe-name obscurity of the random instance id is NOT an ACL substitute:
 * enforcement of "current user only" must come from the explicit DACL applied
 * by the ACL helper (see acl.ts). On non-Windows platforms there is no named
 * pipe at all and any attempt to start a pipe server surfaces a clear
 * Windows-only error.
 */

/** Static prefix of every SWPanel Runner pipe. */
export const PIPE_PREFIX = "swpanel.runner" as const;

/** Case-preserved rule: the pipe name is derived with a lowercase username. */
export const PIPE_USERNAME_LOWERCASE = true as const;

/**
 * Returns the Windows user name in the case used by the pipe name. The derived
 * pipe name is compared case-insensitively by the Windows pipe namespace, so
 * the lowercase form is purely cosmetic; the ACL (not the name) is the
 * security boundary.
 */
export function pipeUserName(): string {
  const userInfo = userNameFromEnvironment();
  return userInfo.toLowerCase();
}

/**
 * Reads the current user name from the environment (Node on Windows derives it
 * from the process token). Falls back to the environment `USERNAME`/`USER`
 * when available, otherwise `"unknown"` so a pipe name can still be formed.
 */
function userNameFromEnvironment(): string {
  const candidates = [process.env.USERNAME, process.env.USER];
  const found = candidates.find((candidate) => candidate !== undefined && candidate.trim().length > 0);
  return found === undefined ? "unknown" : found.trim();
}

/**
 * Derives the full named-pipe path for the current user and a server instance.
 * The instance id is always minted by the server ({@link newServerInstanceId});
 * a caller-supplied id is only used by tests.
 */
export function pipePathForServerInstance(serverInstanceId: string): string {
  return `\\\\.\\pipe\\${PIPE_PREFIX}.${pipeUserName()}.${serverInstanceId}`;
}

/** Mints the random server instance id used to name the pipe. */
export function newServerInstanceId(): string {
  return randomUUID();
}

/** True when the target platform can host Windows named pipes. */
export function supportsWindowsPipes(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}
