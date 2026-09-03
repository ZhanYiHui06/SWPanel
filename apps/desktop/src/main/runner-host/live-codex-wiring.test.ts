import { existsSync, readFileSync } from "node:fs";
import path, { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerAdapter,
  PYTHON_PDFIUM_HELPER_FILE_NAME,
  PythonPdfiumRasterizer,
  RealPdfInputAdapter,
  SolidWorksDocumentCloser,
  WorkspaceSolidWorksOwnershipSurface,
  type CodexTransport,
  type CodexTransportFactory,
  type SolidWorksIdentity,
  type SolidWorksOwnershipSurfaceContext
} from "@swpanel/runner";

import type { LiveCodexConfig } from "./live-codex-config.js";
import {
  buildLiveCodexAgentWiring,
  resolvePdfiumHelperPath
} from "./live-codex-wiring.js";

const SKILL_DIRECTORY = join("C:", "skills", "solidworks-build-part-from-drawing");

/** In-memory transport: records construction/close, never spawns a process. */
class FakeTransport implements CodexTransport {
  closed = false;
  writeLine(): void {}
  setLineHandler(): void {}
  setExitHandler(): void {}
  close(): void {
    this.closed = true;
  }
}

/** Records every transport the factory produced (exactly-one assertion). */
function countingFactory(track: { transports: FakeTransport[] }): CodexTransportFactory {
  return () => {
    const transport = new FakeTransport();
    track.transports.push(transport);
    return transport;
  };
}

function liveConfig(
  overrides: Partial<
    Pick<LiveCodexConfig, "executable" | "modelImageInputSupported">
  > = {}
): LiveCodexConfig {
  return {
    enabled: true,
    executable: "codex",
    skillName: "solidworks-build-part-from-drawing",
    skillPath: SKILL_DIRECTORY,
    modelImageInputSupported: undefined,
    forceReloadSkills: false,
    ...overrides
  };
}

/** Runtime read of the adapter's private fail-closed image-support flag. */
function imageSupportOf(wiring: ReturnType<typeof buildLiveCodexAgentWiring>): boolean {
  return (wiring.agent as unknown as { modelSupportsImageInput: boolean })
    .modelSupportsImageInput;
}

describe("buildLiveCodexAgentWiring (live Codex execution wiring)", () => {
  it("creates exactly ONE persistent Codex child transport per Runner", () => {
    const track = { transports: [] as FakeTransport[] };
    const wiring = buildLiveCodexAgentWiring(
      liveConfig(),
      { transportFactory: countingFactory(track) }
    );

    expect(track.transports).toHaveLength(1);
    expect(wiring.agent).toBeInstanceOf(CodexAppServerAdapter);
  });

  it("hands the adapter to the Runner as OWNED with the configured Skill DIRECTORY", () => {
    const wiring = buildLiveCodexAgentWiring(liveConfig(), {
      transportFactory: () => new FakeTransport()
    });

    expect(wiring.ownsAgent).toBe(true);
    expect(wiring.skillResolvedPath).toBe(SKILL_DIRECTORY);
  });

  it("injects the real PDF input adapter over the Python pdfium rasterizer", () => {
    const wiring = buildLiveCodexAgentWiring(liveConfig(), {
      transportFactory: () => new FakeTransport()
    });

    expect(wiring.inputAdapter).toBeInstanceOf(RealPdfInputAdapter);
    // The adapter's rasterizer member is private; the wiring-level assertion
    // is the concrete engine the adapter received (never a fake or stub).
    const rasterizer = (wiring.inputAdapter as unknown as { rasterizer: unknown })
      .rasterizer;
    expect(rasterizer).toBeInstanceOf(PythonPdfiumRasterizer);
  });

  it("passes the AUTHORITATIVE image-support configuration and fails CLOSED when absent", () => {
    const denied = buildLiveCodexAgentWiring(
      liveConfig({ modelImageInputSupported: false }),
      { transportFactory: () => new FakeTransport() }
    );
    expect(imageSupportOf(denied)).toBe(false);

    const supported = buildLiveCodexAgentWiring(
      liveConfig({ modelImageInputSupported: true }),
      { transportFactory: () => new FakeTransport() }
    );
    expect(imageSupportOf(supported)).toBe(true);

    // Absent (undefined) must NEVER invent image support: the adapter records
    // false, exactly like an explicit denial.
    const absent = buildLiveCodexAgentWiring(liveConfig(), {
      transportFactory: () => new FakeTransport()
    });
    expect(imageSupportOf(absent)).toBe(false);
  });

  it("closes the spawned child when later PDF wiring fails before Runner ownership transfers", () => {
    const transport = new FakeTransport();

    expect(() =>
      buildLiveCodexAgentWiring(liveConfig(), {
        transportFactory: () => transport,
        pdfiumHelperPath: path.resolve("missing", "pdfium-rasterizer-helper.py")
      })
    ).toThrow();
    expect(transport.closed).toBe(true);
  });

  it("produces the ownership surface factory of the live seam (workspace seams bound by the Runner)", () => {
    const wiring = buildLiveCodexAgentWiring(liveConfig(), {
      transportFactory: () => new FakeTransport()
    });
    expect(typeof wiring.buildOwnershipSurface).toBe("function");

    const closed: SolidWorksIdentity[] = [];
    const surface = wiring.buildOwnershipSurface({
      stageOf: () => "MODELING",
      attemptSequenceOf: () => 1,
      attemptRootOf: () => join("C:", "workspaces", "runs", "run-1", "attempt-001"),
      readAttemptFile: () => null
    });
    // The factory-built surface is the real workspace-backed surface: at
    // MODELING a MISSING registry fails closed (never an invented proof).
    expect(surface).toBeInstanceOf(WorkspaceSolidWorksOwnershipSurface);
    expect(() => surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" })).toThrow(
      /without a SolidWorks ownership registry/
    );
    expect(closed).toEqual([]);
  });

  it("binds the DEFAULT bounded Python/pywin32 document closer into the factory-built surface", () => {
    const wiring = buildLiveCodexAgentWiring(liveConfig(), {
      transportFactory: () => new FakeTransport()
    });
    const surface = wiring.buildOwnershipSurface(fakeOwnershipContext(
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSequence: 1,
        updatedAt: "2026-08-16T09:00:00.000Z",
        documents: ["working/plate.sldprt"]
      })
    ));
    // With a VALID registry at MODELING the surface attests and the guard
    // calls the closer — the DEFAULT closer is the real document closer
    // (never a fake), so the live seam would spawn the bounded Python helper.
    const record = surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" });
    expect(record?.identities).toEqual([
      {
        kind: "document",
        documentIdentity: join(
          "C:",
          "workspaces",
          "runs",
          "run-1",
          "attempt-001",
          "working",
          "plate.sldprt"
        )
      }
    ]);
  });

  it("uses the INJECTED document closer (hermetic wiring tests never spawn Python)", () => {
    const closed: SolidWorksIdentity[] = [];
    const wiring = buildLiveCodexAgentWiring(liveConfig(), {
      transportFactory: () => new FakeTransport(),
      documentCloser: {
        close: (identity) => {
          closed.push(identity);
        }
      }
    });
    const surface = wiring.buildOwnershipSurface(fakeOwnershipContext(
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        attemptId: "attempt-1",
        attemptSequence: 1,
        updatedAt: "2026-08-16T09:00:00.000Z",
        documents: ["working/plate.sldprt"]
      })
    ));
    const record = surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" });
    expect(record).not.toBeNull();
    const outcome = surface.closeOnlyOwned(record!);
    expect(outcome.status).toBe("closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toEqual(record?.identities[0]);
  });

  it("the DEFAULT closer of the live seam is the real SolidWorksDocumentCloser", () => {
    const wiring = buildLiveCodexAgentWiring(liveConfig(), {
      transportFactory: () => new FakeTransport()
    });
    const surface = wiring.buildOwnershipSurface(
      fakeOwnershipContext("") // never consulted for this assertion
    );
    // The surface's guard closes through the closer injected at construction;
    // without an explicit documentCloser the wiring must have installed the
    // real bounded Python/pywin32 closer (fail closed: it refuses pids).
    const surfaceWithCloser = surface as unknown as {
      guard: { closer: unknown };
    };
    expect(surfaceWithCloser.guard.closer).toBeInstanceOf(SolidWorksDocumentCloser);
    expect(() =>
      (surfaceWithCloser.guard.closer as SolidWorksDocumentCloser).close({
        kind: "pid",
        pid: 101
      })
    ).toThrow(/never closes a process/);
  });
});

/** A hermetic context whose registry read returns the given file content. */
function fakeOwnershipContext(registryContent: string): SolidWorksOwnershipSurfaceContext {
  return {
    stageOf: () => "MODELING",
    attemptSequenceOf: (runId, attemptId) =>
      runId === "run-1" && attemptId === "attempt-1" ? 1 : null,
    attemptRootOf: () => join("C:", "workspaces", "runs", "run-1", "attempt-001"),
    readAttemptFile: () =>
      registryContent.length === 0 ? null : Buffer.from(registryContent, "utf8")
  };
}

describe("resolvePdfiumHelperPath (bundled-main compatible helper resolution)", () => {
  it("resolves to an existing pdfium-rasterizer-helper.py with readable content", () => {
    const helperPath = resolvePdfiumHelperPath();

    expect(basename(helperPath)).toBe(PYTHON_PDFIUM_HELPER_FILE_NAME);
    expect(existsSync(helperPath)).toBe(true);
    // The rasterizer constructor reads the file; the resolved entry must be
    // the real script, never an invented placeholder.
    expect(readFileSync(helperPath, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("resolves from the BUNDLED desktop main directory to the runner dist helper (dev + packaged ASAR shape)", () => {
    // Repo root from this test tree (apps/desktop/src/main/runner-host, five
    // levels up). NOTE: `new URL(relative, import.meta.url)` is rewritten by
    // vitest to a server-relative URL, so the walk goes through
    // fileURLToPath + path.resolve instead.
    const testModuleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(testModuleDirectory, "../../../../..");
    const bundledMainDirectory = join(repoRoot, "apps", "desktop", "dist", "main");
    const helperPath = resolvePdfiumHelperPath(bundledMainDirectory);

    expect(basename(helperPath)).toBe(PYTHON_PDFIUM_HELPER_FILE_NAME);
    // The exact asar entry scripts/audit-asar.mjs requires: the runner dist
    // adaptation helper, reachable from the bundled main by a pure relative
    // walk (identical inside the packaged asar).
    expect(helperPath.replace(/\\/g, "/")).toContain(
      "apps/runner/dist/adaptation/"
    );
    expect(existsSync(helperPath)).toBe(true);
  });
});
