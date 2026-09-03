/**
 * Technical thread session record + store (Phase 5, P5-3). One technical
 * record per Run attempt is persisted at `runtime/agent-session.json` through
 * the attempt workspace ledger. The record is STRICTLY validated on read and
 * REDACTED by construction: it carries only technical identity/status fields
 * (thread, turn, adapter/protocol versions, timestamps, workspace-relative
 * manifest ref) — never raw reasoning content, never the prompt text and
 * never absolute host paths.
 *
 * The record is a technical snapshot, never a product event: the UI event
 * stream is derived exclusively through the product-event translator, and
 * terminal events stay orchestrator-owned. Fresh-start vs resume of the Agent
 * thread is decided by the adapter from a SUPPLIED prior session record
 * (strictly validated here) — no database fallback in this batch.
 */

/** Canonical technical session file inside the attempt workspace. */
export const AGENT_SESSION_FILE_RELATIVE_PATH = "runtime/agent-session.json" as const;

/** Version of the technical session record shape. */
export const AGENT_SESSION_SCHEMA_VERSION = 1 as const;

/** Technical lifecycle status of the session's last known turn. */
export const AGENT_SESSION_STATUSES = [
  "started",
  "in_progress",
  "completed",
  "interrupted",
  "failed"
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** Redacted technical session record (allowlisted fields only). */
export interface AgentSessionRecord {
  schemaVersion: typeof AGENT_SESSION_SCHEMA_VERSION;
  /** The runtime thread the session owns; the resume key of a later attempt. */
  threadId: string;
  status: AgentSessionStatus;
  adapterId: string;
  adapterVersion: string;
  protocol: string;
  protocolVersion: string;
  startedAt: string;
  updatedAt: string;
  /** The last started turn of the session, when known. */
  turnId?: string;
  /** Thread this session resumed from (session continuity). */
  resumedFromThreadId?: string;
  /** The attempt that owns this session record. */
  attemptId?: string;
  /** Workspace-relative Result Manifest path, when the turn completed. */
  manifestRef?: string;
  /** Technical note (never raw reasoning content). */
  note?: string;
}

/** Minimal write surface of the attempt workspace the store persists through. */
export interface AgentSessionWriteSurface {
  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): unknown;
}

/** Minimal read surface of the attempt workspace the store reads through. */
export interface AgentSessionReadSurface {
  readOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): { content?: Buffer } | null;
}

export interface BuildAgentSessionRecordInput {
  threadId: string;
  status: AgentSessionStatus;
  adapterId: string;
  adapterVersion: string;
  protocol: string;
  protocolVersion: string;
  nowIso: () => string;
  turnId?: string;
  resumedFromThreadId?: string;
  manifestRef?: string;
  attemptId?: string;
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

const RECORD_KEYS = [
  "schemaVersion",
  "threadId",
  "status",
  "adapterId",
  "adapterVersion",
  "protocol",
  "protocolVersion",
  "startedAt",
  "updatedAt",
  "turnId",
  "resumedFromThreadId",
  "manifestRef",
  "attemptId",
  "note"
] as const;

/**
 * Builds a FRESH technical session record (both timestamps = now). Updates at
 * later milestones are applied through {@link withAgentSessionStatus}, which
 * preserves the original `startedAt`.
 */
export function buildAgentSessionRecord(input: BuildAgentSessionRecordInput): AgentSessionRecord {
  const now = input.nowIso();
  return {
    schemaVersion: AGENT_SESSION_SCHEMA_VERSION,
    threadId: input.threadId,
    status: input.status,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    protocol: input.protocol,
    protocolVersion: input.protocolVersion,
    startedAt: now,
    updatedAt: now,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.resumedFromThreadId === undefined
      ? {}
      : { resumedFromThreadId: input.resumedFromThreadId }),
    ...(input.manifestRef === undefined ? {} : { manifestRef: input.manifestRef }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    ...(input.note === undefined ? {} : { note: input.note })
  };
}

export interface AgentSessionUpdateInput {
  status: AgentSessionStatus;
  nowIso: () => string;
  turnId?: string;
  manifestRef?: string;
  /** Replaces the technical note (e.g. a sanitized failure diagnostic). */
  note?: string;
}

/**
 * Returns the record with the new status / optional fields applied and
 * `updatedAt` refreshed; `startedAt` (the session's origin) is preserved.
 */
export function withAgentSessionStatus(
  record: AgentSessionRecord,
  input: AgentSessionUpdateInput
): AgentSessionRecord {
  return {
    ...record,
    status: input.status,
    updatedAt: input.nowIso(),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.manifestRef === undefined ? {} : { manifestRef: input.manifestRef }),
    ...(input.note === undefined ? {} : { note: input.note })
  };
}

/**
 * Strictly validates a parsed technical session record. Returns the normalized
 * record, or null on ANY violation: unknown keys, wrong schema version,
 * malformed types, unknown status or non-ISO timestamps are all rejected (a
 * malformed stored session is never trusted for a resume — the caller falls
 * back to a fresh start).
 */
export function validateAgentSessionRecord(value: unknown): AgentSessionRecord | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!(RECORD_KEYS as readonly string[]).includes(key)) return null;
  }
  if (value.schemaVersion !== AGENT_SESSION_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(value.threadId)) return null;
  if (
    typeof value.status !== "string" ||
    !(AGENT_SESSION_STATUSES as readonly string[]).includes(value.status)
  ) {
    return null;
  }
  if (
    !isNonEmptyString(value.adapterId) ||
    !isNonEmptyString(value.adapterVersion) ||
    !isNonEmptyString(value.protocol) ||
    !isNonEmptyString(value.protocolVersion)
  ) {
    return null;
  }
  if (!isIsoTimestamp(value.startedAt) || !isIsoTimestamp(value.updatedAt)) return null;
  if (value.turnId !== undefined && !isNonEmptyString(value.turnId)) return null;
  if (value.resumedFromThreadId !== undefined && !isNonEmptyString(value.resumedFromThreadId)) {
    return null;
  }
  if (value.manifestRef !== undefined && !isNonEmptyString(value.manifestRef)) return null;
  if (value.attemptId !== undefined && !isNonEmptyString(value.attemptId)) return null;
  if (value.note !== undefined && !isNonEmptyString(value.note)) return null;
  return {
    schemaVersion: AGENT_SESSION_SCHEMA_VERSION,
    threadId: value.threadId,
    status: value.status as AgentSessionStatus,
    adapterId: value.adapterId,
    adapterVersion: value.adapterVersion,
    protocol: value.protocol,
    protocolVersion: value.protocolVersion,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
    ...(value.resumedFromThreadId === undefined
      ? {} : { resumedFromThreadId: value.resumedFromThreadId }),
    ...(value.manifestRef === undefined ? {} : { manifestRef: value.manifestRef }),
    ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
    ...(value.note === undefined ? {} : { note: value.note })
  };
}

export interface AgentSessionWriteInput {
  runId: string;
  attemptSequence: number;
  record: AgentSessionRecord;
}

/**
 * Persists the technical session record at `runtime/agent-session.json`
 * through the attempt workspace ledger (the ONLY writer of the canonical
 * session path).
 */
export function writeAgentSessionRecord(
  workspace: AgentSessionWriteSurface,
  input: AgentSessionWriteInput
): void {
  workspace.writeOwnedFile({
    runId: input.runId,
    attemptSequence: input.attemptSequence,
    relativePath: AGENT_SESSION_FILE_RELATIVE_PATH,
    content: Buffer.from(JSON.stringify(input.record, null, 2) + "\n", "utf8")
  });
}

export interface AgentSessionReadInput {
  runId: string;
  attemptSequence: number;
}

/**
 * Reads + strictly validates the persisted technical session record of an
 * attempt. Returns the record, or null when the file is absent or malformed —
 * a malformed session is NEVER trusted for a resume (fresh start instead).
 */
export function readAgentSessionRecord(
  workspace: AgentSessionReadSurface,
  input: AgentSessionReadInput
): AgentSessionRecord | null {
  const file = workspace.readOwnedFile({
    runId: input.runId,
    attemptSequence: input.attemptSequence,
    relativePath: AGENT_SESSION_FILE_RELATIVE_PATH
  });
  if (file === null || file.content === undefined) return null;
  try {
    return validateAgentSessionRecord(JSON.parse(file.content.toString("utf8")));
  } catch {
    return null;
  }
}
