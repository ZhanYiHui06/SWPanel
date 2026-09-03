import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

import {
  DEVELOPMENT_CONTENT_SECURITY_POLICY,
  REACT_REFRESH_PREAMBLE_HASH
} from "../apps/desktop/src/main/security.js";
import { TEST_RUNTIME_ROOT_CLI_FLAG } from "../apps/desktop/src/main/bridge/runtime-root.js";
import { PRODUCT_ROUTES } from "../apps/desktop/src/renderer/app/route-manifest.js";

let testRuntimeRoot: string | undefined;

test.beforeAll(async () => {
  // The WP5 Runner host needs a data root; the dev smoke uses a temporary root
  // through the dedicated unpackaged CLI argument so it never touches the real
  // %LOCALAPPDATA%\JANGHI\SWPanel.
  testRuntimeRoot = await mkdtemp(path.join(tmpdir(), "swpanel-smoke-root-"));
});

test.afterAll(async () => {
  if (testRuntimeRoot !== undefined) {
    await rm(testRuntimeRoot, { recursive: true, force: true });
  }
});

async function launchRenderer() {
  // The development renderer is authorized ONLY by the dedicated CLI argument
  // (the main process never reads SWPANEL_RENDERER_URL or
  // SWPANEL_DEVELOPMENT_RENDERER from the environment).
  return electron.launch({
    args: [
      path.resolve("apps/desktop/dist/main/main.js"),
      "--swpanel-development-renderer=http://127.0.0.1:5173/",
      `${TEST_RUNTIME_ROOT_CLI_FLAG}=${testRuntimeRoot as string}`
    ],
    cwd: path.resolve(".")
  });
}

async function goToHash(page: Page, samplePath: string) {
  await page.evaluate((nextPath) => {
    globalThis.location.hash = nextPath;
  }, samplePath);
}

test("secure Electron shell reaches every production route", async () => {
  const app = await launchRenderer();

  try {
    const page = await app.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#root")).not.toBeEmpty();

    await page.reload();
    await expect(page.locator("#root")).not.toBeEmpty();

    const { developmentCsp, responseCsp } = await page.evaluate(async () => ({
      developmentCsp: document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content"),
      responseCsp: (await fetch(globalThis.location.href)).headers.get("content-security-policy")
    }));
    expect(developmentCsp).toBe(DEVELOPMENT_CONTENT_SECURITY_POLICY);
    expect(responseCsp).toBe(DEVELOPMENT_CONTENT_SECURITY_POLICY);
    expect(developmentCsp).toContain(`script-src 'self' ${REACT_REFRESH_PREAMBLE_HASH}`);
    expect(developmentCsp).not.toContain("'unsafe-eval'");

    const boundary = await page.evaluate(async () => {
      const swpanelWindow = globalThis as typeof globalThis & {
        swpanel?: Readonly<{
          metadata: Readonly<{
            platform: string;
            versions: Readonly<{ chrome: string; electron: string }>;
          }>;
          health?: Readonly<{
            get: () => Promise<{ ok: boolean; data?: { status: string } }>;
          }>;
          files?: Readonly<{ selectDrawingFile: () => Promise<unknown> }>;
          drawings?: Record<string, unknown>;
          storage?: Record<string, unknown>;
          models?: Record<string, unknown>;
          runs?: Record<string, unknown>;
          clarifications?: Record<string, unknown>;
          cost?: Record<string, unknown>;
          system?: Record<string, unknown>;
          secrets?: Record<string, unknown>;
        }>;
        process?: unknown;
        require?: unknown;
      };

      const api = swpanelWindow.swpanel;
      // Real bridge roundtrip against the REAL Runner under the temp test root.
      const health = api?.health ? await api.health.get() : null;

      return {
        nodeType: typeof swpanelWindow.process,
        requireType: typeof swpanelWindow.require,
          apiKeys: Object.keys(api ?? {}).sort(),
          phase8MethodTypes: {
            secretsGetStatus: api?.secrets === undefined ? "missing" : typeof api.secrets.getStatus,
            secretsSetApiKey: api?.secrets === undefined ? "missing" : typeof api.secrets.setApiKey,
            secretsClearApiKey: api?.secrets === undefined ? "missing" : typeof api.secrets.clearApiKey,
            recoveryStatus: api?.system === undefined ? "missing" : typeof api.system.getRecoveryStatus,
            runDelete: api?.runs === undefined ? "missing" : typeof api.runs.delete,
            costDeleteReport: api?.cost === undefined ? "missing" : typeof api.cost.deleteReport
          },
        metadataKeys: Object.keys(api?.metadata ?? {}),
        apiFrozen: api === undefined ? false : Object.isFrozen(api),
        metadataFrozen: api === undefined ? false : Object.isFrozen(api.metadata),
        healthFrozen: api?.health === undefined ? false : Object.isFrozen(api.health),
        filesFrozen: api?.files === undefined ? false : Object.isFrozen(api.files),
        drawingsFrozen: api?.drawings === undefined ? false : Object.isFrozen(api.drawings),
        storageFrozen: api?.storage === undefined ? false : Object.isFrozen(api.storage),
        methodSets: {
          health: Object.keys(api?.health ?? {}).sort(),
          files: Object.keys(api?.files ?? {}).sort(),
          drawings: Object.keys(api?.drawings ?? {}).sort(),
          storage: Object.keys(api?.storage ?? {}).sort(),
          models: Object.keys(api?.models ?? {}).sort(),
          runs: Object.keys(api?.runs ?? {}).sort(),
          clarifications: Object.keys(api?.clarifications ?? {}).sort(),
          cost: Object.keys(api?.cost ?? {}).sort(),
          secrets: Object.keys(api?.secrets ?? {}).sort(),
          system: Object.keys(api?.system ?? {}).sort()
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
        healthOk: health === null ? null : health.ok,
        healthStatus: health !== null && health.ok ? health.data?.status ?? null : null
      };
    });

    expect(boundary).toEqual({
      nodeType: "undefined",
      requireType: "undefined",
      apiKeys: ["clarifications", "cost", "drawings", "files", "health", "metadata", "models", "runs", "secrets", "storage", "system"],
      phase8MethodTypes: {
        secretsGetStatus: "function",
        secretsSetApiKey: "function",
        secretsClearApiKey: "function",
        recoveryStatus: "function",
        runDelete: "function",
        costDeleteReport: "function"
      },
      metadataKeys: ["platform", "versions"],
      apiFrozen: true,
      metadataFrozen: true,
      healthFrozen: true,
      filesFrozen: true,
      drawingsFrozen: true,
      storageFrozen: true,
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
      healthStatus: "READY"
    });

    for (const route of PRODUCT_ROUTES) {
      await goToHash(page, route.samplePath);
      await expect(page).not.toHaveURL(/scenario=/);
      await expect(page.locator(`[data-route-id="${route.id}"]`)).toBeVisible();
    }

    await page.evaluate(() => {
      globalThis.location.hash = "/component-spec";
    });
    await expect(page.locator('[data-route-id="component-spec"]')).toBeVisible();
    expect(
      consoleErrors.filter(
        (message) =>
          message.includes("Content Security Policy") ||
          message.includes("@vitejs/plugin-react")
      )
    ).toEqual([]);
  } finally {
    await app.close();
  }
});
