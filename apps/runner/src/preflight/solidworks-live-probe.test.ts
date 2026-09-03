import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { RealPreflightProbe } from "./real-preflight-probe.js";
import {
  DEFAULT_SOLIDWORKS_PYTHON_COMMAND,
  DEFAULT_SOLIDWORKS_SPAWNER,
  failClosedSolidWorksResult,
  normalizeWindowsExitStatus,
  parseSolidWorksHelperOutcome,
  probeSolidWorksRuntime,
  runSolidWorksComHelper,
  SolidWorksComHelperAbortedError,
  SolidWorksComHelperTimeoutError,
  solidWorksProbeResultOf,
  type SolidWorksComHelperOutcome,
  type SolidWorksComHelperRequest,
  type SolidWorksComHelperRunner,
  type SolidWorksInstallation,
  type SolidWorksLiveProbeResult,
  type SolidWorksOwnedExit,
  type SolidWorksOwnedExitObservation,
  type SolidWorksProcessSpawner,
  type SpawnedSolidWorksProcess
} from "./solidworks-live-probe.js";

/**
 * Hermetic suite of the live SolidWorks probe (P5-1 real discovery). Every
 * test injects the process / command / discovery seams — NO test ever spawns
 * or attaches to a real SolidWorks process, and nothing is ever killed except
 * the fake OWNED process the tests script (the only real children are the
 * tiny node / never-spawned-error probes of DEFAULT_SOLIDWORKS_SPAWNER's
 * waitExit, which touch no SolidWorks machinery).
 */

const INSTALLATION: SolidWorksInstallation = {
  executablePath: "C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\SLDWORKS.exe",
  fileVersion: "33.0.0.5050",
  source: "uninstall"
};

function helperOutcome(
  overrides: Partial<SolidWorksComHelperOutcome> = {}
): SolidWorksComHelperOutcome {
  return {
    ok: true,
    attached: false,
    pid: 0,
    revision: null,
    foreign: false,
    executablePath: null,
    fileVersion: null,
    source: null,
    ...overrides
  };
}

/** Scripted helper runner: sync outcomes, thrown Errors or rejected promises. */
function scriptedComHelper(
  script: (request: SolidWorksComHelperRequest) =>
    | SolidWorksComHelperOutcome
    | Error
    | Promise<SolidWorksComHelperOutcome>
): { runner: SolidWorksComHelperRunner; requests: SolidWorksComHelperRequest[] } {
  const requests: SolidWorksComHelperRequest[] = [];
  const runner: SolidWorksComHelperRunner = async (request) => {
    requests.push(request);
    const outcome = script(request);
    if (outcome instanceof Error) throw outcome;
    return await outcome;
  };
  return { runner, requests };
}

/** Fake OWNED process handle: kill/waitExit are spied, never a real process. */
function fakeOwnedProcess(
  pid: number,
  observeExitImpl?: (timeoutMs: number) => SolidWorksOwnedExitObservation
): {
  handle: SpawnedSolidWorksProcess;
  killCalls: () => number;
  exitCalls: () => number;
  observeExitCalls: () => number;
} {
  let killCalls = 0;
  let exitCalls = 0;
  let observeExitCalls = 0;
  return {
    handle: {
      pid,
      kill: () => {
        killCalls += 1;
      },
      waitExit: () => {
        exitCalls += 1;
        return Promise.resolve(true);
      },
      observeExit: (timeoutMs) => {
        observeExitCalls += 1;
        // Default: the owned process never exits within the bound — the
        // helper decides the race (matching the pre-early-exit behavior).
        return observeExitImpl !== undefined
          ? observeExitImpl(timeoutMs)
          : { promise: new Promise<SolidWorksOwnedExit>(() => {}), cancel: () => {} };
      }
    },
    killCalls: () => killCalls,
    exitCalls: () => exitCalls,
    observeExitCalls: () => observeExitCalls
  };
}

function fakeSpawner(handle: SpawnedSolidWorksProcess): {
  spawner: SolidWorksProcessSpawner;
  calls: () => string[];
} {
  const calls: string[] = [];
  return {
    spawner: (executablePath) => {
      calls.push(executablePath);
      return handle;
    },
    calls: () => calls
  };
}

function liveProbeOptions(overrides: {
  spawner: SolidWorksProcessSpawner;
  runner: SolidWorksComHelperRunner;
}): Parameters<typeof probeSolidWorksRuntime>[0] {
  return {
    platform: "win32",
    discoverInstallation: () => Promise.resolve(INSTALLATION),
    spawner: overrides.spawner,
    runComHelper: overrides.runner,
    now: () => new Date("2026-08-14T00:00:00.000Z")
  };
}

describe("probeSolidWorksRuntime (live SolidWorks probe, hermetic seams)", () => {
  it("attaches READ-ONLY to a pre-existing instance and never spawns or closes anything", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner, calls: spawnCalls } = fakeSpawner(owned.handle);
    const { runner, requests } = scriptedComHelper((request) => {
      if (request.mode === "attach") {
        return helperOutcome({ attached: true, pid: 1234, revision: "33.0.0.5050" });
      }
      throw new Error("spawn mode must never run when a pre-existing instance is attached");
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot).toEqual({
      available: true,
      version: "33.0.0.5050",
      installedVersion: "33.0.0.5050",
      ownedProcessSpawned: false,
      ownedProcessClosed: false,
      ownedProcessExitCode: null,
      reason: "attached-pre-existing-instance",
      probedAt: "2026-08-14T00:00:00.000Z"
    });
    expect(spawnCalls()).toEqual([]);
    expect(owned.killCalls()).toBe(0);
    expect(requests.map((request) => request.mode)).toEqual(["attach"]);
  });

  it("spawns ONLY when no instance exists, proves ownership by exact pid and closes ONLY the owned process (awaited)", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner, calls: spawnCalls } = fakeSpawner(owned.handle);
    const { runner, requests } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      if (request.mode === "spawn") {
        return helperOutcome({ attached: true, pid: 4242, revision: "33.0.0.5050" });
      }
      throw new Error(`unexpected helper mode ${request.mode}`);
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot.available).toBe(true);
    expect(snapshot.version).toBe("33.0.0.5050");
    expect(snapshot.installedVersion).toBe("33.0.0.5050");
    expect(snapshot.ownedProcessSpawned).toBe(true);
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(snapshot.ownedProcessExitCode).toBeNull();
    expect(snapshot.reason).toBe("owned-process-proven");
    // The spawner received the DISCOVERED executable and nothing else.
    expect(spawnCalls()).toEqual([INSTALLATION.executablePath]);
    // The owned process was killed exactly once and its exit was awaited.
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
    // The spawn-mode helper received the EXACT owned pid as its proof input.
    const spawnRequest = requests.find((request) => request.mode === "spawn");
    expect(spawnRequest?.expectedPid).toBe(4242);
  });

  it("AMD-style startup crash (no COM instance ever) fails closed and still records the installed/file version", async () => {
    const owned = fakeOwnedProcess(9000);
    const { spawner } = fakeSpawner(owned.handle);
    const { runner } = scriptedComHelper(() => {
      // The spawned process crashes at startup: GetActiveObject never yields.
      return helperOutcome();
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot.available).toBe(false);
    expect(snapshot.version).toBeNull();
    // The crash must NOT hide the real installation: file version recorded.
    expect(snapshot.installedVersion).toBe("33.0.0.5050");
    expect(snapshot.ownedProcessSpawned).toBe(true);
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(snapshot.ownedProcessExitCode).toBeNull();
    expect(snapshot.reason).toBe("ownership-not-proven");
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
  });

  it("a foreign (user) instance wins the poll: fail closed, never touch the foreign process", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner } = fakeSpawner(owned.handle);
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      // A pre-existing user instance with a DIFFERENT pid owns the COM object.
      return helperOutcome({ attached: true, pid: 9999, revision: "33.0.0.5050", foreign: true });
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("foreign-instance-owner");
    expect(snapshot.installedVersion).toBe("33.0.0.5050");
    expect(snapshot.ownedProcessExitCode).toBeNull();
    // ONLY our own spawned process is closed — the foreign pid is never killed.
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
  });

  it("the exact owned process exiting before ownership is proven aborts the helper and fails closed PROMPTLY (owned-process-exited, code recorded)", async () => {
    // The real defect: SLDWORKS.exe crashes at startup (~3.26 s, exit code
    // 3221225477 / 0xC0000005) before COM registration. The probe must NOT
    // wait out the full 60 s spawn bound: the exit observation wins the race,
    // the spawn-mode helper is aborted, and the probe fails closed with the
    // stable reason + the normalized exit status.
    const owned = fakeOwnedProcess(4242, () => ({
      promise: Promise.resolve<SolidWorksOwnedExit>({ exited: true, exitCode: 3221225477 }),
      cancel: () => {}
    }));
    const { spawner } = fakeSpawner(owned.handle);
    let spawnRequest: SolidWorksComHelperRequest | undefined;
    const { runner, requests } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      spawnRequest = request;
      // The helper keeps polling forever UNLESS the probe aborts it.
      return new Promise<SolidWorksComHelperOutcome>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(new SolidWorksComHelperAbortedError("aborted: owned process exited")),
          { once: true }
        );
      });
    });
    const startedAt = Date.now();
    const snapshot = await probeSolidWorksRuntime({
      platform: "win32",
      discoverInstallation: () => Promise.resolve(INSTALLATION),
      spawner,
      runComHelper: runner,
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });
    const elapsedMs = Date.now() - startedAt;
    expect(snapshot).toEqual({
      available: false,
      version: null,
      installedVersion: "33.0.0.5050",
      ownedProcessSpawned: true,
      ownedProcessClosed: true,
      ownedProcessExitCode: 3221225477,
      reason: "owned-process-exited",
      probedAt: "2026-08-14T00:00:00.000Z"
    });
    // Prompt: far below the default 60 s spawn bound.
    expect(elapsedMs).toBeLessThan(2_000);
    // The bounded helper child was aborted through its AbortSignal.
    expect(spawnRequest?.signal?.aborted).toBe(true);
    expect(requests.map((request) => request.mode)).toEqual(["attach", "spawn"]);
    // ONLY the exact owned process handle is closed/awaited — nothing foreign,
    // no enumeration, no name-based cleanup.
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
  });

  it("a valid proof whose reaction settles FIRST beats a later exit observation: success unchanged, observation cancelled", async () => {
    // Near-simultaneous helper success and process exit: the exit observation
    // settles in a LATER macrotask than the helper's microtask chain, so the
    // helper's reaction settles strictly first (Promise.race decides by
    // microtask order, never by wall-clock ties) — a valid COM proof can only
    // exist while the process is alive, so success behavior stays unchanged.
    const cancel = vi.fn();
    const owned = fakeOwnedProcess(4242, () => ({
      // Settles a macrotask AFTER the helper's microtask chain: "near"
      // simultaneous in wall-clock terms, strictly later in settle order.
      promise: new Promise<SolidWorksOwnedExit>((resolve) => {
        setTimeout(() => resolve({ exited: true, exitCode: 3221225477 }), 0);
      }),
      cancel
    }));
    const { spawner } = fakeSpawner(owned.handle);
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      return helperOutcome({ attached: true, pid: 4242, revision: "33.0.0.5050" });
    });
    const snapshot = await probeSolidWorksRuntime(liveProbeOptions({ spawner, runner }));
    expect(snapshot.available).toBe(true);
    expect(snapshot.reason).toBe("owned-process-proven");
    expect(snapshot.ownedProcessExitCode).toBeNull();
    // The losing observation was cancelled: its timer/listeners are detached.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(owned.killCalls()).toBe(1);
  });

  it("a PRE-SETTLED exit observation beats a same-tick helper proof (microtask order): fail closed on the ambiguity", async () => {
    // Promise.race settles with whichever REACTION settles first in microtask
    // order — never a wall-clock tie. An observation promise that is ALREADY
    // fulfilled when the race is built queues its reaction immediately, so it
    // beats the helper's proof even though the proof settles in the very same
    // tick. The conservative behavior fails closed (owned-process-exited)
    // instead of trusting a proof the exit may have invalidated a microtask
    // later — a pre-settled exit can never be outrun by a same-tick proof.
    const cancel = vi.fn();
    const owned = fakeOwnedProcess(4242, () => ({
      promise: Promise.resolve<SolidWorksOwnedExit>({ exited: true, exitCode: 3221225477 }),
      cancel
    }));
    const { spawner } = fakeSpawner(owned.handle);
    let spawnSignal: AbortSignal | undefined;
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      spawnSignal = request.signal;
      // A VALID exact-pid proof settling in the very same tick — still loses
      // the race to the pre-settled exit observation.
      return helperOutcome({ attached: true, pid: 4242, revision: "33.0.0.5050" });
    });
    const snapshot = await probeSolidWorksRuntime(liveProbeOptions({ spawner, runner }));
    expect(snapshot.available).toBe(false);
    expect(snapshot.version).toBeNull();
    expect(snapshot.installedVersion).toBe("33.0.0.5050");
    expect(snapshot.ownedProcessSpawned).toBe(true);
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(snapshot.ownedProcessExitCode).toBe(3221225477);
    expect(snapshot.reason).toBe("owned-process-exited");
    // The helper was aborted through its AbortSignal (already settled proof:
    // the abort is a no-op for the helper, nothing extra is killed).
    expect(spawnSignal?.aborted).toBe(true);
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
  });

  it("a REJECTING exit observation after the spawn fails closed as probe-threw while preserving installedVersion and the owned-process cleanup truth", async () => {
    // The observation contract says its promise NEVER rejects — but a seam can
    // violate it. The unexpected rejection must NOT bubble to the outer
    // wrapper (which would drop installedVersion and the ownership facts):
    // the probe aborts ONLY its own helper child, awaits the cleanup of the
    // exact owned handle and fails closed with `probe-threw` carrying
    // installedVersion + truthful ownedProcessSpawned / ownedProcessClosed.
    const owned = fakeOwnedProcess(4242, () => ({
      promise: Promise.reject(new Error("observation seam exploded")),
      cancel: () => {}
    }));
    const { spawner } = fakeSpawner(owned.handle);
    let spawnSignal: AbortSignal | undefined;
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      spawnSignal = request.signal;
      // The helper keeps polling forever UNLESS the probe aborts it.
      return new Promise<SolidWorksComHelperOutcome>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(new SolidWorksComHelperAbortedError("aborted: owned process exited")),
          { once: true }
        );
      });
    });
    const snapshot = await probeSolidWorksRuntime(liveProbeOptions({ spawner, runner }));
    expect(snapshot.available).toBe(false);
    expect(snapshot.version).toBeNull();
    expect(snapshot.installedVersion).toBe("33.0.0.5050");
    expect(snapshot.ownedProcessSpawned).toBe(true);
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(snapshot.ownedProcessExitCode).toBeNull();
    expect(snapshot.reason).toBe("probe-threw");
    // ONLY the exact owned handle is closed/awaited — no user/foreign process.
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
    // The bounded helper child was aborted through its AbortSignal.
    expect(spawnSignal?.aborted).toBe(true);
  });

  it("a THROWING observeExit seam after the spawn fails closed as probe-threw with the helper aborted and the owned cleanup awaited", async () => {
    // A malformed observation seam that THROWS synchronously is an unexpected
    // post-spawn failure: same fail-closed contract as a rejecting observation
    // — probe-threw with installedVersion and the truthful ownership facts,
    // helper child aborted, exact owned handle closed and awaited.
    const owned = fakeOwnedProcess(4242, () => {
      throw new Error("observeExit seam exploded");
    });
    const { spawner } = fakeSpawner(owned.handle);
    let spawnSignal: AbortSignal | undefined;
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      spawnSignal = request.signal;
      return new Promise<SolidWorksComHelperOutcome>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(new SolidWorksComHelperAbortedError("aborted: owned process exited")),
          { once: true }
        );
      });
    });
    const snapshot = await probeSolidWorksRuntime(liveProbeOptions({ spawner, runner }));
    expect(snapshot.available).toBe(false);
    expect(snapshot.installedVersion).toBe("33.0.0.5050");
    expect(snapshot.ownedProcessSpawned).toBe(true);
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(snapshot.ownedProcessExitCode).toBeNull();
    expect(snapshot.reason).toBe("probe-threw");
    expect(spawnSignal?.aborted).toBe(true);
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
  });

  it("an exit-observation bound elapse WITHOUT an exit keeps the standard helper mapping (com-helper-timeout)", async () => {
    // The owned process stays alive past the observation bound: the helper is
    // at its own hard bound, and the mapping must stay the stable
    // com-helper-timeout — the elapsed observation never becomes a
    // misreported owned-process-exited.
    const owned = fakeOwnedProcess(4242, () => ({
      promise: Promise.resolve<SolidWorksOwnedExit>({ exited: false, exitCode: null }),
      cancel: () => {}
    }));
    const { spawner } = fakeSpawner(owned.handle);
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      throw new SolidWorksComHelperTimeoutError("bounded helper exceeded its hard bound");
    });
    const snapshot = await probeSolidWorksRuntime(liveProbeOptions({ spawner, runner }));
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("com-helper-timeout");
    expect(snapshot.ownedProcessSpawned).toBe(true);
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(snapshot.ownedProcessExitCode).toBeNull();
    expect(owned.killCalls()).toBe(1);
  });

  it("a throwing spawner and a pid-less spawn fail closed; the pid-less spawn still awaits cleanup", async () => {
    // 1. The spawner itself throws: nothing was spawned, nothing to close.
    const throwing: SolidWorksProcessSpawner = () => {
      throw new Error("spawn exploded");
    };
    const { runner: runnerA } = scriptedComHelper(() => helperOutcome());
    const fromThrow = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner: throwing, runner: runnerA })
    );
    expect(fromThrow.available).toBe(false);
    expect(fromThrow.reason).toBe("spawn-failed");
    expect(fromThrow.ownedProcessSpawned).toBe(false);
    expect(fromThrow.ownedProcessClosed).toBe(false);

    // 2. The spawner returns a handle WITHOUT a pid (spawn error): fail closed
    //    AND still run the awaited cleanup of that (never-created) handle.
    const noPid = fakeOwnedProcess(0);
    const { spawner: noPidSpawner } = fakeSpawner({ ...noPid.handle, pid: undefined });
    const { runner: runnerB } = scriptedComHelper(() => helperOutcome());
    const fromNoPid = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner: noPidSpawner, runner: runnerB })
    );
    expect(fromNoPid.available).toBe(false);
    expect(fromNoPid.reason).toBe("spawn-failed");
    expect(fromNoPid.ownedProcessSpawned).toBe(false);
    expect(noPid.killCalls()).toBe(1);
    expect(noPid.exitCalls()).toBe(1);
  });

  it("a failing spawn-mode helper still closes ONLY the owned process (helper construction failure is not a leak)", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner } = fakeSpawner(owned.handle);
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      // The helper fails AFTER the spawn (broken COM helper, missing
      // powershell, ...): the owned process must still be closed + awaited.
      return new Error("powershell unavailable");
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("com-helper-failed");
    expect(snapshot.ownedProcessSpawned).toBe(true);
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
  });

  it("a helper that outlives its hard bound fails closed as com-helper-timeout (owned process still closed)", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner } = fakeSpawner(owned.handle);
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      throw new SolidWorksComHelperTimeoutError("bounded helper exceeded its hard bound");
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("com-helper-timeout");
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(owned.killCalls()).toBe(1);
  });

  it("an attach-mode helper failure fails closed IMMEDIATELY and NEVER spawns", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner, calls: spawnCalls } = fakeSpawner(owned.handle);
    const { runner, requests } = scriptedComHelper((request) => {
      if (request.mode === "attach") throw new Error("attach helper exploded");
      throw new Error("the owned-spawn path must never run when the attach failed");
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("com-helper-failed");
    expect(snapshot.ownedProcessSpawned).toBe(false);
    expect(snapshot.ownedProcessClosed).toBe(false);
    // NOTHING was spawned, nothing was killed, nothing was awaited.
    expect(spawnCalls()).toEqual([]);
    expect(owned.killCalls()).toBe(0);
    expect(owned.exitCalls()).toBe(0);
    expect(requests.map((request) => request.mode)).toEqual(["attach"]);
  });

  it("an attach-mode helper TIMEOUT fails closed immediately and NEVER spawns", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner, calls: spawnCalls } = fakeSpawner(owned.handle);
    const { runner, requests } = scriptedComHelper(() => {
      throw new SolidWorksComHelperTimeoutError("bounded helper exceeded its hard bound");
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("com-helper-timeout");
    expect(snapshot.ownedProcessSpawned).toBe(false);
    expect(spawnCalls()).toEqual([]);
    expect(owned.killCalls()).toBe(0);
    expect(requests.map((request) => request.mode)).toEqual(["attach"]);
  });

  it("a malformed attach outcome (ok:false / null / attached-but-unreadable) fails closed and NEVER spawns", async () => {
    const owned = fakeOwnedProcess(4242);
    // 1. A resolved `ok: false` outcome: a helper failure, never a spawn.
    const { spawner: spawnerA, calls: spawnCallsA } = fakeSpawner(owned.handle);
    const { runner: runnerA, requests: requestsA } = scriptedComHelper(() =>
      helperOutcome({ ok: false })
    );
    const fromNotOk = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner: spawnerA, runner: runnerA })
    );
    expect(fromNotOk.available).toBe(false);
    expect(fromNotOk.reason).toBe("com-helper-failed");
    expect(fromNotOk.ownedProcessSpawned).toBe(false);
    expect(spawnCallsA()).toEqual([]);
    expect(requestsA.map((request) => request.mode)).toEqual(["attach"]);

    // 2. A seam that resolves null (type violation): fail closed — never a
    //    null snapshot, never a startup throw, never a spawn.
    const nullRunner: SolidWorksComHelperRunner = () =>
      Promise.resolve(null as unknown as SolidWorksComHelperOutcome);
    const { spawner: spawnerB, calls: spawnCallsB } = fakeSpawner(owned.handle);
    const fromNull = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner: spawnerB, runner: nullRunner })
    );
    expect(fromNull).not.toBeNull();
    expect(fromNull.available).toBe(false);
    expect(fromNull.reason).toBe("com-helper-failed");
    expect(spawnCallsB()).toEqual([]);

    // 3. `attached: true` but unreadable (pid/revision missing): a
    //    half-attached COM object is never trusted — fail closed, never spawn.
    const { spawner: spawnerC, calls: spawnCallsC } = fakeSpawner(owned.handle);
    const { runner: runnerC } = scriptedComHelper(() => helperOutcome({ attached: true }));
    const fromMalformed = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner: spawnerC, runner: runnerC })
    );
    expect(fromMalformed.available).toBe(false);
    expect(fromMalformed.reason).toBe("com-helper-failed");
    expect(spawnCallsC()).toEqual([]);

    // Nothing was ever killed or awaited across all three cases.
    expect(owned.killCalls()).toBe(0);
    expect(owned.exitCalls()).toBe(0);
  });

  it("a spawn-mode helper resolving null (malformed seam) fails closed with the cleanup truth — never a null snapshot", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner } = fakeSpawner(owned.handle);
    const { runner, requests } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      return null as unknown as SolidWorksComHelperOutcome; // seam type violation
    });
    const snapshot = await probeSolidWorksRuntime(
      liveProbeOptions({ spawner, runner })
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("com-helper-failed");
    // The owned process was still closed + awaited (no leak, truthful flags).
    expect(snapshot.ownedProcessSpawned).toBe(true);
    expect(snapshot.ownedProcessClosed).toBe(true);
    expect(owned.killCalls()).toBe(1);
    expect(owned.exitCalls()).toBe(1);
    expect(requests.map((request) => request.mode)).toEqual(["attach", "spawn"]);
  });

  it("fails closed with no-installation-found: nothing spawned, nothing polled", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner, calls: spawnCalls } = fakeSpawner(owned.handle);
    const { runner, requests } = scriptedComHelper(() => helperOutcome());
    const snapshot = await probeSolidWorksRuntime({
      platform: "win32",
      discoverInstallation: () => Promise.resolve(null),
      spawner,
      runComHelper: runner,
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });
    expect(snapshot.available).toBe(false);
    expect(snapshot.installedVersion).toBeNull();
    expect(snapshot.reason).toBe("no-installation-found");
    expect(spawnCalls()).toEqual([]);
    expect(requests).toEqual([]);
    expect(owned.killCalls()).toBe(0);
  });

  it("fails closed on a non-win32 platform without touching process, command or registry seams", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner, calls: spawnCalls } = fakeSpawner(owned.handle);
    const { runner, requests } = scriptedComHelper(() => helperOutcome());
    const discover = vi.fn(() => Promise.resolve(INSTALLATION));
    const snapshot = await probeSolidWorksRuntime({
      platform: "linux",
      discoverInstallation: discover,
      spawner,
      runComHelper: runner,
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("unsupported-platform");
    expect(discover).not.toHaveBeenCalled();
    expect(spawnCalls()).toEqual([]);
    expect(requests).toEqual([]);
    expect(owned.killCalls()).toBe(0);
  });

  it("a thrown discovery is distinguished from a clean no-installation result and fails closed without crashing startup", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner } = fakeSpawner(owned.handle);
    const { runner } = scriptedComHelper(() => helperOutcome());
    const fromThrownDiscovery = await probeSolidWorksRuntime({
      platform: "win32",
      discoverInstallation: () => {
        throw new Error("registry exploded");
      },
      spawner,
      runComHelper: runner,
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });
    expect(fromThrownDiscovery.available).toBe(false);
    expect(fromThrownDiscovery.reason).toBe("com-helper-failed");

    // An injected spawner that throws (any error object) must also fail closed.
    const weird: SolidWorksProcessSpawner = () => {
      throw new Error("spawn exploded");
    };
    const fromWeirdSpawn = await probeSolidWorksRuntime({
      platform: "win32",
      discoverInstallation: () => Promise.resolve(INSTALLATION),
      spawner: weird,
      runComHelper: runner,
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });
    expect(fromWeirdSpawn.available).toBe(false);
    expect(fromWeirdSpawn.reason).toBe("spawn-failed");
    expect(owned.killCalls()).toBe(0);
  });

  it("the fixed seam adapter maps the live snapshot onto the synchronous SolidWorksProbeResult surface", () => {
    const live: SolidWorksLiveProbeResult = {
      available: true,
      version: "33.0.0.5050",
      installedVersion: "33.0.0.5050",
      ownedProcessSpawned: true,
      ownedProcessClosed: true,
      ownedProcessExitCode: null,
      reason: "owned-process-proven",
      probedAt: "2026-08-14T00:00:00.000Z"
    };
    expect(solidWorksProbeResultOf(live)).toEqual({
      available: true,
      version: "33.0.0.5050"
    });
    const failed = failClosedSolidWorksResult({
      reason: "ownership-not-proven",
      installedVersion: "33.0.0.5050",
      probedAt: "2026-08-14T00:00:00.000Z"
    });
    expect(solidWorksProbeResultOf(failed)).toEqual({ available: false, version: null });
    expect(failed.installedVersion).toBe("33.0.0.5050");
    // Every fail-closed snapshot is explicit about the exit-status field.
    expect(failed.ownedProcessExitCode).toBeNull();
    // failClosedSolidWorksResult can carry an observed owned-process exit
    // status verbatim (normalized unsigned Windows code).
    const exited = failClosedSolidWorksResult({
      reason: "owned-process-exited",
      installedVersion: "33.0.0.5050",
      ownedProcessExitCode: 3221225477,
      probedAt: "2026-08-14T00:00:00.000Z"
    });
    expect(exited.ownedProcessExitCode).toBe(3221225477);
    expect(exited.available).toBe(false);
  });

  it("integrates with RealPreflightProbe as the FIXED seam injected after awaiting the live probe", async () => {
    const owned = fakeOwnedProcess(4242);
    const { spawner } = fakeSpawner(owned.handle);
    const { runner } = scriptedComHelper((request) => {
      if (request.mode === "attach") return helperOutcome();
      return helperOutcome({ attached: true, pid: 4242, revision: "33.0.0.5050" });
    });
    const live = await probeSolidWorksRuntime(liveProbeOptions({ spawner, runner }));
    // Exactly the Electron Main wiring pattern: a FIXED synchronous seam over
    // the awaited snapshot (the synchronous probe never runs live COM work).
    const probe = new RealPreflightProbe({
      skillRootPath: "C:\\fake\\skill-root",
      solidworks: { probe: () => solidWorksProbeResultOf(live) }
    });
    expect(probe.solidworksSnapshot).toEqual({ available: true, version: "33.0.0.5050" });
    expect(
      probe.checkCapability("solidworks_available", {
        skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) }
      })
    ).toBe(true);

    const failedLive = failClosedSolidWorksResult({
      reason: "ownership-not-proven",
      installedVersion: "33.0.0.5050",
      probedAt: "2026-08-14T00:00:00.000Z"
    });
    const failedProbe = new RealPreflightProbe({
      skillRootPath: "C:\\fake\\skill-root",
      solidworks: { probe: () => solidWorksProbeResultOf(failedLive) }
    });
    expect(
      failedProbe.checkCapability("solidworks_available", {
        skill: { name: "solidworks-build-part-from-drawing", sha256: "a".repeat(64) }
      })
    ).toBe(false);
    expect(failedProbe.solidworksSnapshot.version).toBeNull();
  });

  it("the default spawner seam shape is a real shell:false spawn (never invoked by these tests)", () => {
    // The default spawner is only exercised against a REAL executable — the
    // hermetic tests never call it. This pins its existence + signature.
    expect(typeof DEFAULT_SOLIDWORKS_SPAWNER).toBe("function");
  });
});

describe("DEFAULT_SOLIDWORKS_SPAWNER waitExit/observeExit (real tiny child processes — never SolidWorks, never a COM object)", () => {
  it("resolves true only when the child's exit/close is actually observed", async () => {
    // `node` with no arguments and ignored stdio reads EOF from stdin and
    // exits on its own within tens of ms — a real, observed exit.
    const owned = DEFAULT_SOLIDWORKS_SPAWNER(process.execPath);
    expect(owned.pid).toBeGreaterThan(0);
    await expect(owned.waitExit(5_000)).resolves.toBe(true);
  });

  it("resolves false for the never-spawned error path, even when called after 'error'/'close' already fired", async () => {
    const missing = path.join(process.cwd(), "no-such-solidworks-helper-xyz.exe");
    const owned = DEFAULT_SOLIDWORKS_SPAWNER(missing);
    expect(owned.pid).toBeUndefined();
    // First call: the 'error' event (ENOENT) is NOT an exit — report false.
    await expect(owned.waitExit(5_000)).resolves.toBe(false);
    // Second call AFTER 'error' + 'close' fired: on Windows the never-spawned
    // path leaves a negative raw error as exitCode (e.g. -4058), so the early
    // exit check must require a real pid — false again, never a claimed exit.
    await expect(owned.waitExit(5_000)).resolves.toBe(false);
  });

  it("observeExit reports the exact observed exit status of the owned child (exit 0)", async () => {
    const owned = DEFAULT_SOLIDWORKS_SPAWNER(process.execPath);
    expect(owned.pid).toBeGreaterThan(0);
    const observation = owned.observeExit(5_000);
    await expect(observation.promise).resolves.toEqual({ exited: true, exitCode: 0 });
    observation.cancel(); // idempotent after settle
  });

  it("observeExit reports the never-spawned error path as exited:false without claiming an exit", async () => {
    const missing = path.join(process.cwd(), "no-such-solidworks-helper-xyz.exe");
    const owned = DEFAULT_SOLIDWORKS_SPAWNER(missing);
    expect(owned.pid).toBeUndefined();
    await expect(owned.observeExit(5_000).promise).resolves.toEqual({
      exited: false,
      exitCode: null
    });
  });

  it("observeExit can be cancelled without disturbing a later waitExit observation", async () => {
    const owned = DEFAULT_SOLIDWORKS_SPAWNER(process.execPath);
    const observation = owned.observeExit(60_000);
    observation.cancel(); // detaches ONLY this observation's timer/listeners
    // waitExit attaches its own listeners and still observes the real exit.
    await expect(owned.waitExit(5_000)).resolves.toBe(true);
  });
});

describe("normalizeWindowsExitStatus (unsigned Windows status normalization)", () => {
  it("normalizes signed and unsigned crash statuses to the documented 0xC0000005 = 3221225477 form", () => {
    expect(normalizeWindowsExitStatus(-1073741819)).toBe(3221225477); // 0xC0000005 as signed
    expect(normalizeWindowsExitStatus(3221225477)).toBe(3221225477); // 0xC0000005 as unsigned
    expect(normalizeWindowsExitStatus(0)).toBe(0);
    expect(normalizeWindowsExitStatus(7)).toBe(7);
    expect(normalizeWindowsExitStatus(null)).toBeNull();
  });
});

describe("runSolidWorksComHelper + parseSolidWorksHelperOutcome (bounded helper, scripted children)", () => {
  /** Fake helper child: EventEmitter-based, scripted stdout/stderr/close. */
  class FakeChild extends EventEmitter {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    killed = false;
    kill(): void {
      this.killed = true;
    }
  }

  function fakeSpawn(): {
    spawnFn: typeof spawn;
    child: FakeChild;
    captured: {
      command: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      shell: boolean | string | undefined;
      windowsHide: boolean | undefined;
    };
  } {
    const child = new FakeChild();
    const captured = {
      command: "",
      args: [] as string[],
      env: {} as NodeJS.ProcessEnv,
      shell: undefined as boolean | string | undefined,
      windowsHide: undefined as boolean | undefined
    };
    const spawnFn = ((
      command: string,
      args: readonly string[],
      options: {
        env?: NodeJS.ProcessEnv;
        shell?: boolean | string;
        windowsHide?: boolean;
      }
    ) => {
      captured.command = command;
      captured.args = [...args];
      captured.env = options.env ?? {};
      captured.shell = options.shell;
      captured.windowsHide = options.windowsHide;
      return child;
    }) as unknown as typeof spawn;
    return { spawnFn, child, captured };
  }

  it("attach mode runs the Python/pywin32 COM helper (-c script, mode/deadline env) and parses the result marker", async () => {
    const { spawnFn, child, captured } = fakeSpawn();
    const outcomePromise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 1_000 },
      { spawn: spawnFn }
    );
    child.stdout.emit(
      "data",
      Buffer.from(
        'SWPANEL_SW_RESULT {"ok":true,"attached":true,"pid":1234,"revision":"33.0.0.5050","foreign":false}',
        "utf8"
      )
    );
    child.emit("close", 0);
    const outcome = await outcomePromise;
    expect(outcome).toEqual({
      ok: true,
      attached: true,
      pid: 1234,
      revision: "33.0.0.5050",
      foreign: false,
      executablePath: null,
      fileVersion: null,
      source: null
    });
    // The COM attach helper is python -c — NEVER the PowerShell Marshal path.
    expect(captured.command).toBe("python");
    expect(captured.args).toContain("-c");
    expect(captured.shell).toBe(false);
    expect(captured.windowsHide).toBe(true);
    expect(captured.env["SWPANEL_SW_PROBE_MODE"]).toBe("attach");
    expect(captured.env["SWPANEL_SW_PROBE_DEADLINE_MS"]).toBe("1000");
    expect(captured.env["SWPANEL_SW_EXPECTED_PID"]).toBeUndefined();
  });

  it("spawn mode passes the exact pid via env and pins the pywin32 ATTACH-ONLY COM code (never Dispatch/Create)", async () => {
    const { spawnFn, child, captured } = fakeSpawn();
    const outcomePromise = runSolidWorksComHelper(
      { mode: "spawn", deadlineMs: 1_000, expectedPid: 4242 },
      { spawn: spawnFn }
    );
    child.stdout.emit(
      "data",
      Buffer.from(
        'SWPANEL_SW_RESULT {"ok":true,"attached":true,"pid":4242,"revision":"33.0.0.5050","foreign":false}',
        "utf8"
      )
    );
    child.emit("close", 0);
    const outcome = await outcomePromise;
    expect(outcome).toEqual({
      ok: true,
      attached: true,
      pid: 4242,
      revision: "33.0.0.5050",
      foreign: false,
      executablePath: null,
      fileVersion: null,
      source: null
    });
    expect(captured.command).toBe("python");
    expect(captured.env["SWPANEL_SW_PROBE_MODE"]).toBe("spawn");
    expect(captured.env["SWPANEL_SW_EXPECTED_PID"]).toBe("4242");
    const scriptIndex = captured.args.indexOf("-c");
    expect(scriptIndex).toBeGreaterThan(-1);
    const script = captured.args[scriptIndex + 1];
    // The COM attach is Python/pywin32 GetActiveObject — never PowerShell.
    expect(script).toContain('win32com.client.GetActiveObject("SldWorks.Application")');
    expect(script).toContain("pythoncom.CoInitialize");
    expect(script).toContain("pythoncom.CoUninitialize");
    expect(script).toContain("GetProcessID");
    expect(script).toContain("RevisionNumber");
    // The Node side decodes the marker as UTF-8, so the Python helper must
    // force UTF-8 on its redirected stdout pipe.
    expect(script).toContain("sys.stdout.reconfigure");
    expect(script).toContain("utf-8");
    // Missing pywin32 is a helper failure, not a clean no-instance result:
    // ok:false makes marker parsing reject and the probe must never spawn.
    expect(script).toContain('result["ok"] = False');
    // The helper NEVER creates a COM instance (no Dispatch/Create): Node is
    // the only spawner and owner of the SolidWorks process.
    expect(script).not.toContain("Dispatch(");
    expect(script).not.toContain("CreateObject");
    expect(script).not.toContain("CoCreateInstance");
    expect(script).not.toContain("Marshal");
    // No -EncodedCommand anywhere on the COM path.
    expect(captured.args).not.toContain("-EncodedCommand");
  });

  it("discover mode stays the year-agnostic PowerShell registry helper (EncodedCommand) and parses discovery fields", async () => {
    const { spawnFn, child, captured } = fakeSpawn();
    const outcomePromise = runSolidWorksComHelper(
      { mode: "discover", deadlineMs: 15_000 },
      { spawn: spawnFn }
    );
    child.stdout.emit(
      "data",
      Buffer.from(
        'SWPANEL_SW_RESULT {"ok":true,"attached":false,"pid":0,"revision":"","foreign":false,"executablePath":"C:\\\\Program Files\\\\SOLIDWORKS Corp\\\\SOLIDWORKS\\\\SLDWORKS.exe","fileVersion":"33.0.0.5050","source":"uninstall"}',
        "utf8"
      )
    );
    child.emit("close", 0);
    const outcome = await outcomePromise;
    expect(outcome.executablePath).toBe(
      "C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\SLDWORKS.exe"
    );
    expect(outcome.fileVersion).toBe("33.0.0.5050");
    expect(outcome.source).toBe("uninstall");
    expect(captured.command).toBe("powershell");
    expect(captured.args[0]).toBe("-NoProfile");
    expect(captured.args).toContain("-EncodedCommand");
    expect(captured.env["SWPANEL_SW_PROBE_MODE"]).toBe("discover");
    expect(captured.env["SWPANEL_SW_EXPECTED_PID"]).toBeUndefined();
    const encodedIndex = captured.args.indexOf("-EncodedCommand");
    expect(encodedIndex).toBeGreaterThan(-1);
    const script = Buffer.from(captured.args[encodedIndex + 1] as string, "base64").toString(
      "utf16le"
    );
    // Discovery remains registry-based, year-agnostic and COM-free.
    expect(script).toContain("SOFTWARE\\SolidWorks");
    expect(script).toContain("InstallLocation");
    expect(script).toContain("SLDWORKS.exe");
    expect(script).toContain("ConvertTo-Json");
    expect(script).toContain("[Console]::OutputEncoding");
    expect(script).toContain("[System.Text.Encoding]::UTF8");
    expect(script).not.toContain("GetActiveObject");
  });

  it("pythonCommand is an injectable argv seam; an empty command rejects without spawning", async () => {
    expect(DEFAULT_SOLIDWORKS_PYTHON_COMMAND).toEqual(["python"]);
    const { spawnFn, child, captured } = fakeSpawn();
    const promise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 1_000 },
      { spawn: spawnFn, pythonCommand: ["py", "-3"] }
    );
    child.stdout.emit(
      "data",
      Buffer.from('SWPANEL_SW_RESULT {"ok":true,"attached":false}', "utf8")
    );
    child.emit("close", 0);
    await promise;
    expect(captured.command).toBe("py");
    expect(captured.args[0]).toBe("-3");
    expect(captured.args[1]).toBe("-c");

    await expect(
      runSolidWorksComHelper(
        { mode: "attach", deadlineMs: 1_000 },
        { spawn: spawnFn, pythonCommand: [] }
      )
    ).rejects.toThrow(/no configured Python command/);
  });

  it("captures helper stdout/stderr boundedly (leading noise below the cap cannot break the marker; oversized output truncates; stderr error text is capped)", async () => {
    // Leading output BELOW the capture cap cannot break marker parsing.
    const noisy = fakeSpawn();
    const noisyPromise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 1_000 },
      { spawn: noisy.spawnFn }
    );
    noisy.child.stdout.emit("data", Buffer.from("x".repeat(10_000), "utf8"));
    noisy.child.stdout.emit(
      "data",
      Buffer.from('SWPANEL_SW_RESULT {"ok":true,"attached":false}', "utf8")
    );
    noisy.child.emit("close", 0);
    const outcome = await noisyPromise;
    expect(outcome.ok).toBe(true);

    // Output EXCEEDING the capture cap before the marker truncates the marker:
    // the capture is bounded and the truncated marker fails closed.
    const overflow = fakeSpawn();
    const overflowPromise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 1_000 },
      { spawn: overflow.spawnFn }
    );
    overflow.child.stdout.emit("data", Buffer.from("x".repeat(100_000), "utf8"));
    overflow.child.stdout.emit(
      "data",
      Buffer.from('SWPANEL_SW_RESULT {"ok":true,"attached":false}', "utf8")
    );
    overflow.child.emit("close", 0);
    await expect(overflowPromise).rejects.toThrow(/no parseable result/);

    // The rejection message carries a CAPPED stderr tail (never the full dump).
    const failing = fakeSpawn();
    const failingPromise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 1_000 },
      { spawn: failing.spawnFn }
    );
    failing.child.stderr.emit("data", Buffer.from("e".repeat(100_000), "utf8"));
    failing.child.emit("close", 3);
    const error = await failingPromise.then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(9_000);
  });

  it("rejects on a non-zero helper exit and on a missing result marker", async () => {
    const failing = fakeSpawn();
    const failingPromise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 1_000 },
      { spawn: failing.spawnFn }
    );
    failing.child.stderr.emit("data", Buffer.from("boom", "utf8"));
    failing.child.emit("close", 1);
    await expect(failingPromise).rejects.toThrow(/exit 1/);

    const noMarker = fakeSpawn();
    const noMarkerPromise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 1_000 },
      { spawn: noMarker.spawnFn }
    );
    noMarker.child.stdout.emit("data", Buffer.from("some unrelated output", "utf8"));
    noMarker.child.emit("close", 0);
    await expect(noMarkerPromise).rejects.toThrow(/no parseable result/);
  });

  it("terminates the helper itself when it outlives its hard bound (SolidWorksComHelperTimeoutError)", async () => {
    const { spawnFn, child } = fakeSpawn();
    const promise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 10 },
      { spawn: spawnFn, graceMs: 20 }
    );
    await expect(promise).rejects.toBeInstanceOf(SolidWorksComHelperTimeoutError);
    expect(child.killed).toBe(true);
  });

  it("an ALREADY-aborted signal rejects promptly with SolidWorksComHelperAbortedError without spawning any child", async () => {
    vi.useFakeTimers();
    try {
      const { spawnFn, child, captured } = fakeSpawn();
      const controller = new AbortController();
      controller.abort();
      const promise = runSolidWorksComHelper(
        { mode: "spawn", deadlineMs: 60_000, expectedPid: 4242, signal: controller.signal },
        { spawn: spawnFn, graceMs: 5_000 }
      );
      // Prompt rejection with the aborted-helper error — never a timeout.
      await expect(promise).rejects.toBeInstanceOf(SolidWorksComHelperAbortedError);
      // NO child was ever spawned: nothing to kill, nothing to await, and no
      // hard-bound/grace timer was ever created.
      expect(captured.command).toBe("");
      expect(captured.env["SWPANEL_SW_EXPECTED_PID"]).toBeUndefined();
      expect(child.killed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a signal abort kills ONLY the helper child and rejects with SolidWorksComHelperAbortedError after the child closes", async () => {
    const { spawnFn, child } = fakeSpawn();
    const controller = new AbortController();
    const promise = runSolidWorksComHelper(
      { mode: "spawn", deadlineMs: 60_000, expectedPid: 4242, signal: controller.signal },
      { spawn: spawnFn, graceMs: 5_000 }
    );
    // Attach the handler BEFORE the abort so the rejection is never unhandled.
    const rejection = promise.then(
      () => null,
      (error: unknown) => error
    );
    controller.abort();
    expect(child.killed).toBe(true);
    // The rejection AWAITS the helper child's closure — still pending here.
    child.emit("close", 1);
    const error = await rejection;
    expect(error).toBeInstanceOf(SolidWorksComHelperAbortedError);
  });

  it("an abort whose child never closes still settles within the grace bound", async () => {
    const { spawnFn, child } = fakeSpawn();
    const controller = new AbortController();
    const promise = runSolidWorksComHelper(
      { mode: "attach", deadlineMs: 60_000, signal: controller.signal },
      { spawn: spawnFn, graceMs: 20 }
    );
    const rejection = promise.then(
      () => null,
      (error: unknown) => error
    );
    controller.abort();
    expect(child.killed).toBe(true);
    const error = await rejection; // settles after ~20 ms grace
    expect(error).toBeInstanceOf(SolidWorksComHelperAbortedError);
  });

  it("a signal abort AFTER the helper completed is a no-op with NO leftover listeners or timers", async () => {
    vi.useFakeTimers();
    try {
      const { spawnFn, child } = fakeSpawn();
      const controller = new AbortController();
      // AbortSignal is an EventTarget (not an EventEmitter): count the abort
      // listener registrations/removals through the signal's own methods.
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const outcomePromise = runSolidWorksComHelper(
        { mode: "attach", deadlineMs: 1_000, signal: controller.signal },
        { spawn: spawnFn }
      );
      child.stdout.emit(
        "data",
        Buffer.from('SWPANEL_SW_RESULT {"ok":true,"attached":false}', "utf8")
      );
      child.emit("close", 0);
      const outcome = await outcomePromise;
      expect(outcome.ok).toBe(true);
      // The settle path detached the abort listener and cleared the hard-bound
      // timer: nothing outlives the invocation.
      const abortAdds = () =>
        addListener.mock.calls.filter(([type]) => type === "abort").length;
      const abortRemoves = () =>
        removeListener.mock.calls.filter(([type]) => type === "abort").length;
      expect(abortRemoves()).toBe(abortAdds());
      expect(vi.getTimerCount()).toBe(0);
      // Cancellation after completion: nothing is killed, nothing is rejected,
      // no listener/timer is (re)created.
      controller.abort();
      expect(child.killed).toBe(false);
      expect(abortRemoves()).toBe(abortAdds());
      expect(vi.getTimerCount()).toBe(0);
      await expect(outcomePromise).resolves.toEqual(outcome);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parseSolidWorksHelperOutcome: valid marker parses, malformed/no-marker/false-ok return null", () => {
    expect(
      parseSolidWorksHelperOutcome(
        'prefix\nSWPANEL_SW_RESULT {"ok":true,"attached":true,"pid":7,"revision":"33.0.0.5050","foreign":false,"executablePath":"C:\\\\x\\\\SLDWORKS.exe","fileVersion":"33.0.0.5050","source":"uninstall"}'
      )
    ).toEqual({
      ok: true,
      attached: true,
      pid: 7,
      revision: "33.0.0.5050",
      foreign: false,
      executablePath: "C:\\x\\SLDWORKS.exe",
      fileVersion: "33.0.0.5050",
      source: "uninstall"
    });
    expect(parseSolidWorksHelperOutcome("no marker at all")).toBeNull();
    expect(parseSolidWorksHelperOutcome("SWPANEL_SW_RESULT not-json")).toBeNull();
    expect(
      parseSolidWorksHelperOutcome('SWPANEL_SW_RESULT {"ok":false,"attached":false}')
    ).toBeNull();
    expect(
      parseSolidWorksHelperOutcome('SWPANEL_SW_RESULT {"ok":true,"attached":false}')
    ).toEqual({
      ok: true,
      attached: false,
      pid: 0,
      revision: null,
      foreign: false,
      executablePath: null,
      fileVersion: null,
      source: null
    });
  });
});
