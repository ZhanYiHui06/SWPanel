import type { RunStage } from "@swpanel/domain";
import { RUN_STAGES } from "@swpanel/domain";

/**
 * Minimal raw Agent runtime record protocol (Phase 4, P4-3). The raw runtime
 * output of an Agent turn is a stream of THESE technical records — the fake
 * adapter emits them and a real adapter (Phase 5) would normalize its runtime
 * output to the same shape. Raw records are diagnostic inputs only:
 *
 * - they are written to the attempt workspace technical dirs (`logs/`,
 *   `runtime/`) and NEVER enter the UI event stream directly;
 * - only the shared-contract translator may map the allowed record types onto
 *   validated Product Event payloads; unsupported versions, unknown types,
 *   malformed payloads and out-of-order streams map to a stable structured
 *   failure (`AGENT_PROTOCOL_INCOMPATIBLE` at the Run level), never to raw
 *   reasoning content surfaced to the Renderer;
 * - the terminal `Completed` / `Failed` events are never derived from raw
 *   records: the orchestrator owns them.
 */
export const RAW_AGENT_RECORDS_VERSION = 1 as const;

/**
 * Technical raw log file inside the attempt workspace (never a product event).
 * Both the fake adapter and the Codex App Server adapter write their raw
 * record stream here.
 */
export const RAW_AGENT_LOG_RELATIVE_PATH = "logs/agent-raw.log" as const;

/**
 * Technical session snapshot file inside the attempt workspace (never a
 * product event). Both adapters persist their technical thread session
 * record here through the workspace ledger (strictly validated / redacted).
 */
export const RAW_AGENT_SESSION_RELATIVE_PATH = "runtime/agent-session.json" as const;

export const RAW_AGENT_RECORD_TYPES = [
  "session_started",
  "stage_changed",
  "activity_updated",
  "progress_updated",
  "clarification_requested",
  "turn_completed",
  "metadata_updated",
  "result_manifest",
  "runtime_log",
  "runtime_error"
] as const;
export type RawAgentRecordType = (typeof RAW_AGENT_RECORD_TYPES)[number];

/** True when the type is a known raw record type. */
export function isRawAgentRecordType(type: unknown): type is RawAgentRecordType {
  return typeof type === "string" && (RAW_AGENT_RECORD_TYPES as readonly string[]).includes(type);
}

/** Envelope every raw record carries. */
interface RawAgentRecordBase {
  recordVersion: typeof RAW_AGENT_RECORDS_VERSION;
  type: RawAgentRecordType;
  /** Technical timestamp the raw runtime observed; ordering is enforced by the translator. */
  occurredAt: string;
  /** Session thread the record belongs to. */
  threadId: string;
}

/** Session identity + runtime capability snapshot (technical; the metadata product event is derived from it). */
export interface RawSessionStartedRecord extends RawAgentRecordBase {
  type: "session_started";
  adapterId: string;
  adapterVersion: string;
  protocol: string;
  protocolVersion: string;
  modelId?: string;
  modelSupportsImageInput: boolean;
}

export interface RawStageChangedRecord extends RawAgentRecordBase {
  type: "stage_changed";
  stage: RunStage;
  activity?: string;
}

export interface RawActivityUpdatedRecord extends RawAgentRecordBase {
  type: "activity_updated";
  activity: string;
}

export interface RawProgressUpdatedRecord extends RawAgentRecordBase {
  type: "progress_updated";
  progressPercent: number;
  activity?: string;
}

/**
 * The raw question set is technical-only: the structured Clarification Request
 * persisted for the UI comes from the orchestrator (`clarifyAttempt`), never
 * from raw reasoning output.
 */
export interface RawClarificationRequestedRecord extends RawAgentRecordBase {
  type: "clarification_requested";
  clarificationRequestId: string;
  questions?: readonly unknown[];
}

export interface RawTurnCompletedRecord extends RawAgentRecordBase {
  type: "turn_completed";
  turnId: string;
  /** Free-form agent reasoning summary — technical-only, never a product event. */
  summary?: string;
}

/** Structured runtime snapshot the translator turns into a `RuntimeMetadataUpdated` payload. */
export interface RawMetadataUpdatedRecord extends RawAgentRecordBase {
  type: "metadata_updated";
  adapterId: string;
  adapterVersion: string;
  protocol: string;
  protocolVersion: string;
  modelId?: string;
  modelSupportsImageInput: boolean;
  /** Session continuity: the thread this session was resumed from, when applicable. */
  resumedFromThreadId?: string;
  /** Resume watermark: last event sequence the raw runtime applied before an interruption. */
  lastAppliedSequence?: number;
}

/** The raw Agent claims a Result Manifest; the independent validator decides whether it holds. */
export interface RawResultManifestRecord extends RawAgentRecordBase {
  type: "result_manifest";
  /** Canonical workspace-relative path of the submitted Result Manifest document. */
  manifestRef: string;
}

/** Technical log line — never translated into a product event. */
export interface RawRuntimeLogRecord extends RawAgentRecordBase {
  type: "runtime_log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  details?: unknown;
}

/** Technical runtime error — never translated into a product event. */
export interface RawRuntimeErrorRecord extends RawAgentRecordBase {
  type: "runtime_error";
  code: string;
  message: string;
}

export type RawAgentRecord =
  | RawSessionStartedRecord
  | RawStageChangedRecord
  | RawActivityUpdatedRecord
  | RawProgressUpdatedRecord
  | RawClarificationRequestedRecord
  | RawTurnCompletedRecord
  | RawMetadataUpdatedRecord
  | RawResultManifestRecord
  | RawRuntimeLogRecord
  | RawRuntimeErrorRecord;

/** The six user-visible stages raw `stage_changed` records may carry. */
export const RAW_AGENT_RUN_STAGES: readonly RunStage[] = RUN_STAGES;
