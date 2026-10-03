import { Button, FormField, InputGroup, InlineNotice, PlayIcon, Select, TextInput, UnitSelect } from "@swpanel/ui";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { ClarificationAnswer, ClarificationAnswerValue } from "@swpanel/domain";
import type { ClarificationView } from "@swpanel/contracts";

import { describeError } from "../error-messages.js";
import { formatRelativeTime } from "../format.js";

/** Stable reviewer identity snapshot for the mock (trusted current user). */
export const MOCK_ANSWERING_USER = "current-windows-user";

type ViewQuestion = ClarificationView["questions"][number];

export interface ClarificationFormProps {
  readonly clarification: ClarificationView;
  /** Number badge order (1-based) for the first question, default 1. */
  readonly startIndex?: number;
  readonly now?: Date;
  /**
   * Persists the answers on the OLD terminal Run's request. The Run is never
   * resumed. May reject with a structured error (shown inline; the form stays
   * open so the submission can be retried).
   */
  readonly onSubmitAnswers: (answers: readonly ClarificationAnswer[]) => Promise<void> | void;
  /** Stable reviewer identity snapshot recorded with the answers. */
  readonly answeredBy?: string;
  /** Called after answers are submitted successfully. */
  readonly onSubmitted?: () => void;
  /** Called when the user starts a NEW Run after answers were saved. */
  readonly onRestartModeling?: () => void;
  /** Disables the restart action while the new Run is being created. */
  readonly restarting?: boolean;
}

/** A positive plain decimal such as `85` or `12.5` (no sign, hex or exponent). */
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

/** Validates a dimension answer; returns a Chinese message or null when valid. */
export function validateDimensionInput(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "请填写数值";
  if (!POSITIVE_DECIMAL.test(value) || !(Number(value) > 0)) return "请输入大于 0 的数字，例如 85 或 12.5";
  return null;
}

function defaultUnit(question: ViewQuestion, unit: string | null): string {
  return unit ?? question.unit ?? "mm";
}

function formatAnswerValue(question: ViewQuestion, value: ClarificationAnswerValue): string {
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
 * Clarification form for an open Clarification Request. Supports the three
 * canonical question types (dimension / text / choice), validates every answer
 * before submitting, and renders the answered state read-only afterwards with a
 * "重新自动建模" action. The original Run stays terminal; a new Run is created
 * by the caller through `onRestartModeling` — the old Run is never resumed.
 */
export function ClarificationForm({
  clarification,
  startIndex = 1,
  now,
  onSubmitAnswers,
  answeredBy = MOCK_ANSWERING_USER,
  onSubmitted,
  onRestartModeling,
  restarting = false
}: ClarificationFormProps): React.JSX.Element {
  const open = clarification.status === "OPEN";

  const [dimensionValues, setDimensionValues] = useState<Readonly<Record<string, string>>>({});
  const [unitValues, setUnitValues] = useState<Readonly<Record<string, string>>>(() => {
    const initial: Record<string, string> = {};
    for (const question of clarification.questions) {
      if (question.type === "dimension") {
        initial[question.questionId] = defaultUnit(question, question.unit);
      }
    }
    return initial;
  });
  const [textValues, setTextValues] = useState<Readonly<Record<string, string>>>({});
  const [choiceValues, setChoiceValues] = useState<Readonly<Record<string, string>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const errorCount = useMemo(() => Object.keys(errors).length, [errors]);

  function setValue(
    setter: Dispatch<SetStateAction<Readonly<Record<string, string>>>>,
    questionId: string,
    value: string
  ) {
    setter((previous) => ({ ...previous, [questionId]: value }));
    if (errors[questionId] !== undefined) {
      const next = { ...errors };
      delete next[questionId];
      setErrors(next);
    }
  }

  function validate(): boolean {
    const nextErrors: Record<string, string> = {};
    for (const question of clarification.questions) {
      if (question.type === "dimension") {
        const problem = validateDimensionInput(dimensionValues[question.questionId] ?? "");
        if (problem !== null) nextErrors[question.questionId] = problem;
      } else if (question.type === "text") {
        const value = (textValues[question.questionId] ?? "").trim();
        if (value === "") {
          nextErrors[question.questionId] = "请填写回答";
        }
      } else if (question.type === "choice") {
        const value = choiceValues[question.questionId] ?? "";
        if (value === "") {
          nextErrors[question.questionId] = "请选择一项";
        }
      }
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function submit() {
    if (!validate()) return;
    setSubmitting(true);
    setSubmitError(null);
    const answeredAt = new Date().toISOString();
    const answers: ClarificationAnswer[] = clarification.questions.map((question) => {
      const base = { id: `answer-${question.questionId}`, questionId: question.questionId, answeredAt, answeredBy };
      if (question.type === "dimension") {
        const value: ClarificationAnswerValue = {
          kind: "dimension",
          value: Number((dimensionValues[question.questionId] ?? "").trim()),
          unit: unitValues[question.questionId] ?? defaultUnit(question, question.unit)
        };
        return { ...base, value };
      }
      if (question.type === "text") {
        const value: ClarificationAnswerValue = { kind: "text", value: textValues[question.questionId] ?? "" };
        return { ...base, value };
      }
      const value: ClarificationAnswerValue = { kind: "choice", optionId: choiceValues[question.questionId] ?? "" };
      return { ...base, value };
    });

    Promise.resolve(onSubmitAnswers(answers)).then(
      () => {
        setSubmitting(false);
        onSubmitted?.();
      },
      (error: unknown) => {
        setSubmitting(false);
        setSubmitError(describeError(error).message);
      }
    );
  }

  const answeredTime =
    clarification.answers.length > 0
      ? clarification.answers[clarification.answers.length - 1]?.answeredAt
      : undefined;

  return (
    <div>
      {open ? (
        <InlineNotice tone="info" className="mb-6" title="Agent 已完成当前可以完成的分析">
          以下信息无法从图纸中确定。提交后回答将进入当前 Revision Facts（版本记忆）。原 Run 不恢复执行，需创建新的 Run 继续建模。
        </InlineNotice>
      ) : (
        <InlineNotice
          tone="success"
          className="mb-6"
          title={
            answeredTime !== undefined
              ? `补充信息已保存至版本记忆 · ${formatRelativeTime(answeredTime, now)}`
              : "补充信息已保存至版本记忆"
          }
        >
          本次 Run 已结束。重新建模将创建新的 Run。
        </InlineNotice>
      )}

      {submitError !== null && (
        <InlineNotice tone="error" className="mb-6" title="提交失败" role="alert">
          {submitError}
        </InlineNotice>
      )}

      {clarification.questions.map((question, index) => {
        const number = startIndex + index;
        const answered = clarification.answers.find((answer) => answer.questionId === question.questionId);
        const error = errors[question.questionId];
        const hint = question.hint;

        return (
          <div className="clarification-question" key={question.questionId}>
            <div className="clarification-question-header">
              <span className="clarification-question-num">{number}.</span>
              <span className="clarification-question-text">{question.question}</span>
            </div>

            {!open && answered !== undefined ? (
              <div className="form-field">
                <p className="text-sm mono" data-testid={`answer-${question.questionId}`}>
                  {formatAnswerValue(question, answered.value as ClarificationAnswerValue)}
                </p>
                <span className="form-hint">{formatRelativeTime(answered.answeredAt, now)}</span>
              </div>
            ) : question.type === "dimension" ? (
              <FormField
                label="数值"
                {...(hint !== null ? { hint: `示例：${hint}` } : {})}
                {...(error !== undefined ? { error } : {})}
              >
                <InputGroup className="input-w-md">
                  <TextInput
                    mono
                    placeholder="输入数值"
                    value={dimensionValues[question.questionId] ?? ""}
                    onValueChange={(value) => setValue(setDimensionValues, question.questionId, value)}
                    invalid={error !== undefined}
                    inputProps={{ "aria-label": question.question, type: "text", inputMode: "decimal" }}
                  />
                  <UnitSelect
                    value={unitValues[question.questionId] ?? defaultUnit(question, question.unit)}
                    onValueChange={(unit) => setValue(setUnitValues, question.questionId, unit)}
                    options={Array.from(new Set([question.unit ?? "mm", "cm", "m"])).map((unit) => ({ label: unit, value: unit }))}
                    selectProps={{ "aria-label": `${question.question} 单位` }}
                  />
                </InputGroup>
              </FormField>
            ) : question.type === "text" ? (
              <FormField
                label="回答"
                {...(hint !== null ? { hint: `示例：${hint}` } : {})}
                {...(error !== undefined ? { error } : {})}
              >
                <TextInput
                  placeholder="请输入回答"
                  value={textValues[question.questionId] ?? ""}
                  onValueChange={(value) => setValue(setTextValues, question.questionId, value)}
                  invalid={error !== undefined}
                  inputProps={{ "aria-label": question.question }}
                />
              </FormField>
            ) : (
              <FormField label="选择" hint="从列表中选择" {...(error !== undefined ? { error } : {})}>
                <Select
                  placeholder="请选择"
                  className="input-w-md"
                  value={choiceValues[question.questionId] ?? ""}
                  onValueChange={(value) => setValue(setChoiceValues, question.questionId, value)}
                  invalid={error !== undefined}
                  options={(question.options ?? []).map((option) => ({ label: option.label, value: option.id }))}
                  selectProps={{ "aria-label": question.question }}
                />
              </FormField>
            )}
          </div>
        );
      })}

      {open ? (
        <div className="flex-row-gap-3 mt-6">
          <Button variant="primary" {...(submitting ? {} : { onClick: submit })} disabled={submitting}>
            提交补充信息
          </Button>
          {errorCount > 0 && <span className="text-sm text-muted">还有 {errorCount} 项未填写完整</span>}
        </div>
      ) : (
        <div className="mt-6">
          <Button
            variant="primary"
            {...(onRestartModeling !== undefined && !restarting ? { onClick: onRestartModeling } : {})}
            disabled={restarting}
          >
            <PlayIcon aria-hidden="true" />
            {restarting ? "正在创建新任务…" : "重新自动建模"}
          </Button>
        </div>
      )}
    </div>
  );
}
