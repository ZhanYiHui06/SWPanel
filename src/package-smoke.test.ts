import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPackage } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { publishRunOutput } from "../scripts/packaging.mjs";
import { smokePackagedApp } from "../scripts/package-smoke.mjs";

/**
 * Real packaged-app smoke: build a production app.asar from the workspace dist
 * outputs (the same surface the Forge package ships) and launch it through
 * `smokePackagedApp`, verifying the app boots and the renderer loads over
 * app://swpanel. This reuses the Electron production ASAR approach from
 * e2e/electron.production.spec.ts without modifying that spec. It is skipped
 * when the workspace has not been built yet (e.g. a fresh clone before
 * `npm run build`).
 */
async function buildProductionAsar() {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-smoke-"));
  const stagingRoot = path.join(tempDirectory, "app");
  await cp(
    path.resolve("apps/desktop/dist/main"),
    path.join(stagingRoot, "apps/desktop/dist/main"),
    { recursive: true }
  );
  await cp(
    path.resolve("apps/desktop/dist/preload"),
    path.join(stagingRoot, "apps/desktop/dist/preload"),
    { recursive: true }
  );
  await cp(
    path.resolve("apps/desktop/dist/renderer"),
    path.join(stagingRoot, "apps/desktop/dist/renderer"),
    { recursive: true }
  );
  await writeFile(
    path.join(stagingRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "swpanel-smoke-asar",
        version: "0.1.0",
        type: "module",
        main: "apps/desktop/dist/main/main.js"
      },
      null,
      2
    )}\n`
  );
  const asarPath = path.join(tempDirectory, "app.asar");
  await createPackage(stagingRoot, asarPath);
  return { tempDirectory, asarPath };
}

describe("packaged-app smoke", () => {
  it.skipIf(
    !(
      existsSync(path.resolve("apps/desktop/dist/renderer/index.html")) &&
      existsSync(path.resolve("apps/desktop/dist/main/main.js"))
    )
  )(
    "launches the freshly packaged app and loads the renderer over app://swpanel",
    { timeout: 60_000 },
    async () => {
      const { tempDirectory, asarPath } = await buildProductionAsar();
      try {
        await expect(smokePackagedApp(asarPath)).resolves.toBeUndefined();
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(
    !(
      existsSync(path.resolve("apps/desktop/dist/renderer/index.html")) &&
      existsSync(path.resolve("apps/desktop/dist/main/main.js"))
    )
  )(
    "real packaged smoke then immediate publish survives transient Windows locks",
    { timeout: 90_000 },
    async () => {
      // Real Windows regression: launch a freshly packaged production asar,
      // then publish the exact same per-run output to a canonical `out` right
      // after the smoke closes the app. A just-closed Electron process can
      // still hold packaged files transiently; `publishRunOutput` must ride
      // through the bounded backoff instead of failing with a lock error.
      const { tempDirectory, asarPath } = await buildProductionAsar();
      try {
        const root = path.join(tempDirectory, "repo");
        const runDir = path.join(
          root,
          ".scratch",
          "package-runs",
          "smoke-publish"
        );
        // Stage the smoke-tested asar into the per-run layout that a real
        // Forge package produces: out/SWPanel-win32-x64/resources/app.asar.
        const resourcesDir = path.join(
          runDir,
          "out",
          "SWPanel-win32-x64",
          "resources"
        );
        await mkdir(resourcesDir, { recursive: true });
        await cp(asarPath, path.join(resourcesDir, "app.asar"));

        await expect(smokePackagedApp(path.join(resourcesDir, "app.asar"))).resolves.toBeUndefined();

        // Immediately after the smoke app closed, publish to the canonical
        // out with real rename/backoff. This must succeed; a persistent lock
        // here is a genuine regression.
        const published = await publishRunOutput(runDir, root);
        expect(published).toBe(path.join(root, "out"));
        expect(existsSync(published)).toBe(true);
        expect(
          existsSync(
            path.join(published, "SWPanel-win32-x64", "resources", "app.asar")
          )
        ).toBe(true);
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    }
  );
});
