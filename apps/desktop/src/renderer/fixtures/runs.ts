import type {
  DrawingRevision,
  ModelingFeedback,
  ModelingRun,
  RevisionFact,
  RunEvent,
  RunEventPayload,
  RunFailureCode,
  RunInputSnapshot,
  RunStage,
  RunStatus
} from "@swpanel/domain";
import { RUN_EVENT_CONTRACT_VERSION, runLabel } from "@swpanel/domain";
import {
  MOCK_AGENT_CONFIG_ID,
  MOCK_ATTEMPT_ID,
  MOCK_PROMPT_TEMPLATE_VERSION,
  MOCK_SKILL
} from "./execution.js";
import { MODEL_IDS } from "./models.js";
import { TIME } from "./timeline.js";

/** Stable fixture ids for every canonical Modeling Run. */
export const RUN_IDS = {
  mainR01: "run-main-r01",
  mainR02: "run-main-r02",
  mainR03: "run-main-r03",
  mainR04: "run-main-r04",
  mainR05: "run-main-r05",
  mainR06: "run-main-r06",
  aR01: "run-a-r01",
  aR02: "run-a-r02",
  aR03: "run-a-r03",
  bR01: "run-b-r01",
  cR01: "run-c-r01",
  cR02: "run-c-r02",
  dR01: "run-d-r01",
  dR02: "run-d-r02"
} as const;

/** Builds one structured Run event with the mandatory envelope fields. */
export function event(
  runId: string,
  sequence: number,
  occurredAt: string,
  payload: RunEventPayload
): RunEvent {
  return {
    contractVersion: RUN_EVENT_CONTRACT_VERSION,
    runId,
    attemptId: MOCK_ATTEMPT_ID,
    sequence,
    occurredAt,
    ...payload
  };
}

export function stageEvent(
  runId: string,
  sequence: number,
  occurredAt: string,
  stage: RunStage,
  activity?: string
): RunEvent {
  return event(runId, sequence, occurredAt, {
    type: "StageChanged",
    stage,
    ...(activity !== undefined ? { activity } : {})
  });
}

export function activityEvent(
  runId: string,
  sequence: number,
  occurredAt: string,
  activity: string
): RunEvent {
  return event(runId, sequence, occurredAt, { type: "ActivityUpdated", activity });
}

export function progressEvent(
  runId: string,
  sequence: number,
  occurredAt: string,
  progressPercent: number
): RunEvent {
  return event(runId, sequence, occurredAt, { type: "ProgressUpdated", progressPercent });
}

export function completedEvent(
  runId: string,
  sequence: number,
  occurredAt: string,
  modelId: string
): RunEvent {
  return event(runId, sequence, occurredAt, { type: "Completed", modelId });
}

export function failedEvent(
  runId: string,
  sequence: number,
  occurredAt: string,
  failureCode: RunFailureCode,
  failureMessage?: string
): RunEvent {
  return event(runId, sequence, occurredAt, {
    type: "Failed",
    failureCode,
    ...(failureMessage !== undefined ? { failureMessage } : {})
  });
}

export function clarificationEvent(
  runId: string,
  sequence: number,
  occurredAt: string,
  clarificationRequestId: string
): RunEvent {
  return event(runId, sequence, occurredAt, { type: "ClarificationRequired", clarificationRequestId });
}

/**
 * Builds a ModelingRun from explicit fields, only setting the optional trailing
 * fields when the caller supplied them (honors exactOptionalPropertyTypes).
 */
export function buildRun(input: {
  id: string;
  number: string;
  drawingId: string;
  revisionId: string;
  status: RunStatus;
  stage: RunStage | null;
  inputSnapshot: RunInputSnapshot;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failureCode?: RunFailureCode;
  failureMessage?: string;
  clarificationRequestId?: string;
  modelId?: string;
}): ModelingRun {
  return {
    id: input.id,
    number: input.number,
    drawingId: input.drawingId,
    revisionId: input.revisionId,
    status: input.status,
    stage: input.stage,
    inputSnapshot: input.inputSnapshot,
    createdAt: input.createdAt,
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
    ...(input.failureMessage !== undefined ? { failureMessage: input.failureMessage } : {}),
    ...(input.clarificationRequestId !== undefined
      ? { clarificationRequestId: input.clarificationRequestId }
      : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {})
  };
}

/**
 * Freezes the execution input at Run creation. A Run reads the Memory snapshot
 * from its creation moment: only facts/feedback recorded up to `createdAt` are
 * included, and the snapshot is never modified afterwards.
 */
export function buildInputSnapshot(input: {
  revision: DrawingRevision;
  facts: readonly RevisionFact[];
  feedback: readonly ModelingFeedback[];
  createdAt: string;
}): RunInputSnapshot {
  return {
    drawingId: input.revision.drawingId,
    revisionId: input.revision.id,
    originalFileRef: input.revision.sourceFile.id,
    revisionFacts: input.facts.filter((fact) => fact.createdAt <= input.createdAt),
    modelingFeedback: input.feedback.filter((feedback) => feedback.createdAt <= input.createdAt),
    promptTemplateVersion: MOCK_PROMPT_TEMPLATE_VERSION,
    skill: MOCK_SKILL,
    agentConfigId: MOCK_AGENT_CONFIG_ID,
    createdAt: input.createdAt
  };
}

/** Standard event stream of a Run that completed and published a Model. */
export function completedRunEvents(input: {
  runId: string;
  modelId: string;
  startedAt: string;
  completedAt: string;
}): RunEvent[] {
  const stages: readonly RunStage[] = [
    "PREPARING",
    "ANALYZING",
    "PLANNING",
    "MODELING",
    "VALIDATING",
    "PACKAGING"
  ];
  const events: RunEvent[] = stages.map((stage, index) =>
    stageEvent(input.runId, index + 1, input.startedAt, stage)
  );
  events.push(
    completedEvent(input.runId, stages.length + 1, input.completedAt, input.modelId)
  );
  return events;
}

/** R05 partial progress while it is RUNNING at the MODELING stage (63%). */
export function mainR05RunningEvents(): RunEvent[] {
  const runId = RUN_IDS.mainR05;
  return [
    stageEvent(runId, 1, TIME.r05Created, "PREPARING"),
    stageEvent(runId, 2, TIME.r05Created, "ANALYZING"),
    progressEvent(runId, 3, TIME.r05Created, 25),
    stageEvent(runId, 4, TIME.r05Created, "PLANNING"),
    progressEvent(runId, 5, TIME.r05Created, 40),
    stageEvent(runId, 6, TIME.r05Created, "MODELING"),
    progressEvent(runId, 7, TIME.r05Created, 63),
    activityEvent(runId, 8, TIME.r05Created, "正在创建主要旋转特征")
  ];
}

/** R05 full event stream for scenarios where it completed and published M03. */
export function mainR05CompletedEvents(): RunEvent[] {
  const runId = RUN_IDS.mainR05;
  const running = mainR05RunningEvents();
  const lastSequence = running.length;
  return [
    ...running,
    stageEvent(runId, lastSequence + 1, TIME.r05Completed, "VALIDATING"),
    stageEvent(runId, lastSequence + 2, TIME.r05Completed, "PACKAGING"),
    completedEvent(runId, lastSequence + 3, TIME.r05Completed, MODEL_IDS.mainM03)
  ];
}

/** R06 full event stream for the background Run that published M02. */
export function mainR06CompletedEvents(): RunEvent[] {
  const runId = RUN_IDS.mainR06;
  const stages: readonly RunStage[] = [
    "PREPARING",
    "ANALYZING",
    "PLANNING",
    "MODELING",
    "VALIDATING",
    "PACKAGING"
  ];
  const events: RunEvent[] = stages.map((stage, index) =>
    stageEvent(runId, index + 1, TIME.r06Created, stage)
  );
  events.push(
    completedEvent(runId, stages.length + 1, TIME.r06Completed, MODEL_IDS.mainM02)
  );
  return events;
}

/** R05 event stream for the run-failed scenario (failed during VALIDATING). */
export function mainR05FailedEvents(): RunEvent[] {
  const runId = RUN_IDS.mainR05;
  const running = mainR05RunningEvents();
  const lastSequence = running.length;
  return [
    ...running,
    stageEvent(runId, lastSequence + 1, TIME.r05Failed, "VALIDATING"),
    failedEvent(runId, lastSequence + 2, TIME.r05Failed, "VALIDATION_REJECTED", "SolidWorks 自动重建失败")
  ];
}

/** Event stream of a Run that terminated with a technical failure. */
export function failedRunEvents(input: {
  runId: string;
  failureCode: RunFailureCode;
  failureMessage?: string;
  startedAt: string;
  failedAt: string;
}): RunEvent[] {
  return [
    stageEvent(input.runId, 1, input.startedAt, "PREPARING"),
    stageEvent(input.runId, 2, input.startedAt, "ANALYZING"),
    stageEvent(input.runId, 3, input.startedAt, "PLANNING"),
    stageEvent(input.runId, 4, input.startedAt, "MODELING"),
    stageEvent(input.runId, 5, input.startedAt, "VALIDATING"),
    failedEvent(input.runId, 6, input.failedAt, input.failureCode, input.failureMessage)
  ];
}

/** Event stream of a Run the user actively cancelled. */
export function cancelledRunEvents(input: {
  runId: string;
  startedAt: string;
  cancelledAt: string;
  reason?: string;
}): RunEvent[] {
  return [
    stageEvent(input.runId, 1, input.startedAt, "PREPARING"),
    stageEvent(input.runId, 2, input.startedAt, "ANALYZING"),
    event(input.runId, 3, input.cancelledAt, {
      type: "CancellationRequested",
      ...(input.reason !== undefined ? { reason: input.reason } : {})
    }),
    event(input.runId, 4, input.cancelledAt, { type: "CancellationConfirmed" })
  ];
}

/** Event stream of a Run that stopped at CLARIFICATION_REQUIRED. */
export function clarificationRunEvents(input: {
  runId: string;
  clarificationRequestId: string;
  startedAt: string;
  clarifiedAt: string;
}): RunEvent[] {
  return [
    stageEvent(input.runId, 1, input.startedAt, "PREPARING"),
    stageEvent(input.runId, 2, input.startedAt, "ANALYZING"),
    stageEvent(input.runId, 3, input.startedAt, "PLANNING"),
    activityEvent(input.runId, 4, input.startedAt, "正在汇总无法确定的工程信息"),
    clarificationEvent(input.runId, 5, input.clarifiedAt, input.clarificationRequestId)
  ];
}

/** Convenience: canonical sequence label for a Run on a revision. */
export function nextRunLabel(sequence: number): string {
  return runLabel(sequence);
}
