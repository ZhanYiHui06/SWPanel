import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertNoLegacyPackageCopy,
  assertWithinRoot,
  createPackageRun,
  defaultPackageLockDir,
  formatLockedOutputError,
  isWindowsFileLock,
  legacyPackageCopyPath,
  OUT_INVALID_PREFIX,
  packageAll,
  packageRunsRoot,
  PUBLISH_MAX_RETRIES,
  PUBLISH_RETRY_DELAYS,
  publishRunOutput,
  quarantineExistingOut,
  verifyPackagedAppAsar
} from "../scripts/packaging.mjs";

/** @param {string} filePath */
async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Create a runDir with a real per-run `out` tree containing marker.txt. */
async function makeRunOut(runDir: string) {
  await mkdir(path.join(runDir, "out"), { recursive: true });
  await writeFile(path.join(runDir, "out", "marker.txt"), "verified");
}

/** Fake steps that all succeed. */
function successfulSteps() {
  return {
    runBuild: () => 0,
    runPackage: async (_root: string, outDir: string) => {
      const asarPath = path.join(
        outDir,
        "SWPanel-win32-x64",
        "resources",
        "app.asar"
      );
      await mkdir(path.dirname(asarPath), { recursive: true });
      await writeFile(asarPath, "verified asar");
      return { ok: true as const, asarPath, sizeBytes: 13 };
    },
    runAudit: () => ({ ok: true }),
    runSmoke: () => undefined,
    // Hermetic tests never touch the real audit report file; the canonical
    // fingerprinting after publish is injected separately when it is asserted.
    finalizeReport: () => undefined
  };
}

describe("packageAll (per-run output + atomic publish)", () => {
  it("publishes to the canonical out only after build/package/audit/smoke all pass", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pkgall-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const finalizedPaths: string[] = [];
      const result = await packageAll({
        root,
        lockDir: path.join(base, "lock"),
        ...successfulSteps(),
        finalizeReport: (publishedAsarPath: string) => {
          finalizedPaths.push(publishedAsarPath);
        }
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outPath).toBe(path.join(root, "out"));
      // The returned asarPath is the CANONICAL published path (not the per-run
      // source), it exists on disk, and the report finalization saw exactly it.
      expect(result.asarPath).toBe(
        path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar")
      );
      expect(await exists(result.asarPath)).toBe(true);
      expect(finalizedPaths).toEqual([result.asarPath]);
      // sizeBytes must match the canonical published file, not a per-run one.
      const canonicalInfo = await stat(result.asarPath);
      expect(canonicalInfo.size).toBe(result.sizeBytes);
      expect(
        await exists(
          path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar")
        )
      ).toBe(true);
      expect(result.asarPath).not.toMatch(/package-runs/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("aborts as publish when the audit report cannot be finalized after publish", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pkgall-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const result = await packageAll({
        root,
        lockDir: path.join(base, "lock"),
        ...successfulSteps(),
        finalizeReport: () => {
          throw new Error("cannot fingerprint published asar");
        }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("publish");
      expect(result.error).toMatch(/cannot fingerprint published asar/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it.each([
    ["build", { runBuild: () => 7 }],
    [
      "package",
      { runPackage: () => ({ ok: false as const, exitCode: 9 }) }
    ],
    ["audit", { runAudit: () => ({ ok: false }) }],
    [
      "smoke",
      {
        runSmoke: () => {
          throw new Error("renderer failed to load");
        }
      }
    ]
  ])("aborts at stage %s without publishing or leaving a canonical out", async (stage, overrides) => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pkgall-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const result = await packageAll({
        root,
        lockDir: path.join(base, "lock"),
        ...successfulSteps(),
        ...overrides
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe(stage);
      expect(await exists(path.join(root, "out"))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("quarantines a previous canonical out at the start so it can never be current evidence", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pkgall-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, "out", "SWPanel-win32-x64", "resources"), {
        recursive: true
      });
      await writeFile(
        path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar"),
        "stale"
      );
      const quarantine = await quarantineExistingOut(root);
      expect(quarantine.status).toBe("moved");
      if (quarantine.status !== "moved") return;
      expect(path.basename(quarantine.target)).toMatch(
        new RegExp(`^${OUT_INVALID_PREFIX}`)
      );
      await expect(access(path.join(root, "out"))).rejects.toThrow();
      const result = await packageAll({
        root,
        lockDir: path.join(base, "lock"),
        ...successfulSteps()
      });
      expect(result.ok).toBe(true);
      await expect(access(path.join(root, "out"))).resolves.toBeUndefined();
      await expect(access(quarantine.target)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("a failed build leaves the stale quarantine in place and no canonical out", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pkgall-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, "out"), { recursive: true });
      await writeFile(path.join(root, "out", "marker.txt"), "old package");
      const result = await packageAll({
        root,
        lockDir: path.join(base, "lock"),
        runBuild: () => 3,
        runPackage: successfulSteps().runPackage,
        runAudit: successfulSteps().runAudit,
        runSmoke: successfulSteps().runSmoke
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("build");
      await expect(access(path.join(root, "out"))).rejects.toThrow();
      const entries = await readdir(root);
      expect(entries.some((entry) => entry.startsWith(OUT_INVALID_PREFIX))).toBe(
        true
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("publish/rename failures are never swallowed", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pkgall-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const result = await packageAll({
        root,
        lockDir: path.join(base, "lock"),
        ...successfulSteps(),
        publish: () => {
          throw new Error("rename failed");
        }
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.stage).toBe("publish");
      expect(result.error).toMatch(/rename failed/);
      await expect(access(path.join(root, "out"))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("aborts when another live process holds the packaging lock", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pkgall-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const lockDir = path.join(base, "lock");
      const lock = await import("../scripts/package-lock.mjs");
      const first = await lock.acquirePackageLock(lockDir);
      expect(first.status).toBe("acquired");
      await expect(
        packageAll({ root, lockDir, ...successfulSteps() })
      ).rejects.toThrow(/Another packaging run is in progress/);
      await lock.releasePackageLock(
        first.status === "acquired" ? first.lock : null,
        lockDir
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("aborts when the legacy .package-copy directory exists and never deletes it", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pkgall-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, ".package-copy"), { recursive: true });
      await writeFile(
        path.join(root, ".package-copy", "keep.txt"),
        "do not delete"
      );
      const result = await packageAll({
        root,
        lockDir: path.join(base, "lock"),
        ...successfulSteps()
      });
      expect(result.ok).toBe(false);
      await expect(
        access(path.join(root, ".package-copy", "keep.txt"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("exposes a default lock directory inside .scratch", () => {
    expect(defaultPackageLockDir).toMatch(/[\\/]\.scratch[\\/]package-lock/);
    expect(packageRunsRoot).toMatch(/[\\/]\.scratch[\\/]package-runs/);
    expect(legacyPackageCopyPath).toMatch(/[\\/]\.package-copy$/);
  });
});

describe("quarantineExistingOut", () => {
  it("reports absent when there is no out directory", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-q-"));
    try {
      expect(await quarantineExistingOut(base)).toEqual({ status: "absent" });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to quarantine a non-directory named out", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-q-"));
    try {
      await writeFile(path.join(base, "out"), "file");
      await expect(quarantineExistingOut(base)).rejects.toThrow(
        /not a directory/
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("publishRunOutput", () => {
  it("moves the run output to the canonical path atomically", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pub-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(root, ".scratch", "package-runs", "run-1");
      await mkdir(
        path.join(runDir, "out", "SWPanel-win32-x64", "resources"),
        { recursive: true }
      );
      await writeFile(
        path.join(runDir, "out", "SWPanel-win32-x64", "resources", "app.asar"),
        "verified"
      );
      const published = await publishRunOutput(runDir, root);
      expect(published).toBe(path.join(root, "out"));
      await expect(
        access(
          path.join(root, "out", "SWPanel-win32-x64", "resources", "app.asar")
        )
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing canonical out", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pub-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, "out"), { recursive: true });
      const runDir = path.join(root, ".scratch", "package-runs", "run-2");
      await mkdir(runDir, { recursive: true });
      await expect(publishRunOutput(runDir, root)).rejects.toThrow(
        /already exists/
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to publish when the per-run source output is missing", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pub-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(root, ".scratch", "package-runs", "run-missing");
      await mkdir(runDir, { recursive: true });
      await expect(publishRunOutput(runDir, root)).rejects.toThrow(
        /per-run output .* does not exist/
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("retries transient Windows locks with bounded backoff and succeeds", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pub-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(
        root,
        ".scratch",
        "package-runs",
        "run-retry"
      );
      await makeRunOut(runDir);

      const transientErrors = [
        Object.assign(new Error("transient"), { code: "EBUSY" }),
        Object.assign(new Error("transient"), { code: "EPERM" })
      ];
      let renameCalls = 0;
      const renameFn = async (from: string, to: string) => {
        if (renameCalls < transientErrors.length) {
          const error = transientErrors[renameCalls];
          renameCalls += 1;
          if (error === undefined) {
            throw new Error("Missing transient test error.");
          }
          throw error;
        }
        renameCalls += 1;
        return rename(from, to);
      };
      const slept: number[] = [];
      const sleepFn = (ms: number) => {
        slept.push(ms);
        return undefined;
      };

      const published = await publishRunOutput(runDir, root, {
        rename: renameFn,
        sleep: sleepFn
      });
      expect(published).toBe(path.join(root, "out"));
      // Initial attempt + one retry per transient error, each backed off.
      expect(renameCalls).toBe(transientErrors.length + 1);
      expect(slept).toEqual(PUBLISH_RETRY_DELAYS.slice(0, transientErrors.length));
      await expect(
        access(path.join(root, "out", "marker.txt"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails immediately when the canonical destination appears mid-publish", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pub-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(
        root,
        ".scratch",
        "package-runs",
        "run-appears"
      );
      await makeRunOut(runDir);
      const canonical = path.join(root, "out");

      let sleeps = 0;
      const existsFn = async (filePath: string) => {
        if (
          path.resolve(filePath) === path.resolve(canonical) &&
          sleeps >= 1
        ) {
          // The canonical destination appears while we are backing off.
          return true;
        }
        return exists(filePath);
      };
      const sleepFn = () => {
        sleeps += 1;
        return undefined;
      };
      const renameFn = () =>
        Promise.reject(
          Object.assign(new Error("transient"), { code: "EBUSY" })
        );

      await expect(
        publishRunOutput(runDir, root, {
          rename: renameFn,
          exists: existsFn,
          sleep: sleepFn
        })
      ).rejects.toThrow(/appeared while publishing/);
      // The canonical out was never created and the source is untouched.
      await expect(access(canonical)).rejects.toThrow();
      await expect(
        access(path.join(runDir, "out", "marker.txt"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("does not retry non-transient rename errors", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pub-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(
        root,
        ".scratch",
        "package-runs",
        "run-nontransient"
      );
      await makeRunOut(runDir);

      let renameCalls = 0;
      const renameFn = () => {
        renameCalls += 1;
        return Promise.reject(
          Object.assign(new Error("not a lock"), { code: "ENOENT" })
        );
      };
      let sleeps = 0;
      const sleepFn = () => {
        sleeps += 1;
        return undefined;
      };

      await expect(
        publishRunOutput(runDir, root, { rename: renameFn, sleep: sleepFn })
      ).rejects.toThrow(/not a lock/);
      expect(renameCalls).toBe(1);
      expect(sleeps).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails loudly when the transient lock outlives the bounded retry budget", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-pub-"));
    try {
      const root = path.join(base, "repo");
      const runDir = path.join(
        root,
        ".scratch",
        "package-runs",
        "run-timeout"
      );
      await makeRunOut(runDir);

      let renameCalls = 0;
      const renameFn = () => {
        renameCalls += 1;
        return Promise.reject(
          Object.assign(new Error("persistent lock"), { code: "EPERM" })
        );
      };

      const slept: number[] = [];
      const sleepFn = (ms: number) => {
        slept.push(ms);
        return undefined;
      };
      await expect(
        publishRunOutput(runDir, root, {
          rename: renameFn,
          sleep: sleepFn
        })
      ).rejects.toThrow(/Cannot move packaged output/);
      expect(slept).toEqual(PUBLISH_RETRY_DELAYS);
      // Initial attempt plus every bounded retry ran, then the persistent
      // lock surfaced as a clear publish failure (never an overwrite).
      expect(renameCalls).toBe(PUBLISH_MAX_RETRIES + 1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("createPackageRun", () => {
  it("creates a uuid-scoped run directory under .scratch/package-runs with metadata", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-run-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(root, { recursive: true });
      const run = await createPackageRun(root);
      expect(run.outDir).toBe(path.join(run.runDir, "out"));
      await expect(
        access(path.join(run.runDir, "run.json"))
      ).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("verifyPackagedAppAsar", () => {
  it("reports the fresh app.asar size when it exists and is non-empty", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-verify-"));
    try {
      const resources = path.join(base, "SWPanel-win32-x64", "resources");
      await mkdir(resources, { recursive: true });
      const asarPath = path.join(resources, "app.asar");
      await writeFile(asarPath, "fresh asar content");
      const result = await verifyPackagedAppAsar(base);
      expect(result.asarPath).toBe(asarPath);
      expect(result.sizeBytes).toBeGreaterThan(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects a missing app.asar after a claimed successful package", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-verify-"));
    try {
      await expect(verifyPackagedAppAsar(base)).rejects.toThrow(
        /no fresh app\.asar/
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects an empty app.asar", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-verify-"));
    try {
      const resources = path.join(base, "SWPanel-win32-x64", "resources");
      await mkdir(resources, { recursive: true });
      await writeFile(path.join(resources, "app.asar"), "");
      await expect(verifyPackagedAppAsar(base)).rejects.toThrow(/empty/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("assertWithinRoot / formatLockedOutputError / isWindowsFileLock", () => {
  it("accepts a nested directory and rejects the root itself and siblings", () => {
    const root = path.join("F:", "SWPanel");
    expect(() =>
      assertWithinRoot(root, path.join(root, "out"), "output")
    ).not.toThrow();
    expect(() => assertWithinRoot(root, root, "output")).toThrow(
      /workspace root itself/
    );
    expect(() =>
      assertWithinRoot(root, path.join("F:", "Other", "out"), "output")
    ).toThrow(/outside the workspace root/);
  });

  it("recognizes Windows file lock error codes", () => {
    expect(isWindowsFileLock({ code: "EBUSY" })).toBe(true);
    expect(isWindowsFileLock({ code: "EPERM" })).toBe(true);
    expect(isWindowsFileLock({ code: "ENOTEMPTY" })).toBe(true);
    expect(isWindowsFileLock({ code: "ENOENT" })).toBe(false);
    expect(isWindowsFileLock(null)).toBe(false);
  });

  it("formats an actionable error naming the locked packaged output", () => {
    const message = formatLockedOutputError("F:\\out", { code: "EBUSY" });
    expect(message).toContain("F:\\out");
    expect(message).toContain("Close SWPanel");
    expect(message).toContain("aborted");
  });

  it("assertNoLegacyPackageCopy aborts on an existing .package-copy", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-assert-"));
    try {
      const root = path.join(base, "repo");
      await mkdir(path.join(root, ".package-copy"), { recursive: true });
      await expect(assertNoLegacyPackageCopy(root)).rejects.toThrow(
        /\.package-copy/
      );
      const clean = path.join(base, "clean");
      await mkdir(clean, { recursive: true });
      await expect(assertNoLegacyPackageCopy(clean)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
