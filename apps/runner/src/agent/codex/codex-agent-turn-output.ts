/**
 * Provider-facing wire projection of the Agent Turn Output contract for the
 * Codex App Server `turn/start.outputSchema` seam (Phase 5, P5-3).
 *
 * The CANONICAL registered contract `AGENT_TURN_OUTPUT_JSON_SCHEMA`
 * (`@swpanel/contracts`) intentionally documents the terminal either/or with a
 * root `oneOf` and MUST stay unchanged as the registered contract. Native Codex
 * 0.147.0 rejects that document as `outputSchema`: its Structured Outputs mode
 * requires a root object schema with `additionalProperties: false`, object
 * properties whose `required` lists EVERY property, and NO
 * `oneOf`/`anyOf`/`allOf`/`not` anywhere in the document.
 *
 * This module therefore exports:
 *
 * - {@link CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA}: the provider-facing schema sent
 *   in `turn/start.outputSchema`. Root object, closed at every object level and
 *   every object property listed in `required` (OpenAI Structured Outputs
 *   convention). Optional semantics are encoded with REQUIRED nullable
 *   sentinels (`type: ["object","null"]` / `["array","null"]` /
 *   `["string","null"]`): `completed` is object-or-null, `questions` is
 *   array-or-null, `processMp4` is a required object-or-null sentinel of the
 *   semantically optional recording artifact and `productionVerified` is a
 *   required boolean (false is the expected claim for this product's HIL). The
 *   document is fully FLATTENED (no `$ref`, no `definitions`) and carries no
 *   `$schema`/`$id` — only a title/description — for maximum provider
 *   compatibility. Semantic strictness (choice questions require options, the
 *   Result Manifest v1 shape) is intentionally NOT weakened: it stays enforced
 *   by the canonical validator after projection.
 *
 * - {@link validateCodexAgentTurnOutputWire}: the strict wire validator /
 *   projector. It rejects unknown fields and missing provider-required fields
 *   at EVERY object level, rejects wrong nullable/non-null types, rejects
 *   both/neither/contradictory terminal payloads (fail closed), normalizes the
 *   nullable sentinels (null means absent) and then delegates to the canonical
 *   `validateAgentTurnOutput` as the AUTHORITATIVE contract gate. The returned
 *   value is the canonical `AgentTurnOutput` the consumers already understand.
 */
import {
  AGENT_TURN_OUTPUT_CONTRACT_VERSION,
  AGENT_TURN_OUTPUT_RESULTS,
  Phase4ContractError,
  REQUIRED_RESULT_MANIFEST_ARTIFACTS,
  RESULT_MANIFEST_CONTRACT_VERSION,
  RESULT_MANIFEST_RESULTS,
  validateAgentTurnOutput,
  type AgentTurnOutput
} from "@swpanel/contracts";
import { CLARIFICATION_QUESTION_TYPES } from "@swpanel/domain";

/**
 * Closed artifact reference shape, INLINED into every artifact property of the
 * flattened wire schema (never `$ref`-ed / `definitions`-ed: provider
 * compatibility).
 */
const CODEX_ARTIFACT_REF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fileName", "relativePath", "sizeBytes", "sha256"],
  properties: {
    fileName: { type: "string" },
    relativePath: { type: "string" },
    sizeBytes: { type: "integer" },
    sha256: { type: "string" }
  }
} as const;

/**
 * The provider-facing Agent Turn Output JSON Schema sent as
 * `turn/start.outputSchema`. Constraints of the Structured Outputs mode it is
 * built for: root `type: "object"`, `additionalProperties: false` at every
 * object level, EVERY object property listed in `required`, nullable
 * semantics via REQUIRED `type: ["...", "null"]` sentinels, and NO
 * `oneOf`/`anyOf`/`allOf`/`not`/`$ref`/`definitions`/`$schema`/`$id`
 * anywhere. The canonical `validateAgentTurnOutput` remains the authoritative
 * semantic gate after projection — this document only constrains the provider
 * wire shape.
 */
export const CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA = {
  title: "SWPanel Agent Turn Output (Codex provider wire schema)",
  description:
    "Provider-facing projection of the canonical SWPanel Agent Turn Output " +
    "contract, shaped for the Codex App Server Structured Outputs mode: a root " +
    "object closed at every object level, every property listed in required, " +
    "and required nullable sentinels for optional semantics (null means absent). " +
    "The canonical @swpanel/contracts validator remains the authoritative " +
    "semantic gate after projection.",
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "result", "completed", "questions"],
  properties: {
    contractVersion: { enum: [AGENT_TURN_OUTPUT_CONTRACT_VERSION] },
    result: { enum: [...AGENT_TURN_OUTPUT_RESULTS] },
    completed: {
      title: "completed turn: embedded Result Manifest v1 (object-or-null sentinel)",
      type: ["object", "null"],
      additionalProperties: false,
      required: [
        "contractVersion",
        "result",
        "solidWorksVersion",
        "units",
        "projectionDecision",
        "featureCount",
        "bodyCount",
        "rebuildStatus",
        "unresolvedAssumptions",
        "productionVerified",
        "artifacts"
      ],
      properties: {
        contractVersion: { enum: [RESULT_MANIFEST_CONTRACT_VERSION] },
        result: { enum: [...RESULT_MANIFEST_RESULTS] },
        solidWorksVersion: { type: "string" },
        units: { type: "string" },
        projectionDecision: { type: "string" },
        featureCount: { type: "integer" },
        bodyCount: { type: "integer" },
        rebuildStatus: { enum: ["PASSED", "FAILED"] },
        unresolvedAssumptions: { type: "array", items: { type: "string" } },
        // Required boolean: no claim on the wire is a lie — false is the
        // expected production-verification claim of this product's HIL.
        productionVerified: { type: "boolean" },
        artifacts: {
          type: "object",
          additionalProperties: false,
          required: [...REQUIRED_RESULT_MANIFEST_ARTIFACTS, "processMp4"],
          properties: {
            sldprt: { ...CODEX_ARTIFACT_REF_SCHEMA },
            preview: { ...CODEX_ARTIFACT_REF_SCHEMA },
            dimensionLedger: { ...CODEX_ARTIFACT_REF_SCHEMA },
            featurePlan: { ...CODEX_ARTIFACT_REF_SCHEMA },
            buildValidationLog: { ...CODEX_ARTIFACT_REF_SCHEMA },
            builderSource: { ...CODEX_ARTIFACT_REF_SCHEMA },
            // Required nullable sentinel of the semantically optional recording
            // artifact: null means the artifact is absent (canonical contract
            // omits it).
            processMp4: { ...CODEX_ARTIFACT_REF_SCHEMA, type: ["object", "null"] }
          }
        }
      }
    },
    questions: {
      title: "clarification required: structured question set (array-or-null sentinel)",
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "question", "hint", "unit", "options"],
        properties: {
          id: { type: "string" },
          type: { enum: [...CLARIFICATION_QUESTION_TYPES] },
          question: { type: "string" },
          hint: { type: ["string", "null"] },
          unit: { type: ["string", "null"] },
          options: {
            type: ["array", "null"],
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label"],
              properties: {
                id: { type: "string" },
                label: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
} as const;

const CODEX_AGENT_TURN_OUTPUT_WIRE_KEYS = [
  "contractVersion",
  "result",
  "completed",
  "questions"
] as const;

const CODEX_WIRE_MANIFEST_KEYS = [
  "contractVersion",
  "result",
  "solidWorksVersion",
  "units",
  "projectionDecision",
  "featureCount",
  "bodyCount",
  "rebuildStatus",
  "unresolvedAssumptions",
  "productionVerified",
  "artifacts"
] as const;

const CODEX_WIRE_ARTIFACT_KEYS = [...REQUIRED_RESULT_MANIFEST_ARTIFACTS, "processMp4"] as const;

const CODEX_WIRE_ARTIFACT_REF_KEYS = ["fileName", "relativePath", "sizeBytes", "sha256"] as const;

const CODEX_WIRE_QUESTION_KEYS = ["id", "type", "question", "hint", "unit", "options"] as const;

const CODEX_WIRE_QUESTION_OPTION_KEYS = ["id", "label"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertWireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", `${label} must be a JSON object`);
  }
  return value;
}

/** Rejects any key outside `allowed`: unknown wire fields are never trusted. */
function assertNoWireUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Phase4ContractError(
      "UNKNOWN_FIELD",
      `${label} contains unknown field(s): ${unknown.join(", ")}`
    );
  }
}

/** Requires a provider-required wire field to be PRESENT (Structured Outputs: no absent fields). */
function requireWireField(record: Record<string, unknown>, key: string, label: string): unknown {
  if (!(key in record)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `${label} is missing the required field ${key}`
    );
  }
  return record[key];
}

function assertWireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Phase4ContractError("INVALID_CONTRACT", `${label} must be a string`);
  }
  return value;
}

function assertWireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Phase4ContractError("INVALID_CONTRACT", `${label} must be a number`);
  }
  return value;
}

function assertWireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Phase4ContractError("INVALID_CONTRACT", `${label} must be a boolean`);
  }
  return value;
}

/** Strictly projects one wire artifact reference (all fields required, closed). */
function projectWireArtifactRef(value: unknown, label: string): Record<string, unknown> {
  const record = assertWireRecord(value, label);
  assertNoWireUnknownKeys(record, CODEX_WIRE_ARTIFACT_REF_KEYS, label);
  const fileName = assertWireString(requireWireField(record, "fileName", label), `${label}.fileName`);
  const relativePath = assertWireString(
    requireWireField(record, "relativePath", label),
    `${label}.relativePath`
  );
  const sizeBytes = assertWireNumber(requireWireField(record, "sizeBytes", label), `${label}.sizeBytes`);
  const sha256 = assertWireString(requireWireField(record, "sha256", label), `${label}.sha256`);
  return { fileName, relativePath, sizeBytes, sha256 };
}

/**
 * Strictly projects the wire Result Manifest v1 mirror (required nullable
 * `processMp4` sentinel, required boolean `productionVerified`) into the
 * canonical manifest shape: `processMp4: null` is normalized by omission, the
 * canonical Result Manifest validator re-checks every semantic afterwards.
 */
function projectWireManifest(value: unknown): Record<string, unknown> {
  const label = "completed";
  const record = assertWireRecord(value, label);
  assertNoWireUnknownKeys(record, CODEX_WIRE_MANIFEST_KEYS, label);
  if (requireWireField(record, "contractVersion", label) !== RESULT_MANIFEST_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected completed manifest contractVersion ${RESULT_MANIFEST_CONTRACT_VERSION}`
    );
  }
  if (requireWireField(record, "result", label) !== "completed") {
    throw new Phase4ContractError("INVALID_CONTRACT", "completed manifest result must be 'completed'");
  }
  const solidWorksVersion = assertWireString(
    requireWireField(record, "solidWorksVersion", label),
    `${label}.solidWorksVersion`
  );
  const units = assertWireString(requireWireField(record, "units", label), `${label}.units`);
  const projectionDecision = assertWireString(
    requireWireField(record, "projectionDecision", label),
    `${label}.projectionDecision`
  );
  const featureCount = assertWireNumber(requireWireField(record, "featureCount", label), `${label}.featureCount`);
  const bodyCount = assertWireNumber(requireWireField(record, "bodyCount", label), `${label}.bodyCount`);
  const rebuildStatus = assertWireString(
    requireWireField(record, "rebuildStatus", label),
    `${label}.rebuildStatus`
  );
  const unresolvedAssumptions = requireWireField(record, "unresolvedAssumptions", label);
  if (!Array.isArray(unresolvedAssumptions)) {
    throw new Phase4ContractError("INVALID_CONTRACT", `${label}.unresolvedAssumptions must be an array`);
  }
  const normalizedAssumptions: string[] = [];
  unresolvedAssumptions.forEach((assumption, index) => {
    normalizedAssumptions.push(
      assertWireString(assumption, `${label}.unresolvedAssumptions[${index}]`)
    );
  });
  const productionVerified = assertWireBoolean(
    requireWireField(record, "productionVerified", label),
    `${label}.productionVerified`
  );
  const artifactsLabel = `${label}.artifacts`;
  const artifactsRecord = assertWireRecord(requireWireField(record, "artifacts", label), artifactsLabel);
  assertNoWireUnknownKeys(artifactsRecord, CODEX_WIRE_ARTIFACT_KEYS, artifactsLabel);
  const normalizedArtifacts: Record<string, unknown> = {};
  for (const key of REQUIRED_RESULT_MANIFEST_ARTIFACTS) {
    normalizedArtifacts[key] = projectWireArtifactRef(
      requireWireField(artifactsRecord, key, artifactsLabel),
      `${artifactsLabel}.${key}`
    );
  }
  const processMp4 = requireWireField(artifactsRecord, "processMp4", artifactsLabel);
  if (processMp4 !== null) {
    // Required nullable sentinel: null means the recording artifact is absent —
    // normalized by omission for the canonical manifest.
    normalizedArtifacts.processMp4 = projectWireArtifactRef(processMp4, `${artifactsLabel}.processMp4`);
  }
  return {
    contractVersion: RESULT_MANIFEST_CONTRACT_VERSION,
    result: "completed",
    solidWorksVersion,
    units,
    projectionDecision,
    featureCount,
    bodyCount,
    rebuildStatus,
    unresolvedAssumptions: normalizedAssumptions,
    productionVerified,
    artifacts: normalizedArtifacts
  };
}

/** Strictly projects one wire question option (all fields required, closed). */
function projectWireQuestionOption(value: unknown, label: string): Record<string, unknown> {
  const record = assertWireRecord(value, label);
  assertNoWireUnknownKeys(record, CODEX_WIRE_QUESTION_OPTION_KEYS, label);
  const id = assertWireString(requireWireField(record, "id", label), `${label}.id`);
  const optionLabel = assertWireString(requireWireField(record, "label", label), `${label}.label`);
  return { id, label: optionLabel };
}

/**
 * Strictly projects one wire question: all six fields are provider-required,
 * `hint`/`unit` are string-or-null and `options` is array-or-null — null is
 * normalized by omission. Choice-requires-options and the question type enum
 * stay enforced by the canonical validator (never weakened here).
 */
function projectWireQuestion(value: unknown, index: number): Record<string, unknown> {
  const label = `questions[${index}]`;
  const record = assertWireRecord(value, label);
  assertNoWireUnknownKeys(record, CODEX_WIRE_QUESTION_KEYS, label);
  const id = assertWireString(requireWireField(record, "id", label), `${label}.id`);
  const type = assertWireString(requireWireField(record, "type", label), `${label}.type`);
  const question = assertWireString(requireWireField(record, "question", label), `${label}.question`);
  const normalized: Record<string, unknown> = { id, type, question };
  const hint = requireWireField(record, "hint", label);
  if (hint !== null) {
    normalized.hint = assertWireString(hint, `${label}.hint`);
  }
  const unit = requireWireField(record, "unit", label);
  if (unit !== null) {
    normalized.unit = assertWireString(unit, `${label}.unit`);
  }
  const options = requireWireField(record, "options", label);
  if (options !== null) {
    if (!Array.isArray(options)) {
      throw new Phase4ContractError("INVALID_CONTRACT", `${label}.options must be an array or null`);
    }
    normalized.options = options.map((option, optionIndex) =>
      projectWireQuestionOption(option, `${label}.options[${optionIndex}]`)
    );
  }
  return normalized;
}

/**
 * Strictly validates and projects a provider-wire Agent Turn Output document
 * into the canonical `AgentTurnOutput`. Fails closed (throws
 * {@link Phase4ContractError}) on unknown fields, missing provider-required
 * fields, wrong nullable/non-null types, both/neither/contradictory terminal
 * payloads, malformed manifests and illegal questions; the projected document
 * then passes the canonical `validateAgentTurnOutput` — the AUTHORITATIVE
 * contract gate — unchanged.
 */
export function validateCodexAgentTurnOutputWire(value: unknown): AgentTurnOutput {
  const record = assertWireRecord(value, "Agent Turn Output");
  assertNoWireUnknownKeys(record, CODEX_AGENT_TURN_OUTPUT_WIRE_KEYS, "Agent Turn Output");
  if (requireWireField(record, "contractVersion", "Agent Turn Output") !== AGENT_TURN_OUTPUT_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected contractVersion ${AGENT_TURN_OUTPUT_CONTRACT_VERSION}`
    );
  }
  const result = requireWireField(record, "result", "Agent Turn Output");
  if (result !== "completed" && result !== "clarification_required") {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "Agent Turn Output result must be one of completed, clarification_required"
    );
  }
  const completed = requireWireField(record, "completed", "Agent Turn Output");
  const questions = requireWireField(record, "questions", "Agent Turn Output");
  if (result === "completed") {
    // Mutually exclusive: a completed turn carries the manifest and NO
    // questions — a non-null question sentinel is a contradictory payload.
    if (questions !== null) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "a completed Agent Turn Output must carry questions === null (the terminal states are mutually exclusive)"
      );
    }
    if (!isRecord(completed)) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "a completed Agent Turn Output must embed the Result Manifest document (completed must be an object, never null)"
      );
    }
    const normalizedManifest = projectWireManifest(completed);
    // The canonical contract validator is the AUTHORITATIVE gate: the projected
    // document must pass the shared strict validator unchanged.
    return validateAgentTurnOutput({
      contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
      result: "completed",
      completed: normalizedManifest
    });
  }
  // clarification_required: mutually exclusive with the manifest claim — a
  // non-null completed sentinel is a contradictory payload.
  if (completed !== null) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "a clarification Agent Turn Output must carry completed === null (the terminal states are mutually exclusive)"
    );
  }
  if (!Array.isArray(questions)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "a clarification Agent Turn Output must carry a non-null question array"
    );
  }
  const normalizedQuestions = questions.map((question, index) => projectWireQuestion(question, index));
  return validateAgentTurnOutput({
    contractVersion: AGENT_TURN_OUTPUT_CONTRACT_VERSION,
    result: "clarification_required",
    questions: normalizedQuestions
  });
}
