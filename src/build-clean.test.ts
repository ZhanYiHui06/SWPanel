import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  removeDirectories,
  workspaceDistDirectories
} from "../scripts/clean.mjs";

const isWindows = process.platform === "win32";

/**
 * Simulates the Windows lock a packaged SWPanel instance holds on app.asar:
 * opens the file with FileShare.None, blocking any delete until released.
 * Returns an async release function.
 */
async function lockFile(filePath: string): Promise<() => Promise<void>> {
  const scriptPath = path.join(
    os.tmpdir(),
    `swpanel-lock-${process.pid}-${Math.random().toString(36).slice(2)}.ps1`
  );
  await writeFile(
    scriptPath,
    [
      "param([string]$path)",
      "$s = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
      'Write-Output "LOCKED"',
      "[Console]::In.ReadLine() | Out-Null",
      "$s.Dispose()"
    ].join("\n"),
    "utf8"
  );
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, filePath],
    { stdio: ["pipe", "pipe", "inherit"] }
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (String(chunk).includes("LOCKED")) resolve();
    });
    child.once("error", reject);
  });
  return async () => {
    child.stdin?.end();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await rm(scriptPath, { force: true }).catch(() => undefined);
  };
}

async function createLockedPackageLayout(): Promise<{
  base: string;
  distDir: string;
  outDir: string;
  appAsar: string;
  release: () => Promise<void>;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-clean-"));
  const distDir = path.join(base, "dist");
  const outDir = path.join(base, "out", "SWPanel-win32-x64", "resources");
  await mkdir(distDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(distDir, "index.js"), "stale");
  const appAsar = path.join(outDir, "app.asar");
  await writeFile(appAsar, "stale package");
  const release = await lockFile(appAsar);
  return { base, distDir, outDir, appAsar, release };
}

describe("build clean vs Electron Forge output", () => {
  it("cleans every workspace dist but never the Forge out directory", () => {
    expect(workspaceDistDirectories).toContain("../dist");
    expect(workspaceDistDirectories).toContain("../apps/desktop/dist");
    expect(workspaceDistDirectories).toContain("../apps/runner/dist");
    expect(workspaceDistDirectories).toContain("../packages/contracts/dist");
    expect(workspaceDistDirectories).toContain("../packages/domain/dist");
    expect(workspaceDistDirectories).toContain("../packages/ui/dist");
    expect(
      workspaceDistDirectories.some((entry) => path.basename(entry) === "out")
    ).toBe(false);
  });

  it.skipIf(!isWindows)(
    "workspace dist rebuild completes while a packaged app.asar is locked",
    { timeout: 15_000 },
    async () => {
      const layout = await createLockedPackageLayout();
      try {
        // This is exactly what clean.mjs does for `npm run build`: only the
        // workspace dist outputs are removed, never the Forge `out` dir.
        await expect(removeDirectories([layout.distDir])).resolves.toBeUndefined();
        await expect(access(layout.distDir)).rejects.toThrow();
        // The stale package is untouched and still locked.
        await expect(access(layout.appAsar)).resolves.toBeUndefined();
      } finally {
        await layout.release();
        await rm(layout.base, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!isWindows)(
    "regression: cleaning the out dir itself used to fail when app.asar is locked",
    { timeout: 15_000 },
    async () => {
      const layout = await createLockedPackageLayout();
      try {
        // Old clean.mjs deleted `../out`; that is exactly the step that
        // aborted `npm run build` with EBUSY and left dists half-deleted.
        await expect(removeDirectories([layout.outDir])).rejects.toThrow();
        await expect(access(layout.appAsar)).resolves.toBeUndefined();
      } finally {
        await layout.release();
        await rm(layout.base, { recursive: true, force: true });
      }
    }
  );
});
