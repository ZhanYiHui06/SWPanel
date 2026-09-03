import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * Process identity provider for the packaging lock.
 *
 * Windows recycles PIDs aggressively, so a "live" PID is NOT proof that the
 * process that recorded the lock is still alive: the PID may now belong to an
 * unrelated process born after the owner died. The reliable discriminator is
 * the process start time (birth time). This module queries the start time of a
 * process by platform:
 *
 * - Windows: PowerShell `Get-Process -Id <pid> .StartTime` (Win32 API behind
 *   the CIM/Process provider), returned as .NET ticks and converted to epoch
 *   milliseconds. Same-user processes are queryable; a process we cannot
 *   inspect yields null.
 * - Linux/Android: `/proc/<pid>/stat` field 22 (starttime in clock ticks since
 *   boot) combined with `/proc/stat` `btime` and `getconf CLK_TCK`, converted
 *   to epoch milliseconds.
 * - macOS/other: no portable in-process query is available, so null is
 *   returned ("cannot verify"), which lock callers treat as a safe abort.
 *
 * A null result MUST never be interpreted as "the process is dead": it means
 * "identity cannot be verified", and the caller aborts as unknown rather than
 * risking a stale takeover of a live process.
 */

/**
 * @typedef {{ pid: number; startTime: number }} ProcessIdentity
 *   pid plus the process start time in epoch milliseconds (a fixed, absolute
 *   value that never changes for a given process instance).
 */

/**
 * Run a PowerShell command and resolve its trimmed stdout, or null when
 * powershell cannot be launched. stderr is ignored: a member-access failure
 * (e.g. access denied) produces an empty stdout, which callers treat as
 * "cannot verify".
 *
 * @param {string} command
 * @returns {Promise<string | null>}
 */
function runPowerShell(command) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    let stdout = "";
    let finished = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => {
      if (!finished) {
        finished = true;
        resolve(null);
      }
    });
    child.once("exit", () => {
      if (!finished) {
        finished = true;
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Query a Windows process start time via PowerShell. Outputs the .NET ticks of
 * `Process.StartTime` (UTC), which is a plain integer with no culture-dependent
 * formatting. An empty output means the process is missing or its start time
 * could not be read.
 *
 * @param {number} pid
 * @returns {Promise<ProcessIdentity | null>}
 */
async function queryWindowsProcessIdentity(pid) {
  const script =
    "$p = Get-Process -Id " +
    pid +
    ' -ErrorAction SilentlyContinue; ' +
    'if ($null -eq $p) { Write-Output ""; exit 0 } ' +
    'try { Write-Output ([long]$p.StartTime.ToUniversalTime().Ticks) } ' +
    'catch { Write-Output "" }';
  const output = await runPowerShell(script);
  if (output === null) return null;
  const line = output.split(/\s+/).filter((part) => part.length > 0).pop();
  const ticks = line === undefined ? Number.NaN : Number(line);
  if (!Number.isInteger(ticks) || ticks <= 0) return null;
  // .NET ticks are 100 ns since 0001-01-01; epoch ms is ticks/10000 - epoch.
  const startTime = ticks / 10000 - 62135596800000;
  if (!Number.isFinite(startTime) || startTime <= 0) return null;
  return { pid, startTime };
}

/**
 * Query a Linux process start time via /proc. Returns null when /proc is not
 * available or the process is gone.
 *
 * @param {number} pid
 * @returns {Promise<ProcessIdentity | null>}
 */
async function queryLinuxProcessIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces/parens; everything after the last ")"
    // is fields 3..N. starttime is field 22 -> index (22 - 3) = 19.
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks) || startTicks < 0) return null;
    const statBoot = await readFile("/proc/stat", "utf8");
    const btimeMatch = /^btime\s+(\d+)/m.exec(statBoot);
    if (btimeMatch === null) return null;
    const bootSeconds = Number(btimeMatch[1]);
    if (!Number.isFinite(bootSeconds)) return null;
    const clockTicks = clockTicksPerSecond();
    const startTime = (bootSeconds + startTicks / clockTicks) * 1000;
    if (!Number.isFinite(startTime) || startTime <= 0) return null;
    return { pid, startTime };
  } catch {
    return null;
  }
}

/** @returns {number} clock ticks per second (defaults to 100). */
function clockTicksPerSecond() {
  try {
    const result = spawnSync("getconf", ["CLK_TCK"], {
      encoding: "utf8",
      windowsHide: true
    });
    const value = Number(result.stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    return 100;
  }
}

/**
 * Query the identity of the process with the given pid.
 *
 * @param {number} pid
 * @returns {Promise<ProcessIdentity | null>}
 *   identity when the process exists AND its start time could be read
 *   reliably; null when the process is absent or identity cannot be verified.
 */
export async function queryProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    return queryWindowsProcessIdentity(pid);
  }
  if (process.platform === "linux" || process.platform === "android") {
    return queryLinuxProcessIdentity(pid);
  }
  return null;
}

/**
 * Create an injectable identity provider. Tests can supply their own provider
 * to exercise the birth-time takeover logic deterministically without spawning
 * PowerShell or reading /proc.
 *
 * @returns {(pid: number) => Promise<ProcessIdentity | null>}
 */
export function createIdentityProvider() {
  return queryProcessIdentity;
}
