/**
 * Module-only packaging helpers. This file is deliberately NOT an entry point:
 * the only supported production packaging entry is `npm run package:win`
 * (scripts/package-all.mjs), which enforces the cross-process packaging lock
 * and the per-run output lifecycle. Running this file directly is prohibited —
 * a lockless direct main was removed in batch D.
 */

export {
  assertNoLegacyPackageCopy,
  assertWithinRoot,
  createPackageRun,
  defaultAudit,
  defaultBuild,
  defaultPackage,
  defaultPackageLockDir,
  defaultSmoke,
  formatLockedOutputError,
  isWindowsFileLock,
  legacyPackageCopyPath,
  OUT_INVALID_PREFIX,
  packageAll,
  packageRunsRoot,
  publishRunOutput,
  quarantineExistingOut,
  verifyPackagedAppAsar
} from "./packaging.mjs";

export {
  acquirePackageLock,
  determineOwnerState,
  isProcessAlive,
  LOCK_METADATA_FILENAME,
  newLockPayload,
  readLockMetadata,
  REAPER_MUTEX_SUFFIX,
  reapStaleLock,
  releasePackageLock
} from "./package-lock.mjs";

const invoked = process.argv[1];
if (invoked !== undefined && pathEndsWithPackageWin(invoked)) {
  console.error(
    "scripts/package-win.mjs is not an entry point. Run `npm run package:win` " +
      "(scripts/package-all.mjs), which acquires the cross-process packaging " +
      "lock and publishes only fully verified packages."
  );
  process.exit(1);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function pathEndsWithPackageWin(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized === "scripts/package-win.mjs" || normalized.endsWith("/scripts/package-win.mjs");
}
