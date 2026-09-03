/**
 * The workspace-backed SolidWorks ownership surface (Phase 5, Batch 2): the
 * `FakeExecutorOptions.ownership` implementation of the LIVE product path. It
 * reads the CURRENT Run/attempt's persisted stage and the versioned
 * attempt-scoped ownership registry
 * (`runtime/solidworks-ownership.json`, see `solidworks-ownership-registry.ts`)
 * through an injected workspace seam, and attests every VALID registration
 * through the existing {@link SolidWorksOwnershipGuard} as document
 * identities — the guard then closes ONLY the proven documents.
 *
 * Stage semantics (fail-closed, never an invented proof):
 *
 * - PREPARING / ANALYZING / PLANNING (and a null persisted stage): CAD work
 *   has not started, so the attempt cannot own any live document yet. An
 *   ABSENT registry returns null (`nothing-owned` — a normal cancellation may
 *   proceed); a VALID pre-registered plan also returns null (nothing is owned
 *   before MODELING); a PRESENT but MALFORMED registry is never trusted and
 *   throws at ANY stage (a written registry that violates the contract is a
 *   fail-closed signal, never silently ignored).
 * - MODELING / VALIDATING / PACKAGING: the attempt may own live documents, so
 *   a MISSING registry throws (the plan was never recorded — absence is not
 *   proof), a MALFORMED / binding-mismatched / escaping registry throws, an
 *   unresolvable attempt workspace throws, and a VALID registry is attested
 *   into document identities (absolute attempt-workspace paths) and returned
 *   for the guard to close. Any throw here routes the cancellation through
 *   the executor's cleanup-failure policy: FAILED / CANCEL_CLEANUP_PENDING,
 *   never CANCELLED.
 *
 * The workspace seam is fully injected (dependency injection): the Runner
 * binds it to the real ledger + repository at open() time, and tests bind
 * hermetic fakes — the surface itself never touches the database or the
 * filesystem directly.
 */
import { resolve, sep } from "node:path";

import type { RunStage } from "@swpanel/domain";

import type { SolidWorksOwnershipSurface } from "../fake-executor.js";
import {
  SolidWorksOwnershipGuard,
  type CloseOnlyOwnedOutcome,
  type OwnershipRecord,
  type SnapshotOwnershipInput,
  type SolidWorksIdentityCloser
} from "./solidworks-ownership-guard.js";
import {
  isSolidWorksOwnedStage,
  readSolidWorksOwnershipRegistry
} from "./solidworks-ownership-registry.js";

/** The runtime context of the LIVE seam, injected by the Runner at open(). */
export interface SolidWorksOwnershipSurfaceContext {
  /** Persisted stage of the Run, or null (never started / already terminal). */
  stageOf(runId: string): RunStage | null;
  /**
   * attemptSequence of the CURRENT ACTIVE attempt of the run, but ONLY when
   * its attemptId matches; null when the pair is not the active attempt (the
   * surface must never read another attempt's registry).
   */
  attemptSequenceOf(runId: string, attemptId: string): number | null;
  /** Absolute root of the attempt workspace, or null when unresolvable. */
  attemptRootOf(runId: string, attemptSequence: number): string | null;
  /** Reads one attempt-scoped file; null when absent (throws stay fail-closed). */
  readAttemptFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): Buffer | null;
}

/**
 * A stable, structured failure of the ownership surface: missing / malformed /
 * unverifiable registrations, a stale attempt binding or an unresolvable
 * attempt workspace. The executor catches any throw from
 * `snapshotRecord`/`closeOnlyOwned` and routes it through the cleanup-failure
 * policy (FAILED / CANCEL_CLEANUP_PENDING, never CANCELLED).
 */
export class SolidWorksOwnershipSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolidWorksOwnershipSurfaceError";
  }
}

export interface WorkspaceSolidWorksOwnershipSurfaceOptions {
  /** The injected workspace seam (Runner-bound in production, fakes in tests). */
  workspace: SolidWorksOwnershipSurfaceContext;
  /**
   * The ONLY low-level close path of the attested documents (default callers
   * inject the bounded Python/pywin32 document closer). Receives ONLY
   * individually attested identities, one per call.
   */
  closer: SolidWorksIdentityCloser;
}

/**
 * The workspace-backed {@link SolidWorksOwnershipSurface} of the live path.
 * Attestation is additive per (runId, attemptId) inside the owned guard
 * instance; `closeOnlyOwned` is the guard's own boundary, so a record that
 * was never attested (forged or built outside this surface) is refused as
 * `ownership-unproven` and the closer is never invoked.
 */
export class WorkspaceSolidWorksOwnershipSurface implements SolidWorksOwnershipSurface {
  private readonly workspace: SolidWorksOwnershipSurfaceContext;
  private readonly guard: SolidWorksOwnershipGuard;

  constructor(options: WorkspaceSolidWorksOwnershipSurfaceOptions) {
    this.workspace = options.workspace;
    this.guard = new SolidWorksOwnershipGuard({ closer: options.closer });
  }

  /**
   * The frozen ownership record of the CURRENT attempt, or null when the
   * attempt provably owns nothing yet (pre-CAD stages / absent registry). A
   * throw means the registration cannot be verified and the cancellation must
   * NOT be confirmed.
   */
  snapshotRecord(input: SnapshotOwnershipInput): OwnershipRecord | null {
    const stage = this.workspace.stageOf(input.runId);
    if (stage === null) return null; // never started / terminal: nothing owned
    const attemptSequence = this.workspace.attemptSequenceOf(input.runId, input.attemptId);
    if (attemptSequence === null) {
      throw new SolidWorksOwnershipSurfaceError(
        `attempt ${input.attemptId} is not the current ACTIVE attempt of Run ${input.runId}; ` +
          "its ownership registry can never be verified"
      );
    }
    const read = readSolidWorksOwnershipRegistry(
      {
        readOwnedFile: (input) => this.workspace.readAttemptFile(input)
      },
      {
        runId: input.runId,
        attemptId: input.attemptId,
        attemptSequence
      }
    );
    if (read.status === "invalid") {
      throw new SolidWorksOwnershipSurfaceError(
        `the SolidWorks ownership registry of attempt ${input.attemptId} is malformed ` +
          "(unknown fields, wrong version, non-SLDPRT/escaping/empty documents, more than one " +
          "document — the Phase 5 single-part contract allows EXACTLY ONE .SLDPRT — or a binding " +
          "mismatch); the cancellation cannot be confirmed"
      );
    }
    if (read.status === "absent") {
      if (isSolidWorksOwnedStage(stage)) {
        throw new SolidWorksOwnershipSurfaceError(
          `attempt ${input.attemptId} reached ${stage} without a SolidWorks ownership ` +
            "registry (runtime/solidworks-ownership.json); a missing registration is not proof " +
            "that no document is owned — the cancellation cannot be confirmed"
        );
      }
      return null; // pre-CAD stage, no registration: nothing owned
    }
    // A VALID registry exists. Before MODELING nothing can be owned yet (CAD
    // work has not started), so even a valid pre-registered plan means nothing
    // owned; from MODELING on the documents are attested and closed.
    if (!isSolidWorksOwnedStage(stage)) return null;
    const root = this.workspace.attemptRootOf(input.runId, attemptSequence);
    if (root === null) {
      throw new SolidWorksOwnershipSurfaceError(
        `the attempt workspace of Run ${input.runId} / attempt ${input.attemptId} cannot be ` +
          "resolved; the registered documents can never be verified — the cancellation cannot be confirmed"
      );
    }
    const documentIdentities = read.record.documents.map((relative) =>
      resolveAttemptDocumentPath(input, root, relative)
    );
    this.guard.record({
      runId: input.runId,
      attemptId: input.attemptId,
      documentIdentities
    });
    return this.guard.snapshotRecord(input);
  }

  /** Closes EXACTLY the proven identities of the record (guard boundary). */
  closeOnlyOwned(record: OwnershipRecord): CloseOnlyOwnedOutcome {
    return this.guard.closeOnlyOwned(record);
  }
}

/**
 * Resolves one validated attempt-relative document path against the attempt
 * workspace root. The registry validator already refuses escapes; this
 * canonical resolution re-checks containment (defense in depth) and returns
 * the absolute path the closer compares against `GetPathName` EXACTLY
 * (case/separator normalization happens in the closer's comparison).
 */
function resolveAttemptDocumentPath(
  input: SnapshotOwnershipInput,
  root: string,
  relative: string
): string {
  const absoluteRoot = resolve(root);
  const resolved = resolve(absoluteRoot, ...relative.split("/"));
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : absoluteRoot + sep;
  if (resolved !== absoluteRoot && !resolved.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new SolidWorksOwnershipSurfaceError(
      `document path ${relative} of Run ${input.runId} / attempt ${input.attemptId} escapes ` +
        "the attempt workspace; the cancellation cannot be confirmed"
    );
  }
  return resolved;
}
