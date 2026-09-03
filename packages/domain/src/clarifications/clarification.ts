import { DomainInvariantError } from "../errors.js";

/**
 * A Clarification Request batches every blocking engineering question raised by
 * one Modeling Run. The Run completes as much analysis as possible and only then
 * stops at `CLARIFICATION_REQUIRED`; answers never resume the original Run.
 */
export const CLARIFICATION_STATUSES = ["OPEN", "ANSWERED"] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];

export const CLARIFICATION_STATUS_LABELS: Readonly<Record<ClarificationStatus, string>> = {
  OPEN: "待回答",
  ANSWERED: "已回答"
};

export const CLARIFICATION_QUESTION_TYPES = ["dimension", "text", "choice"] as const;
export type ClarificationQuestionType = (typeof CLARIFICATION_QUESTION_TYPES)[number];

export interface ClarificationQuestionOption {
  id: string;
  label: string;
}

export interface ClarificationQuestion {
  id: string;
  type: ClarificationQuestionType;
  question: string;
  /** Example / placeholder answer shown to the user. */
  hint?: string;
  /** Unit for `dimension` questions, e.g. mm. */
  unit?: string;
  /** Selectable options for `choice` questions. */
  options?: readonly ClarificationQuestionOption[];
}

export type ClarificationAnswerValue =
  | { kind: "dimension"; value: number; unit: string }
  | { kind: "text"; value: string }
  | { kind: "choice"; optionId: string };

export interface ClarificationAnswer {
  id: string;
  questionId: string;
  value: ClarificationAnswerValue;
  answeredAt: string;
  answeredBy: string;
}

export interface ClarificationRequest {
  id: string;
  runId: string;
  revisionId: string;
  status: ClarificationStatus;
  questions: readonly ClarificationQuestion[];
  answers: readonly ClarificationAnswer[];
  createdAt: string;
  answeredAt?: string;
}

export function canAnswerClarification(request: ClarificationRequest): boolean {
  return request.status === "OPEN";
}

/** Marks a request ANSWERED; throws when the request is not open. */
export function markClarificationAnswered(
  request: ClarificationRequest,
  answeredAt: string
): ClarificationRequest {
  if (!canAnswerClarification(request)) {
    throw new DomainInvariantError(
      `Clarification request ${request.id} is not open and cannot be answered`
    );
  }
  return { ...request, status: "ANSWERED", answeredAt };
}
