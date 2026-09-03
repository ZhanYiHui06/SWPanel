import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, session } from "electron";
import {
  codexVersionProbe,
  DEFAULT_RUN_PROFILE,
  hashSkillDirectory,
  PreflightGate,
  probeLiveCodexRuntime,
  probeSolidWorksRuntime,
  RealPreflightProbe,
  Runner,
  runtimeProbeResultOf,
  solidWorksProbeResultOf,
  type LiveCodexProbeResult,
  type RunnerConfig,
  type SolidWorksLiveProbeResult
} from "@swpanel/runner";

import { resolveRuntimeRootConfig } from "./bridge/runtime-root.js";
import {
  createWindowedDialogAdapter,
  DrawingFilePicker
} from "./files/file-selection.js";
import { SelectedFileRegistry } from "./files/selected-file-registry.js";
import { installMainIpc } from "./ipc/main-ipc.js";
import { SecretStore } from "./secrets/secret-store.js";
import {
  resolveLiveCodexConfig,
  type LiveCodexConfig
} from "./runner-host/live-codex-config.js";
import { buildLiveCodexAgentWiring } from "./runner-host/live-codex-wiring.js";
import { RunnerHost } from "./runner-host/runner-host.js";
import { resolveTestExecutorConfig } from "./runner-host/test-executor-config.js";
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  createRendererProtocolHandler,
  createWindowOptions,
  installSessionSecurity,
  isAllowedTopLevelNavigation,
  readDevelopmentRendererCliArg
} from "./security.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(moduleDirectory, "../renderer");

app.enableSandbox();

// Must run before the `ready` event: register `app` as a standard + secure
// scheme so the renderer has the real `app://swpanel` origin (CSP `'self'`
// stays pinned to it) and can use fetch/module loading over it. The scheme is
// deliberately NOT registered with `bypassCSP` or `corsEnabled`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

/**
 * The runtime data root is resolved ONCE, before the `ready` event, from the
 * strict CLI contract (runtime-root.ts): production derives
 * `%LOCALAPPDATA%\JANGHI\SWPanel` from the OS; the ONLY override is the
 * explicit `--swpanel-test-runtime-root=<absolute-local-path>` argument, honored
 * only on an unpackaged launch. A malformed/forbidden root is a fatal startup
 * error: the app must never launch against an ambiguous data root.
 */
let runtimeRoot: string;
try {
  runtimeRoot = resolveRuntimeRootConfig(process.argv, {
    isPackaged: app.isPackaged
  }).root;
} catch (error) {
  console.error(
    `SWPanel fatal startup error: invalid runtime root configuration: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  app.exit(1);
}

/**
 * Test-only Fake Executor configuration (Phase 3, P3-6): resolved ONCE from
 * the two dedicated environment variables and honored ONLY on an unpackaged
 * launch (see `test-executor-config.ts`). A packaged launch that carries them
 * refuses startup — the variables are never silently ignored. With no
 * variables set the Runner keeps its production default (`success`, instant
 * steps). The Renderer can never reach this configuration: no IPC payload or
 * bridge channel carries a scenario or a delay.
 */
let testExecutorConfig: ReturnType<typeof resolveTestExecutorConfig>;
try {
  testExecutorConfig = resolveTestExecutorConfig(process.env, {
    isPackaged: app.isPackaged
  });
} catch (error) {
  console.error(
    `SWPanel fatal startup error: invalid test executor configuration: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  app.exit(1);
}

/**
 * Live Codex App Server probe configuration (Phase 5, review-finding-9 real
 * discovery wiring): resolved ONCE from the dedicated environment variables
 * and honored ONLY on an unpackaged launch (see `live-codex-config.ts`). With
 * no variables set the Runner keeps its production default — the
 * deterministic SYNTHETIC preflight path — and the live probe is never
 * spawned. The Renderer can never reach this configuration: no IPC payload or
 * bridge channel carries a live Codex setting.
 */
let liveCodexConfig: LiveCodexConfig;
try {
  liveCodexConfig = resolveLiveCodexConfig(process.env, {
    isPackaged: app.isPackaged
  });
} catch (error) {
  console.error(
    `SWPanel fatal startup error: invalid live Codex configuration: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  app.exit(1);
}

/** The single Runner host owning the database + pipe server + client. */
let runnerHost: RunnerHost | null = null;
/** Shared close so `before-quit` and window shutdown cannot race. */
let shutdownPromise: Promise<void> | null = null;

function shutdownRunner(): Promise<void> {
  const host = runnerHost;
  runnerHost = null;
  if (host === null) {
    return shutdownPromise ?? Promise.resolve();
  }
  if (shutdownPromise !== null) return shutdownPromise;
  shutdownPromise = host.close().finally(() => {
    shutdownPromise = null;
  });
  return shutdownPromise;
}

async function loadPackagedRenderer(window: BrowserWindow): Promise<void> {
  try {
    await window.loadURL(APP_ENTRY_URL);
  } catch (error) {
    console.error(
      `SWPanel renderer failed to load over ${APP_ENTRY_URL}:`,
      error
    );
  }
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  // The development renderer override is honored ONLY for an explicit
  // development launch: the app must not be packaged AND scripts/dev.mjs or the
  // dev-mode Electron smoke must pass the dedicated
  // `--swpanel-development-renderer=http://127.0.0.1:5173/` CLI argument. Every
  // other launch — packaged, temp-ASAR, or a loose `electron ...` run — ignores
  // the override, so an injected environment can never point the renderer at an
  // external target: SWPANEL_RENDERER_URL and SWPANEL_DEVELOPMENT_RENDERER (any
  // casing) are never read.
  const rendererDevelopmentUrl = readDevelopmentRendererCliArg(process.argv);

  if (!app.isPackaged && rendererDevelopmentUrl !== undefined) {
    try {
      await window.loadURL(rendererDevelopmentUrl);
      return;
    } catch (error) {
      console.error(
        `SWPanel renderer failed to load ${rendererDevelopmentUrl}; ` +
          "falling back to the packaged renderer.",
        error
      );
    }
  }
  await loadPackagedRenderer(window);
}

function createMainWindow(): BrowserWindow {
  const preloadPath = path.resolve(moduleDirectory, "../preload/preload.cjs");
  const window = new BrowserWindow(createWindowOptions(preloadPath));

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    const currentUrl = window.webContents.getURL();
    if (!isAllowedTopLevelNavigation(navigationUrl, currentUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (event, navigationUrl) => {
    const currentUrl = window.webContents.getURL();
    if (!isAllowedTopLevelNavigation(navigationUrl, currentUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (errorCode !== -3) {
      // -3 (ERR_ABORTED) is expected for cancelled/redirected loads.
      console.error(
        `SWPanel renderer load failed (${errorCode}): ${errorDescription}`
      );
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  void loadRenderer(window);

  return window;
}

/**
 * Builds the REAL preflight gate of the live Codex seam (review-finding-9
 * wiring): the authoritative live snapshot (initialize + skills/list + bounded
 * thread/start compatibility round trip) feeds the {@link RealPreflightProbe} —
 * protocol v2, the pinned
 * runtime version and the exact skill-path discovery come from the live
 * probe, the image capability from the explicit live configuration; the
 * SolidWorks capability comes from the LIVE SolidWorks probe snapshot
 * ({@link probeSolidWorksRuntime}, awaited BEFORE this gate is built and
 * injected as a FIXED synchronous seam — the synchronous probe never performs
 * live COM work itself). An absent snapshot fails SolidWorks closed
 * truthfully. Never called on the default synthetic path.
 */
function buildLivePreflightGate(live: {
  config: LiveCodexConfig;
  result: LiveCodexProbeResult;
  liveSolidWorks: SolidWorksLiveProbeResult | null;
}): PreflightGate {
  return new PreflightGate(
    new RealPreflightProbe({
      skillRootPath: live.config.skillPath,
      runtime: { probe: () => runtimeProbeResultOf(live.result) },
      ...(live.result.modelImageInputSupported === null
        ? {}
        : { modelImageInputSupported: live.result.modelImageInputSupported }),
      liveCodex: live.result,
      // The FIXED SolidWorks seam over the awaited live snapshot: the
      // snapshot is snapshot-compatible with the synchronous
      // SolidWorksProbeResult surface and is captured exactly once per
      // Runner open (mirroring the liveCodex injection idiom).
      ...(live.liveSolidWorks === null
        ? {}
        : { solidworks: { probe: () => solidWorksProbeResultOf(live.liveSolidWorks!) } })
    })
  );
}

void app.whenReady().then(async () => {
  // Live Codex discovery runs BEFORE the Runner host is constructed: the
  // captured snapshot is authoritative configuration of the production
  // preflight gate (never Renderer-controlled). The probe owns and closes its
  // own app-server child; the bounded round trip cannot hang startup beyond
  // its per-request timeout. When live discovery is disabled nothing runs and
  // the Runner keeps the deterministic synthetic preflight path.
  let liveCodex: { config: LiveCodexConfig; result: LiveCodexProbeResult } | null = null;
  // The live SolidWorks availability/version snapshot of the same mode: it
  // runs ONLY here (unpackaged live-Codex execution) and never on the default
  // synthetic path. The probe fails closed on any runtime failure — it can
  // never crash startup; a failed snapshot fails the SolidWorks capability
  // closed at the gate.
  let liveSolidWorks: SolidWorksLiveProbeResult | null = null;
  if (liveCodexConfig.enabled) {
    // The live app-server handshake cannot verify the CLI version, so the
    // pinned-version input comes from the bounded `--version` metadata probe.
    const version = codexVersionProbe({ command: liveCodexConfig.executable }).probe().version;
    const result = await probeLiveCodexRuntime({
      command: liveCodexConfig.executable,
      skillName: liveCodexConfig.skillName,
      skillResolvedPath: liveCodexConfig.skillPath,
      ...(liveCodexConfig.modelImageInputSupported === undefined
        ? {}
        : { modelImageInputSupported: liveCodexConfig.modelImageInputSupported }),
      ...(liveCodexConfig.forceReloadSkills ? { forceReloadSkills: true } : {}),
      version
    });
    liveCodex = { config: liveCodexConfig, result };
    console.log(
      `SWPanel live Codex probe: available=${result.available} protocol=${result.protocol ?? "none"} ` +
        `skillDiscovered=${result.skillDiscovered} skillPathVerified=${result.skillPathVerified}`
    );
    // The live SolidWorks probe: read-only attach to a pre-existing instance,
    // or (only when none exists) an owned SLDWORKS.exe spawn with exact-pid
    // COM ownership proof and owned-only cleanup. The snapshot carries no
    // paths — only booleans, versions and the redacted stable reason.
    liveSolidWorks = await probeSolidWorksRuntime();
    console.log(
      `SWPanel live SolidWorks probe: available=${liveSolidWorks.available} ` +
        `version=${liveSolidWorks.version ?? "none"} ` +
        `installedVersion=${liveSolidWorks.installedVersion ?? "none"} ` +
        `ownedProcessSpawned=${liveSolidWorks.ownedProcessSpawned} ` +
        `ownedProcessClosed=${liveSolidWorks.ownedProcessClosed} reason=${liveSolidWorks.reason}`
    );
  }

  // Start the Runner host BEFORE creating/showing the window: the bridge health
  // state must reflect the real Runner. On failure the host stays FAILED (no
  // silent Mock fallback) and the health channel still answers.
  const host = new RunnerHost({
    dataRoot: runtimeRoot,
    ...(liveCodex === null &&
    testExecutorConfig.scenario === undefined &&
    testExecutorConfig.stepDelayMs === undefined &&
    testExecutorConfig.leaseDurationMs === undefined
      ? {}
      : {
          dependencies: {
            createRunner: (dataRoot) => {
              const config: RunnerConfig = {
                ...(testExecutorConfig.scenario === undefined
                  ? {}
                  : { fakeExecutorScenario: testExecutorConfig.scenario }),
                ...(testExecutorConfig.stepDelayMs === undefined
                  ? {}
                  : { fakeExecutorStepDelayMs: testExecutorConfig.stepDelayMs }),
                ...(testExecutorConfig.leaseDurationMs === undefined
                  ? {}
                  : { leaseDurationMs: testExecutorConfig.leaseDurationMs })
              };
              if (liveCodex !== null) {
                // The frozen Run profile of the live seam pins the REAL skill
                // digest (SWPanel's own canonical directory SHA-256 — the
                // protocol never returns a hash), never the synthetic fixture
                // digest: the real hash gate compares the CURRENT tree against
                // this exact digest. A skill tree that cannot be hashed is a
                // fatal startup error (fail closed, never a silent fallback to
                // the synthetic path).
                let skillSha256: string;
                try {
                  skillSha256 = hashSkillDirectory(liveCodex.config.skillPath);
                } catch (error) {
                  console.error(
                    `SWPanel fatal startup error: the configured live Codex skill tree cannot be hashed: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  );
                  app.exit(1);
                  throw error;
                }
                config.runProfile = {
                  promptTemplateVersion: DEFAULT_RUN_PROFILE.promptTemplateVersion,
                  skill: { name: liveCodex.config.skillName, sha256: skillSha256 },
                  agentConfigId: DEFAULT_RUN_PROFILE.agentConfigId
                };
                config.preflight = buildLivePreflightGate({
                  ...liveCodex,
                  liveSolidWorks
                });
                // The authoritative SolidWorks version attestation of the live
                // seam: injected ONLY when the live snapshot is available AND
                // its version is non-null — an absent snapshot/version keeps
                // the version-agnostic default and the attestation gate stays
                // inert. The Runner then fails the Result Manifest closed
                // (ARTIFACT_MANIFEST_INVALID, before artifact reads) unless the
                // Agent's recorded solidWorksVersion EXACTLY matches, and the
                // controlled prompt carries the same authoritative value so the
                // Agent records the exact version instead of guessing.
                if (
                  liveSolidWorks !== null &&
                  liveSolidWorks.available &&
                  liveSolidWorks.version !== null
                ) {
                  config.expectedSolidWorksVersion = liveSolidWorks.version;
                }
                // Batch C minimal live execution wiring: the ONE persistent
                // Codex app-server child per Runner (executor-owned via
                // `ownsAgent`, closed on shutdown and never orphaned), the
                // strict NDJSON client + turn adapter with the AUTHORITATIVE
                // image-support configuration (absent fails closed), the
                // configured Skill DIRECTORY as the turn's
                // `skillResolvedPath`, and the real PDF input adapter over the
                // bundled pypdfium2 rasterizer (explicit helper path valid in
                // dev and packaged ASAR). Nothing is faked and the synthetic
                // default path keeps its deterministic Fake defaults.
                const liveWiring = buildLiveCodexAgentWiring(liveCodex.config);
                config.agent = liveWiring.agent;
                config.ownsAgent = liveWiring.ownsAgent;
                config.skillResolvedPath = liveWiring.skillResolvedPath;
                config.inputAdapter = liveWiring.inputAdapter;
                // P5-4/B2: the ownership-safe cancellation surface of the live
                // seam. The Runner binds the factory to its real workspace
                // seams at open(); the synthetic/default path never receives
                // it and keeps its no-ownership cancellation behavior.
                config.buildOwnershipSurface = liveWiring.buildOwnershipSurface;
              }
              return new Runner(dataRoot, config);
            }
          }
        })
  });
  runnerHost = host;
  try {
    await host.start();
  } catch (error) {
    // `host.start()` already logged the structured failure; `host.health`
    // exposes the sanitized FAILED state to the renderer.
    void error;
  }

  const registry = new SelectedFileRegistry();
  const picker = new DrawingFilePicker({
    // Electron treats any non-BaseWindow first argument as the OPTIONS object,
    // so the plain webContents id from the IPC handler must be resolved to the
    // REAL BrowserWindow here — otherwise the native dialog silently drops its
    // PDF/DWG/DXF filter and title. A destroyed parent falls back to an
    // unparented dialog with the real options.
    dialog: createWindowedDialogAdapter({
      dialog,
      resolveWindow: (webContentsId) =>
        BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.id === webContentsId
        )
    }),
    registry,
    registerSourceFile: (sha256, absolutePath) => {
      try {
        host.registerSourceFile(sha256, absolutePath);
      } catch {
        // Registration is best-effort at pick time; the drawing command itself
        // surfaces a structured SOURCE_FILE_NOT_REGISTERED error when needed.
      }
    }
  });
  // The SafeStorage-backed API-key store (Step 3): the vault lives under the
  // per-user data directory and is encrypted at rest with Electron's
  // `safeStorage` (DPAPI on Windows). The plaintext key never crosses the
  // bridge — Main serves presence + masked status only.
  const secretStore = new SecretStore({
    filePath: path.join(app.getPath("userData"), "secrets.enc"),
    safeStorage
  });

  installMainIpc(ipcMain, { host, picker, registry, secrets: secretStore });

  protocol.handle(APP_SCHEME, createRendererProtocolHandler(rendererRoot));
  installSessionSecurity(session.defaultSession);
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void shutdownRunner();
    app.quit();
  }
});

app.on("before-quit", () => {
  // Start the teardown immediately; `will-quit` below waits for completion.
  void shutdownRunner();
});

app.on("will-quit", (event) => {
  // The Runner (IPC client -> pipe server -> SQLite/ledger) must close safely
  // before the process exits: defer the quit until the shared close finishes.
  if (runnerHost === null && shutdownPromise === null) return;
  event.preventDefault();
  void shutdownRunner().finally(() => app.quit());
});
