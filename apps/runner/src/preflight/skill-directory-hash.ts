/**
 * Deterministic SHA-256 of a modeling Skill directory (Phase 5, P5-1 real
 * hash gate). The preflight gate freezes a Skill identity (name + sha256)
 * into the Run Input Snapshot at creation time; at execution time the REAL
 * probe recomputes the digest of the CURRENT skill directory and requires an
 * exact match — a drifted or replaced skill can never pass a frozen snapshot.
 *
 * Canonical algorithm (v1, documented):
 *
 * 1. The root MUST be an absolute path to a REAL directory. The root itself
 *    is checked with `lstat`: a symbolic link (or junction) at the root fails
 *    closed (`SYMLINK`) — the configured skill path must never be redirected
 *    to a different tree. A missing or non-directory root fails closed
 *    (`NOT_A_DIRECTORY`).
 * 2. The tree is walked depth-first with `readdir(dir, { withFileTypes: true
 *    })`. ONLY regular files contribute to the digest. Every other entry
 *    type is a FAILURE, never a skip:
 *      - any symbolic link anywhere in the tree fails closed (`SYMLINK`) —
 *        a symlink can point outside the root and silently swap content
 *        (path escape), so it is never followed and never ignored;
 *      - sockets, FIFOs, devices and unknown entry kinds fail closed
 *        (`UNSUPPORTED_ENTRY`).
 * 3. Every regular file is recorded with its NORMALIZED relative path:
 *    forward slashes, no leading "./" and no trailing "/". A normalized
 *    relative path that would escape the root (".." segments) fails closed
 *    (`PATH_ESCAPE`) — belt-and-braces containment on top of the symlink
 *    refusal, so a future walker change can never widen the hashed set.
 * 4. The canonical stream is built from the recorded entries SORTED by their
 *    normalized relative path (ascending code-point order of the path string
 *    itself). The sort key is the path, never the filesystem enumeration
 *    order, so the digest is independent of creation order, readdir order and
 *    OS enumeration differences. For each entry, in sorted order:
 *
 *        u64be(byteLength(pathUtf8)) || pathUtf8 || u64be(byteLength(content)) || content
 *
 *    (integers big-endian, 8 bytes; the length prefixes make the framing
 *    unambiguous — no boundary can be confused with content).
 * 5. The SHA-256 of the canonical stream is returned as a 64-character
 *    lowercase hex digest.
 *
 * Determinism: the digest depends ONLY on the set of (normalized relative
 * path, content) pairs of the regular files under the root — the same tree
 * yields the same digest on every OS. Any file-system anomaly (unreadable
 * file, missing entry mid-walk, disappearing directory) fails closed with the
 * structured {@link SkillHashError} — a partial digest is never produced.
 *
 * The walk is SYNCHRONOUS (the preflight gate is synchronous); skill
 * directories are small, and the fail-closed contract matters more than
 * throughput here.
 */
import { createHash, type Hash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  type Dirent,
  type Stats
} from "node:fs";
import { join, relative } from "node:path";

/** Structured failure classification of a skill directory hash computation. */
export type SkillHashErrorCode =
  | "NOT_A_DIRECTORY"
  | "SYMLINK"
  | "UNSUPPORTED_ENTRY"
  | "PATH_ESCAPE"
  | "READ_FAILED";

/**
 * Structured, fail-closed hash failure. The message carries only the
 * classification and the offending path — never user content — and the
 * preflight gate converts it into a redacted boolean capability result.
 */
export class SkillHashError extends Error {
  readonly code: SkillHashErrorCode;
  /** The absolute path of the offending entry (the root for root failures). */
  readonly path: string;
  /** The normalized relative path of the offending entry ("" for the root). */
  readonly relativePath: string;

  constructor(code: SkillHashErrorCode, path: string, relativePath: string, message: string) {
    super(message);
    this.name = "SkillHashError";
    this.code = code;
    this.path = path;
    this.relativePath = relativePath;
  }
}

/** One recorded regular file of the walked tree (sorted before hashing). */
interface SkillFileEntry {
  /** Normalized relative path (forward slashes, no leading "./"). */
  relativePath: string;
  /** Absolute path used to read the content. */
  absolutePath: string;
}

/** u64be length prefix of the canonical stream. */
const LENGTH_PREFIX_BYTES = 8 as const;

function fail(code: SkillHashErrorCode, path: string, relativePath: string, message: string): never {
  throw new SkillHashError(code, path, relativePath, message);
}

/** The canonical normalized relative path: forward slashes, no leading "./". */
function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0).join("/");
  if (normalized.length === 0) return ".";
  return normalized;
}

/**
 * Fail-closed containment check: the absolute candidate must stay strictly
 * inside the root. Returns the normalized relative path on success and throws
 * `PATH_ESCAPE` otherwise. This is belt-and-braces — the dirent walk can only
 * produce contained names and symlinks are already refused — but it pins the
 * invariant against future walker changes.
 */
function containedRelativePath(root: string, candidate: string, entryRelativePath: string): string {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${"/"}`) ||
    fromRoot.startsWith(`..${"\\"}`) ||
    isAbsolutePath(fromRoot)
  ) {
    fail("PATH_ESCAPE", candidate, entryRelativePath, `path escapes the skill root: ${candidate}`);
  }
  return normalizeRelativePath(fromRoot);
}

function isAbsolutePath(value: string): boolean {
  return value.length > 0 && (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value));
}

function isSymlink(entry: Dirent, stats: Stats): boolean {
  return entry.isSymbolicLink() || stats.isSymbolicLink();
}

/** Walks the tree and records every regular file (fail-closed on anything else). */
function collectFiles(root: string): SkillFileEntry[] {
  const entries: SkillFileEntry[] = [];
  const walk = (directory: string, dirRelativePath: string): void => {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      fail(
        "READ_FAILED",
        directory,
        dirRelativePath,
        `cannot read skill directory: ${errorMessage(error)}`
      );
    }
    for (const entry of dirents) {
      const absolutePath = join(directory, entry.name);
      const entryRelativePath =
        dirRelativePath === "." ? entry.name : `${dirRelativePath}/${entry.name}`;
      let stats: Stats;
      try {
        stats = lstatSync(absolutePath);
      } catch (error) {
        fail(
          "READ_FAILED",
          absolutePath,
          entryRelativePath,
          `cannot stat skill entry: ${errorMessage(error)}`
        );
      }
      // Any symlink/junction anywhere in the tree fails closed: it could
      // redirect the hash outside the root (path escape), so it is never
      // followed and never silently skipped.
      if (isSymlink(entry, stats)) {
        fail("SYMLINK", absolutePath, entryRelativePath, `symbolic link in skill directory: ${absolutePath}`);
      }
      if (stats.isDirectory()) {
        walk(absolutePath, entryRelativePath);
        continue;
      }
      if (!stats.isFile()) {
        fail(
          "UNSUPPORTED_ENTRY",
          absolutePath,
          entryRelativePath,
          `unsupported entry in skill directory (not a regular file): ${absolutePath}`
        );
      }
      const relativePath = containedRelativePath(root, absolutePath, entryRelativePath);
      entries.push({ relativePath, absolutePath });
    }
  };
  walk(root, ".");
  return entries;
}

/** Appends a u64be big-endian length prefix to the hash stream. */
function updateLength(hash: Hash, lengthBytes: number): void {
  const buffer = Buffer.alloc(LENGTH_PREFIX_BYTES);
  buffer.writeBigUInt64BE(BigInt(lengthBytes), 0);
  hash.update(buffer);
}

/**
 * Computes the deterministic SHA-256 of the skill directory at `root`
 * (canonical algorithm documented at the module head). Throws
 * {@link SkillHashError} on ANY anomaly — symlink, path escape, unreadable
 * entry, non-directory root — and never returns a partial digest.
 */
export function hashSkillDirectory(root: string): string {
  if (typeof root !== "string" || root.trim().length === 0) {
    fail("NOT_A_DIRECTORY", root, ".", "skill root must be a non-empty absolute path");
  }
  let rootStats: Stats;
  try {
    rootStats = lstatSync(root);
  } catch (error) {
    fail(
      "NOT_A_DIRECTORY",
      root,
      ".",
      `skill root is not a readable directory: ${errorMessage(error)}`
    );
  }
  if (rootStats.isSymbolicLink()) {
    fail("SYMLINK", root, ".", `skill root must not be a symbolic link: ${root}`);
  }
  if (!rootStats.isDirectory()) {
    fail("NOT_A_DIRECTORY", root, ".", `skill root is not a directory: ${root}`);
  }

  const entries = collectFiles(root);
  // The canonical order is the sorted normalized relative path — the digest
  // never depends on filesystem enumeration order.
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  const hash = createHash("sha256");
  for (const entry of entries) {
    const pathBuffer = Buffer.from(entry.relativePath, "utf8");
    updateLength(hash, pathBuffer.byteLength);
    hash.update(pathBuffer);
    let content: Buffer;
    try {
      content = readFileSync(entry.absolutePath);
    } catch (error) {
      fail(
        "READ_FAILED",
        entry.absolutePath,
        entry.relativePath,
        `cannot read skill file: ${errorMessage(error)}`
      );
    }
    updateLength(hash, content.byteLength);
    hash.update(content);
  }
  return hash.digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
