import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { queryProcessIdentity } from "./process-identity.mjs";

/**
 * Cross-process packaging lock based on an atomically created lock DIRECTORY.
 *
 * Design (batch D hardening):
 * - `mkdir(lockDir)` is the atomic claim: exactly one process wins, and the
 *   winner is the owner from the mkdir instant onward. The only way to become
 *   owner is to win this plain `mkdir` competition — a stale takeover never
 *   directly grants ownership.
 * - The random `lockId` lives in `owner.json` inside the lock directory. It is
 *   written immediately after mkdir (temp file + atomic rename), so a reader
 *   never observes a half-written metadata file.
 * - Owner metadata records `pid`, `hostname` and `processStartTime` (epoch ms).
 *   A live PID is never reclaimed by age alone, but a live PID whose recorded
 *   birth time does not match the process currently using that PID (Windows
 *   recycles PIDs) is treated as a dead owner and can be taken over. When the
 *   owner's identity cannot be queried reliably, the lock is reported as
 *   "unknown" and the caller must abort for manual review (never guess).
 * - Initialization is race-free for observers: a lock directory whose metadata
 *   is missing or unreadable is never taken over (the owner may still be
 *   writing it, or crashed between mkdir and the metadata write). Such a lock
 *   is reported as "unknown" and the caller must abort.
 * - Stale takeover uses an atomic reaper MUTEX DIRECTORY
 *   (`<lockDir>.reaper`) to serialize read-verify-reap across processes. Only
 *   after winning the reaper mutex does a process RE-READ the metadata and
 *   compare lockId/pid/owner identity against what it originally observed, and
 *   only when that re-verification confirms the owner is still dead does it
 *   atomically rename the stale lock directory to a unique tombstone and remove
 *   it. This closes the ABA window: a lock that was reaped and recreated by a
 *   live owner between observation and takeover can never be removed by a
 *   process holding only the stale observation. Reaping NEVER grants ownership;
 *   the reaper releases the mutex and the acquirer loops back to the ordinary
 *   `mkdir` competition.
 * - `releasePackageLock` verifies `lockId`/`pid`/`hostname` against the current
 *   metadata before touching anything, so an owner can never release a lock
 *   that a newer run has taken over.
 */

/** Name of the metadata file stored inside the lock directory. */
export const LOCK_METADATA_FILENAME = "owner.json";

/** Suffix of the atomic reaper mutex directory for stale lock takeover. */
export const REAPER_MUTEX_SUFFIX = ".reaper";

/** A fresh metadata payload for this process (synchronous identity fields). */
export function newLockPayload() {
  return {
    lockId: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: Date.now(),
    createdISO: new Date().toISOString()
  };
}

/**
 * Build the owner metadata payload, recording this process's start time via the
 * identity provider so a future observer can distinguish a live owner from a
 * reused PID. When the start time cannot be queried the field is omitted and
 * the lock degrades to the conservative "live PID = busy" behavior.
 *
 * @param {(pid: number) => Promise<{ pid: number; startTime: number } | null>} identityProvider
 * @returns {Promise<Record<string, unknown>>}
 */
async function ownerPayload(identityProvider) {
  /** @type {Record<string, unknown>} */
  const payload = newLockPayload();
  let identity;
  try {
    identity = await identityProvider(process.pid);
  } catch {
    // A failing identity query degrades exactly like an unanswerable one: the
    // birth-time field is omitted and the lock uses the conservative
    // "live PID = busy" behavior instead of aborting acquisition.
    identity = null;
  }
  if (
    identity !== null &&
    typeof identity === "object" &&
    typeof identity.startTime === "number" &&
    Number.isFinite(identity.startTime) &&
    identity.startTime > 0
  ) {
    payload.processStartTime = identity.startTime;
  }
  return payload;
}

/**
 * @param {number} pid
 * @returns {boolean} true when a process with the pid exists (or exists but
 *   rejects signal 0, i.e. EPERM), false when it is gone (ESRCH).
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

/**
 * Read and validate the lock metadata. Returns the payload only when it is
 * well-formed (non-empty lockId and a positive integer pid), otherwise null.
 * A null result means "cannot verify an owner" and therefore "never take this
 * lock over automatically".
 *
 * @param {string} lockDir
 * @returns {Promise<({ lockId: string; pid: number } & Record<string, unknown>) | null>}
 */
export async function readLockMetadata(lockDir) {
  let raw;
  try {
    raw = await readFile(path.join(lockDir, LOCK_METADATA_FILENAME), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (typeof parsed.lockId !== "string" || parsed.lockId.length === 0) return null;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  return parsed;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write lock metadata atomically (temp file inside the lock dir + rename).
 *
 * @param {string} lockDir
 * @param {Record<string, unknown>} payload
 */
async function writeLockMetadata(lockDir, payload) {
  const metadataPath = path.join(lockDir, LOCK_METADATA_FILENAME);
  const tempPath = `${metadataPath}.tmp-${payload.lockId}`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await rename(tempPath, metadataPath);
}

/** @param {unknown} error */
function errorCode(error) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

/**
 * Classify the current owner of a lock directory:
 * - "alive": the owner PID is alive and (when a start time was recorded) the
 *   identity provider confirms the same process instance. Lock is busy.
 * - "dead": the owner PID is gone, or the live PID is a different process
 *   (birth time mismatch => the recorded owner is gone). Lock is reapable.
 * - "unknown": identity cannot be verified (including a failed/rejected
 *   identity query). Never reap; safe abort.
 *
 * @param {{ pid: number; processStartTime?: unknown } & Record<string, unknown>} metadata
 * @param {(pid: number) => Promise<{ pid: number; startTime: number } | null>} identityProvider
 * @returns {Promise<"alive" | "dead" | "unknown">}
 */
export async function determineOwnerState(
  metadata,
  identityProvider = queryProcessIdentity
) {
  if (!Number.isInteger(metadata.pid) || metadata.pid <= 0) return "unknown";
  if (!isProcessAlive(metadata.pid)) return "dead";
  if (typeof metadata.processStartTime !== "number") {
    // Legacy metadata written before the birth-time field: cannot compare
    // identities, so conservatively treat the live PID as the owner.
    return "alive";
  }
  let identity;
  try {
    identity = await identityProvider(metadata.pid);
  } catch {
    // A query that throws is a verification failure like any other: never
    // guess, never reap — report unknown and let the caller abort safely.
    return "unknown";
  }
  if (
    identity === null ||
    typeof identity !== "object" ||
    typeof identity.startTime !== "number"
  ) {
    return "unknown";
  }
  return identity.startTime === metadata.processStartTime ? "alive" : "dead";
}

/**
 * Take over a lock whose owner is dead, under the atomic reaper mutex.
 *
 * The caller has already observed `observed` metadata that looked stale. This
 * function first wins the `<lockDir>.reaper` mutex directory (an atomic mkdir),
 * then RE-READS the lock metadata and compares lockId/pid/process identity
 * (birth time) against the observation so a lock that was reaped and recreated
 * by a live owner in the meantime (ABA) is never removed. Only a re-verified
 * dead owner is atomically renamed to a unique tombstone and deleted. Reaping
 * never grants ownership: the caller loops back to the ordinary mkdir
 * competition afterwards.
 *
 * @param {string} lockDir
 * @param {{ lockId: string; pid: number; processStartTime?: unknown }} observed
 *   metadata observed before the reaper mutex was requested
 * @param {(pid: number) => Promise<{ pid: number; startTime: number } | null>} identityProvider
 * @param {() => Promise<void>} [onHoldingMutex] test-only hook invoked (and
 *   awaited) immediately after the reaper mutex is won, while it is still held,
 *   and before the metadata is re-read. Production callers omit it; tests use
 *   it as a deterministic barrier to pause inside the critical section.
 * @returns {Promise<"reaped" | "gone" | "changed" | "alive" | "unknown">}
 */
export async function reapStaleLock(
  lockDir,
  observed,
  identityProvider = queryProcessIdentity,
  onHoldingMutex
) {
  const mutexDir = `${lockDir}${REAPER_MUTEX_SUFFIX}`;
  try {
    await mkdir(mutexDir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return "changed";
    throw error;
  }
  try {
    if (onHoldingMutex !== undefined) await onHoldingMutex();
    const current = await readLockMetadata(lockDir);
    if (current === null) return "gone"; // reaped/released by someone else
    if (
      current.lockId !== observed.lockId ||
      current.pid !== observed.pid ||
      current.processStartTime !== observed.processStartTime
    ) {
      // ABA guard: the lockId/pid/process identity no longer match what was
      // observed before the mutex was requested — a live owner has recreated
      // the lock, so it must not be reaped.
      return "changed";
    }
    const state = await determineOwnerState(current, identityProvider);
    if (state !== "dead") return state; // "alive" | "unknown"
    const tombstone = path.join(
      path.dirname(lockDir),
      `${path.basename(lockDir)}.reaped-${observed.lockId}`
    );
    try {
      await rename(lockDir, tombstone);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "gone";
      throw error;
    }
    await rm(tombstone, { recursive: true, force: true });
    return "reaped";
  } finally {
    await rm(mutexDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Acquire the cross-process packaging lock.
 *
 * Ownership is granted ONLY by winning the plain `mkdir(lockDir)` competition.
 * When the directory already exists, the owner is classified; a dead owner is
 * reaped under the reaper mutex and the loop returns to the ordinary mkdir
 * competition rather than claiming ownership from the reap.
 *
 * @param {string} lockDir absolute path of the lock directory
 * @param {{
 *   waitMs?: number;
 *   maxAttempts?: number;
 *   identityProvider?: (pid: number) => Promise<{ pid: number; startTime: number } | null>;
 * }} [options] bounded retry used only to wait out the brief owner
 *   initialization window; identityProvider is injectable for deterministic
 *   tests (defaults to the platform process-identity query).
 * @returns {Promise<
 *   | { status: "acquired"; lock: Record<string, unknown> }
 *   | { status: "busy" }
 *   | { status: "unknown" }
 * >}
 */
export async function acquirePackageLock(lockDir, options = {}) {
  const { waitMs = 150, maxAttempts = 5 } = options;
  const identityProvider = options.identityProvider ?? queryProcessIdentity;
  const payload = await ownerPayload(identityProvider);
  await mkdir(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    try {
      await mkdir(lockDir);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      // Lock directory exists: classify the current owner.
      const existing = await readLockMetadata(lockDir);
      if (existing === null) {
        // Owner may still be initializing (between mkdir and metadata write),
        // or crashed mid-init. Never take over unverifiable metadata.
        await sleep(waitMs);
        continue;
      }
      const state = await determineOwnerState(existing, identityProvider);
      if (state === "alive") return { status: "busy" };
      if (state === "unknown") return { status: "unknown" };
      // Owner is dead: reap under the reaper mutex, then retry mkdir. The reap
      // itself never grants ownership — the plain mkdir competition decides.
      const reaped = await reapStaleLock(lockDir, existing, identityProvider);
      if (reaped === "alive") return { status: "busy" };
      if (reaped === "unknown") return { status: "unknown" };
      await sleep(waitMs);
      continue;
    }
    // We won the mkdir: the directory is ours. Initialization is completed
    // immediately; any observer that saw the dir before metadata was written
    // simply never takes it over (see above).
    await writeLockMetadata(lockDir, payload);
    return { status: "acquired", lock: payload };
  }
  return { status: "unknown" };
}

/**
 * Release the packaging lock, but only when this process still owns it. The
 * lockId/pid (and hostname when recorded) in `lock` are verified against the
 * current metadata before the lock directory is moved to a unique tombstone and
 * removed. A lock that was already taken over by a newer run is left untouched.
 *
 * @param {Record<string, unknown> | null} lock the payload returned by
 *   acquirePackageLock
 * @param {string} lockDir
 */
export async function releasePackageLock(lock, lockDir) {
  if (lock === null || typeof lock !== "object") return;
  if (typeof lock.lockId !== "string" || lock.lockId.length === 0) return;
  const current = await readLockMetadata(lockDir);
  if (current === null) return; // already gone (taken over or manually removed)
  if (current.lockId !== lock.lockId) return; // a newer owner holds it now
  if (current.pid !== lock.pid) return;
  if (typeof lock.hostname === "string" && current.hostname !== lock.hostname) {
    return;
  }
  const tombstone = path.join(
    path.dirname(lockDir),
    `${path.basename(lockDir)}.released-${lock.lockId}`
  );
  await rename(lockDir, tombstone);
  await rm(tombstone, { recursive: true, force: true });
}
