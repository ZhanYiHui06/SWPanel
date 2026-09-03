/**
 * Leaf module holding the canonical draft and ids of every Phase 4 JSON Schema
 * document. Kept dependency-free so each contract module can import its own
 * `*_SCHEMA_ID` without creating an import cycle with `schema-registry.ts`.
 */

/** JSON Schema draft used by every Phase 4 schema document. */
export const PHASE4_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#" as const;

/**
 * Stable, versioned `$id` URIs of the Phase 4 schema documents. The trailing
 * segment is the document version and must match the contract version it documents.
 */
export const PHASE4_SCHEMA_IDS = [
  "swpanel://contracts/ipc-envelope/1",
  "swpanel://contracts/invocation-package/1",
  "swpanel://contracts/runtime-metadata/1",
  "swpanel://contracts/product-events/1",
  "swpanel://contracts/clarification/1",
  "swpanel://contracts/error/1",
  "swpanel://contracts/input-adaptation/2",
  "swpanel://contracts/result-manifest/1",
  "swpanel://contracts/agent-turn-output/1"
] as const;
export type Phase4SchemaId = (typeof PHASE4_SCHEMA_IDS)[number];

export const IPC_ENVELOPE_SCHEMA_ID = "swpanel://contracts/ipc-envelope/1" as const satisfies Phase4SchemaId;
export const INVOCATION_PACKAGE_SCHEMA_ID =
  "swpanel://contracts/invocation-package/1" as const satisfies Phase4SchemaId;
export const RUNTIME_METADATA_SCHEMA_ID =
  "swpanel://contracts/runtime-metadata/1" as const satisfies Phase4SchemaId;
export const PRODUCT_EVENTS_SCHEMA_ID =
  "swpanel://contracts/product-events/1" as const satisfies Phase4SchemaId;
export const CLARIFICATION_SCHEMA_ID =
  "swpanel://contracts/clarification/1" as const satisfies Phase4SchemaId;
export const ERROR_SCHEMA_ID = "swpanel://contracts/error/1" as const satisfies Phase4SchemaId;
export const INPUT_ADAPTATION_SCHEMA_ID =
  "swpanel://contracts/input-adaptation/2" as const satisfies Phase4SchemaId;
export const RESULT_MANIFEST_SCHEMA_ID =
  "swpanel://contracts/result-manifest/1" as const satisfies Phase4SchemaId;
export const AGENT_TURN_OUTPUT_SCHEMA_ID =
  "swpanel://contracts/agent-turn-output/1" as const satisfies Phase4SchemaId;
