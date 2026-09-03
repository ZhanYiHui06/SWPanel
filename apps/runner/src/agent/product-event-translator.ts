import type { RunEventPayload, RunStage } from "@swpanel/domain";
import { RUN_STAGES } from "@swpanel/domain";
import {
  Phase4ContractError,
  RUNTIME_METADATA_CONTRACT_VERSION,
  validateProductEventPayload
} from "@swpanel/contracts";
import {
  isRawAgentRecordType,
  RAW_AGENT_RECORDS_VERSION
} from "./raw-agent-records.js";

/**
 * Product-event translator (Phase 4, P4-3): the ONLY bridge from raw Agent
 * runtime records to validated Product Event payloads. The translator
 *
 * - accepts only the versioned raw record protocol and rejects unknown types;
 * - maps the allowed record types onto the payload shapes the shared
 *   `@swpanel/contracts` validator accepts — every constructed payload runs
 *   through `validateProductEventPayload`, the translator never trusts its own
 *   construction;
 * - treats `session_started` / `runtime_log` / `runtime_error` as
 *   technical-only records that produce NO product event;
 * - NEVER derives `Completed` / `Failed` — the terminal event stays owned by
 *   the orchestrator;
 * - reports unsupported versions, unknown types, malformed payloads and
 *   out-of-order streams as a stable structured failure so the caller can fail
 *   the Run with `AGENT_PROTOCOL_INCOMPATIBLE` without exposing raw reasoning
 *   content to the Renderer.
 */

export type RawTranslationFailureCode =
  | "RAW_RECORD_UNSUPPORTED_VERSION"
  | "RAW_RECORD_UNKNOWN_TYPE"
  | "RAW_RECORD_MALFORMED"
  | "RAW_RECORD_OUT_OF_ORDER";

export interface RawTranslationFailure {
  code: RawTranslationFailureCode;
  /** Technical explanation for the Runner log; never surfaced to the UI verbatim. */
  message: string;
  /** Index of the offending record in the raw stream. */
  recordIndex: number;
}

export type RawTranslationResult =
  | { ok: true; payloads: readonly RunEventPayload[] }
  | { ok: false; failure: RawTranslationFailure };

/** Execution context the translator needs for resume watermarks. */
export interface RawTranslationContext {
  attemptId: string;
}

/** Stable Run-level failure code every raw incompatibility maps to. */
export const RAW_PROTOCOL_FAILURE_CODE = "AGENT_PROTOCOL_INCOMPATIBLE" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function failure(
  code: RawTranslationFailureCode,
  recordIndex: number,
  message: string
): RawTranslationResult {
  return { ok: false, failure: { code, message, recordIndex } };
}

function malformed(recordIndex: number, reason: string): RawTranslationResult {
  return failure("RAW_RECORD_MALFORMED", recordIndex, reason);
}

/** Runs the shared strict validator; maps a contract violation to a malformed translation. */
function strictPayload(payload: RunEventPayload): RunEventPayload | null {
  try {
    return validateProductEventPayload(payload);
  } catch (error) {
    if (error instanceof Phase4ContractError) {
      return null;
    }
    throw error;
  }
}

/**
 * Translates one raw Agent record stream into validated Product Event payloads
 * (in stream order, without duplicates). Returns `ok: true` with the payloads —
 * every payload already passed `validateProductEventPayload` — or `ok: false`
 * with the stable structured failure. The stream is validated incrementally
 * and fails fast on the first violation.
 */
export function translateRawAgentRecords(
  records: readonly unknown[],
  context: RawTranslationContext
): RawTranslationResult {
  const payloads: RunEventPayload[] = [];
  let lastOccurredMs = Number.NEGATIVE_INFINITY;
  let sawCompletedTurn = false;

  for (let index = 0; index < records.length; index++) {
    const raw = records[index];
    if (!isRecord(raw)) {
      return malformed(index, "record is not a JSON object");
    }
    if (raw.recordVersion !== RAW_AGENT_RECORDS_VERSION) {
      return failure(
        "RAW_RECORD_UNSUPPORTED_VERSION",
        index,
        `record uses unsupported raw protocol version ${JSON.stringify(raw.recordVersion)}; ` +
          `expected ${RAW_AGENT_RECORDS_VERSION}`
      );
    }
    if (!isRawAgentRecordType(raw.type)) {
      return failure(
        "RAW_RECORD_UNKNOWN_TYPE",
        index,
        `record carries unknown raw type ${JSON.stringify(raw.type)}`
      );
    }
    if (!isNonEmptyString(raw.occurredAt) || Number.isNaN(Date.parse(raw.occurredAt))) {
      return malformed(index, "record occurredAt must be a valid ISO timestamp");
    }
    const occurredMs = Date.parse(raw.occurredAt);
    if (occurredMs < lastOccurredMs) {
      return failure(
        "RAW_RECORD_OUT_OF_ORDER",
        index,
        `record occurredAt ${raw.occurredAt} is earlier than the previous record of the stream`
      );
    }
    lastOccurredMs = occurredMs;
    if (!isNonEmptyString(raw.threadId)) {
      return malformed(index, "record threadId must be a non-empty string");
    }

    switch (raw.type) {
      case "session_started":
      case "runtime_log":
      case "runtime_error":
        // Technical-only records: no product event is ever derived from them.
        continue;
      case "stage_changed": {
        const stage = raw.stage;
        if (typeof stage !== "string" || !RUN_STAGES.includes(stage as RunStage)) {
          return malformed(index, "stage_changed stage must be a known run stage");
        }
        if (raw.activity !== undefined && !isNonEmptyString(raw.activity)) {
          return malformed(index, "stage_changed activity must be a non-empty string when present");
        }
        const validated = strictPayload({
          type: "StageChanged",
          stage: stage as RunStage,
          ...(raw.activity === undefined ? {} : { activity: raw.activity })
        });
        if (validated === null) return malformed(index, "StageChanged payload rejected by the shared validator");
        payloads.push(validated);
        continue;
      }
      case "activity_updated": {
        if (!isNonEmptyString(raw.activity)) {
          return malformed(index, "activity_updated activity must be a non-empty string");
        }
        const validated = strictPayload({ type: "ActivityUpdated", activity: raw.activity });
        if (validated === null) {
          return malformed(index, "ActivityUpdated payload rejected by the shared validator");
        }
        payloads.push(validated);
        continue;
      }
      case "progress_updated": {
        const progressPercent = raw.progressPercent;
        if (
          typeof progressPercent !== "number" ||
          !Number.isInteger(progressPercent) ||
          progressPercent < 0 ||
          progressPercent > 100
        ) {
          return malformed(
            index,
            "progress_updated progressPercent must be an integer between 0 and 100"
          );
        }
        if (raw.activity !== undefined && !isNonEmptyString(raw.activity)) {
          return malformed(index, "progress_updated activity must be a non-empty string when present");
        }
        const validated = strictPayload({
          type: "ProgressUpdated",
          progressPercent,
          ...(raw.activity === undefined ? {} : { activity: raw.activity })
        });
        if (validated === null) {
          return malformed(index, "ProgressUpdated payload rejected by the shared validator");
        }
        payloads.push(validated);
        continue;
      }
      case "clarification_requested": {
        if (!isNonEmptyString(raw.clarificationRequestId)) {
          return malformed(
            index,
            "clarification_requested clarificationRequestId must be a non-empty string"
          );
        }
        const validated = strictPayload({
          type: "ClarificationRequired",
          clarificationRequestId: raw.clarificationRequestId
        });
        if (validated === null) {
          return malformed(index, "ClarificationRequired payload rejected by the shared validator");
        }
        payloads.push(validated);
        continue;
      }
      case "turn_completed": {
        if (!isNonEmptyString(raw.turnId)) {
          return malformed(index, "turn_completed turnId must be a non-empty string");
        }
        const validated = strictPayload({ type: "AgentTurnCompleted", turnId: raw.turnId });
        if (validated === null) {
          return malformed(index, "AgentTurnCompleted payload rejected by the shared validator");
        }
        payloads.push(validated);
        sawCompletedTurn = true;
        continue;
      }
      case "metadata_updated": {
        const metadata = buildRuntimeMetadataDocument(raw, context);
        if (metadata === null) return malformed(index, "metadata_updated payload is malformed");
        const validated = strictPayload({ type: "RuntimeMetadataUpdated", metadata });
        if (validated === null) {
          return malformed(index, "RuntimeMetadataUpdated payload rejected by the shared validator");
        }
        payloads.push(validated);
        continue;
      }
      case "result_manifest": {
        if (!sawCompletedTurn) {
          return failure(
            "RAW_RECORD_OUT_OF_ORDER",
            index,
            "result_manifest arrived before any turn_completed record of the stream"
          );
        }
        if (!isNonEmptyString(raw.manifestRef)) {
          return malformed(index, "result_manifest manifestRef must be a non-empty string");
        }
        const validated = strictPayload({
          type: "ResultManifestReceived",
          manifestRef: raw.manifestRef
        });
        if (validated === null) {
          return malformed(index, "ResultManifestReceived payload rejected by the shared validator");
        }
        payloads.push(validated);
        continue;
      }
    }
  }
  return { ok: true, payloads };
}

/**
 * Builds the structured Runtime Metadata document of a `metadata_updated`
 * record: the runtime capability snapshot, the session thread identity and the
 * resume watermark (`attemptId` comes from the execution context, never from
 * the raw record). Returns null when a raw field is malformed; the shared
 * `validateRuntimeMetadata` pass inside `validateProductEventPayload` is the
 * final authority on the document shape.
 */
function buildRuntimeMetadataDocument(
  raw: Record<string, unknown>,
  context: RawTranslationContext
): Record<string, unknown> | null {
  if (
    !isNonEmptyString(raw.adapterId) ||
    !isNonEmptyString(raw.adapterVersion) ||
    !isNonEmptyString(raw.protocol) ||
    !isNonEmptyString(raw.protocolVersion)
  ) {
    return null;
  }
  if (typeof raw.modelSupportsImageInput !== "boolean") {
    return null;
  }
  if (raw.modelId !== undefined && !isNonEmptyString(raw.modelId)) {
    return null;
  }
  const runtime: Record<string, unknown> = {
    adapterId: raw.adapterId,
    adapterVersion: raw.adapterVersion,
    protocol: raw.protocol,
    protocolVersion: raw.protocolVersion,
    modelSupportsImageInput: raw.modelSupportsImageInput,
    ...(raw.modelId === undefined ? {} : { modelId: raw.modelId })
  };
  const session: Record<string, unknown> = { threadId: raw.threadId };
  if (raw.resumedFromThreadId !== undefined) {
    if (!isNonEmptyString(raw.resumedFromThreadId)) return null;
    session.resumedFromThreadId = raw.resumedFromThreadId;
  }
  const metadata: Record<string, unknown> = {
    contractVersion: RUNTIME_METADATA_CONTRACT_VERSION,
    runtime,
    session,
    updatedAt: raw.occurredAt
  };
  if (raw.lastAppliedSequence !== undefined) {
    const watermark = raw.lastAppliedSequence;
    if (typeof watermark !== "number" || !Number.isSafeInteger(watermark) || watermark < 0) {
      return null;
    }
    metadata.resume = { attemptId: context.attemptId, lastAppliedSequence: watermark };
  }
  return metadata;
}
