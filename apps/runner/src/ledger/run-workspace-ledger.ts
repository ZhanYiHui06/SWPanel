import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

import {
  InvalidArgumentError,
  LedgerCopyFailedError,
  LedgerEscapeDetectedError,
  LedgerError,
  LedgerFileMissingError,
  LedgerPathUnsafeError,
  RunnerError
} from "../errors.js";
import { SAFE_PATH_TOKEN, assertSafeIdToken } from "../ids.js";

/** Directory layout the Run workspace contributes below the workspace root. */
export const RUN_WORKSPACE_RELATIVE_DIR = "runs" as const;

/** The six isolated directories of one execution attempt. */
export const RUN_WORKSPACE_SUBDIRS = [
  "input",
  "memory",
  "working",
  "output",
  "logs",
  "runtime"
] as const;
export type RunWorkspaceSubdir = (typeof RUN_WORKSPACE_SUBDIRS)[number];

export interface RunWorkspaceOptions {
  /** Absolute canonical root of the whole workspace tree (must be a real dir). */
  workspaceRoot: string;
}

export interface RunWorkspaceLayout {
  runId: string;
  attemptSequence: number;
  /** `attempt-NNN` directory label, zero-padded to three digits. */
  attemptLabel: string;
  /** `runs/{runId}/attempt-NNN` (forward slashes, the persisted form). */
  relativeRoot: string;
  absoluteRoot: string;
  directories: Readonly<
    Record<RunWorkspaceSubdir, { relativePath: string; absolutePath: string }>
  >;
}

export interface StoredRunFile {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Isolated Run workspace ledger (Phase 3, P3-1). One attempt owns the subtree
 *
 *   runs/{runId}/attempt-{NNN}/{input,memory,working,output,logs,runtime}
 *
 * below a dedicated workspace root. The ledger reuses the immutable-drawing
 * ledger's defense patterns: generated-id safe path tokens, canonical
 * containment, absolute/traversal/drive rejection, component-level
 * symlink/junction refusal and conservative allowlist deletion. Every write and
 * every deletion is scoped to exactly one attempt subtree, so cleanup can never
 * touch another Run's files.
 */
export class RunWorkspaceLedger {
  private readonly workspaceRoot: string;
  private isOpened = false;

  constructor(options: RunWorkspaceOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
  }

  /**
   * Opens the ledger. The workspace root is created when missing; a root that
   * is a symlink/junction or not a directory is refused.
   */
  open(): void {
    let stats: Stats;
    try {
      stats = lstatSync(this.workspaceRoot);
    } catch {
      try {
        mkdirSync(this.workspaceRoot, { recursive: true });
      } catch (error) {
        throw new RunnerError({
          code: "LEDGER_IO",
          message: `Failed to create the run workspace root: ${this.workspaceRoot}`,
          details: { workspaceRoot: this.workspaceRoot },
          cause: error
        });
      }
      stats = lstatSync(this.workspaceRoot);
    }
    if (stats.isSymbolicLink()) {
      throw new LedgerEscapeDetectedError(
        `Run workspace root must not be a symbolic link or junction: ${this.workspaceRoot}`,
        { workspaceRoot: this.workspaceRoot }
      );
    }
    if (!stats.isDirectory()) {
      throw new RunnerError({
        code: "LEDGER_IO",
        message: `Run workspace root is not a directory: ${this.workspaceRoot}`,
        details: { workspaceRoot: this.workspaceRoot }
      });
    }
    this.isOpened = true;
  }

  close(): void {
    this.isOpened = false;
  }

  get isOpen(): boolean {
    return this.isOpened;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** `attempt-NNN` label of an attempt sequence. */
  static attemptLabel(attemptSequence: number): string {
    if (!Number.isSafeInteger(attemptSequence) || attemptSequence < 1) {
      throw new InvalidArgumentError(
        `attemptSequence must be a positive integer, got ${attemptSequence}`
      );
    }
    return `attempt-${String(attemptSequence).padStart(3, "0")}`;
  }

  /**
   * Pure layout computation of one attempt's workspace subtree. Validates the
   * run id and attempt sequence but touches neither the database nor the disk.
   */
  workspaceLayout(runId: string, attemptSequence: number): RunWorkspaceLayout {
    const attemptLabel = this.assertAttemptIdentity(runId, attemptSequence);
    const relativeRoot = [RUN_WORKSPACE_RELATIVE_DIR, runId, attemptLabel].join("/");
    const absoluteRoot = this.toAbsolute(relativeRoot);
    const directories = Object.fromEntries(
      RUN_WORKSPACE_SUBDIRS.map((subdir) => {
        const relativePath = `${relativeRoot}/${subdir}`;
        return [subdir, { relativePath, absolutePath: this.toAbsolute(relativePath) }];
      })
    ) as RunWorkspaceLayout["directories"];
    return {
      runId,
      attemptSequence,
      attemptLabel,
      relativeRoot,
      absoluteRoot,
      directories
    };
  }

  /**
   * Creates the six isolated directories of one attempt. Every existing path
   * component is re-checked for symlink/junction escapes before creation.
   */
  createAttemptWorkspace(runId: string, attemptSequence: number): RunWorkspaceLayout {
    this.assertOpen();
    const layout = this.workspaceLayout(runId, attemptSequence);
    this.assertNoLinkComponent(layout.relativeRoot, layout.absoluteRoot, "attempt workspace");
    for (const entry of Object.values(layout.directories)) {
      try {
        mkdirSync(entry.absolutePath, { recursive: true });
      } catch (error) {
        throw new LedgerCopyFailedError(`Failed to create run workspace directory ${entry.absolutePath}`, {
          relativePath: entry.relativePath,
          cause: error
        });
      }
    }
    return layout;
  }

  /**
   * Writes Runner-owned bytes under one attempt subtree. `relativePath` must be
   * a relative, traversal-free path of safe tokens; the final path always stays
   * inside `runs/{runId}/attempt-NNN/`, is checked component-by-component for
   * symlink/junction escapes and the stored bytes are hashed for verification.
   */
  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): StoredRunFile {
    this.assertOpen();
    const layout = this.workspaceLayout(input.runId, input.attemptSequence);
    this.assertRelativePathSafe(input.relativePath, "owned file path");
    const relativePath = `${layout.relativeRoot}/${input.relativePath}`;
    const absolutePath = this.toAbsolute(relativePath);
    this.assertNoLinkComponent(relativePath, absolutePath, "owned file target");
    try {
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, input.content);
    } catch (error) {
      throw new LedgerCopyFailedError(`Failed to write run workspace file ${absolutePath}`, {
        relativePath,
        cause: error
      });
    }
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    return {
      relativePath,
      absolutePath,
      sha256,
      sizeBytes: input.content.byteLength
    };
  }

  /**
   * Reads one Runner-owned file inside one attempt subtree with the same
   * guards as `writeOwnedFile`: the path must be a relative, traversal-free
   * path of safe tokens, every component is checked for symlink/junction
   * escapes, and the final target must not itself be a link. Returns the read
   * bytes plus the stored verification record (sha256/size of the actual
   * bytes), or null when the file does not exist. Phase 4 (P4-5) uses this as
   * the independent workspace read surface of the Artifact validator — the
   * Agent's manifest paths are never trusted before this reader accepts them.
   */
  readOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): (StoredRunFile & { content: Buffer }) | null {
    this.assertOpen();
    const layout = this.workspaceLayout(input.runId, input.attemptSequence);
    this.assertRelativePathSafe(input.relativePath, "owned file path");
    const relativePath = `${layout.relativeRoot}/${input.relativePath}`;
    const absolutePath = this.toAbsolute(relativePath);
    this.assertNoLinkComponent(relativePath, absolutePath, "owned file target");
    if (RunWorkspaceLedger.isSymlink(absolutePath)) {
      throw new LedgerEscapeDetectedError(
        `Refusing to read a symbolic link: ${absolutePath}`,
        { relativePath }
      );
    }
    if (!existsSync(absolutePath)) return null;
    let content: Buffer;
    try {
      content = readFileSync(absolutePath);
    } catch (error) {
      throw new LedgerError({
        code: "LEDGER_IO",
        message: `Failed to read run workspace file ${absolutePath}`,
        details: { relativePath },
        cause: error
      });
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    return {
      relativePath,
      absolutePath,
      sha256,
      sizeBytes: content.byteLength,
      content
    };
  }

  /**
   * Conservative single-file deletion inside one attempt subtree. Refuses any
   * path outside `runs/{runId}/attempt-NNN/`, any symlink/junction component
   * and any missing target (callers use "already gone" semantics at the
   * service layer like the drawing ledger).
   */
  deleteOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): void {
    this.assertOpen();
    const layout = this.workspaceLayout(input.runId, input.attemptSequence);
    this.assertRelativePathSafe(input.relativePath, "owned file path");
    const relativePath = `${layout.relativeRoot}/${input.relativePath}`;
    const absolutePath = this.toAbsolute(relativePath);
    this.assertCanonicalContainment(absolutePath, `deletion target ${relativePath}`);
    this.assertNoLinkComponent(relativePath, absolutePath, "deletion target");
    if (RunWorkspaceLedger.isSymlink(absolutePath)) {
      throw new LedgerEscapeDetectedError(`Refusing to delete a symbolic link: ${absolutePath}`, {
        relativePath
      });
    }
    if (!existsSync(absolutePath)) {
      throw new LedgerFileMissingError(`Deletion target does not exist: ${absolutePath}`, {
        relativePath
      });
    }
    try {
      rmSync(absolutePath, { force: true });
    } catch (error) {
      throw new LedgerError({
        code: "LEDGER_IO",
        message: `Failed to delete run workspace file ${absolutePath}`,
        details: { relativePath },
        cause: error
      });
    }
    this.pruneEmptyParents(relativePath);
  }

  /**
   * Conservative attempt cleanup: removes exactly
   * `runs/{runId}/attempt-NNN` plus the empty parent chain it leaves behind.
   * The run id and attempt sequence are validated tokens, so a wrong run id
   * can never reach another Run's subtree; a missing attempt directory is
   * "already gone" (the cleanup intent is satisfied). Never touches the
   * workspace root or any other run.
   */
  deleteAttemptWorkspace(runId: string, attemptSequence: number): void {
    this.assertOpen();
    const layout = this.workspaceLayout(runId, attemptSequence);
    this.assertNoLinkComponent(layout.relativeRoot, layout.absoluteRoot, "attempt cleanup");
    if (RunWorkspaceLedger.isSymlink(layout.absoluteRoot)) {
      throw new LedgerEscapeDetectedError(
        `Refusing to delete a symbolic link or junction: ${layout.absoluteRoot}`,
        { relativePath: layout.relativeRoot }
      );
    }
    if (!existsSync(layout.absoluteRoot)) {
      return; // already gone
    }
    try {
      rmSync(layout.absoluteRoot, { recursive: true, force: true });
    } catch (error) {
      throw new LedgerError({
        code: "LEDGER_IO",
        message: `Failed to delete run attempt workspace ${layout.absoluteRoot}`,
        details: { relativePath: layout.relativeRoot },
        cause: error
      });
    }
    // Prune the now-empty `runs/{runId}` and `runs` parents; `rmdirSync` only
    // removes empty directories, and every candidate stays inside the
    // workspace root.
    const split = layout.relativeRoot.split("/");
    for (let depth = split.length - 1; depth >= 1; depth--) {
      const parentAbs = resolve(this.workspaceRoot, ...split.slice(0, depth));
      try {
        rmdirSync(parentAbs);
      } catch {
        break; // non-empty or missing: stop pruning
      }
    }
  }

  // -------------------------------------------------------------------------
  // Containment and escape checks
  // -------------------------------------------------------------------------

  /**
   * Canonical containment: the resolved target must be lexically inside the
   * canonical workspace root (second guard line; component-level link checks
   * are the primary escape defense on Windows).
   */
  private assertCanonicalContainment(target: string, label: string): void {
    const canonicalRoot = normalize(this.workspaceRoot);
    const canonicalTarget = normalize(resolve(target));
    const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    const outside = canonicalTarget === canonicalRoot || !canonicalTarget.startsWith(rootPrefix);
    if (outside) {
      throw new LedgerEscapeDetectedError(`${label} resolves outside the run workspace root`, {
        target,
        workspaceRoot: this.workspaceRoot
      });
    }
  }

  /** Rejects traversal, drive/UNC, absolute and NUL tricks in a relative path. */
  private assertRelativePathSafe(relativePath: string, label: string): void {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new LedgerPathUnsafeError(`${label} must be a non-empty string`);
    }
    if (isAbsolute(relativePath)) {
      throw new LedgerPathUnsafeError(`${label} must not be absolute: ${relativePath}`, {
        relativePath
      });
    }
    const split = relativePath.split(/[\\/]/);
    if (split.some((part) => part === ".." || part === "." || part === "")) {
      throw new LedgerPathUnsafeError(
        `${label} must not contain traversal segments: ${relativePath}`,
        { relativePath }
      );
    }
    if (/^[A-Za-z]:/.test(relativePath)) {
      throw new LedgerPathUnsafeError(`${label} must not contain a drive prefix: ${relativePath}`, {
        relativePath
      });
    }
    if (relativePath.includes("\0")) {
      throw new LedgerPathUnsafeError(`${label} must not contain NUL bytes`);
    }
    // POSIX guard: `C:\...` must not be treated as a relative subdirectory name.
    if (sep === "/" && /^[A-Za-z]:[\\/]/.test(relativePath)) {
      throw new LedgerPathUnsafeError(
        `${label} looks like a Windows absolute path: ${relativePath}`,
        { relativePath }
      );
    }
  }

  /** True when the path exists and is a symbolic link or junction. */
  private static isSymlink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * Rejects unsafe symlink/junction components. Every component is checked,
   * including the final one, so a tampered directory cannot redirect a write
   * or a recursive deletion outside the workspace root.
   */
  private assertNoLinkComponent(relativePath: string, _absolutePath: string, label: string): void {
    const split = relativePath.split(/[\\/]/);
    for (let i = 0; i < split.length; i++) {
      const component = split[i];
      if (component === undefined) continue;
      if (!SAFE_PATH_TOKEN.test(component)) {
        throw new LedgerPathUnsafeError(
          `${label} contains an unsafe path segment: ${component}`,
          { relativePath }
        );
      }
      const candidate = resolve(this.workspaceRoot, ...split.slice(0, i + 1));
      if (RunWorkspaceLedger.isSymlink(candidate)) {
        throw new LedgerEscapeDetectedError(
          `${label} traverses a symbolic link or junction: ${candidate}`,
          { relativePath }
        );
      }
    }
  }

  private toAbsolute(relativePath: string): string {
    this.assertRelativePathSafe(relativePath, "workspace path");
    return resolve(this.workspaceRoot, ...relativePath.split(/[\\/]/));
  }

  /**
   * Prunes the empty directory chain of a deleted file, stopping at the
   * attempt directory itself (a single-file delete never removes the attempt
   * root — only the explicit attempt cleanup does).
   */
  private pruneEmptyParents(relativePath: string): void {
    const split = relativePath.split(/[\\/]/);
    // runs/{runId}/attempt-NNN = 3 components; never prune below that depth.
    const attemptDirDepth = 3;
    for (let depth = split.length - 1; depth > attemptDirDepth; depth--) {
      const parentAbs = resolve(this.workspaceRoot, ...split.slice(0, depth));
      try {
        rmdirSync(parentAbs);
      } catch {
        break; // non-empty directory: stop pruning
      }
    }
  }

  /** Validates the run id token and the attempt sequence, returning the label. */
  private assertAttemptIdentity(runId: string, attemptSequence: number): string {
    assertSafeIdToken("runId", runId);
    return RunWorkspaceLedger.attemptLabel(attemptSequence);
  }

  private assertOpen(): void {
    if (!this.isOpened) {
      throw new RunnerError({
        code: "LEDGER_NOT_OPEN",
        message: "The run workspace ledger is not open",
        details: { workspaceRoot: this.workspaceRoot }
      });
    }
  }
}
