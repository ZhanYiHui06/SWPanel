import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  OwnershipRecord,
  SolidWorksIdentity
} from "./solidworks-ownership-guard.js";
import {
  SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
  SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION
} from "./solidworks-ownership-registry.js";
import {
  SolidWorksOwnershipSurfaceError,
  WorkspaceSolidWorksOwnershipSurface,
  type SolidWorksOwnershipSurfaceContext
} from "./workspace-solidworks-ownership-surface.js";

/** In-memory workspace seam of the surface (hermetic, fully injected). */
function seam(overrides: Partial<SolidWorksOwnershipSurfaceContext> = {}) {
  const files = new Map<string, string>();
  return {
    files,
    context: {
      stageOf: () => "MODELING" as const,
      attemptSequenceOf: (runId: string, attemptId: string) =>
        runId === "run-1" && attemptId === "attempt-1" ? 1 : null,
      attemptRootOf: (runId: string, attemptSequence: number) =>
        runId === "run-1" && attemptSequence === 1
          ? resolve(join("C:", "workspaces", "runs", runId, "attempt-001"))
          : null,
      readAttemptFile: (input: { relativePath: string }) => {
        const content = files.get(input.relativePath);
        return content === undefined ? null : Buffer.from(content, "utf8");
      },
      ...overrides
    } satisfies SolidWorksOwnershipSurfaceContext
  };
}

function registryJson(documents: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION,
    runId: "run-1",
    attemptId: "attempt-1",
    attemptSequence: 1,
    updatedAt: "2026-08-16T09:00:00.000Z",
    documents
  });
}

/** Records the identities the closer received. */
function recordingCloser() {
  const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
    void _identity;
  });
  return { close, closer: { close } };
}

describe("WorkspaceSolidWorksOwnershipSurface", () => {
  it("returns null at PREPARING/ANALYZING/PLANNING with NO registry (nothing owned)", () => {
    for (const stage of ["PREPARING", "ANALYZING", "PLANNING"] as const) {
      const { close, closer } = recordingCloser();
      const { context } = seam({ stageOf: () => stage });
      const surface = new WorkspaceSolidWorksOwnershipSurface({ workspace: context, closer });
      expect(
        surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" })
      ).toBeNull();
      expect(close).not.toHaveBeenCalled();
    }
  });

  it("returns null for a VALID pre-registered plan at a pre-CAD stage (nothing owned yet)", () => {
    const { close, closer } = recordingCloser();
    const { context, files } = seam({ stageOf: () => "PLANNING" });
    files.set(
      SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
      registryJson(["working/plate.sldprt"])
    );
    const surface = new WorkspaceSolidWorksOwnershipSurface({ workspace: context, closer });
    expect(surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" })).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it("throws for a PRESENT but MALFORMED registry at ANY stage (fail closed, never ignored)", () => {
    for (const stage of ["PLANNING", "MODELING"] as const) {
      const { context, files } = seam({ stageOf: () => stage });
      files.set(SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH, registryJson(["../escape.sldprt"]));
      const surface = new WorkspaceSolidWorksOwnershipSurface({
        workspace: context,
        closer: recordingCloser().closer
      });
      expect(() =>
        surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" })
      ).toThrow(SolidWorksOwnershipSurfaceError);
    }
  });

  it("throws at MODELING for a registry with MULTIPLE documents (single-part contract, fail closed) and never closes", () => {
    const { close, closer } = recordingCloser();
    const { context, files } = seam();
    // Two planned/saved part documents are a contract violation: unknown or
    // multiple documents can never be cleaned safely, so the cancellation
    // must fail closed (the executor maps the throw to CANCEL_CLEANUP_PENDING)
    // instead of closing an ambiguous set.
    files.set(
      SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
      registryJson(["working/plate.sldprt", "output/plate-model.sldprt"])
    );
    const surface = new WorkspaceSolidWorksOwnershipSurface({ workspace: context, closer });
    expect(() => surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" })).toThrow(
      /EXACTLY ONE/
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("throws when the registry is MISSING at MODELING and later (absence is not proof)", () => {
    for (const stage of ["MODELING", "VALIDATING", "PACKAGING"] as const) {
      const { context } = seam({ stageOf: () => stage });
      const surface = new WorkspaceSolidWorksOwnershipSurface({
        workspace: context,
        closer: recordingCloser().closer
      });
      expect(() =>
        surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" })
      ).toThrow(/without a SolidWorks ownership registry/);
    }
  });

  it("throws when the attempt is not the current ACTIVE attempt", () => {
    const { context } = seam();
    const surface = new WorkspaceSolidWorksOwnershipSurface({
      workspace: context,
      closer: recordingCloser().closer
    });
    expect(() =>
      surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-9" })
    ).toThrow(/not the current ACTIVE attempt/);
  });

  it("throws when the attempt workspace root cannot be resolved", () => {
    const { context, files } = seam({ attemptRootOf: () => null });
    files.set(SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH, registryJson(["working/plate.sldprt"]));
    const surface = new WorkspaceSolidWorksOwnershipSurface({
      workspace: context,
      closer: recordingCloser().closer
    });
    expect(() =>
      surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" })
    ).toThrow(/cannot be resolved/);
  });

  it("returns null when the persisted stage is null (never started / terminal)", () => {
    const { context } = seam({ stageOf: () => null });
    const surface = new WorkspaceSolidWorksOwnershipSurface({
      workspace: context,
      closer: recordingCloser().closer
    });
    expect(surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" })).toBeNull();
  });

  it("attests a VALID single-document registry at MODELING into one absolute document identity and closes it", () => {
    const { close, closer } = recordingCloser();
    const { context, files } = seam();
    files.set(
      SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
      registryJson(["working/底板-法兰.SLDPRT"])
    );
    const surface = new WorkspaceSolidWorksOwnershipSurface({ workspace: context, closer });

    const record = surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" });
    expect(record).not.toBeNull();
    const root = resolve(join("C:", "workspaces", "runs", "run-1", "attempt-001"));
    expect(record?.identities).toEqual([
      { kind: "document", documentIdentity: join(root, "working", "底板-法兰.SLDPRT") }
    ]);

    const outcome = surface.closeOnlyOwned(record!);
    expect(outcome).toEqual({ status: "closed", closed: record?.identities });
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls).toEqual(record?.identities.map((identity) => [identity]));
  });

  it("a forged record is refused as ownership-unproven and the closer is never invoked", () => {
    const { close, closer } = recordingCloser();
    const { context, files } = seam();
    files.set(SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH, registryJson(["working/plate.sldprt"]));
    const surface = new WorkspaceSolidWorksOwnershipSurface({ workspace: context, closer });
    const record = surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" });
    expect(record).not.toBeNull();

    const forged: OwnershipRecord = {
      runId: "run-1",
      attemptId: "attempt-1",
      identities: [{ kind: "document", documentIdentity: "C:\\forged.sldprt" }]
    };
    const outcome = surface.closeOnlyOwned(forged);
    expect(outcome).toEqual({ status: "ownership-unproven", reason: "identity-not-attested" });
    expect(close).not.toHaveBeenCalled();
  });

  it("a throwing closer surfaces as a structured partial outcome (the executor fails the cancel)", () => {
    const close = vi.fn<(identity: SolidWorksIdentity) => void>(() => {
      throw new Error("document still open");
    });
    const { context, files } = seam();
    files.set(SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH, registryJson(["working/a.sldprt"]));
    const surface = new WorkspaceSolidWorksOwnershipSurface({
      workspace: context,
      closer: { close }
    });
    const record = surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" });
    const outcome = surface.closeOnlyOwned(record!);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failed).toHaveLength(1);
      expect(outcome.failed[0]?.error).toBeInstanceOf(Error);
    }
  });

  it("re-attestation is additive but never duplicates (snapshot twice, close once)", () => {
    const { close, closer } = recordingCloser();
    const { context, files } = seam();
    files.set(SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH, registryJson(["working/a.sldprt"]));
    const surface = new WorkspaceSolidWorksOwnershipSurface({ workspace: context, closer });

    const first = surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" });
    const second = surface.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" });
    expect(second?.identities).toEqual(first?.identities);
    const outcome = surface.closeOnlyOwned(second!);
    expect(outcome.status).toBe("closed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
