import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, rename, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquirePackageLock,
  releasePackageLock
} from "./package-lock.mjs";
import {
  reportAsarAudit,
  auditReportPath,
  finalizeAsarAuditReport
} from "./audit-asar.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

/** Windows error codes raised when a running process locks packaged files. */
const WINDOWS_LOCK_ERROR_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * True when the error is a Windows file lock that no retry can bypass.
 *
 * @param {unknown} error
 * @returns {error is { code: string }}
 */
export function isWindowsFileLock(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    WINDOWS_LOCK_ERROR_CODES.has(error.code)
  );
}

/**
 * User-facing, actionable message for a locked Forge output directory.
 *
 * @param {string} outputPath
 * @param {{ code: string }} error
 * @returns {string}
 */
export function formatLockedOutputError(outputPath, error) {
  return [
    `Cannot move packaged output "${outputPath}" (${error.code}).`,
    "A running SWPanel process is most likely holding the packaged app open.",
    "Transient locks were retried with bounded backoff before giving up.",
    "Close SWPanel (and its helper processes), then run package:win again.",
    "Packaging was aborted: the stale package was not reused."
  ].join("\n");
}

/**
 * Assert that a path package:win is about to modify resolves strictly inside
 * the workspace root (never the root itself, never a sibling).
 *
 * @param {string} root
 * @param {string} candidate
 * @param {string} label
 */
export function assertWithinRoot(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot) {
    throw new Error(
      `Refusing to operate on the workspace root itself as ${label}: "${resolved}".`
    );
  }
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    throw new Error(
      `Refusing to operate outside the workspace root for ${label}: "${resolved}".`
    );
  }
}

/** @param {string} filePath */
async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The legacy `.package-copy` staging directory. Batch D removed the old
 * work-copy flow: this directory is no longer created or managed by any
 * packaging code, and a leftover directory is never deleted automatically.
 */
export const legacyPackageCopyPath = fileURLToPath(
  new URL("../.package-copy", import.meta.url)
);

/**
 * Guard: if the legacy `.package-copy` staging directory exists, packaging
 * aborts and requires a human to inspect it. It is never auto-deleted, and the
 * stale snapshot is never reused.
 *
 * @param {string} root
 */
export async function assertNoLegacyPackageCopy(root) {
  const snapshotPath = path.join(root, ".package-copy");
  if (await exists(snapshotPath)) {
    throw new Error(
      `Legacy staging directory "${snapshotPath}" exists. `.concat(
        "The .package-copy flow was removed and packaging never deletes it. ",
        "Inspect and remove it manually, then run package:win again."
      )
    );
  }
}

/**
 * Directory where every packaging run stores its temporary output.
 * `.scratch/package-runs/<uuid>/out` holds the freshly Forge-packaged app;
 * the canonical `out` directory is only ever produced by the final atomic
 * publish after build/package/verify/audit/smoke all succeed.
 */
export const packageRunsRoot = fileURLToPath(
  new URL("../.scratch/package-runs", import.meta.url)
);

/** Prefix of the root-level quarantine that holds a previous canonical `out`. */
export const OUT_INVALID_PREFIX = "out-invalid-";

/** Default lock directory for the workspace (gitignored via .scratch). */
export const defaultPackageLockDir = fileURLToPath(
  new URL("../.scratch/package-lock", import.meta.url)
);

/**
 * Transient-lock retry backoff (ms) applied when `publishRunOutput`'s rename
 * fails with a Windows transient lock (EPERM/EBUSY/ENOTEMPTY, e.g. a just-closed
 * smoke-launched process still releasing the packaged app). The schedule totals
 * 3750 ms — a bounded 3-5 s budget — after which a persistent lock fails loudly
 * instead of being waited out indefinitely.
 */
export const PUBLISH_RETRY_DELAYS = [250, 500, 1000, 2000];

/** Number of transient-lock retries before publish fails (matches the delay schedule). */
export const PUBLISH_MAX_RETRIES = PUBLISH_RETRY_DELAYS.length;

/**
 * Move a previous canonical `out` directory to a root-level
 * `out-invalid-<stamp>` quarantine. This runs at the very start of packaging so
 * a stale package can never be mistaken for (or reused as) current evidence:
 * from this point on the canonical `out` must not exist until the run
 * successfully publishes.
 *
 * @param {string} root workspace root containing the `out` directory
 * @returns {Promise<{ status: "absent" } | { status: "moved"; target: string }>}
 */
export async function quarantineExistingOut(root) {
  const canonical = path.join(root, "out");
  let info;
  try {
    info = await stat(canonical);
  } catch {
    return { status: "absent" };
  }
  if (!info.isDirectory()) {
    throw new Error(
      `Refusing to quarantine "${canonical}": it is not a directory. ` +
        "Inspect it manually; packaging was aborted."
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(root, `${OUT_INVALID_PREFIX}${stamp}`);
  assertWithinRoot(root, target, "out quarantine");
  try {
    await rename(canonical, target);
  } catch (error) {
    if (isWindowsFileLock(error)) {
      throw new Error(formatLockedOutputError(canonical, error), {
        cause: error
      });
    }
    throw error;
  }
  return { status: "moved", target };
}

/**
 * Create a fresh per-run directory under `.scratch/package-runs/<uuid>` and
 * record the run metadata inside it.
 *
 * @param {string} root
 * @returns {Promise<{ runDir: string; outDir: string; uuid: string }>}
 */
export async function createPackageRun(root) {
  assertWithinRoot(root, path.join(root, ".scratch"), "run scratch directory");
  const uuid = randomUUID();
  const runDir = path.join(root, ".scratch", "package-runs", uuid);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify(
      {
        uuid,
        createdAt: new Date().toISOString(),
        pid: process.pid
      },
      null,
      2
    ),
    "utf8"
  );
  return { runDir, outDir: path.join(runDir, "out"), uuid };
}

/**
 * Atomically publish a fully verified per-run output to the canonical `out`
 * directory. The canonical path must not exist (it was quarantined at the
 * start of the run); rename failures are never swallowed.
 *
 * A Windows transient file lock (EPERM/EBUSY/ENOTEMPTY — e.g. a just-closed
 * smoke-launched process still releasing the packaged app) is retried with
 * bounded backoff (`PUBLISH_RETRY_DELAYS`, totalling 3-5 s). Before EVERY
 * attempt (the initial one and each retry) the canonical destination is
 * re-verified as still absent and the per-run source as still present: a
 * canonical `out` that appears mid-publish, or a per-run output that
 * disappears, fails immediately and is never overwritten. A lock that outlives
 * the bounded budget surfaces as a clear publish failure.
 *
 * @param {string} runDir
 * @param {string} root
 * @param {{
 *   rename?: (from: string, to: string) => Promise<unknown>;
 *   exists?: (filePath: string) => Promise<boolean>;
 *   sleep?: (ms: number) => unknown | Promise<unknown>;
 *   maxRetries?: number;
 *   retryDelays?: readonly number[];
 * }} [options] injectable primitives for deterministic fault-injection tests
 * @returns {Promise<string>} the canonical output path
 */
export async function publishRunOutput(runDir, root, options = {}) {
  const canonical = path.join(root, "out");
  const runOut = path.join(runDir, "out");
  const renameFn = options.rename ?? rename;
  const existsFn = options.exists ?? exists;
  const sleepFn = options.sleep ?? sleep;
  const maxRetries = options.maxRetries ?? PUBLISH_MAX_RETRIES;
  const retryDelays = options.retryDelays ?? PUBLISH_RETRY_DELAYS;

  assertWithinRoot(root, canonical, "canonical output");
  if (await existsFn(canonical)) {
    throw new Error(
      `Refusing to publish: canonical output "${canonical}" already exists. ` +
        "It must not exist until a fully verified run publishes it. " +
        "Inspect the workspace manually; packaging was aborted."
    );
  }
  if (!(await existsFn(runOut))) {
    throw new Error(
      `Refusing to publish: per-run output "${runOut}" does not exist. ` +
        "A verified run must produce its output before publish can rename it. " +
        "Inspect the run directory manually; packaging was aborted."
    );
  }

  for (let attempt = 0; ; attempt += 1) {
    // Re-verify before every attempt: the canonical destination must still be
    // absent and the per-run source must still be present, so a mid-publish
    // change fails loudly and can never cause an overwrite or a silent publish
    // of a disappeared source.
    if (await existsFn(canonical)) {
      throw new Error(
        `Refusing to publish: canonical output "${canonical}" appeared while ` +
          "publishing. It must not exist until a fully verified run publishes " +
          "it. Packaging was aborted; no overwrite was attempted."
      );
    }
    if (!(await existsFn(runOut))) {
      throw new Error(
        `Refusing to publish: per-run output "${runOut}" disappeared while ` +
          "publishing. Packaging was aborted; no rename was attempted."
      );
    }
    try {
      await renameFn(runOut, canonical);
      return canonical;
    } catch (error) {
      if (!isWindowsFileLock(error)) throw error;
      if (attempt >= maxRetries) {
        // Bounded transient-lock budget exhausted: a persistent lock is a
        // clear publish failure, never a silent success or an overwrite.
        throw new Error(formatLockedOutputError(canonical, error), {
          cause: error
        });
      }
      const delay =
        retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 1000;
      await sleepFn(delay);
    }
  }
}

/**
 * Invoke `npm` reliably cross-platform: on Windows, `npm` is a `.cmd` shim
 * that `spawn` cannot resolve without a shell, so npm's cli.js (via the
 * `npm_execpath` environment variable npm sets for lifecycle scripts) is run
 * with the current node executable instead. When npm is not the parent (no
 * `npm_execpath`), a shell is used to launch the shim.
 *
 * @returns {{ command: string; args: string[]; shell: boolean }}
 */
function npmInvocation() {
  const npmExec = process.env.npm_execpath;
  if (typeof npmExec === "string" && npmExec.length > 0) {
    return { command: process.execPath, args: [npmExec], shell: false };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: [],
    shell: process.platform === "win32"
  };
}

/**
 * Run a command from `cwd` and resolve its exit code.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean }} options
 * @returns {Promise<number>}
 */
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: "inherit",
      env: options.env ?? process.env,
      ...(options.shell === true ? { shell: true } : {})
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * Run `npm <args>` from the given root.
 *
 * @param {readonly string[]} args
 * @param {string} root
 * @returns {Promise<number>}
 */
function runNpm(args, root) {
  const invocation = npmInvocation();
  return runCommand(invocation.command, [...invocation.args, ...args], {
    cwd: root,
    shell: invocation.shell
  });
}

/**
 * Verify that the freshly packaged app.asar exists and is non-empty, so the
 * caller can never mistake a missing or stale artifact for a new package.
 *
 * @param {string} outputPath the Forge output directory for this run
 * @returns {Promise<{ asarPath: string; sizeBytes: number }>}
 */
export async function verifyPackagedAppAsar(outputPath) {
  const asarPath = path.join(
    outputPath,
    "SWPanel-win32-x64",
    "resources",
    "app.asar"
  );
  let info;
  try {
    info = await stat(asarPath);
  } catch (error) {
    throw new Error(
      `Packaging reported success but no fresh app.asar exists at "${asarPath}". ` +
        "Refusing to treat this as a new package.",
      { cause: error }
    );
  }
  if (info.size <= 0) {
    throw new Error(
      `Fresh app.asar at "${asarPath}" is empty (${info.size} bytes). ` +
        "Refusing to treat this as a new package."
    );
  }
  return { asarPath, sizeBytes: info.size };
}

/**
 * Build the workspace dist outputs from `root` (`npm run build`).
 *
 * @param {string} root
 * @returns {Promise<number>} exit code
 */
export async function defaultBuild(root) {
  return runNpm(["run", "build"], root);
}

/**
 * Package the built app for Windows x64 into the per-run output directory via
 * Electron Forge. The Forge `outDir` is injected through the
 * `SWPANEL_FORGE_OUT_DIR` environment variable (see forge.config.mjs), so every
 * run packages into its own temporary directory and the canonical `out` is only
 * produced by the final publish.
 *
 * @param {string} root
 * @param {string} runOut per-run Forge output directory
 * @returns {Promise<
 *   | { ok: false; exitCode: number }
 *   | { ok: true; asarPath: string; sizeBytes: number }
 * >}
 */
export async function defaultPackage(root, runOut) {
  const forgeCli = fileURLToPath(
    new URL(
      "../node_modules/@electron-forge/cli/dist/electron-forge.js",
      import.meta.url
    )
  );
  const exitCode = await runCommand(
    process.execPath,
    [forgeCli, "package", "--platform=win32", "--arch=x64"],
    {
      cwd: root,
      env: { ...process.env, SWPANEL_FORGE_OUT_DIR: runOut }
    }
  );
  if (exitCode !== 0) {
    return { ok: false, exitCode };
  }
  const { asarPath, sizeBytes } = await verifyPackagedAppAsar(runOut);
  return { ok: true, asarPath, sizeBytes };
}

/**
 * Audit the freshly produced asar (closure + forbidden content).
 *
 * @param {string} asarPath
 * @returns {Promise<Awaited<ReturnType<typeof reportAsarAudit>>>}
 */
export function defaultAudit(asarPath) {
  return reportAsarAudit(asarPath);
}

/**
 * Launch the freshly packaged app and verify it boots with the renderer served
 * over `app://swpanel` (production posture). Reuses the Electron production
 * ASAR launch approach from e2e/electron.production.spec.ts without modifying
 * that spec.
 *
 * @param {string} asarPath
 */
export async function defaultSmoke(asarPath) {
  const { smokePackagedApp } = await import("./package-smoke.mjs");
  await smokePackagedApp(asarPath);
}

/**
 * Full packaging chain: lock -> legacy-copy guard -> quarantine previous
 * canonical out -> build -> package (per-run out) -> verify -> audit -> smoke,
 * then an atomic publish to the canonical `out` only when every step passed.
 * The canonical `out` does not exist during the run, so a failed
 * build/package/audit/smoke can never leave a stale package as current
 * evidence.
 *
 * All heavy steps are injectable so tests can exercise every failure stage
 * without running npm/Forge/Electron.
 *
 * @param {{
 *   root?: string;
 *   lockDir?: string;
 *   runBuild?: (root: string) => number | Promise<number>;
 *   runPackage?: (root: string, runOut: string) =>
 *     | { ok: false; exitCode: number }
 *     | { ok: true; asarPath: string; sizeBytes: number }
 *     | Promise<{ ok: false; exitCode: number } | { ok: true; asarPath: string; sizeBytes: number }>;
 *   runAudit?: (asarPath: string) => { ok: boolean } | Promise<{ ok: boolean }>;
 *   runSmoke?: (asarPath: string) => void | Promise<void>;
 *   publish?: (runDir: string, root: string) => string | Promise<string>;
 *   finalizeReport?: (publishedAsarPath: string) => unknown | Promise<unknown>;
 * }} [options]
 * @returns {Promise<
 *   | { ok: false; exitCode?: number; stage: string; runDir?: string; error?: string }
 *   | { ok: true; asarPath: string; sizeBytes: number; auditReportPath: string; outPath: string }
 * >}
 */
export async function packageAll(options = {}) {
  const root = options.root ?? workspaceRoot;
  const lockDir = options.lockDir ?? path.join(root, ".scratch", "package-lock");
  const runBuild = options.runBuild ?? defaultBuild;
  const runPackage = options.runPackage ?? defaultPackage;
  const runAudit = options.runAudit ?? defaultAudit;
  const runSmoke = options.runSmoke ?? defaultSmoke;
  const publish = options.publish ?? publishRunOutput;
  const finalizeReport = options.finalizeReport ?? finalizeAsarAuditReport;

  const acquisition = await acquirePackageLock(lockDir);
  if (acquisition.status === "busy") {
    throw new Error(
      "Another packaging run is in progress (a live process holds the " +
        "packaging lock). Wait for it to finish."
    );
  }
  if (acquisition.status === "unknown") {
    throw new Error(
      `The packaging lock directory "${lockDir}" has unreadable or missing ` +
        "owner metadata. A crash during lock initialization may have left it " +
        "behind. Inspect it manually; packaging never deletes it automatically."
    );
  }
  const lock = acquisition.lock;
  try {
    await assertNoLegacyPackageCopy(root);
    const quarantine = await quarantineExistingOut(root);
    if (quarantine.status === "moved") {
      console.log(
        `Quarantined previous output at ${quarantine.target}; the canonical ` +
          "out will not exist until this run publishes a verified package."
      );
    }
    const { runDir, outDir } = await createPackageRun(root);
    const buildCode = await runBuild(root);
    if (buildCode !== 0) {
      return { ok: false, exitCode: buildCode, stage: "build", runDir };
    }
    const packaged = await runPackage(root, outDir);
    if (packaged.ok === false) {
      return { ok: false, exitCode: packaged.exitCode, stage: "package", runDir };
    }
    const report = await runAudit(packaged.asarPath);
    if (!report.ok) {
      console.error(
        `ASAR audit FAILED for ${packaged.asarPath}. The failed package is ` +
          `kept only under the temporary run directory ${runDir}; the canonical ` +
          "out was not published."
      );
      console.error(`Audit report: ${auditReportPath}`);
      return { ok: false, stage: "audit", runDir };
    }
    try {
      await runSmoke(packaged.asarPath);
    } catch (error) {
      return {
        ok: false,
        stage: "smoke",
        runDir,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    let outPath;
    try {
      outPath = await publish(runDir, root);
    } catch (error) {
      // Publish/rename failures are never swallowed: the canonical out must
      // not exist, and the failure must reach the caller with a clear stage.
      return {
        ok: false,
        stage: "publish",
        runDir,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    // The canonical asar lives under the published `out`. Resolve it from the
    // fresh package layout so callers and the audit report always reference
    // the published artifact, not the per-run source.
    const canonicalAsarPath = path.join(
      outPath,
      "SWPanel-win32-x64",
      "resources",
      "app.asar"
    );
    try {
      await finalizeReport(canonicalAsarPath);
    } catch (error) {
      // The package is already canonical; a failed report finalization must
      // still surface loudly (never report success without the published
      // fingerprint tied to the report).
      return {
        ok: false,
        stage: "publish",
        runDir,
        error:
          `Package published to ${outPath} but the audit report could not be ` +
          `finalized: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    console.log(`Published verified package to ${outPath}.`);
    return {
      ok: true,
      asarPath: canonicalAsarPath,
      sizeBytes: packaged.sizeBytes,
      auditReportPath,
      outPath
    };
  } catch (error) {
    return {
      ok: false,
      stage: "setup",
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await releasePackageLock(lock, lockDir);
  }
}
