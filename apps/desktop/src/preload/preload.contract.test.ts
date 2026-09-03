// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAIN_CHANNELS, type RunEventsBridgePush, type SwpanelBridgeApi } from "../main/bridge/bridge-contract.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Bridge contract test: pins the EXACT renderer-visible method set, the frozen
 * surfaces, and the fixed channels the Preload invokes.
 *
 * The sandboxed Preload cannot `require` a sibling module, so it ships as an
 * esbuild BUNDLE (exactly like the real `build:electron` step). This test
 * bundles `preload.cts` the same way and loads the bundle with a fake
 * `electron` module placed in a node_modules sibling of the bundle, so Node's
 * native `require("electron")` (external in the bundle) resolves to the fake.
 * It therefore proves the SHIPPED artifact, not a hand-imported source file.
 */

const preloadSource = fileURLToPath(new URL("../preload/preload.cts", import.meta.url));

interface BridgeMockState {
  exposed: SwpanelBridgeApi | null;
  channels: string[];
  payloads: unknown[];
  listenChannels: string[];
  unlistenChannels: string[];
  /** Channel -> attached listeners (the mock can simulate Main pushes). */
  listeners: Record<string, Array<(event: unknown, payload: unknown) => void>>;
  /** When true the mock rejects the runSubscribe invoke deterministically. */
  failSubscribe: boolean;
}

let tempDir: string | undefined;
let bundlePath: string | undefined;
let statePath: string | undefined;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "swpanel-preload-contract-"));
  // The Preload reads process.versions at load time; plain Node (vitest) has no
  // electron version, so inject the pinned one for the contract check.
  (process.versions as Record<string, string>).electron = "43.3.0";
  const modulesDir = join(tempDir, "node_modules");
  const mockDir = join(modulesDir, "electron");
  mkdirSync(mockDir, { recursive: true });
  statePath = join(modulesDir, "__swpanel_mock_state__.cjs");
  writeFileSync(
    statePath,
    'module.exports = { exposed: null, channels: [], payloads: [], listenChannels: [], unlistenChannels: [], listeners: {}, failSubscribe: false };\n'
  );
  writeFileSync(
    join(mockDir, "index.js"),
    [
      'const state = require("../__swpanel_mock_state__.cjs");',
      "module.exports = {",
      "  contextBridge: { exposeInMainWorld: (key, value) => { state.exposed = value; } },",
      "  ipcRenderer: {",
      "    invoke: (channel, payload) => {",
      "      state.channels.push(channel);",
      "      state.payloads.push(payload);",
      "      if (state.failSubscribe && channel === 'swpanel:runs:subscribe') {",
      "        return Promise.resolve({ ok: false, error: { code: 'INVALID_PAYLOAD', message: 'rejected by test' } });",
      "      }",
      "      return Promise.resolve({ ok: true, data: {} });",
      "    },",
      "    on: (channel, listener) => {",
      "      state.listenChannels.push(channel);",
      "      (state.listeners[channel] ??= []).push(listener);",
      "    },",
      "    removeListener: (channel, listener) => {",
      "      state.unlistenChannels.push(channel);",
      "      const listeners = state.listeners[channel];",
      "      if (!listeners) return;",
      "      const index = listeners.indexOf(listener);",
      "      if (index >= 0) listeners.splice(index, 1);",
      "    }",
      "  }",
      "};"
    ].join("\n") + "\n"
  );
  writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "commonjs" }));

  bundlePath = join(tempDir, "preload.cjs");
  await build({
    entryPoints: [preloadSource],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: bundlePath,
    logLevel: "silent"
  });
});

afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
});

function loadState(): BridgeMockState {
  const resolved = statePath;
  if (resolved === undefined) throw new Error("state path missing");
  return nodeRequire(resolved) as BridgeMockState;
}
function loadPreloadWithDiagnostics(): void {
  const resolved = bundlePath;
  if (resolved === undefined) throw new Error("bundle path missing");
  // The bundle is CommonJS; require() it natively so Node resolves
  // `require("electron")` from the bundle's temp node_modules to the fake.
  nodeRequire(resolved);
}

describe("preload bridge contract", () => {
  it("exposes exactly the frozen WP5 + Phase 3 surface under window.swpanel", () => {
    loadPreloadWithDiagnostics();
    const state = loadState();
    expect(state.exposed).not.toBeNull();
    const api = state.exposed as SwpanelBridgeApi;
    expect(Object.keys(api).sort()).toEqual([
      "clarifications",
      "cost",
      "drawings",
      "files",
      "health",
      "metadata",
      "models",
      "runs",
      "secrets",
      "storage",
      "system"
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.metadata)).toBe(true);
    expect(Object.isFrozen(api.health)).toBe(true);
    expect(Object.isFrozen(api.files)).toBe(true);
    expect(Object.isFrozen(api.drawings)).toBe(true);
    expect(Object.isFrozen(api.storage)).toBe(true);
    expect(Object.isFrozen(api.runs)).toBe(true);
    expect(Object.isFrozen(api.clarifications)).toBe(true);
    expect(Object.isFrozen(api.models)).toBe(true);
    expect(Object.isFrozen(api.cost)).toBe(true);
    expect(Object.isFrozen(api.system)).toBe(true);
    expect(Object.isFrozen(api.secrets)).toBe(true);
    expect(Object.isFrozen(api.metadata.versions)).toBe(true);
    expect(api.metadata.platform).toBeTypeOf("string");
    expect(api.metadata.versions.electron).toBeTypeOf("string");
  });

  it("exposes the exact method set (no generic APIs)", () => {
    const api = loadState().exposed as SwpanelBridgeApi;
    const methods = {
      health: Object.keys(api.health).sort(),
      files: Object.keys(api.files).sort(),
      drawings: Object.keys(api.drawings).sort(),
      storage: Object.keys(api.storage).sort(),
      runs: Object.keys(api.runs).sort(),
      clarifications: Object.keys(api.clarifications).sort(),
      models: Object.keys(api.models).sort(),
      cost: Object.keys(api.cost).sort(),
      system: Object.keys(api.system).sort(),
      secrets: Object.keys(api.secrets).sort()
    };
    expect(methods.health).toEqual(["get"]);
    expect(methods.files).toEqual(["selectDrawingFile"]);
    expect(methods.drawings).toEqual([
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
    ]);
    expect(methods.storage).toEqual(["getSettings", "updateSettings"]);
    expect(methods.runs).toEqual(["cancel", "create", "delete", "getDetail", "list", "subscribe"]);
    expect(methods.clarifications).toEqual(["get", "submit"]);
    expect(methods.models).toEqual(["getDetail", "review"]);
    expect(methods.cost).toEqual([
      "createReport",
      "deleteReport",
      "getEffectiveCostData",
      "getReportDetail",
      "updateCostData"
    ]);
    expect(methods.system).toEqual(["getRecoveryStatus"]);
    expect(methods.secrets).toEqual(["clearApiKey", "getStatus", "setApiKey"]);

    // No generic / raw capabilities are exposed.
    const surface = JSON.stringify(api);
    expect(surface).not.toMatch(/invoke|readFile|spawn|shell|pipe|channel/);
  });

  it("invokes exactly the allowlisted channel constants", async () => {
    const api = loadState().exposed as SwpanelBridgeApi;
    const state = loadState();
    state.channels.length = 0;
    state.payloads.length = 0;

    await api.health.get();
    await api.files.selectDrawingFile();
    await api.drawings.list();
    await api.drawings.getHistory("d1");
    await api.drawings.getDetail("d1");
    await api.drawings.getRevisionHistory("d1", "r1");
    await api.drawings.getRevisionDetail("d1", "r1");
    await api.storage.getSettings();
    await api.drawings.importDrawing({
      drawingNumber: "X",
      name: "x",
      selectedFileToken: `swsel_${"a".repeat(32)}`,
      createdAt: "2026-08-12T00:00:00.000Z"
    });
    await api.drawings.addRevision({
      drawingId: "d1",
      selectedFileToken: `swsel_${"b".repeat(32)}`,
      createdAt: "2026-08-12T00:00:00.000Z"
    });
    await api.drawings.setCurrentRevision({
      drawingId: "d1",
      revisionId: "r1",
      updatedAt: "2026-08-12T00:00:00.000Z"
    });
    await api.drawings.deleteRevision({
      drawingId: "d1",
      revisionId: "r2",
      updatedAt: "2026-08-12T00:00:00.000Z"
    });
    await api.drawings.addRevisionFact({
      drawingId: "d1",
      revisionId: "r1",
      field: "f",
      value: "v",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T00:00:00.000Z",
      clientIntentId: `swint_${"d".repeat(32)}`
    });
    await api.drawings.addModelingFeedback({
      drawingId: "d1",
      revisionId: "r1",
      content: "c",
      createdAt: "2026-08-12T00:00:00.000Z",
      clientIntentId: `swint_${"e".repeat(32)}`
    });
    await api.storage.updateSettings({
      settings: {
        dataRoot: "C:\\data",
        workspaceRoot: "C:\\data\\w",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    });
    await api.runs.list();
    await api.runs.getDetail("run-1");
    await api.runs.create({ drawingId: "d1", revisionId: "r1" });
    await api.runs.cancel({ runId: "run-1", reason: "用户取消" });
    const unsubscribe = api.runs.subscribe({ runId: "run-1", fromSequence: 0 }, () => {});
    unsubscribe();
    await api.clarifications.get("clar-1");
    await api.clarifications.submit({
      clarificationRequestId: "clar-1",
      answers: [
        {
          id: "ans-1",
          questionId: "dimension",
          value: { kind: "dimension", value: 12, unit: "mm" },
          answeredAt: "2026-08-13T01:00:00.000Z",
          answeredBy: "alice"
        }
      ],
      answeredAt: "2026-08-13T01:00:00.000Z",
      answeredBy: "alice"
    });
    await api.models.getDetail("model-1");
    await api.models.review({
      modelId: "model-1",
      result: "APPROVED",
      reviewerId: "current-windows-user",
      reviewedAt: "2026-08-13T01:00:00.000Z"
    });
    await api.runs.delete({ runId: "run-1", drawingId: "d1", revisionId: "r1" });
    await api.cost.getEffectiveCostData();
    await api.cost.updateCostData({
      materials: [],
      allowances: [],
      fixedCosts: [],
      customFields: [],
      capturedAt: "2026-08-18T00:00:00.000Z"
    });
    await api.cost.getReportDetail("cost-report-1");    await api.cost.createReport({
      input: {} as never,
      createdAt: "2026-08-18T00:00:00.000Z"
    });
    await api.cost.deleteReport({ costReportId: "cost-report-1", revisionId: "rev-3" });
    await api.system.getRecoveryStatus();
    await api.secrets.getStatus();
    await api.secrets.setApiKey("sk-proj-renderer-submitted-key");
    await api.secrets.clearApiKey();

    const expected = [
      MAIN_CHANNELS.health,
      MAIN_CHANNELS.selectDrawingFile,
      MAIN_CHANNELS.drawingList,
      MAIN_CHANNELS.drawingHistory,
      MAIN_CHANNELS.drawingDetail,
      MAIN_CHANNELS.revisionHistory,
      MAIN_CHANNELS.revisionDetail,
      MAIN_CHANNELS.storageGetSettings,
      MAIN_CHANNELS.importDrawing,
      MAIN_CHANNELS.addRevision,
      MAIN_CHANNELS.setCurrentRevision,
      MAIN_CHANNELS.deleteRevision,
      MAIN_CHANNELS.addRevisionFact,
      MAIN_CHANNELS.addModelingFeedback,
      MAIN_CHANNELS.updateStorageSettings,
      MAIN_CHANNELS.runList,
      MAIN_CHANNELS.runDetail,
      MAIN_CHANNELS.runCreate,
      MAIN_CHANNELS.runCancel,
      MAIN_CHANNELS.runSubscribe,
      MAIN_CHANNELS.runUnsubscribe,
      MAIN_CHANNELS.clarificationGet,
      MAIN_CHANNELS.clarificationSubmit,
      MAIN_CHANNELS.modelDetail,
      MAIN_CHANNELS.modelReview,
      MAIN_CHANNELS.runDelete,
      MAIN_CHANNELS.costDataGet,
      MAIN_CHANNELS.costDataUpdate,
      MAIN_CHANNELS.costReportDetail,
      MAIN_CHANNELS.costReportCreate,
      MAIN_CHANNELS.costReportDelete,
      MAIN_CHANNELS.recoveryStatus,
      MAIN_CHANNELS.secretsGetStatus,
      MAIN_CHANNELS.secretsSetApiKey,
      MAIN_CHANNELS.secretsClearApiKey
    ];
    expect(state.channels).toEqual(expected);
    // Every invoke passes exactly TWO arguments: a fixed channel and a payload
    // object — never a channel/listener parameter supplied by the renderer.
    expect(state.payloads.length).toBe(expected.length);
    for (const payload of state.payloads) {
      expect(typeof payload).toBe("object");
    }
    // subscribe attaches the runEvents push listener BEFORE asking Main to
    // subscribe, and unsubscribe removes it — always the frozen push channel.
    expect(state.listenChannels).toEqual([MAIN_CHANNELS.runEvents]);
    expect(state.unlistenChannels).toEqual([MAIN_CHANNELS.runEvents]);
  });

  it("surfaces a rejected subscribe deterministically as a runEventsError push and detaches the listener (M1)", async () => {
    const api = loadState().exposed as SwpanelBridgeApi;
    const state = loadState();
    // The mocked state module is cached across tests; reset the recordings.
    state.unlistenChannels.length = 0;
    state.listeners = {};
    state.failSubscribe = true;
    const pushes: RunEventsBridgePush[] = [];
    api.runs.subscribe({ runId: "run-1", fromSequence: 0 }, (push) => pushes.push(push));
    // The invoke resolves with the structured rejection; the error push is the
    // deterministic outcome — the renderer never waits forever on a refused
    // subscription.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushes).toEqual([
      {
        kind: "runEventsError",
        runId: "run-1",
        error: { code: "INVALID_PAYLOAD", message: "rejected by test" }
      }
    ]);
    // The dangling listener was detached by the failure path.
    expect(state.unlistenChannels).toEqual([MAIN_CHANNELS.runEvents]);
    expect(state.listeners[MAIN_CHANNELS.runEvents] ?? []).toHaveLength(0);
    state.failSubscribe = false;
  });

  it("forwards only pushes matching the subscribed runId (concurrent subscriptions stay isolated)", () => {
    const api = loadState().exposed as SwpanelBridgeApi;
    const state = loadState();
    state.listeners = {};
    const run1Pushes: RunEventsBridgePush[] = [];
    const run2Pushes: RunEventsBridgePush[] = [];
    api.runs.subscribe({ runId: "run-1", fromSequence: 0 }, (push) => run1Pushes.push(push));
    api.runs.subscribe({ runId: "run-2", fromSequence: 0 }, (push) => run2Pushes.push(push));
    const listeners = state.listeners[MAIN_CHANNELS.runEvents] ?? [];
    expect(listeners).toHaveLength(2);

    // A Main push for run-2 reaches ONLY run-2's handler...
    listeners[1]?.(null, { kind: "runEvents", runId: "run-2", fromSequence: 1, events: [] });
    expect(run1Pushes).toEqual([]);
    expect(run2Pushes).toHaveLength(1);

    // ...and a push for run-1 reaches ONLY run-1's handler.
    listeners[0]?.(null, { kind: "runEvents", runId: "run-1", fromSequence: 1, events: [] });
    expect(run1Pushes).toHaveLength(1);
    expect(run2Pushes).toHaveLength(1);
  });

  it("never sends the drawing file absolute path through the bridge", async () => {
    const api = loadState().exposed as SwpanelBridgeApi;
    const state = loadState();
    state.payloads.length = 0;
    await api.drawings.importDrawing({
      drawingNumber: "PDJF001.01",
      name: "轧辊",
      selectedFileToken: `swsel_${"c".repeat(32)}`,
      createdAt: "2026-08-12T00:00:00.000Z"
    });
    const serialized = JSON.stringify(state.payloads);
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(serialized).not.toMatch(/\\\\/);
  });
});
