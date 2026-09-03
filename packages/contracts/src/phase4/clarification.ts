import type {
  ClarificationAnswer,
  ClarificationQuestion,
  ClarificationQuestionOption,
  ClarificationQuestionType,
  ClarificationRequest
} from "@swpanel/domain";
import {
  CLARIFICATION_QUESTION_TYPES,
  CLARIFICATION_STATUSES
} from "@swpanel/domain";
import {
  CLARIFICATION_SCHEMA_ID,
  PHASE4_SCHEMA_DRAFT
} from "./schema-ids.js";
import {
  Phase4ContractError,
  assertIsoTimestamp,
  assertNoUnknownKeys,
  assertNonEmptyString,
  assertOptionalNonEmptyString,
  isRecord
} from "./shared.js";

/**
 * Versioned structured Clarification contract: Clarification is a structured
 * question set, never natural language for the UI to parse (development-plan.md
 * §8.4). Requests reuse the canonical `@swpanel/domain` Clarification types;
 * the validator strictly checks question/answer shapes, question types and
 * option membership so the UI can render answers without interpreting prose.
 */
export const CLARIFICATION_CONTRACT_VERSION = 1 as const;

const CLARIFICATION_STATUS_SET: ReadonlySet<string> = new Set(CLARIFICATION_STATUSES);
const CLARIFICATION_QUESTION_TYPE_SET: ReadonlySet<string> = new Set(
  CLARIFICATION_QUESTION_TYPES
);

/** JSON Schema document registering/documenting the Clarification contract. */
export const CLARIFICATION_JSON_SCHEMA = {
  $schema: PHASE4_SCHEMA_DRAFT,
  $id: CLARIFICATION_SCHEMA_ID,
  title: "SWPanel Clarification Contract",
  description:
    "Structured Clarification request/answer exchange between a Modeling Run " +
    "and the user. Questions are typed (dimension/text/choice) with selectable " +
    "options; choice questions must carry options and answer values are " +
    "discriminated by kind, matching the strict validator.",
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "id", "runId", "revisionId", "status", "questions", "answers", "createdAt"],
  properties: {
    contractVersion: { const: CLARIFICATION_CONTRACT_VERSION },
    id: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    revisionId: { type: "string", minLength: 1 },
    status: { enum: [...CLARIFICATION_STATUSES] },
    questions: {
      type: "array",
      minItems: 1,
      items: {
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
      }
    },
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "questionId", "value", "answeredAt", "answeredBy"],
        properties: {
          id: { type: "string", minLength: 1 },
          questionId: { type: "string", minLength: 1 },
          value: {
            type: "object",
            oneOf: [
              {
                title: "dimension answer",
                type: "object",
                additionalProperties: false,
                required: ["kind", "value", "unit"],
                properties: {
                  kind: { const: "dimension" },
                  value: { type: "number" },
                  unit: { type: "string", minLength: 1 }
                }
              },
              {
                title: "text answer",
                type: "object",
                additionalProperties: false,
                required: ["kind", "value"],
                properties: {
                  kind: { const: "text" },
                  value: { type: "string", minLength: 1 }
                }
              },
              {
                title: "choice answer",
                type: "object",
                additionalProperties: false,
                required: ["kind", "optionId"],
                properties: {
                  kind: { const: "choice" },
                  optionId: { type: "string", minLength: 1 }
                }
              }
            ]
          },
          answeredAt: { type: "string", format: "date-time" },
          answeredBy: { type: "string", minLength: 1 }
        }
      }
    },
    createdAt: { type: "string", format: "date-time" },
    answeredAt: { type: "string", format: "date-time" }
  },
  definitions: {
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

function assertQuestionOption(option: unknown): ClarificationQuestionOption {
  if (!isRecord(option)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "each question option must be an object");
  }
  assertNoUnknownKeys(option, ["id", "label"], "question option");
  const id = assertNonEmptyString(option, "id", "question option");
  const label = assertNonEmptyString(option, "label", "question option");
  return { id, label };
}

/**
 * Strictly validates one structured Clarification question. `choice` questions
 * must carry a non-empty option set; unknown fields are rejected.
 */
export function validateClarificationQuestion(value: unknown): ClarificationQuestion {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "clarification question must be an object");
  }
  assertNoUnknownKeys(
    value,
    ["id", "type", "question", "hint", "unit", "options"],
    "clarification question"
  );
  const id = assertNonEmptyString(value, "id", "clarification question");
  if (typeof value.type !== "string" || !CLARIFICATION_QUESTION_TYPE_SET.has(value.type)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "question type must be one of dimension, text, choice"
    );
  }
  const question = assertNonEmptyString(value, "question", "clarification question");
  const hint = assertOptionalNonEmptyString(value, "hint", "clarification question");
  const unit = assertOptionalNonEmptyString(value, "unit", "clarification question");
  let options: readonly ClarificationQuestionOption[] | undefined;
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length === 0) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "choice question options must be a non-empty array"
      );
    }
    options = value.options.map(assertQuestionOption);
  }
  if (value.type === "choice" && options === undefined) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "choice questions must carry selectable options"
    );
  }
  return {
    id,
    type: value.type as ClarificationQuestion["type"],
    question,
    ...(hint === undefined ? {} : { hint }),
    ...(unit === undefined ? {} : { unit }),
    ...(options === undefined ? {} : { options })
  };
}

/**
 * Strictly validates one Clarification answer against its structured value
 * shape (dimension/text/choice). Unknown fields are rejected.
 */
export function validateClarificationAnswer(value: unknown): ClarificationAnswer {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "clarification answer must be an object");
  }
  assertNoUnknownKeys(
    value,
    ["id", "questionId", "value", "answeredAt", "answeredBy"],
    "clarification answer"
  );
  const id = assertNonEmptyString(value, "id", "clarification answer");
  const questionId = assertNonEmptyString(value, "questionId", "clarification answer");
  const answeredAt = assertIsoTimestamp(value, "answeredAt", "clarification answer");
  const answeredBy = assertNonEmptyString(value, "answeredBy", "clarification answer");

  const answerValue = value.value;
  if (!isRecord(answerValue)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "answer value must be an object");
  }
  const kind = answerValue.kind;
  if (typeof kind !== "string" || !CLARIFICATION_QUESTION_TYPE_SET.has(kind)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "answer value.kind must be one of dimension, text, choice"
    );
  }
  const questionType = kind as ClarificationQuestionType;
  switch (questionType) {
    case "dimension": {
      assertNoUnknownKeys(answerValue, ["kind", "value", "unit"], "dimension answer value");
      if (typeof answerValue.value !== "number" || !Number.isFinite(answerValue.value)) {
        throw new Phase4ContractError(
          "INVALID_CONTRACT",
          "dimension answer value.value must be a finite number"
        );
      }
      const unit = assertNonEmptyString(answerValue, "unit", "dimension answer value");
      return { id, questionId, value: { kind: questionType, value: answerValue.value, unit }, answeredAt, answeredBy };
    }
    case "text": {
      assertNoUnknownKeys(answerValue, ["kind", "value"], "text answer value");
      const text = assertNonEmptyString(answerValue, "value", "text answer value");
      return { id, questionId, value: { kind: questionType, value: text }, answeredAt, answeredBy };
    }
    case "choice": {
      assertNoUnknownKeys(answerValue, ["kind", "optionId"], "choice answer value");
      const optionId = assertNonEmptyString(answerValue, "optionId", "choice answer value");
      return { id, questionId, value: { kind: questionType, optionId }, answeredAt, answeredBy };
    }
  }
}

/**
 * Strictly validates a serialized Clarification Request. Throws
 * {@link Phase4ContractError} on the first violation: contract version mismatch,
 * unknown fields, illegal status/question types, empty question sets or
 * malformed answers.
 */
export function validateClarificationRequest(value: unknown): ClarificationRequest {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "clarification request must be an object");
  }
  assertNoUnknownKeys(
    value,
    ["contractVersion", "id", "runId", "revisionId", "status", "questions", "answers", "createdAt", "answeredAt"],
    "clarification request"
  );
  if (value.contractVersion !== CLARIFICATION_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected contractVersion ${CLARIFICATION_CONTRACT_VERSION}, got ${JSON.stringify(value.contractVersion)}`
    );
  }
  const id = assertNonEmptyString(value, "id", "clarification request");
  const runId = assertNonEmptyString(value, "runId", "clarification request");
  const revisionId = assertNonEmptyString(value, "revisionId", "clarification request");
  if (typeof value.status !== "string" || !CLARIFICATION_STATUS_SET.has(value.status)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "status must be one of OPEN, ANSWERED"
    );
  }
  const questions = value.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "clarification request questions must be a non-empty array"
    );
  }
  const validatedQuestions = questions.map(validateClarificationQuestion);
  const answers = value.answers;
  if (!Array.isArray(answers)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "clarification request answers must be an array"
    );
  }
  const validatedAnswers = answers.map(validateClarificationAnswer);
  const createdAt = assertIsoTimestamp(value, "createdAt", "clarification request");
  const answeredAt = assertOptionalNonEmptyString(value, "answeredAt", "clarification request");
  return {
    id,
    runId,
    revisionId,
    status: value.status as ClarificationRequest["status"],
    questions: validatedQuestions,
    answers: validatedAnswers,
    createdAt,
    ...(answeredAt === undefined ? {} : { answeredAt })
  };
}
