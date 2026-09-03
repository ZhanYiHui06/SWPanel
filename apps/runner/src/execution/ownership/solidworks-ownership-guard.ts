import { InvalidArgumentError } from "../../errors.js";

/**
 * Phase 5 (P5-4): ownership-safe SolidWorks cancellation boundary.
 *
 * The guard is the ONLY cancellation path toward SolidWorks and it is built
 * around explicit, per-attempt ownership proof:
 *
 * - An immutable {@link OwnershipRecord} is bound to (runId, attemptId) and
 *   carries ONLY identities the attempt itself recorded — OS process ids of
 *   SolidWorks processes the attempt spawned and canonical document identities
 *   of documents the attempt opened. Identities are normalized (trimmed,
 *   deduplicated) at record time and the record is frozen.
 * - `closeOnlyOwned` closes ONLY identities whose proof holds for the record's
 *   (runId, attemptId) pair inside this guard instance: any unattested or
 *   mismatched identity makes the WHOLE close `ownership-unproven` and the
 *   closer is not invoked at all — an unproven or mismatched identity is never
 *   closed, and a record minted by another guard instance (e.g. a previous
 *   process generation) cannot prove anything.
 * - The low-level closer is injected and receives ONLY verified individual
 *   identities (one per call). The guard NEVER enumerates processes, NEVER
 *   matches by process name and NEVER offers a "kill all SLDWORKS.exe" style
 *   API — its public surface is exactly `record` / `recordIdentity` /
 *   `snapshotRecord` / `closeOnlyOwned`.
 *
 * Cancellation mapping (used by the executor integration): `closed` and
 * `nothing-owned` allow normal cancellation; `ownership-unproven`, `partial`
 * and `failed` map conservatively to the existing `CANCEL_CLEANUP_PENDING`
 * failure — a cancellation is never confirmed while a SolidWorks identity of
 * the attempt may still be live.
 */

/** A SolidWorks process, identified by its OS process id — never by name. */
export interface SolidWorksPidIdentity {
  readonly kind: "pid";
  /** Positive OS process id of ONE SolidWorks process the attempt spawned. */
  readonly pid: number;
}

/** A SolidWorks document, identified by its canonical document identity. */
export interface SolidWorksDocumentIdentity {
  readonly kind: "document";
  /**
   * Canonical document identity (e.g. the absolute document path or document
   * GUID) of a document the attempt opened. Never a process name.
   */
  readonly documentIdentity: string;
}

/** One verifiable SolidWorks identity originating from the attempt. */
export type SolidWorksIdentity = SolidWorksPidIdentity | SolidWorksDocumentIdentity;

/** Builds the pid identity of one SolidWorks process (validated on record). */
export function pidOf(pid: number): SolidWorksPidIdentity {
  return { kind: "pid", pid };
}

/** Builds the document identity of one SolidWorks document (validated on record). */
export function documentOf(documentIdentity: string): SolidWorksDocumentIdentity {
  return { kind: "document", documentIdentity };
}

/**
 * Immutable ownership record: bound to (runId, attemptId), carrying exactly
 * the normalized, deduplicated identities recorded for that attempt. Every
 * object in the record (the record, the identities array and each identity)
 * is frozen; there is no mutator API.
 */
export interface OwnershipRecord {
  readonly runId: string;
  readonly attemptId: string;
  /** Normalized, deduplicated identities in insertion order. */
  readonly identities: readonly SolidWorksIdentity[];
}

export interface BuildOwnershipRecordInput {
  runId: string;
  attemptId: string;
  identities?: readonly SolidWorksIdentity[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Pure normalizer of an ownership record: validates the binding and every
 * identity (positive safe-integer pid / non-empty trimmed document identity),
 * deduplicates by canonical key and freezes the record. NOTE: building a
 * record this way NEVER attests anything — closing a record that was not
 * recorded through a guard instance is refused as `ownership-unproven` (the
 * missing-proof path); use {@link SolidWorksOwnershipGuard.record} /
 * {@link SolidWorksOwnershipGuard.recordIdentity} to attest.
 */
export function buildOwnershipRecord(input: BuildOwnershipRecordInput): OwnershipRecord {
  if (!isNonEmptyString(input.runId)) {
    throw new InvalidArgumentError("an ownership record requires a non-empty runId");
  }
  if (!isNonEmptyString(input.attemptId)) {
    throw new InvalidArgumentError("an ownership record requires a non-empty attemptId");
  }
  const seen = new Set<string>();
  const identities: SolidWorksIdentity[] = [];
  for (const identity of input.identities ?? []) {
    const normalized = normalizeIdentity(identity);
    const key = identityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push(freezeIdentity(normalized));
  }
  return Object.freeze({
    runId: input.runId,
    attemptId: input.attemptId,
    identities: Object.freeze(identities)
  });
}

/** Validates + normalizes one identity (document identities are trimmed). */
function normalizeIdentity(identity: SolidWorksIdentity): SolidWorksIdentity {
  if (identity.kind === "pid") {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
      throw new InvalidArgumentError(
        `a pid identity requires a positive safe-integer pid, got ${String(identity.pid)}`
      );
    }
    return identity;
  }
  const documentIdentity = identity.documentIdentity.trim();
  if (documentIdentity.length === 0) {
    throw new InvalidArgumentError("a document identity requires a non-empty document identity");
  }
  return { kind: "document", documentIdentity };
}

/** Canonical deduplication key of one identity. */
function identityKey(identity: SolidWorksIdentity): string {
  return identity.kind === "pid" ? `pid:${identity.pid}` : `doc:${identity.documentIdentity}`;
}

/** Freezes one identity object (every record identity is immutable). */
function freezeIdentity(identity: SolidWorksIdentity): SolidWorksIdentity {
  return Object.freeze({ ...identity });
}

/** Why a record's ownership could not be proven. */
export type OwnershipUnprovenReason =
  | "attempt-not-attested"
  | "identity-not-attested";

/**
 * Structured outcome of one {@link SolidWorksOwnershipGuard.closeOnlyOwned}
 * call. `closed` / `nothing-owned` allow normal cancellation; every other
 * status maps conservatively to `CANCEL_CLEANUP_PENDING`.
 */
export type CloseOnlyOwnedOutcome =
  | {
      status: "closed";
      /** Every verified identity of the record was closed successfully. */
      closed: readonly SolidWorksIdentity[];
    }
  | {
      status: "nothing-owned";
    }
  | {
      status: "ownership-unproven";
      reason: OwnershipUnprovenReason;
    }
  | {
      status: "partial";
      closed: readonly SolidWorksIdentity[];
      failed: readonly FailedSolidWorksIdentity[];
    }
  | {
      status: "failed";
      closed: readonly SolidWorksIdentity[];
      failed: readonly FailedSolidWorksIdentity[];
    };

/** One identity the closer threw on, with the structured failure. */
export interface FailedSolidWorksIdentity {
  identity: SolidWorksIdentity;
  error: unknown;
}

/**
 * True when the close outcome allows a normal cancellation to proceed:
 * `closed` (everything verified was closed) and `nothing-owned` (there was
 * nothing to close). Every other status is conservatively NOT safe — the
 * cancellation must surface as `CANCEL_CLEANUP_PENDING` instead of claiming
 * CANCELLED.
 */
export function isOwnedCloseSafeForCancellation(outcome: CloseOnlyOwnedOutcome): boolean {
  return outcome.status === "closed" || outcome.status === "nothing-owned";
}

/**
 * The low-level close path of the guard. Implementations close exactly ONE
 * verified SolidWorks identity (cooperative close of the individual process /
 * document) and throw on failure; they receive ONLY verified individual
 * identities and never process names, enumerations or "all instances" targets.
 */
export interface SolidWorksIdentityCloser {
  close(identity: SolidWorksIdentity): void;
}

export interface SolidWorksOwnershipGuardOptions {
  /** The ONLY low-level close path; receives verified individual identities. */
  closer: SolidWorksIdentityCloser;
}

export interface RecordOwnershipInput {
  runId: string;
  attemptId: string;
  pids?: readonly number[];
  documentIdentities?: readonly string[];
}

export interface RecordIdentityInput {
  runId: string;
  attemptId: string;
  identity: SolidWorksIdentity;
}

export interface SnapshotOwnershipInput {
  runId: string;
  attemptId: string;
}

/**
 * The ownership-safe cancellation boundary of ONE executor process
 * generation. Attestation lives in this instance: identities recorded here can
 * be proven for close; a record that reaches `closeOnlyOwned` without a
 * matching attestation (forged, built via {@link buildOwnershipRecord}, or
 * minted by a previous process generation) is refused as `ownership-unproven`
 * and the closer is never invoked.
 */
export class SolidWorksOwnershipGuard {
  private readonly closer: SolidWorksIdentityCloser;
  /** runId+attemptId -> canonical identity keys attested by this instance. */
  private readonly attested = new Map<string, Set<string>>();

  constructor(options: SolidWorksOwnershipGuardOptions) {
    this.closer = options.closer;
  }

  /**
   * Records (attests) identities originating from the attempt and returns the
   * immutable ownership record bound to (runId, attemptId). Recording is
   * additive: later {@link recordIdentity} calls extend the same attestation;
   * {@link snapshotRecord} returns the current normalized snapshot.
   */
  record(input: RecordOwnershipInput): OwnershipRecord {
    const identities: SolidWorksIdentity[] = [];
    for (const pid of input.pids ?? []) {
      identities.push(pidOf(pid));
    }
    for (const documentIdentity of input.documentIdentities ?? []) {
      identities.push(documentOf(documentIdentity));
    }
    const record = buildOwnershipRecord({
      runId: input.runId,
      attemptId: input.attemptId,
      identities
    });
    attestRecordTo(this.attested, input.runId, input.attemptId, record);
    return record;
  }

  /**
   * Records ONE further identity originating from the attempt (e.g. a
   * SolidWorks process the attempt spawned mid-flight). Does not return a
   * record; call {@link snapshotRecord} to obtain the current frozen snapshot.
   */
  recordIdentity(input: RecordIdentityInput): void {
    const record = buildOwnershipRecord({
      runId: input.runId,
      attemptId: input.attemptId,
      identities: [input.identity]
    });
    attestRecordTo(this.attested, input.runId, input.attemptId, record);
  }

  /** The frozen record of every identity attested for the attempt so far. */
  snapshotRecord(input: SnapshotOwnershipInput): OwnershipRecord {
    const key = attestationKey(input.runId, input.attemptId);
    const keys = this.attested.get(key);
    if (keys === undefined) {
      return buildOwnershipRecord({ runId: input.runId, attemptId: input.attemptId });
    }
    const identities: SolidWorksIdentity[] = [];
    for (const identityKey of keys) {
      if (identityKey.startsWith("pid:")) {
        identities.push(pidOf(Number(identityKey.slice("pid:".length))));
      } else {
        identities.push(documentOf(identityKey.slice("doc:".length)));
      }
    }
    return buildOwnershipRecord({
      runId: input.runId,
      attemptId: input.attemptId,
      identities
    });
  }

  /**
   * Cooperative close of EXACTLY the verified identities of the record.
   * Every identity must be proven for the record's (runId, attemptId) inside
   * this guard instance; any unattested or mismatched identity makes the whole
   * close `ownership-unproven` and the closer is not invoked at all. Proven
   * identities are closed one by one (best-effort: a throw on one identity is
   * recorded and the remaining identities are still attempted), and the
   * structured outcome reports exactly which identities were closed and which
   * failed.
   */
  closeOnlyOwned(record: OwnershipRecord): CloseOnlyOwnedOutcome {
    const validated = validateRecordShape(record);
    if (validated.identities.length === 0) {
      return { status: "nothing-owned" };
    }
    const key = attestationKey(validated.runId, validated.attemptId);
    const attestedKeys = this.attested.get(key);
    if (attestedKeys === undefined) {
      return { status: "ownership-unproven", reason: "attempt-not-attested" };
    }
    for (const identity of validated.identities) {
      if (!attestedKeys.has(identityKey(identity))) {
        // A mismatched/unrecorded identity poisons the WHOLE close: never
        // close anything while any identity of the record is unproven.
        return { status: "ownership-unproven", reason: "identity-not-attested" };
      }
    }
    const closed: SolidWorksIdentity[] = [];
    const failed: FailedSolidWorksIdentity[] = [];
    for (const identity of validated.identities) {
      try {
        this.closer.close(identity);
        closed.push(identity);
      } catch (error) {
        failed.push({ identity, error });
      }
    }
    if (failed.length === 0) {
      return { status: "closed", closed };
    }
    if (closed.length === 0) {
      return { status: "failed", closed: [], failed };
    }
    return { status: "partial", closed, failed };
  }
}

/** Attests the identities of one record into the instance's registry. */
function attestRecordTo(
  attested: Map<string, Set<string>>,
  runId: string,
  attemptId: string,
  record: OwnershipRecord
): void {
  const key = attestationKey(runId, attemptId);
  let keys = attested.get(key);
  if (keys === undefined) {
    keys = new Set();
    attested.set(key, keys);
  }
  for (const identity of record.identities) {
    keys.add(identityKey(identity));
  }
}

function attestationKey(runId: string, attemptId: string): string {
  return `${runId}\u0000${attemptId}`;
}

/**
 * Structural validation of a record BEFORE any proof / close work: a
 * malformed record (bad binding or bad identity shape) is a programming error
 * and is rejected loudly; a well-formed record without attestation is a
 * proof failure and is refused as `ownership-unproven`.
 */
function validateRecordShape(record: OwnershipRecord): OwnershipRecord {
  if (!isNonEmptyString(record.runId)) {
    throw new InvalidArgumentError("an ownership record requires a non-empty runId");
  }
  if (!isNonEmptyString(record.attemptId)) {
    throw new InvalidArgumentError("an ownership record requires a non-empty attemptId");
  }
  // The runtime value may be forged (cast callers): validate the array before
  // trusting any element.
  const rawIdentities: unknown = record.identities;
  if (!Array.isArray(rawIdentities)) {
    throw new InvalidArgumentError("an ownership record requires an identities array");
  }
  const identities = rawIdentities as readonly SolidWorksIdentity[];
  for (const identity of identities) {
    if (
      identity === null ||
      typeof identity !== "object" ||
      (identity.kind !== "pid" && identity.kind !== "document")
    ) {
      throw new InvalidArgumentError("an ownership record carries only pid/document identities");
    }
    if (identity.kind === "pid" && (!Number.isSafeInteger(identity.pid) || identity.pid <= 0)) {
      throw new InvalidArgumentError(
        `a pid identity requires a positive safe-integer pid, got ${String(identity.pid)}`
      );
    }
    if (identity.kind === "document" && !isNonEmptyString(identity.documentIdentity.trim())) {
      throw new InvalidArgumentError("a document identity requires a non-empty document identity");
    }
  }
  return record;
}
