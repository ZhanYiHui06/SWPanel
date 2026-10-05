/**
 * The LIVE SolidWorks availability/version probe of Phase 5 (P5-1 real
 * discovery) — the async counterpart of the synchronous injected
 * {@link SolidWorksProbe} seam of {@link RealPreflightProbe}, built exactly
 * like the live Codex discovery (`codex-live-probe.ts`): the synchronous
 * probe keeps its deterministic seam and the Electron Main host AWAITS the
 * live probe and injects a FIXED seam `{ probe: () => snapshot-compatible
 * result }` afterwards (never an inline live COM call inside the probe).
 *
 * Ownership safety (the probe NEVER touches a process it does not own):
 *
 * - The probe FIRST attaches READ-ONLY to a pre-existing `SldWorks.Application`
 *   COM instance (bounded poll through the Python/pywin32 helper) and verifies
 *   `GetProcessID()` + `RevisionNumber()`. A pre-existing instance is never
 *   closed and its documents are never touched — the probe only reads.
 * - Only when NO instance exists does the probe spawn `SLDWORKS.exe` DIRECTLY
 *   from Node (`shell: false`, `windowsHide: true`) so Node captures the exact
 *   owned pid BEFORE any helper runs. The bounded Python/pywin32 COM helper
 *   then polls `win32com.client.GetActiveObject("SldWorks.Application")` and
 *   REQUIRES the COM `GetProcessID()` to equal the exact spawned pid — only
 *   then is ownership proven and `RevisionNumber()` read. A COM instance with
 *   a DIFFERENT pid (a user process) fails the probe closed and is never
 *   touched. The helper NEVER creates a COM instance (no `Dispatch`/`Create`):
 *   it only attaches to a running object, so Node remains the only spawner and
 *   owner. (The COM attach/spawn helper is Python/pywin32 because PowerShell's
 *   `[Marshal]::GetActiveObject` path returns TYPE_E_ELEMENTNOTFOUND on real
 *   hosts where pywin32 `GetActiveObject` provably works.)
 * - On success, on any failure and on timeout the probe closes/terminates ONLY
 *   that exact Node-spawned process (kill on the owned handle + awaited exit —
 *   never a pid-delta cleanup, never taskkill-by-name, never a name-based mass
 *   cleanup, never `ExitApp`/`Quit` on an attached instance). When ownership
 *   cannot be proven the probe fails closed and kills no other process.
 * - While the spawn-mode helper polls, the probe CONCURRENTLY observes the
 *   exact spawned child handle (`observeExit`). The moment OUR owned process
 *   exits before COM ownership is proven — the real startup crash signature
 *   `0xC0000005` = 3221225477, after which SLDWORKS.exe can never register —
 *   the probe ABORTS the bounded helper child through its AbortSignal (kills
 *   ONLY the helper child, awaits its closure) and fails closed promptly with
 *   the stable `owned-process-exited` reason and the normalized unsigned
 *   Windows exit status. It never waits out the full spawn bound for a process
 *   that is already gone. Whichever reaction settles first in MICROTASK order
 *   decides the race — never a wall-clock tie: a valid proof whose reaction
 *   settles first wins and success behavior is unchanged; a PRE-SETTLED exit
 *   observation (a promise already fulfilled when the race is built) queues
 *   its reaction immediately and can beat a proof settling in the very same
 *   tick, and the probe then fails closed on that ambiguity.
 * - The cleanup is AWAITED before the snapshot resolves, even when the helper
 *   construction or the poll itself failed after the spawn, and even when an
 *   UNEXPECTED post-spawn failure (a rejecting/throwing observation seam)
 *   threw: the probe fails closed with `probe-threw` while PRESERVING
 *   installedVersion and the truthful ownedProcessSpawned / ownedProcessClosed
 *   cleanup facts — the failure never bubbles to the outer wrapper and never
 *   loses the ownership truth.
 *
 * Discovery is year-agnostic (never a hardcoded year): the PowerShell helper
 * reads the installed-product registry locations (the `SOFTWARE\SolidWorks\SOLIDWORKS <year>\Setup`
 * "SolidWorks Folder" value and the uninstall DisplayName/InstallLocation
 * entries, 64-bit and 32-bit views) plus the year-independent standard
 * install location, and verifies the actual `SLDWORKS.exe` FileVersion. When
 * no executable is found the probe fails closed (`no-installation-found`).
 * Discovery stays on PowerShell; only the COM attach/spawn work moved to
 * Python/pywin32. The AMD startup-crash case (SolidWorks installed but COM
 * activation and direct launch crash, e.g. `atio6axx.dll` `0xc0000005`)
 * returns `available: false` with the discovered installed/file version
 * recorded — the crash is never misreported as availability.
 *
 * Fail-closed contract (mirrors {@link probeLiveCodexRuntime}): a runtime
 * failure never throws — it returns the fail-closed snapshot with a REDACTED,
 * stable `reason` code (never a path, never a raw error message — the gate
 * persists booleans only). Only an internal programming failure escapes to the
 * probe's own catch-all, which converts it into `probe-threw` so startup never
 * crashes because of the probe; a POST-SPAWN `probe-threw` still carries
 * installedVersion and the truthful ownedProcessSpawned / ownedProcessClosed
 * cleanup facts (the cleanup is awaited before that snapshot resolves).
 *
 * The READ-ONLY attach step is itself fail-closed: a thrown, timed-out,
 * `ok: false` or otherwise malformed attach outcome NEVER falls through to
 * the owned-spawn path — only a clean `ok: true, attached: false` attach
 * outcome may spawn. Every injected seam result (helper outcome, discovery,
 * spawner handle) that is null or malformed maps to a fail-closed snapshot:
 * the probe never resolves null and never throws at startup because of a seam.
 *
 * Hermetic tests inject the spawner / discovery / helper-runner seams and never
 * launch a real SolidWorks process. The explicitly invoked scratch smoke lives
 * at `.scratch/solidworks-probe-smoke.mts` (git/lint-ignored, never a test).
 */
import { spawn } from "node:child_process";

import type { SolidWorksProbeResult } from "./real-preflight-probe.js";

/** Default bound of the READ-ONLY pre-existing-instance attach poll (3 s). */
export const DEFAULT_SOLIDWORKS_ATTACH_PROBE_TIMEOUT_MS = 3_000 as const;
/**
 * Default bound of the ownership-proving spawn poll (60 s): a cold
 * SLDWORKS.exe start needs time to register in the COM running-object table.
 */
export const DEFAULT_SOLIDWORKS_SPAWN_PROBE_TIMEOUT_MS = 60_000 as const;
/** Default bound of one PowerShell helper invocation (registry discovery). */
export const DEFAULT_SOLIDWORKS_DISCOVER_HELPER_TIMEOUT_MS = 15_000 as const;
/**
 * Grace added on top of a helper's own deadline: a COM dispatch that blocks
 * (e.g. a busy SolidWorks instance) cannot outlive the NODE-side hard bound,
 * after which the helper process itself (our own child) is terminated.
 */
export const DEFAULT_SOLIDWORKS_HELPER_GRACE_MS = 5_000 as const;
/** Bound of the awaited owned-process cleanup after `kill()` (5 s). */
export const DEFAULT_SOLIDWORKS_CLOSE_GRACE_MS = 5_000 as const;

/** The SolidWorks COM ProgID the helper polls with GetActiveObject. */
export const SOLIDWORKS_COM_PROGID = "SldWorks.Application" as const;
/** The SolidWorks executable file name the discovery verifies. */
export const SOLIDWORKS_EXECUTABLE_FILE_NAME = "SLDWORKS.exe" as const;

/**
 * The default Python argv of the COM attach/spawn helper. The interpreter must
 * have pywin32 installed; when it (or Python itself) is unavailable the helper
 * fails closed (`com-helper-failed`) — the probe never installs dependencies
 * and never falls through to a spawn decision on a helper failure.
 */
export const DEFAULT_SOLIDWORKS_PYTHON_COMMAND = ["python"] as const;

/** Bound of the helper stdout capture (the result marker is tiny). */
const MAX_SOLIDWORKS_HELPER_STDOUT_CHARS = 64 * 1024;
/** Bound of the helper stderr capture (error diagnostics only). */
const MAX_SOLIDWORKS_HELPER_STDERR_CHARS = 8 * 1024;

/** Env var carrying the helper mode to the helper child. */
const SOLIDWORKS_PROBE_MODE_ENV = "SWPANEL_SW_PROBE_MODE" as const;
/** Env var carrying the poll deadline (ms) to the helper child. */
const SOLIDWORKS_PROBE_DEADLINE_MS_ENV = "SWPANEL_SW_PROBE_DEADLINE_MS" as const;
/** Env var carrying the exact spawned pid the COM instance must match. */
const SOLIDWORKS_EXPECTED_PID_ENV = "SWPANEL_SW_EXPECTED_PID" as const;
/** The stdout marker line prefix of every helper result. */
const SOLIDWORKS_RESULT_MARKER = "SWPANEL_SW_RESULT " as const;
/** The rejection message of an aborted helper invocation (owned-process-exited). */
const SOLIDWORKS_HELPER_ABORT_MESSAGE =
  "the SolidWorks probe helper was aborted (the owned process exited before COM ownership was proven)" as const;

/**
 * The REDACTED, stable reason of the snapshot — the only diagnostics persisted
 * toward the gate. Never a path, never a raw error message.
 */
export type SolidWorksProbeReason =
  | "attached-pre-existing-instance"
  | "owned-process-proven"
  | "unsupported-platform"
  | "no-installation-found"
  | "spawn-failed"
  | "ownership-not-proven"
  | "owned-process-exited"
  | "foreign-instance-owner"
  | "com-helper-failed"
  | "com-helper-timeout"
  | "probe-threw";

/**
 * The authoritative async snapshot of ONE live SolidWorks probe call,
 * consumed by the Electron Main host (injected into the synchronous
 * {@link RealPreflightProbe} as a fixed seam via
 * {@link solidWorksProbeResultOf}). Every field is derived from the live COM
 * proof, the discovery or the ownership diagnostics — never invented.
 */
export interface SolidWorksLiveProbeResult {
  /** True when a drivable SolidWorks instance was PROVEN (attached or owned). */
  available: boolean;
  /**
   * The drivable live revision (`RevisionNumber`, e.g. "33.0.0.5050"), or
   * null when no instance could be proven.
   */
  version: string | null;
  /**
   * The discovered installed/file version (registry DisplayVersion or the
   * actual SLDWORKS.exe FileVersion), or null when not discoverable. Recorded
   * EVEN when availability fails (e.g. the AMD startup-crash case).
   */
  installedVersion: string | null;
  /** True when the probe spawned its own SLDWORKS.exe (ownership path). */
  ownedProcessSpawned: boolean;
  /**
   * True when the owned process was closed/terminated and its exit was
   * observed within the close bound. The probe NEVER closes any other process.
   */
  ownedProcessClosed: boolean;
  /**
   * The normalized unsigned Windows exit status of the OWNED process, or null
   * when no owned exit was observed (or the exit code was unreadable). Set
   * ONLY when the owned process exited before COM ownership was proven
   * (reason `owned-process-exited`): the 0xC0000005 startup access-violation
   * crash is reported as 3221225477 — a signed raw status such as
   * -1073741819 is normalized to the unsigned form
   * ({@link normalizeWindowsExitStatus}), so the persisted diagnostic never
   * depends on how the OS surfaced the code. Never a path, never an error
   * message.
   */
  ownedProcessExitCode: number | null;
  /** Redacted stable reason (see {@link SolidWorksProbeReason}). */
  reason: SolidWorksProbeReason;
  /** ISO timestamp of the snapshot (probe clock). */
  probedAt: string;
}

/** The fail-closed snapshot: nothing is ever assumed. */
export function failClosedSolidWorksResult(input: {
  reason: SolidWorksProbeReason;
  installedVersion?: string | null;
  probedAt: string;
  /** Observed owned-process exit status, or null (see {@link SolidWorksLiveProbeResult.ownedProcessExitCode}). */
  ownedProcessExitCode?: number | null;
}): SolidWorksLiveProbeResult {
  return {
    available: false,
    version: null,
    installedVersion: input.installedVersion ?? null,
    ownedProcessSpawned: false,
    ownedProcessClosed: false,
    ownedProcessExitCode: input.ownedProcessExitCode ?? null,
    reason: input.reason,
    probedAt: input.probedAt
  };
}

/**
 * Adapts the authoritative live snapshot onto the synchronous
 * {@link SolidWorksProbeResult} surface of {@link RealPreflightProbe} (the
 * seam the Electron Main host injects as the fixed probe
 * `{ probe: () => solidWorksProbeResultOf(snapshot) }`). The fields are the
 * live snapshot verbatim — nothing is invented or reinterpreted.
 */
export function solidWorksProbeResultOf(live: SolidWorksLiveProbeResult): SolidWorksProbeResult {
  return { available: live.available, version: live.version };
}

/**
 * Normalizes a Windows process exit status to its unsigned 32-bit form so the
 * persisted diagnostic is stable across how the OS/Node surfaced the code: a
 * raw signed status -1073741819 and a raw unsigned status 3221225477 both
 * normalize to 3221225477, the documented 0xC0000005 access-violation startup
 * crash of SLDWORKS.exe on affected hosts. Non-negative statuses pass through
 * unchanged; null stays null (no exit was observed / the code is unreadable).
 */
export function normalizeWindowsExitStatus(status: number | null): number | null {
  if (status === null) return null;
  return status < 0 ? status >>> 0 : status;
}

/**
 * A cancellable observation of ONE owned-process exit. `promise` resolves
 * when the exit is observed ({@link SolidWorksOwnedExit} with the normalized
 * unsigned Windows status) or when the bound elapses without an exit
 * (`exited: false`); it NEVER rejects. A seam that VIOLATES this (a rejecting
 * observation) is an unexpected post-spawn failure: the probe fails closed
 * with `probe-threw` (never a crash, never a lost ownership fact).
 * `cancel()` detaches the observation's
 * timers/listeners so nothing outlives the race it belongs to; after cancel
 * the promise never settles (the caller must drop it). Both are idempotent.
 */
export interface SolidWorksOwnedExitObservation {
  readonly promise: Promise<SolidWorksOwnedExit>;
  /** Detaches the observation (idempotent; a no-op once the promise settled). */
  cancel(): void;
}

/** The observed outcome of one owned-process exit observation. */
export interface SolidWorksOwnedExit {
  /** True only when the owned process's exit was ACTUALLY observed. */
  exited: boolean;
  /** The normalized unsigned Windows exit status, or null when unobserved/unreadable. */
  exitCode: number | null;
}

/**
 * The owned process handle of ONE Node-spawned SolidWorks process. `kill()`
 * operates on the owned spawn handle (TerminateProcess on Windows — never a
 * fresh pid-based lookup, so a pid-reuse race is impossible) and `waitExit`
 * observes the OWNED process exit.
 */
export interface SpawnedSolidWorksProcess {
  /** The exact OS pid captured by Node at spawn time, or undefined on spawn failure. */
  readonly pid: number | undefined;
  /** Terminates exactly this process (idempotent; a dead process is a no-op). */
  kill(): void;
  /**
   * Resolves true only when this process's exit/close was actually observed
   * within the bound; false on timeout AND on 'error' (an error is not an
   * exit — never throws).
   */
  waitExit(timeoutMs: number): Promise<boolean>;
  /**
   * Starts a cancellable observation of this exact process's exit, used by
   * the probe to abort the bounded COM helper the moment the OWNED process is
   * gone (the owned-process-exited early path). Observes only this exact
   * handle — never an enumeration, never a name match, never another process.
   */
  observeExit(timeoutMs: number): SolidWorksOwnedExitObservation;
}

/** The spawn seam: launches the discovered SLDWORKS.exe from Node. */
export type SolidWorksProcessSpawner = (executablePath: string) => SpawnedSolidWorksProcess;

/**
 * The default spawner: `spawn(..., { shell: false, windowsHide: true,
 * stdio: "ignore" })` — the owned process boundary is never a shell, never a
 * visible console window on Windows hosts, and the child's stdio is never
 * used (the COM helper is the only channel). The pid is captured synchronously
 * by Node BEFORE any later action.
 */
export const DEFAULT_SOLIDWORKS_SPAWNER: SolidWorksProcessSpawner = (executablePath) => {
  const child = spawn(executablePath, [], {
    shell: false,
    windowsHide: true,
    stdio: "ignore"
  });
  return {
    pid: child.pid,
    kill() {
      try {
        child.kill();
      } catch {
        // the process is already gone
      }
    },
    waitExit(timeoutMs) {
      return new Promise<boolean>((resolve) => {
        // A process that never spawned (`pid` never set) can never produce an
        // observed exit: report false immediately instead of waiting out the
        // bound (the 'error' event may already have fired and closed). The
        // no-op 'error' listener swallows the still-pending async spawn-error
        // event, which would otherwise surface as an uncaught exception.
        if (child.pid === undefined) {
          child.once("error", () => {});
          resolve(false);
          return;
        }
        // A real exit is only provable for a process that actually spawned:
        // on Windows the never-spawned error path surfaces a negative raw
        // error as `exitCode` (e.g. -4058) plus a `close` — that is NOT an
        // observed exit and must report false.
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), timeoutMs);
        const settle = (exitObserved: boolean) => {
          clearTimeout(timer);
          resolve(exitObserved);
        };
        // 'exit' — and 'close' after a real exit — prove the process ended.
        // 'error' (failed kill, never-spawned child) is NOT an exit: report
        // false, never claim an exit that was not observed. 'close' with a
        // null code is the never-spawned error path as well, so it reports
        // false too (an error without a process never emits 'exit').
        child.once("exit", () => settle(true));
        child.once("close", () => settle(child.exitCode !== null || child.signalCode !== null));
        child.once("error", () => settle(false));
      });
    },
    observeExit(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onExit: (() => void) | undefined;
      let onClose: (() => void) | undefined;
      let onError: (() => void) | undefined;
      // Detaches EVERYTHING this observation owns: the bound timer and the
      // exact-child listeners. After cancel the promise never settles and the
      // probe must drop it — nothing may hold Node open past the race.
      const detach = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (onExit !== undefined) child.removeListener("exit", onExit);
        if (onClose !== undefined) child.removeListener("close", onClose);
        if (onError !== undefined) child.removeListener("error", onError);
      };
      const promise = new Promise<SolidWorksOwnedExit>((resolve) => {
        // A process that never spawned (`pid` never set) can never produce an
        // observed exit: report exited:false immediately. The no-op 'error'
        // listener swallows the still-pending async spawn-error event, which
        // would otherwise surface as an uncaught exception.
        if (child.pid === undefined) {
          child.once("error", () => {});
          resolve({ exited: false, exitCode: null });
          return;
        }
        // A real exit is only provable for a process that actually spawned:
        // on Windows the never-spawned error path surfaces a negative raw
        // error as `exitCode` plus a `close` — that is NOT an observed exit
        // and must report exited:false (the pid guard above already covers
        // it); an already-exited owned process is reported immediately with
        // its normalized status.
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ exited: true, exitCode: normalizeWindowsExitStatus(child.exitCode) });
          return;
        }
        timer = setTimeout(() => {
          detach();
          resolve({ exited: false, exitCode: null });
        }, timeoutMs);
        // 'exit' — and 'close' after a real exit — prove the process ended and
        // carry the status normalized to the unsigned Windows form. 'error'
        // (failed kill, never-spawned child) is NOT an exit: exited:false,
        // never a claimed exit that was not observed.
        onExit = () => {
          detach();
          resolve({ exited: true, exitCode: normalizeWindowsExitStatus(child.exitCode) });
        };
        onClose = () => {
          detach();
          resolve({
            exited: child.exitCode !== null || child.signalCode !== null,
            exitCode: normalizeWindowsExitStatus(child.exitCode)
          });
        };
        onError = () => {
          detach();
          resolve({ exited: false, exitCode: null });
        };
        child.on("exit", onExit);
        child.on("close", onClose);
        child.on("error", onError);
      });
      return { promise, cancel: detach };
    }
  };
};

/** The discovered installation (internal to the probe; never persisted). */
export interface SolidWorksInstallation {
  /** Absolute path of the verified SLDWORKS.exe (spawn input only). */
  readonly executablePath: string;
  /** The actual SLDWORKS.exe FileVersion, or null when unreadable. */
  readonly fileVersion: string | null;
  /** Which discovery source proved the executable (diagnostics). */
  readonly source: "uninstall" | "product-setup" | "standard-path";
}

/** The discovery seam: registry + file-version discovery, fail-closed null. */
export type SolidWorksInstallationDiscovery = () => Promise<SolidWorksInstallation | null>;

/** The helper modes of the bounded COM helper (discover / attach / spawn). */
export type SolidWorksComHelperMode = "discover" | "attach" | "spawn";

export interface SolidWorksComHelperRequest {
  mode: SolidWorksComHelperMode;
  /** Poll deadline in ms (the helper exits at the deadline at the latest). */
  deadlineMs: number;
  /** The exact spawned pid the COM GetProcessID must equal (spawn mode). */
  expectedPid?: number;
  /**
   * Optional cancellation of ONE helper invocation: on abort the runner kills
   * ONLY its own helper child and rejects with
   * {@link SolidWorksComHelperAbortedError} (after the child's close,
   * bounded by the grace) — used by the probe's owned-process-exited early
   * path. Absent for attach/discover and for injected seam runners that do
   * not need it.
   */
  signal?: AbortSignal;
}

/** Parsed outcome of one PowerShell helper invocation. */
export interface SolidWorksComHelperOutcome {
  ok: boolean;
  /** True when a live COM instance was attached (attach/spawn modes). */
  attached: boolean;
  /** The COM GetProcessID of the attached instance, or 0. */
  pid: number;
  /** The RevisionNumber of the attached instance, or null. */
  revision: string | null;
  /** True when the attached instance's pid differed from the spawned pid. */
  foreign: boolean;
  /** Verified SLDWORKS.exe path (discover mode), or null. */
  executablePath: string | null;
  /** SLDWORKS.exe FileVersion (discover mode), or null. */
  fileVersion: string | null;
  /** Discovery source (discover mode), or null. */
  source: string | null;
}

/** The command seam: ONE bounded helper invocation (PowerShell discovery, Python/pywin32 COM). */
export type SolidWorksComHelperRunner = (
  request: SolidWorksComHelperRequest
) => Promise<SolidWorksComHelperOutcome>;

/** The bounded-helper rejection when the helper outlived its hard bound. */
export class SolidWorksComHelperTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolidWorksComHelperTimeoutError";
  }
}

/**
 * The bounded-helper rejection when the probe ABORTED the helper because the
 * owned SolidWorks process exited before COM ownership was proven (the
 * owned-process-exited early path). The abort kills ONLY the helper child
 * (never the owned process, never a foreign process) and the rejection
 * settles only after the helper child's close was observed within the grace
 * bound — the probe awaits it, so no helper is ever left terminating.
 */
export class SolidWorksComHelperAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolidWorksComHelperAbortedError";
  }
}

/**
 * The bounded COM helper runner. Two child transports, both `shell: false` /
 * `windowsHide: true` with a NODE-side hard bound (deadline + grace) that
 * terminates the helper child itself when a COM dispatch blocks:
 *
 * - `discover`: the PowerShell helper (the pipe-acl `-EncodedCommand` idiom) —
 *   the script ships as a template literal, is delivered via UTF-16LE base64
 *   (no temp file — works inside app.asar), receives its mode / deadline
 *   through dedicated env vars (no shell interpolation), forces UTF-8 on its
 *   redirected stdout pipe and emits exactly one `SWPANEL_SW_RESULT <json>`
 *   marker line on stdout.
 * - `attach` / `spawn`: a Python/pywin32 helper (`python -c <script>`, the
 *   script also ships as a template literal — no temp file) that
 *   `CoInitialize`s its thread, polls `win32com.client.GetActiveObject` and
 *   reads `GetProcessID()` + `RevisionNumber()`. The helper NEVER creates a
 *   COM instance (`Dispatch`/`Create`): it only attaches to a running object,
 *   so Node remains the only spawner and owner. When Python or pywin32 is
 *   unavailable the helper reports `ok: false` (fail closed, never a spawn
 *   decision; nothing is ever installed automatically). Both transports emit
 *   the same bounded stdout/stderr and the same UTF-8 marker protocol.
 *
 * The helper process is OUR child: when a COM dispatch blocks past the hard
 * bound (deadline + grace), Node terminates the helper itself and rejects with
 * {@link SolidWorksComHelperTimeoutError} — the bounded helper can never hang
 * the probe.
 */
export const DEFAULT_SOLIDWORKS_COM_HELPER_RUNNER: SolidWorksComHelperRunner = (request) =>
  runSolidWorksComHelper(request);

export interface SolidWorksComHelperRunnerOptions {
  /** Injectable child-process spawner (hermetic tests script it). */
  spawn?: typeof spawn;
  /** Injectable environment base (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injectable hard-bound grace on top of the request deadline. */
  graceMs?: number;
  /**
   * Injectable Python argv of the COM attach/spawn helper (default
   * {@link DEFAULT_SOLIDWORKS_PYTHON_COMMAND}, e.g. `["py", "-3"]`). The first
   * element is the executable; any further elements lead it verbatim; the
   * runner appends `-c <script>` itself.
   */
  pythonCommand?: readonly string[];
}

/**
 * Runs ONE bounded helper invocation and parses its result marker: `discover`
 * through the PowerShell registry helper, `attach`/`spawn` through the
 * Python/pywin32 COM helper. Rejects when the helper failed to start, exited
 * non-zero, produced no parseable marker, or outlived its hard bound
 * ({@link SolidWorksComHelperTimeoutError}). A signal that is ALREADY aborted
 * at entry rejects PROMPTLY with {@link SolidWorksComHelperAbortedError}
 * WITHOUT spawning any child (nothing to kill, nothing to await, no timer);
 * an abort that fires after the child exists kills ONLY the helper child and
 * the rejection settles after its close (bounded by the grace). stdout/stderr
 * capture is bounded.
 */
export async function runSolidWorksComHelper(
  request: SolidWorksComHelperRequest,
  options: SolidWorksComHelperRunnerOptions = {}
): Promise<SolidWorksComHelperOutcome> {
  const signal = request.signal;
  // A signal ALREADY aborted at entry: the invocation is cancelled before any
  // child is spawned — reject promptly with the aborted-helper error rather
  // than timing out. Nothing is spawned, so nothing is killed or awaited;
  // no user/foreign process is ever touched.
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(new SolidWorksComHelperAbortedError(SOLIDWORKS_HELPER_ABORT_MESSAGE));
  }
  const spawnFn = options.spawn ?? spawn;
  const env = options.env ?? process.env;
  const graceMs = options.graceMs ?? DEFAULT_SOLIDWORKS_HELPER_GRACE_MS;
  const childEnv = {
    ...env,
    [SOLIDWORKS_PROBE_MODE_ENV]: request.mode,
    [SOLIDWORKS_PROBE_DEADLINE_MS_ENV]: String(request.deadlineMs),
    ...(request.expectedPid === undefined
      ? {}
      : { [SOLIDWORKS_EXPECTED_PID_ENV]: String(request.expectedPid) })
  };
  let command: string;
  let args: string[];
  if (request.mode === "discover") {
    // Year-agnostic installation discovery stays the PowerShell registry
    // helper (EncodedCommand UTF-16LE base64 — no temp file, asar-safe).
    command = "powershell";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(SOLIDWORKS_DISCOVER_SCRIPT, "utf16le").toString("base64")
    ];
  } else {
    // COM attach/spawn runs in a bounded Python/pywin32 child: PowerShell's
    // Marshal.GetActiveObject returns TYPE_E_ELEMENTNOTFOUND on real hosts
    // where pywin32 GetActiveObject works. The script ships inline (-c), never
    // a temp file.
    const pythonCommand = options.pythonCommand ?? DEFAULT_SOLIDWORKS_PYTHON_COMMAND;
    const pythonExecutable = pythonCommand[0];
    if (pythonExecutable === undefined) {
      return Promise.reject(
        new Error("the SolidWorks probe helper has no configured Python command")
      );
    }
    command = pythonExecutable;
    args = [...pythonCommand.slice(1), "-c", SOLIDWORKS_PYTHON_COM_SCRIPT];
  }
  return new Promise((resolve, reject) => {
    const signal = request.signal;
    const child = spawnFn(command, args, {
      env: childEnv,
      shell: false,
      windowsHide: true
    });
    // Guards the promise against double-settlement (abort vs. close vs.
    // hard bound): the first settling path wins, the others become no-ops.
    let settled = false;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_SOLIDWORKS_HELPER_STDOUT_CHARS) {
        stdout += chunk.toString("utf8");
        if (stdout.length > MAX_SOLIDWORKS_HELPER_STDOUT_CHARS) {
          stdout = stdout.slice(0, MAX_SOLIDWORKS_HELPER_STDOUT_CHARS);
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_SOLIDWORKS_HELPER_STDERR_CHARS) {
        stderr += chunk.toString("utf8");
        if (stderr.length > MAX_SOLIDWORKS_HELPER_STDERR_CHARS) {
          stderr = stderr.slice(0, MAX_SOLIDWORKS_HELPER_STDERR_CHARS);
        }
      }
    });
    const hardBound = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(
        new SolidWorksComHelperTimeoutError(
          `the SolidWorks probe helper exceeded its hard bound (${request.deadlineMs + graceMs} ms)`
        )
      );
    }, request.deadlineMs + graceMs);
    const onAbort = () => {
      // Cancellation AFTER the helper completed is a no-op: nothing is killed
      // and the settled outcome stands.
      if (settled) return;
      settled = true;
      clearTimeout(hardBound);
      signal?.removeEventListener("abort", onAbort);
      try {
        child.kill();
      } catch {
        // already gone
      }
      // Await the helper child's closure (bounded by the grace) so the probe
      // never returns with the helper still terminating: the rejection fires
      // on the child's 'close' or at the grace bound, whichever comes first.
      const abortCloseBound = setTimeout(() => {
        reject(new SolidWorksComHelperAbortedError(SOLIDWORKS_HELPER_ABORT_MESSAGE));
      }, graceMs);
      child.once("close", () => {
        clearTimeout(abortCloseBound);
        reject(new SolidWorksComHelperAbortedError(SOLIDWORKS_HELPER_ABORT_MESSAGE));
      });
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardBound);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`the SolidWorks probe helper failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardBound);
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error(`the SolidWorks probe helper failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      const outcome = parseSolidWorksHelperOutcome(stdout);
      if (outcome === null) {
        reject(new Error("the SolidWorks probe helper produced no parseable result"));
        return;
      }
      resolve(outcome);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parses the helper's `SWPANEL_SW_RESULT <json>` marker line. Returns null
 * for a missing marker, malformed JSON, a non-object payload or `ok: false`.
 */
export function parseSolidWorksHelperOutcome(stdout: string): SolidWorksComHelperOutcome | null {
  const markerIndex = stdout.indexOf(SOLIDWORKS_RESULT_MARKER);
  if (markerIndex < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(markerIndex + SOLIDWORKS_RESULT_MARKER.length).trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["ok"] !== true) return null;
  return {
    ok: true,
    attached: parsed["attached"] === true,
    pid: typeof parsed["pid"] === "number" ? parsed["pid"] : 0,
    revision:
      typeof parsed["revision"] === "string" && parsed["revision"].trim().length > 0
        ? parsed["revision"]
        : null,
    foreign: parsed["foreign"] === true,
    executablePath:
      typeof parsed["executablePath"] === "string" && parsed["executablePath"].length > 0
        ? parsed["executablePath"]
        : null,
    fileVersion:
      typeof parsed["fileVersion"] === "string" && parsed["fileVersion"].length > 0
        ? parsed["fileVersion"]
        : null,
    source:
      typeof parsed["source"] === "string" && parsed["source"].length > 0
        ? parsed["source"]
        : null
  };
}

/**
 * The default discovery: one bounded PowerShell helper invocation in
 * `discover` mode (registry + file-version discovery, year-agnostic), mapped
 * onto the installation shape. A clean empty discovery returns null; helper
 * startup/protocol/timeout failures reject so the live probe can distinguish
 * them from a host where no installation was found.
 */
export const DEFAULT_SOLIDWORKS_INSTALLATION_DISCOVERY: SolidWorksInstallationDiscovery =
  async () => {
    const outcome = await runSolidWorksComHelper({
      mode: "discover",
      deadlineMs: DEFAULT_SOLIDWORKS_DISCOVER_HELPER_TIMEOUT_MS
    });
    if (!outcome.ok || outcome.executablePath === null) return null;
    return {
      executablePath: outcome.executablePath,
      fileVersion: outcome.fileVersion,
      source: outcome.source === "product-setup" ? "product-setup" : outcome.source === "uninstall" ? "uninstall" : "standard-path"
    };
  };

export interface SolidWorksLiveProbeOptions {
  /**
   * The spawn seam of SLDWORKS.exe. Default: the real shell:false /
   * windowsHide:true spawn ({@link DEFAULT_SOLIDWORKS_SPAWNER}) — Node
   * captures the exact owned pid before any helper runs.
   */
  spawner?: SolidWorksProcessSpawner;
  /**
   * The installation discovery seam. Default: the real registry + file-version
   * helper discovery ({@link DEFAULT_SOLIDWORKS_INSTALLATION_DISCOVERY}).
   */
  discoverInstallation?: SolidWorksInstallationDiscovery;
  /**
   * The bounded helper runner seam (PowerShell discovery + Python/pywin32 COM
   * attach/spawn). Default: the real helper
   * ({@link DEFAULT_SOLIDWORKS_COM_HELPER_RUNNER}).
   */
  runComHelper?: SolidWorksComHelperRunner;
  /** Bound of the READ-ONLY pre-existing-instance attach poll (ms). */
  attachTimeoutMs?: number;
  /** Bound of the ownership-proving spawn poll (ms). */
  spawnTimeoutMs?: number;
  /** Deterministic clock of the snapshot timestamp (default wall clock). */
  now?: () => Date;
  /** Injectable platform for hermetic tests (default process.platform). */
  platform?: NodeJS.Platform;
}

/**
 * The authoritative live SolidWorks probe of ONE call. Never throws for a
 * runtime failure — it returns the fail-closed snapshot (the preflight gate
 * records the boolean and stays redacted); only the probe's own catch-all
 * converts an unexpected internal failure into `probe-threw` so startup never
 * crashes because of the probe.
 */
export async function probeSolidWorksRuntime(
  options: SolidWorksLiveProbeOptions = {}
): Promise<SolidWorksLiveProbeResult> {
  let probedAt: string;
  try {
    probedAt = (options.now ?? (() => new Date()))().toISOString();
  } catch {
    probedAt = new Date().toISOString();
  }
  try {
    return await probeSolidWorksRuntimeUnsafe(options, probedAt);
  } catch {
    return failClosedSolidWorksResult({ probedAt, reason: "probe-threw" });
  }
}

/** The probe body; any throw here is converted to `probe-threw` by the wrapper. */
async function probeSolidWorksRuntimeUnsafe(
  options: SolidWorksLiveProbeOptions,
  probedAt: string
): Promise<SolidWorksLiveProbeResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return failClosedSolidWorksResult({ probedAt, reason: "unsupported-platform" });
  }
  const attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_SOLIDWORKS_ATTACH_PROBE_TIMEOUT_MS;
  const spawnTimeoutMs = options.spawnTimeoutMs ?? DEFAULT_SOLIDWORKS_SPAWN_PROBE_TIMEOUT_MS;
  const discoverInstallation =
    options.discoverInstallation ?? DEFAULT_SOLIDWORKS_INSTALLATION_DISCOVERY;
  const spawner = options.spawner ?? DEFAULT_SOLIDWORKS_SPAWNER;
  const runComHelper = options.runComHelper ?? DEFAULT_SOLIDWORKS_COM_HELPER_RUNNER;

  // 1. Year-agnostic installation discovery (registry + file version); fail
  //    closed without a verified executable.
  let installation: SolidWorksInstallation | null;
  try {
    installation = await discoverInstallation();
  } catch {
    return failClosedSolidWorksResult({ probedAt, reason: "com-helper-failed" });
  }
  if (installation === null) {
    return failClosedSolidWorksResult({ probedAt, reason: "no-installation-found" });
  }
  const installedVersion = installation.fileVersion;

  // 2. READ-ONLY attach to a pre-existing instance (verify GetProcessID +
  //    RevisionNumber; NEVER closed, NEVER documents touched). The probe
  //    fails closed IMMEDIATELY on a thrown/timed-out/foreign/malformed
  //    attach — ONLY a clean `ok: true, attached: false` outcome may enter
  //    the owned-spawn path. An attach failure is never treated as "no
  //    instance" and never triggers a spawn.
  let attach: SolidWorksComHelperOutcome | null;
  try {
    attach = await runComHelper({ mode: "attach", deadlineMs: attachTimeoutMs });
  } catch (error) {
    return failClosedSolidWorksResult({
      probedAt,
      installedVersion,
      reason:
        error instanceof SolidWorksComHelperTimeoutError
          ? "com-helper-timeout"
          : "com-helper-failed"
    });
  }
  // A null/malformed seam result (`ok: false`) is a helper failure: fail
  // closed — never spawn, never resolve null, never throw at startup.
  if (attach === null || !attach.ok) {
    return failClosedSolidWorksResult({
      probedAt,
      installedVersion,
      reason: "com-helper-failed"
    });
  }
  if (isLiveInstance(attach)) {
    return {
      available: true,
      version: attach.revision,
      installedVersion,
      ownedProcessSpawned: false,
      ownedProcessClosed: false,
      ownedProcessExitCode: null,
      reason: "attached-pre-existing-instance",
      probedAt
    };
  }
  // Attached but unreadable (missing pid/revision) or a foreign pid: a
  // half-attached COM object is never trusted — fail closed, never spawn.
  if (attach.attached || attach.foreign) {
    return failClosedSolidWorksResult({
      probedAt,
      installedVersion,
      reason: "com-helper-failed"
    });
  }
  // attach.ok === true && attached === false && !foreign: the ONLY clean
  // entry into the owned-spawn path below.

  // 3. No instance: spawn SLDWORKS.exe DIRECTLY from Node (shell:false,
  //    windowsHide:true) so the exact owned pid is captured BEFORE any later
  //    action. From here on, cleanup is mandatory and touches ONLY this
  //    process — even when the helper construction or the poll fails.
  let spawned: SpawnedSolidWorksProcess;
  try {
    spawned = spawner(installation.executablePath);
  } catch {
    return failClosedSolidWorksResult({ probedAt, installedVersion, reason: "spawn-failed" });
  }
  const ownedPid = spawned.pid;
  if (ownedPid === undefined || ownedPid <= 0) {
    await closeOwnedProcess(spawned);
    return failClosedSolidWorksResult({ probedAt, installedVersion, reason: "spawn-failed" });
  }

  let result: SolidWorksLiveProbeResult | null = null;
  try {
    // 4. Bounded COM ownership proof with a CONCURRENT exact-owned-process
    //    exit observation. The helper polls GetActiveObject and REQUIRES
    //    GetProcessID == the exact spawned pid before reading RevisionNumber;
    //    a foreign instance (different pid) fails closed and is never touched.
    //    While the helper polls, the probe observes the EXACT spawned child
    //    handle: the moment OUR process exits before ownership is proven (the
    //    real startup crash signature 0xC0000005 / 3221225477, after which
    //    SLDWORKS.exe can never register in the COM ROT), the helper is
    //    aborted and the probe fails closed promptly — it never waits out the
    //    full spawn bound for a process that is already gone.
    let outcome: SolidWorksComHelperOutcome | null = null;
    let helperError: unknown = null;
    const controller = new AbortController();
    const helperSettled = (async () => {
      try {
        outcome = await runComHelper({
          mode: "spawn",
          deadlineMs: spawnTimeoutMs,
          expectedPid: ownedPid,
          signal: controller.signal
        });
      } catch (error) {
        helperError = error;
      }
    })();
    try {
      // The observation listens at least as long as the helper's own hard
      // bound (deadline + grace), so no exit the helper could have polled
      // past is missed. It observes ONLY this exact owned handle.
      const exitObservation = spawned.observeExit(
        spawnTimeoutMs + DEFAULT_SOLIDWORKS_HELPER_GRACE_MS
      );
      // Promise.race settles with whichever reaction settles first in
      // MICROTASK order — never a wall-clock tie: a PRE-SETTLED exit
      // observation (a promise already fulfilled when the race is built)
      // queues its reaction immediately and beats the helper's proof even
      // when the proof settles in the very same tick — the probe then fails
      // closed on the ambiguity. The helper's proof wins only when its
      // reaction settles first, and success behavior stays unchanged (a valid
      // COM proof can only exist while the process is alive).
      const first = await Promise.race([
        helperSettled.then(() => "helper" as const),
        exitObservation.promise.then((observed) => observed)
      ]);
      if (first === "helper") {
        // The helper decided (proof, foreign instance, timeout, failure, or
        // no proof): the exit observation must not outlive the race — detach
        // its timer/listeners so nothing holds Node open.
        exitObservation.cancel();
        result = mapSpawnPhaseOutcome({ outcome, helperError, ownedPid, installedVersion, probedAt });
      } else if (first.exited) {
        // OUR OWN process exited before COM ownership was proven: abort the
        // bounded helper child (kills ONLY the helper; the exact owned
        // process is already gone — never a foreign or user process) and
        // AWAIT its closure — the abort settles the helper within the grace
        // bound. Then fail closed promptly with the observed, normalized
        // exit status.
        controller.abort();
        await helperSettled;
        result = {
          available: false,
          version: null,
          installedVersion,
          ownedProcessSpawned: true,
          ownedProcessClosed: true,
          ownedProcessExitCode: first.exitCode,
          reason: "owned-process-exited",
          probedAt
        };
      } else {
        // The observation bound elapsed WITHOUT an exit (the owned process is
        // still alive): the helper is at its own hard bound — fall through to
        // the standard helper mapping (com-helper-timeout). No abort: killing
        // the helper here would misreport a timeout as an abort.
        await helperSettled;
        result = mapSpawnPhaseOutcome({ outcome, helperError, ownedPid, installedVersion, probedAt });
      }
    } catch {
      // An UNEXPECTED post-spawn failure (a malformed observation seam that
      // THROWS, a REJECTING observation — the contract says it never rejects
      // but a seam can — or any other unexpected error after the exact owned
      // handle exists): abort ONLY our own helper child and await its
      // closure, then fail closed with `probe-threw`. The finally below still
      // attaches the truthful ownedProcessSpawned / ownedProcessClosed
      // cleanup facts and installedVersion is preserved — the failure never
      // bubbles to the outer wrapper, so the ownership truth is never lost.
      // No user/foreign process is touched — only the owned handle is closed.
      controller.abort();
      await helperSettled;
      result = failClosedSolidWorksResult({ probedAt, installedVersion, reason: "probe-threw" });
    }
  } finally {
    // 5. Cleanup is AWAITED before the snapshot resolves and touches ONLY the
    //    exact Node-spawned process (never a name match, never an enumeration,
    //    never a pid-delta computation). Every post-spawn result truthfully
    //    reports that the owned process WAS spawned and records whether its
    //    exit was observed.
    const closed = await closeOwnedProcess(spawned);
    if (result !== null) {
      result = { ...result, ownedProcessSpawned: true, ownedProcessClosed: closed };
    }
  }
  // Defense in depth: no code path may resolve the probe to null. A post-spawn
  // unexpected failure was already converted to `probe-threw` INSIDE the try
  // (facts preserved, cleanup awaited in the finally); anything else that ever
  // threw here is still caught by the outer wrapper.
  return (
    result ??
    failClosedSolidWorksResult({ probedAt, installedVersion, reason: "com-helper-failed" })
  );
}

/** True when the outcome proves a live, readable COM instance. */
function isLiveInstance(outcome: SolidWorksComHelperOutcome): boolean {
  return outcome.attached && outcome.pid > 0 && isNonEmpty(outcome.revision);
}

function isNonEmpty(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/**
 * Maps a SETTLED spawn-mode helper phase onto the snapshot — the standard,
 * stable mappings (helper error → com-helper-failed / com-helper-timeout;
 * malformed or `ok: false` seam result → com-helper-failed; exact-pid proof →
 * owned-process-proven; foreign pid → foreign-instance-owner; otherwise →
 * ownership-not-proven). Used by the probe when the HELPER's reaction settled
 * before the exit observation's reaction (microtask order — see the race);
 * the owned-process-exited early path is decided by the race, never by this
 * mapping.
 */
function mapSpawnPhaseOutcome(input: {
  outcome: SolidWorksComHelperOutcome | null;
  helperError: unknown;
  ownedPid: number;
  installedVersion: string | null;
  probedAt: string;
}): SolidWorksLiveProbeResult {
  const { outcome, helperError, ownedPid, installedVersion, probedAt } = input;
  if (helperError !== null) {
    return failClosedSolidWorksResult({
      probedAt,
      installedVersion,
      reason:
        helperError instanceof SolidWorksComHelperTimeoutError
          ? "com-helper-timeout"
          : "com-helper-failed"
    });
  }
  if (outcome === null || !outcome.ok) {
    // A null/malformed seam result is a helper failure: fail closed — the
    // probe never resolves null and never throws at startup.
    return failClosedSolidWorksResult({ probedAt, installedVersion, reason: "com-helper-failed" });
  }
  if (outcome.attached && outcome.pid === ownedPid && isNonEmpty(outcome.revision)) {
    return {
      available: true,
      version: outcome.revision,
      installedVersion,
      ownedProcessSpawned: true,
      ownedProcessClosed: false,
      ownedProcessExitCode: null,
      reason: "owned-process-proven",
      probedAt
    };
  }
  if (outcome.foreign) {
    return failClosedSolidWorksResult({ probedAt, installedVersion, reason: "foreign-instance-owner" });
  }
  return failClosedSolidWorksResult({ probedAt, installedVersion, reason: "ownership-not-proven" });
}

/**
 * Closes EXACTLY the owned process: terminate on the owned handle, then AWAIT
 * its exit within the close bound. Never throws; returns whether the exit was
 * observed (the diagnostic `ownedProcessClosed` truth).
 */
async function closeOwnedProcess(spawned: SpawnedSolidWorksProcess): Promise<boolean> {
  try {
    try {
      spawned.kill();
    } catch {
      // the process is already gone
    }
    return await spawned.waitExit(DEFAULT_SOLIDWORKS_CLOSE_GRACE_MS);
  } catch {
    return false;
  }
}

/**
 * The PowerShell discovery helper script (template literal; delivered via
 * `-EncodedCommand` UTF-16LE base64 — no temp file, asar-safe). ONE mode:
 *
 * - `discover`: year-agnostic installation discovery — uninstall
 *   DisplayName/InstallLocation entries and the
 *   `SOFTWARE\SolidWorks\SOLIDWORKS <year>\Setup` "SolidWorks Folder" value
 *   (64-bit and 32-bit views) plus the standard install location fallback —
 *   verifying the actual SLDWORKS.exe existence and FileVersion. Emits
 *   `{ ok, executablePath, fileVersion, source }` (plus the shared
 *   attached/pid/revision/foreign fields, always empty here).
 *
 * The COM attach/spawn work does NOT live here: PowerShell's
 * `[Marshal]::GetActiveObject` returns TYPE_E_ELEMENTNOTFOUND on real hosts
 * where pywin32 works, so attach/spawn run in the Python helper
 * ({@link SOLIDWORKS_PYTHON_COM_SCRIPT}).
 */
const SOLIDWORKS_DISCOVER_SCRIPT = String.raw`
# Force UTF-8 on the redirected stdout pipe: the Node side decodes the result
# marker as UTF-8, so the helper must never fall back to the OEM code page
# (non-ASCII install paths would be mangled).
try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ErrorActionPreference = 'Stop'

$mode = $env:SWPANEL_SW_PROBE_MODE
if ($mode -ne 'discover') { Write-Error ('SWPANEL_SW_PROBE_MODE must be ''discover'' but is: ' + $mode); exit 1 }

$candidates = New-Object System.Collections.ArrayList
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
function Add-Candidate([string]$dir, [string]$source) {
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  $exe = Join-Path $dir 'SLDWORKS.exe'
  try {
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
      if ($seen.Add($exe.ToLowerInvariant())) {
        $null = $candidates.Add(@{ exe = $exe; source = $source })
      }
    }
  } catch { }
}
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
  $base = $null
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
  } catch { continue }
  try {
    $uninstall = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
    if ($null -ne $uninstall) {
      foreach ($subName in $uninstall.GetSubKeyNames()) {
        try {
          $sub = $uninstall.OpenSubKey($subName)
          if ($null -ne $sub) {
            $displayName = [string]$sub.GetValue('DisplayName')
            if ($displayName -match 'SOLIDWORKS') {
              Add-Candidate ([string]$sub.GetValue('InstallLocation')) 'uninstall'
            }
            $sub.Close()
          }
        } catch { }
      }
      $uninstall.Close()
    }
  } catch { }
  try {
    $solidworks = $base.OpenSubKey('SOFTWARE\SolidWorks')
    if ($null -ne $solidworks) {
      foreach ($subName in $solidworks.GetSubKeyNames()) {
        if ($subName -notmatch '^SOLIDWORKS\s') { continue }
        try {
          $setup = $solidworks.OpenSubKey($subName + '\Setup')
          if ($null -ne $setup) {
            Add-Candidate ([string]$setup.GetValue('SolidWorks Folder')) 'product-setup'
            $setup.Close()
          }
        } catch { }
      }
      $solidworks.Close()
    }
  } catch { }
  if ($null -ne $base) { $base.Close() }
}
# Year-independent standard install location (fallback; verified by existence).
Add-Candidate (Join-Path $env:ProgramFiles 'SOLIDWORKS Corp\SOLIDWORKS') 'standard-path'
if ($candidates.Count -gt 0) {
  $first = $candidates[0]
  $fileVersion = $null
  try {
    $versionInfo = (Get-Item -LiteralPath $first.exe).VersionInfo
    if ($null -ne $versionInfo) { $fileVersion = [string]$versionInfo.FileVersion }
  } catch { }
  $result = @{ ok = $true; attached = $false; pid = 0; revision = ''; foreign = $false; executablePath = $first.exe; fileVersion = $fileVersion; source = $first.source }
  Write-Output ('SWPANEL_SW_RESULT ' + ($result | ConvertTo-Json -Compress))
  exit 0
}
$result = @{ ok = $true; attached = $false; pid = 0; revision = ''; foreign = $false; executablePath = $null; fileVersion = $null; source = $null }
Write-Output ('SWPANEL_SW_RESULT ' + ($result | ConvertTo-Json -Compress))
exit 0
`;

/**
 * The Python/pywin32 COM helper script (template literal; delivered via
 * `python -c <script>` — no temp file, asar-safe). Two modes:
 *
 * - `attach`: READ-ONLY bounded poll of
 *   `win32com.client.GetActiveObject("SldWorks.Application")`; on attach reads
 *   `GetProcessID()` + `RevisionNumber()` and emits
 *   `{ ok, attached, pid, revision, foreign }`. Never closes anything, never
 *   touches documents.
 * - `spawn`: same bounded poll, but requires `GetProcessID` to equal
 *   `SWPANEL_SW_EXPECTED_PID`; a live instance with a DIFFERENT pid is
 *   reported `foreign: true` (the Node side fails closed and never touches
 *   it).
 *
 * The helper NEVER creates a COM instance (no `Dispatch`/`Create`): it only
 * attaches to an already-running object, so Node remains the only spawner and
 * owner. When Python or pywin32 is unavailable it reports `ok: false` (fail
 * closed — the probe never installs dependencies and a helper failure never
 * falls through to a spawn decision). A COM dispatch that blocks past the
 * deadline cannot outlive the Node-side hard bound, which terminates the
 * helper process itself.
 */
const SOLIDWORKS_PYTHON_COM_SCRIPT = String.raw`
import json
import os
import sys
import time

# Force UTF-8 on the redirected stdout pipe: the Node side decodes the result
# marker as UTF-8, so the helper must never fall back to the locale encoding
# (non-ASCII revisions would be mangled).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

mode = os.environ.get("SWPANEL_SW_PROBE_MODE", "")
if mode not in ("attach", "spawn"):
    sys.stderr.write("SWPANEL_SW_PROBE_MODE must be 'attach' or 'spawn'\n")
    sys.exit(1)

try:
    deadline_ms = float(os.environ.get("SWPANEL_SW_PROBE_DEADLINE_MS", "") or 3000)
except ValueError:
    deadline_ms = 3000
if deadline_ms <= 0:
    deadline_ms = 3000
deadline = time.monotonic() + deadline_ms / 1000.0

expected_pid = -1
if mode == "spawn":
    try:
        expected_pid = int(os.environ.get("SWPANEL_SW_EXPECTED_PID", ""))
    except ValueError:
        expected_pid = -1
    if expected_pid <= 0:
        sys.stderr.write("SWPANEL_SW_EXPECTED_PID must be a positive pid\n")
        sys.exit(2)

result = {"ok": True, "attached": False, "pid": 0, "revision": "", "foreign": False}

try:
    import pythoncom
    import win32com.client
except Exception:
    # Python or pywin32 unavailable: fail closed. Never install anything and
    # never fall through to a spawn decision — the Node side rejects ok:false
    # and maps the helper failure to com-helper-failed.
    result["ok"] = False
    print("SWPANEL_SW_RESULT " + json.dumps(result, separators=(",", ":")))
    sys.exit(0)

try:
    pythoncom.CoInitialize()
except Exception:
    pass

attached = False
com_pid = 0
revision = ""
foreign = False

while True:
    if time.monotonic() >= deadline:
        break
    try:
        # ATTACH-ONLY: GetActiveObject never creates an instance — it resolves
        # the already-running object in the ROT (or raises when none exists).
        sw = win32com.client.GetActiveObject("SldWorks.Application")
        # Depending on the generated typelib wrapper these are methods or plain properties.
        _pid = sw.GetProcessID
        _rev = sw.RevisionNumber
        com_pid = int(_pid() if callable(_pid) else _pid)
        revision = str(_rev() if callable(_rev) else _rev)
        attached = True
        if mode == "spawn" and com_pid != expected_pid:
            foreign = True
        break
    except Exception:
        time.sleep(0.3)

try:
    pythoncom.CoUninitialize()
except Exception:
    pass

result = {"ok": True, "attached": attached, "pid": com_pid, "revision": revision, "foreign": foreign}
print("SWPANEL_SW_RESULT " + json.dumps(result, separators=(",", ":")))
`;
