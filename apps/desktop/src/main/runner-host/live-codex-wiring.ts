/**
 * Live Codex execution wiring of the Runner host (Batch C minimal live
 * execution wiring): builds the Runner-configuration fragment of the LIVE
 * Codex seam — the ONE persistent app-server child transport, the strict
 * NDJSON client, the async turn adapter and the real PDF input adapter over
 * the bundled pypdfium2 rasterizer. Consumed ONLY by the liveCodex branch of
 * `main.ts`; the default synthetic path keeps its deterministic Fake agent /
 * Fake input-adapter defaults untouched (no live config, no wiring).
 *
 * Lifecycle contract: EXACTLY ONE persistent Codex child transport per Runner
 * — one `codexChildTransportFactory({ command })` over the configured
 * executable, invoked exactly once. The client wraps the transport and the
 * adapter wraps the client; `ownsAgent: true` hands the adapter (and with it
 * the child process) to the Runner's executor, which closes it on shutdown
 * (bounded, never orphaned) even when no queue loop ever started.
 *
 * Fail-closed posture:
 *
 * - `modelSupportsImageInput` is ONLY the authoritative explicit live
 *   configuration (the same value the preflight gate received); absent
 *   (`undefined`) the option is omitted and the adapter records `false` —
 *   image support is never invented and a null/undefined wiring can never
 *   claim it;
 * - the pypdfium2 helper path is resolved EXPLICITLY against the bundled
 *   desktop main — `apps/desktop/dist/main` in dev and the packaged asar
 *   (`app.asar/apps/runner/dist/adaptation/pdfium-rasterizer-helper.py`,
 *   audited by `scripts/audit-asar.mjs`) — because the esbuild bundle inlines
 *   the rasterizer module and its `import.meta.url`-based default could never
 *   find the real helper file; the rasterizer constructor itself fails closed
 *   on a missing/unreadable helper.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodexAppServerAdapter,
  CodexAppServerClient,
  codexChildTransportFactory,
  PYTHON_PDFIUM_HELPER_FILE_NAME,
  PythonPdfiumRasterizer,
  RealPdfInputAdapter,
  SolidWorksDocumentCloser,
  WorkspaceSolidWorksOwnershipSurface,
  type AgentTurnAdapter,
  type CodexTransportFactory,
  type InputAdapter,
  type SolidWorksIdentityCloser,
  type SolidWorksOwnershipSurface,
  type SolidWorksOwnershipSurfaceContext
} from "@swpanel/runner";

import type { LiveCodexConfig } from "./live-codex-config.js";

/** The Runner-configuration fragment of the live Codex execution seam. */
export interface LiveCodexAgentWiring {
  /** The Codex App Server turn adapter of the live seam (`config.agent`). */
  readonly agent: AgentTurnAdapter;
  /**
   * The Runner's executor OWNS the adapter (`config.ownsAgent`): it closes
   * the adapter — terminating the persistent Codex child, bounded — whenever
   * the Runner closes.
   */
  readonly ownsAgent: true;
  /**
   * The exact configured Skill DIRECTORY (`config.skillResolvedPath`): the
   * same directory the preflight gate and the directory digest consume.
   */
  readonly skillResolvedPath: string;
  /**
   * The real PDF input adapter over the pypdfium2 rasterizer
   * (`config.inputAdapter`), replacing the deterministic fake input scenario.
   */
  readonly inputAdapter: InputAdapter;
  /**
   * Phase 5 (P5-4 / Batch 2): constructs the ownership-safe SolidWorks
   * cancellation surface of the live seam (`config.buildOwnershipSurface`),
   * bound by the Runner at `open()` to the real persisted-stage / active
   * attempt / attempt-workspace seams. The static part — the bounded
   * Python/pywin32 document-only closer — is built HERE (never re-created per
   * Runner open); the workspace seams only exist after the Runner opens, so
   * the surface itself is produced by this factory.
   */
  readonly buildOwnershipSurface: (
    context: SolidWorksOwnershipSurfaceContext
  ) => SolidWorksOwnershipSurface;
}

export interface LiveCodexAgentWiringOptions {
  /**
   * The live-spawn seam of the app-server child. Default:
   * `codexChildTransportFactory` over the configured executable — the ONE
   * persistent child per Runner. Hermetic tests inject an in-memory factory
   * and never spawn a process.
   */
  transportFactory?: CodexTransportFactory;
  /** Injectable helper path for hermetic startup-failure tests. */
  pdfiumHelperPath?: string;
  /**
   * The ONLY low-level document-close path of the ownership surface. Default:
   * the bounded shell:false Python/pywin32 document-only closer
   * ({@link SolidWorksDocumentCloser}). Hermetic tests inject an in-memory
   * closer and never spawn a Python child.
   */
  documentCloser?: SolidWorksIdentityCloser;
}

/**
 * Builds the live Codex execution wiring of one Runner from the resolved
 * live configuration. The transport factory is produced over the configured
 * executable and invoked EXACTLY once: one persistent app-server child per
 * Runner.
 */
export function buildLiveCodexAgentWiring(
  config: LiveCodexConfig,
  options: LiveCodexAgentWiringOptions = {}
): LiveCodexAgentWiring {
  const transportFactory =
    options.transportFactory ??
    codexChildTransportFactory({ command: config.executable });
  const transport = transportFactory();
  try {
    const client = new CodexAppServerClient({ transport });
    const agent = new CodexAppServerAdapter({
      client,
      // Authoritative explicit live configuration — never invented; absent
      // (undefined) is omitted so the adapter fails CLOSED to `false`. The
      // adapter option is `modelSupportsImageInput` (the wiring's own
      // contract); the live config spells the capability `...Supported`.
      ...(config.modelImageInputSupported === undefined
        ? {}
        : { modelSupportsImageInput: config.modelImageInputSupported })
    });
    const inputAdapter = new RealPdfInputAdapter({
      rasterizer: new PythonPdfiumRasterizer({
        helperPath: options.pdfiumHelperPath ?? resolvePdfiumHelperPath()
      })
    });
    // The static part of the ownership seam: the bounded document-only closer
    // is built ONCE here (default) or injected (hermetic tests). The surface
    // itself is produced per Runner open by the factory below, which the
    // Runner binds to its real workspace seams.
    const documentCloser = options.documentCloser ?? new SolidWorksDocumentCloser();
    return {
      agent,
      ownsAgent: true,
      skillResolvedPath: config.skillPath,
      inputAdapter,
      buildOwnershipSurface: (context) =>
        new WorkspaceSolidWorksOwnershipSurface({
          workspace: context,
          closer: documentCloser
        })
    };
  } catch (error) {
    // Ownership transfers to the Runner only after the complete wiring has
    // been constructed. If client/adapter/PDF setup fails before that return,
    // close the already-spawned child here so startup cannot orphan it.
    transport.close();
    throw error;
  }
}

/**
 * Resolves the bundled pypdfium2 helper script against the bundled desktop
 * main, covering the dev bundle (`apps/desktop/dist/main`) and the packaged
 * asar (`app.asar/apps/runner/dist/adaptation/pdfium-rasterizer-helper.py`),
 * with the TypeScript test tree fallback. Returns the first existing
 * candidate (like the rasterizer's own default resolution), never an invented
 * path. The base directory is injectable so tests can pin the bundled-main
 * resolution exactly.
 */
export function resolvePdfiumHelperPath(
  moduleDirectory: string = path.dirname(fileURLToPath(import.meta.url))
): string {
  const candidates = [
    // Bundled desktop main (dev + packaged asar):
    // apps/desktop/dist/main -> apps/runner/dist/adaptation/<helper>.py
    path.resolve(
      moduleDirectory,
      "../../../runner/dist/adaptation",
      PYTHON_PDFIUM_HELPER_FILE_NAME
    ),
    // TypeScript test tree: apps/desktop/src/main/runner-host ->
    // apps/runner/src/adaptation/<helper>.py
    path.resolve(
      moduleDirectory,
      "../../../../runner/src/adaptation",
      PYTHON_PDFIUM_HELPER_FILE_NAME
    )
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
