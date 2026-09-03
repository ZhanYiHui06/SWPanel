import { access } from "node:fs/promises";
import path from "node:path";

import { _electron as electron } from "@playwright/test";

/**
 * Packaged-app smoke test: launch the freshly packaged output and verify the
 * app boots and the renderer is served over `app://swpanel` with the production
 * security posture (no development renderer override). This reuses the
 * Electron production ASAR launch approach from e2e/electron.production.spec.ts
 * without modifying that spec.
 *
 * The packaged directory normally contains `SWPanel.exe`; when the executable
 * is present it is launched directly, otherwise the packaged `app.asar` is
 * launched with the workspace Electron binary (exactly how the production e2e
 * spec launches a real asar).
 *
 * @param {string} asarPath absolute path to the freshly packaged app.asar
 * @returns {Promise<void>} resolves when the packaged app boots correctly
 */
export async function smokePackagedApp(asarPath) {
  // Strip every casing of the legacy development override + marker so the
  // packaged app must load the real renderer over app://swpanel (Windows env is
  // case-insensitive). The main process never reads these environment variables
  // — the development renderer is authorized only by the dedicated CLI argument
  // on an unpackaged launch — but stripping keeps the smoke hermetic against
  // test-runner environment leakage.
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (
      upper !== "SWPANEL_RENDERER_URL" &&
      upper !== "SWPANEL_DEVELOPMENT_RENDERER" &&
      value !== undefined
    ) {
      env[key] = value;
    }
  }

  const packageRoot = path.resolve(path.dirname(asarPath), ".."); // SWPanel-win32-x64
  const exePath = path.join(packageRoot, "SWPanel.exe");
  let exeExists = false;
  try {
    await access(exePath);
    exeExists = true;
  } catch {
    // No packaged executable; launch the asar with the workspace Electron.
  }

  let app;
  if (exeExists) {
    app = await electron.launch({ executablePath: exePath, cwd: packageRoot, env });
  } else {
    app = await electron.launch({ args: [asarPath], cwd: path.dirname(asarPath), env });
  }

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator("#root").waitFor({ state: "visible", timeout: 30_000 });
    const url = page.url();
    const rootChildCount = await page.locator("#root > *").count();
    if (!/^app:\/\/swpanel\//.test(url)) {
      throw new Error(
        `Packaged smoke FAILED: renderer loaded from "${url}" instead of app://swpanel.`
      );
    }
    if (rootChildCount === 0) {
      throw new Error("Packaged smoke FAILED: the renderer root is empty.");
    }
  } finally {
    await app.close().catch(() => undefined);
  }
}
