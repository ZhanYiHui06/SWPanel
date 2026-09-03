import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

import { open as openZip } from "yauzl";

import { reportAsarAudit, sha256File } from "./audit-asar.mjs";
import {
  assertWithinRoot,
  defaultSmoke,
  isWindowsFileLock,
  PUBLISH_RETRY_DELAYS
} from "./packaging.mjs";
import {
  acquirePackageLock,
  releasePackageLock
} from "./package-lock.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

export { workspaceRoot };

/** Prefix of the root-level quarantine that holds a previous canonical `installers`. */
export const INSTALLERS_INVALID_PREFIX = "installers-invalid-";

/**
 * Directory where every installer run stores its temporary staging output.
 * `.scratch/installer-runs/<uuid>/out` holds the audited canonical package
 * copied for Forge's `make --skip-package`; the canonical root `installers`
 * directory is only ever produced by the final atomic publish after
 * package/stage/make/audit all succeed.
 */
export const installerRunsRoot = fileURLToPath(
  new URL("../.scratch/installer-runs", import.meta.url)
);

/**
 * The per-workspace directory that must contain every installer run.
 *
 * @param {string} root workspace root
 * @returns {string}
 */
export function installerRunsDir(root) {
  return path.join(root, ".scratch", "installer-runs");
}

/** Human-readable installer audit report location (gitignored via .scratch). */
export const installerAuditReportPath = fileURLToPath(
  new URL("../.scratch/installer-audit-report.json", import.meta.url)
);

/** The entry inside a Squirrel full.nupkg that must be the packaged app.asar. */
export const REQUIRED_NUPKG_ASAR_ENTRY = "lib/net45/resources/app.asar";

/**
 * Absolute ceiling for a single packaged app.asar streamed out of the
 * full.nupkg. The canonical-size comparison already ties the nupkg asar to the
 * audited package byte-for-byte; this independent sanity bound rejects a
 * corrupt or hostile nupkg that claims an implausibly large archive entry
 * before it is ever compared or streamed fully.
 */
export const MAX_NUPKG_ASAR_SIZE_BYTES = 512 * 1024 * 1024;

/** Windows PE executable magic bytes: the first two bytes of a real Setup.exe. */
export const MZ_MAGIC = Buffer.from([0x4d, 0x5a]);

/** Windows PE signature bytes: "PE\0\0" at the e_lfanew offset. */
export const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00]);

/** COFF machine value of a 64-bit (x64/AMD64) PE image. */
export const MACHINE_X64 = 0x8664;

/** COFF machine value of a 32-bit (i386) PE image. */
export const MACHINE_X86 = 0x014c;

/**
 * COFF machine values accepted for the Squirrel Setup.exe bootstrapper.
 * Squirrel's electron-winstaller generates Setup.exe as a STANDARD i386
 * (0x14c) bootstrapper regardless of the app's target architecture, so the
 * audit explicitly requires/accepts 0x14c. An x64 (0x8664) bootstrapper is
 * also allowed in case a future Squirrel/electron-winstaller emits one, but
 * any other machine (ARM/ARM64/RISC-V, or a misnamed blob) is rejected. The
 * payload app exe inside the full.nupkg, by contrast, must be x64
 * (MACHINE_X64) — see the payload audit.
 */
export const BOOTSTRAPPER_MACHINES = [MACHINE_X86, MACHINE_X64];

/** The 4-byte e_lfanew field ends at 0x40, the minimum valid PE header offset. */
export const MIN_PE_HEADER_OFFSET = 0x40;

/**
 * The number of leading bytes read to probe a PE image. The DOS header,
 * e_lfanew, the "PE\0\0" signature and the COFF header all live in the first
 * 64 KiB, so a multi-hundred-megabyte Setup.exe or payload exe is never
 * buffered — only this prefix is inspected.
 */
export const PE_PROBE_BYTES = 64 * 1024;

/**
 * Normalize a ZIP entry name to a stable Windows-path key. A ZIP entry is a
 * raw path string that may use forward or back slashes, contain redundant
 * separators or dot segments, or differ only in case; on a Windows filesystem
 * every one of those forms can address the SAME extracted file. This returns
 * the canonical key used for uniqueness and collision checks: POSIX
 * separators, `..`/`.` dot segments collapsed, redundant separators removed,
 * and the whole path lowercased (casefold). Returns null when the entry
 * escapes the archive root via a leading `..` past the root or resolves to
 * the root itself.
 *
 * @param {string} entry raw ZIP entry name
 * @returns {string | null}
 */
export function normalizeZipEntryName(entry) {
  const segments = [];
  for (const raw of entry.replace(/\\/g, "/").split("/")) {
    if (raw.length === 0 || raw === ".") continue;
    if (raw === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(raw.toLowerCase());
  }
  return segments.length === 0 ? null : segments.join("/");
}

/**
 * Squirrel's NuGet version form, mirroring electron-winstaller's convertVersion
 * (`1.2.3-beta.1` -> `1.2.3-beta1`). The full.nupkg basename embeds this form,
 * so the expected artifact name must use it too.
 *
 * @param {string} version package.json version
 * @returns {string}
 */
export function toSquirrelVersion(version) {
  const withoutBuild = String(version).split("+")[0] ?? "";
  const parts = withoutBuild.split("-");
  const main = parts[0] ?? "";
  const pre = parts.slice(1);
  if (pre.length === 0) return main;
  return [main, pre.join("-").replace(/\./g, "")].join("-");
}

/**
 * The forge/package identity that drives every Squirrel artifact name: the
 * forge `packagerConfig.name` (falling back to `packagerConfig.executableName`
 * and then the package name). Both the Setup.exe basename and the payload exe
 * entry inside the full.nupkg are derived from this app name.
 *
 * @returns {Promise<{ appName: string; pkg: { name: string; version: string } }>}
 */
async function readForgeIdentity() {
  const forgeConfig = (await import("../forge.config.mjs")).default;
  const pkg = JSON.parse(
    await readFile(path.join(workspaceRoot, "package.json"), "utf8")
  );
  return {
    appName:
      forgeConfig?.packagerConfig?.name ??
      forgeConfig?.packagerConfig?.executableName ??
      pkg.name,
    pkg
  };
}

/**
 * Expected Squirrel artifact basenames for the current workspace, derived the
 * same way Electron Forge's MakerSquirrel names them:
 *
 * - Setup.exe is `<appName>-<version> Setup.exe`, where appName is the forge
 *   packagerConfig.name (falling back to the executableName and then the
 *   package name);
 * - the full.nupkg is `<packageName>-<squirrelVersion>-full.nupkg`, where
 *   packageName is the package.json name with hyphens replaced by underscores
 *   (Squirrel rejects hyphens).
 *
 * @returns {Promise<{ setupExe: string; fullNupkg: string }>}
 */
export async function deriveSquirrelArtifactNames() {
  const { appName, pkg } = await readForgeIdentity();
  const version = toSquirrelVersion(pkg.version);
  return {
    setupExe: `${appName}-${version} Setup.exe`,
    fullNupkg: `${String(pkg.name).replace(/-/g, "_")}-${version}-full.nupkg`
  };
}

/**
 * The Squirrel payload entry inside the full.nupkg: the packaged x64 app
 * executable that Squirrel extracts to `lib/net45/` and runs. The basename is
 * derived from the forge `packagerConfig.name`/`executableName` (falling back
 * to the package name), the same identity that names Setup.exe, so e.g. this
 * workspace yields `lib/net45/SWPanel.exe`.
 *
 * @returns {Promise<string>} e.g. `lib/net45/SWPanel.exe`
 */
export async function deriveNupkgPayloadEntryName() {
  const { appName } = await readForgeIdentity();
  return `lib/net45/${appName}.exe`;
}

/**
 * True when a size claim for a nupkg entry (the packaged app.asar or the
 * payload exe) is within the documented upper limit. Rejecting an oversized
 * entry before any SHA-256 work keeps the audit robust against pathological
 * archives.
 *
 * @param {number} sizeBytes
 * @param {number} maxBytes the absolute cap (shared MAX_NUPKG_ASAR_SIZE_BYTES
 *   unless a test overrides it)
 * @param {string} entryLabel human-readable entry name for error messages
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
export function checkNupkgEntrySizeLimit(sizeBytes, maxBytes, entryLabel) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return {
      ok: false,
      error: `Invalid ${entryLabel} size claim "${sizeBytes}" in the full.nupkg.`
    };
  }
  if (sizeBytes > maxBytes) {
    return {
      ok: false,
      error:
        `The ${entryLabel} inside the full.nupkg is ${sizeBytes} bytes, which ` +
        `exceeds the ${maxBytes}-byte upper limit. This is not a plausible ` +
        "SWPanel packaged app; the installer artifacts are rejected."
    };
  }
  return { ok: true };
}

/**
 * Size-limit check for the packaged app.asar entry (see
 * `checkNupkgEntrySizeLimit`); kept as a named wrapper so the cap default is
 * the shared MAX_NUPKG_ASAR_SIZE_BYTES.
 *
 * @param {number} sizeBytes
 * @param {number} [maxBytes] override for tests
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
export function checkNupkgAsarSizeLimit(
  sizeBytes,
  maxBytes = MAX_NUPKG_ASAR_SIZE_BYTES
) {
  return checkNupkgEntrySizeLimit(sizeBytes, maxBytes, "app.asar");
}

/**
 * @typedef {{
 *   releases: string;
 *   setupExe: string;
 *   fullNupkg: string;
 * }} InstallerArtifacts
 */

/**
 * @typedef {{
 *   entry: string;
 *   found: boolean;
 *   sha256: string;
 *   sizeBytes: number;
 *   crc32: number;
 * }} NupkgAsarEntryReport
 */

/**
 * @typedef {{
 *   entry: string;
 *   found: boolean;
 *   sha256: string;
 *   sizeBytes: number;
 *   crc32: number;
 *   machine: number;
 * }} NupkgPayloadExeReport
 */

/**
 * @typedef {{
 *   ok: false;
 *   generatedAt: string;
 *   makerOutputDir: string;
 *   error: string;
 *   stage?: string;
 *   shaMatches?: boolean;
 *   canonicalAsarPath?: string;
 *   canonicalAsarSha256?: string;
 *   canonicalAsarSizeBytes?: number;
 *   artifacts?: InstallerArtifacts;
 *   nupkg?: NupkgAsarEntryReport;
 *   payload?: NupkgPayloadExeReport;
 * }} InstallerAuditFailure
 */

/**
 * @typedef {{
 *   ok: true;
 *   generatedAt: string;
 *   makerOutputDir: string;
 *   canonicalAsarPath: string;
 *   canonicalAsarSha256: string;
 *   canonicalAsarSizeBytes: number;
 *   artifacts: InstallerArtifacts;
 *   nupkg: NupkgAsarEntryReport;
 *   payload: NupkgPayloadExeReport;
 *   shaMatches: true;
 * }} InstallerAuditSuccess
 */

/** @typedef {InstallerAuditFailure | InstallerAuditSuccess} InstallerAuditReport */

/**
 * The audit report plus per-run metadata merged in by makeWinInstaller before
 * the report is written to `.scratch/installer-audit-report.json`.
 *
 * @typedef {InstallerAuditReport & {
 *   canonicalAudit?: AsarAuditReport;
 *   uuid?: string;
 *   runDir?: string;
 *   publishedPath?: string;
 *   publishedAt?: string;
 * }} InstallerAuditReportWithMeta
 */

/**
 * @typedef {{
 *   ok: true;
 *   asarPath: string;
 *   outPath: string;
 *   sizeBytes: number;
 *   canonicalAsarSha256: string;
 *   auditReport: AsarAuditReport;
 * }} PrepareCanonicalPackageSuccess
 */

/**
 * @typedef {{
 *   ok: false;
 *   stage: "audit" | "smoke";
 *   asarPath: string;
 *   error: string;
 *   auditReport: AsarAuditReport | null;
 * }} PrepareCanonicalPackageFailure
 */

/** @typedef {import("./audit-asar.mjs").AsarAuditReport} AsarAuditReport */

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
 * Strict containment guard used for every path make:win stages or publishes:
 * the candidate must be lexically inside the container AND, once every
 * symlink/junction on the way has been resolved, still be strictly inside it.
 * An existing candidate that is itself a symlink or junction is rejected
 * outright so a staged or published source can never be redirected outside the
 * workspace.
 *
 * Both paths must exist: the container and the candidate are resolved with
 * realpath. Callers create the candidate (mkdir) or verify existence before
 * calling.
 *
 * @param {string} container existing directory the candidate must live inside
 * @param {string} candidate existing path to validate
 * @param {string} label human-readable description for error messages
 */
export async function assertStrictWithin(container, candidate, label) {
  assertWithinRoot(container, candidate, label);
  let linkInfo;
  try {
    linkInfo = await lstat(candidate);
  } catch {
    linkInfo = null;
  }
  if (linkInfo !== null && linkInfo.isSymbolicLink()) {
    throw new Error(
      `Refusing to use "${candidate}" as ${label}: it is a symbolic link or junction.`
    );
  }
  const resolvedContainer = await realpath(container);
  const resolvedCandidate = await realpath(candidate);
  if (resolvedCandidate === resolvedContainer) {
    throw new Error(
      `Refusing to operate on the container itself as ${label}: "${resolvedCandidate}".`
    );
  }
  const relative = path.relative(resolvedContainer, resolvedCandidate);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    throw new Error(
      `Refusing to operate outside "${resolvedContainer}" for ${label}: ` +
        `"${resolvedCandidate}".`
    );
  }
}

/**
 * Recursively verify that a directory tree contains no symbolic links,
 * junctions, or reparse points. The tree root and every entry are lstat'd
 * individually so the tree is walked without ever following a link; on Windows
 * a junction is a reparse point that lstat reports as a symbolic link, so
 * junctions are rejected the same way as symlinks. Because every path in the
 * tree is a real file or directory, the realpath containment established for
 * the tree root extends to the whole tree.
 *
 * @param {string} dir directory (or root path) to verify
 * @param {string} label human-readable description for error messages
 */
async function assertNoLinksInTree(dir, label) {
  let rootInfo;
  try {
    rootInfo = await lstat(dir);
  } catch (error) {
    throw new Error(
      `Cannot inspect the ${label} tree at "${dir}": ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error }
    );
  }
  if (rootInfo.isSymbolicLink()) {
    throw new Error(
      `Refusing to stage: "${dir}" inside the ${label} is a symbolic link, ` +
        "junction, or reparse point. The packaged app tree must contain only " +
        "real files and directories."
    );
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Cannot inspect the ${label} tree at "${dir}": ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error }
    );
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) {
      throw new Error(
        `Refusing to stage: "${fullPath}" inside the ${label} is a symbolic ` +
          "link, junction, or reparse point. The packaged app tree must " +
          "contain only real files and directories."
      );
    }
    if (info.isDirectory()) {
      await assertNoLinksInTree(fullPath, label);
    }
  }
}

/**
 * Create a fresh per-run staging directory under `.scratch/installer-runs/<uuid>`
 * and record the run metadata inside it. The run directory is strictly
 * contained under `.scratch/installer-runs` (realpath-resolved) so a pre-existing
 * junction can never redirect staging outside the workspace.
 *
 * @param {string} root
 * @returns {Promise<{ runDir: string; stagingOut: string; uuid: string }>}
 */
export async function createInstallerRun(root) {
  const runsRoot = installerRunsDir(root);
  assertWithinRoot(root, runsRoot, "installer runs scratch directory");
  await mkdir(runsRoot, { recursive: true });
  await assertStrictWithin(root, runsRoot, "installer runs scratch directory");
  const uuid = randomUUID();
  const runDir = path.join(runsRoot, uuid);
  await mkdir(runDir, { recursive: true });
  await assertStrictWithin(runsRoot, runDir, "installer run directory");
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
  return { runDir, stagingOut: path.join(runDir, "out"), uuid };
}

/**
 * Copy the audited canonical packaged app (`out/SWPanel-win32-x64`) into the
 * per-run staging out. The canonical `out` itself is never passed to Forge's
 * `make` (its `make` directory and temporary copies would disturb the audited
 * canonical tree); `make --skip-package` runs exclusively against the staging
 * copy, whose `resources/app.asar` must remain byte-identical to the canonical
 * one so the nupkg audit below can compare SHA-256 fingerprints.
 *
 * The canonical package source (and the run staging output) must resolve
 * strictly inside the workspace/`.scratch/installer-runs` and must not be a
 * symlink/junction. The entire canonical package tree is recursively verified
 * (lstat) before copying so a nested symlink/junction/reparse point — not only
 * one at the tree root — can never redirect the copy outside the workspace;
 * the staged copy is recursively verified again after the copy completes.
 *
 * @param {string} root
 * @param {string} runDir
 * @param {string} packageOutPath canonical Forge output directory (e.g. `out`)
 * @returns {Promise<string>} the staged packaged app directory
 */
export async function stageCanonicalPackage(root, runDir, packageOutPath) {
  const source = path.join(packageOutPath, "SWPanel-win32-x64");
  let info;
  try {
    info = await stat(source);
  } catch (error) {
    throw new Error(
      `Cannot stage the canonical package: "${source}" does not exist. ` +
        "Run package:win first; make:win stages only a fully audited package.",
      { cause: error }
    );
  }
  if (!info.isDirectory()) {
    throw new Error(
      `Cannot stage the canonical package: "${source}" is not a directory. ` +
        "Inspect it manually; make:win was aborted."
    );
  }
  // Both the canonical package output and the staged source must resolve
  // strictly inside the workspace and must not be symlinks/junctions.
  await assertStrictWithin(root, packageOutPath, "canonical package output");
  await assertStrictWithin(root, source, "canonical package source");
  // Recursively verify the ENTIRE canonical package tree before copying it:
  // any symlink, junction, or reparse point anywhere inside (not only at the
  // root) is rejected, so the copy can never follow a nested link outside the
  // workspace. Because every entry is a real file or directory, the realpath
  // containment the strict root check established extends to the whole tree.
  await assertNoLinksInTree(source, "canonical package");
  const runsRoot = installerRunsDir(root);
  await assertStrictWithin(runsRoot, runDir, "installer run directory");
  const stagingOut = path.join(runDir, "out");
  await mkdir(stagingOut, { recursive: true });
  await assertStrictWithin(runsRoot, stagingOut, "installer staging output");
  const staged = path.join(stagingOut, "SWPanel-win32-x64");
  // The staged destination must not already be a symlink/junction: fs.cp
  // follows an existing link at the destination and would write through to the
  // link target, escaping the staging area. Reject it before any copy happens.
  let stagedInfo;
  try {
    stagedInfo = await lstat(staged);
  } catch {
    stagedInfo = null;
  }
  if (stagedInfo !== null && stagedInfo.isSymbolicLink()) {
    throw new Error(
      `Refusing to stage: destination "${staged}" is a symbolic link, ` +
        "junction, or reparse point. The staging area must contain only real " +
        "directories."
    );
  }
  await cp(source, staged, {
    recursive: true
  });
  // Defense in depth: re-verify the staged copy after the copy completes.
  // fs.cp preserves symlinks by default, so a link copied from a source that
  // changed between the pre-copy walk and the copy, or injected into the
  // staging area, would still be rejected here and never reach Forge.
  await assertNoLinksInTree(staged, "staged package");
  return staged;
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
 * Invoke Electron Forge `make --skip-package --platform=win32 --arch=x64
 * --targets squirrel` against the staging out. The staging out is injected the
 * same way package:win injects its per-run out: forge.config.mjs reads
 * `SWPANEL_FORGE_OUT_DIR` at load time, so Forge resolves the packaged app
 * under `<stagingOut>/SWPanel-win32-x64` (the staged copy, never the canonical
 * `out`) and writes the squirrel artifacts under
 * `<stagingOut>/make/squirrel.windows/x64`.
 *
 * @param {string} root
 * @param {string} stagingOut
 * @returns {Promise<number>} Forge exit code
 */
export async function defaultMake(root, stagingOut) {
  const forgeCli = fileURLToPath(
    new URL(
      "../node_modules/@electron-forge/cli/dist/electron-forge.js",
      import.meta.url
    )
  );
  return runCommand(
    process.execPath,
    [
      forgeCli,
      "make",
      "--skip-package",
      "--platform=win32",
      "--arch=x64",
      "--targets",
      "squirrel"
    ],
    {
      cwd: root,
      env: { ...process.env, SWPANEL_FORGE_OUT_DIR: stagingOut }
    }
  );
}

/**
 * Stream a single entry out of a ZIP (Squirrel full.nupkg) with yauzl and hash
 * its bytes while computing the CRC-32 of the decompressed stream. Entries are
 * lazily read from the central directory so only the matching file is
 * decompressed. The caller is responsible for having verified (via
 * `readZipEntries`) that the entry is unique before streaming it.
 *
 * When `maxBytes` is supplied the decompressed stream is hard-capped: as soon
 * as the size passes the cap the stream is aborted, the archive is closed, and
 * `sizeExceeded` is set, so a hostile or corrupt archive whose central
 * directory lies about the entry size can never make the audit decompress an
 * unbounded payload.
 *
 * When `options.capturePrefixBytes` is supplied, up to that many leading bytes
 * of the decompressed stream are also retained (as `prefix`) so callers can
 * inspect the PE header of an entry such as the payload exe without buffering
 * the whole (potentially multi-hundred-megabyte) entry.
 *
 * @param {string} zipPath
 * @param {string} entryName
 * @param {number} [maxBytes] hard cap on the decompressed size (no limit when
 *   omitted)
 * @param {{ capturePrefixBytes?: number }} [options] retain up to
 *   `capturePrefixBytes` leading decompressed bytes as `prefix`
 * @returns {Promise<
 *   | { found: false }
 *   | { found: true; sha256: string; sizeBytes: number; crc32: number; sizeExceeded: boolean; prefix?: Buffer }
 * >}
 */
export function readZipEntrySha256(zipPath, entryName, maxBytes, options = {}) {
  return new Promise((resolve, reject) => {
    openZip(
      zipPath,
      { lazyEntries: true, decodeStrings: true },
      (openError, zipfile) => {
        if (openError !== null) {
          reject(openError);
          return;
        }
        let settled = false;
        zipfile.on("error", reject);
        zipfile.on("end", () => {
          if (!settled) {
            settled = true;
            resolve({ found: false });
          }
        });
        zipfile.on("entry", (entry) => {
          if (entry.fileName !== entryName) {
            zipfile.readEntry();
            return;
          }
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError !== null) {
              reject(streamError);
              return;
            }
            const capturePrefixBytes = options.capturePrefixBytes;
            const prefix =
              capturePrefixBytes !== undefined && capturePrefixBytes > 0
                ? Buffer.alloc(capturePrefixBytes)
                : undefined;
            let prefixFilled = 0;
            const hash = createHash("sha256");
            let size = 0;
            let crc = 0;
            stream.on("data", (chunk) => {
              size += chunk.length;
              hash.update(chunk);
              crc = crc32(chunk, crc);
              if (prefix !== undefined && prefixFilled < prefix.length) {
                const n = Math.min(prefix.length - prefixFilled, chunk.length);
                chunk.copy(prefix, prefixFilled, 0, n);
                prefixFilled += n;
              }
              if (maxBytes !== undefined && size > maxBytes && !settled) {
                settled = true;
                zipfile.close();
                stream.destroy();
                resolve({
                  found: true,
                  sha256: hash.digest("hex"),
                  sizeBytes: size,
                  crc32: crc >>> 0,
                  sizeExceeded: true,
                  ...(prefix !== undefined
                    ? { prefix: prefix.subarray(0, prefixFilled) }
                    : {})
                });
              }
            });
            stream.on("error", (streamErr) => {
              if (settled) return;
              settled = true;
              zipfile.close();
              reject(streamErr);
            });
            stream.on("end", () => {
              if (settled) return;
              settled = true;
              zipfile.close();
              resolve({
                found: true,
                sha256: hash.digest("hex"),
                sizeBytes: size,
                crc32: crc >>> 0,
                sizeExceeded: false,
                ...(prefix !== undefined
                  ? { prefix: prefix.subarray(0, prefixFilled) }
                  : {})
              });
            });
          });
        });
        zipfile.readEntry();
      }
    );
  });
}

/**
 * Enumerate every entry of a ZIP (Squirrel full.nupkg) from the central
 * directory without decompressing any file data. Used to enforce strict
 * uniqueness of the packaged app.asar entry before it is streamed.
 *
 * @param {string} zipPath
 * @returns {Promise<Array<{
 *   fileName: string;
 *   crc32: number;
 *   compressedSize: number;
 *   uncompressedSize: number;
 *   compressionMethod: number;
 * }>>}
 */
export function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    openZip(
      zipPath,
      { lazyEntries: true, decodeStrings: true },
      (openError, zipfile) => {
        if (openError !== null) {
          reject(openError);
          return;
        }
        /** @type {Array<{ fileName: string; crc32: number; compressedSize: number; uncompressedSize: number; compressionMethod: number }>} */
        const entries = [];
        zipfile.on("error", reject);
        zipfile.on("end", () => resolve(entries));
        zipfile.on("entry", (entry) => {
          entries.push({
            fileName: entry.fileName,
            crc32: entry.crc32,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
            compressionMethod: entry.compressionMethod
          });
          zipfile.readEntry();
        });
        zipfile.readEntry();
      }
    );
  });
}

/**
 * Assert a required squirrel artifact exists, is a file, and is non-empty.
 *
 * @param {string} filePath
 * @param {string} label
 */
async function assertArtifact(filePath, label) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(
      `Squirrel maker output is incomplete: ${label} is missing at "${filePath}".`
    );
  }
  if (!info.isFile() || info.size <= 0) {
    throw new Error(
      `Squirrel maker output is incomplete: ${label} at "${filePath}" is ` +
        "empty or not a file."
    );
  }
}

/**
 * SHA-1 hex digest of a file's contents. Squirrel's RELEASES file fingerprints
 * each nupkg with SHA-1, so the installer audit verifies that claim against the
 * actual full.nupkg bytes.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha1File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha1").update(data).digest("hex");
}

/**
 * True when the file's first two bytes are the MZ magic of a Windows PE
 * executable. Only the 2-byte header is read, so a 141 MB Setup.exe is never
 * buffered. This is deliberately weak (the installer audit uses
 * `validateWindowsPE` for the full MZ/e_lfanew/PE\0\0/machine verification);
 * it exists as a cheap pre-check and for tests that only assert the magic.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function hasMZHeader(filePath) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const header = Buffer.alloc(MZ_MAGIC.length);
    const { bytesRead } = await handle.read(header, 0, MZ_MAGIC.length, 0);
    if (bytesRead !== MZ_MAGIC.length) return false;
    return header.equals(MZ_MAGIC);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Verify a leading buffer really is a Windows PE image by parsing its headers:
 *
 * 1. starts with the `MZ` magic (DOS header);
 * 2. `e_lfanew` (offset 0x3C, 4-byte LE) points at or past 0x40 with a valid
 *    PE header length (a DOS stub is at least 64 bytes);
 * 3. the signature at that offset is exactly `PE\0\0`;
 * 4. the COFF machine field (immediately after the signature) is one of the
 *    caller-supplied `allowedMachines`.
 *
 * The caller supplies the machine policy explicitly: Setup.exe is expected to
 * be the standard i386 bootstrapper (`BOOTSTRAPPER_MACHINES`), while the
 * payload exe inside the full.nupkg must be x64 (`[MACHINE_X64]`). A buffer
 * that merely starts with `MZ` but lacks a valid PE header (a misnamed blob)
 * is rejected.
 *
 * @param {Buffer} bytes leading bytes of the image (at least the first ~64
 *   bytes; `PE_PROBE_BYTES` for safety)
 * @param {readonly number[]} allowedMachines COFF machines accepted for this
 *   role
 * @returns {{ ok: true; machine: number } | { ok: false; error: string }}
 */
export function parsePEHeader(bytes, allowedMachines) {
  if (bytes.length < MZ_MAGIC.length) {
    return {
      ok: false,
      error: `Too short to be a Windows PE executable (${bytes.length} bytes).`
    };
  }
  if (!bytes.subarray(0, MZ_MAGIC.length).equals(MZ_MAGIC)) {
    return {
      ok: false,
      error: "Does not start with the MZ magic of a Windows PE executable."
    };
  }
  if (bytes.length < MIN_PE_HEADER_OFFSET + 4) {
    return {
      ok: false,
      error: "Too short to carry a PE e_lfanew header offset."
    };
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (!Number.isInteger(peOffset) || peOffset < MIN_PE_HEADER_OFFSET) {
    return {
      ok: false,
      error:
        `Invalid PE header offset ${peOffset} (must be at or past ` +
        `${MIN_PE_HEADER_OFFSET}).`
    };
  }
  if (bytes.length < peOffset + PE_SIGNATURE.length + 2) {
    return {
      ok: false,
      error: `Truncated before the PE header at offset ${peOffset}.`
    };
  }
  if (
    !bytes
      .subarray(peOffset, peOffset + PE_SIGNATURE.length)
      .equals(PE_SIGNATURE)
  ) {
    return {
      ok: false,
      error:
        `No "PE\\0\\0" signature at offset ${peOffset}; not a real PE image.`
    };
  }
  const machine = bytes.readUInt16LE(peOffset + PE_SIGNATURE.length);
  if (!allowedMachines.includes(machine)) {
    return {
      ok: false,
      error:
        `COFF machine 0x${machine.toString(16)} is not one of the expected ` +
        `machines (${allowedMachines
          .map((m) => `0x${m.toString(16)}`)
          .join(", ")}).`
    };
  }
  return { ok: true, machine };
}

/**
 * Verify a file really is a Windows PE image with a COFF machine among
 * `allowedMachines` (see `parsePEHeader` for the header rules). Only the first
 * `PE_PROBE_BYTES` are read (the whole DOS header, the "PE\0\0" signature, the
 * COFF header and the start of the optional header all live there), so a
 * multi-hundred-megabyte Setup.exe is never buffered.
 *
 * @param {string} filePath
 * @param {readonly number[]} allowedMachines COFF machines accepted for this
 *   role (e.g. `BOOTSTRAPPER_MACHINES` for Setup.exe)
 * @returns {Promise<{ ok: true; machine: number } | { ok: false; error: string }>}
 */
export async function validateWindowsPE(filePath, allowedMachines) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const header = Buffer.alloc(PE_PROBE_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const parsed = parsePEHeader(header.subarray(0, bytesRead), allowedMachines);
    if (parsed.ok === false) {
      return {
        ok: false,
        error:
          `"${filePath}" is not a valid Windows PE executable: ${parsed.error}`
      };
    }
    return parsed;
  } catch (error) {
    return {
      ok: false,
      error:
        `Cannot inspect "${filePath}" as a Windows PE executable: ` +
        (error instanceof Error ? error.message : String(error))
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Verify an in-memory leading buffer (e.g. the `prefix` captured from the
 * payload exe entry while streaming it out of the full.nupkg) is a real
 * Windows PE image with a COFF machine among `allowedMachines`.
 *
 * @param {Buffer} bytes leading bytes of the image
 * @param {readonly number[]} allowedMachines COFF machines accepted for this
 *   role
 * @returns {{ ok: true; machine: number } | { ok: false; error: string }}
 */
export function validateWindowsPEBuffer(bytes, allowedMachines) {
  return parsePEHeader(bytes, allowedMachines);
}

/**
 * Parse a Squirrel RELEASES file into its lines. Every Squirrel RELEASES line
 * is exactly `SHA1 FILENAME SIZE`; a UTF-8 BOM and CRLF endings are tolerated.
 *
 * @param {string} content raw RELEASES text
 * @returns {Array<{ sha1: string; name: string; size: string; tokenCount: number; raw: string }>}
 */
export function parseReleases(content) {
  return content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tokens = line.split(/\s+/);
      return {
        sha1: tokens[0] ?? "",
        name: tokens[1] ?? "",
        size: tokens[2] ?? "",
        tokenCount: tokens.length,
        raw: line
      };
    });
}

/**
 * Strictly validate a Squirrel RELEASES file against the actual full.nupkg that
 * sits next to it. Every line must be EXACTLY `SHA1 FILENAME SIZE` (no extra
 * tokens) with a valid SHA-1 and a positive size; the line naming the actual
 * full.nupkg must be unique and must match its real SHA-1 and byte size. Delta
 * lines (other well-formed names) are tolerated but never trusted for the full
 * package. When `existingNames` is supplied (the files actually on disk next
 * to RELEASES), every referenced filename must correspond to a real artifact,
 * so a RELEASES record that names a blob that is not on disk is rejected.
 *
 * @param {string} content raw RELEASES text
 * @param {{ name: string; size: number; sha1: string }} nupkg the actual
 *   full.nupkg on disk (basename, byte size, SHA-1 hex)
 * @param {{ existingNames?: readonly string[] }} [options] basenames of the
 *   artifacts actually present next to RELEASES; when supplied every
 *   referenced name must appear in it
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
export function validateReleases(content, nupkg, options = {}) {
  const existingNames = options.existingNames;
  const lines = parseReleases(content);
  if (lines.length === 0) {
    return { ok: false, error: "RELEASES is empty; a full package line is required." };
  }
  const seenNames = new Set();
  let fullEntry = undefined;
  for (const line of lines) {
    if (line.tokenCount !== 3) {
      return {
        ok: false,
        error: `RELEASES contains a malformed line: "${line.raw}". ` +
          `It has ${line.tokenCount} tokens; every line must be exactly ` +
          "SHA1 FILENAME SIZE."
      };
    }
    if (line.sha1.length === 0 || line.name.length === 0 || line.size.length === 0) {
      return {
        ok: false,
        error: `RELEASES contains a malformed line: "${line.raw}". ` +
          "Every line must be exactly SHA1 FILENAME SIZE."
      };
    }
    if (!/^[0-9a-fA-F]{40}$/.test(line.sha1)) {
      return {
        ok: false,
        error: `RELEASES contains an invalid SHA-1 in line "${line.raw}".`
      };
    }
    if (!/^[1-9]\d*$/.test(line.size)) {
      return {
        ok: false,
        error: `RELEASES contains an invalid size in line "${line.raw}".`
      };
    }
    // A duplicate record for the same artifact (a case-variant would extract
    // to the same Windows file) makes the file ambiguous and is rejected.
    if (seenNames.has(line.name.toLowerCase())) {
      return {
        ok: false,
        error: `RELEASES references "${line.name}" more than once; each ` +
          "artifact must have exactly one record."
      };
    }
    seenNames.add(line.name.toLowerCase());
    if (line.name === nupkg.name) {
      if (fullEntry !== undefined) {
        return {
          ok: false,
          error: `RELEASES references the full nupkg "${nupkg.name}" more ` +
            "than once; exactly one full package record is required."
        };
      }
      fullEntry = line;
    }
  }
  if (existingNames !== undefined) {
    const onDisk = new Set(existingNames.map((name) => name.toLowerCase()));
    for (const line of lines) {
      if (!onDisk.has(line.name.toLowerCase())) {
        return {
          ok: false,
          error:
            `RELEASES references "${line.name}" but that artifact is not ` +
            "present on disk next to RELEASES."
        };
      }
    }
  }
  if (fullEntry === undefined) {
    return {
      ok: false,
      error:
        `RELEASES does not reference the full nupkg "${nupkg.name}" that is ` +
        "being audited."
    };
  }
  if (fullEntry.size !== String(nupkg.size)) {
    return {
      ok: false,
      error:
        `RELEASES claims "${nupkg.name}" is ${fullEntry.size} bytes but the ` +
        `full.nupkg on disk is ${nupkg.size} bytes.`
    };
  }
  if (fullEntry.sha1.toLowerCase() !== nupkg.sha1.toLowerCase()) {
    return {
      ok: false,
      error:
        `RELEASES SHA-1 for "${nupkg.name}" (${fullEntry.sha1}) does not match ` +
        `the full.nupkg on disk (${nupkg.sha1}).`
    };
  }
  return { ok: true };
}

/**
 * Fingerprint the canonical app.asar (SHA-256 + size) so the nupkg audit can
 * compare against the package package:win just audited.
 *
 * @param {string} canonicalAsarPath
 * @returns {Promise<
 *   | { ok: true; sha256: string; sizeBytes: number }
 *   | { ok: false; error: string }
 * >}
 */
async function fingerprintCanonicalAsar(canonicalAsarPath) {
  try {
    const sha256 = await sha256File(canonicalAsarPath);
    const info = await stat(canonicalAsarPath);
    return { ok: true, sha256, sizeBytes: info.size };
  } catch (error) {
    return {
      ok: false,
      error:
        `Cannot fingerprint the canonical asar "${canonicalAsarPath}": ` +
        (error instanceof Error ? error.message : String(error))
    };
  }
}

/**
 * Audit the freshly made squirrel artifacts under
 * `<stagingOut>/make/squirrel.windows/x64`. Strict format validation, in order:
 *
 * 1. Exactly one `Setup.exe` and exactly one `*-full.nupkg` (plus `RELEASES`)
 *    must exist and be non-empty; duplicates fail loudly instead of silently
 *    picking the first match.
 * 2. `Setup.exe` must be a real Windows PE image whose COFF machine is the
 *    standard Squirrel bootstrapper (i386 0x14c; an x64 0x8664 bootstrapper is
 *    also accepted) — never a misnamed blob.
 * 3. `RELEASES` must be well-formed (`SHA1 FILENAME SIZE` per line) and the line
 *    naming the actual full.nupkg must match its real SHA-1 and byte size.
 * 4. The full.nupkg ZIP must contain exactly one `lib/net45/resources/app.asar`
 *    entry; the decompressed bytes must carry the declared CRC-32, fit within
 *    `MAX_NUPKG_ASAR_SIZE_BYTES`, and match the expected canonical fingerprint
 *    (SHA-256 + size) that the fresh prepare audit established.
 * 5. The full.nupkg must also contain exactly one x64 payload exe entry
 *    (`lib/net45/<appName>.exe`, derived from the forge executableName/name);
 *    it must carry the declared CRC-32, fit within the same entry size cap,
 *    and be a real PE image whose COFF machine is x64 (0x8664) — the evidence
 *    that the installer really targets x64.
 *
 * `expected` is the authoritative comparison target so a canonical asar that
 * changes between prepare and audit can never silently pass; when no expected
 * fingerprint is supplied (backward compatibility) the canonical asar is
 * re-fingerprinted on the spot. A missing or mismatched artifact returns an
 * `ok: false` report; it is never published.
 *
 * @param {string} stagingOut
 * @param {string} canonicalAsarPath
 * @param {{
 *   canonicalAsarSha256?: string;
 *   canonicalAsarSizeBytes?: number;
 *   maxNupkgEntrySizeBytes?: number;
 * }} [expected] expected canonical fingerprint from the fresh prepare audit;
 *   `maxNupkgEntrySizeBytes` optionally overrides the shared nupkg entry size
 *   cap (app.asar AND payload exe) for tests (never set by the make:win chain,
 *   which uses MAX_NUPKG_ASAR_SIZE_BYTES)
 * @returns {Promise<InstallerAuditReport>}
 */
export async function auditMakerOutput(stagingOut, canonicalAsarPath, expected = {}) {
  const squirrelDir = path.join(stagingOut, "make", "squirrel.windows", "x64");
  return auditSquirrelOutput(squirrelDir, canonicalAsarPath, expected);
}

/**
 * Shared core of the full installer audit. It validates a squirrel output
 * directory (either the per-run staging output via `auditMakerOutput` or, after
 * the atomic publish, the canonical root `installers` directory itself via
 * `auditCanonicalInstallers`) with the exact same strict checks: exactly the
 * expected `Setup.exe` (derived from package.json/forge.config.mjs) and
 * full.nupkg basenames, a Setup.exe that is a real Windows PE bootstrapper (MZ,
 * e_lfanew, "PE\0\0", COFF machine in `BOOTSTRAPPER_MACHINES`: the standard
 * i386 0x14c bootstrapper, with 0x8664 accepted for a future x64 one), a
 * RELEASES whose every line is exactly `SHA1 FILENAME SIZE` with a unique
 * truthful full-package record and disk correspondence, a unique packaged
 * app.asar inside the nupkg (Windows-path normalized, collision-free, within
 * the declared AND streamed size caps) whose CRC-32/size/SHA-256 match the
 * canonical fingerprint, and a unique x64 payload exe entry
 * (`lib/net45/<appName>.exe`, derived from the forge executableName/name) that
 * is a real PE with COFF machine 0x8664 and carries the declared CRC-32 within
 * the same size caps.
 *
 * @param {string} squirrelDir directory holding RELEASES/Setup.exe/full.nupkg
 * @param {string} canonicalAsarPath
 * @param {{
 *   canonicalAsarSha256?: string;
 *   canonicalAsarSizeBytes?: number;
 *   maxNupkgEntrySizeBytes?: number;
 * }} [expected] optional canonical fingerprint override (tests only for the cap)
 * @returns {Promise<InstallerAuditReport>}
 */
async function auditSquirrelOutput(squirrelDir, canonicalAsarPath, expected = {}) {
  const base = {
    generatedAt: new Date().toISOString(),
    makerOutputDir: squirrelDir
  };
  let entries;
  try {
    entries = await readdir(squirrelDir);
  } catch {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output directory "${squirrelDir}" is missing. ` +
        "The make step reported success but produced no installer artifacts."
    };
  }
  // Exactly one Setup.exe and exactly one `*-full.nupkg` must be present. A
  // duplicate is never the intended Squirrel output (a stale sibling from a
  // previous run or a misnamed blob) and would make RELEASES ambiguity possible,
  // so the audit fails loudly instead of picking the first match.
  // The Squirrel artifact names are DERIVED from the workspace package.json and
  // forge.config.mjs (the same way MakerSquirrel names them): Setup.exe must be
  // exactly `<appName>-<version> Setup.exe` and the full package exactly
  // `<packageName>-<squirrelVersion>-full.nupkg`. A differently-named
  // executable or nupkg (a misnamed blob) is rejected even when it is a real
  // PE/ZIP, so an installer can never be audited under a wrong identity.
  const expectedNames = await deriveSquirrelArtifactNames();
  const expectedSetupExe = expectedNames.setupExe;
  const expectedFullNupkg = expectedNames.fullNupkg;
  const releases = entries.find((entry) => entry === "RELEASES");
  const setupExes = entries.filter((entry) => /\.exe$/i.test(entry));
  const fullNupkgs = entries.filter((entry) => /-full\.nupkg$/i.test(entry));
  if (releases === undefined || setupExes.length === 0 || fullNupkgs.length === 0) {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output in "${squirrelDir}" is incomplete ` +
        `(RELEASES=${releases ?? "missing"}, ` +
        `Setup.exe=${setupExes.length === 0 ? "missing" : "present"}, ` +
        `full.nupkg=${fullNupkgs.length === 0 ? "missing" : "present"}).`
    };
  }
  // Exact-name matches use a case-insensitive comparison because the artifacts
  // are extracted into the same Windows directory, so a case-variant duplicate
  // would collide on extraction and is rejected outright.
  const setupExact = setupExes.filter(
    (entry) => entry.toLowerCase() === expectedSetupExe.toLowerCase()
  );
  const nupkgExact = fullNupkgs.filter(
    (entry) => entry.toLowerCase() === expectedFullNupkg.toLowerCase()
  );
  const wrongExes = setupExes.filter(
    (entry) => entry.toLowerCase() !== expectedSetupExe.toLowerCase()
  );
  const wrongNupkgs = fullNupkgs.filter(
    (entry) => entry.toLowerCase() !== expectedFullNupkg.toLowerCase()
  );
  if (setupExact.length === 0) {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output in "${squirrelDir}" does not contain the expected ` +
        `Setup.exe "${expectedSetupExe}" (found ` +
        `${setupExes.map((entry) => `"${entry}"`).join(", ") || "no executables"}).`
    };
  }
  if (setupExact.length > 1) {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output in "${squirrelDir}" contains ${setupExact.length} ` +
        `case-variant files named "${expectedSetupExe}"; exactly one ` +
        "Setup.exe is required."
    };
  }
  if (nupkgExact.length === 0) {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output in "${squirrelDir}" does not contain the expected ` +
        `full.nupkg "${expectedFullNupkg}" (found ` +
        `${fullNupkgs.map((entry) => `"${entry}"`).join(", ") || "no nupkgs"}).`
    };
  }
  if (nupkgExact.length > 1) {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output in "${squirrelDir}" contains ${nupkgExact.length} ` +
        `case-variant files named "${expectedFullNupkg}"; exactly one ` +
        "full.nupkg is required."
    };
  }
  if (wrongExes.length > 0) {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output in "${squirrelDir}" contains unexpected ` +
        `executables ${wrongExes.map((entry) => `"${entry}"`).join(", ")}; only ` +
        `the expected Setup.exe "${expectedSetupExe}" is allowed.`
    };
  }
  if (wrongNupkgs.length > 0) {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output in "${squirrelDir}" contains unexpected full ` +
        `packages ${wrongNupkgs.map((entry) => `"${entry}"`).join(", ")}; only ` +
        `the expected full.nupkg "${expectedFullNupkg}" is allowed.`
    };
  }
  const setupExe = setupExact[0];
  const fullNupkg = nupkgExact[0];
  // The length guards above already guarantee these are present; these checks
  // only keep TypeScript's strict indexed-access narrowing honest.
  if (setupExe === undefined || fullNupkg === undefined) {
    return {
      ...base,
      ok: false,
      error:
        `Squirrel maker output in "${squirrelDir}" is incomplete ` +
        `(Setup.exe=${setupExe ?? "missing"}, ` +
        `full.nupkg=${fullNupkg ?? "missing"}).`
    };
  }
  const releasesPath = path.join(squirrelDir, releases);
  const setupExePath = path.join(squirrelDir, setupExe);
  const fullNupkgPath = path.join(squirrelDir, fullNupkg);
  try {
    await assertArtifact(releasesPath, "RELEASES");
    await assertArtifact(setupExePath, "Setup.exe");
    await assertArtifact(fullNupkgPath, "full.nupkg");
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  try {
    // Setup.exe must really be a Windows PE executable, not a misnamed blob:
    // MZ magic, e_lfanew pointing at a valid PE header, "PE\0\0" signature,
    // and a COFF machine in BOOTSTRAPPER_MACHINES. Squirrel's
    // electron-winstaller builds Setup.exe as a STANDARD i386 (0x14c)
    // bootstrapper even for an x64 target, so 0x14c is explicitly
    // required/allowed; an x64 (0x8664) bootstrapper is also accepted in case
    // a future electron-winstaller emits one, but any other machine is
    // rejected. The x64 evidence for this installer comes from the payload
    // exe inside the full.nupkg (audited below), not from Setup.exe's machine.
    const peCheck = await validateWindowsPE(setupExePath, BOOTSTRAPPER_MACHINES);
    if (peCheck.ok === false) {
      return { ...base, ok: false, error: peCheck.error };
    }
    // RELEASES must truthfully describe the full.nupkg next to it: the line
    // naming the package must carry its real SHA-1 and byte size, every line
    // must be exactly SHA1 FILENAME SIZE, and every referenced name must
    // correspond to a real artifact on disk.
    const releasesContent = await readFile(releasesPath, "utf8");
    const nupkgInfo = await stat(fullNupkgPath);
    const nupkgSha1 = await sha1File(fullNupkgPath);
    const releasesCheck = validateReleases(
      releasesContent,
      {
        name: fullNupkg,
        size: nupkgInfo.size,
        sha1: nupkgSha1
      },
      { existingNames: entries }
    );
    if (releasesCheck.ok === false) {
      return { ...base, ok: false, error: releasesCheck.error };
    }
    // The full.nupkg must contain exactly one packaged app.asar entry. Entry
    // names are normalized the way Windows would extract them (slashes, dot
    // segments, casefold) and every normalization collision is rejected, so a
    // variant spelling can never smuggle a second app.asar past the audit.
    const zipEntries = await readZipEntries(fullNupkgPath);
    const expectedAsarKey = normalizeZipEntryName(REQUIRED_NUPKG_ASAR_ENTRY);
    if (expectedAsarKey === null) {
      return {
        ...base,
        ok: false,
        error:
          `Internal invariant failed: "${REQUIRED_NUPKG_ASAR_ENTRY}" does not ` +
          "normalize to a valid Windows path."
      };
    }
    const seenKeys = new Map();
    let ambiguousEntry = undefined;
    for (const entry of zipEntries) {
      const key = normalizeZipEntryName(entry.fileName);
      if (key === null) {
        ambiguousEntry = {
          raw: entry.fileName,
          reason: "escapes the archive root"
        };
        break;
      }
      const prior = seenKeys.get(key);
      if (prior !== undefined) {
        ambiguousEntry = {
          raw: entry.fileName,
          reason: `collides with "${prior}" under Windows path normalization`
        };
        break;
      }
      seenKeys.set(key, entry.fileName);
    }
    if (ambiguousEntry !== undefined) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is invalid: the nupkg "${fullNupkgPath}" ` +
          `contains the entry "${ambiguousEntry.raw}" that ${ambiguousEntry.reason}; ` +
          "the archive is ambiguous and is rejected."
      };
    }
    const asarEntries = zipEntries.filter(
      (entry) => normalizeZipEntryName(entry.fileName) === expectedAsarKey
    );
    if (asarEntries.length === 0) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is incomplete: "${fullNupkgPath}" does not ` +
          `contain "${REQUIRED_NUPKG_ASAR_ENTRY}".`
      };
    }
    if (asarEntries.length > 1) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is invalid: "${fullNupkgPath}" contains ` +
          `${asarEntries.length} entries resolving to ` +
          `"${REQUIRED_NUPKG_ASAR_ENTRY}"; exactly one packaged app.asar is ` +
          "required."
      };
    }
    const asarEntry = asarEntries[0];
    if (asarEntry === undefined) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is incomplete: "${fullNupkgPath}" does not ` +
          `contain "${REQUIRED_NUPKG_ASAR_ENTRY}".`
      };
    }
    // The DECLARED uncompressed size must fit the cap before the entry is ever
    // streamed, so a hostile central directory cannot make the audit
    // decompress a pathological payload even when the stream check would catch
    // it afterwards. When an expected canonical size is available it must also
    // match the declared claim, so a lying central directory is rejected
    // before any bytes are decompressed.
    const declaredSizeCheck = checkNupkgAsarSizeLimit(
      asarEntry.uncompressedSize,
      expected?.maxNupkgEntrySizeBytes
    );
    if (declaredSizeCheck.ok === false) {
      return { ...base, ok: false, error: declaredSizeCheck.error };
    }
    if (
      typeof expected?.canonicalAsarSizeBytes === "number" &&
      Number.isFinite(expected.canonicalAsarSizeBytes) &&
      expected.canonicalAsarSizeBytes > 0 &&
      asarEntry.uncompressedSize !== expected.canonicalAsarSizeBytes
    ) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is invalid: "${fullNupkgPath}" declares the ` +
          `asar entry "${REQUIRED_NUPKG_ASAR_ENTRY}" as ` +
          `${asarEntry.uncompressedSize} bytes but the expected canonical asar ` +
          `is ${expected.canonicalAsarSizeBytes} bytes.`
      };
    }
    const nupkgEntry = await readZipEntrySha256(
      fullNupkgPath,
      asarEntry.fileName,
      expected?.maxNupkgEntrySizeBytes
    );
    if (!nupkgEntry.found) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is incomplete: "${fullNupkgPath}" does not ` +
          `contain "${REQUIRED_NUPKG_ASAR_ENTRY}".`
      };
    }
    // The decompressed stream must never exceed the cap even when the declared
    // size was plausible: this hard limit runs while the bytes stream out.
    if (nupkgEntry.sizeExceeded) {
      const maxBytes =
        expected?.maxNupkgEntrySizeBytes ?? MAX_NUPKG_ASAR_SIZE_BYTES;
      return {
        ...base,
        ok: false,
        error:
          `The app.asar inside "${fullNupkgPath}" exceeded the ${maxBytes}-byte ` +
          "upper limit while being streamed. This is not a plausible SWPanel " +
          "packaged app; the installer artifacts are rejected."
      };
    }
    // The decompressed bytes must carry the CRC-32 the central directory claims.
    if (nupkgEntry.crc32 !== asarEntry.crc32) {
      return {
        ...base,
        ok: false,
        error:
          `Installer audit failed: the asar inside "${fullNupkgPath}" has CRC-32 ` +
          `${nupkgEntry.crc32} but the archive entry declares ${asarEntry.crc32}. ` +
          "The nupkg is corrupt and is rejected."
      };
    }
    // A single packaged asar may never exceed the documented upper limit.
    const sizeLimitCheck = checkNupkgAsarSizeLimit(
      nupkgEntry.sizeBytes,
      expected?.maxNupkgEntrySizeBytes
    );
    if (sizeLimitCheck.ok === false) {
      return { ...base, ok: false, error: sizeLimitCheck.error };
    }
    const expectedSha = expected?.canonicalAsarSha256;
    const expectedSize = expected?.canonicalAsarSizeBytes;
    let canonicalSha;
    let canonicalSize;
    if (
      typeof expectedSha === "string" &&
      expectedSha.length > 0 &&
      typeof expectedSize === "number" &&
      Number.isFinite(expectedSize) &&
      expectedSize > 0
    ) {
      // The expected fingerprint from the fresh prepare audit is the
      // authoritative comparison target.
      canonicalSha = expectedSha;
      canonicalSize = expectedSize;
    } else {
      // Backward compatibility: re-fingerprint the canonical asar on the spot.
      const canonical = await fingerprintCanonicalAsar(canonicalAsarPath);
      if (canonical.ok === false) {
        return { ...base, ok: false, error: canonical.error };
      }
      canonicalSha = canonical.sha256;
      canonicalSize = canonical.sizeBytes;
    }
    const shaMatches = canonicalSha === nupkgEntry.sha256;
    const sizeMatches = canonicalSize === nupkgEntry.sizeBytes;
    const artifacts = {
      releases: releasesPath,
      setupExe: setupExePath,
      fullNupkg: fullNupkgPath
    };
    const nupkg = {
      entry: REQUIRED_NUPKG_ASAR_ENTRY,
      found: true,
      sha256: nupkgEntry.sha256,
      sizeBytes: nupkgEntry.sizeBytes,
      crc32: nupkgEntry.crc32
    };
    if (!shaMatches) {
      return {
        ...base,
        ok: false,
        error:
          `Installer audit failed: the asar inside "${fullNupkgPath}" ` +
          `(sha256 ${nupkgEntry.sha256}) does not match the canonical asar ` +
          `"${canonicalAsarPath}" (sha256 ${canonicalSha}).`,
        shaMatches: false,
        canonicalAsarPath,
        canonicalAsarSha256: canonicalSha,
        canonicalAsarSizeBytes: canonicalSize,
        artifacts,
        nupkg
      };
    }
    if (!sizeMatches) {
      return {
        ...base,
        ok: false,
        error:
          `Installer audit failed: the asar inside "${fullNupkgPath}" is ` +
          `${nupkgEntry.sizeBytes} bytes but the canonical asar ` +
          `"${canonicalAsarPath}" is ${canonicalSize} bytes.`,
        shaMatches: true,
        canonicalAsarPath,
        canonicalAsarSha256: canonicalSha,
        canonicalAsarSizeBytes: canonicalSize,
        artifacts,
        nupkg
      };
    }
    // --- x64 payload exe audit ---------------------------------------------
    // The full.nupkg must contain exactly one payload exe entry
    // (`lib/net45/<appName>.exe`, derived from the forge executableName/name,
    // the same identity that names Setup.exe). The payload exe is the x64
    // target evidence: Setup.exe is only a standard (i386 0x14c) Squirrel
    // bootstrapper, so the audit's x64 proof comes from the actual app
    // executable inside the package. It must be unique (Windows-path
    // normalized, so a case-variant duplicate collides on extraction and is
    // rejected), within the same declared AND streamed size caps, carry the
    // declared CRC-32, and be a real PE image whose COFF machine is x64.
    const expectedPayloadEntry = await deriveNupkgPayloadEntryName();
    const expectedPayloadKey = normalizeZipEntryName(expectedPayloadEntry);
    if (expectedPayloadKey === null) {
      return {
        ...base,
        ok: false,
        error:
          `Internal invariant failed: "${expectedPayloadEntry}" does not ` +
          "normalize to a valid Windows path."
      };
    }
    const payloadEntries = zipEntries.filter(
      (entry) => normalizeZipEntryName(entry.fileName) === expectedPayloadKey
    );
    if (payloadEntries.length === 0) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is incomplete: "${fullNupkgPath}" does not ` +
          `contain the x64 payload exe "${expectedPayloadEntry}".`
      };
    }
    if (payloadEntries.length > 1) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is invalid: "${fullNupkgPath}" contains ` +
          `${payloadEntries.length} entries resolving to ` +
          `"${expectedPayloadEntry}"; exactly one payload exe is required.`
      };
    }
    const payloadEntry = payloadEntries[0];
    if (payloadEntry === undefined) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is incomplete: "${fullNupkgPath}" does not ` +
          `contain the x64 payload exe "${expectedPayloadEntry}".`
      };
    }
    const payloadDeclaredSizeCheck = checkNupkgEntrySizeLimit(
      payloadEntry.uncompressedSize,
      expected?.maxNupkgEntrySizeBytes ?? MAX_NUPKG_ASAR_SIZE_BYTES,
      "payload exe"
    );
    if (payloadDeclaredSizeCheck.ok === false) {
      return { ...base, ok: false, error: payloadDeclaredSizeCheck.error };
    }
    const payloadStreamed = await readZipEntrySha256(
      fullNupkgPath,
      payloadEntry.fileName,
      expected?.maxNupkgEntrySizeBytes,
      { capturePrefixBytes: PE_PROBE_BYTES }
    );
    if (!payloadStreamed.found) {
      return {
        ...base,
        ok: false,
        error:
          `Squirrel maker output is incomplete: "${fullNupkgPath}" does not ` +
          `contain the x64 payload exe "${expectedPayloadEntry}".`
      };
    }
    if (payloadStreamed.sizeExceeded) {
      const maxBytes =
        expected?.maxNupkgEntrySizeBytes ?? MAX_NUPKG_ASAR_SIZE_BYTES;
      return {
        ...base,
        ok: false,
        error:
          `The payload exe inside "${fullNupkgPath}" exceeded the ` +
          `${maxBytes}-byte upper limit while being streamed. This is not a ` +
          "plausible SWPanel packaged app; the installer artifacts are rejected."
      };
    }
    if (payloadStreamed.crc32 !== payloadEntry.crc32) {
      return {
        ...base,
        ok: false,
        error:
          `Installer audit failed: the payload exe inside "${fullNupkgPath}" ` +
          `has CRC-32 ${payloadStreamed.crc32} but the archive entry declares ` +
          `${payloadEntry.crc32}. The nupkg is corrupt and is rejected.`
      };
    }
    const payloadSizeLimitCheck = checkNupkgEntrySizeLimit(
      payloadStreamed.sizeBytes,
      expected?.maxNupkgEntrySizeBytes ?? MAX_NUPKG_ASAR_SIZE_BYTES,
      "payload exe"
    );
    if (payloadSizeLimitCheck.ok === false) {
      return { ...base, ok: false, error: payloadSizeLimitCheck.error };
    }
    // The payload exe must be a REAL PE image whose COFF machine is x64
    // (0x8664) — the x64 target evidence. The captured prefix is validated
    // with parsePEHeader so no path is created on disk for a hostile entry.
    const payloadPe = parsePEHeader(
      payloadStreamed.prefix ?? Buffer.alloc(0),
      [MACHINE_X64]
    );
    if (payloadPe.ok === false) {
      return {
        ...base,
        ok: false,
        error:
          `Installer audit failed: the payload exe "${expectedPayloadEntry}" ` +
          `inside "${fullNupkgPath}" is not a valid x64 (0x8664) Windows PE ` +
          `executable: ${payloadPe.error}`
      };
    }
    const payload = {
      entry: expectedPayloadEntry,
      found: true,
      sha256: payloadStreamed.sha256,
      sizeBytes: payloadStreamed.sizeBytes,
      crc32: payloadStreamed.crc32,
      machine: payloadPe.machine
    };
    return {
      ...base,
      ok: true,
      canonicalAsarPath,
      canonicalAsarSha256: canonicalSha,
      canonicalAsarSizeBytes: canonicalSize,
      artifacts,
      nupkg,
      payload,
      shaMatches: true
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error:
        `Cannot audit installer output under "${squirrelDir}": ` +
        (error instanceof Error ? error.message : String(error))
    };
  }
}

/**
 * Full installer audit repeated against the freshly PUBLISHED canonical root
 * `installers` directory itself (the canonical dir IS the squirrel output, so it
 * is audited directly). `makeWinInstaller` re-runs this after the atomic
 * publish: ok:true is only ever reported when the canonical artifacts at their
 * canonical location pass the same full audit (exactly one MZ Setup.exe, a
 * truthful RELEASES, and a unique matching nupkg app.asar) that the per-run
 * output passed before publish. The report it produces therefore references
 * canonical paths exclusively.
 *
 * @param {string} installersDir the canonical `installers` directory
 * @param {string} canonicalAsarPath
 * @param {{
 *   canonicalAsarSha256?: string;
 *   canonicalAsarSizeBytes?: number;
 *   maxNupkgEntrySizeBytes?: number;
 * }} [expected] expected canonical fingerprint from the fresh prepare audit
 * @returns {Promise<InstallerAuditReport>}
 */
export async function auditCanonicalInstallers(
  installersDir,
  canonicalAsarPath,
  expected = {}
) {
  return auditSquirrelOutput(installersDir, canonicalAsarPath, expected);
}

/**
 * Verify the staged app.asar is byte-identical to the fingerprint the fresh
 * prepare audit established (SHA-256 + size). A mismatch means the staging copy
 * drifted from the audited canonical package, so make must abort before Forge
 * packages a wrong tree.
 *
 * @param {string} stagedAsarPath
 * @param {{ canonicalAsarSha256: string; sizeBytes: number }} expected
 * @returns {Promise<{ ok: true } | { ok: false; error: string }>}
 */
export async function verifyStagedAsar(stagedAsarPath, expected) {
  let info;
  try {
    info = await stat(stagedAsarPath);
  } catch {
    return {
      ok: false,
      error:
        `Cannot verify the staged asar: "${stagedAsarPath}" does not exist. ` +
        "make:win was aborted before Forge could package a drifted tree."
    };
  }
  let sha;
  try {
    sha = await sha256File(stagedAsarPath);
  } catch (error) {
    return {
      ok: false,
      error:
        `Cannot verify the staged asar "${stagedAsarPath}": ` +
        (error instanceof Error ? error.message : String(error))
    };
  }
  if (sha !== expected.canonicalAsarSha256 || info.size !== expected.sizeBytes) {
    return {
      ok: false,
      error:
        `Staged asar "${stagedAsarPath}" (sha256 ${sha}, ${info.size} bytes) ` +
        `does not match the expected canonical fingerprint (sha256 ` +
        `${expected.canonicalAsarSha256}, ${expected.sizeBytes} bytes).`
    };
  }
  return { ok: true };
}

/**
 * User-facing, actionable message for a locked installers directory.
 *
 * @param {string} outputPath
 * @param {{ code: string }} error
 * @returns {string}
 */
export function formatLockedInstallersError(outputPath, error) {
  return [
    `Cannot move installer output "${outputPath}" (${error.code}).`,
    "A running process is most likely holding the installer artifacts open.",
    "Transient locks were retried with bounded backoff before giving up.",
    "Close any viewer of installers/Setup.exe, then run make:win again.",
    "Installer publishing was aborted: no partial installers were published."
  ].join("\n");
}

/**
 * Move a previous canonical `installers` directory to a root-level
 * `installers-invalid-<stamp>` quarantine. makeWinInstaller calls this
 * immediately after acquiring the packaging lock, so a stale installer can
 * never be mistaken for current evidence: from that point on the canonical
 * `installers` must not exist until a fully verified run publishes its output.
 *
 * @param {string} root workspace root containing the `installers` directory
 * @returns {Promise<{ status: "absent" } | { status: "moved"; target: string }>}
 */
export async function quarantineExistingInstallers(root) {
  const canonical = path.join(root, "installers");
  let info;
  try {
    info = await stat(canonical);
  } catch {
    return { status: "absent" };
  }
  if (!info.isDirectory()) {
    throw new Error(
      `Refusing to quarantine "${canonical}": it is not a directory. ` +
        "Inspect it manually; installer publishing was aborted."
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(root, `${INSTALLERS_INVALID_PREFIX}${stamp}`);
  assertWithinRoot(root, target, "installers quarantine");
  try {
    await rename(canonical, target);
  } catch (error) {
    if (isWindowsFileLock(error)) {
      throw new Error(formatLockedInstallersError(canonical, error), {
        cause: error
      });
    }
    throw error;
  }
  return { status: "moved", target };
}

/**
 * Atomically publish a fully audited per-run squirrel output to the canonical
 * root `installers` directory. The canonical path must not exist (a previous
 * installers was quarantined right after the lock was taken); rename failures
 * are never swallowed. A Windows transient file lock is retried with bounded
 * backoff (reusing PUBLISH_RETRY_DELAYS from packaging.mjs); before every
 * attempt the canonical destination is re-verified as still absent and the
 * per-run source as still present. The per-run source must resolve strictly
 * inside `.scratch/installer-runs` and must not be a symlink/junction.
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
 * @returns {Promise<string>} the canonical installers path
 */
export async function publishInstallerOutput(runDir, root, options = {}) {
  const canonical = path.join(root, "installers");
  const source = path.join(
    runDir,
    "out",
    "make",
    "squirrel.windows",
    "x64"
  );
  const renameFn = options.rename ?? rename;
  const existsFn = options.exists ?? exists;
  const sleepFn = options.sleep ?? sleep;
  const maxRetries = options.maxRetries ?? PUBLISH_RETRY_DELAYS.length;
  const retryDelays = options.retryDelays ?? PUBLISH_RETRY_DELAYS;

  assertWithinRoot(root, canonical, "canonical installers");
  if (await existsFn(canonical)) {
    throw new Error(
      `Refusing to publish installers: canonical "${canonical}" already exists. ` +
        "It must not exist until a fully audited run publishes it. " +
        "Inspect the workspace manually; make:win was aborted."
    );
  }
  if (!(await existsFn(source))) {
    throw new Error(
      `Refusing to publish installers: maker output "${source}" does not exist. ` +
        "A successful make must produce the squirrel artifacts before publish " +
        "can rename them. Inspect the run directory manually; make:win was aborted."
    );
  }
  // The per-run publish source must resolve strictly inside the workspace's
  // installer-runs tree and must not be a symlink/junction, so a redirect can
  // never move something outside the workspace into the canonical installers.
  const runsRoot = installerRunsDir(root);
  await assertStrictWithin(runsRoot, runDir, "installer run directory");
  await assertStrictWithin(runsRoot, source, "installer publish source");

  for (let attempt = 0; ; attempt += 1) {
    // Re-verify before every attempt: the canonical destination must still be
    // absent and the per-run source must still be present, so a mid-publish
    // change fails loudly and can never cause an overwrite or a silent publish
    // of a disappeared source.
    if (await existsFn(canonical)) {
      throw new Error(
        `Refusing to publish installers: canonical "${canonical}" appeared ` +
          "while publishing. It must not exist until a fully audited run " +
          "publishes it. make:win was aborted; no overwrite was attempted."
      );
    }
    if (!(await existsFn(source))) {
      throw new Error(
        `Refusing to publish installers: maker output "${source}" disappeared ` +
          "while publishing. make:win was aborted; no rename was attempted."
      );
    }
    try {
      await renameFn(source, canonical);
      return canonical;
    } catch (error) {
      if (!isWindowsFileLock(error)) throw error;
      if (attempt >= maxRetries) {
        // Bounded transient-lock budget exhausted: a persistent lock is a
        // clear publish failure, never a silent success or an overwrite.
        throw new Error(formatLockedInstallersError(source, error), {
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
 * Move a freshly published canonical root `installers` directory back into the
 * per-run squirrel staging output it came from, restoring the exact pre-publish
 * state so the canonical `installers` is absent again. `makeWinInstaller` calls
 * this (while still holding the packaging lock) when the post-publish canonical
 * re-audit or the final report commit fails: a failed run must never leave the
 * new installers as current evidence. Both endpoints must resolve inside the
 * workspace; the rename is never silently retried because the published
 * artifacts are not held by a smoke process.
 *
 * @param {string} installersPath the canonical `installers` directory just published
 * @param {string} runDir the per-run directory the output originally came from
 * @param {string} root workspace root
 */
export async function rollbackPublishedInstallers(installersPath, runDir, root) {
  const runSquirrelDir = path.join(
    runDir,
    "out",
    "make",
    "squirrel.windows",
    "x64"
  );
  assertWithinRoot(root, installersPath, "canonical installers");
  assertWithinRoot(root, runSquirrelDir, "installer run squirrel output");
  await mkdir(path.dirname(runSquirrelDir), { recursive: true });
  await rename(installersPath, runSquirrelDir);
}

/**
 * Atomically write the installer audit report JSON (temp file + rename in the
 * same directory), creating `.scratch` when needed. The report is shared
 * across runs, so a half-written report must never be observable.
 *
 * @param {string} reportPath
 * @param {InstallerAuditReportWithMeta} report
 */
export async function writeAuditReport(reportPath, report) {
  const dir = path.dirname(reportPath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(reportPath)}.tmp-${randomUUID()}`
  );
  try {
    await writeFile(tempPath, JSON.stringify(report, null, 2), "utf8");
    await rename(tempPath, reportPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Overwrite the shared installer audit report with an ok:false run-specific
 * failure record, so a failed publish/finalize (or any aborted stage) can never
 * leave a stale success report behind. Every call site awaits this while still
 * holding the packaging lock, and a failure to write the failure report is never
 * swallowed: it propagates as the run failure because leaving a stale success
 * behind is worse than surfacing the write error.
 *
 * @param {string} reportPath
 * @param {{
 *   stage: string;
 *   error: string;
 *   uuid?: string;
 *   runDir?: string;
 *   makerOutputDir?: string;
 *   canonicalAudit?: AsarAuditReport;
 * }} fields
 */
async function writeFailureReport(reportPath, fields) {
  await writeAuditReport(reportPath, {
    ok: false,
    generatedAt: new Date().toISOString(),
    // The ok:false shape requires makerOutputDir; an aborted run has no maker
    // output, so it is recorded empty rather than fabricated. After a publish
    // failure the caller passes the canonical (or per-run) output it knows about.
    makerOutputDir: fields.makerOutputDir ?? "",
    error: fields.error,
    stage: fields.stage,
    ...(fields.uuid !== undefined ? { uuid: fields.uuid } : {}),
    ...(fields.runDir !== undefined ? { runDir: fields.runDir } : {}),
    ...(fields.canonicalAudit !== undefined
      ? { canonicalAudit: fields.canonicalAudit }
      : {})
  });
}

/**
 * Prepare the canonical package for installering WITHOUT re-packaging it.
 * make:win never runs package:win again and never quarantines the canonical
 * `out`: the current canonical `out/SWPanel-win32-x64/resources/app.asar` is
 * audited fresh (reportAsarAudit, which also rewrites the shared
 * `.scratch/asar-audit-report.json` as the pre-evidence fingerprint) and then
 * smoke-launched, so a stale or broken package aborts before any make step.
 *
 * @param {string} root
 * @returns {Promise<PrepareCanonicalPackageSuccess | PrepareCanonicalPackageFailure>}
 */
export async function prepareCanonicalPackage(root) {
  const asarPath = path.join(
    root,
    "out",
    "SWPanel-win32-x64",
    "resources",
    "app.asar"
  );
  let auditReport;
  try {
    auditReport = await reportAsarAudit(asarPath);
  } catch (error) {
    return {
      ok: false,
      stage: "audit",
      asarPath,
      error:
        `Cannot prepare the canonical package: fresh ASAR audit failed for ` +
        `"${asarPath}". make:win installs only a currently-verified package ` +
        `and never re-packages or quarantines the canonical out: ` +
        (error instanceof Error ? error.message : String(error)),
      auditReport: null
    };
  }
  if (auditReport.ok !== true) {
    return {
      ok: false,
      stage: "audit",
      asarPath,
      error:
        `Fresh ASAR audit FAILED for "${asarPath}". make:win installs only a ` +
        "currently-verified package and never re-packages or quarantines the " +
        "canonical out. Run package:win to produce a fresh package.",
      auditReport
    };
  }
  try {
    await defaultSmoke(asarPath);
  } catch (smokeError) {
    return {
      ok: false,
      stage: "smoke",
      asarPath,
      error:
        `Fresh smoke of the canonical package FAILED for "${asarPath}". ` +
        "make:win installs only a package that boots; it never re-packages or " +
        "quarantines the canonical out. Run package:win to produce a fresh " +
        "package." +
        (smokeError instanceof Error ? ` ${smokeError.message}` : ""),
      auditReport
    };
  }
  return {
    ok: true,
    asarPath,
    outPath: path.join(root, "out"),
    sizeBytes: auditReport.asarSizeBytes,
    canonicalAsarSha256: auditReport.asarSha256,
    auditReport
  };
}

/**
 * Full installer chain: acquire the same cross-process packaging lock package:win
 * uses, quarantine a previous canonical `installers` immediately, prepare the
 * CURRENT canonical package (fresh audit + smoke of
 * `out/SWPanel-win32-x64/resources/app.asar`, never a re-package and never a
 * quarantine of the canonical `out`) -> stage it into a per-run staging out
 * (verifying the staged asar matches the prepared expected fingerprint) ->
 * Forge `make --skip-package` for squirrel -> audit
 * Setup.exe/RELEASES/full.nupkg (including the SHA-256 + size of the asar
 * streamed from the nupkg vs the expected canonical fingerprint) -> atomic
 * publish of the maker output to root `installers` -> RE-AUDIT the published
 * canonical `installers` directory itself (auditCanonicalInstallers) -> commit
 * the final ok:true report whose paths all reference the canonical installers.
 * Because the previous `installers` was quarantined right after the lock was
 * taken, ANY failure up to the publish leaves the canonical `installers` absent.
 * A failure of the canonical re-audit or the final report commit rolls the just-
 * published installers back into the per-run output (canonical absent again)
 * and rewrites the report ok:false. Every failure report write is awaited inside
 * the lock and is never swallowed: a report that cannot be rewritten ok:false is
 * itself the run failure, because a stale success report is never acceptable.
 *
 * The lock is held from before prepare until the final report write completes,
 * so make:win and package:win can never mutate the canonical `out`/`installers`
 * concurrently.
 *
 * All heavy steps are injectable so tests can exercise every failure stage
 * without running the fresh audit/smoke/Forge/yauzl against real artifacts.
 *
 * @param {{
 *   root?: string;
 *   lockDir?: string;
 *   prepareCanonicalPackage?: (root: string) =>
 *     Promise<PrepareCanonicalPackageSuccess | PrepareCanonicalPackageFailure>;
 *   createInstallerRun?: (root: string) =>
 *     Promise<{ runDir: string; stagingOut: string; uuid: string }>;
 *   stageCanonicalPackage?: (root: string, runDir: string, outPath: string) =>
 *     string | Promise<string>;
 *   runMake?: (root: string, stagingOut: string) => number | Promise<number>;
 *   auditMakerOutput?: (stagingOut: string, canonicalAsarPath: string,
 *     expectedFingerprint?: { canonicalAsarSha256: string; canonicalAsarSizeBytes: number }) =>
 *     InstallerAuditReport | Promise<InstallerAuditReport>;
 *   auditCanonicalInstallers?: (installersDir: string, canonicalAsarPath: string,
 *     expectedFingerprint?: { canonicalAsarSha256: string; canonicalAsarSizeBytes: number }) =>
 *     InstallerAuditReport | Promise<InstallerAuditReport>;
 *   quarantineExistingInstallers?: (root: string) =>
 *     Promise<{ status: "absent" } | { status: "moved"; target: string }>;
 *   publishInstallerOutput?: (runDir: string, root: string) =>
 *     string | Promise<string>;
 *   rollbackPublishedInstallers?: (installersPath: string, runDir: string,
 *     root: string) => unknown | Promise<unknown>;
 *   writeAuditReport?: (reportPath: string, report: InstallerAuditReportWithMeta) =>
 *     unknown | Promise<unknown>;
 *   reportPath?: string;
 * }} [options]
 * @returns {Promise<
 *   | { ok: false; stage: "prepare" | "stage" | "make" | "audit" | "publish" | "setup"; prepareStage?: string; asarPath?: string; exitCode?: number; runDir?: string; error?: string; reportPath: string }
 *   | { ok: true; installersPath: string; makerOutputDir: string; canonicalAsarSha256: string; reportPath: string; uuid: string; runDir: string }
 * >}
 */
export async function makeWinInstaller(options = {}) {
  const root = options.root ?? workspaceRoot;
  // Same cross-process packaging lock package:win uses, so a package:win and a
  // make:win can never run concurrently against the canonical out/installers.
  const lockDir =
    options.lockDir ?? path.join(root, ".scratch", "package-lock");
  const runPrepare = options.prepareCanonicalPackage ?? prepareCanonicalPackage;
  const createRun = options.createInstallerRun ?? createInstallerRun;
  const runStage = options.stageCanonicalPackage ?? stageCanonicalPackage;
  const runMake = options.runMake ?? defaultMake;
  const runAudit = options.auditMakerOutput ?? auditMakerOutput;
  const runCanonicalAudit =
    options.auditCanonicalInstallers ?? auditCanonicalInstallers;
  const quarantine = options.quarantineExistingInstallers ??
    quarantineExistingInstallers;
  const publish = options.publishInstallerOutput ?? publishInstallerOutput;
  const rollback = options.rollbackPublishedInstallers ??
    rollbackPublishedInstallers;
  const writeReport = options.writeAuditReport ?? writeAuditReport;
  const reportPath =
    options.reportPath ?? path.join(root, ".scratch", "installer-audit-report.json");

  // A busy or unverifiable lock is a hard failure that must reach the caller
  // without touching the shared report (another run may be mid-write).
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

  let runDir;
  let uuid;
  try {
    // Immediately after the lock is held the previous canonical installers are
    // quarantined, so a stale installer can never be mistaken for current
    // evidence no matter which later step fails.
    const quarantineResult = await quarantine(root);
    if (quarantineResult.status === "moved") {
      console.log(
        `Quarantined previous installers at ${quarantineResult.target}; ` +
          "installers will be re-published only after the run fully succeeds."
      );
    }

    const run = await createRun(root);
    runDir = run.runDir;
    uuid = run.uuid;

    const preparedResult = await runPrepare(root);
    if (preparedResult.ok === false) {
      await writeFailureReport(reportPath, {
        stage: "prepare",
        uuid,
        runDir,
        error: preparedResult.error
      });
      return {
        ok: false,
        stage: "prepare",
        prepareStage: preparedResult.stage,
        asarPath: preparedResult.asarPath,
        runDir,
        error: preparedResult.error,
        reportPath
      };
    }

    // Stage the audited canonical package and verify the staged app.asar is
    // byte-identical (SHA-256 + size) to the fingerprint prepare just
    // established, so Forge can never package a drifted tree.
    const staged = await runStage(root, runDir, preparedResult.outPath);
    const stagedCheck = await verifyStagedAsar(
      path.join(staged, "resources", "app.asar"),
      {
        canonicalAsarSha256: preparedResult.canonicalAsarSha256,
        sizeBytes: preparedResult.sizeBytes
      }
    );
    if (stagedCheck.ok === false) {
      await writeFailureReport(reportPath, {
        stage: "stage",
        uuid,
        runDir,
        error: stagedCheck.error
      });
      return {
        ok: false,
        stage: "stage",
        asarPath: preparedResult.asarPath,
        runDir,
        error: stagedCheck.error,
        reportPath
      };
    }

    const makeCode = await runMake(root, run.stagingOut);
    if (makeCode !== 0) {
      await writeFailureReport(reportPath, {
        stage: "make",
        uuid,
        runDir,
        error: `Forge make exited with code ${makeCode}.`
      });
      return {
        ok: false,
        stage: "make",
        exitCode: makeCode,
        runDir,
        reportPath
      };
    }

    const auditResult = await runAudit(
      run.stagingOut,
      preparedResult.asarPath,
      {
        canonicalAsarSha256: preparedResult.canonicalAsarSha256,
        canonicalAsarSizeBytes: preparedResult.sizeBytes
      }
    );
    // Pre-publish report: run-specific evidence only, never canonical published
    // paths. When the audit itself fails this is also the ok:false record.
    await writeReport(reportPath, {
      ...auditResult,
      canonicalAudit: preparedResult.auditReport,
      uuid,
      runDir
    });
    if (auditResult.ok !== true) {
      return {
        ok: false,
        stage: "audit",
        runDir,
        error: auditResult.error,
        reportPath
      };
    }

    let installersPath;
    try {
      installersPath = await publish(runDir, root);
    } catch (error) {
      // Publish/rename failures are never swallowed: the canonical installers
      // must not exist, and the shared report must not keep a stale success.
      const publishError =
        error instanceof Error ? error.message : String(error);
      await writeFailureReport(reportPath, {
        stage: "publish",
        uuid,
        runDir,
        // The publish failed, so the run still has no maker output at a
        // canonical location; the per-run maker output path is recorded.
        makerOutputDir: path.join(
          runDir,
          "out",
          "make",
          "squirrel.windows",
          "x64"
        ),
        error: publishError,
        canonicalAudit: preparedResult.auditReport
      });
      return {
        ok: false,
        stage: "publish",
        runDir,
        error: publishError,
        reportPath
      };
    }
    let finalError;
    let canonicalAuditResult;
    try {
      // The installers are canonical now. Only an ok:true report whose paths
      // point at the canonical installers may be returned; first the published
      // canonical directory is re-audited with the same full audit.
      canonicalAuditResult = await runCanonicalAudit(
        installersPath,
        preparedResult.asarPath,
        {
          canonicalAsarSha256: preparedResult.canonicalAsarSha256,
          canonicalAsarSizeBytes: preparedResult.sizeBytes
        }
      );
      if (canonicalAuditResult.ok !== true) {
        throw new Error(
          `Installers published to ${installersPath} but the canonical ` +
            `re-audit FAILED: ${canonicalAuditResult.error}`
        );
      }
      try {
        // Final canonical report: the audit result is rewritten so every path
        // points at the canonical installers location.
        await writeReport(reportPath, {
          ...canonicalAuditResult,
          canonicalAudit: preparedResult.auditReport,
          uuid,
          runDir,
          publishedPath: installersPath,
          publishedAt: new Date().toISOString()
        });
      } catch (error) {
        throw new Error(
          `Installers published to ${installersPath} but the installer audit ` +
            `report could not be finalized: ` +
            (error instanceof Error ? error.message : String(error)),
          { cause: error }
        );
      }
    } catch (error) {
      // The canonical re-audit or the final report commit failed. Roll the
      // just-published installers back into the per-run output so the canonical
      // `installers` is absent again, then rewrite the report ok:false. The
      // rollback runs before the failure report, so the failure record can
      // truthfully assert no canonical installers remain.
      finalError =
        error instanceof Error ? error.message : String(error);
      try {
        await rollback(installersPath, runDir, root);
      } catch (rollbackError) {
        const rollbackMessage =
          `Installers published to ${installersPath} and the rollback after ` +
          `"${finalError}" FAILED: ` +
          (rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)) +
          ". The canonical installers may still exist; inspect them manually.";
        finalError = rollbackMessage;
      }
      await writeFailureReport(reportPath, {
        stage: "publish",
        uuid,
        runDir,
        makerOutputDir: installersPath,
        error: finalError,
        canonicalAudit: preparedResult.auditReport
      });
      return {
        ok: false,
        stage: "publish",
        runDir,
        error: finalError,
        reportPath
      };
    }
    console.log(`Published verified installers to ${installersPath}.`);
    return {
      ok: true,
      installersPath,
      makerOutputDir: installersPath,
      canonicalAsarSha256: canonicalAuditResult.canonicalAsarSha256,
      reportPath,
      uuid,
      runDir
    };
  } catch (error) {
    await writeFailureReport(reportPath, {
      stage: "setup",
      ...(uuid !== undefined ? { uuid } : {}),
      ...(runDir !== undefined ? { runDir } : {}),
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      ok: false,
      stage: "setup",
      reportPath,
      ...(runDir !== undefined ? { runDir } : {}),
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    // The lock is held from before prepare through the final report write;
    // release it only after the whole chain (success or failure) completed.
    await releasePackageLock(lock, lockDir).catch(() => undefined);
  }
}
