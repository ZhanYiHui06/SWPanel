import type { ClarificationQuestion } from "@swpanel/domain";
import {
  AGENT_TURN_OUTPUT_SCHEMA_ID,
  PHASE4_SCHEMA_DRAFT
} from "./schema-ids.js";
import {
  Phase4ContractError,
  assertNoUnknownKeys,
  isRecord
} from "./shared.js";
import {
  RESULT_MANIFEST_JSON_SCHEMA,
  validateResultManifest,
  type ResultManifest
} from "./result-manifest.js";
import { validateClarificationQuestion } from "./clarification.js";

/**
 * Versioned Agent Turn Output contract (Phase 5): the machine-readable terminal
 * document of ONE Agent result turn. The document is a strict either/or —
 * EXACTLY ONE of the two terminal states:
 *
 * - `completed` — the turn claims a finished modeling result: the embedded
 *   Result Manifest v1 document (reused unchanged, history-compatible) is the
 *   success statement the independent artifact validator verifies;
 * - `clarification_required` — the turn could not determine blocking
 *   engineering facts and asks the user: the document carries ONLY the
 *   strictly validated structured `ClarificationQuestion[]` set, never natural
 *   language for the UI to parse.
 *
 * The two states are mutually exclusive by construction: a completed document
 * must not carry questions and a clarification document must not carry a
 * manifest. 0/multiple/malformed documents of a turn are protocol failures —
 * the consumer (the Codex App Server adapter) extracts EXACTLY ONE valid
 * document per turn and fails `AGENT_PROTOCOL_INCOMPATIBLE` otherwise.
 */
export const AGENT_TURN_OUTPUT_CONTRACT_VERSION = 1 as const;

/** The only legal terminal states of one Agent turn. */
export const AGENT_TURN_OUTPUT_RESULTS = ["completed", "clarification_required"] as const;
export type AgentTurnOutputResult = (typeof AGENT_TURN_OUTPUT_RESULTS)[number];

/** The completed terminal state: the embedded Result Manifest v1 document. */
export interface AgentTurnOutputCompleted {
  contractVersion: typeof AGENT_TURN_OUTPUT_CONTRACT_VERSION;
  result: "completed";
  /** The versioned Result Manifest v1 document (the success statement). */
  completed: ResultManifest;
}

/** The clarification terminal state: ONLY the strictly validated question set. */
export interface AgentTurnOutputClarification {
  contractVersion: typeof AGENT_TURN_OUTPUT_CONTRACT_VERSION;
  result: "clarification_required";
  /** Strictly validated structured questions; never natural language. */
  questions: readonly ClarificationQuestion[];
}

export type AgentTurnOutput = AgentTurnOutputCompleted | AgentTurnOutputClarification;

/** JSON Schema document registering/documenting the Agent Turn Output contract. */
export const AGENT_TURN_OUTPUT_JSON_SCHEMA = {
  $schema: PHASE4_SCHEMA_DRAFT,
  $id: AGENT_TURN_OUTPUT_SCHEMA_ID,
  title: "SWPanel Agent Turn Output",
  description:
    "Machine-readable terminal document of one Agent result turn: exactly one " +
    "of completed (embedded Result Manifest v1) or clarification_required " +
    "(strictly validated structured question set only). The branches are " +
    "mutually exclusive; the shared strict validator is the authoritative gate.",
  type: "object",
  oneOf: [
    {
      title: "completed turn",
      type: "object",
      additionalProperties: false,
      required: ["contractVersion", "result", "completed"],
      properties: {
        contractVersion: { const: AGENT_TURN_OUTPUT_CONTRACT_VERSION },
        result: { const: "completed" },
        // The EXISTING Result Manifest v1 document, embedded unchanged (the
        // success statement the independent validator verifies).
        completed: { $ref: "#/definitions/resultManifest" }
      }
    },
    {
      title: "clarification required",
      type: "object",
      additionalProperties: false,
      required: ["contractVersion", "result", "questions"],
      properties: {
        contractVersion: { const: AGENT_TURN_OUTPUT_CONTRACT_VERSION },
        result: { const: "clarification_required" },
        // ONLY the structured question set — never free-form prose.
        questions: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/definitions/clarificationQuestion" }
        }
      }
    }
  ],
  definitions: {
    // The embedded Result Manifest v1 schema document, reused unchanged so the
    // two contracts can never drift apart (history-compatible).
    resultManifest: RESULT_MANIFEST_JSON_SCHEMA,
    // Mirrored at the ROOT definitions so the draft-07 fragment refs of the
    // embedded Result Manifest (`#/definitions/artifactRef`) resolve against
    // THIS document (draft-07 fragment refs are root-scoped).
    artifactRef: RESULT_MANIFEST_JSON_SCHEMA.definitions.artifactRef,
    // The same strict question shape the Clarification contract enforces:
    // choice questions must carry a non-empty option set, unknown fields are
    // rejected.
    clarificationQuestion: {
      type: "object",
      oneOf: [
        {
          title: "dimension/text question",
          type: "object",
          additionalProperties: false,
          required: ["id", "type", "question"],
          properties: {
            id: { type: "string", minLength: 1 },
            type: { enum: ["dimension", "text"] },
            question: { type: "string", minLength: 1 },
            hint: { type: "string", minLength: 1 },
            unit: { type: "string", minLength: 1 },
            options: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/definitions/questionOption" }
            }
          }
        },
        {
          title: "choice question",
          type: "object",
          additionalProperties: false,
          required: ["id", "type", "question", "options"],
          properties: {
            id: { type: "string", minLength: 1 },
            type: { const: "choice" },
            question: { type: "string", minLength: 1 },
            hint: { type: "string", minLength: 1 },
            unit: { type: "string", minLength: 1 },
            options: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/definitions/questionOption" }
            }
          }
        }
      ]
    },
    questionOption: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label"],
      properties: {
        id: { type: "string", minLength: 1 },
        label: { type: "string", minLength: 1 }
      }
    }
  }
} as const;

/**
 * Strictly validates a serialized Agent Turn Output document. Throws
 * {@link Phase4ContractError} on the first violation: contract version
 * mismatch, unknown fields, an illegal `result`, BOTH terminal states present
 * (mutually exclusive), a completed turn whose embedded document fails the
 * Result Manifest v1 validator, or a clarification turn without a non-empty
 * question set / with a question that fails the strict question validator. The
 * normalized document ALWAYS carries the strictly validated shapes, so the
 * consumer never re-parses raw wire content.
 */
export function validateAgentTurnOutput(value: unknown): AgentTurnOutput {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "Agent Turn Output must be a JSON object");
  }
  assertNoUnknownKeys(
    value,
    ["contractVersion", "result", "completed", "questions"],
    "Agent Turn Output"
  );
  if (value.contractVersion !== AGENT_TURN_OUTPUT_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected contractVersion ${AGENT_TURN_OUTPUT_CONTRACT_VERSION}, got ${JSON.stringify(value.contractVersion)}`
    );
  }
  if (value.result !== "completed" && value.result !== "clarification_required") {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "Agent Turn Output result must be one of completed, clarification_required"
    );
  }
  if (value.result === "completed") {
    // Mutually exclusive: a completed turn never carries clarification questions.
    if (value.questions !== undefined) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "a completed Agent Turn Output must not carry clarification questions (mutually exclusive)"
      );
    }
    if (value.completed === undefined) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "a completed Agent Turn Output must embed the Result Manifest document"
      );
    }
    const completed = validateResultManifest(value.completed);
    return {
      contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
      result: "completed",
      completed
    };
  }
  // clarification_required: mutually exclusive with the manifest claim.
  if (value.completed !== undefined) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "a clarification Agent Turn Output must not carry a Result Manifest (mutually exclusive)"
    );
  }
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "a clarification Agent Turn Output must carry a non-empty question set"
    );
  }
  const questions = value.questions.map(validateClarificationQuestion);
  return {
    contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
    result: "clarification_required",
    questions
  };
}
