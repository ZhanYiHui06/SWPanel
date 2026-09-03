import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acquirePackageLock,
  determineOwnerState,
  isProcessAlive,
  LOCK_METADATA_FILENAME,
  newLockPayload,
  readLockMetadata,
  REAPER_MUTEX_SUFFIX,
  reapStaleLock,
  releasePackageLock
} from "../scripts/package-lock.mjs";

/** @param {string} lockDir */
async function createLockDir(lockDir: string) {
  await mkdir(lockDir, { recursive: true });
}

/**
 * Spawn a real child node process that acquires the lock and, optionally, keeps
 * it held until the parent tells it to release (stdin "release" line) or for
 * the given holdMs. Resolves with the child and its pid once acquired.
 */
function spawnLockHolder(
  lockDir: string,
  holdMs: number
): Promise<{ child: import("node:child_process").ChildProcess; pid: number }> {
  const lockModuleUrl = new URL(
    "../scripts/package-lock.mjs",
    import.meta.url
  ).href;
  const script = `
    import { acquirePackageLock, releasePackageLock } from ${JSON.stringify(
      lockModuleUrl
    )};
    const lockDir = ${JSON.stringify(lockDir)};
    const result = await acquirePackageLock(lockDir);
    console.log("ACQUIRED:" + JSON.stringify(result.status));
    if (result.status === "acquired") {
      await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
      await releasePackageLock(result.lock, lockDir);
    }
    console.log("DONE:" + result.status);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "inherit"]
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = String(chunk);
      const match = text.match(/ACQUIRED:(\S+)/);
      if (match && !settled) {
        settled = true;
        resolve({ child, pid: child.pid ?? 0 });
      }
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`holder exited before acquiring (${code})`));
      }
    });
  });
}

/** Wait until the lock directory no longer exists (released). */
async function waitForLockRelease(lockDir: string, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    try {
      await access(lockDir);
    } catch {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("lock directory was not released in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Poll until `predicate()` becomes true; deterministic barrier helper. */
async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000
) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("cross-process packaging lock (directory lock)", () => {
  it("acquires via atomic mkdir and records a lockId inside the directory", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      const result = await acquirePackageLock(lockDir);
      expect(result.status).toBe("acquired");
      const lock = result.status === "acquired" ? result.lock : null;
      expect(lock).not.toBeNull();
      expect(typeof lock?.lockId).toBe("string");
      expect(lock?.lockId).not.toHaveLength(0);
      expect(lock?.pid).toBe(process.pid);
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe(lock?.lockId);
      await releasePackageLock(lock, lockDir);
      await expect(access(lockDir)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("is refused while a real live process holds it (no time-based takeover)", { timeout: 20_000 }, async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      // Long hold so the child is still alive (and still sleeping) when the
      // parent finishes verifying the live-owner semantics.
      const { child } = await spawnLockHolder(lockDir, 2500);
      // Attach the exit wait before doing anything else: the child may exit
      // right after releasing the lock, so the listener must already be there.
      const exitPromise = new Promise<void>((resolve) =>
        child.once("exit", () => resolve())
      );
      // The holder owns the lock while its process is alive; even an
      // apparently ancient lock must NOT be reclaimed.
      const original = await readLockMetadata(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "old-stale-looking",
          pid: child.pid ?? 0,
          createdAt: Date.now() - 60 * 60 * 1000
        }),
        "utf8"
      );
      const result = await acquirePackageLock(lockDir);
      expect(result.status).toBe("busy");
      // The live owner's metadata is left untouched.
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe("old-stale-looking");
      // Restore the owner's original metadata immediately so its own release
      // can proceed once its hold expires.
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify(original, null, 2),
        "utf8"
      );
      await waitForLockRelease(lockDir);
      await exitPromise;
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("takes over a lock whose pid is dead, regardless of age", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "dead-owner",
          pid: 999999,
          createdAt: Date.now()
        }),
        "utf8"
      );
      const result = await acquirePackageLock(lockDir);
      expect(result.status).toBe("acquired");
      const lock = result.status === "acquired" ? result.lock : null;
      expect(lock?.pid).toBe(process.pid);
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe(lock?.lockId);
      await releasePackageLock(lock, lockDir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("treats a live PID with a mismatched birth time as dead (PID recycling)", async () => {
    // The recorded PID is process.pid (alive) but the recorded start time does
    // not match the process that currently owns the PID: on Windows a recycled
    // PID looks alive yet the lock owner is long gone, so it must be reapable.
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "recycled-pid",
          pid: process.pid,
          processStartTime: 11111
        }),
        "utf8"
      );
      const fakeProvider = (pid: number) =>
        Promise.resolve({ pid, startTime: 22222 });
      expect(
        await determineOwnerState(
          {
            lockId: "recycled-pid",
            pid: process.pid,
            processStartTime: 11111
          },
          fakeProvider
        )
      ).toBe("dead");
      const result = await acquirePackageLock(lockDir, {
        identityProvider: fakeProvider
      });
      expect(result.status).toBe("acquired");
      const lock = result.status === "acquired" ? result.lock : null;
      await releasePackageLock(lock, lockDir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("treats a live PID with a matching birth time as alive (busy)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "live-owner",
          pid: process.pid,
          processStartTime: 33333
        }),
        "utf8"
      );
      const fakeProvider = (pid: number) =>
        Promise.resolve({ pid, startTime: 33333 });
      const result = await acquirePackageLock(lockDir, {
        identityProvider: fakeProvider
      });
      expect(result.status).toBe("busy");
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe("live-owner");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("aborts as unknown when the owner identity cannot be verified (never reap)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "opaque-owner",
          pid: process.pid,
          processStartTime: 44444
        }),
        "utf8"
      );
      const opaqueProvider = () => Promise.resolve(null);
      const result = await acquirePackageLock(lockDir, {
        identityProvider: opaqueProvider
      });
      expect(result.status).toBe("unknown");
      await expect(access(lockDir)).resolves.toBeUndefined();
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe("opaque-owner");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("records the owner's process start time in the lock metadata (Windows PID reuse support)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      const fakeProvider = (pid: number) =>
        Promise.resolve({ pid, startTime: 77777 });
      const result = await acquirePackageLock(lockDir, {
        identityProvider: fakeProvider
      });
      expect(result.status).toBe("acquired");
      const lock = result.status === "acquired" ? result.lock : null;
      expect(lock?.processStartTime).toBe(77777);
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.processStartTime).toBe(77777);
      await releasePackageLock(lock, lockDir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("a rejecting identity query degrades acquisition (no birth-time field, not an error)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      // The provider throws for every pid (including the acquiring process's
      // own pid). The lock must still be acquirable with the conservative
      // metadata: no processStartTime field, since identity cannot be verified.
      const failingProvider = () =>
        Promise.reject(new Error("identity query failed"));
      const result = await acquirePackageLock(lockDir, {
        identityProvider: failingProvider
      });
      expect(result.status).toBe("acquired");
      const lock = result.status === "acquired" ? result.lock : null;
      expect(lock).not.toBeNull();
      expect(lock?.processStartTime).toBeUndefined();
      await releasePackageLock(lock, lockDir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("a rejecting identity query is a safe unknown abort, never a reap (owner unverifiable)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "unverifiable-owner",
          pid: process.pid,
          processStartTime: 88888
        }),
        "utf8"
      );
      const failingProvider = () =>
        Promise.reject(new Error("identity query failed"));
      expect(
        await determineOwnerState(
          {
            lockId: "unverifiable-owner",
            pid: process.pid,
            processStartTime: 88888
          },
          failingProvider
        )
      ).toBe("unknown");
      const result = await acquirePackageLock(lockDir, {
        identityProvider: failingProvider
      });
      expect(result.status).toBe("unknown");
      // The lock directory is left untouched: no reaping on a failed query.
      await expect(access(lockDir)).resolves.toBeUndefined();
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe("unverifiable-owner");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("reapStaleLock reaps a re-verified dead owner and frees the path for plain mkdir", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "dead-owner",
          pid: 999999,
          processStartTime: 1
        }),
        "utf8"
      );
      const observed = await readLockMetadata(lockDir);
      expect(observed?.lockId).toBe("dead-owner");
      const fakeProvider = (pid: number) =>
        Promise.resolve({ pid, startTime: 55555 });
      const result = await reapStaleLock(lockDir, observed!, fakeProvider);
      expect(result).toBe("reaped");
      await expect(access(lockDir)).rejects.toThrow();
      // The reap never grants ownership: a plain mkdir competition decides.
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({ lockId: "fresh", pid: process.pid }),
        "utf8"
      );
      await expect(access(lockDir)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("ABA guard: a lock reaped and recreated by a live owner is never removed by a stale observation", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "old-dead",
          pid: 999999,
          processStartTime: 1
        }),
        "utf8"
      );
      const observed = await readLockMetadata(lockDir);
      expect(observed?.lockId).toBe("old-dead");
      // Full ABA cycle before the reaper re-verifies: the stale lock is reaped,
      // then a NEW live owner recreates the directory with a fresh lockId and
      // its own birth time. A reaper holding only the stale observation must
      // refuse to remove the recreated lock.
      const deadProvider = (pid: number) =>
        Promise.resolve({ pid, startTime: 55555 });
      expect(await reapStaleLock(lockDir, observed!, deadProvider)).toBe(
        "reaped"
      );
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "new-live",
          pid: process.pid,
          processStartTime: 66666
        }),
        "utf8"
      );
      const fakeProvider = (pid: number) =>
        Promise.resolve({ pid, startTime: 66666 });
      const result = await reapStaleLock(lockDir, observed!, fakeProvider);
      expect(result).toBe("changed");
      await expect(access(lockDir)).resolves.toBeUndefined();
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe("new-live");
      expect(metadata?.pid).toBe(process.pid);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("deterministic barrier: the reaper mutex serializes re-verification so a recreated live lock is never reaped", async () => {
    // The stale lock is observed as "old-dead" (pid 999999, birth 1). Reaper A
    // wins the reaper mutex and pauses INSIDE the critical section (via the
    // test-only onHoldingMutex hook) before re-reading. While A holds the
    // mutex, the stale lock is reaped and recreated by a live owner with a new
    // lockId and birth time (the ABA swap). Released, A re-reads the metadata,
    // compares lockId/pid/process identity against its stale observation and
    // must refuse to remove the recreated lock. Reaper B, starting afterwards,
    // must also refuse: the mutex serializes every read-verify-reap, so no
    // stale observation can ever remove a lock a live owner recreated.
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "old-dead",
          pid: 999999,
          processStartTime: 1
        }),
        "utf8"
      );
      const observed = await readLockMetadata(lockDir);
      expect(observed?.lockId).toBe("old-dead");
      const barrierFile = path.join(base, "barrier-a");
      const releaseFile = path.join(base, "release-a");
      const lockModuleUrl = new URL(
        "../scripts/package-lock.mjs",
        import.meta.url
      ).href;
      const script = `
        import { readFile, writeFile, rm } from "node:fs/promises";
        import { reapStaleLock } from ${JSON.stringify(lockModuleUrl)};
        const lockDir = ${JSON.stringify(lockDir)};
        const observed = ${JSON.stringify(observed)};
        const barrier = ${JSON.stringify(barrierFile)};
        const release = ${JSON.stringify(releaseFile)};
        const result = await reapStaleLock(
          lockDir,
          observed,
          undefined,
          async () => {
            await writeFile(barrier, "a", "utf8");
            // Hold the mutex until the test performs the ABA swap and
            // releases. Poll: readFile rejects while the file does not exist.
            for (;;) {
              try {
                await readFile(release, "utf8");
                return;
              } catch {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }
          }
        );
        await rm(barrier, { force: true });
        console.log("REAP_RESULT:" + result);
      `;
      const runChild = () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", script],
            { stdio: ["ignore", "pipe", "inherit"] }
          );
          let stdout = "";
          let settled = false;
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout += String(chunk);
          });
          child.once("error", (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
          child.once("exit", (code) => {
            if (settled) return;
            settled = true;
            const match = stdout.match(/REAP_RESULT:(\S+)/);
            if (match) resolve(match[1]!);
            else reject(new Error(`child exited (${code}) without a result`));
          });
        });
      // Reaper A wins the mutex and pauses inside the critical section.
      const childA = runChild();
      await waitFor(
        () => {
          try {
            accessSync(barrierFile);
            return true;
          } catch {
            return false;
          }
        },
        "reaper A to hold the mutex"
      );
      // ABA swap while A holds the mutex: the stale lock is reaped (moved to a
      // tombstone) and a LIVE owner recreates the directory under a fresh
      // lockId with its own process identity.
      await rename(lockDir, path.join(base, `${path.basename(lockDir)}.reaped-old-dead`));
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "new-live",
          pid: process.pid,
          processStartTime: 66666
        }),
        "utf8"
      );
      // Release A: it re-reads, sees the recreated lock, and refuses to reap it.
      await writeFile(releaseFile, "release", "utf8");
      expect(await childA).toBe("changed");
      await expect(access(lockDir)).resolves.toBeUndefined();
      let metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe("new-live");
      expect(metadata?.pid).toBe(process.pid);
      // A stale observer arriving later (reaper B) also refuses: the recreated
      // live lock does not match the stale observation.
      const childB = runChild();
      expect(await childB).toBe("changed");
      metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).toBe("new-live");
      expect(metadata?.pid).toBe(process.pid);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never reclaims a lock whose metadata is unreadable or invalid", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        "not json at all",
        "utf8"
      );
      const result = await acquirePackageLock(lockDir);
      expect(result.status).toBe("unknown");
      await expect(access(lockDir)).resolves.toBeUndefined();
      // Unreadable file (missing metadata) is also unknown, never reclaimed.
      const emptyDir = path.join(base, "empty-lock");
      await createLockDir(emptyDir);
      const resultEmpty = await acquirePackageLock(emptyDir);
      expect(resultEmpty.status).toBe("unknown");
      await expect(access(emptyDir)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("releases only for the owning lockId; a wrong or null lock leaves it intact", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      const result = await acquirePackageLock(lockDir);
      expect(result.status).toBe("acquired");
      const lock = result.status === "acquired" ? result.lock : null;
      // Wrong lockId / wrong pid must not release.
      await releasePackageLock({ lockId: "other", pid: lock?.pid }, lockDir);
      await expect(access(lockDir)).resolves.toBeUndefined();
      await releasePackageLock({ lockId: lock?.lockId, pid: 999999 }, lockDir);
      await expect(access(lockDir)).resolves.toBeUndefined();
      await releasePackageLock(null, lockDir);
      await expect(access(lockDir)).resolves.toBeUndefined();
      // The correct owner releases.
      await releasePackageLock(lock, lockDir);
      await expect(access(lockDir)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("a released lock can be re-acquired immediately by the same or another process", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      const first = await acquirePackageLock(lockDir);
      expect(first.status).toBe("acquired");
      await releasePackageLock(
        first.status === "acquired" ? first.lock : null,
        lockDir
      );
      const second = await acquirePackageLock(lockDir);
      expect(second.status).toBe("acquired");
      await releasePackageLock(
        second.status === "acquired" ? second.lock : null,
        lockDir
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("two real processes racing a stale lock: exactly one acquires, never both (reaper mutex barrier)", { timeout: 30_000 }, async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-lock-"));
    const lockDir = path.join(base, "lock");
    try {
      // Pre-seed a stale lock directory with a dead owner.
      await createLockDir(lockDir);
      await writeFile(
        path.join(lockDir, LOCK_METADATA_FILENAME),
        JSON.stringify({
          lockId: "stale-seed",
          pid: 999999,
          processStartTime: 1
        }),
        "utf8"
      );
      // Two independent processes race to acquire the stale lock. Ownership is
      // granted ONLY by the plain mkdir competition; the reaper mutex
      // serializes stale reaping so exactly one winner emerges and the loser
      // observes the live owner as busy (never both owners, never a reaped
      // lock stolen under a live owner). The winner HOLDS the lock for 3s
      // before exiting, so the loser must observe it as alive and busy rather
      // than taking over a lock whose owner already exited.
      const lockModuleUrl = new URL(
        "../scripts/package-lock.mjs",
        import.meta.url
      ).href;
      const script = `
        import { acquirePackageLock } from ${JSON.stringify(lockModuleUrl)};
        const lockDir = ${JSON.stringify(lockDir)};
        const result = await acquirePackageLock(lockDir, { waitMs: 50, maxAttempts: 20 });
        if (result.status === "acquired") {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        console.log("STATUS:" + result.status);
      `;
      const runChild = () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", script],
            { stdio: ["ignore", "pipe", "inherit"] }
          );
          let stdout = "";
          let settled = false;
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout += String(chunk);
          });
          child.once("error", (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
          child.once("exit", (code) => {
            if (settled) return;
            settled = true;
            const match = stdout.match(/STATUS:(\S+)/);
            if (match) resolve(match[1]!);
            else reject(new Error(`child exited (${code}) without a status`));
          });
        });
      const [statusA, statusB] = await Promise.all([runChild(), runChild()]);
      const acquired = [statusA, statusB].filter((s) => s === "acquired");
      const busy = [statusA, statusB].filter((s) => s === "busy");
      expect(acquired).toHaveLength(1);
      expect(busy).toHaveLength(1);
      expect(statusA).not.toBe("unknown");
      expect(statusB).not.toBe("unknown");
      // The winner's lock metadata is a fresh lockId, never the stale seed.
      const metadata = await readLockMetadata(lockDir);
      expect(metadata?.lockId).not.toBe("stale-seed");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("newLockPayload / isProcessAlive", () => {
  it("produces a unique random lockId per payload", () => {
    const a = newLockPayload();
    const b = newLockPayload();
    expect(a.lockId).not.toBe(b.lockId);
    expect(a.pid).toBe(process.pid);
    expect(typeof a.hostname).toBe("string");
    expect(typeof a.createdISO).toBe("string");
    expect(REAPER_MUTEX_SUFFIX).toBe(".reaper");
  });

  it("detects process liveness without killing anything", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(99999999)).toBe(false);
  });
});
