/** Server-only live Codex configuration and ownership-safe wiring. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodexAppServerAdapter,
  CodexAppServerClient,
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
} from "../index.js";

import { resolveWebCodexProvider, webCodexTransportFactory } from "./web-codex-provider.js";
import type { LiveCodexConfig } from "./live-codex-config.js";

export interface LiveCodexAgentWiring {
    readonly agent: AgentTurnAdapter;
    readonly ownsAgent: true;
    readonly skillResolvedPath: string;
    readonly inputAdapter: InputAdapter;
    readonly buildOwnershipSurface: (
    context: SolidWorksOwnershipSurfaceContext
  ) => SolidWorksOwnershipSurface;
}

export interface LiveCodexAgentWiringOptions {
    transportFactory?: CodexTransportFactory;
    pdfiumHelperPath?: string;
    documentCloser?: SolidWorksIdentityCloser;
    /** The user's selected model, read per turn (null = CLI default). */
    modelProvider?: () => string | null;
}

export function buildLiveCodexAgentWiring(
  config: LiveCodexConfig,
  options: LiveCodexAgentWiringOptions = {}
): LiveCodexAgentWiring {
  const transportFactory =
    options.transportFactory ??
    webCodexTransportFactory(resolveWebCodexProvider(config.executable, process.env));
  const transport = transportFactory();
  try {
    const client = new CodexAppServerClient({ transport });
    const agent = new CodexAppServerAdapter({
      client,
      ...(options.modelProvider === undefined ? {} : { modelProvider: options.modelProvider }),
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

export function resolvePdfiumHelperPath(
  moduleDirectory: string = path.dirname(fileURLToPath(import.meta.url))
): string {
  const candidates = [
    path.resolve(moduleDirectory, "../adaptation", PYTHON_PDFIUM_HELPER_FILE_NAME),
    path.resolve(moduleDirectory, "../../src/adaptation", PYTHON_PDFIUM_HELPER_FILE_NAME)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
