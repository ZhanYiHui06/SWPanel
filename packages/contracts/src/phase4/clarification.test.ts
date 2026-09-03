import { describe, expect, it } from "vitest";

import type { ClarificationRequest } from "@swpanel/domain";
import {
  CLARIFICATION_CONTRACT_VERSION,
  Phase4ContractError,
  validateClarificationAnswer,
  validateClarificationQuestion,
  validateClarificationRequest
} from "../index.js";

function validRequest(): ClarificationRequest {
  return {
    id: "clar-1",
    runId: "run-1",
    revisionId: "rev-1",
    status: "OPEN",
    questions: [
      { id: "q1", type: "dimension", question: "中心孔深度是多少？", unit: "mm" },
      { id: "q2", type: "text", question: "材料是什么？", hint: "如 42CrMo" },
      {
        id: "q3",
        type: "choice",
        question: "倒角类型？",
        options: [
          { id: "opt-c1", label: "45 度倒角" },
          { id: "opt-c2", label: "圆角" }
        ]
      }
    ],
    answers: [
      {
        id: "a1",
        questionId: "q1",
        value: { kind: "dimension", value: 85, unit: "mm" },
        answeredAt: "2026-08-13T11:00:00.000Z",
        answeredBy: "user-1"
      }
    ],
    createdAt: "2026-08-13T10:00:00.000Z",
    answeredAt: "2026-08-13T11:00:00.000Z"
  };
}

/** Wire form of the Clarification Request: the domain request plus the contract version. */
function validWire(): Record<string, unknown> {
  return { contractVersion: CLARIFICATION_CONTRACT_VERSION, ...validRequest() };
}

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("clarification contract", () => {
  it("pins the contract version", () => {
    expect(CLARIFICATION_CONTRACT_VERSION).toBe(1);
  });

  it("accepts a well-formed request and round-trips over JSON", () => {
    const wire = validWire();
    expect(validateClarificationRequest(wire)).toEqual(validRequest());
    expect(JSON.parse(JSON.stringify(validateClarificationRequest(wire)))).toEqual(validRequest());
  });

  it("accepts an answered request whose answers match the question types", () => {
    const wire = {
      ...validWire(),
      status: "ANSWERED",
      answers: [
        { id: "a1", questionId: "q2", value: { kind: "text", value: "42CrMo" }, answeredAt: "2026-08-13T11:00:00.000Z", answeredBy: "user-1" },
        { id: "a2", questionId: "q3", value: { kind: "choice", optionId: "opt-c1" }, answeredAt: "2026-08-13T11:00:00.000Z", answeredBy: "user-1" }
      ]
    };
    const validated = validateClarificationRequest(wire);
    expect(validated.status).toBe("ANSWERED");
    expect(validated.answers).toHaveLength(2);
  });

  it("rejects a contract version mismatch", () => {
    expectCode(() => validateClarificationRequest({ ...validWire(), contractVersion: 2 }), "VERSION_MISMATCH");
    expectCode(() => validateClarificationRequest(validRequest()), "VERSION_MISMATCH");
  });

  it("rejects unknown fields on request, question and answer", () => {
    const wire = validWire();
    const questions = wire.questions as Array<Record<string, unknown>>;
    const answers = wire.answers as Array<Record<string, unknown>>;
    expectCode(() => validateClarificationRequest({ ...wire, priority: "high" }), "UNKNOWN_FIELD");
    expectCode(
      () => validateClarificationRequest({ ...wire, questions: [{ ...questions[0]!, source: "agent" }] }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () => validateClarificationRequest({ ...wire, answers: [{ ...answers[0]!, approved: true }] }),
      "UNKNOWN_FIELD"
    );
  });

  it("rejects an illegal status and an unknown question type", () => {
    expectCode(
      () => validateClarificationRequest({ ...validWire(), status: "CLOSED" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateClarificationQuestion({ id: "q", type: "date", question: "when?" }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects an empty question set and missing questions", () => {
    expectCode(
      () => validateClarificationRequest({ ...validWire(), questions: [] }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateClarificationRequest({ ...validWire(), questions: undefined }),
      "INVALID_CONTRACT"
    );
  });

  it("requires choice questions to carry options and rejects empty option sets", () => {
    expectCode(
      () => validateClarificationQuestion({ id: "q", type: "choice", question: "which?" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateClarificationQuestion({ id: "q", type: "choice", question: "which?", options: [] }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects malformed answers per kind", () => {
    expectCode(
      () =>
        validateClarificationAnswer({
          id: "a",
          questionId: "q",
          value: { kind: "dimension", value: "85" },
          answeredAt: "2026-08-13T11:00:00.000Z",
          answeredBy: "u"
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateClarificationAnswer({
          id: "a",
          questionId: "q",
          value: { kind: "dimension", value: 85 },
          answeredAt: "2026-08-13T11:00:00.000Z",
          answeredBy: "u"
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateClarificationAnswer({
          id: "a",
          questionId: "q",
          value: { kind: "text", value: "" },
          answeredAt: "2026-08-13T11:00:00.000Z",
          answeredBy: "u"
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateClarificationAnswer({
          id: "a",
          questionId: "q",
          value: { kind: "choice" },
          answeredAt: "2026-08-13T11:00:00.000Z",
          answeredBy: "u"
        }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects unknown fields inside answer values", () => {
    expectCode(
      () =>
        validateClarificationAnswer({
          id: "a",
          questionId: "q",
          value: { kind: "text", value: "42CrMo", confidence: 0.9 },
          answeredAt: "2026-08-13T11:00:00.000Z",
          answeredBy: "u"
        }),
      "UNKNOWN_FIELD"
    );
  });
});
