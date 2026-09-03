import {
  ERROR_SCHEMA_ID,
  PHASE4_SCHEMA_DRAFT
} from "./schema-ids.js";
import {
  Phase4ContractError,
  assertNoUnknownKeys,
  assertNonEmptyString,
  isRecord
} from "./shared.js";

/**
 * Versioned structured Error contract shared by every Phase 4 exchange that can
 * fail outside the IPC envelope (e.g. invocation generation, manifest
 * validation, adapter failures surfaced as structured errors). Codes are stable
 * machine-readable identifiers mapped by the UI without parsing prose; the code
 * space is intentionally open-ended so every module keeps its own canonical
 * code list.
 */
export const ERROR_CONTRACT_VERSION = 1 as const;

export interface ErrorContract {
  contractVersion: typeof ERROR_CONTRACT_VERSION;
  /** Stable machine-readable code, e.g. "ARTIFACT_MANIFEST_INVALID". */
  code: string;
  message: string;
  /** True when the caller may retry the same operation unchanged. */
  retryable?: boolean;
  /** Machine-readable diagnostic context; never user-visible prose. */
  details?: Readonly<Record<string, unknown>>;
}

/** JSON Schema document registering/documenting the Error contract. */
export const ERROR_JSON_SCHEMA = {
  $schema: PHASE4_SCHEMA_DRAFT,
  $id: ERROR_SCHEMA_ID,
  title: "SWPanel Structured Error",
  description:
    "Structured error document: stable machine-readable code plus message, " +
    "an optional retry hint and optional machine-readable details.",
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "code", "message"],
  properties: {
    contractVersion: { const: ERROR_CONTRACT_VERSION },
    code: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
    retryable: { type: "boolean" },
    details: { type: "object" }
  }
} as const;

/**
 * Strictly validates a serialized structured Error document. Throws
 * {@link Phase4ContractError} on the first violation: version mismatch, unknown
 * fields, empty code/message or a non-boolean retryable flag.
 */
export function validateErrorContract(value: unknown): ErrorContract {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "Error document must be a JSON object");
  }
  assertNoUnknownKeys(
    value,
    ["contractVersion", "code", "message", "retryable", "details"],
    "Error document"
  );
  if (value.contractVersion !== ERROR_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected contractVersion ${ERROR_CONTRACT_VERSION}, got ${JSON.stringify(value.contractVersion)}`
    );
  }
  const code = assertNonEmptyString(value, "code", "Error document");
  const message = assertNonEmptyString(value, "message", "Error document");
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    throw new Phase4ContractError("INVALID_CONTRACT", "retryable must be a boolean when present");
  }
  if (value.details !== undefined && !isRecord(value.details)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "details must be an object when present");
  }
  return {
    contractVersion: ERROR_CONTRACT_VERSION,
    code,
    message,
    ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
    ...(value.details === undefined ? {} : { details: value.details })
  };
}
