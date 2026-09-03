import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "../errors.js";
import {
  canAnswerClarification,
  CLARIFICATION_QUESTION_TYPES,
  CLARIFICATION_STATUSES,
  markClarificationAnswered,
  type ClarificationRequest
} from "./clarification.js";

const openRequest: ClarificationRequest = {
  id: "clar-1",
  runId: "run-1",
  revisionId: "rev-3",
  status: "OPEN",
  questions: [
    { id: "C01", type: "dimension", question: "中心孔深度是多少？", hint: "85", unit: "mm" },
    { id: "C02", type: "text", question: "R5 圆角对应哪一侧？", hint: "右侧轴肩外缘" },
    {
      id: "C03",
      type: "choice",
      question: "图纸中的材料无法确认",
      options: [{ id: "opt-1", label: "42CrMo" }]
    }
  ],
  answers: [],
  createdAt: "2026-08-10T12:00:00.000Z"
};

describe("clarification request", () => {
  it("defines the canonical statuses and structured question types", () => {
    expect(CLARIFICATION_STATUSES).toEqual(["OPEN", "ANSWERED"]);
    expect(CLARIFICATION_QUESTION_TYPES).toEqual(["dimension", "text", "choice"]);
  });

  it("keeps an open request answerable", () => {
    expect(canAnswerClarification(openRequest)).toBe(true);
  });

  it("marks a request answered exactly once", () => {
    const answered = markClarificationAnswered(openRequest, "2026-08-10T13:00:00.000Z");
    expect(answered.status).toBe("ANSWERED");
    expect(answered.answeredAt).toBe("2026-08-10T13:00:00.000Z");
    expect(answered.questions).toHaveLength(3);
    expect(canAnswerClarification(answered)).toBe(false);
  });

  it("never allows a second answer on a closed request", () => {
    const answered = markClarificationAnswered(openRequest, "2026-08-10T13:00:00.000Z");
    expect(() =>
      markClarificationAnswered(answered, "2026-08-10T14:00:00.000Z")
    ).toThrow(DomainInvariantError);
  });
});
