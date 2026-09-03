import {
  PHASE4_SCHEMA_DRAFT,
  RUNTIME_METADATA_SCHEMA_ID
} from "./schema-ids.js";
import {
  Phase4ContractError,
  assertIsoTimestamp,
  assertNoUnknownKeys,
  assertNonEmptyString,
  assertOptionalNonEmptyString,
  isNonNegativeSafeInteger,
  isRecord
} from "./shared.js";

/**
 * Versioned Runtime Metadata contract: the structured snapshot of the Agent
 * runtime context carried by `RuntimeMetadataUpdated` product events and used
 * for resume. It covers the runtime capability (adapter + protocol), the
 * session identity (thread) and the resume watermark (last applied event
 * sequence of the attempt). Raw runtime events are diagnostic inputs and never
 * enter this structured contract.
 */
export const RUNTIME_METADATA_CONTRACT_VERSION = 1 as const;

export interface RuntimeMetadataRuntime {
  /** Identifier of the Agent runtime adapter, e.g. "codex-app-server". */
  adapterId: string;
  adapterVersion: string;
  /** Runtime protocol name, e.g. "codex-app-server". */
  protocol: string;
  protocolVersion: string;
  /** Model configuration id, when the runtime exposes it. */
  modelId?: string;
  /** False until image input support is verified at preflight. */
  modelSupportsImageInput: boolean;
}

export interface RuntimeMetadataSession {
  threadId: string;
  /** Previous thread the session was resumed from, when applicable. */
  resumedFromThreadId?: string;
}

export interface RuntimeMetadataResume {
  attemptId: string;
  /** Last event sequence applied by this attempt before interruption. */
  lastAppliedSequence: number;
}

export interface RuntimeMetadata {
  contractVersion: typeof RUNTIME_METADATA_CONTRACT_VERSION;
  runtime: RuntimeMetadataRuntime;
  session?: RuntimeMetadataSession;
  resume?: RuntimeMetadataResume;
  updatedAt: string;
}

/** JSON Schema document registering/documenting the Runtime Metadata contract. */
export const RUNTIME_METADATA_JSON_SCHEMA = {
  $schema: PHASE4_SCHEMA_DRAFT,
  $id: RUNTIME_METADATA_SCHEMA_ID,
  title: "SWPanel Runtime Metadata",
  description:
    "Structured snapshot of the Agent runtime context: runtime capability, " +
    "session thread identity and the resume watermark of the attempt.",
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "runtime", "updatedAt"],
  properties: {
    contractVersion: { const: RUNTIME_METADATA_CONTRACT_VERSION },
    runtime: {
      type: "object",
      additionalProperties: false,
      required: ["adapterId", "adapterVersion", "protocol", "protocolVersion", "modelSupportsImageInput"],
      properties: {
        adapterId: { type: "string", minLength: 1 },
        adapterVersion: { type: "string", minLength: 1 },
        protocol: { type: "string", minLength: 1 },
        protocolVersion: { type: "string", minLength: 1 },
        modelId: { type: "string", minLength: 1 },
        modelSupportsImageInput: { type: "boolean" }
      }
    },
    session: {
      type: "object",
      additionalProperties: false,
      required: ["threadId"],
      properties: {
        threadId: { type: "string", minLength: 1 },
        resumedFromThreadId: { type: "string", minLength: 1 }
      }
    },
    resume: {
      type: "object",
      additionalProperties: false,
      required: ["attemptId", "lastAppliedSequence"],
      properties: {
        attemptId: { type: "string", minLength: 1 },
        lastAppliedSequence: { type: "integer", minimum: 0 }
      }
    },
    updatedAt: { type: "string", format: "date-time" }
  }
} as const;

/**
 * Strictly validates a serialized Runtime Metadata document. Throws
 * {@link Phase4ContractError} on the first violation: version mismatch, unknown
 * fields, missing capabilities or an invalid resume watermark.
 */
export function validateRuntimeMetadata(value: unknown): RuntimeMetadata {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "Runtime Metadata must be a JSON object");
  }
  assertNoUnknownKeys(
    value,
    ["contractVersion", "runtime", "session", "resume", "updatedAt"],
    "Runtime Metadata"
  );
  if (value.contractVersion !== RUNTIME_METADATA_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected contractVersion ${RUNTIME_METADATA_CONTRACT_VERSION}, got ${JSON.stringify(value.contractVersion)}`
    );
  }

  const runtime = value.runtime;
  if (!isRecord(runtime)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "runtime must be an object");
  }
  assertNoUnknownKeys(
    runtime,
    ["adapterId", "adapterVersion", "protocol", "protocolVersion", "modelId", "modelSupportsImageInput"],
    "runtime"
  );
  const adapterId = assertNonEmptyString(runtime, "adapterId", "runtime");
  const adapterVersion = assertNonEmptyString(runtime, "adapterVersion", "runtime");
  const protocol = assertNonEmptyString(runtime, "protocol", "runtime");
  const protocolVersion = assertNonEmptyString(runtime, "protocolVersion", "runtime");
  const modelId = assertOptionalNonEmptyString(runtime, "modelId", "runtime");
  if (typeof runtime.modelSupportsImageInput !== "boolean") {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "runtime.modelSupportsImageInput must be a boolean"
    );
  }

  let session: RuntimeMetadataSession | undefined;
  if (value.session !== undefined) {
    const sessionValue = value.session;
    if (!isRecord(sessionValue)) {
      throw new Phase4ContractError("INVALID_CONTRACT", "session must be an object");
    }
    assertNoUnknownKeys(sessionValue, ["threadId", "resumedFromThreadId"], "session");
    const threadId = assertNonEmptyString(sessionValue, "threadId", "session");
    const resumedFromThreadId = assertOptionalNonEmptyString(
      sessionValue,
      "resumedFromThreadId",
      "session"
    );
    session = {
      threadId,
      ...(resumedFromThreadId === undefined ? {} : { resumedFromThreadId })
    };
  }

  let resume: RuntimeMetadataResume | undefined;
  if (value.resume !== undefined) {
    const resumeValue = value.resume;
    if (!isRecord(resumeValue)) {
      throw new Phase4ContractError("INVALID_CONTRACT", "resume must be an object");
    }
    assertNoUnknownKeys(resumeValue, ["attemptId", "lastAppliedSequence"], "resume");
    const attemptId = assertNonEmptyString(resumeValue, "attemptId", "resume");
    if (!isNonNegativeSafeInteger(resumeValue.lastAppliedSequence)) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "resume.lastAppliedSequence must be a non-negative integer"
      );
    }
    resume = { attemptId, lastAppliedSequence: resumeValue.lastAppliedSequence };
  }

  const updatedAt = assertIsoTimestamp(value, "updatedAt", "Runtime Metadata");

  return {
    contractVersion: RUNTIME_METADATA_CONTRACT_VERSION,
    runtime: {
      adapterId,
      adapterVersion,
      protocol,
      protocolVersion,
      ...(modelId === undefined ? {} : { modelId }),
      modelSupportsImageInput: runtime.modelSupportsImageInput
    },
    ...(session === undefined ? {} : { session }),
    ...(resume === undefined ? {} : { resume }),
    updatedAt
  };
}
