import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Repository root. vitest runs from the workspace root (where vitest.config.js
 * lives), which is where the .gitignore under test is located.
 */
const repoRoot = path.resolve(process.cwd());

/**
 * Ask git whether `relPath` (POSIX, relative to the repo root) is ignored by
 * the working-tree .gitignore. `--no-index` ignores the index, so this is a
 * pure .gitignore pattern check. Returns the verbose match line when ignored
 * (e.g. `.gitignore:10:/out-invalid-` star `/  out-invalid-.../app.asar`) and
 * null when the path is not ignored.
 */
function gitCheckIgnore(relPath: string): string | null {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "-v", relPath],
    { cwd: repoRoot, encoding: "utf8" }
  );
  // git check-ignore exits 0 when ignored, 1 when not ignored.
  if (result.status === 0) {
    return result.stdout.trim();
  }
  expect(result.status).toBe(1);
  return null;
}

describe("repo .gitignore root out-invalid-* quarantine rule", () => {
  it("ignores root-level out-invalid-* quarantines via the exact /out-invalid-*/ rule", () => {
    const match = gitCheckIgnore(
      "out-invalid-2026-08-11T10-01-59-246Z/app.asar"
    );
    expect(match).not.toBeNull();
    expect(match).toContain("/out-invalid-*/");

    // The quarantine directory itself (and hence everything under it) is
    // ignored, matching the audit/forge "out-invalid-" root prefix semantics.
    expect(
      gitCheckIgnore("out-invalid-2026-08-11T10-01-59-246Z/")
    ).toContain("/out-invalid-*/");
    expect(gitCheckIgnore("out-invalid-/x")).toContain("/out-invalid-*/");
  });

  it("does not ignore nested out-invalid-* directories (rule is root-anchored)", () => {
    // The quarantine prefix only ever appears at the workspace root; a module
    // directory that happens to be named out-invalid-* must not be dropped.
    expect(gitCheckIgnore("apps/desktop/out-invalid-2026/app.js")).toBeNull();
    // Under a dist tree the path may be ignored by **/dist/ — but never by the
    // root /out-invalid-*/ rule.
    const nestedDist = gitCheckIgnore("packages/ui/dist/out-invalid-2026/app.js");
    if (nestedDist !== null) {
      expect(nestedDist).not.toContain("/out-invalid-*/");
    }
  });

  it("does not ignore directories that merely start with out-invalid", () => {
    // Precise prefix matching: only the exact `out-invalid-` (with trailing
    // hyphen) root prefix is a packaging quarantine.
    expect(gitCheckIgnore("out-invalidated/app.asar")).toBeNull();
    expect(gitCheckIgnore("out-invalid/app.asar")).toBeNull();
    expect(gitCheckIgnore("out-invalidish/x.js")).toBeNull();
  });
});
