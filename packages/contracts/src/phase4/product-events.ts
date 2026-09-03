import type { RunEvent, RunEventPayload, RunEventType, RunFailureCode, RunStage } from "@swpanel/domain";
import {
  RUN_EVENT_CONTRACT_VERSION,
  RUN_EVENT_TYPES,
  RUN_FAILURE_CODES,
  RUN_STAGES
} from "@swpanel/domain";
import {
  PHASE4_SCHEMA_DRAFT,
  PRODUCT_EVENTS_SCHEMA_ID
} from "./schema-ids.js";
import {
  Phase4ContractError,
  assertNoUnknownKeys,
  assertNonEmptyString,
  assertOptionalNonEmptyString,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isRecord
} from "./shared.js";
import { validateRuntimeMetadata, RUNTIME_METADATA_JSON_SCHEMA } from "./runtime-metadata.js";

/**
 * Versioned Product Events contract: the strict payload schema of every one of
 * the twelve structured `RUN_EVENT_TYPES`. Raw Agent logs are diagnostic inputs
 * and never become product events; the UI only consumes events that satisfy
 * this contract. The version is pinned to the canonical domain Run event
 * contract version so the two can never drift apart.
 */
export const PRODUCT_EVENTS_CONTRACT_VERSION = RUN_EVENT_CONTRACT_VERSION;

const RUN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);
const RUN_STAGE_SET: ReadonlySet<string> = new Set(RUN_STAGES);
const RUN_FAILURE_CODE_SET: ReadonlySet<string> = new Set(RUN_FAILURE_CODES);

/** Envelope fields owned by the event wrapper, not by any event payload. */
const PRODUCT_EVENT_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "contractVersion",
  "runId",
  "attemptId",
  "sequence",
  "occurredAt",
  "runtimeThreadId"
]);

/** Property subschemas of the mandatory event envelope shared by every payload variant. */
const PRODUCT_EVENT_ENVELOPE_PROPERTIES = {
  contractVersion: { const: PRODUCT_EVENTS_CONTRACT_VERSION },
  runId: { type: "string", minLength: 1 },
  attemptId: { type: "string", minLength: 1 },
  sequence: { type: "integer", minimum: 0 },
  occurredAt: { type: "string", format: "date-time" },
  runtimeThreadId: { type: "string", minLength: 1 }
} as const;

/** Envelope fields required on every product event, payload fields excluded. */
const PRODUCT_EVENT_REQUIRED_ENVELOPE = [
  "contractVersion",
  "runId",
  "attemptId",
  "sequence",
  "occurredAt",
  "type"
] as const;

/** JSON Schema document registering/documenting the Product Events contract. */
export const PRODUCT_EVENTS_JSON_SCHEMA = {
  $schema: PHASE4_SCHEMA_DRAFT,
  $id: PRODUCT_EVENTS_SCHEMA_ID,
  title: "SWPanel Product Events",
  description:
    "Structured product events derived from raw Agent output. The document " +
    "encodes the discriminated payload of every RUN_EVENT_TYPE as one closed " +
    "oneOf branch (envelope plus type-specific fields; unknown fields are " +
    "rejected); the shared contract validator remains the authoritative gate.",
  type: "object",
  oneOf: [
    {
      title: "StageChanged",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "stage"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "StageChanged" },
        stage: { enum: [...RUN_STAGES] },
        activity: { type: "string", minLength: 1 }
      }
    },
    {
      title: "ActivityUpdated",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "activity"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "ActivityUpdated" },
        activity: { type: "string", minLength: 1 }
      }
    },
    {
      title: "ProgressUpdated",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "progressPercent"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "ProgressUpdated" },
        progressPercent: { type: "number", minimum: 0, maximum: 100 },
        activity: { type: "string", minLength: 1 }
      }
    },
    {
      title: "ClarificationRequired",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "clarificationRequestId"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "ClarificationRequired" },
        clarificationRequestId: { type: "string", minLength: 1 }
      }
    },
    {
      title: "AgentTurnCompleted",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "turnId"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "AgentTurnCompleted" },
        turnId: { type: "string", minLength: 1 }
      }
    },
    {
      title: "RuntimeMetadataUpdated",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "metadata"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "RuntimeMetadataUpdated" },
        metadata: { $ref: "#/definitions/runtimeMetadata" }
      }
    },
    {
      title: "ResultManifestReceived",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "manifestRef"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "ResultManifestReceived" },
        manifestRef: { type: "string", minLength: 1 }
      }
    },
    {
      title: "ArtifactValidationFailed",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "failureCode"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "ArtifactValidationFailed" },
        failureCode: { enum: [...RUN_FAILURE_CODES] }
      }
    },
    {
      title: "Completed",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "Completed" },
        modelId: { type: "string", minLength: 1 }
      }
    },
    {
      title: "Failed",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE, "failureCode"],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "Failed" },
        failureCode: { enum: [...RUN_FAILURE_CODES] },
        failureMessage: { type: "string", minLength: 1 }
      }
    },
    {
      title: "CancellationRequested",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "CancellationRequested" },
        reason: { type: "string", minLength: 1 }
      }
    },
    {
      title: "CancellationConfirmed",
      type: "object",
      additionalProperties: false,
      required: [...PRODUCT_EVENT_REQUIRED_ENVELOPE],
      properties: {
        ...PRODUCT_EVENT_ENVELOPE_PROPERTIES,
        type: { const: "CancellationConfirmed" }
      }
    }
  ],
  definitions: {
    runtimeMetadata: RUNTIME_METADATA_JSON_SCHEMA
  }
} as const;

/**
 * Strictly validates ONE product event payload (the `type` discriminator plus
 * its type-specific fields). Unknown fields, unknown enums and out-of-range
 * values are rejected; the payload never falls back to a loose envelope check.
 */
export function validateProductEventPayload(value: unknown): RunEventPayload {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "product event payload must be an object");
  }
  const type = value.type;
  if (typeof type !== "string" || !RUN_EVENT_TYPE_SET.has(type)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `type is not a known product event type: ${JSON.stringify(type)}`
    );
  }
  switch (type as RunEventType) {
    case "StageChanged": {
      assertNoUnknownKeys(value, ["type", "stage", "activity"], "StageChanged event");
      const stage = value.stage;
      if (typeof stage !== "string" || !RUN_STAGE_SET.has(stage)) {
        throw new Phase4ContractError(
          "INVALID_CONTRACT",
          "StageChanged stage must be a known run stage"
        );
      }
      assertOptionalNonEmptyString(value, "activity", "StageChanged event");
      return {
        type,
        stage: stage as RunStage,
        ...(value.activity === undefined ? {} : { activity: value.activity })
      } as RunEventPayload;
    }
    case "ActivityUpdated": {
      assertNoUnknownKeys(value, ["type", "activity"], "ActivityUpdated event");
      const activity = assertNonEmptyString(value, "activity", "ActivityUpdated event");
      return { type, activity } as RunEventPayload;
    }
    case "ProgressUpdated": {
      assertNoUnknownKeys(value, ["type", "progressPercent", "activity"], "ProgressUpdated event");
      const progressPercent = value.progressPercent;
      if (
        typeof progressPercent !== "number" ||
        !Number.isFinite(progressPercent) ||
        progressPercent < 0 ||
        progressPercent > 100
      ) {
        throw new Phase4ContractError(
          "INVALID_CONTRACT",
          "ProgressUpdated progressPercent must be a number between 0 and 100"
        );
      }
      assertOptionalNonEmptyString(value, "activity", "ProgressUpdated event");
      return {
        type,
        progressPercent,
        ...(value.activity === undefined ? {} : { activity: value.activity })
      } as RunEventPayload;
    }
    case "ClarificationRequired": {
      assertNoUnknownKeys(
        value,
        ["type", "clarificationRequestId"],
        "ClarificationRequired event"
      );
      const clarificationRequestId = assertNonEmptyString(
        value,
        "clarificationRequestId",
        "ClarificationRequired event"
      );
      return { type, clarificationRequestId } as RunEventPayload;
    }
    case "AgentTurnCompleted": {
      assertNoUnknownKeys(value, ["type", "turnId"], "AgentTurnCompleted event");
      const turnId = assertNonEmptyString(value, "turnId", "AgentTurnCompleted event");
      return { type, turnId } as RunEventPayload;
    }
    case "RuntimeMetadataUpdated": {
      assertNoUnknownKeys(value, ["type", "metadata"], "RuntimeMetadataUpdated event");
      if (value.metadata === undefined) {
        throw new Phase4ContractError(
          "INVALID_CONTRACT",
          "RuntimeMetadataUpdated metadata is required"
        );
      }
      // Return the validated, normalized metadata document instead of the raw
      // input so callers never observe an unvalidated field.
      return { type, metadata: validateRuntimeMetadata(value.metadata) } as RunEventPayload;
    }
    case "ResultManifestReceived": {
      assertNoUnknownKeys(value, ["type", "manifestRef"], "ResultManifestReceived event");
      const manifestRef = assertNonEmptyString(value, "manifestRef", "ResultManifestReceived event");
      return { type, manifestRef } as RunEventPayload;
    }
    case "ArtifactValidationFailed": {
      assertNoUnknownKeys(value, ["type", "failureCode"], "ArtifactValidationFailed event");
      const failureCode = value.failureCode;
      if (typeof failureCode !== "string" || !RUN_FAILURE_CODE_SET.has(failureCode)) {
        throw new Phase4ContractError(
          "INVALID_CONTRACT",
          "ArtifactValidationFailed failureCode must be a known run failure code"
        );
      }
      return { type, failureCode: failureCode as RunFailureCode } as RunEventPayload;
    }
    case "Completed": {
      assertNoUnknownKeys(value, ["type", "modelId"], "Completed event");
      assertOptionalNonEmptyString(value, "modelId", "Completed event");
      return {
        type,
        ...(value.modelId === undefined ? {} : { modelId: value.modelId })
      } as RunEventPayload;
    }
    case "Failed": {
      assertNoUnknownKeys(value, ["type", "failureCode", "failureMessage"], "Failed event");
      const failureCode = value.failureCode;
      if (typeof failureCode !== "string" || !RUN_FAILURE_CODE_SET.has(failureCode)) {
        throw new Phase4ContractError(
          "INVALID_CONTRACT",
          "Failed failureCode must be a known run failure code"
        );
      }
      assertOptionalNonEmptyString(value, "failureMessage", "Failed event");
      return {
        type,
        failureCode: failureCode as RunFailureCode,
        ...(value.failureMessage === undefined ? {} : { failureMessage: value.failureMessage })
      } as RunEventPayload;
    }
    case "CancellationRequested": {
      assertNoUnknownKeys(value, ["type", "reason"], "CancellationRequested event");
      assertOptionalNonEmptyString(value, "reason", "CancellationRequested event");
      return {
        type,
        ...(value.reason === undefined ? {} : { reason: value.reason })
      } as RunEventPayload;
    }
    case "CancellationConfirmed": {
      assertNoUnknownKeys(value, ["type"], "CancellationConfirmed event");
      return { type } as RunEventPayload;
    }
  }
}

/**
 * Strictly validates a complete product event: the mandatory envelope fields
 * (contract version, run id, attempt id, sequence, timestamp, optional runtime
 * thread id) plus the strictly validated payload of the event's type. Throws
 * {@link Phase4ContractError} on the first violation.
 */
export function validateProductEvent(value: unknown): RunEvent {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "product event must be an object");
  }
  if (value.contractVersion !== PRODUCT_EVENTS_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected contractVersion ${PRODUCT_EVENTS_CONTRACT_VERSION}, got ${JSON.stringify(value.contractVersion)}`
    );
  }
  const runId = assertNonEmptyString(value, "runId", "product event");
  const attemptId = assertNonEmptyString(value, "attemptId", "product event");
  if (!isNonNegativeSafeInteger(value.sequence)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "product event sequence must be a non-negative integer"
    );
  }
  if (!isNonEmptyString(value.occurredAt) || Number.isNaN(Date.parse(value.occurredAt))) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "product event occurredAt must be a valid ISO timestamp"
    );
  }
  assertOptionalNonEmptyString(value, "runtimeThreadId", "product event");
  // The payload validator rejects unknown fields, so the envelope fields must
  // be filtered out first; they are validated by the checks above.
  const payloadValue: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!PRODUCT_EVENT_ENVELOPE_KEYS.has(key)) {
      payloadValue[key] = value[key];
    }
  }
  const payload = validateProductEventPayload(payloadValue);
  return {
    contractVersion: PRODUCT_EVENTS_CONTRACT_VERSION,
    runId,
    attemptId,
    sequence: value.sequence,
    occurredAt: value.occurredAt,
    ...(value.runtimeThreadId === undefined ? {} : { runtimeThreadId: value.runtimeThreadId }),
    ...payload
  } as RunEvent;
}
