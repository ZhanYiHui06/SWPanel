import { COMMAND_NAMES } from "../commands.js";
import {
  QUERY_NAMES,
  SUBSCRIBE_NAMES,
  IPC_PROTOCOL_VERSION
} from "../ipc.js";
import { RUN_EVENT_CONTRACT_VERSION, RUN_EVENT_TYPES } from "@swpanel/domain";
import {
  IPC_ENVELOPE_SCHEMA_ID,
  PHASE4_SCHEMA_DRAFT
} from "./schema-ids.js";

/**
 * Versioned JSON Schema document registering/documenting the IPC envelope
 * contract (architecture.md §12.1): the four envelope kinds spoken over the
 * named pipe. The document pins the protocol version, the allowlisted
 * operations per channel and the Run event envelope; payload strictness stays
 * in the dependency-free validators (`validateIpc*Envelope` and
 * `validateProductEvent`), which remain the authoritative gates.
 */
export const IPC_ENVELOPE_CONTRACT_VERSION = IPC_PROTOCOL_VERSION;

/** JSON Schema document registering/documenting the IPC envelope contract. */
export const IPC_ENVELOPE_JSON_SCHEMA = {
  $schema: PHASE4_SCHEMA_DRAFT,
  $id: IPC_ENVELOPE_SCHEMA_ID,
  title: "SWPanel IPC Envelope",
  description:
    "Versioned envelope family of the local IPC contract: request, response, " +
    "handshake and server-initiated Run event push. Operations are allowlisted " +
    "per channel; no generic command endpoint exists.",
  oneOf: [
    {
      title: "request",
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "requestId", "channel", "operation", "payload"],
      properties: {
        protocolVersion: { const: IPC_PROTOCOL_VERSION },
        requestId: { type: "string", minLength: 1 },
        idempotencyKey: { type: "string", minLength: 1 },
        channel: { enum: ["query", "command", "subscribe"] },
        operation: {
          enum: [...QUERY_NAMES, ...COMMAND_NAMES, ...SUBSCRIBE_NAMES]
        },
        payload: { type: "object" }
      }
    },
    {
      title: "response",
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "requestId", "ok"],
      properties: {
        protocolVersion: { const: IPC_PROTOCOL_VERSION },
        requestId: { type: "string", minLength: 1 },
        ok: { type: "boolean" },
        data: {},
        error: { $ref: "#/definitions/error" }
      }
    },
    {
      title: "handshake",
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "serverInstanceId"],
      properties: {
        protocolVersion: { const: IPC_PROTOCOL_VERSION },
        serverInstanceId: { type: "string", minLength: 1 }
      }
    },
    {
      title: "event",
      type: "object",
      additionalProperties: false,
      required: ["protocolVersion", "kind", "runId", "fromSequence", "events"],
      properties: {
        protocolVersion: { const: IPC_PROTOCOL_VERSION },
        kind: { const: "runEvents" },
        runId: { type: "string", minLength: 1 },
        fromSequence: { type: "integer", minimum: 0 },
        events: { type: "array", items: { $ref: "#/definitions/runEvent" } }
      }
    }
  ],
  definitions: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 }
      }
    },
    runEvent: {
      type: "object",
      additionalProperties: true,
      required: ["contractVersion", "runId", "attemptId", "sequence", "occurredAt", "type"],
      properties: {
        contractVersion: { const: RUN_EVENT_CONTRACT_VERSION },
        runId: { type: "string", minLength: 1 },
        attemptId: { type: "string", minLength: 1 },
        sequence: { type: "integer", minimum: 0 },
        occurredAt: { type: "string", format: "date-time" },
        runtimeThreadId: { type: "string", minLength: 1 },
        type: { enum: [...RUN_EVENT_TYPES] }
      }
    }
  }
} as const;
