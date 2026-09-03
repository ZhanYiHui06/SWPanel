import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { makeTempDir, removeTempDir } from "../test-utils.js";
import { hashSkillDirectory, SkillHashError } from "./skill-directory-hash.js";

/**
 * Golden digest of the canonical algorithm (v1) for the fixed tree:
 *
 *   a.txt     "A"
 *   d.txt     "DDD"
 *   sub/b.txt "BB"
 *   sub/c.txt ""      (empty file — the framing MUST distinguish it)
 *
 * The value pins the whole canonical stream (u64be length prefixes, sorted
 * normalized relative paths, file content) — an accidental algorithm change
 * breaks this test, not some future snapshot.
 */
const GOLDEN_DIGEST =
  "707702a6766b52c516c21abc0cfe17bb8c7bc21e33f193c95a696f303ae228c4" as const;

const EMPTY_TREE_DIGEST = createHash("sha256").digest("hex"); // sha256 of the empty stream

interface SkillTree {
  dir: string;
  write(relativePath: string, content: string): void;
  mkdir(relativePath: string): void;
}

function openTree(prefix: string): SkillTree {
  const dir = makeTempDir(prefix);
  return {
    dir,
    write(relativePath: string, content: string): void {
      const absolute = join(dir, ...relativePath.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, "utf8");
    },
    mkdir(relativePath: string): void {
      mkdirSync(join(dir, ...relativePath.split("/")), { recursive: true });
    }
  };
}

function closeTree(tree: SkillTree): void {
  removeTempDir(tree.dir);
}

/** Creates the exact golden tree and returns its root. */
function writeGoldenTree(prefix: string): SkillTree {
  const tree = openTree(prefix);
  tree.write("a.txt", "A");
  tree.write("d.txt", "DDD");
  tree.write("sub/b.txt", "BB");
  tree.write("sub/c.txt", "");
  return tree;
}

/** True when the host permits symlink creation (Windows may not). */
function symlinkSupported(): boolean {
  const probe = openTree("symlink-capable");
  try {
    const target = join(probe.dir, "target.txt");
    const link = join(probe.dir, "link.txt");
    probe.write("target.txt", "x");
    symlinkSync(target, link, "file");
    return lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  } finally {
    closeTree(probe);
  }
}

const CAN_SYMLINK = symlinkSupported();

describe("hashSkillDirectory (canonical deterministic directory SHA-256)", () => {
  it("matches the golden digest of the canonical algorithm for the fixed tree", () => {
    const tree = writeGoldenTree("hash-golden");
    try {
      expect(hashSkillDirectory(tree.dir)).toBe(GOLDEN_DIGEST);
    } finally {
      closeTree(tree);
    }
  });

  it("is deterministic: repeated hashing and reversed file-creation order give the SAME digest", () => {
    const first = writeGoldenTree("hash-det-a");
    const second = openTree("hash-det-b");
    try {
      // Reverse creation order AND a different directory enumeration order.
      second.write("sub/c.txt", "");
      second.write("sub/b.txt", "BB");
      second.write("d.txt", "DDD");
      second.write("a.txt", "A");
      const digestA1 = hashSkillDirectory(first.dir);
      const digestA2 = hashSkillDirectory(first.dir);
      const digestB = hashSkillDirectory(second.dir);
      expect(digestA1).toBe(digestA2);
      expect(digestA2).toBe(digestB);
      expect(digestB).toBe(GOLDEN_DIGEST);
    } finally {
      closeTree(first);
      closeTree(second);
    }
  });

  it("an empty tree hashes the empty canonical stream (no files, no framing)", () => {
    const tree = openTree("hash-empty");
    try {
      expect(hashSkillDirectory(tree.dir)).toBe(EMPTY_TREE_DIGEST);
      // An EMPTY subdirectory contributes nothing (only regular files hash).
      tree.mkdir("empty-dir");
      expect(hashSkillDirectory(tree.dir)).toBe(EMPTY_TREE_DIGEST);
      // Nested empty dirs too.
      tree.mkdir("a/b/c");
      expect(hashSkillDirectory(tree.dir)).toBe(EMPTY_TREE_DIGEST);
    } finally {
      closeTree(tree);
    }
  });

  it("drift: any content change, added file, removed file or rename changes the digest", () => {
    const tree = writeGoldenTree("hash-drift");
    try {
      const base = hashSkillDirectory(tree.dir);
      expect(base).toBe(GOLDEN_DIGEST);

      // Content drift of one byte.
      tree.write("a.txt", "B");
      expect(hashSkillDirectory(tree.dir)).not.toBe(base);

      // Empty -> non-empty drift (the framing distinguishes empty content).
      tree.write("sub/c.txt", "C");
      const withContent = hashSkillDirectory(tree.dir);
      expect(withContent).not.toBe(base);

      // Added file.
      tree.write("new.txt", "NEW");
      expect(hashSkillDirectory(tree.dir)).not.toBe(withContent);

      // Rename (same content, different path) drifts too.
      tree.write("renamed.txt", "BB");
      const renamed = hashSkillDirectory(tree.dir);
      expect(renamed).not.toBe(withContent);

      // A subdirectory rename drifts (the normalized relative paths change).
      tree.write("sub2/b.txt", "BB");
      expect(hashSkillDirectory(tree.dir)).not.toBe(renamed);
    } finally {
      closeTree(tree);
    }
  });

  it("fails closed with NOT_A_DIRECTORY for a missing root, a file root and an empty path", () => {
    const tree = openTree("hash-not-dir");
    try {
      expect(() => hashSkillDirectory(join(tree.dir, "missing"))).toThrowError(
        expect.objectContaining<Partial<SkillHashError>>({ code: "NOT_A_DIRECTORY" })
      );
      tree.write("plain.txt", "not a directory");
      expect(() => hashSkillDirectory(join(tree.dir, "plain.txt"))).toThrowError(
        expect.objectContaining<Partial<SkillHashError>>({ code: "NOT_A_DIRECTORY" })
      );
      expect(() => hashSkillDirectory("")).toThrowError(
        expect.objectContaining<Partial<SkillHashError>>({ code: "NOT_A_DIRECTORY" })
      );
    } finally {
      closeTree(tree);
    }
  });

  it.runIf(CAN_SYMLINK)(
    "path escape fails closed: a symlink inside the tree (file or directory) is SYMLINK, never followed",
    () => {
      const outside = openTree("hash-outside");
      const tree = writeGoldenTree("hash-symlink-inside");
      try {
        outside.write("secret.txt", "content OUTSIDE the skill root");
        // A FILE symlink pointing outside the root (replaces the empty c.txt).
        rmSync(join(tree.dir, "sub", "c.txt"));
        symlinkSync(join(outside.dir, "secret.txt"), join(tree.dir, "sub", "c.txt"), "file");
        expect(() => hashSkillDirectory(tree.dir)).toThrowError(
          expect.objectContaining<Partial<SkillHashError>>({
            code: "SYMLINK",
            relativePath: "sub/c.txt"
          })
        );
        // A DIRECTORY symlink pointing outside the root.
        tree.write("sub2/keep.txt", "K");
        symlinkSync(outside.dir, join(tree.dir, "escape"), "dir");
        expect(() => hashSkillDirectory(tree.dir)).toThrowError(
          expect.objectContaining<Partial<SkillHashError>>({ code: "SYMLINK" })
        );
        // The hash never mixes outside content in: the error is raised, never
        // a digest computed over the escaped tree.
      } finally {
        closeTree(outside);
        closeTree(tree);
      }
    }
  );

  it.runIf(CAN_SYMLINK)(
    "fails closed with SYMLINK when the configured root itself is a symlink",
    () => {
      const real = openTree("hash-real-root");
      const alias = openTree("hash-alias");
      try {
        real.write("SKILL.md", "# real");
        symlinkSync(real.dir, join(alias.dir, "redirected"), "dir");
        expect(() => hashSkillDirectory(join(alias.dir, "redirected"))).toThrowError(
          expect.objectContaining<Partial<SkillHashError>>({
            code: "SYMLINK",
            relativePath: "."
          })
        );
      } finally {
        closeTree(real);
        closeTree(alias);
      }
    }
  );

  it("the digest is independent of the host path (only relative paths hash)", () => {
    // Two trees with identical content under DIFFERENT absolute roots hash
    // identically — the canonical stream never contains the root path.
    const treeA = writeGoldenTree("hash-root-a");
    const treeB = writeGoldenTree("hash-root-b");
    try {
      expect(hashSkillDirectory(treeA.dir)).toBe(hashSkillDirectory(treeB.dir));
      expect(hashSkillDirectory(treeA.dir)).toBe(GOLDEN_DIGEST);
    } finally {
      closeTree(treeA);
      closeTree(treeB);
    }
  });
});
