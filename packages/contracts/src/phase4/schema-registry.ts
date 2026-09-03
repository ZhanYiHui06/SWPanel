import { IPC_ENVELOPE_JSON_SCHEMA } from "./ipc-envelope.js";
import { INVOCATION_PACKAGE_JSON_SCHEMA } from "./invocation-package.js";
import { RUNTIME_METADATA_JSON_SCHEMA } from "./runtime-metadata.js";
import { PRODUCT_EVENTS_JSON_SCHEMA } from "./product-events.js";
import { CLARIFICATION_JSON_SCHEMA } from "./clarification.js";
import { ERROR_JSON_SCHEMA } from "./error.js";
import { INPUT_ADAPTATION_JSON_SCHEMA } from "./input-adaptation.js";
import { RESULT_MANIFEST_JSON_SCHEMA } from "./result-manifest.js";
import { AGENT_TURN_OUTPUT_JSON_SCHEMA } from "./agent-turn-output.js";
import {
  PHASE4_SCHEMA_DRAFT,
  PHASE4_SCHEMA_IDS,
  type Phase4SchemaId
} from "./schema-ids.js";
import {
  Phase4ContractError,
  assertNoUnknownKeys,
  assertNonEmptyString,
  isPositiveSafeInteger,
  isRecord
} from "./shared.js";

/**
 * Versioned registration/documentation of every Phase 4 JSON Schema document.
 * Each entry pairs the stable schema id with its versioned draft-07 document so
 * the contract surface is discoverable and machine-auditable: a peer can look
 * up the exact schema a validator enforces. The dependency-free validators
 * remain the authoritative runtime gates; the registry documents them.
 */
export const PHASE4_REGISTRY_VERSION = 1 as const;

export interface Phase4SchemaDocument {
  /** Stable machine id of the schema (also the document `$id`). */
  id: Phase4SchemaId;
  title: string;
  description: string;
  /** Document version; must match the trailing segment of the `$id`. */
  version: number;
  /** Draft-07 JSON Schema document (serializable, dependency-free). */
  schema: Readonly<Record<string, unknown>>;
}

export const PHASE4_SCHEMAS: readonly Phase4SchemaDocument[] = [
  {
    id: "swpanel://contracts/ipc-envelope/1",
    title: "SWPanel IPC Envelope",
    description:
      "Versioned envelope family of the local IPC contract: request, response, handshake and Run event push.",
    version: 1,
    schema: IPC_ENVELOPE_JSON_SCHEMA
  },
  {
    id: "swpanel://contracts/invocation-package/1",
    title: "SWPanel Invocation Package",
    description:
      "Frozen input handed to the modeling Skill for one Run attempt: skill identity, adapter-derived image, memory, workspace and execution options.",
    version: 1,
    schema: INVOCATION_PACKAGE_JSON_SCHEMA
  },
  {
    id: "swpanel://contracts/runtime-metadata/1",
    title: "SWPanel Runtime Metadata",
    description:
      "Structured snapshot of the Agent runtime context: runtime capability, session thread and resume watermark.",
    version: 1,
    schema: RUNTIME_METADATA_JSON_SCHEMA
  },
  {
    id: "swpanel://contracts/product-events/1",
    title: "SWPanel Product Events",
    description:
      "Structured product events derived from raw Agent output; one of the twelve RUN_EVENT_TYPES plus the event envelope.",
    version: 1,
    schema: PRODUCT_EVENTS_JSON_SCHEMA
  },
  {
    id: "swpanel://contracts/clarification/1",
    title: "SWPanel Clarification Contract",
    description:
      "Structured Clarification request/answer exchange; typed questions and validated answers.",
    version: 1,
    schema: CLARIFICATION_JSON_SCHEMA
  },
  {
    id: "swpanel://contracts/error/1",
    title: "SWPanel Structured Error",
    description:
      "Structured error document: stable machine-readable code, message, retry hint and machine-readable details.",
    version: 1,
    schema: ERROR_JSON_SCHEMA
  },
  {
    id: "swpanel://contracts/input-adaptation/2",
    title: "SWPanel Input Adaptation Metadata",
    description:
      "Serialized Input Adapter request and conversion provenance: source hash, page selection, structured rendering engine id/version, derived image, warnings and production-verification flag.",
    version: 2,
    schema: INPUT_ADAPTATION_JSON_SCHEMA
  },
  {
    id: "swpanel://contracts/result-manifest/1",
    title: "SWPanel Result Manifest",
    description:
      "Machine-readable success statement of a modeling turn with the complete required artifact set.",
    version: 1,
    schema: RESULT_MANIFEST_JSON_SCHEMA
  },
  {
    id: "swpanel://contracts/agent-turn-output/1",
    title: "SWPanel Agent Turn Output",
    description:
      "Machine-readable terminal document of one Agent result turn: exactly one of completed (embedded Result Manifest v1) or clarification_required (strictly validated structured question set only).",
    version: 1,
    schema: AGENT_TURN_OUTPUT_JSON_SCHEMA
  }
];

const SCHEMA_ID_SET: ReadonlySet<string> = new Set(PHASE4_SCHEMA_IDS);
const SCHEMA_BY_ID: Readonly<Record<Phase4SchemaId, Phase4SchemaDocument>> = Object.fromEntries(
  PHASE4_SCHEMAS.map((entry) => [entry.id, entry])
) as Readonly<Record<Phase4SchemaId, Phase4SchemaDocument>>;

/** Returns the registered schema document for `id`; throws when unknown. */
export function getPhase4Schema(id: Phase4SchemaId): Phase4SchemaDocument {
  const entry = SCHEMA_BY_ID[id];
  if (entry === undefined) {
    throw new Phase4ContractError("INVALID_CONTRACT", `Unknown Phase 4 schema id: ${id}`);
  }
  return entry;
}

/**
 * Checks that a JSON Schema document is a well-formed Phase 4 draft-07
 * document: the `$id` matches the registered id, the draft is the canonical
 * one, the version embedded in the `$id` matches the registration and the
 * structural keywords (type/properties/oneOf/definitions) have the expected
 * shapes.
 */
function assertSchemaDocument(
  schema: unknown,
  id: string,
  version: number
): void {
  if (!isRecord(schema)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `schema document for ${id} must be a JSON object`
    );
  }
  if (schema.$id !== id) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `schema document $id must be ${id}`
    );
  }
  if (schema.$schema !== PHASE4_SCHEMA_DRAFT) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "schema document $schema must be the canonical draft-07 uri"
    );
  }
  const segments = id.split("/");
  const embeddedVersion = segments[segments.length - 1];
  if (embeddedVersion !== String(version)) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `schema document $id version ${embeddedVersion} does not match registered version ${version}`
    );
  }
  if (schema.type !== undefined && schema.type !== "object") {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `schema document ${id} must describe JSON objects`
    );
  }
  if (schema.properties !== undefined && !isRecord(schema.properties)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `schema document ${id} properties must be an object`
    );
  }
  if (schema.oneOf !== undefined && !Array.isArray(schema.oneOf)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `schema document ${id} oneOf must be an array`
    );
  }
  if (schema.definitions !== undefined && !isRecord(schema.definitions)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `schema document ${id} definitions must be an object`
    );
  }
}

/**
 * Strictly validates a serialized schema registration entry. Throws
 * {@link Phase4ContractError} on the first violation: unknown fields, unknown
 * schema id, malformed metadata or a schema document whose `$id`/draft/version
 * does not match the registration.
 */
export function validatePhase4SchemaRegistration(value: unknown): Phase4SchemaDocument {
  if (!isRecord(value)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "schema registration must be a JSON object"
    );
  }
  assertNoUnknownKeys(
    value,
    ["id", "title", "description", "version", "schema"],
    "schema registration"
  );
  const id = value.id;
  if (typeof id !== "string" || !SCHEMA_ID_SET.has(id)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `unknown Phase 4 schema id: ${JSON.stringify(id)}`
    );
  }
  const title = assertNonEmptyString(value, "title", "schema registration");
  const description = assertNonEmptyString(value, "description", "schema registration");
  if (!isPositiveSafeInteger(value.version)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "schema registration version must be a positive integer"
    );
  }
  assertSchemaDocument(value.schema, id, value.version);
  return {
    id: id as Phase4SchemaId,
    title,
    description,
    version: value.version,
    schema: value.schema as Readonly<Record<string, unknown>>
  };
}

/** True when `id` is a registered Phase 4 schema id. */
export function isPhase4SchemaId(id: unknown): id is Phase4SchemaId {
  return typeof id === "string" && SCHEMA_ID_SET.has(id);
}
