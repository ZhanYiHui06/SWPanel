import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import { DRAWING_FILE_FORMATS, type DrawingFileFormat, type RevisionSourceFile } from "@swpanel/domain";

import {
  InvalidArgumentError,
  LedgerCopyFailedError,
  LedgerEscapeDetectedError,
  LedgerError,
  LedgerFileMissingError,
  LedgerHashMismatchError,
  LedgerPathUnsafeError,
  LedgerSizeMismatchError,
  RunnerError
} from "../errors.js";
import { SAFE_PATH_TOKEN, generateId } from "../ids.js";

/** Directory layout of the immutable drawing library. */
export const DRAWING_LIBRARY_RELATIVE_DIR = "library/drawings" as const;
/** Source directory inside a Revision directory. */
export const REVISION_SOURCE_DIR_NAME = "source" as const;
/** Immutable media type lookup for the allowlisted formats. */
export const DRAWING_MIME_TYPES: Readonly<Record<DrawingFileFormat, string>> = {
  PDF: "application/pdf",
  DWG: "application/acad",
  DXF: "application/dxf"
};

const ACCEPTED_EXTENSIONS: Readonly<Record<DrawingFileFormat, string>> = {
  PDF: ".pdf",
  DWG: ".dwg",
  DXF: ".dxf"
};

export interface LedgerOptions {
  /** Absolute canonical root of the whole data root (must already exist). */
  dataRoot: string;
}

/** Result of a successful immutable store operation. */
export interface StoredDrawingFile {
  fileId: string;
  relativePath: string;
  absolutePath: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Immutable source-file ledger for original Drawing files (WP2). Files are
 * copied byte-for-byte into generated-id directories below a configurable data
 * root, hashed and verified, and recorded only as relative paths. The ledger
 * never deletes or overwrites a stored file.
 */
export class DrawingFileLedger {
  private readonly dataRoot: string;
  private isOpened = false;

  constructor(options: LedgerOptions) {
    this.dataRoot = resolve(options.dataRoot);
  }

  /** Checks the data root exists and is a directory; opens the ledger. */
  open(): void {
    let stats: Stats;
    try {
      stats = lstatSync(this.dataRoot);
    } catch {
      throw new RunnerError({
        code: "LEDGER_IO",
        message: `Ledger data root does not exist: ${this.dataRoot}`,
        details: { dataRoot: this.dataRoot }
      });
    }
    if (stats.isSymbolicLink()) {
      throw new LedgerEscapeDetectedError(
        `Ledger data root must not be a symbolic link or junction: ${this.dataRoot}`,
        { dataRoot: this.dataRoot }
      );
    }
    if (!stats.isDirectory()) {
      throw new RunnerError({
        code: "LEDGER_IO",
        message: `Ledger data root is not a directory: ${this.dataRoot}`,
        details: { dataRoot: this.dataRoot }
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

  /** Relative path the library root contributes to the layout. */
  static readonly libraryRelativeDir = DRAWING_LIBRARY_RELATIVE_DIR;

  // -------------------------------------------------------------------------
  // Public storage surface
  // -------------------------------------------------------------------------

  /**
   * Immutably stores a source file. The file is copied into a fresh
   * generated-id directory (`library/drawings/{fileId}/source/original.{ext}`),
   * verified by size and SHA-256, and its relative path returned. Callers then
   * persist the metadata through the repository inside the same transaction.
   *
   * When `sizeBytes`/`sha256` are omitted they are computed from the source
   * bytes; when provided they must match the actual bytes exactly.
   */
  storeSourceFile(input: {
    fileName: string;
    format: DrawingFileFormat;
    sizeBytes?: number;
    sha256?: string;
    mimeType?: string;
    uploadedAt: string;
    sourcePath: string;
  }): StoredDrawingFile {
    this.assertOpen();
    const file = this.validateInput(input);
    const fileId = generateId();
    // Relative paths are persisted and compared with forward slashes so they
    // stay stable across platforms (Windows join uses backslashes).
    const relativeDir = join(DRAWING_LIBRARY_RELATIVE_DIR, fileId, REVISION_SOURCE_DIR_NAME).replaceAll(
      "\\",
      "/"
    );
    const relativePath = join(relativeDir, `original${ACCEPTED_EXTENSIONS[file.format]}`).replaceAll(
      "\\",
      "/"
    );
    this.assertRelativePathSafe(relativePath);

    const absoluteDir = this.toAbsolute(relativeDir);
    const absolutePath = this.toAbsolute(relativePath);
    // Re-check every component (including the target dir) for symlink/junction
    // escapes before creating anything under the library.
    this.assertNoLinkComponent(relativeDir, absoluteDir, "store target");
    try {
      mkdirSync(absoluteDir, { recursive: true });
    } catch (error) {
      throw new LedgerCopyFailedError(`Failed to create ledger directory ${absoluteDir}`, {
        relativePath,
        cause: error
      });
    }
    try {
      copyFileSync(file.sourcePath, absolutePath);
    } catch (error) {
      // If the source is missing, surface the structured missing-file error.
      if (!existsSync(file.sourcePath)) {
        throw new LedgerFileMissingError(`Source file does not exist: ${file.sourcePath}`, {
          sourcePath: file.sourcePath,
          relativePath
        });
      }
      throw new LedgerCopyFailedError(
        `Failed to copy source file into the ledger: ${file.sourcePath} -> ${absolutePath}`,
        { sourcePath: file.sourcePath, relativePath, cause: error }
      );
    }

    const verification = this.verifyStoredFile(absolutePath, relativePath, file.sizeBytes, file.sha256);
    if (!verification.ok) {
      // Do not leave a partial/incorrect immutable file behind.
      this.deleteOwnedFile(relativePath);
      throw verification.error;
    }

    return {
      fileId,
      relativePath,
      absolutePath,
      sha256: verification.sha256,
      sizeBytes: verification.sizeBytes
    };
  }

  /**
   * Verifies a stored file still matches its recorded size and SHA-256.
   * Returns a structured missing-file error instead of throwing so callers can
   * map it without mixing it with DB failures.
   */
  verifyStoredFile(
    absolutePath: string,
    relativePath: string,
    expectedSizeBytes: number,
    expectedSha256: string
  ): { ok: true; sha256: string; sizeBytes: number } | { ok: false; error: LedgerError } {
    let content: Buffer;
    try {
      content = readFileSync(absolutePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          ok: false,
          error: new LedgerFileMissingError(`Stored ledger file is missing: ${absolutePath}`, {
            relativePath
          })
        };
      }
      return {
        ok: false,
        error: new RunnerError({
          code: "LEDGER_IO",
          message: `Failed to read stored ledger file: ${absolutePath}`,
          details: { relativePath },
          cause: error
        })
      };
    }
    if (content.byteLength !== expectedSizeBytes) {
      return {
        ok: false,
        error: new LedgerSizeMismatchError(
          `Stored ledger file size mismatch: expected ${expectedSizeBytes}, got ${content.byteLength}`,
          { relativePath, expectedSizeBytes, actualSizeBytes: content.byteLength }
        )
      };
    }
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      return {
        ok: false,
        error: new LedgerHashMismatchError(
          `Stored ledger file SHA-256 mismatch for ${relativePath}`,
          { relativePath, expectedSha256, actualSha256 }
        )
      };
    }
    return { ok: true, sha256: actualSha256, sizeBytes: content.byteLength };
  }

  /**
   * Resolves a ledger-relative path to an absolute path under the data root.
   * Throws when the relative path escapes the library (containment check).
   */
  toAbsolute(relativePath: string): string {
    this.assertRelativePathSafe(relativePath);
    return resolve(this.dataRoot, ...relativePath.split(/[\\/]/));
  }

  /**
   * Conservative delete helper (WP2). Refuses by default; only deletes when the
   * relative path is inside `library/drawings`, contains no symlink/junction
   * component (as far as Node can verify on this platform), and the caller
   * explicitly opted in. Never deletes outside the allowlist root.
   */
  deleteOwnedFile(relativePath: string): void {
    this.assertOpen();
    // Relative paths are compared with forward slashes (the persisted form).
    const normalized = relativePath.replaceAll("\\", "/");
    if (
      normalized === DRAWING_LIBRARY_RELATIVE_DIR ||
      normalized.startsWith(`${DRAWING_LIBRARY_RELATIVE_DIR}/`)
    ) {
      this.deleteAllowlistedPath(relativePath);
      return;
    }
    throw new LedgerPathUnsafeError(
      `Refusing to delete a path outside the drawing library allowlist: ${relativePath}`,
      { relativePath }
    );
  }

  // -------------------------------------------------------------------------
  // Containment and escape checks
  // -------------------------------------------------------------------------

  /**
   * Canonical containment: the resolved target must be lexically inside the
   * canonical ledger root. Because Node `path.resolve` follows neither drive
   * case nor reparse points, this is the *second* guard line; component-level
   * symlink/junction checks below are the primary escape defense on Windows.
   */
  assertCanonicalContainment(target: string, label: string): void {
    const canonicalRoot = normalize(this.dataRoot);
    const canonicalTarget = normalize(resolve(target));
    const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    const outside = canonicalTarget === canonicalRoot || !canonicalTarget.startsWith(rootPrefix);
    if (outside) {
      throw new LedgerEscapeDetectedError(`${label} resolves outside the ledger data root`, {
        target,
        dataRoot: this.dataRoot
      });
    }
  }

  /**
   * Rejects relative paths that attempt traversal, drive/UNC roots, backslash
   * tricks on POSIX and absolute path injection. Every ledger write goes through
   * this check before any filesystem call.
   */
  private assertRelativePathSafe(relativePath: string): void {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new LedgerPathUnsafeError("Ledger relative path must be a non-empty string");
    }
    if (isAbsolute(relativePath)) {
      throw new LedgerPathUnsafeError(`Ledger relative path must not be absolute: ${relativePath}`, {
        relativePath
      });
    }
    const split = relativePath.split(/[\\/]/);
    if (split.some((part) => part === ".." || part === "." || part === "")) {
      throw new LedgerPathUnsafeError(
        `Ledger relative path must not contain traversal segments: ${relativePath}`,
        { relativePath }
      );
    }
    if (/^[A-Za-z]:/.test(relativePath)) {
      throw new LedgerPathUnsafeError(
        `Ledger relative path must not contain a drive prefix: ${relativePath}`,
        { relativePath }
      );
    }
    if (relativePath.includes("\0")) {
      throw new LedgerPathUnsafeError("Ledger relative path must not contain NUL bytes");
    }
    // POSIX guard: `C:\...` must not be treated as a relative subdirectory name.
    if (sep === "/" && /^[A-Za-z]:[\\/]/.test(relativePath)) {
      throw new LedgerPathUnsafeError(
        `Ledger relative path looks like a Windows absolute path: ${relativePath}`,
        { relativePath }
      );
    }
  }

  /**
   * True when the path exists and is a symbolic link or junction. Missing paths
   * are not links (they will be created). Node reports Windows junctions as
   * symbolic links (verified on Node 24), so one check covers both platforms.
   */
  private static isSymlink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * Rejects unsafe symlink/junction components for the given path. Every
   * component is checked, including the final one, so a tampered final
   * directory cannot redirect a later write outside the root.
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
      const candidate = resolve(this.dataRoot, ...split.slice(0, i + 1));
      if (DrawingFileLedger.isSymlink(candidate)) {
        throw new LedgerEscapeDetectedError(
          `${label} traverses a symbolic link or junction: ${candidate}`,
          { relativePath }
        );
      }
    }
  }

  private deleteAllowlistedPath(relativePath: string): void {
    this.assertRelativePathSafe(relativePath);
    const absolutePath = this.toAbsolute(relativePath);
    this.assertCanonicalContainment(absolutePath, `deletion target ${relativePath}`);
    this.assertNoLinkComponent(relativePath, absolutePath, "deletion target");

    // The final component itself must not be a link (either of the two stats
    // orderings above catches it); a final symlink is resolved by rmSync below.
    if (DrawingFileLedger.isSymlink(absolutePath)) {
      throw new LedgerEscapeDetectedError(
        `Refusing to delete a symbolic link: ${absolutePath}`,
        { relativePath }
      );
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
        message: `Failed to delete ledger file ${absolutePath}`,
        details: { relativePath },
        cause: error
      });
    }
    // Prune the empty directory chain this deletion created (e.g. compensation
    // leaves an empty generated-id source dir). `rmdirSync` only removes empty
    // directories, so a non-empty candidate stops the pruning automatically and
    // every candidate stays inside the allowlist root.
    const split = relativePath.split(/[\\/]/);
    const allowlistTokens = DRAWING_LIBRARY_RELATIVE_DIR.split("/");
    const underAllowlist =
      split.length > allowlistTokens.length &&
      allowlistTokens.every((token, index) => split[index] === token);
    if (underAllowlist) {
      for (let depth = split.length - 1; depth >= allowlistTokens.length; depth--) {
        const parentAbs = resolve(this.dataRoot, ...split.slice(0, depth));
        try {
          rmdirSync(parentAbs);
        } catch {
          break; // non-empty directory: stop pruning
        }
      }
    }
  }

  private validateInput(input: {
    fileName: string;
    format: DrawingFileFormat;
    sizeBytes?: number;
    sha256?: string;
    mimeType?: string;
    uploadedAt: string;
    sourcePath: string;
  }): { fileName: string; format: DrawingFileFormat; sizeBytes: number; sha256: string; mimeType?: string; uploadedAt: string; sourcePath: string } {
    if (!DRAWING_FILE_FORMATS.includes(input.format)) {
      throw new InvalidArgumentError(`Unsupported drawing file format: ${String(input.format)}`, {
        format: input.format
      });
    }
    if (typeof input.fileName !== "string" || input.fileName.length === 0) {
      throw new InvalidArgumentError("fileName must be a non-empty string");
    }
    if (basename(input.fileName) !== input.fileName) {
      throw new InvalidArgumentError(
        `fileName must not contain path separators: ${input.fileName}`,
        { fileName: input.fileName }
      );
    }
    if (basename(input.fileName).startsWith(".")) {
      throw new InvalidArgumentError(`fileName must not be hidden: ${input.fileName}`);
    }
    if (extname(input.fileName).toLowerCase() !== ACCEPTED_EXTENSIONS[input.format]) {
      throw new InvalidArgumentError(
        `fileName extension does not match format ${input.format}: ${input.fileName}`,
        { fileName: input.fileName, format: input.format }
      );
    }
    if (typeof input.uploadedAt !== "string" || input.uploadedAt.length === 0) {
      throw new InvalidArgumentError("uploadedAt must be a non-empty ISO timestamp");
    }
    if (typeof input.sourcePath !== "string" || input.sourcePath.length === 0) {
      throw new InvalidArgumentError("sourcePath must be a non-empty string");
    }

    // Read the source bytes once: missing files surface as a structured error
    // instead of being silently ignored.
    let content: Buffer;
    try {
      content = readFileSync(input.sourcePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new LedgerFileMissingError(`Source file does not exist: ${input.sourcePath}`, {
          sourcePath: input.sourcePath
        });
      }
      throw new RunnerError({
        code: "LEDGER_IO",
        message: `Failed to read source file: ${input.sourcePath}`,
        details: { sourcePath: input.sourcePath },
        cause: error
      });
    }
    const actualSize = content.byteLength;
    const actualSha256 = createHash("sha256").update(content).digest("hex");

    if (input.sizeBytes !== undefined) {
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
        throw new InvalidArgumentError(`sizeBytes must be a positive integer, got ${input.sizeBytes}`);
      }
      if (input.sizeBytes !== actualSize) {
        throw new LedgerSizeMismatchError(
          `Declared size ${input.sizeBytes} does not match actual bytes ${actualSize}`,
          { sourcePath: input.sourcePath, declaredSizeBytes: input.sizeBytes, actualSizeBytes: actualSize }
        );
      }
    }
    if (input.sha256 !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
        throw new InvalidArgumentError("sha256 must be a 64-character lowercase hex digest");
      }
      if (input.sha256.toLowerCase() !== actualSha256) {
        throw new LedgerHashMismatchError(
          `Declared SHA-256 does not match the actual file bytes`,
          { sourcePath: input.sourcePath, declaredSha256: input.sha256, actualSha256 }
        );
      }
    }

    return {
      fileName: input.fileName,
      format: input.format,
      sizeBytes: actualSize,
      sha256: actualSha256,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      uploadedAt: input.uploadedAt,
      sourcePath: input.sourcePath
    };
  }

  private assertOpen(): void {
    if (!this.isOpened) {
      throw new RunnerError({
        code: "LEDGER_NOT_OPEN",
        message: "The drawing file ledger is not open",
        details: { dataRoot: this.dataRoot }
      });
    }
  }

  /** Metadata of a stored source file, including its absolute path. */
  toRevisionSourceFile(stored: StoredDrawingFile, input: {
    fileName: string;
    format: DrawingFileFormat;
    mimeType?: string;
    uploadedAt: string;
  }): RevisionSourceFile {
    return {
      id: stored.fileId,
      fileName: input.fileName,
      format: input.format,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      relativePath: stored.relativePath,
      uploadedAt: input.uploadedAt
    };
  }
}
