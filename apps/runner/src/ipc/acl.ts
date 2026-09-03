import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

import { pipeUserName } from "./pipe-name.js";

/**
 * Windows DACL enforcement for the per-user Runner named pipe
 * (architecture.md §12.1, "current-user-only ACL").
 *
 * TRUTHFUL LIMITS (all verified on this machine, Node 24 / Windows 10.0.26300):
 *
 * 1. Node (`node:net` / `node:fs`) has NO public API to set a DACL on a named
 *    pipe before or after it is created, and Node 24 no longer exposes a public
 *    `dlopen` to call raw Win32 exports.
 * 2. The `icacls` command-line utility CANNOT address a live named pipe here:
 *    `icacls \\.\pipe\...` fails with error 87 ("invalid parameter") for both
 *    reading and granting, so the "spawn `icacls` on the pipe path" strategy
 *    does not work on this host and must not be claimed to have worked.
 * 3. A pipe created by Node inherits a default DACL that grants `Everyone` and
 *    `NT AUTHORITY\ANONYMOUS LOGON` read/synchronize (verified by reading the
 *    DACL back; see the ACL evidence test). Pipe-name obscurity is NOT an ACL
 *    substitute.
 * 4. The enforcement helper (pipe-acl-windows.ts) applies a "current user +
 *    SYSTEM only, protected" DACL to the live pipe via a first-party
 *    PowerShell P/Invoke script and verifies the result by reading the DACL
 *    back. This is the same `SetSecurityInfo(SE_KERNEL_OBJECT,
 *    DACL|PROTECTED_DACL)` call the Win32 SDK uses for named-pipe security.
 *
 * The verification here is STRICT: the applied DACL must contain BOTH the
 * current user's SID AND the SYSTEM SID, and must contain NO other ACE (broad
 * well-known SIDs such as Everyone / ANONYMOUS LOGON / Authenticated Users /
 * BUILTIN\Users / BUILTIN\Administrators are rejected explicitly, and any
 * other stray SID is rejected too). Anything short of that is reported as
 * `WINDOWS_ACL_FAILED` — the Runner never claims an ACL-protected pipe it
 * cannot prove.
 *
 * Non-Windows platforms always surface a clear "Windows-only IPC" result
 * (`WINDOWS_ONLY_UNSUPPORTED`); nothing is ever claimed as ACL-protected
 * there.
 */

export type PipeDaclStatus =
  | "WINDOWS_ACL_APPLIED"
  | "WINDOWS_ACL_FAILED"
  | "WINDOWS_ONLY_UNSUPPORTED";

export interface PipeDaclResult {
  status: PipeDaclStatus;
  /** Current-user account name (when known). */
  ownerAccount?: string;
  /** SID of the current user from the process token (when known). */
  ownerSid?: string;
  /** SYSTEM well-known SID that must be present in the DACL. */
  systemSid?: string;
  /** Human-readable reason for the status; always present for failures. */
  reason?: string;
  /** Post-apply ACE list captured as raw evidence. */
  aces?: readonly { sid: string; mask: number }[];
}

export interface PipeDaclContext {
  platform: NodeJS.Platform;
}

/** SYSTEM well-known SID granted full access alongside the current user. */
export const SYSTEM_SID = "S-1-5-18" as const;

/** Access mask every allowed ACE must carry (FILE_ALL_ACCESS). */
export const PIPE_DACL_ACE_MASK = 0x001f01ff as const;

/**
 * Broad well-known SIDs that must never appear in the applied DACL. The strict
 * verification additionally rejects ANY SID outside {current user, SYSTEM};
 * this set only exists so a failure caused by a known broad SID gets a precise,
 * actionable reason.
 */
const FORBIDDEN_SIDS: ReadonlySet<string> = new Set([
  "S-1-1-0", // Everyone
  "S-1-5-7", // NT AUTHORITY\ANONYMOUS LOGON
  "S-1-5-11", // NT AUTHORITY\Authenticated Users
  "S-1-5-32-545", // BUILTIN\Users
  "S-1-5-32-544" // BUILTIN\Administrators
]);

/** Raw DACL evidence captured from a live pipe (also the evidence file shape). */
export interface PipeDaclEvidence {
  pipePath: string;
  capturedAt: string;
  ownerAccount: string;
  ownerSid: string;
  systemSid: string;
  aces: readonly { sid: string; mask: number }[];
}

function userAccountForDacl(): string {
  return pipeUserName();
}

function describeAces(aces: readonly { sid: string; mask: number }[]): string {
  return aces.map((ace) => `${ace.sid}(0x${ace.mask.toString(16)})`).join(", ");
}

/**
 * Pure, unit-testable verification of a captured DACL against the strict
 * "current user + SYSTEM only" rule. Returns `{ ok: true }` only when every ACE
 * is either the current user's SID or SYSTEM, both are present, no broad
 * forbidden SID appears and every ACE grants the full access mask.
 */
export function verifyPipeDacl(
  evidence: Pick<PipeDaclEvidence, "ownerSid" | "systemSid" | "aces">
): { ok: true } | { ok: false; reason: string } {
  const { ownerSid, systemSid, aces } = evidence;
  const present = new Set(aces.map((ace) => ace.sid));
  const forbidden = aces.filter((ace) => FORBIDDEN_SIDS.has(ace.sid));

  if (!present.has(ownerSid)) {
    return {
      ok: false,
      reason: `Applied DACL is missing the current user's SID (${ownerSid}): ${describeAces(aces)}`
    };
  }
  if (!present.has(systemSid)) {
    return {
      ok: false,
      reason: `Applied DACL is missing the SYSTEM SID (${systemSid}): ${describeAces(aces)}`
    };
  }
  if (forbidden.length > 0) {
    return {
      ok: false,
      reason: `Applied DACL still exposes forbidden broad SIDs: ${describeAces(forbidden)}`
    };
  }
  const unexpected = aces.filter((ace) => ace.sid !== ownerSid && ace.sid !== systemSid);
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: `Applied DACL exposes SIDs other than {current user, SYSTEM}: ${describeAces(unexpected)}`
    };
  }
  const wrongMask = aces.filter((ace) => ace.mask !== PIPE_DACL_ACE_MASK);
  if (wrongMask.length > 0) {
    return {
      ok: false,
      reason: `Applied DACL carries unexpected access masks: ${describeAces(wrongMask)}`
    };
  }
  return { ok: true };
}

/**
 * Applies the "current user + SYSTEM only" DACL to a Windows Named Pipe server
 * and strictly verifies the result, or returns a truthful unsupported result on
 * non-Windows platforms. The pipe must already be listening so the helper can
 * open it with `READ_CONTROL | WRITE_DAC`; the DACL is replaced in place.
 */
export async function applyPipeDaclToServer(
  pipePath: string,
  context: PipeDaclContext = { platform: process.platform }
): Promise<PipeDaclResult> {
  if (context.platform !== "win32") {
    return {
      status: "WINDOWS_ONLY_UNSUPPORTED",
      reason:
        "Windows Named Pipes exist only on win32; on this platform there is no pipe to protect " +
        `(platform=${context.platform}). Nothing is claimed as ACL-protected.`
    };
  }

  // Load the Windows-only helper lazily; importing it never happens on other
  // platforms.
  const { applyPipeDacl } = await import("./pipe-acl-windows.js");
  try {
    const outcome = await applyPipeDacl(pipePath, { ownerAccount: userAccountForDacl() });
    const verification = verifyPipeDacl({
      ownerSid: outcome.ownerSid,
      systemSid: SYSTEM_SID,
      aces: outcome.aces
    });
    if (!verification.ok) {
      return {
        status: "WINDOWS_ACL_FAILED",
        ownerAccount: outcome.ownerAccount,
        ownerSid: outcome.ownerSid,
        systemSid: SYSTEM_SID,
        reason: verification.reason,
        aces: outcome.aces
      };
    }
    return {
      status: "WINDOWS_ACL_APPLIED",
      ownerAccount: outcome.ownerAccount,
      ownerSid: outcome.ownerSid,
      systemSid: SYSTEM_SID,
      aces: outcome.aces
    };
  } catch (error) {
    return {
      status: "WINDOWS_ACL_FAILED",
      ownerAccount: userAccountForDacl(),
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Captures the current DACL of a live pipe as raw evidence. Unlike the
 * apply path this is READ-ONLY: it opens the pipe with `READ_CONTROL` only and
 * never modifies the DACL. Non-Windows platforms throw, because on those
 * platforms there is no named pipe to read and no evidence to fabricate.
 */
export async function readPipeDaclEvidence(
  pipePath: string,
  context: PipeDaclContext = { platform: process.platform }
): Promise<PipeDaclEvidence> {
  if (context.platform !== "win32") {
    throw new Error(
      `Raw pipe DACL evidence can only be captured on win32 (platform=${context.platform})`
    );
  }
  const { readPipeDacl } = await import("./pipe-acl-windows.js");
  const outcome = await readPipeDacl(pipePath, { ownerAccount: userAccountForDacl() });
  return {
    pipePath,
    capturedAt: new Date().toISOString(),
    ownerAccount: outcome.ownerAccount,
    ownerSid: outcome.ownerSid,
    systemSid: SYSTEM_SID,
    aces: outcome.aces
  };
}

/**
 * Captures the raw DACL evidence of a live pipe and writes it to
 * `evidenceFilePath` as pretty-printed JSON. This is the durable raw evidence
 * artifact proving what the pipe DACL actually contains; the returned value is
 * the same evidence object that was written.
 */
export async function writePipeDaclEvidence(
  pipePath: string,
  evidenceFilePath: string,
  context: PipeDaclContext = { platform: process.platform }
): Promise<PipeDaclEvidence> {
  const evidence = await readPipeDaclEvidence(pipePath, context);
  writeFileSync(evidenceFilePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

/**
 * Fallback documented for environments where the pipe file may be addressable
 * by `icacls`; on this machine it is NOT (error 87) and it is never used to
 * claim enforcement. Kept so the WP4 brief's proposed fallback is represented
 * truthfully in code.
 */
export function applyPipeDaclWithIcacls(pipePath: string): Promise<void> {
  const identity = userAccountForDacl();
  const args = [
    pipePath,
    "/inheritance:r",
    "/grant:r",
    `${identity}:(GR,GW)`,
    "/grant:r",
    "SYSTEM:(GR,GW)"
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("icacls", args, { shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `icacls exited with code ${code}${stderr.length > 0 ? `: ${stderr.trim()}` : ""}`
          )
        );
      }
    });
  });
}

/** Resolves the SYSTEM well-known SID constant used by tests. */
export const SYSTEM_SID_CONST = SYSTEM_SID;
