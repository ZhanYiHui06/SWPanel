import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createPackage } from "@electron/asar";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

import { CONTENT_SECURITY_POLICY, DEVELOPMENT_RENDERER_CLI_FLAG, DEVELOPMENT_RENDERER_URL } from "../apps/desktop/src/main/security.js";
import { TEST_RUNTIME_ROOT_CLI_FLAG } from "../apps/desktop/src/main/bridge/runtime-root.js";
import {
  FAKE_EXECUTOR_SCENARIO_ENV,
  FAKE_EXECUTOR_STEP_DELAY_ENV,
  RUN_LEASE_ENV
} from "../apps/desktop/src/main/runner-host/test-executor-config.js";
import { registerGeometryFixture } from "../apps/runner/src/testing/measured-geometry-fixture.js";
import { PRODUCT_ROUTES } from "../apps/desktop/src/renderer/app/route-manifest.js";
import type { RunDetailBridgeResult, SwpanelBridgeApi } from "../apps/desktop/src/main/bridge/bridge-contract.js";
import {
  PROMPT_TEMPLATE_VERSION
} from "../apps/runner/src/adaptation/prompt-template.js";
import {
  validateInputAdapterResult,
  validateInvocationPackage,
  validateResultManifest,
  validateRuntimeMetadata
} from "@swpanel/contracts";

const DESKTOP_DIST_DIR = path.resolve("apps/desktop/dist");

// The WP5 Runner host needs a data root; every unpackaged launch in this spec
// uses a temporary root via the dedicated unpackaged-only CLI argument so the
// tests never touch the real %LOCALAPPDATA%\JANGHI\SWPanel. A real packaged app
// (package-smoke) uses the OS-derived production root by design.
let testRuntimeRoot: string | undefined;

test.beforeAll(async () => {
  testRuntimeRoot = await mkdtemp(path.join(os.tmpdir(), "swpanel-production-root-"));
});

test.afterAll(async () => {
  if (testRuntimeRoot !== undefined) {
    await rm(testRuntimeRoot, { recursive: true, force: true });
  }
});

/**
 * Production Electron shell: launches the built main process WITHOUT the
 * dedicated development-renderer CLI argument, so the renderer is served by the
 * restricted `app://swpanel` protocol exactly like a packaged app. The Vite dev
 * server is not used by these tests, and this spec is run from
 * playwright.electron.production.config.ts which has no `webServer`.
 *
 * The development renderer is authorized ONLY by the explicit
 * `--swpanel-development-renderer=<url>` CLI argument on an unpackaged launch
 * (scripts/dev.mjs and the dev smoke pass it). These tests never pass it, so
 * every production launch here must unconditionally load `app://swpanel` — even
 * when SWPANEL_RENDERER_URL / SWPANEL_DEVELOPMENT_RENDERER environment
 * variables (any casing) and a live hostile service on port 5173 are present,
 * and even when a hostile or duplicate development-renderer CLI argument is
 * passed.
 */
async function launchRenderer(env: Record<string, string>, ...cliArgs: string[]) {
  return launchRendererWithRoot(testRuntimeRoot as string, env, ...cliArgs);
}

/**
 * Launches the built main process against a CALLER-provided temp runtime root
 * (the WP5 restart-persistence test needs to relaunch against the SAME root).
 */
async function launchRendererWithRoot(
  root: string,
  env: Record<string, string>,
  ...cliArgs: string[]
) {
  return electron.launch({
    args: [
      path.resolve("apps/desktop/dist/main/main.js"),
      `${TEST_RUNTIME_ROOT_CLI_FLAG}=${root}`,
      ...cliArgs
    ],
    cwd: path.resolve("."),
    env
  });
}

async function launchAsar(asarPath: string, env: Record<string, string>, ...cliArgs: string[]) {
  return electron.launch({
    args: [asarPath, `${TEST_RUNTIME_ROOT_CLI_FLAG}=${testRuntimeRoot as string}`, ...cliArgs],
    cwd: path.resolve("."),
    env
  });
}

/**
 * Produces a clean base environment for the packaged app. Windows environment
 * variables are case-insensitive, so the legacy renderer-override and
 * development-marker variables are dropped in every casing
 * (`SWPANEL_RENDERER_URL`/`swpanel_renderer_url`,
 * `SWPANEL_DEVELOPMENT_RENDERER`/`swpanel_development_renderer`) so the test
 * runner's own environment can never leak them into a child launch. The matrix
 * tests then deliberately re-inject them to prove the main process ignores them
 * completely.
 */
function productionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
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
  return env;
}

/**
 * Builds a real app.asar for THIS build in a temporary directory, containing
 * only the shipped runtime surface: package metadata, the main process bundle,
 * the preload and the renderer output. This deliberately does not depend on the
 * Forge `out/` package (which can be locked by another process): the asar is
 * produced with @electron/asar from the workspace dist artifacts and the app is
 * launched with Electron pointed directly at the archive.
 */
async function buildProductionAsar() {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-asar-"));
  const stagingRoot = path.join(tempDirectory, "app");
  await cp(
    path.join(DESKTOP_DIST_DIR, "main"),
    path.join(stagingRoot, "apps/desktop/dist/main"),
    { recursive: true }
  );
  await cp(
    path.join(DESKTOP_DIST_DIR, "preload"),
    path.join(stagingRoot, "apps/desktop/dist/preload"),
    { recursive: true }
  );
  await cp(
    path.join(DESKTOP_DIST_DIR, "renderer"),
    path.join(stagingRoot, "apps/desktop/dist/renderer"),
    { recursive: true }
  );
  await writeFile(
    path.join(stagingRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "swpanel-e2e-asar",
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

/**
 * Starts a hostile HTTP server on the pinned development port 5173. If the
 * production app ever honored the development renderer override (via the
 * environment or a hostile CLI argument) it would load this page and execute
 * the inline script, which would be a finding.
 */
async function startMaliciousRenderer() {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "/");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><html><body><script>globalThis.__attackerExecuted = true;</script>attacker</body></html>'
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(5173, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  return { hits: () => hits.length, close };
}

async function goToHash(page: Page, samplePath: string) {
  await page.evaluate((nextPath) => {
    globalThis.location.hash = nextPath;
  }, samplePath);
}

async function expectShellBoundary(page: Page, expectedSettingsDataRoot: string) {
  const boundary = await page.evaluate(async (expectedDataRoot) => {
    const swpanelWindow = globalThis as typeof globalThis & {
      swpanel?: Readonly<{
        metadata: Readonly<{
          platform: string;
          versions: Readonly<{ chrome: string; electron: string }>;
        }>;
        health?: Readonly<{
          get: () => Promise<{ ok: boolean; data?: { status: string; serverInstanceId: string | null } }>;
        }>;
        files?: Readonly<{ selectDrawingFile: () => Promise<unknown> }>;
        drawings?: Record<string, unknown>;
        storage?: Readonly<{
          getSettings: () => Promise<{
            ok: boolean;
            data?: { settings: { dataRoot: string; constraint: string } };
          }>;
        }>;
        models?: Readonly<Record<string, unknown>>;
        runs?: Readonly<Record<string, unknown>>;
        clarifications?: Readonly<Record<string, unknown>>;
          cost?: Readonly<Record<string, unknown>>;
          system?: Readonly<Record<string, unknown>>;
          secrets?: Readonly<Record<string, unknown>>;
        }>;
      process?: unknown;
      require?: unknown;
    };

    const api = swpanelWindow.swpanel;
    const drawingMethods = Object.keys(api?.drawings ?? {}).sort();
    const storageMethods = Object.keys(api?.storage ?? {}).sort();
    const fileMethods = Object.keys(api?.files ?? {}).sort();
    const healthMethods = Object.keys(api?.health ?? {}).sort();
    const modelMethods = Object.keys(api?.models ?? {}).sort();
    const runMethods = Object.keys(api?.runs ?? {}).sort();
    const clarificationMethods = Object.keys(api?.clarifications ?? {}).sort();
    const costMethods = Object.keys(api?.cost ?? {}).sort();
    const systemMethods = Object.keys(api?.system ?? {}).sort();
    const secretsMethods = Object.keys(api?.secrets ?? {}).sort();

    // Real bridge roundtrip against the REAL Runner (temp test root): the
    // health channel must reflect the started RunnerHost, the drawing list must
    // answer an empty library, and storage settings must mirror the temp root.
    const health = api?.health ? await api.health.get() : null;
    const drawingListFn = api?.drawings?.list as
      | (() => Promise<{ ok: boolean; data?: unknown }>)
      | undefined;
    const drawingList = drawingListFn === undefined ? null : await drawingListFn();
    const storageSettings = api?.storage ? await api.storage.getSettings() : null;

    return {
      nodeType: typeof swpanelWindow.process,
      requireType: typeof swpanelWindow.require,
      apiKeys: Object.keys(api ?? {}).sort(),
      metadataKeys: Object.keys(api?.metadata ?? {}),
      apiFrozen: api === undefined ? false : Object.isFrozen(api),
      metadataFrozen: api === undefined ? false : Object.isFrozen(api.metadata),
      versionsFrozen:
        api === undefined ? false : Object.isFrozen((api.metadata as { versions: unknown }).versions),
      healthFrozen: api?.health === undefined ? false : Object.isFrozen(api.health),
      filesFrozen: api?.files === undefined ? false : Object.isFrozen(api.files),
      drawingsFrozen: api?.drawings === undefined ? false : Object.isFrozen(api.drawings),
      storageFrozen: api?.storage === undefined ? false : Object.isFrozen(api.storage),
      modelsFrozen: api?.models === undefined ? false : Object.isFrozen(api.models),
      runsFrozen: api?.runs === undefined ? false : Object.isFrozen(api.runs),
      clarificationsFrozen:
        api?.clarifications === undefined ? false : Object.isFrozen(api.clarifications),
      costFrozen:
        api?.cost === undefined ? false : Object.isFrozen(api.cost),
      systemFrozen: api?.system === undefined ? false : Object.isFrozen(api.system),
      secretsFrozen: api?.secrets === undefined ? false : Object.isFrozen(api.secrets),
      methodSets: {
        health: healthMethods,
        files: fileMethods,
        drawings: drawingMethods,
        storage: storageMethods,
        models: modelMethods,
        runs: runMethods,
        clarifications: clarificationMethods,
        cost: costMethods,
        system: systemMethods,
        secrets: secretsMethods
      },
      bridgeMethodTypes: {
        healthGet:
          api === undefined || api.health === undefined
            ? "missing"
            : typeof api.health.get,
        selectDrawingFile:
          api === undefined || api.files === undefined
            ? "missing"
            : typeof api.files.selectDrawingFile,
        drawingList:
          api === undefined || api.drawings === undefined
            ? "missing"
            : typeof api.drawings.list,
        getSettings:
          api === undefined || api.storage === undefined
            ? "missing"
            : typeof api.storage.getSettings,
        runCreate:
          api === undefined || api.runs === undefined
            ? "missing"
            : typeof api.runs.create,
        runSubscribe:
          api === undefined || api.runs === undefined
            ? "missing"
            : typeof api.runs.subscribe,
        runDelete: api?.runs === undefined ? "missing" : typeof api.runs.delete,
        costDeleteReport: api?.cost === undefined ? "missing" : typeof api.cost.deleteReport,
        recoveryStatus: api?.system === undefined ? "missing" : typeof api.system.getRecoveryStatus,
        secretsGetStatus: api?.secrets === undefined ? "missing" : typeof api.secrets.getStatus,
        secretsSetApiKey: api?.secrets === undefined ? "missing" : typeof api.secrets.setApiKey,
        secretsClearApiKey: api?.secrets === undefined ? "missing" : typeof api.secrets.clearApiKey
      },
      // The bridge must expose NO raw generic capabilities.
      rawApiSurface: JSON.stringify(api ?? {}),
      // Truthful RunnerHost state over the real bridge.
      healthOk: health === null ? null : health.ok,
      healthStatus: health !== null && health.ok ? health.data?.status ?? null : null,
      healthServerInstanceId:
        health !== null && health.ok ? health.data?.serverInstanceId ?? null : null,
      healthError: health !== null && !health.ok ? "present" : null,
      drawingListOk: drawingList?.ok ?? null,
      drawingListData: drawingList !== null && drawingList.ok ? drawingList.data : null,
      storageSettingsOk: storageSettings?.ok ?? null,
      storageDataRoot: storageSettings !== null && storageSettings.ok ? storageSettings.data?.settings.dataRoot ?? null : null,
      storageConstraint:
        storageSettings !== null && storageSettings.ok
          ? storageSettings.data?.settings.constraint ?? null
          : null,
      storageDataRootMatchesExpected:
        storageSettings !== null && storageSettings.ok
          ? storageSettings.data?.settings.dataRoot === expectedDataRoot
          : false
    };
  }, expectedSettingsDataRoot);

  expect(boundary).toEqual({
    nodeType: "undefined",
    requireType: "undefined",
      apiKeys: ["clarifications", "cost", "drawings", "files", "health", "metadata", "models", "runs", "secrets", "storage", "system"],
    metadataKeys: ["platform", "versions"],
    apiFrozen: true,
    metadataFrozen: true,
    versionsFrozen: true,
    healthFrozen: true,
    filesFrozen: true,
    drawingsFrozen: true,
    storageFrozen: true,
    modelsFrozen: true,
    runsFrozen: true,
    clarificationsFrozen: true,
      costFrozen: true,
      systemFrozen: true,
      secretsFrozen: true,
      methodSets: {
      health: ["get"],
      files: ["selectDrawingFile"],
      drawings: [
        "addModelingFeedback",
        "addRevision",
        "addRevisionFact",
        "deleteRevision",
        "getDetail",
        "getHistory",
        "getRevisionDetail",
        "getRevisionHistory",
        "importDrawing",
        "list",
        "setCurrentRevision"
      ],
      storage: ["getSettings", "updateSettings"],
      models: ["getDetail", "review"],
        runs: ["cancel", "create", "delete", "getDetail", "list", "subscribe"],
      clarifications: ["get", "submit"],
        cost: ["createReport", "deleteReport", "getEffectiveCostData", "getReportDetail", "updateCostData"],
        secrets: ["clearApiKey", "getStatus", "setApiKey"],
        system: ["getRecoveryStatus"]
      },
      bridgeMethodTypes: {
      healthGet: "function",
      selectDrawingFile: "function",
      drawingList: "function",
      getSettings: "function",
      runCreate: "function",
        runSubscribe: "function",
        runDelete: "function",
        costDeleteReport: "function",
        recoveryStatus: "function",
        secretsGetStatus: "function",
        secretsSetApiKey: "function",
        secretsClearApiKey: "function"
      },
    rawApiSurface: expect.not.stringMatching(/invoke|readFile|spawn|shell|\bpipe\b/),
    healthOk: true,
    healthStatus: "READY",
    healthServerInstanceId: expect.any(String),
    healthError: null,
    drawingListOk: true,
    drawingListData: [],
    storageSettingsOk: true,
    storageDataRoot: expectedSettingsDataRoot,
    storageConstraint: "LOCAL_FIXED_NTFS",
    storageDataRootMatchesExpected: true
  });
}

test("packaged renderer loads over app://swpanel with the production security posture", async () => {
  const app = await launchRenderer(productionEnv());

  try {
    const page = await app.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#root")).not.toBeEmpty();

    expect(page.url()).toMatch(/^app:\/\/swpanel\/index\.html/);

    const csp = await page.evaluate(
      () =>
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? null
    );
    expect(csp).toBe(CONTENT_SECURITY_POLICY);
    expect(csp).not.toContain("ws://127.0.0.1");

    await expectShellBoundary(page, testRuntimeRoot as string);

    await expect(page.locator('[data-route-id="workbench"]')).toBeVisible();
    expect(
      consoleErrors.filter((message) => message.includes("Content Security Policy"))
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

test("packaged renderer reaches every production route over app://swpanel", async () => {
  const app = await launchRenderer(productionEnv());

  try {
    const page = await app.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#root")).not.toBeEmpty();
    expect(page.url()).toMatch(/^app:\/\/swpanel\/index\.html/);

    for (const route of PRODUCT_ROUTES) {
      await goToHash(page, route.samplePath);
      await expect(page).not.toHaveURL(/scenario=/);
      await expect(page.locator(`[data-route-id="${route.id}"]`)).toBeVisible();
    }

    expect(
      consoleErrors.filter((message) => message.includes("Content Security Policy"))
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

test("the app protocol cannot fetch files outside the renderer root", async () => {
  const app = await launchRenderer(productionEnv());

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#root")).not.toBeEmpty();

    const result = await page.evaluate(
      async ({ winIniUrl, packageUrl }) => {
        const attempts: Record<string, string> = {};
        for (const [label, url] of Object.entries({ winIniUrl, packageUrl })) {
          try {
            const response = await fetch(url);
            attempts[label] = `resolved:${response.status}`;
          } catch {
            attempts[label] = "rejected";
          }
        }

        const traversalOutcome: string[] = [];
        for (const url of [
          "app://swpanel/../package.json",
          "app://swpanel/%2e%2e/%2e%2e/package.json",
          "app://swpanel/../../..//C:/Windows/win.ini"
        ]) {
          try {
            const response = await fetch(url);
            traversalOutcome.push(`resolved:${response.status}`);
          } catch {
            traversalOutcome.push("rejected");
          }
        }

        const positiveStatus = await (async () => {
          try {
            const response = await fetch("app://swpanel/index.html");
            return `resolved:${response.status}`;
          } catch {
            return "rejected";
          }
        })();

        return { attempts, traversalOutcome, positiveStatus };
      },
      {
        winIniUrl: pathToFileURL(path.join("C:", "Windows", "win.ini")).toString(),
        packageUrl: pathToFileURL(path.resolve("package.json")).toString()
      }
    );

    expect(result.attempts).toEqual({
      winIniUrl: "rejected",
      packageUrl: "rejected"
    });
    expect(result.traversalOutcome).toEqual([
      "resolved:404",
      "resolved:404",
      "resolved:404"
    ]);
    expect(result.positiveStatus).toBe("resolved:200");
  } finally {
    await app.close();
  }
});

test("the app protocol refuses to execute scripts outside the renderer root", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-outside-"));
  const outsideScript = path.join(tempDirectory, "outside.js");
  await writeFile(outsideScript, "globalThis.__swpanelOutsideJsExecuted = true;\n");
  const outsideUrl = pathToFileURL(outsideScript).toString();

  try {
    const app = await launchRenderer(productionEnv());
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("#root")).not.toBeEmpty();

      const result = await page.evaluate(async (scriptUrl) => {
        const target = globalThis as typeof globalThis & {
          __swpanelOutsideJsExecuted?: boolean;
        };
        const script = document.createElement("script");
        script.src = scriptUrl;
        const outcome = await new Promise<string>((resolve) => {
          script.onload = () => resolve("load");
          script.onerror = () => resolve("error");
          document.head.appendChild(script);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { outcome, executed: target.__swpanelOutsideJsExecuted === true };
      }, outsideUrl);

      expect(result).toEqual({ outcome: "error", executed: false });
    } finally {
      await app.close();
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("top-level navigation is restricted to same-entry hash changes on the app origin", async () => {
  const app = await launchRenderer(productionEnv());

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#root")).not.toBeEmpty();
    const entryUrl = page.url();
    expect(entryUrl).toMatch(/^app:\/\/swpanel\/index\.html/);

    const attempts = await page.evaluate(() => {
      const targets = [
        "file:///C:/Windows/win.ini",
        "https://example.com/",
        "app://evil/index.html",
        "app://swpanel/index.html?scenario=x"
      ];
      const results: string[] = [];
      for (const target of targets) {
        try {
          globalThis.location.assign(target);
          results.push("assigned");
        } catch {
          results.push("threw");
        }
      }
      return results;
    });
    expect(attempts).toEqual(["assigned", "assigned", "assigned", "assigned"]);

    // Blocked navigations leave the current entry untouched.
    await page.waitForTimeout(500);
    expect(page.url()).toBe(entryUrl);

    // Same-entry hash navigation (the SPA router) still works.
    await goToHash(page, "/settings");
    await expect(page.locator('[data-route-id="settings"]')).toBeVisible();
    expect(page.url()).toMatch(/^app:\/\/swpanel\/index\.html/);
  } finally {
    await app.close();
  }
});

test("packaged app loads from a real app.asar with the full production security posture", async () => {
  const { tempDirectory, asarPath } = await buildProductionAsar();
  try {
    const app = await launchAsar(asarPath, productionEnv());
    try {
      const packaged = await app.evaluate(({ app: electronApp }) => ({
        isPackaged: electronApp.isPackaged,
        getAppPath: electronApp.getAppPath()
      }));
      expect(packaged.getAppPath).toMatch(/\.asar$/i);

      const page = await app.firstWindow();
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });

      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("#root")).not.toBeEmpty();

      // The renderer must be served over app://swpanel from inside the asar.
      expect(page.url()).toMatch(/^app:\/\/swpanel\/index\.html/);

      // The Vite bundle references its chunks relative to index.html; resolve
      // each reference against the app://swpanel origin and prove the asar
      // actually serves the JS and CSS chunks over the app protocol.
      const assets = await page.evaluate(async () => {
        const script = document.querySelector<HTMLScriptElement>(
          'script[type="module"][src]'
        );
        const stylesheet = document.querySelector<HTMLLinkElement>(
          'link[rel="stylesheet"][href]'
        );
        const targets = [
          { kind: "script", url: script ? new URL(script.src, location.href).href : null },
          {
            kind: "stylesheet",
            url: stylesheet ? new URL(stylesheet.href, location.href).href : null
          }
        ];
        const results: Record<string, string> = {};
        for (const { kind, url } of targets) {
          if (url === null) {
            results[kind] = "missing";
            continue;
          }
          try {
            const response = await fetch(url);
            results[kind] = `resolved:${response.status}`;
          } catch {
            results[kind] = "rejected";
          }
        }
        return { results, origin: location.origin };
      });
      expect(assets.origin).toBe("app://swpanel");
      expect(assets.results.script).toBe("resolved:200");
      expect(assets.results.stylesheet).toBe("resolved:200");

      const csp = await page.evaluate(
        () =>
          document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute("content") ?? null
      );
      expect(csp).toBe(CONTENT_SECURITY_POLICY);
      expect(csp).not.toContain("ws://127.0.0.1");

      // The preload bridge loaded and is frozen: swpanel.metadata comes from the
      // preload inside the asar.
      await expectShellBoundary(page, testRuntimeRoot as string);

      await expect(page.locator('[data-route-id="workbench"]')).toBeVisible();
      expect(
        consoleErrors.filter((message) => message.includes("Content Security Policy"))
      ).toEqual([]);
    } finally {
      await app.close();
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("WP5 drawing workflow persists across an app restart on the temp test root", async () => {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-wp5-e2e-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-wp5-root-"));
  const fixturePath = path.join(fixtureDirectory, "PDJF001.01.pdf");
  await writeFile(fixturePath, "%PDF-1.4\nWP5 restart persistence fixture.\n%%EOF\n");

  interface WorkflowBridge {
    files: {
      selectDrawingFile(): Promise<{
        ok: boolean;
        data?: {
          canceled: boolean;
          file: {
            token: string;
            fileName: string;
            format: string;
            sizeBytes: number;
            sha256: string;
          } | null;
        };
        error?: { code: string; message: string };
      }>;
    };
    drawings: {
      importDrawing(input: unknown): Promise<{
        ok: boolean;
        data?: { drawing: { id: string } };
        error?: { code: string; message: string };
      }>;
      list(): Promise<{
        ok: boolean;
        data?: Array<{
          drawingId: string;
          drawingNumber: string;
          name: string;
          totalRevisionCount: number;
        }>;
        error?: { code: string; message: string };
      }>;
      getHistory(drawingId: string): Promise<{
        ok: boolean;
        data?: { revisions: unknown[]; currentRevisionId: string | null };
        error?: { code: string; message: string };
      }>;
    };
  }

  try {
    // First launch: stage + import a real PDF through the real bridge. Only the
    // native dialog call is stubbed (Playwright cannot drive a native window);
    // path/format/regular-file validation, SHA-256, the one-use token, the
    // Runner registration and the drawing.create command all stay real.
    const first = await launchRendererWithRoot(root, productionEnv());
    let drawingId: string;
    try {
      const page = await first.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("#root")).not.toBeEmpty();

      await first.evaluate(({ dialog }, fixture) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [fixture] });
      }, fixturePath);

      const outcome = await page.evaluate(async () => {
        const api = (globalThis as typeof globalThis & {
          swpanel: {
            files: WorkflowBridge["files"];
            drawings: WorkflowBridge["drawings"];
          };
        }).swpanel;

        const selected = await api.files.selectDrawingFile();
        if (!selected.ok || selected.data === undefined || selected.data.canceled || selected.data.file === null) {
          return { ok: false, reason: selected.ok ? "canceled" : (selected.error?.code ?? "unknown") };
        }
        // The renderer must never see the absolute fixture path.
        const selectedSurface = JSON.stringify(selected.data.file);
        if (/[A-Za-z]:[\\/]/.test(selectedSurface)) {
          return { ok: false, reason: "absolute path leaked over the bridge" };
        }
        const imported = await api.drawings.importDrawing({
          drawingNumber: "PDJF001.01",
          name: "轧辊（一）",
          selectedFileToken: selected.data.file.token,
          createdAt: "2026-08-13T01:00:00.000Z"
        });
        if (!imported.ok || imported.data === undefined) {
          return { ok: false, reason: imported.ok ? "no data" : (imported.error?.code ?? "unknown") };
        }
        return { ok: true, drawingId: imported.data.drawing.id };
      });

      expect(outcome).toEqual({ ok: true, drawingId: expect.any(String) });
      drawingId = (outcome as { ok: true; drawingId: string }).drawingId;
    } finally {
      await first.close();
    }
    // Second launch against the SAME temp root: the library must survive.
    const second = await launchRendererWithRoot(root, productionEnv());
    try {
      const page = await second.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("#root")).not.toBeEmpty();

      const persisted = await page.evaluate(async (expectedDrawingId) => {
        const api = (globalThis as typeof globalThis & {
          swpanel: {
            drawings: WorkflowBridge["drawings"];
          };
        }).swpanel;
        const list = await api.drawings.list();
        if (!list.ok || list.data === undefined) {
          return { ok: false, reason: list.ok ? "no data" : (list.error?.code ?? "unknown") };
        }
        const item = list.data.find((entry) => entry.drawingId === expectedDrawingId);
        if (item === undefined) {
          return { ok: false, reason: "drawing missing after restart" };
        }
        const history = await api.drawings.getHistory(expectedDrawingId);
        if (!history.ok || history.data === undefined) {
          return { ok: false, reason: history.ok ? "no data" : (history.error?.code ?? "unknown") };
        }
        return {
          ok: true,
          drawingNumber: item.drawingNumber,
          name: item.name,
          totalRevisionCount: item.totalRevisionCount,
          historyRevisionCount: history.data.revisions.length,
          currentRevisionId: history.data.currentRevisionId
        };
      }, drawingId);

      expect(persisted).toEqual({
        ok: true,
        drawingNumber: "PDJF001.01",
        name: "轧辊（一）",
        totalRevisionCount: 1,
        historyRevisionCount: 1,
        currentRevisionId: expect.any(String)
      });
    } finally {
      await second.close();
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("WP6 drawing workflow is driven through the visible UI and persists on the temp root", async () => {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-wp6-e2e-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-wp6-root-"));
  const fixturePath = path.join(fixtureDirectory, "PDJF002.01.pdf");
  await writeFile(fixturePath, "%PDF-1.4\nWP6 visible-UI workflow fixture.\n%%EOF\n");

  /** Stubs only the native dialog; path/format validation, SHA-256, the one-use
   *  token, Runner registration and every drawing command stay REAL. */
  async function stubNativePicker(app: Awaited<ReturnType<typeof launchRendererWithRoot>>) {
    await app.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [fixture] });
    }, fixturePath);
  }

  try {
    // ── First launch: upload/import, add Revision, set current, facts/feedback
    const first = await launchRendererWithRoot(root, productionEnv());
    try {
      const page = await first.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("#root")).not.toBeEmpty();
      await stubNativePicker(first);

      // Upload/import through the visible UI (the Runner library is empty).
      await goToHash(page, "/drawings");
      await expect(page.getByText("图纸库还是空的")).toBeVisible();
      await page.getByRole("button", { name: "上传图纸" }).first().click();
      const importDialog = page.getByRole("dialog", { name: "上传图纸" });
      await expect(importDialog).toBeVisible();
      await importDialog.getByRole("button", { name: "选择图纸文件" }).click();
      await expect(importDialog.getByText("PDJF002.01.pdf")).toBeVisible();
      await importDialog.getByLabel("图号").fill("PDJF002.01");
      await importDialog.getByLabel("名称").fill("轧辊（二）");
      await importDialog.getByRole("button", { name: "导入图纸" }).click();

      // The page navigates to the created Drawing's Overview (real UUID ids).
      await expect(page.getByRole("heading", { name: "PDJF002.01" })).toBeVisible();
      await expect(page.getByText("版本历史")).toBeVisible();
      await expect(page.locator(".history-row").filter({ hasText: "V1" }).getByText("当前")).toBeVisible();

      // 新增版本 through the UI (current pointer untouched), then set V2 current.
      await page.getByRole("button", { name: "新增版本" }).click();
      const revisionDialog = page.getByRole("dialog", { name: "新增版本" });
      await revisionDialog.getByRole("button", { name: "选择图纸文件" }).click();
      await expect(revisionDialog.getByText("PDJF002.01.pdf")).toBeVisible();
      await revisionDialog.getByRole("button", { name: "确认新增版本" }).click();
      await expect(page.locator(".history-row").filter({ hasText: "V2" })).toBeVisible();
      await page.getByRole("button", { name: "设为当前版本" }).first().click();
      await expect(page.getByText(/已设为当前版本/)).toBeVisible();
      await expect(page.locator(".history-row").filter({ hasText: "V2" }).getByText("当前")).toBeVisible();

      // Revision memory: add a fact and a feedback entry through the UI.
      await page.getByRole("link", { name: "版本记忆" }).click();
      await expect(page.getByText("Revision Facts")).toBeVisible();
      await page.getByRole("button", { name: "添加事实" }).click();
      let dialog = page.getByRole("dialog", { name: "添加工程事实" });
      await dialog.getByLabel("字段名称").fill("材料");
      await dialog.getByLabel("值").fill("42CrMo");
      await dialog.getByRole("button", { name: "保存事实" }).click();
      await expect(page.getByText("42CrMo")).toBeVisible();

      await page.getByRole("button", { name: "添加反馈" }).click();
      dialog = page.getByRole("dialog", { name: "添加建模反馈" });
      await dialog.getByLabel("反馈内容").fill("注意 R5 圆角方向");
      await dialog.getByRole("button", { name: "保存反馈" }).click();
      await expect(page.getByText(/注意 R5 圆角方向/)).toBeVisible();

      // The Drawing workflow never creates a Run in this phase.
      await expect(page.getByText(/Run [R]\d/)).toHaveCount(0);
      await page.getByRole("link", { name: "概览" }).click();
      await expect(page.getByText("版本历史")).toBeVisible();
      await expect(page.getByText("暂无记录")).toBeVisible();
    } finally {
      await first.close();
    }

    // ── Second launch against the SAME root: the library survives and the
    //    created Drawing is visible through the UI (WP7 expands restart flow).
    const second = await launchRendererWithRoot(root, productionEnv());
    try {
      const page = await second.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("#root")).not.toBeEmpty();
      await goToHash(page, "/drawings");
      await expect(page.getByRole("link", { name: "PDJF002.01", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "PDJF002.01", exact: true }).click();
      await expect(page.getByText("版本历史", { exact: true })).toBeVisible();
      await expect(page.locator(".history-row").filter({ hasText: "V2" }).getByText("当前")).toBeVisible();
    } finally {
      await second.close();
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 4 real Runner protocol chain publishes product events and clarification answers become Revision Facts", async () => {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-p4-e2e-fixture-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-p4-e2e-root-"));
  const fixturePath = path.join(fixtureDirectory, "P4-E2E.pdf");
  await writeFile(fixturePath, "%PDF-1.4\\nP4 real Runner protocol fixture.\\n%%EOF\\n");
  const app = await launchRendererWithRoot(root, {
    ...productionEnv(),
    [FAKE_EXECUTOR_SCENARIO_ENV]: "clarification",
    [FAKE_EXECUTOR_STEP_DELAY_ENV]: "0"
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#root")).not.toBeEmpty();
    await app.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [fixture] });
    }, fixturePath);

    const created = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { swpanel: SwpanelBridgeApi }).swpanel;
      const selected = await api.files.selectDrawingFile();
      if (!selected.ok) throw new Error(`file selection failed: ${selected.error.code}`);
      if (selected.data.file === null || selected.data.file === undefined) {
        throw new Error("file selection returned no file");
      }
      const imported = await api.drawings.importDrawing({
        drawingNumber: "P4-E2E",
        name: "Phase 4 Runner",
        selectedFileToken: selected.data.file.token,
        createdAt: "2026-08-13T01:00:00.000Z"
      });
      if (!imported.ok) throw new Error(`import failed: ${imported.error.code}`);
      const run = await api.runs.create({ drawingId: imported.data.drawing.id, revisionId: imported.data.revision.id });
      if (!run.ok) throw new Error(`run failed: ${run.error.code}`);
      return { drawingId: imported.data.drawing.id, revisionId: imported.data.revision.id, runId: run.data.id };
    });

    const detail = await page.evaluate(async (runId): Promise<RunDetailBridgeResult> => {
      const api = (globalThis as typeof globalThis & { swpanel: SwpanelBridgeApi }).swpanel;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = await api.runs.getDetail(runId);
        if (result.ok && result.data.run.status === "CLARIFICATION_REQUIRED") return result.data;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Runner did not reach CLARIFICATION_REQUIRED");
    }, created.runId);

    const protocolTypes = detail.events.map((event) => event.type);
    expect(protocolTypes).toContain("StageChanged");
    expect(protocolTypes).toContain("ClarificationRequired");
    expect(protocolTypes).not.toContain("ResultManifestReceived");
    expect(protocolTypes.at(-1)).toBe("ClarificationRequired");

    const revisionFacts = await page.evaluate(async ({ runId, drawingId, revisionId }) => {
      const api = (globalThis as typeof globalThis & { swpanel: SwpanelBridgeApi }).swpanel;
      const runDetail = await api.runs.getDetail(runId);
      if (!runDetail.ok || runDetail.data.run.clarificationRequestId === null) {
        throw new Error("Runner did not expose an open clarification request");
      }
      const request = await api.clarifications.get(runDetail.data.run.clarificationRequestId);
      if (!request.ok) throw new Error(`clarification get failed: ${request.error.code}`);
      const dimension = request.data.questions.find((question) => question.type === "dimension");
      const choice = request.data.questions.find((question) => question.type === "choice");
      if (dimension === undefined || choice === undefined || choice.options === null) {
        throw new Error("Runner returned incomplete clarification questions");
      }
      const submitted = await api.clarifications.submit({
        clarificationRequestId: request.data.clarificationRequestId,
        answers: [
          { id: "p4-answer-dimension", questionId: dimension.questionId, value: { kind: "dimension", value: 12, unit: "mm" }, answeredAt: "2026-08-13T02:00:00.000Z", answeredBy: "e2e-user" },
          { id: "p4-answer-choice", questionId: choice.questionId, value: { kind: "choice", optionId: choice.options.at(1)?.id ?? "full" }, answeredAt: "2026-08-13T02:00:00.000Z", answeredBy: "e2e-user" }
        ],
        answeredAt: "2026-08-13T02:00:00.000Z",
        answeredBy: "e2e-user"
      });
      if (!submitted.ok) throw new Error(`clarification submit failed: ${submitted.error.code}`);
      const history = await api.drawings.getRevisionHistory(drawingId, revisionId);
      if (!history.ok) throw new Error(`revision history failed: ${history.error.code}`);
      const nextRun = await api.runs.create({ drawingId, revisionId });
      if (!nextRun.ok) throw new Error(`new run failed: ${nextRun.error.code}`);
      return { clarificationStatus: submitted.data.status, facts: history.data.facts, nextRun: { id: nextRun.data.id, status: nextRun.data.status } };
    }, created);

    expect(revisionFacts.clarificationStatus).toBe("ANSWERED");
    expect(revisionFacts.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "底板厚度是多少？", value: "12 mm", source: "CLARIFICATION", sourceRunId: created.runId }),
      expect.objectContaining({ field: "焊缝处理方式？", value: "全周满焊", source: "CLARIFICATION", sourceRunId: created.runId })
    ]));
    expect(revisionFacts.nextRun.status).toBe("QUEUED");
    expect(revisionFacts.nextRun.id).not.toBe(created.runId);
  } finally {
    await app.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("missing stored source file shows a structured UI error without crashing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-wp7-missing-root-"));
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-wp7-missing-fixture-"));
  const fixturePath = path.join(fixtureDirectory, "PDJF003.01.pdf");
  await writeFile(fixturePath, "%PDF-1.4\\nWP7 missing-source fixture.\\n%%EOF\\n");

  async function filesUnder(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await filesUnder(absolute));
      else files.push(absolute);
    }
    return files;
  }

  try {
    const first = await launchRendererWithRoot(root, productionEnv());
    try {
      const page = await first.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await first.evaluate(({ dialog }, fixture) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [fixture] });
      }, fixturePath);
      await goToHash(page, "/drawings");
      await page.getByRole("button", { name: "上传图纸" }).first().click();
      const dialog = page.getByRole("dialog", { name: "上传图纸" });
      await dialog.getByRole("button", { name: "选择图纸文件" }).click();
      await dialog.getByLabel("图号").fill("PDJF003.01");
      await dialog.getByLabel("名称").fill("缺失源文件验证");
      await dialog.getByRole("button", { name: "导入图纸" }).click();
      await expect(page.getByText("版本历史", { exact: true })).toBeVisible();
    } finally {
      await first.close();
    }

    const storedFiles = (await filesUnder(root)).filter((file) => file.toLowerCase().endsWith(".pdf"));
    expect(storedFiles.length).toBeGreaterThan(0);
    for (const storedFile of storedFiles) await unlink(storedFile);

    const second = await launchRendererWithRoot(root, productionEnv());
    try {
      const page = await second.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await goToHash(page, "/drawings");
      // The list is metadata-only and keeps working; the damaged source file is
      // reported where it is actually read: the drawing detail.
      await expect(page.getByRole("link", { name: "打开图纸 PDJF003.01" })).toBeVisible();
      await page.getByRole("link", { name: "打开图纸 PDJF003.01" }).click();
      await expect(page.getByText("图纸详情加载失败")).toBeVisible();
      await expect(page.getByText("文件缺失，无法读取，请联系管理员")).toBeVisible();
      // The raw code lives in the collapsed technical details.
      await page.getByText("技术详情").first().click();
      await expect(page.getByText("LEDGER_FILE_MISSING")).toBeVisible();
      await expect(page.locator("#root")).not.toBeEmpty();
    } finally {
      await second.close();
    }
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test.describe("the development renderer is authorized only by the explicit CLI argument", () => {
  // Every row injects BOTH the legacy environment override and the
  // development marker (SWPANEL_RENDERER_URL pointing at the pinned dev URL +
  // SWPANEL_DEVELOPMENT_RENDERER) and a live hostile server on 5173, so any
  // wrongly-honored environment or CLI would load the attacker's page and hit
  // the server. The main process must instead stay on app://swpanel with zero
  // hits in every combination.
  const devEnvironmentOverrides = {
    SWPANEL_RENDERER_URL: DEVELOPMENT_RENDERER_URL,
    SWPANEL_DEVELOPMENT_RENDERER: "1"
  } as const;

  const matrix = [
    {
      name: "a loose launch ignores both environment variables and the development marker",
      mode: "loose" as const,
      cliArgs: []
    },
    {
      name: "a temp-asar launch ignores both environment variables and the development marker",
      mode: "temp asar" as const,
      cliArgs: []
    },
    {
      name: "a loose launch rejects duplicate development-renderer CLI arguments",
      mode: "loose" as const,
      cliArgs: [
        `${DEVELOPMENT_RENDERER_CLI_FLAG}=${DEVELOPMENT_RENDERER_URL}`,
        `${DEVELOPMENT_RENDERER_CLI_FLAG}=${DEVELOPMENT_RENDERER_URL}`
      ]
    },
    {
      name: "a loose launch rejects a variant development-renderer CLI argument",
      mode: "loose" as const,
      cliArgs: [DEVELOPMENT_RENDERER_CLI_FLAG, DEVELOPMENT_RENDERER_URL]
    },
    {
      name: "a temp-asar launch rejects an external development-renderer CLI argument",
      mode: "temp asar" as const,
      cliArgs: [`${DEVELOPMENT_RENDERER_CLI_FLAG}=https://example.com/`]
    }
  ];

  for (const row of matrix) {
    test(`${row.name} always loads app://swpanel and never contacts the hostile dev server`, async () => {
      const attacker = await startMaliciousRenderer();
      let tempDirectory: string | undefined;
      try {
        const env = { ...productionEnv(), ...devEnvironmentOverrides };
        let app: Awaited<ReturnType<typeof launchRenderer>> | undefined;
        try {
          if (row.mode === "loose") {
            app = await launchRenderer(env, ...row.cliArgs);
          } else {
            const built = await buildProductionAsar();
            tempDirectory = built.tempDirectory;
            app = await launchAsar(built.asarPath, env, ...row.cliArgs);
          }

          const page = await app.firstWindow();
          await page.waitForLoadState("domcontentloaded");
          await expect(page.locator("#root")).not.toBeEmpty();
          expect(page.url()).toMatch(/^app:\/\/swpanel\/index\.html/);
          await expect(page.locator('[data-route-id="workbench"]')).toBeVisible();

          const attackerExecuted = await page.evaluate(() => {
            const target = globalThis as typeof globalThis & {
              __attackerExecuted?: boolean;
            };
            return target.__attackerExecuted === true;
          });
          expect(attackerExecuted).toBe(false);
        } finally {
          if (app !== undefined) await app.close();
        }
        // The production renderer must never have contacted the hostile server.
        expect(attacker.hits()).toBe(0);
      } finally {
        if (tempDirectory !== undefined) {
          await rm(tempDirectory, { recursive: true, force: true });
        }
        await attacker.close();
      }
    });
  }
});

test.describe("Phase 3 Run orchestration through the real Runner + Fake Executor", () => {
  /** Production env plus the test-only Fake Executor harness variables. */
  function executorEnv(overrides: Record<string, string>): Record<string, string> {
    return { ...productionEnv(), ...overrides };
  }

  interface RunEventShape {
    type: string;
    stage?: string;
    modelId?: string;
    metadata?: unknown;
    manifestRef?: string;
    sequence: number;
  }

  interface RunDetailShape {
    run: Record<string, unknown>;
    events: Array<RunEventShape>;
    lastEventSequence: number;
  }

  interface RunBridge {
    runs: {
      list(): Promise<{
        ok: boolean;
        data?: Array<{ runId: string; runLabel: string; status: string; stage: string | null }>;
        error?: { code: string };
      }>;
      getDetail(runId: string): Promise<{ ok: boolean; data?: RunDetailShape; error?: { code: string } }>;
      create(input: { drawingId: string; revisionId: string }): Promise<{
        ok: boolean;
        data?: { id: string; number: string; status: string; inputSnapshot?: Record<string, unknown> };
        error?: { code: string; message: string };
      }>;
      cancel(input: { runId: string; reason?: string }): Promise<{
        ok: boolean;
        data?: { runId: string; status: string; alreadyCancelled?: boolean; failureCode?: string };
        error?: { code: string; message: string };
      }>;
      subscribe(input: { runId: string; fromSequence: number }, onPush: (push: unknown) => void): () => void;
    };
  }

  interface DrawingBridge {
    files: {
      selectDrawingFile(): Promise<{
        ok: boolean;
        data?: { canceled: boolean; file: { token: string; fileName: string } | null };
        error?: { code: string };
      }>;
    };
    drawings: {
      importDrawing(input: {
        drawingNumber: string;
        name: string;
        selectedFileToken: string;
        createdAt: string;
      }): Promise<{
        ok: boolean;
        data?: { drawing: { id: string }; revision: { id: string } };
        error?: { code: string; message: string };
      }>;
      addRevision(input: {
        drawingId: string;
        selectedFileToken: string;
        createdAt: string;
      }): Promise<{
        ok: boolean;
        data?: { revision: { id: string } };
        error?: { code: string; message: string };
      }>;
      list(): Promise<{ ok: boolean; data?: Array<{ drawingId: string; drawingNumber: string }>; error?: { code: string } }>;
    };
  }

  /** Creates one Drawing + first Revision through the REAL bridge (only the
   *  native dialog is stubbed), returning the identity pair. */
  async function createDrawingThroughBridge(
    app: Awaited<ReturnType<typeof launchRendererWithRoot>>,
    page: Page,
    fixturePath: string,
    drawingNumber: string,
    name: string
  ): Promise<{ drawingId: string; revisionId: string }> {
    await app.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [fixture] });
    }, fixturePath);
    const outcome = await page.evaluate(
      async ({ drawingNumber, name }) => {
        const api = (globalThis as typeof globalThis & {
          swpanel: DrawingBridge;
        }).swpanel;
        const selected = await api.files.selectDrawingFile();
        if (!selected.ok || selected.data === undefined || selected.data.canceled || selected.data.file === null) {
          return { ok: false as const, reason: "pick failed" };
        }
        const imported = await api.drawings.importDrawing({
          drawingNumber,
          name,
          selectedFileToken: selected.data.file.token,
          createdAt: "2026-08-13T08:00:00.000Z"
        });
        if (!imported.ok || imported.data === undefined) {
          return { ok: false as const, reason: imported.error?.code ?? "import failed" };
        }
        return {
          ok: true as const,
          drawingId: imported.data.drawing.id,
          revisionId: imported.data.revision.id
        };
      },
      { drawingNumber, name }
    );
    expect(outcome.ok).toBe(true);
    return outcome as { ok: true; drawingId: string; revisionId: string };
  }

  /** Polls `runs.getDetail` until the predicate holds (deterministic harness). */
  async function waitForRun(
    page: Page,
    runId: string,
    predicate: (detail: RunDetailShape) => boolean,
    timeoutMs = 25_000
  ): Promise<RunDetailShape> {
    let last: RunDetailShape | null = null;
    await expect
      .poll(
        async () => {
          const detail = await page.evaluate(async (id) => {
            const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
            const result = await api.runs.getDetail(id);
            return result.ok && result.data !== undefined ? result.data : null;
          }, runId);
          last = detail;
          return last === null ? false : predicate(last);
        },
        { timeout: timeoutMs, intervals: [150, 250, 400] }
      )
      .toBe(true);
    // The poll only returns once `last` satisfied the predicate (non-null).
    return last ?? { run: {}, events: [], lastEventSequence: 0 };
  }

  /** Run list rows through the bridge (newest first). */
  async function listRuns(page: Page): Promise<Array<{ runId: string; runLabel: string; status: string; stage: string | null }>> {
    return page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
      const result = await api.runs.list();
      return result.ok && result.data !== undefined ? result.data : [];
    });
  }

  const ALL_SIX_STAGES = ["PREPARING", "ANALYZING", "PLANNING", "MODELING", "VALIDATING", "PACKAGING"] as const;

  test("a real Run executes through all six stages and publishes a PENDING_REVIEW Model", async () => {
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-p3-fixture-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-p3-root-"));
    const fixturePath = path.join(fixtureDirectory, "PDJF030.01.pdf");
    await writeFile(fixturePath, "%PDF-1.4\nPhase 3 six-stage fixture.\n%%EOF\n");

    try {
      const app = await launchRendererWithRoot(
        root,
        executorEnv({ [FAKE_EXECUTOR_SCENARIO_ENV]: "success", [FAKE_EXECUTOR_STEP_DELAY_ENV]: "250" })
      );
      try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await expect(page.locator("#root")).not.toBeEmpty();

        const { drawingId, revisionId } = await createDrawingThroughBridge(
          app,
          page,
          fixturePath,
          "PDJF030.01",
          "P3 六阶段验证"
        );

        const created = await page.evaluate(
          async ({ drawingId, revisionId }) => {
            const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
            return api.runs.create({ drawingId, revisionId });
          },
          { drawingId, revisionId }
        );
        expect(created.ok).toBe(true);
        expect(created.data?.status).toBe("QUEUED");
        const runId = created.data?.id as string;
        expect(created.data?.number).toBe("R01");
        // The Runner froze the Input Snapshot itself (identity pair only was
        // submitted): version values come from the Runner profile, never the
        // Renderer.
        const snapshot = created.data?.inputSnapshot;
        expect(snapshot).toBeDefined();
        expect(snapshot?.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION);
        expect((snapshot?.skill as { name?: string } | undefined)?.name).toBe(
          "solidworks-autobuild"
        );
        expect(snapshot?.agentConfigId).toBe("codex-app-server");
        expect(snapshot?.drawingId).toBe(drawingId);
        expect(snapshot?.revisionId).toBe(revisionId);
        expect(snapshot?.originalFileRef).toContain("library/drawings");

        // Subscribe from sequence 0 and collect every push.
        await page.evaluate(
          (id) => {
            const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
            const target = globalThis as typeof globalThis & {
              __p3Pushes?: unknown[];
              __p3Unsubscribe?: () => void;
            };
            target.__p3Pushes = [];
            target.__p3Unsubscribe = api.runs.subscribe({ runId: id, fromSequence: 0 }, (push) => {
              target.__p3Pushes?.push(push);
            });
          },
          runId
        );

       

        const detail = await waitForRun(page, runId, (d) => {
          const run = d.run;
          return run.status === "COMPLETED";
        });

        const run = detail.run;
        expect(run.status).toBe("COMPLETED");
        // Terminal projection (F3): the Runner records completed_at and clears
        // ALL live execution fields (stage/activity/progress) — the walked
        // stages live in the events.
        expect(run.stage).toBeNull();
        expect(run.activity).toBeNull();
        // The Runner product default (P5-2) published a PENDING_REVIEW Model:
        // the Completed read-model resolves the Model id.
        expect(run.modelId).not.toBeNull();
        expect(run.failureCode).toBeNull();
        expect(run.progressPercent).toBeNull();
        expect(run.startedAt).not.toBeNull();
        expect(run.completedAt).not.toBeNull();

        // The event stream carried all six stages in order and a Completed
        // event publishing the Model id (Phase 5 P5-2), with no cancellation
        // anywhere.
        const events = detail.events;
        const phase4Types = events
          .map((event) => event.type)
          .filter((type) =>
            [
              "RuntimeMetadataUpdated",
              "AgentTurnCompleted",
              "ResultManifestReceived",
              "Completed"
            ].includes(type)
          );
        expect(phase4Types).toEqual([
          "RuntimeMetadataUpdated",
          "AgentTurnCompleted",
          "ResultManifestReceived",
          "Completed"
        ]);
        const metadataEvent = events.find((event) => event.type === "RuntimeMetadataUpdated");
        expect(metadataEvent?.metadata).toBeDefined();
        expect(validateRuntimeMetadata(metadataEvent?.metadata)).toMatchObject({
          contractVersion: 1,
          runtime: {
            adapterId: "codex-app-server",
            protocol: "codex-app-server",
            modelSupportsImageInput: true
          },
          session: { threadId: `thread-${runId}` }
        });
        const manifestEvent = events.find((event) => event.type === "ResultManifestReceived");
        expect(manifestEvent?.manifestRef).toBe("output/result-manifest.json");

        // Verify the complete Runner-owned Phase 4 workspace chain, not only
        // the terminal status: adapter envelope -> Invocation Package -> prompt
        // -> Result Manifest and its independently validated artifact set.
        const attemptRoot = path.join(root, "workspaces", "runs", runId, "attempt-001");
        const adapterResult = validateInputAdapterResult(
          JSON.parse(await readFile(path.join(attemptRoot, "input", "adapter-result.json"), "utf8"))
        );
        expect(adapterResult.ok).toBe(true);
        const invocationPackage = validateInvocationPackage(
          JSON.parse(await readFile(path.join(attemptRoot, "runtime", "invocation-package.json"), "utf8"))
        );
        expect(invocationPackage.runId).toBe(runId);
        expect(invocationPackage.input.imagePath).toBe("input/drawing.png");
        expect(invocationPackage.input.imageSha256).toBe(
          adapterResult.ok ? adapterResult.provenance.output.sha256 : ""
        );
        const prompt = await readFile(path.join(attemptRoot, "runtime", "prompt.md"), "utf8");
        expect(prompt).toContain(`Template ${PROMPT_TEMPLATE_VERSION}`);
        expect(prompt).toContain(runId);
        const resultManifest = validateResultManifest(
          JSON.parse(await readFile(path.join(attemptRoot, "output", "result-manifest.json"), "utf8"))
        );
        expect(resultManifest.result).toBe("completed");
        expect(resultManifest.artifacts).toBeDefined();
        const stageChanges = events.filter((event) => event.type === "StageChanged");
        expect(stageChanges.map((event) => event.stage)).toEqual([...ALL_SIX_STAGES]);
        const completed = events.filter((event) => event.type === "Completed");
        expect(completed).toHaveLength(1);
        // The Completed event carries the published Model id (P5-2).
        expect(completed[0]?.modelId).toBe(run.modelId);
        expect(events.some((event) => event.type === "CancellationRequested")).toBe(false);
        expect(events.some((event) => event.type === "CancellationConfirmed")).toBe(false);
        // Strictly increasing sequences (backlog + live batches, no duplicates).
        const sequences = events.map((event) => event.sequence);
        expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
        expect(new Set(sequences).size).toBe(sequences.length);
        expect(detail.lastEventSequence).toBe(sequences[sequences.length - 1]);

        // The collected live pushes contain the same ordered history.
        const pushes = await page.evaluate(() => {
          const target = globalThis as typeof globalThis & { __p3Pushes?: unknown[] };
          return target.__p3Pushes ?? [];
        });
        const pushedEvents = (pushes as Array<{ events: unknown[] }>).flatMap((push) => push.events);
        expect(pushedEvents.length).toBeGreaterThanOrEqual(sequences.length);

        // The Fake Executor wrote its result artifact into the isolated
        // attempt workspace under the temp runtime root.
        const resultFile = path.join(
          root,
          "workspaces",
          "runs",
          runId,
          "attempt-001",
          "output",
          "fake-result.txt"
        );
        expect(existsSync(resultFile)).toBe(true);

        // Cancelling a terminal Run is a stable structured error, never a
        // mutation of history.
        const cancelResult = await page.evaluate(
          (id) => {
            const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
            return api.runs.cancel({ runId: id, reason: "用户主动取消" });
          },
          runId
        );
        expect(cancelResult.ok).toBe(false);
        expect(cancelResult.error?.code).toBe("DOMAIN_INVARIANT");

        // ---------------------------------------------------------------------
        // Phase 6 Model Review closed loop on the published Model
        // ---------------------------------------------------------------------
        interface ModelBridge {
          models: {
            getDetail(modelId: string): Promise<{
              ok: boolean;
              data?: {
                model: {
                  modelId: string;
                  reviewStatus: string;
                  isCurrentApproved: boolean;
                };
                reviews: Array<{ reviewId: string; result: string; reviewerId: string; comment: string | null }>;
              };
              error?: { code: string; message: string };
            }>;
            review(input: {
              modelId: string;
              result: "APPROVED" | "REJECTED";
              comment?: string;
              reviewerId: string;
              reviewedAt: string;
            }): Promise<{
              ok: boolean;
              data?: {
                model: {
                  modelId: string;
                  reviewStatus: string;
                  isCurrentApproved: boolean;
                };
                reviews: Array<{ reviewId: string; result: string; reviewerId: string; comment: string | null }>;
              };
              error?: { code: string; message: string };
            }>;
          };
          drawings: {
            getRevisionDetail(drawingId: string, revisionId: string): Promise<{
              ok: boolean;
              data?: {
                revision: { currentApprovedModelId: string | null };
                models: Array<{ modelId: string; reviewStatus: string; isCurrentApproved: boolean }>;
              };
            }>;
          };
        }

        const modelId = run.modelId as string;
        const initialModelDetail = await page.evaluate(
          (mId) => {
            const api = (globalThis as typeof globalThis & { swpanel: ModelBridge }).swpanel;
            return api.models.getDetail(mId);
          },
          modelId
        );
        expect(initialModelDetail.ok).toBe(true);
        expect(initialModelDetail.data?.model.reviewStatus).toBe("PENDING_REVIEW");
        expect(initialModelDetail.data?.model.isCurrentApproved).toBe(false);
        expect(initialModelDetail.data?.reviews).toHaveLength(0);

        // Approve the model through the bridge
        const approveTime = new Date().toISOString();
        const reviewResult = await page.evaluate(
          ({ mId, time }) => {
            const api = (globalThis as typeof globalThis & { swpanel: ModelBridge }).swpanel;
            return api.models.review({
              modelId: mId,
              result: "APPROVED",
              reviewerId: "current-windows-user",
              reviewedAt: time
            });
          },
          { mId: modelId, time: approveTime }
        );
        expect(reviewResult.ok).toBe(true);
        expect(reviewResult.data?.model.reviewStatus).toBe("APPROVED");
        expect(reviewResult.data?.model.isCurrentApproved).toBe(true);
        expect(reviewResult.data?.reviews).toHaveLength(1);
        expect(reviewResult.data?.reviews[0]?.result).toBe("APPROVED");

        // Verify revision currentApprovedModelId is repointed atomically
        const revisionDetail = await page.evaluate(
          ({ dId, rId }) => {
            const api = (globalThis as typeof globalThis & { swpanel: ModelBridge }).swpanel;
            return api.drawings.getRevisionDetail(dId, rId);
          },
          { dId: drawingId, rId: revisionId }
        );
        expect(revisionDetail.ok).toBe(true);
        expect(revisionDetail.data?.revision.currentApprovedModelId).toBe(modelId);
        expect(revisionDetail.data?.models[0]?.isCurrentApproved).toBe(true);

        // ---------------------------------------------------------------------
        // Phase 7 Cost Data & Deterministic Cost Engine closed loop
        // ---------------------------------------------------------------------
        interface CostDataSnapshotView {
          materials: readonly {
            id: string;
            name: string;
            purchasePrice: number;
            priceUnit: string;
            density?: number;
            densityUnit?: string;
            effectiveFrom: string;
            updatedAt: string;
          }[];
          allowances: readonly {
            id: string;
            stockType: string;
            allowances: readonly { name: string; valueMm: number }[];
            updatedAt: string;
          }[];
          fixedCosts: readonly {
            id: string;
            name: string;
            amount: number;
            currency: string;
            basis: string;
            defaultEnabled: boolean;
            updatedAt: string;
          }[];
          customFields: readonly {
            id: string;
            key: string;
            name: string;
            value: string;
            unit?: string;
            semantics: string;
            updatedAt: string;
          }[];
          capturedAt: string;
        }

        interface CostReportView {
          costReportId: string;
          label: string;
          drawingId: string;
          revisionId: string;
          modelId: string;
          quantity: number;
          createdAt: string;
          result: {
            rawStockVolume: number;
            materialCost: number;
            fixedCostLines: readonly { name: string; amount: number; basis: string; subtotal: number }[];
            perPieceCost: number;
            totalCost: number;
            currency: string;
          };
        }

        interface CostReportInputView {
          drawingId: string;
          revisionId: string;
          modelId: string;
          quantity: number;
          materialId: string;
          stockType: string;
          stockSpec: string;
          finishedVolume: number;
          allowances: readonly { name: string; valueMm: number }[];
          costData: CostDataSnapshotView;
          formulaVersion: string;
          capturedAt: string;
        }

        interface CostBridge {
          cost: {
            getEffectiveCostData(): Promise<{ ok: boolean; data: CostDataSnapshotView; error?: { code: string; message: string } }>;
            updateCostData(snapshot: CostDataSnapshotView): Promise<{ ok: boolean; data: CostDataSnapshotView; error?: { code: string; message: string } }>;
            getReportDetail(id: string): Promise<{ ok: boolean; data: CostReportView; error?: { code: string; message: string } }>;
            createReport(input: { input: CostReportInputView; createdAt: string }): Promise<{ ok: boolean; data: CostReportView; error?: { code: string; message: string } }>;
          };
          drawings: {
            getRevisionDetail(dId: string, rId: string): Promise<{ ok: boolean; data: { costReports: readonly { label: string }[] } }>;
          };
        }

        // 1. Get initial cost data basis
        const initialCostData = await page.evaluate(() => {
          const api = (globalThis as typeof globalThis & { swpanel: CostBridge }).swpanel;
          return api.cost.getEffectiveCostData();
        });
        expect(initialCostData.ok).toBe(true);
        expect(initialCostData.data.materials.length).toBeGreaterThanOrEqual(1);

        // The fake executor produces no measured geometry; register the test-only
        // measured-log fixture so the cost report can use a verified volume.
        registerGeometryFixture(root, modelId);

        // 2. Generate Q01 cost report for approved model
        const q01Created = await page.evaluate(
          ({ dId, rId, mId, cd }) => {
            const api = (globalThis as typeof globalThis & { swpanel: CostBridge }).swpanel;
            return api.cost.createReport({
              input: {
                drawingId: dId,
                revisionId: rId,
                modelId: mId,
                quantity: 5,
                materialId: cd.materials[0]!.id,
                stockType: "CYLINDER",
                stockSpec: "Ø320 × 820 mm",
                finishedVolume: 0.031,
                allowances: [{ name: "直径方向默认余量", valueMm: 20 }, { name: "长度方向默认余量", valueMm: 20 }],
                costData: cd,
                formulaVersion: "2026.08-p7",
                capturedAt: "2026-08-18T03:00:00.000Z"
              },
              createdAt: "2026-08-18T03:00:00.000Z"
            });
          },
          { dId: drawingId, rId: revisionId, mId: modelId, cd: initialCostData.data }
        );
        expect(q01Created.ok).toBe(true);
        expect(q01Created.data.label).toBe("Q01");
        expect(q01Created.data.result.totalCost).toBeGreaterThan(0);
        const q01InitialCost = q01Created.data.result.totalCost;

        // 3. Modify global cost data: raise material price
        const updatedCostDataSnapshot = {
          ...initialCostData.data,
          materials: [
            {
              ...initialCostData.data.materials[0]!,
              purchasePrice: 99999,
              updatedAt: "2026-08-18T04:00:00.000Z"
            }
          ],
          capturedAt: "2026-08-18T04:00:00.000Z"
        };
        const costDataUpdated = await page.evaluate((snapshot) => {
          const api = (globalThis as typeof globalThis & { swpanel: CostBridge }).swpanel;
          return api.cost.updateCostData(snapshot);
        }, updatedCostDataSnapshot);
        expect(costDataUpdated.ok).toBe(true);

        // 4. Verify Q01 report is immutable (re-read from storage and assert old total unchanged)
        const q01ReadBack = await page.evaluate((repId) => {
          const api = (globalThis as typeof globalThis & { swpanel: CostBridge }).swpanel;
          return api.cost.getReportDetail(repId);
        }, q01Created.data.costReportId);
        expect(q01ReadBack.ok).toBe(true);
        expect(q01ReadBack.data.result.totalCost).toBe(q01InitialCost);

        // 5. Generate Q02 report with new cost data
        const q02Created = await page.evaluate(
          ({ dId, rId, mId, cd }) => {
            const api = (globalThis as typeof globalThis & { swpanel: CostBridge }).swpanel;
            return api.cost.createReport({
              input: {
                drawingId: dId,
                revisionId: rId,
                modelId: mId,
                quantity: 5,
                materialId: cd.materials[0]!.id,
                stockType: "CYLINDER",
                stockSpec: "Ø320 × 820 mm",
                finishedVolume: 0.031,
                allowances: [{ name: "直径方向默认余量", valueMm: 20 }, { name: "长度方向默认余量", valueMm: 20 }],
                costData: cd,
                formulaVersion: "2026.08-p7",
                capturedAt: "2026-08-18T04:05:00.000Z"
              },
              createdAt: "2026-08-18T04:05:00.000Z"
            });
          },
          { dId: drawingId, rId: revisionId, mId: modelId, cd: costDataUpdated.data }
        );
        expect(q02Created.ok).toBe(true);
        expect(q02Created.data.label).toBe("Q02");
        expect(q02Created.data.result.totalCost).toBeGreaterThan(q01InitialCost);

        // 6. Revision detail lists both Q01 and Q02 reports
        const finalRevDetail = await page.evaluate(
          ({ dId, rId }) => {
            const api = (globalThis as typeof globalThis & { swpanel: CostBridge }).swpanel;
            return api.drawings.getRevisionDetail(dId, rId);
          },
          { dId: drawingId, rId: revisionId }
        );
        expect(finalRevDetail.ok).toBe(true);
        expect(finalRevDetail.data.costReports).toHaveLength(2);
        expect(finalRevDetail.data.costReports[0]!.label).toBe("Q01");
        expect(finalRevDetail.data.costReports[1]!.label).toBe("Q02");
      } finally {
        await app.close();
      }
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a real Runner artifact-validation scenario fails closed after the Agent manifest claim", async () => {
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-p4-validation-fixture-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-p4-validation-root-"));
    const fixturePath = path.join(fixtureDirectory, "P4-VALIDATION.pdf");
    await writeFile(fixturePath, "%PDF-1.4\\nPhase 4 independent validation fixture.\\n%%EOF\\n");

    try {
      const app = await launchRendererWithRoot(
        root,
        executorEnv({ [FAKE_EXECUTOR_SCENARIO_ENV]: "artifact-validation-failure" })
      );
      try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await expect(page.locator("#root")).not.toBeEmpty();
        const { drawingId, revisionId } = await createDrawingThroughBridge(
          app,
          page,
          fixturePath,
          "P4-VALIDATION",
          "Phase 4 independent validation"
        );
        const created = await page.evaluate(
          async ({ drawingId, revisionId }) => {
            const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
            return api.runs.create({ drawingId, revisionId });
          },
          { drawingId, revisionId }
        );
        expect(created.ok).toBe(true);
        const runId = created.data?.id as string;
        const detail = await waitForRun(page, runId, (value) => value.run.status === "FAILED");
        expect(detail.run.failureCode).toBe("VALIDATION_REJECTED");
        const eventTypes = detail.events.map((event) => event.type);
        expect(eventTypes.filter((type) => type === "StageChanged")).toHaveLength(5);
        expect(eventTypes.slice(-5)).toEqual([
          "RuntimeMetadataUpdated",
          "AgentTurnCompleted",
          "ResultManifestReceived",
          "ArtifactValidationFailed",
          "Failed"
        ]);
        expect(eventTypes.some((type) => type === "Completed")).toBe(false);
        expect(detail.events.at(-2)).toMatchObject({
          type: "ArtifactValidationFailed"
        });
        expect(detail.events.at(-1)).toMatchObject({
          type: "Failed"
        });
      } finally {
        await app.close();
      }
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the serial queue keeps the second Run QUEUED while the first runs; queued cancel cleans up", async () => {
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-p3-queue-fixture-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-p3-queue-root-"));
    const fixturePath = path.join(fixtureDirectory, "PDJF031.01.pdf");
    await writeFile(fixturePath, "%PDF-1.4\nPhase 3 serial queue fixture.\n%%EOF\n");

    try {
      const app = await launchRendererWithRoot(
        root,
        executorEnv({ [FAKE_EXECUTOR_SCENARIO_ENV]: "success", [FAKE_EXECUTOR_STEP_DELAY_ENV]: "400" })
      );
      try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await expect(page.locator("#root")).not.toBeEmpty();

        const { drawingId, revisionId } = await createDrawingThroughBridge(
          app,
          page,
          fixturePath,
          "PDJF031.01",
          "P3 串行队列验证"
        );

        // F1 regression: TWO separate create invocations for the SAME
        // drawing/revision pair are two distinct intents (Main mints a unique
        // idempotency key per user invocation) — they mint R01 and R02.
        const createRun = async (): Promise<{ id: string; number: string }> => {
          const created = await page.evaluate(
            async ({ drawingId, revisionId }) => {
              const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
              return api.runs.create({ drawingId, revisionId });
            },
            { drawingId, revisionId }
          );
          expect(created.ok).toBe(true);
          return { id: created.data?.id as string, number: created.data?.number ?? "" };
        };

        const createdA = await createRun();
        const runA = createdA.id;
        expect(createdA.number).toBe("R01");
        // The first Run is claimed immediately and starts executing.
        const detailA = await waitForRun(page, runA, (d) => {
          const run = d.run;
          return run.status === "RUNNING" && run.stage !== null;
        });
        expect(detailA.run.status).toBe("RUNNING");

        const createdB = await createRun();
        const runB = createdB.id;
        expect(runB).not.toBe(runA);
        expect(createdB.number).toBe("R02");
        // Serial invariant: exactly one RUNNING (A) and one QUEUED (B).
        await expect
          .poll(async () => {
            const rows = await listRuns(page);
            const byId = Object.fromEntries(rows.map((row) => [row.runId, row.status]));
            return byId[runA] === "RUNNING" && byId[runB] === "QUEUED";
          }, { timeout: 10_000, intervals: [150, 250] })
          .toBe(true);

        // Cancel B (QUEUED) while A runs: atomic cancellation, no claim, no
        // workspace, no Model.
        const cancelled = await page.evaluate(
          (id) => {
            const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
            return api.runs.cancel({ runId: id, reason: "用户主动取消" });
          },
          runB
        );
        expect(cancelled.ok).toBe(true);
        expect(cancelled.data?.status).toBe("CANCELLED");
        expect(cancelled.data?.alreadyCancelled).toBe(false);

        const detailB = await waitForRun(page, runB, (d) => {
          return d.run.status === "CANCELLED";
        });
        const eventsB = detailB.events;
        expect(eventsB.map((event) => event.type)).toEqual([
          "CancellationRequested",
          "CancellationConfirmed"
        ]);
        // B never claimed execution: no attempt workspace directory exists.
        expect(existsSync(path.join(root, "workspaces", "runs", runB))).toBe(false);

        // A was untouched by B's cancellation and completes, publishing a
        // PENDING_REVIEW Model (the Runner product default, P5-2).
        const detailAFinal = await waitForRun(page, runA, (d) => {
          return d.run.status === "COMPLETED";
        }, 20_000);
        expect(detailAFinal.run.modelId).not.toBeNull();
        const eventsA = detailAFinal.events;
        expect(eventsA.some((event) => event.type === "CancellationRequested")).toBe(false);
      } finally {
        await app.close();
      }
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Run, snapshot and events survive a UI/Runner close-restart; an interruption is never CANCELLED", async () => {
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-p3-restart-fixture-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-p3-restart-root-"));
    const fixturePath = path.join(fixtureDirectory, "PDJF032.01.pdf");
    await writeFile(fixturePath, "%PDF-1.4\nPhase 3 restart fixture.\n%%EOF\n");
    const env = executorEnv({
      [FAKE_EXECUTOR_SCENARIO_ENV]: "success",
      [FAKE_EXECUTOR_STEP_DELAY_ENV]: "300",
      [RUN_LEASE_ENV]: "4000"
    });

    let runId = "";
    try {
      // ── First launch: create the Run and interrupt it mid-execution.
      const first = await launchRendererWithRoot(root, env);
      try {
        const page = await first.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await expect(page.locator("#root")).not.toBeEmpty();
        const { drawingId, revisionId } = await createDrawingThroughBridge(
          first,
          page,
          fixturePath,
          "PDJF032.01",
          "P3 重启恢复验证"
        );
        const created = await page.evaluate(
          async ({ drawingId, revisionId }) => {
            const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
            return api.runs.create({ drawingId, revisionId });
          },
          { drawingId, revisionId }
        );
        expect(created.ok).toBe(true);
        runId = created.data?.id ?? runId;
        // Wait until the execution actually started (lease still live), then
        // close the app: an unexpected interruption, never a cancellation.
        await waitForRun(page, runId, (d) => {
          const run = d.run;
          return run.status === "RUNNING" && run.stage === "PREPARING";
        });
      } finally {
        await first.close();
      }

      // ── Second launch against the SAME root: the Run is recovered as an
      //    interruption (RECOVERY_UNSUPPORTED — the default success scenario
      //    proves no safe resume), NEVER CANCELLED, and its snapshot-backed
      //    events are still readable.
      const second = await launchRendererWithRoot(root, env);
      try {
        const page = await second.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await expect(page.locator("#root")).not.toBeEmpty();
        const runIdNow = runId;

        const detail = await waitForRun(page, runIdNow, (d) => {
          const run = d.run;
          return run.status === "FAILED";
        }, 25_000);
        const run = detail.run;
        expect(run.status).toBe("FAILED");
        expect(run.failureCode).toBe("RECOVERY_UNSUPPORTED");
        // The interruption was never mislabelled as a cancellation.
        expect(run.status).not.toBe("CANCELLED");
        const events = detail.events;
        expect(events.some((event) => event.type === "CancellationRequested")).toBe(false);
        expect(events.some((event) => event.type === "CancellationConfirmed")).toBe(false);
        // The events persisted through the restart (stages reached before the
        // interruption are readable) and the queue slot freed.
        expect(events.some((event) => event.type === "StageChanged" && event.stage === "PREPARING")).toBe(true);
        expect(detail.lastEventSequence > 0).toBe(true);
        expect(run.completedAt).not.toBeNull();

        // The Drawing library survives the restart too.
        const drawings = await page.evaluate(async () => {
          const api = (globalThis as typeof globalThis & { swpanel: DrawingBridge }).swpanel;
          const result = await api.drawings.list();
          return result.ok && result.data !== undefined ? result.data : [];
        });
        expect(drawings.some((drawing) => drawing.drawingNumber === "PDJF032.01")).toBe(true);
      } finally {
        await second.close();
      }
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a recovery-supported Run resumes after a quick restart and completes through all six stages", async () => {
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "swpanel-p3-recover-fixture-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "swpanel-p3-recover-root-"));
    const fixturePath = path.join(fixtureDirectory, "PDJF033.01.pdf");
    await writeFile(fixturePath, "%PDF-1.4\nPhase 3 recovery fixture.\n%%EOF\n");
    const env = executorEnv({
      [FAKE_EXECUTOR_SCENARIO_ENV]: "recovery-supported",
      [FAKE_EXECUTOR_STEP_DELAY_ENV]: "300",
      [RUN_LEASE_ENV]: "4000"
    });

    let runId = "";
    try {
      // ── First launch: the Fake Executor interrupts at ANALYZING.
      const first = await launchRendererWithRoot(root, env);
      try {
        const page = await first.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await expect(page.locator("#root")).not.toBeEmpty();
        const { drawingId, revisionId } = await createDrawingThroughBridge(
          first,
          page,
          fixturePath,
          "PDJF033.01",
          "P3 可恢复中断验证"
        );
        const created = await page.evaluate(
          async ({ drawingId, revisionId }) => {
            const api = (globalThis as typeof globalThis & { swpanel: RunBridge }).swpanel;
            return api.runs.create({ drawingId, revisionId });
          },
          { drawingId, revisionId }
        );
        expect(created.ok).toBe(true);
        runId = created.data?.id ?? runId;
        // The scripted interrupt point of `recovery-supported` is ANALYZING:
        // wait for it, then close while the lease is still live.
        await waitForRun(page, runId, (d) => {
          const run = d.run;
          return run.status === "RUNNING" && run.stage === "ANALYZING";
        });
      } finally {
        await first.close();
      }

      // ── Second launch: the expired lease is recovered (RESUME) and the
      //    attempt continues from the persisted stage through PACKAGING.
      const second = await launchRendererWithRoot(root, env);
      try {
        const page = await second.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await expect(page.locator("#root")).not.toBeEmpty();
        const runIdNow = runId;

        const detail = await waitForRun(page, runIdNow, (d) => {
          return d.run.status === "COMPLETED";
        }, 25_000);
        const run = detail.run;
        expect(run.status).toBe("COMPLETED");
        // The resumed Run completes through the same P5-2 success path and
        // publishes a PENDING_REVIEW Model.
        expect(run.modelId).not.toBeNull();
        const events = detail.events;
        // The resume walked the FULL six stages (no stage was skipped or
        // replayed) and never cancelled.
        const stageChanges = events.filter((event) => event.type === "StageChanged");
        expect(stageChanges.map((event) => event.stage)).toEqual([...ALL_SIX_STAGES]);
        expect(events.some((event) => event.type === "CancellationRequested")).toBe(false);
        const sequences = events.map((event) => event.sequence);
        expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
        expect(new Set(sequences).size).toBe(sequences.length);
        // The completed attempt's workspace artifact exists under the temp root.
        expect(
          existsSync(
            path.join(root, "workspaces", "runs", runIdNow, "attempt-001", "output", "fake-result.txt")
          )
        ).toBe(true);
      } finally {
        await second.close();
      }
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
