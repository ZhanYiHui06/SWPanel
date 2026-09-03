import type {
  ClarificationAnswer,
  ClarificationAnswerValue,
  ClarificationQuestion,
  ClarificationRequest,
  RevisionFact
} from "@swpanel/domain";
import { DomainInvariantError } from "@swpanel/domain";
import { TIME } from "./timeline.js";
import { RUN_IDS } from "./runs.js";
import { REVISION_IDS } from "./drawings.js";

/** Stable fixture ids for every canonical Clarification Request. */
export const CLARIFICATION_IDS = {
  mainR04: "clar-main-r04",
  dR02: "clar-d-r02"
} as const;

/**
 * Stable canonical Revision Fact field for each clarification question, keyed
 * by clarification request id then question id.
 *
 * The canonical field is the stable identity shared by the question, its answer
 * and the Revision Fact it produces. This guarantees a material answer (C03 on
 * the main request) maps to the same canonical `材料` fact as the drawing's
 * confirmed material fact, so the two can never coexist as contradictory
 * records: the repository upserts facts by `(revisionId, canonicalField)`.
 */
export const CANONICAL_FACT_FIELDS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  [CLARIFICATION_IDS.mainR04]: {
    C01: "中心孔深度",
    C02: "R5 圆角位置",
    C03: "材料"
  },
  [CLARIFICATION_IDS.dR02]: {
    C01: "键槽宽度",
    C02: "表面处理要求"
  }
};

/**
 * Input shape used both by scenario seeds and the
 * `submitClarificationAnswers` repository command so the two stay consistent.
 */
export interface ClarificationAnswerInput {
  questionId: string;
  value: ClarificationAnswerValue;
  /** Revision Fact field name; defaults to the question text. */
  field?: string;
}

/** The three documented blocking questions on the main drawing's R05. */
export function mainClarificationQuestions(): readonly ClarificationQuestion[] {
  return [
    { id: "C01", type: "dimension", question: "中心孔深度是多少？", hint: "85", unit: "mm" },
    { id: "C02", type: "text", question: "R5 圆角对应哪一侧？", hint: "右侧轴肩外缘" },
    {
      id: "C03",
      type: "choice",
      question: "图纸中的材料无法确认",
      options: [
        { id: "opt-42crmo", label: "42CrMo" },
        { id: "opt-45", label: "45#钢" }
      ]
    }
  ];
}

/** Open clarification on the secondary drawing D (矫直辊) R02. */
export function dClarificationQuestions(): readonly ClarificationQuestion[] {
  return [
    { id: "C01", type: "dimension", question: "键槽宽度无法确定？", hint: "28", unit: "mm" },
    { id: "C02", type: "text", question: "图纸中的表面处理要求无法确认", hint: "表面淬火 HRC 45-50" }
  ];
}

export function buildOpenClarification(input: {
  id: string;
  runId: string;
  revisionId: string;
  questions: readonly ClarificationQuestion[];
  createdAt: string;
}): ClarificationRequest {
  return {
    id: input.id,
    runId: input.runId,
    revisionId: input.revisionId,
    status: "OPEN",
    questions: input.questions,
    answers: [],
    createdAt: input.createdAt
  };
}

export function buildAnsweredClarification(input: {
  id: string;
  runId: string;
  revisionId: string;
  questions: readonly ClarificationQuestion[];
  answers: readonly ClarificationAnswer[];
  createdAt: string;
  answeredAt: string;
}): ClarificationRequest {
  return {
    ...buildOpenClarification(input),
    status: "ANSWERED",
    answers: input.answers,
    answeredAt: input.answeredAt
  };
}

export function buildAnswersFromInputs(
  request: ClarificationRequest,
  inputs: readonly ClarificationAnswerInput[],
  answeredAt: string,
  answeredBy: string
): readonly ClarificationAnswer[] {
  return inputs.map((input) => ({
    id: `answer-${input.questionId}`,
    questionId: input.questionId,
    value: input.value,
    answeredAt,
    answeredBy
  }));
}

function answerToFactValue(
  value: ClarificationAnswerValue,
  question: ClarificationQuestion
): string {
  switch (value.kind) {
    case "dimension":
      return `${value.value} ${value.unit}`;
    case "text":
      return value.value;
    case "choice": {
      const option = question.options?.find((candidate) => candidate.id === value.optionId);
      return option?.label ?? value.optionId;
    }
  }
}

/**
 * Resolves the canonical Revision Fact field for one answer: an explicit field
 * wins, otherwise the request's canonical question->field map, otherwise the
 * question text as a last resort.
 */
export function resolveFactField(
  request: ClarificationRequest,
  questionId: string
): string | undefined {
  return CANONICAL_FACT_FIELDS[request.id]?.[questionId];
}

/**
 * Converts submitted Clarification answers into authoritative Revision Facts
 * (source CLARIFICATION). Used by the repository command and by scenario seeds
 * so an "answered" scenario equals what the command would produce.
 *
 * Each fact carries a stable id derived from its canonical field, so re-answering
 * the same question always targets the same fact record.
 */
export function factsFromAnswers(
  request: ClarificationRequest,
  inputs: readonly ClarificationAnswerInput[],
  answeredAt: string
): RevisionFact[] {
  return inputs.map((input) => {
    const question = request.questions.find((candidate) => candidate.id === input.questionId);
    if (question === undefined) {
      throw new DomainInvariantError(
        `Answer references unknown question ${input.questionId} on ${request.id}`
      );
    }
    const field = input.field ?? resolveFactField(request, input.questionId) ?? question.question;
    return {
      id: `fact-${request.revisionId}-${field}`,
      revisionId: request.revisionId,
      field,
      value: answerToFactValue(input.value, question),
      source: "CLARIFICATION",
      sourceRunId: request.runId,
      createdAt: answeredAt
    };
  });
}

/**
 * Upserts facts by their stable `(revisionId, field)` identity: an added fact
 * replaces any existing fact for the same revision and canonical field. This
 * guarantees a clarification answer can never coexist with a contradictory
 * canonical fact (e.g. the `材料` answer and the drawing-confirmed `材料` fact).
 */
export function upsertFactsByField(
  existing: readonly RevisionFact[],
  additions: readonly RevisionFact[]
): RevisionFact[] {
  const merged = [...existing];
  for (const fact of additions) {
    const index = merged.findIndex(
      (candidate) =>
        candidate.revisionId === fact.revisionId && candidate.field === fact.field
    );
    if (index >= 0) {
      merged[index] = fact;
    } else {
      merged.push(fact);
    }
  }
  return merged;
}

/** Canonical answered inputs for the main drawing's R05 clarification. */
export function mainAnsweredInputs(): readonly ClarificationAnswerInput[] {
  return [
    { questionId: "C01", value: { kind: "dimension", value: 85, unit: "mm" }, field: "中心孔深度" },
    { questionId: "C02", value: { kind: "text", value: "右侧轴肩外缘" }, field: "R5 圆角位置" },
    { questionId: "C03", value: { kind: "choice", optionId: "opt-42crmo" }, field: "材料" }
  ];
}

/** Builds the main R04 Clarification Request in its OPEN state. */
export function buildMainOpenClarification(): ClarificationRequest {
  return buildOpenClarification({
    id: CLARIFICATION_IDS.mainR04,
    runId: RUN_IDS.mainR04,
    revisionId: REVISION_IDS.mainV3,
    questions: mainClarificationQuestions(),
    createdAt: TIME.r04Clarified
  });
}

/** Builds the main R04 Clarification Request in its ANSWERED state. */
export function buildMainAnsweredClarification(): ClarificationRequest {
  const open = buildMainOpenClarification();
  return buildAnsweredClarification({
    id: open.id,
    runId: open.runId,
    revisionId: open.revisionId,
    questions: open.questions,
    answers: buildAnswersFromInputs(open, mainAnsweredInputs(), TIME.r04Answered, "current-windows-user"),
    createdAt: open.createdAt,
    answeredAt: TIME.r04Answered
  });
}

/** Builds the secondary drawing D R02 Clarification Request (always OPEN). */
export function buildDOpenClarification(): ClarificationRequest {
  return buildOpenClarification({
    id: CLARIFICATION_IDS.dR02,
    runId: RUN_IDS.dR02,
    revisionId: REVISION_IDS.dV1,
    questions: dClarificationQuestions(),
    createdAt: TIME.dR02Clarified
  });
}
