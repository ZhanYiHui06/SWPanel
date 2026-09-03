/**
 * Versioned attempt-scoped SolidWorks ownership registry (Phase 5, Batch 2):
 * the machine-readable ownership contract between the Agent and the
 * ownership-safe cancellation surface, persisted at
 * `runtime/solidworks-ownership.json` inside ONE attempt workspace.
 *
 * The registry carries EXACTLY the attempt's own document claims: workspace
 * RELATIVE `.SLDPRT` paths of the SolidWorks documents the attempt creates and
 * saves. It NEVER carries pids, process names, commands or absolute paths —
 * process ownership is a different proof channel (the probe's exact-pid COM
 * proof) and this file is Agent-written, so anything beyond relative document
 * paths is refused. Every read is STRICTLY validated and fail-closed:
 *
 * - unknown fields, a wrong schema version, a binding mismatch (runId /
 *   attemptId / attemptSequence must equal the attempt being cancelled) and
 *   non-ISO timestamps are rejected;
 * - every document must be an attempt-workspace-relative path: no absolute
 *   path, no drive prefix, no traversal/`.`/empty segments, no NUL, and a
 *   case-insensitive `.sldprt` extension (SolidWorks saves real parts only);
 * - an EMPTY document list is rejected (a registry that claims nothing can
 *   never prove anything — the absent-file case is the caller's "no
 *   registration" signal, a present-but-empty file is a contract violation);
 * - the SINGLE-PART contract caps the registry at EXACTLY ONE document
 *   ({@link SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS}) — the Phase 5 chain produces
 *   one editable `.SLDPRT` per Run (planned path first, then the SAME entry
 *   updated to the true saved path). A raw document list with more than one
 *   entry, or a case-insensitively-deduplicated set of more than one distinct
 *   document, is INVALID: unknown/multiple planned/saved part documents can
 *   never be cleaned safely, so the cancellation fails closed
 *   (CANCEL_CLEANUP_PENDING) instead of running an unsafe cleanup;
 * - duplicate raw entries are rejected rather than normalized away: the Agent
 *   must update the single entry in place, never append a second spelling.
 *
 * The read surface distinguishes ABSENT from INVALID: the surface needs the
 * absent case to mean "nothing owned (yet)" at pre-CAD stages, while a
 * PRESENT but malformed registry is never trusted at any stage.
 */
import type { RunStage } from "@swpanel/domain";

/** Canonical registry file inside the attempt workspace (`runtime/`). */
export const SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH =
  "runtime/solidworks-ownership.json" as const;

/** Version of the registry record shape. */
export const SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION = 1 as const;

/**
 * The single-part maximum of the ownership registry: the Phase 5 chain
 * produces EXACTLY ONE editable `.SLDPRT` per Run, so the registry may carry
 * at most one attempt-relative document — the planned path first, then the
 * SAME entry updated to the true saved path, never a second document. A
 * registry whose raw document list, or whose case-insensitively-deduplicated
 * set, exceeds this maximum is INVALID (fail closed): unknown or multiple
 * planned/saved part documents can never be cleaned safely, so the
 * cancellation surfaces CANCEL_CLEANUP_PENDING instead of an unsafe cleanup.
 */
export const SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS = 1 as const;

/**
 * The stages in which the attempt may own live SolidWorks documents. Before
 * MODELING the CAD work has not started, so nothing can be owned; from
 * MODELING on, a missing/malformed/unverifiable registry blocks the
 * cancellation (fail closed).
 */
export const SOLIDWORKS_OWNED_STAGES: readonly RunStage[] = [
  "MODELING",
  "VALIDATING",
  "PACKAGING"
] as const;

/** True when the persisted stage is one the attempt may own documents in. */
export function isSolidWorksOwnedStage(stage: RunStage | null): boolean {
  return stage !== null && SOLIDWORKS_OWNED_STAGES.includes(stage);
}

/**
 * The persisted ownership registry of ONE attempt. Documents are attempt
 * workspace RELATIVE `.SLDPRT` paths (forward slashes, e.g.
 * `working/plate.sldprt`) — the Agent records the plan before CAD starts and
 * updates the real saved paths afterwards. The Phase 5 single-part contract
 * caps the document list at EXACTLY ONE entry
 * ({@link SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS}): the same entry is updated
 * from the planned path to the true saved path, never appended.
 */
export interface SolidWorksOwnershipRegistryRecord {
  schemaVersion: typeof SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION;
  runId: string;
  attemptId: string;
  attemptSequence: number;
  updatedAt: string;
  /** Normalized, deduplicated attempt-workspace-relative `.SLDPRT` paths (at most one). */
  documents: readonly string[];
}

/** The binding a stored registry must match (the attempt being cancelled). */
export interface SolidWorksOwnershipRegistryBinding {
  runId: string;
  attemptId: string;
  attemptSequence: number;
}

/** Strict validator: the normalized record, or null on ANY violation. */
export function validateSolidWorksOwnershipRegistry(
  value: unknown,
  binding: SolidWorksOwnershipRegistryBinding
): SolidWorksOwnershipRegistryRecord | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!(RECORD_KEYS as readonly string[]).includes(key)) return null;
  }
  if (value.schemaVersion !== SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION) return null;
  if (value.runId !== binding.runId) return null;
  if (value.attemptId !== binding.attemptId) return null;
  if (value.attemptSequence !== binding.attemptSequence) return null;
  if (!isIsoTimestamp(value.updatedAt)) return null;
  if (!Array.isArray(value.documents)) return null;
  if (value.documents.length === 0) return null; // empty record: fail closed
  if (value.documents.length > SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS) {
    // The RAW list already exceeds the single-part maximum: multiple planned /
    // saved entries (even duplicates) are a contract violation, fail closed.
    return null;
  }
  const seen = new Set<string>();
  const documents: string[] = [];
  for (const rawDocument of value.documents) {
    if (typeof rawDocument !== "string") return null;
    const relative = normalizeRegistryPath(rawDocument);
    if (relative === null) return null; // escape / absolute / non-sldprt / NUL
    // Dedupe on the case-folded key: Windows filesystems are case-insensitive,
    // so `a.sldprt` and `a.SLDPRT` are the SAME document (the closer compares
    // normcase paths exactly — attesting both would make the second close
    // fail with 0 matches).
    const key = relative.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    documents.push(relative);
  }
  if (documents.length === 0) return null; // only duplicates: still an empty claim
  if (documents.length > SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS) {
    // The NORMALIZED (case-insensitively deduplicated) set exceeds the
    // single-part maximum: more than one distinct document, fail closed.
    return null;
  }
  return {
    schemaVersion: SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION,
    runId: value.runId,
    attemptId: value.attemptId,
    attemptSequence: value.attemptSequence,
    updatedAt: value.updatedAt,
    documents: Object.freeze(documents)
  };
}

const RECORD_KEYS = [
  "schemaVersion",
  "runId",
  "attemptId",
  "attemptSequence",
  "updatedAt",
  "documents"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Normalizes one registry document path to the canonical attempt-relative
 * form (forward slashes, no leading/trailing slash). Returns null when the
 * path is NOT a safe attempt-workspace-relative `.SLDPRT` path: absolute or
 * drive-prefixed, traversal (`..` / `.`), empty segments, a NUL character or
 * any extension other than `.sldprt` (case-insensitive — Windows filesystems
 * are case-insensitive) are all refused.
 */
export function normalizeRegistryPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.includes("\0")) return null;
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return null; // absolute (posix)
  if (/^[A-Za-z]:/.test(normalized)) return null; // drive prefix (Windows)
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) return null; // `//`, trailing `/`
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  if (segments.some((segment) => /^[A-Za-z]:/.test(segment))) return null; // embedded drive
  if (segments.some((segment) => segment.startsWith("."))) return null; // dotfiles / no basename
  const last = segments[segments.length - 1];
  if (last === undefined || !last.toLowerCase().endsWith(".sldprt")) return null;
  return segments.join("/");
}

/**
 * The discriminated read result of the registry store: the surface needs to
 * tell "no registry file" (nothing owned at pre-CAD stages) apart from "the
 * file exists but violates the contract" (NEVER trusted, fail closed).
 */
export type SolidWorksOwnershipRegistryReadResult =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; record: SolidWorksOwnershipRegistryRecord };

/** Minimal read surface of the attempt workspace the store reads through. */
export interface SolidWorksOwnershipRegistryReadSurface {
  readOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): Buffer | null;
}

export interface SolidWorksOwnershipRegistryReadInput {
  runId: string;
  attemptId: string;
  attemptSequence: number;
}

/**
 * Reads + strictly validates the persisted ownership registry of one attempt
 * through the attempt workspace ledger. Absent file -> `absent`; a present
 * file that fails ANY validation rule -> `invalid` (fail closed — a written
 * registry that violates the contract is never trusted); a fully valid
 * registry -> `valid` with the normalized record.
 */
export function readSolidWorksOwnershipRegistry(
  workspace: SolidWorksOwnershipRegistryReadSurface,
  input: SolidWorksOwnershipRegistryReadInput
): SolidWorksOwnershipRegistryReadResult {
  const file = workspace.readOwnedFile({
    runId: input.runId,
    attemptSequence: input.attemptSequence,
    relativePath: SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH
  });
  if (file === null) return { status: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.toString("utf8"));
  } catch {
    return { status: "invalid" };
  }
  const record = validateSolidWorksOwnershipRegistry(parsed, input);
  return record === null ? { status: "invalid" } : { status: "valid", record };
}
