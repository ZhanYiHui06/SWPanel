import type {
  DrawingRevision,
  ModelingFeedback,
  ModelingRun,
  RevisionFact,
  RunEvent,
  RunEventType,
  RunStage
} from "@swpanel/domain";
import { buildScenario, type MockScenario } from "./scenarios.js";
import type { MockWorld } from "./world.js";

/**
 * Reusable fixture causality validator (handoff batch B).
 *
 * It audits the canonical scenario worlds for the cross-entity timeline rules
 * that make the deterministic fixture data self-consistent. Every check reads
 * the worlds produced by `buildScenario` — the same source of truth the Mock
 * Repository is seeded from — so the audit never copies a second, potentially
 * divergent dataset.
 *
 * Checks:
 *  1. event-order        — every Run's event `sequence` is strictly
 *                          increasing and `occurredAt` is monotonically
 *                          non-decreasing.
 *  2. run-lifecycle      — every Run's status is validated per status class:
 *                          QUEUED has no start/end/events, RUNNING has a start
 *                          but no end and no terminal event, and every terminal
 *                          Run has exactly one matching terminal event as its
 *                          last event at `completedAt`; all event timestamps
 *                          stay inside [startedAt, completedAt]; the StageChanged
 *                          stream is a contiguous prefix of the canonical six
 *                          stages; every non-QUEUED event occurs no earlier than
 *                          startedAt; a RUNNING Run's `stage` equals its last
 *                          StageChanged event; a Run with no StageChanged event
 *                          must show `stage === null`; a terminal Run shows
 *                          `stage === null` after execution ended.
 *  3. model-source       — every Model is produced by a COMPLETED source Run
 *                          whose `modelId` points back at the Model; a COMPLETED
 *                          Run MAY carry no modelId (Phase 3 Fake Executor
 *                          completes without publishing a Model), but a provided
 *                          modelId — on the Run record or on its Completed event
 *                          — must resolve to a Model produced by that Run; every
 *                          COMPLETED Run has exactly one Completed event and
 *                          that event is the last event; a REJECTED model's
 *                          source Run must be COMPLETED.
 *  4. reject-source      — a REJECTED review is recorded strictly after its
 *                          source Run finished and after the model was
 *                          generated (a rejection can never roll back time).
 *  5. r05-variants       — in every scenario that features R05, the Run must
 *                          walk the exact per-variant stage chain (a missing
 *                          stage or an early terminal is a violation).
 *  6. sole-running       — at most one RUNNING Run per scenario world, and no
 *                          RUNNING Run may overlap a completed R05.
 *  7. cost-reports       — a report's `modelId` is the revision's unambiguous
 *                          latest APPROVED model at the report's creation
 *                          moment, built only from temporally valid APPROVED
 *                          reviews of the same revision; the drawing/revision/
 *                          model/source-run/report/snapshot chain is consistent.
 *  8. approval-pointer   — every Revision's `currentApprovedModelId` equals the
 *                          revision's unique latest valid APPROVED review and is
 *                          null when no valid approval exists (the "current final
 *                          pointer" semantics; the report-time semantics are the
 *                          cost-reports rule above).
 *  9. snapshot-freeze    — a Run input snapshot freezes exactly the Revision
 *                          Facts and Modeling Feedback visible on the run's
 *                          revision at the run's creation instant: same revision,
 *                          createdAt <= run.createdAt, every visible record is
 *                          present and every present record is visible
 *                          (bidirectional); feedback references belong to the
 *                          same revision.
 * 10. cost-snapshot      — every cost item frozen into a report's cost-data
 *                          snapshot is effective by the capture instant
 *                          (`updatedAt <= capturedAt`, and `effectiveFrom <=
 *                          capturedAt` for materials), so a historical report
 *                          never uses cost data updated after it was captured.
 * 11. timeline           — the full causal chain holds across entities:
 *                          drawing <= revision <= run created <= run completed
 *                          <= model generated <= review <= report, and a source
 *                          file is uploaded no earlier than its drawing was
 *                          created and no later than its revision was created.
 * 12. unique-ids         — every entity id is unique within its kind, every
 *                          `runEvents` key names a real Run, every Run has an
 *                          entry, and every event's `runId` matches its key.
 * 13. finite-times       — every timestamp across every entity parses to a
 *                          finite number.
 * 14. run-intervals      — the execution intervals of all executed (non-QUEUED)
 *                          Runs are globally non-overlapping.
 * 15. cross-revision     — every Memory reference stays inside the owning
 *                          Revision, in the world and in every frozen Run input
 *                          snapshot: a Fact's `sourceRunId` (when present) must
 *                          name a Run on the same revision as the Fact; every
 *                          Modeling Feedback must reference a Model and a Model
 *                          Review that belong to the feedback's revision, where
 *                          the review names the same Model and is REJECTED.
 *
 * The standalone `npm run check:fixtures` command prints the full audit and
 * exits non-zero on any problem; the vitest suite asserts the same rules.
 */

export interface TimelineViolation {
  /** Compact category id used by the CLI report. */
  rule:
    | "event-order"
    | "run-lifecycle"
    | "model-source"
    | "reject-source"
    | "r05-variants"
    | "sole-running"
    | "cost-reports"
    | "approval-pointer"
    | "snapshot-freeze"
    | "cost-snapshot"
    | "timeline"
    | "unique-ids"
    | "finite-times"
    | "run-intervals"
    | "cross-revision";
  scenario: MockScenario;
  message: string;
}

export interface TimelineAudit {
  scenario: MockScenario;
  violations: TimelineViolation[];
}

/** Parses a canonical ISO-8601 timestamp. Invalid dates become NaN. */
function timestamp(value: string): number {
  return Date.parse(value);
}

/** True when the parsed timestamp is a finite number. */
function isFiniteTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/** The six documented stages, in execution order. */
const STAGE_ORDER: readonly string[] = [
  "PREPARING",
  "ANALYZING",
  "PLANNING",
  "MODELING",
  "VALIDATING",
  "PACKAGING"
];

/** The R05 variants that must demonstrate the causal chain. */
export const R05_CAUSAL_SCENARIOS: readonly MockScenario[] = [
  "run-running",
  "run-completed",
  "model-pending-review",
  "model-approved",
  "model-rejected",
  "cost-report-generated",
  "run-failed"
];

/**
 * The exact StageChanged chain each R05 variant must walk. A scenario not
 * listed here does not feature R05 in a pinned stage shape.
 */
const R05_EXPECTED_STAGES: Readonly<Partial<Record<MockScenario, readonly string[]>>> = {
  "run-running": ["PREPARING", "ANALYZING", "PLANNING", "MODELING"],
  "run-queued": [],
  "run-completed": STAGE_ORDER,
  "run-cancelled": ["PREPARING", "ANALYZING"],
  "run-failed": ["PREPARING", "ANALYZING", "PLANNING", "MODELING", "VALIDATING"],
  "model-pending-review": STAGE_ORDER,
  "model-approved": STAGE_ORDER,
  "model-rejected": STAGE_ORDER,
  "cost-report-generated": STAGE_ORDER
};

/** The terminal event type each R05 variant must end on. */
const R05_EXPECTED_TERMINAL: Readonly<Partial<Record<MockScenario, RunEventType>>> = {
  "run-completed": "Completed",
  "model-pending-review": "Completed",
  "model-approved": "Completed",
  "model-rejected": "Completed",
  "cost-report-generated": "Completed",
  "run-failed": "Failed",
  "run-cancelled": "CancellationConfirmed"
};

/** Terminal event types. CancellationRequested alone is not terminal. */
const TERMINAL_EVENT_TYPES: readonly RunEventType[] = [
  "Completed",
  "Failed",
  "CancellationConfirmed",
  "ClarificationRequired"
];

function isTerminalEvent(event: RunEvent): boolean {
  return TERMINAL_EVENT_TYPES.includes(event.type);
}

function stageStream(events: readonly RunEvent[]): readonly RunStage[] {
  return events
    .filter((event) => event.type === "StageChanged")
    .map((event) => event.stage);
}

/**
 * Walks a Run's event chain against its recorded status and asserts the status,
 * timestamps, terminal event and stage stream are consistent.
 */
function validateRunLifecycle(run: ModelingRun, events: readonly RunEvent[]): string[] {
  const problems: string[] = [];
  const id = run.id;

  if (run.status === "QUEUED") {
    if (run.startedAt !== undefined) problems.push(`run ${id} is QUEUED but has startedAt`);
    if (run.completedAt !== undefined) problems.push(`run ${id} is QUEUED but has completedAt`);
    if (run.stage !== null) problems.push(`run ${id} is QUEUED but has stage ${String(run.stage)}`);
    if (events.length > 0) {
      problems.push(`run ${id} is QUEUED but has ${events.length} event(s)`);
    }
    return problems;
  }

  // Every executed (non-QUEUED) event must occur no earlier than startedAt.
  if (run.startedAt === undefined) {
    problems.push(`run ${id} is ${run.status} but has no startedAt`);
  } else {
    for (const event of events) {
      if (timestamp(event.occurredAt) < timestamp(run.startedAt)) {
        problems.push(
          `run ${id} event seq ${event.sequence} at ${event.occurredAt} predates startedAt ${run.startedAt}`
        );
        break;
      }
    }
  }

  // The `stage` field is the user-visible stage, null before execution starts
  // and after it ends. Consistency rules:
  // - no StageChanged event => stage must be null;
  // - RUNNING stage must equal the last StageChanged event's stage;
  // - a terminal Run shows stage null after execution ended.
  const stageEvents = events.filter((event) => event.type === "StageChanged");
  if (stageEvents.length === 0 && run.stage !== null) {
    problems.push(`run ${id} has no StageChanged event but shows stage ${String(run.stage)}`);
  }
  if (run.status === "RUNNING") {
    const lastStage = [...stageEvents].at(-1)?.stage;
    if (lastStage !== undefined && run.stage !== lastStage) {
      problems.push(
        `run ${id} stage ${String(run.stage)} does not match its last StageChanged event ${lastStage}`
      );
    }
  } else if (run.stage !== null) {
    problems.push(`run ${id} is ${run.status} but still shows stage ${String(run.stage)} after execution ended`);
  }

  if (run.status === "RUNNING") {
    if (run.startedAt === undefined) problems.push(`run ${id} is RUNNING but has no startedAt`);
    if (run.completedAt !== undefined) problems.push(`run ${id} is RUNNING but has completedAt`);
    if (run.stage === null) problems.push(`run ${id} is RUNNING but has no stage`);
    if (events.length === 0) problems.push(`run ${id} is RUNNING but has no events`);
    const terminal = events.find((event) => isTerminalEvent(event));
    if (terminal !== undefined) {
      problems.push(`run ${id} is RUNNING but already has a terminal event ${terminal.type}`);
    }
    return problems;
  }

  // ---- terminal statuses ----
  if (run.startedAt === undefined) problems.push(`run ${id} is ${run.status} but has no startedAt`);
  if (run.completedAt === undefined) problems.push(`run ${id} is ${run.status} but has no completedAt`);
  if (run.startedAt !== undefined && run.completedAt !== undefined) {
    if (timestamp(run.completedAt) < timestamp(run.startedAt)) {
      problems.push(`run ${id} completed ${run.completedAt} before it started ${run.startedAt}`);
    }
  }
  const started = run.startedAt;
  const eventsStart = events[0]?.occurredAt;
  if (started !== undefined && eventsStart !== undefined && timestamp(eventsStart) < timestamp(started)) {
    problems.push(`run ${id} first event at ${eventsStart} predates startedAt ${started}`);
  }

  // Exactly one terminal event of the kind matching the recorded status, and no
  // terminal event of any other kind.
  const counts = new Map<RunEventType, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  const countType = (type: RunEventType): number => counts.get(type) ?? 0;

  switch (run.status) {
    case "COMPLETED": {
      const completed = countType("Completed");
      if (completed !== 1) {
        problems.push(`run ${id} is COMPLETED but has ${completed} Completed event(s)`);
      }
      for (const type of TERMINAL_EVENT_TYPES) {
        const count = countType(type);
        if (type !== "Completed" && count > 0) {
          problems.push(`run ${id} is COMPLETED but has ${count} ${type} event(s)`);
        }
      }
      const completedEvent = events.find((event) => event.type === "Completed");
      if (completedEvent !== undefined && completedEvent.modelId !== run.modelId) {
        if (run.modelId === undefined) {
          problems.push(
            `run ${id} Completed event publishes model ${completedEvent.modelId} but the run records none`
          );
        } else {
          problems.push(
            `run ${id} Completed event publishes model ${completedEvent.modelId} but the run records ${run.modelId}`
          );
        }
      }
      break;
    }
    case "FAILED": {
      const failed = countType("Failed");
      if (failed !== 1) {
        problems.push(`run ${id} is FAILED but has ${failed} Failed event(s)`);
      }
      for (const type of TERMINAL_EVENT_TYPES) {
        if (type !== "Failed" && countType(type) > 0) {
          problems.push(`run ${id} is FAILED but has ${countType(type)} ${type} event(s)`);
        }
      }
      const failedEvent = events.find((event) => event.type === "Failed");
      if (failedEvent !== undefined && run.failureCode !== undefined && failedEvent.failureCode !== run.failureCode) {
        problems.push(
          `run ${id} Failed event reports ${failedEvent.failureCode} but the run records ${run.failureCode}`
        );
      }
      break;
    }
    case "CANCELLED": {
      const requested = countType("CancellationRequested");
      const confirmed = countType("CancellationConfirmed");
      if (requested !== 1) {
        problems.push(`run ${id} is CANCELLED but has ${requested} CancellationRequested event(s)`);
      }
      if (confirmed !== 1) {
        problems.push(`run ${id} is CANCELLED but has ${confirmed} CancellationConfirmed event(s)`);
      }
      const requestedIndex = events.findIndex((event) => event.type === "CancellationRequested");
      const confirmedIndex = events.findIndex((event) => event.type === "CancellationConfirmed");
      if (requestedIndex >= 0 && confirmedIndex >= 0 && requestedIndex >= confirmedIndex) {
        problems.push(`run ${id} CancellationConfirmed precedes CancellationRequested`);
      }
      break;
    }
    case "CLARIFICATION_REQUIRED": {
      const clarifications = countType("ClarificationRequired");
      if (clarifications !== 1) {
        problems.push(`run ${id} is CLARIFICATION_REQUIRED but has ${clarifications} ClarificationRequired event(s)`);
      }
      const clarificationEvent = events.find((event) => event.type === "ClarificationRequired");
      if (
        clarificationEvent !== undefined &&
        run.clarificationRequestId !== undefined &&
        clarificationEvent.clarificationRequestId !== run.clarificationRequestId
      ) {
        problems.push(
          `run ${id} ClarificationRequired event references ${clarificationEvent.clarificationRequestId} but the run records ${run.clarificationRequestId}`
        );
      }
      break;
    }
  }

  // No event may arrive after the Run already terminated.
  const firstTerminalIndex = events.findIndex((event) => isTerminalEvent(event));
  if (firstTerminalIndex >= 0 && firstTerminalIndex < events.length - 1) {
    const following = events[firstTerminalIndex + 1];
    problems.push(
      `run ${id} has an event after it already terminated: ${following?.type} at ${following?.occurredAt}`
    );
  }

  // The last event must be the terminal event and must match completedAt.
  const lastEvent = events.at(-1);
  if (lastEvent !== undefined && run.completedAt !== undefined) {
    if (timestamp(lastEvent.occurredAt) < timestamp(run.completedAt)) {
      problems.push(
        `run ${id} last event at ${lastEvent.occurredAt} predates completedAt ${run.completedAt}`
      );
    }
    if (timestamp(lastEvent.occurredAt) > timestamp(run.completedAt)) {
      problems.push(
        `run ${id} last event at ${lastEvent.occurredAt} is after completedAt ${run.completedAt}`
      );
    }
  }

  // Every event must stay inside [startedAt, completedAt].
  if (run.startedAt !== undefined && run.completedAt !== undefined) {
    const start = timestamp(run.startedAt);
    const end = timestamp(run.completedAt);
    for (const event of events) {
      const occurred = timestamp(event.occurredAt);
      if (occurred < start) {
        problems.push(`run ${id} event seq ${event.sequence} at ${event.occurredAt} predates startedAt ${run.startedAt}`);
        break;
      }
      if (occurred > end) {
        problems.push(`run ${id} event seq ${event.sequence} at ${event.occurredAt} is after completedAt ${run.completedAt}`);
        break;
      }
    }
  }

  // The StageChanged stream must be a contiguous prefix of the canonical stages
  // (no missing stage, no repeats, no out-of-order stage).
  const stages = stageStream(events);
  for (let index = 0; index < stages.length; index += 1) {
    if (stages[index] !== STAGE_ORDER[index]) {
      problems.push(
        `run ${id} stage sequence diverges from the documented chain at position ${index}: ${JSON.stringify(stages)}`
      );
      break;
    }
  }
  if (run.status === "COMPLETED" && stages.length !== STAGE_ORDER.length) {
    problems.push(
      `run ${id} is COMPLETED but walked ${stages.length}/${STAGE_ORDER.length} stages`
    );
  }

  return problems;
}

/**
 * The R05 exact-chain check: in every scenario that features R05, the stage
 * stream must equal the variant's pinned chain and the last event must be the
 * variant's expected terminal event (missing stages and early terminals are
 * both violations).
 */
function validateR05Causality(
  scenario: MockScenario,
  run: ModelingRun,
  events: readonly RunEvent[]
): string[] {
  const problems: string[] = [];
  const expected = R05_EXPECTED_STAGES[scenario];
  if (expected === undefined) return problems;

  const stages = stageStream(events);
  if (stages.length !== expected.length || stages.some((stage, index) => stage !== expected[index])) {
    problems.push(
      `run ${run.id} in ${scenario} stage sequence ${JSON.stringify(stages)} diverges from the required exact chain ${JSON.stringify(expected)}`
    );
  }

  const expectedTerminal = R05_EXPECTED_TERMINAL[scenario];
  if (expectedTerminal !== undefined) {
    const lastEvent = events.at(-1);
    if (lastEvent?.type !== expectedTerminal) {
      problems.push(
        `run ${run.id} in ${scenario} last event is ${lastEvent?.type ?? "none"}, expected ${expectedTerminal}`
      );
    } else if (run.completedAt !== undefined && timestamp(lastEvent.occurredAt) !== timestamp(run.completedAt)) {
      problems.push(
        `run ${run.id} terminal event at ${lastEvent.occurredAt} does not match completedAt ${run.completedAt}`
      );
    }
  }

  if (scenario === "run-running" && events.some((event) => isTerminalEvent(event))) {
    problems.push(`run ${run.id} is RUNNING in ${scenario} but has a terminal event`);
  }
  if (scenario === "run-queued" && events.length > 0) {
    problems.push(`run ${run.id} is QUEUED in ${scenario} but has events`);
  }
  return problems;
}

/** Rejects must be recorded strictly after their source Run completed. */
function validateRejectSource(world: MockWorld): string[] {
  const problems: string[] = [];
  const runsById = new Map(world.runs.map((run) => [run.id, run]));
  const modelsById = new Map(world.models.map((model) => [model.id, model]));
  for (const review of world.reviews) {
    if (review.result !== "REJECTED") continue;
    const model = modelsById.get(review.modelId);
    if (model === undefined) continue;
    const sourceRun = runsById.get(model.runId);
    if (sourceRun === undefined) continue;
    const runDoneAt = sourceRun.completedAt ?? sourceRun.createdAt;
    if (timestamp(review.createdAt) <= timestamp(runDoneAt)) {
      problems.push(
        `review ${review.id} rejected model ${model.id} at ${review.createdAt}, not after its source run ${sourceRun.id} finished at ${runDoneAt}`
      );
    }
    // A rejection can never roll back the model's own creation time.
    if (timestamp(review.createdAt) < timestamp(model.generatedAt)) {
      problems.push(
        `review ${review.id} rejected model ${model.id} at ${review.createdAt} before the model was generated ${model.generatedAt}`
      );
    }
  }
  return problems;
}

/**
 * Rule 1 (model-source): every Model must be produced by a COMPLETED source Run
 * whose `modelId` points back at the Model, and the Run's unique Completed event
 * must publish that same Model and be the last event. A COMPLETED Run MAY
 * publish no Model (Phase 3 Fake Executor semantics): a missing `modelId` is
 * valid, while any provided `modelId` — on the Run record or on its Completed
 * event — must resolve to a Model produced by that same Run. A REJECTED review
 * reviews a produced Model, so a rejected model's source Run must be COMPLETED.
 */
function validateModelSource(world: MockWorld): string[] {
  const problems: string[] = [];
  const runsById = new Map(world.runs.map((run) => [run.id, run]));
  const modelsById = new Map(world.models.map((model) => [model.id, model]));

  for (const model of world.models) {
    const run = runsById.get(model.runId);
    if (run === undefined) {
      problems.push(`model ${model.id} references unknown source run ${model.runId}`);
      continue;
    }
    if (run.status !== "COMPLETED") {
      problems.push(
        `model ${model.id} is produced by source run ${run.id} which is ${run.status}, not COMPLETED`
      );
    }
    if (run.modelId !== model.id) {
      problems.push(
        `model ${model.id} source run ${run.id} records modelId ${run.modelId ?? "none"}, not the model`
      );
    }
    if (run.status === "COMPLETED") {
      const published = (world.runEvents[run.id] ?? []).filter(
        (event) => event.type === "Completed" && event.modelId === model.id
      );
      if (published.length !== 1) {
        problems.push(
          `COMPLETED run ${run.id} has ${published.length} Completed event(s) publishing model ${model.id}`
        );
      }
    }
  }

  for (const run of world.runs) {
    if (run.status !== "COMPLETED") continue;
    const events = world.runEvents[run.id] ?? [];
    const completed = events.filter((event) => event.type === "Completed");
    if (completed.length !== 1) {
      problems.push(`COMPLETED run ${run.id} has ${completed.length} Completed event(s)`);
    }
    // Phase 3 semantics: a Run may complete WITHOUT publishing a Model (the
    // Fake Executor creates no models record). A missing modelId is valid; a
    // provided modelId on the Run record must resolve to a Model produced by
    // this Run.
    if (run.modelId !== undefined) {
      const model = modelsById.get(run.modelId);
      if (model === undefined) {
        problems.push(`COMPLETED run ${run.id} publishes unknown model ${run.modelId}`);
      } else if (model.runId !== run.id) {
        problems.push(
          `COMPLETED run ${run.id} publishes model ${run.modelId} which belongs to run ${model.runId}`
        );
      }
    }
    // A modelId published by the Completed event must resolve to a Model of
    // this Run too (the record/event equality is checked by run-lifecycle).
    if (completed.length === 1 && completed[0]?.modelId !== undefined) {
      const publishedModelId = completed[0].modelId;
      const model = modelsById.get(publishedModelId);
      if (model === undefined) {
        problems.push(
          `COMPLETED run ${run.id} Completed event publishes unknown model ${publishedModelId}`
        );
      } else if (model.runId !== run.id) {
        problems.push(
          `COMPLETED run ${run.id} Completed event publishes model ${publishedModelId} which belongs to run ${model.runId}`
        );
      }
    }
    const lastEvent = events.at(-1);
    if (completed.length === 1 && lastEvent?.type !== "Completed") {
      problems.push(`COMPLETED run ${run.id} does not end on its Completed event`);
    }
  }

  for (const review of world.reviews) {
    if (review.result !== "REJECTED") continue;
    const model = modelsById.get(review.modelId);
    if (model === undefined) continue;
    const sourceRun = runsById.get(model.runId);
    if (sourceRun !== undefined && sourceRun.status !== "COMPLETED") {
      problems.push(
        `REJECTED model ${model.id} source run ${sourceRun.id} is ${sourceRun.status}, not COMPLETED`
      );
    }
  }

  return problems;
}

/**
 * Rule 2 (approval-pointer): a Revision's `currentApprovedModelId` is the
 * "current final pointer" and must equal the revision's unique latest valid
 * APPROVED review (valid = recorded after the model was generated), and must be
 * null when no valid approval exists. The report-time semantics (which model was
 * the latest approval at a report's creation instant) are validated separately
 * by `validateCostReports`.
 */
function validateApprovalPointers(world: MockWorld): string[] {
  const problems: string[] = [];
  const modelsById = new Map(world.models.map((model) => [model.id, model]));

  // revisionId -> modelId -> latest valid approvedAt.
  const revisionApprovals = new Map<string, Map<string, number>>();
  for (const review of world.reviews) {
    if (review.result !== "APPROVED") continue;
    const model = modelsById.get(review.modelId);
    if (model === undefined) continue;
    if (timestamp(review.createdAt) < timestamp(model.generatedAt)) continue;
    const approvals = revisionApprovals.get(model.revisionId) ?? new Map<string, number>();
    const previous = approvals.get(model.id) ?? -Infinity;
    if (timestamp(review.createdAt) > previous) {
      approvals.set(model.id, timestamp(review.createdAt));
    }
    revisionApprovals.set(model.revisionId, approvals);
  }

  for (const revision of world.revisions) {
    const approvals = revisionApprovals.get(revision.id) ?? new Map<string, number>();
    const pointer = revision.currentApprovedModelId;
    if (approvals.size === 0) {
      if (pointer !== null) {
        problems.push(
          `revision ${revision.id} has no valid APPROVED review but currentApprovedModelId is ${pointer}`
        );
      }
      continue;
    }
    let latestModelId: string | undefined;
    let latestTime = -Infinity;
    let tie = false;
    for (const [modelId, approvedAt] of approvals) {
      if (approvedAt > latestTime) {
        latestTime = approvedAt;
        latestModelId = modelId;
        tie = false;
      } else if (approvedAt === latestTime) {
        tie = true;
      }
    }
    if (tie) {
      problems.push(
        `revision ${revision.id} has multiple models approved at the latest instant ${new Date(latestTime).toISOString()}; current approved model is ambiguous`
      );
    } else if (pointer !== latestModelId) {
      problems.push(
        `revision ${revision.id} currentApprovedModelId ${pointer ?? "null"} does not match the unique latest valid approval ${latestModelId} at ${new Date(latestTime).toISOString()}`
      );
    }
  }

  return problems;
}

/**
 * Rule 3 (snapshot-freeze): a Run's input snapshot must freeze exactly the set
 * of Revision Facts and Modeling Feedback visible on the run's revision at the
 * run's creation instant. Bidirectional ID checks: every visible record must be
 * present in the snapshot and every present record must be visible (same
 * revision and createdAt <= run.createdAt); feedback references must point at
 * entities that belong to the same revision.
 */
function validateSnapshotFreeze(world: MockWorld): string[] {
  const problems: string[] = [];
  const modelsById = new Map(world.models.map((model) => [model.id, model]));
  const reviewsById = new Map(world.reviews.map((review) => [review.id, review]));

  for (const run of world.runs) {
    const snapshot = run.inputSnapshot;
    const createdAt = timestamp(run.createdAt);

    const visibleFacts = world.facts.filter(
      (fact) => fact.revisionId === run.revisionId && timestamp(fact.createdAt) <= createdAt
    );
    const snapshotFactIds = new Set(snapshot.revisionFacts.map((fact) => fact.id));
    for (const fact of visibleFacts) {
      if (!snapshotFactIds.has(fact.id)) {
        problems.push(
          `run ${run.id} snapshot at ${run.createdAt} is missing visible revision fact ${fact.id}`
        );
      }
    }
    for (const fact of snapshot.revisionFacts) {
      if (fact.revisionId !== run.revisionId) {
        problems.push(
          `run ${run.id} snapshot includes revision fact ${fact.id} of revision ${fact.revisionId}, not ${run.revisionId}`
        );
      }
      if (timestamp(fact.createdAt) > createdAt) {
        problems.push(
          `run ${run.id} snapshot includes future revision fact ${fact.id} at ${fact.createdAt}`
        );
      }
      if (!visibleFacts.some((candidate) => candidate.id === fact.id)) {
        problems.push(
          `run ${run.id} snapshot includes revision fact ${fact.id} not visible at ${run.createdAt}`
        );
      }
    }

    const visibleFeedback = world.feedback.filter(
      (entry) => entry.revisionId === run.revisionId && timestamp(entry.createdAt) <= createdAt
    );
    const snapshotFeedbackIds = new Set(snapshot.modelingFeedback.map((entry) => entry.id));
    for (const entry of visibleFeedback) {
      if (!snapshotFeedbackIds.has(entry.id)) {
        problems.push(
          `run ${run.id} snapshot at ${run.createdAt} is missing visible modeling feedback ${entry.id}`
        );
      }
    }
    for (const entry of snapshot.modelingFeedback) {
      if (entry.revisionId !== run.revisionId) {
        problems.push(
          `run ${run.id} snapshot includes modeling feedback ${entry.id} of revision ${entry.revisionId}, not ${run.revisionId}`
        );
      }
      if (timestamp(entry.createdAt) > createdAt) {
        problems.push(
          `run ${run.id} snapshot includes future modeling feedback ${entry.id} at ${entry.createdAt}`
        );
      }
      if (!visibleFeedback.some((candidate) => candidate.id === entry.id)) {
        problems.push(
          `run ${run.id} snapshot includes modeling feedback ${entry.id} not visible at ${run.createdAt}`
        );
      }
      // Review-derived feedback always references a Model and a Review on the
      // same revision; USER_SUPPLEMENT feedback (directly entered on the
      // Drawing workflow) carries neither and needs no reference check.
      if (entry.modelId !== undefined) {
        const model = modelsById.get(entry.modelId);
        if (model === undefined) {
          problems.push(`run ${run.id} snapshot feedback ${entry.id} references unknown model ${entry.modelId}`);
        } else if (model.revisionId !== run.revisionId) {
          problems.push(
            `run ${run.id} snapshot feedback ${entry.id} references model ${entry.modelId} of revision ${model.revisionId}, not ${run.revisionId}`
          );
        }
      }
      if (entry.reviewId !== undefined && !reviewsById.has(entry.reviewId)) {
        problems.push(`run ${run.id} snapshot feedback ${entry.id} references unknown review ${entry.reviewId}`);
      }
    }
  }

  return problems;
}

/**
 * Rule 15 (cross-revision): every Memory reference stays inside the owning
 * Revision, in the world and in every frozen Run input snapshot.
 *
 * Shared per-entity reference checks:
 *  - a Fact's `sourceRunId` (when present) must name a Run that exists and runs
 *    on the same revision as the Fact;
 *  - every Modeling Feedback must reference a Model and a Model Review that
 *    exist and belong to the feedback's revision, the review must name the same
 *    Model and must be REJECTED (feedback is modeling experience produced by a
 *    rejected review).
 *
 * At world level the owning revision is each record's own `revisionId`; at
 * snapshot level every referenced entity must belong to the Run's revision, so
 * a frozen snapshot can never leak a reference across revisions.
 */
function validateCrossRevisionReferences(world: MockWorld): string[] {
  const problems: string[] = [];
  const runsById = new Map(world.runs.map((run) => [run.id, run]));
  const modelsById = new Map(world.models.map((model) => [model.id, model]));
  const reviewsById = new Map(world.reviews.map((review) => [review.id, review]));

  const factSourceRunProblems = (fact: RevisionFact, label: string): string[] => {
    if (fact.sourceRunId === undefined) return [];
    const sourceRun = runsById.get(fact.sourceRunId);
    if (sourceRun === undefined) {
      return [`${label} references unknown source run ${fact.sourceRunId}`];
    }
    if (sourceRun.revisionId !== fact.revisionId) {
      return [
        `${label} of revision ${fact.revisionId} references source run ${fact.sourceRunId} of revision ${sourceRun.revisionId}`
      ];
    }
    return [];
  };

  const feedbackReferenceProblems = (
    entry: ModelingFeedback,
    expectedRevisionId: string,
    label: string
  ): string[] => {
    const out: string[] = [];
    // USER_SUPPLEMENT feedback is entered directly on the Drawing workflow and
    // carries no Model/Review reference; only review-derived feedback is
    // validated against the review source chain.
    if (entry.modelId === undefined && entry.reviewId === undefined) {
      return out;
    }
    const model = modelsById.get(entry.modelId ?? "");
    if (model === undefined) {
      out.push(`${label} references unknown model ${String(entry.modelId)}`);
    } else if (model.revisionId !== expectedRevisionId) {
      out.push(
        `${label} references model ${String(entry.modelId)} of revision ${model.revisionId}, not ${expectedRevisionId}`
      );
    }
    const review = reviewsById.get(entry.reviewId ?? "");
    if (review === undefined) {
      out.push(`${label} references unknown review ${String(entry.reviewId)}`);
    } else {
      if (review.modelId !== entry.modelId) {
        out.push(
          `${label} references review ${String(entry.reviewId)} of model ${review.modelId}, not ${String(entry.modelId)}`
        );
      }
      if (review.result !== "REJECTED") {
        out.push(
          `${label} references review ${String(entry.reviewId)} which is ${review.result}, not REJECTED`
        );
      }
    }
    return out;
  };

  // World-level references: the owning revision is each record's own revision.
  for (const fact of world.facts) {
    problems.push(...factSourceRunProblems(fact, `fact ${fact.id}`));
  }
  for (const entry of world.feedback) {
    problems.push(...feedbackReferenceProblems(entry, entry.revisionId, `feedback ${entry.id}`));
  }

  // Snapshot references: every referenced entity must belong to the Run's
  // revision (the snapshot already guarantees the record's own revision).
  for (const run of world.runs) {
    for (const fact of run.inputSnapshot.revisionFacts) {
      problems.push(
        ...factSourceRunProblems(fact, `run ${run.id} snapshot fact ${fact.id}`)
      );
    }
    for (const entry of run.inputSnapshot.modelingFeedback) {
      problems.push(
        ...feedbackReferenceProblems(
          entry,
          run.revisionId,
          `run ${run.id} snapshot feedback ${entry.id}`
        )
      );
    }
  }

  return problems;
}

/**
 * Rule 4 (cost-snapshot): every cost item frozen into a report's cost-data
 * snapshot must have been effective by the capture instant — `updatedAt <=
 * capturedAt` for every material/allowance/fixed-cost/custom-field and
 * `effectiveFrom <= capturedAt` for materials. A historical report can never
 * reference cost data that was updated after the report was captured.
 */
function validateCostSnapshotTimes(world: MockWorld): string[] {
  const problems: string[] = [];
  for (const report of world.reports) {
    const capturedAt = report.snapshot.input.capturedAt;
    const costData = report.snapshot.input.costData;
    const check = (label: string, value: string) => {
      if (timestamp(value) > timestamp(capturedAt)) {
        problems.push(
          `report ${report.id} cost snapshot ${label} ${value} is after capturedAt ${capturedAt}`
        );
      }
    };
    for (const material of costData.materials) {
      check(`material ${material.id} updatedAt`, material.updatedAt);
      check(`material ${material.id} effectiveFrom`, material.effectiveFrom);
    }
    for (const allowance of costData.allowances) {
      check(`allowance ${allowance.id} updatedAt`, allowance.updatedAt);
    }
    for (const fixedCost of costData.fixedCosts) {
      check(`fixedCost ${fixedCost.id} updatedAt`, fixedCost.updatedAt);
    }
    for (const custom of costData.customFields) {
      check(`customField ${custom.id} updatedAt`, custom.updatedAt);
    }
  }
  return problems;
}

/**
 * Full cross-entity causal chain: drawing <= revision <= run created <= run
 * completed <= model generated <= review <= report, plus clarification and
 * memory/feedback reference chains.
 */
function validateFullChain(world: MockWorld): string[] {
  const problems: string[] = [];
  const drawingsById = new Map(world.drawings.map((drawing) => [drawing.id, drawing]));
  const revisionsById = new Map(world.revisions.map((revision) => [revision.id, revision]));
  const runsById = new Map(world.runs.map((run) => [run.id, run]));
  const modelsById = new Map(world.models.map((model) => [model.id, model]));

  // drawing <= source uploaded <= revision created
  for (const revision of world.revisions) {
    const drawing = drawingsById.get(revision.drawingId);
    if (drawing === undefined) continue;
    if (timestamp(revision.createdAt) < timestamp(drawing.createdAt)) {
      problems.push(
        `revision ${revision.id} created ${revision.createdAt} before its drawing ${drawing.id} created ${drawing.createdAt}`
      );
    }
    if (timestamp(revision.sourceFile.uploadedAt) < timestamp(drawing.createdAt)) {
      problems.push(
        `revision ${revision.id} source uploaded ${revision.sourceFile.uploadedAt} before its drawing ${drawing.id} was created ${drawing.createdAt}`
      );
    }
    if (timestamp(revision.sourceFile.uploadedAt) > timestamp(revision.createdAt)) {
      problems.push(
        `revision ${revision.id} source uploaded ${revision.sourceFile.uploadedAt} after revision created ${revision.createdAt}`
      );
    }
  }

  // revision <= run created <= run started <= run completed
  for (const run of world.runs) {
    const revision = revisionsById.get(run.revisionId);
    if (revision === undefined) continue;
    if (revision.drawingId !== run.drawingId) {
      problems.push(
        `run ${run.id} drawing ${run.drawingId} does not match its revision ${revision.id} drawing ${revision.drawingId}`
      );
    }
    if (timestamp(run.createdAt) < timestamp(revision.createdAt)) {
      problems.push(
        `run ${run.id} created ${run.createdAt} before its revision ${revision.id} created ${revision.createdAt}`
      );
    }
    if (run.startedAt !== undefined && timestamp(run.createdAt) > timestamp(run.startedAt)) {
      problems.push(`run ${run.id} created ${run.createdAt} after it started ${run.startedAt}`);
    }
    if (run.startedAt !== undefined && run.completedAt !== undefined && timestamp(run.completedAt) < timestamp(run.startedAt)) {
      problems.push(`run ${run.id} completed ${run.completedAt} before it started ${run.startedAt}`);
    }
    if (
      run.inputSnapshot.revisionId !== run.revisionId ||
      run.inputSnapshot.drawingId !== run.drawingId ||
      run.inputSnapshot.originalFileRef !== revision.sourceFile.id
    ) {
      problems.push(`run ${run.id} inputSnapshot lineage does not match its drawing revision`);
    }
    if (timestamp(run.inputSnapshot.createdAt) !== timestamp(run.createdAt)) {
      problems.push(`run ${run.id} inputSnapshot was captured at ${run.inputSnapshot.createdAt}, not run creation ${run.createdAt}`);
    }
    for (const fact of run.inputSnapshot.revisionFacts) {
      if (timestamp(fact.createdAt) > timestamp(run.createdAt)) {
        problems.push(`run ${run.id} snapshot includes future revision fact ${fact.id}`);
      }
    }
    for (const feedback of run.inputSnapshot.modelingFeedback) {
      if (timestamp(feedback.createdAt) > timestamp(run.createdAt)) {
        problems.push(`run ${run.id} snapshot includes future modeling feedback ${feedback.id}`);
      }
    }
  }

  // run completed <= model generated (and model owned by its source run)
  for (const model of world.models) {
    const run = runsById.get(model.runId);
    if (run === undefined) continue;
    if (run.drawingId !== model.drawingId || run.revisionId !== model.revisionId) {
      problems.push(`model ${model.id} drawing/revision does not match its source run ${run.id}`);
    }
    if (run.completedAt !== undefined && timestamp(model.generatedAt) < timestamp(run.completedAt)) {
      problems.push(
        `model ${model.id} generated ${model.generatedAt} before its source run ${run.id} completed ${run.completedAt}`
      );
    }
    if (run.startedAt !== undefined && timestamp(model.generatedAt) < timestamp(run.startedAt)) {
      problems.push(
        `model ${model.id} generated ${model.generatedAt} before its source run ${run.id} started ${run.startedAt}`
      );
    }
  }

  // model generated <= review
  for (const review of world.reviews) {
    const model = modelsById.get(review.modelId);
    if (model === undefined) continue;
    if (timestamp(review.createdAt) < timestamp(model.generatedAt)) {
      problems.push(
        `review ${review.id} recorded ${review.createdAt} before its model ${model.id} generated ${model.generatedAt}`
      );
    }
  }

  // model generated <= review <= report + report structural chain
  for (const report of world.reports) {
    const model = modelsById.get(report.modelId);
    if (model === undefined) continue;
    const reportTime = timestamp(report.createdAt);
    if (timestamp(model.generatedAt) > reportTime) {
      problems.push(
        `report ${report.id} created ${report.createdAt} before its model ${model.id} generated ${model.generatedAt}`
      );
    }
    const run = runsById.get(model.runId);
    if (run !== undefined && run.completedAt !== undefined && timestamp(run.completedAt) > reportTime) {
      problems.push(
        `report ${report.id} created ${report.createdAt} before its model's source run ${run.id} completed ${run.completedAt}`
      );
    }
    for (const review of world.reviews) {
      if (review.modelId === model.id && review.result === "APPROVED" && timestamp(review.createdAt) > reportTime) {
        problems.push(
          `report ${report.id} created ${report.createdAt} before the approval review ${review.id} at ${review.createdAt}`
        );
      }
    }
    if (
      report.snapshot.input.drawingId !== report.drawingId ||
      report.snapshot.input.revisionId !== report.revisionId ||
      report.snapshot.input.modelId !== report.modelId ||
      report.snapshot.input.quantity !== report.quantity
    ) {
      problems.push(`report ${report.id} snapshot input lineage does not match the report`);
    }
    const snapshotMaterial = report.snapshot.input.costData.materials.find(
      (material) => material.id === report.snapshot.input.materialId
    );
    if (snapshotMaterial === undefined) {
      problems.push(`report ${report.id} snapshot is missing selected material ${report.snapshot.input.materialId}`);
    }
    if (report.snapshot.input.costData.capturedAt !== report.snapshot.input.capturedAt) {
      problems.push(`report ${report.id} cost-data snapshot was captured at ${report.snapshot.input.costData.capturedAt}, not ${report.snapshot.input.capturedAt}`);
    }
    if (
      report.snapshot.createdAt !== report.createdAt ||
      report.updatedAt !== report.createdAt ||
      report.snapshot.input.capturedAt !== report.createdAt ||
      report.snapshot.input.costData.capturedAt !== report.createdAt
    ) {
      problems.push(`report ${report.id} snapshot/updatedAt timestamps do not match createdAt`);
    }
  }

  // clarification chain: run exists, revision matches, request after run start
  for (const request of world.clarifications) {
    const run = runsById.get(request.runId);
    if (run === undefined) continue;
    if (run.revisionId !== request.revisionId) {
      problems.push(
        `clarification ${request.id} revision ${request.revisionId} does not match its run ${run.id} revision ${run.revisionId}`
      );
    }
    if (timestamp(request.createdAt) < timestamp(run.startedAt ?? run.createdAt)) {
      problems.push(
        `clarification ${request.id} created ${request.createdAt} before its run ${run.id} started ${run.startedAt ?? run.createdAt}`
      );
    }
    if (request.status === "ANSWERED" && request.answeredAt !== undefined && timestamp(request.answeredAt) < timestamp(request.createdAt)) {
      problems.push(
        `clarification ${request.id} answered ${request.answeredAt} before it was created ${request.createdAt}`
      );
    }
  }

  // memory/feedback chains: produced after the event that produced them
  for (const fact of world.facts) {
    if (fact.sourceRunId === undefined) continue;
    const run = runsById.get(fact.sourceRunId);
    if (run !== undefined && timestamp(fact.createdAt) < timestamp(run.createdAt)) {
      problems.push(
        `fact ${fact.id} created ${fact.createdAt} before its source run ${run.id} was created ${run.createdAt}`
      );
    }
  }
  for (const feedback of world.feedback) {
    const review = world.reviews.find((candidate) => candidate.id === feedback.reviewId);
    if (review !== undefined && timestamp(feedback.createdAt) < timestamp(review.createdAt)) {
      problems.push(
        `feedback ${feedback.id} created ${feedback.createdAt} before its review ${review.id} ${review.createdAt}`
      );
    }
  }

  return problems;
}

/**
 * Builds a report approval timeline from VALID APPROVED reviews only (a review
 * is valid when it is recorded after the model was generated), then checks that
 * every report references the unambiguous latest approved model of its revision
 * at its creation moment, and that the revision's current pointer is backed by
 * a real approval.
 */
function validateCostReports(world: MockWorld): string[] {
  const problems: string[] = [];
  const runsById = new Map(world.runs.map((run) => [run.id, run]));
  const modelsById = new Map(world.models.map((model) => [model.id, model]));
  const revisionsById = new Map(world.revisions.map((revision) => [revision.id, revision]));
  const drawingsById = new Map(world.drawings.map((drawing) => [drawing.id, drawing]));

  const revisionApprovals = new Map<string, Map<string, number>>();
  for (const review of world.reviews) {
    if (review.result !== "APPROVED") continue;
    const model = modelsById.get(review.modelId);
    if (model === undefined) continue;
    const approvedAt = timestamp(review.createdAt);
    if (approvedAt < timestamp(model.generatedAt)) {
      problems.push(
        `APPROVED review ${review.id} at ${review.createdAt} predates its model ${model.id} generation ${model.generatedAt}`
      );
      continue;
    }
    const revisionId = model.revisionId;
    const approvals = revisionApprovals.get(revisionId) ?? new Map<string, number>();
    const previous = approvals.get(model.id) ?? -Infinity;
    if (approvedAt > previous) approvals.set(model.id, approvedAt);
    revisionApprovals.set(revisionId, approvals);
  }

  // Every currentApprovedModelId pointer must be backed by a valid approval.
  for (const revision of world.revisions) {
    const pointer = revision.currentApprovedModelId;
    if (pointer === null) continue;
    const model = modelsById.get(pointer);
    if (model === undefined) {
      problems.push(`revision ${revision.id} points to unknown current approved model ${pointer}`);
      continue;
    }
    if (model.reviewStatus !== "APPROVED") {
      problems.push(`revision ${revision.id} current approved model ${pointer} is ${model.reviewStatus}`);
      continue;
    }
    if ((revisionApprovals.get(revision.id)?.get(pointer)) === undefined) {
      problems.push(`revision ${revision.id} current approved model ${pointer} has no valid APPROVED review`);
    }
  }

  // Same-time approval ambiguity on a revision makes the current model choice
  // explicit non-determinism and is therefore a violation.
  for (const [revisionId, approvals] of revisionApprovals) {
    const byTime = new Map<number, string[]>();
    for (const [modelId, approvedAt] of approvals) {
      const list = byTime.get(approvedAt) ?? [];
      list.push(modelId);
      byTime.set(approvedAt, list);
    }
    for (const [approvedAt, models] of byTime) {
      if (models.length > 1) {
        problems.push(
          `revision ${revisionId} models ${models.join(", ")} approved at the same instant ${new Date(approvedAt).toISOString()}; current approved model is ambiguous`
        );
      }
    }
  }

  for (const report of world.reports) {
    const reportTime = timestamp(report.createdAt);
    const model = modelsById.get(report.modelId);
    if (model === undefined) continue;
    if (model.reviewStatus !== "APPROVED") {
      problems.push(`report ${report.id} at ${report.createdAt} references non-approved model ${report.modelId}`);
      continue;
    }
    const revision = revisionsById.get(report.revisionId);
    const drawing = drawingsById.get(report.drawingId);
    if (revision === undefined || drawing === undefined) continue;
    if (revision.drawingId !== report.drawingId || model.revisionId !== report.revisionId || model.drawingId !== report.drawingId) {
      problems.push(`report ${report.id} drawing/revision/model are inconsistent`);
      continue;
    }
    if (drawing.currentRevisionId !== report.revisionId) {
      problems.push(`report ${report.id} targets non-current revision ${report.revisionId}`);
      continue;
    }
    const approvals = revisionApprovals.get(report.revisionId) ?? new Map<string, number>();
    const modelApprovedAt = approvals.get(report.modelId);
    if (modelApprovedAt === undefined) {
      problems.push(`report ${report.id} at ${report.createdAt} references model ${report.modelId} with no valid APPROVED review`);
      continue;
    }
    if (reportTime < modelApprovedAt) {
      problems.push(
        `report ${report.id} at ${report.createdAt} predates its model ${report.modelId} approval at ${new Date(modelApprovedAt).toISOString()}`
      );
      continue;
    }
    let latestModelId: string | undefined;
    let latestTime = -Infinity;
    let tie = false;
    for (const [candidateId, candidateTime] of approvals) {
      if (candidateTime > reportTime) continue;
      if (candidateTime > latestTime) {
        latestTime = candidateTime;
        latestModelId = candidateId;
        tie = false;
      } else if (candidateTime === latestTime) {
        tie = true;
      }
    }
    if (latestModelId !== report.modelId || tie) {
      problems.push(
        `report ${report.id} at ${report.createdAt} references model ${report.modelId} which is not the unambiguous latest approved model of ${revision.id} (latest ${latestModelId ?? "none"})`
      );
      continue;
    }
    const sourceRun = runsById.get(model.runId);
    if (sourceRun !== undefined && sourceRun.completedAt !== undefined && reportTime < timestamp(sourceRun.completedAt)) {
      problems.push(
        `report ${report.id} at ${report.createdAt} predates its model's source run ${sourceRun.id} completion`
      );
    }
  }
  return problems;
}

/** Every entity id must be unique within its kind; runEvents keys own their events. */
function validateUniqueIds(world: MockWorld): string[] {
  const problems: string[] = [];
  const checkUnique = (kind: string, ids: readonly string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`duplicate ${kind} id ${id}`);
      seen.add(id);
    }
  };
  checkUnique("drawing", world.drawings.map((drawing) => drawing.id));
  checkUnique("revision", world.revisions.map((revision) => revision.id));
  checkUnique("run", world.runs.map((run) => run.id));
  checkUnique("model", world.models.map((model) => model.id));
  checkUnique("review", world.reviews.map((review) => review.id));
  checkUnique("clarification", world.clarifications.map((request) => request.id));
  checkUnique("artifact", world.artifacts.map((artifact) => artifact.id));
  checkUnique("fact", world.facts.map((fact) => fact.id));
  checkUnique("feedback", world.feedback.map((entry) => entry.id));
  checkUnique("report", world.reports.map((report) => report.id));

  const runIds = new Set(world.runs.map((run) => run.id));
  for (const run of world.runs) {
    if (!(run.id in world.runEvents)) {
      problems.push(`run ${run.id} has no runEvents entry`);
    }
  }
  for (const [key, events] of Object.entries(world.runEvents)) {
    if (!runIds.has(key)) {
      problems.push(`runEvents has an entry for unknown run ${key}`);
      continue;
    }
    for (const event of events) {
      if (event.runId !== key) {
        problems.push(`run ${key} event seq ${event.sequence} has runId ${event.runId}`);
      }
    }
  }

  const modelIds = new Set(world.models.map((model) => model.id));
  const reviewIds = new Set(world.reviews.map((review) => review.id));
  for (const model of world.models) {
    if (!runIds.has(model.runId)) problems.push(`model ${model.id} references unknown source run ${model.runId}`);
  }
  for (const review of world.reviews) {
    if (!modelIds.has(review.modelId)) problems.push(`review ${review.id} references unknown model ${review.modelId}`);
  }
  for (const artifact of world.artifacts) {
    if (!runIds.has(artifact.runId)) problems.push(`artifact ${artifact.id} references unknown run ${artifact.runId}`);
    if (artifact.modelId !== undefined && !modelIds.has(artifact.modelId)) {
      problems.push(`artifact ${artifact.id} references unknown model ${artifact.modelId}`);
    }
  }
  for (const fact of world.facts) {
    if (fact.sourceRunId !== undefined && !runIds.has(fact.sourceRunId)) {
      problems.push(`fact ${fact.id} references unknown source run ${fact.sourceRunId}`);
    }
  }
  for (const feedback of world.feedback) {
    // Review-derived feedback must name a real Model/Review; USER_SUPPLEMENT
    // feedback entered on the Drawing workflow carries neither.
    if (feedback.modelId !== undefined && !modelIds.has(feedback.modelId)) {
      problems.push(`feedback ${feedback.id} references unknown model ${feedback.modelId}`);
    }
    if (feedback.reviewId !== undefined && !reviewIds.has(feedback.reviewId)) {
      problems.push(`feedback ${feedback.id} references unknown review ${feedback.reviewId}`);
    }
  }
  for (const report of world.reports) {
    if (!modelIds.has(report.modelId)) problems.push(`report ${report.id} references unknown model ${report.modelId}`);
  }
  return problems;
}

/** Every timestamp across every entity must parse to a finite number. */
function validateFiniteTimes(world: MockWorld): string[] {
  const problems: string[] = [];
  const check = (label: string, value: string) => {
    if (!isFiniteTime(value)) {
      problems.push(`${label} has non-finite timestamp ${JSON.stringify(value)}`);
    }
  };

  for (const drawing of world.drawings) {
    check(`drawing ${drawing.id} createdAt`, drawing.createdAt);
    check(`drawing ${drawing.id} updatedAt`, drawing.updatedAt);
  }
  for (const revision of world.revisions) {
    check(`revision ${revision.id} createdAt`, revision.createdAt);
    check(`revision ${revision.id} updatedAt`, revision.updatedAt);
    check(`revision ${revision.id} source uploadedAt`, revision.sourceFile.uploadedAt);
  }
  for (const run of world.runs) {
    check(`run ${run.id} createdAt`, run.createdAt);
    if (run.startedAt !== undefined) check(`run ${run.id} startedAt`, run.startedAt);
    if (run.completedAt !== undefined) check(`run ${run.id} completedAt`, run.completedAt);
    check(`run ${run.id} snapshot createdAt`, run.inputSnapshot.createdAt);
    for (const fact of run.inputSnapshot.revisionFacts) {
      check(`run ${run.id} snapshot fact ${fact.id} createdAt`, fact.createdAt);
    }
    for (const feedback of run.inputSnapshot.modelingFeedback) {
      check(`run ${run.id} snapshot feedback ${feedback.id} createdAt`, feedback.createdAt);
    }
  }
  for (const model of world.models) {
    check(`model ${model.id} generatedAt`, model.generatedAt);
  }
  for (const review of world.reviews) {
    check(`review ${review.id} createdAt`, review.createdAt);
  }
  for (const request of world.clarifications) {
    check(`clarification ${request.id} createdAt`, request.createdAt);
    if (request.answeredAt !== undefined) check(`clarification ${request.id} answeredAt`, request.answeredAt);
    for (const answer of request.answers) {
      check(`clarification ${request.id} answer ${answer.id} answeredAt`, answer.answeredAt);
    }
  }
  for (const fact of world.facts) {
    check(`fact ${fact.id} createdAt`, fact.createdAt);
  }
  for (const feedback of world.feedback) {
    check(`feedback ${feedback.id} createdAt`, feedback.createdAt);
  }
  for (const artifact of world.artifacts) {
    check(`artifact ${artifact.id} createdAt`, artifact.createdAt);
  }
  for (const report of world.reports) {
    check(`report ${report.id} createdAt`, report.createdAt);
    check(`report ${report.id} updatedAt`, report.updatedAt);
    check(`report ${report.id} snapshot createdAt`, report.snapshot.createdAt);
    check(`report ${report.id} snapshot capturedAt`, report.snapshot.input.capturedAt);
    check(`report ${report.id} costData capturedAt`, report.snapshot.input.costData.capturedAt);
    for (const material of report.snapshot.input.costData.materials) {
      check(`report ${report.id} material ${material.id} updatedAt`, material.updatedAt);
      check(`report ${report.id} material ${material.id} effectiveFrom`, material.effectiveFrom);
    }
    for (const allowance of report.snapshot.input.costData.allowances) {
      check(`report ${report.id} allowance ${allowance.id} updatedAt`, allowance.updatedAt);
    }
    for (const fixedCost of report.snapshot.input.costData.fixedCosts) {
      check(`report ${report.id} fixedCost ${fixedCost.id} updatedAt`, fixedCost.updatedAt);
    }
    for (const custom of report.snapshot.input.costData.customFields) {
      check(`report ${report.id} customField ${custom.id} updatedAt`, custom.updatedAt);
    }
  }
  for (const definition of world.costData.definitions) {
    check(`costData definition ${definition.id} updatedAt`, definition.updatedAt);
  }
  for (const material of world.costData.materials) {
    check(`costData material ${material.id} updatedAt`, material.updatedAt);
    check(`costData material ${material.id} effectiveFrom`, material.effectiveFrom);
  }
  for (const allowance of world.costData.allowances) {
    check(`costData allowance ${allowance.id} updatedAt`, allowance.updatedAt);
  }
  for (const fixedCost of world.costData.fixedCosts) {
    check(`costData fixedCost ${fixedCost.id} updatedAt`, fixedCost.updatedAt);
  }
  for (const custom of world.costData.customFields) {
    check(`costData customField ${custom.id} updatedAt`, custom.updatedAt);
  }
  for (const [runId, events] of Object.entries(world.runEvents)) {
    for (const event of events) {
      check(`run ${runId} event seq ${event.sequence} occurredAt`, event.occurredAt);
    }
  }
  return problems;
}

/**
 * Execution intervals of every executed (non-QUEUED) Run must be globally
 * non-overlapping. A RUNNING Run has no end yet (open interval).
 */
function validateRunIntervals(world: MockWorld): string[] {
  const problems: string[] = [];
  const executed = world.runs.filter((run) => run.status !== "QUEUED");
  for (let i = 0; i < executed.length; i += 1) {
    const a = executed[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < executed.length; j += 1) {
      const b = executed[j];
      if (b === undefined) continue;
      const aStart = timestamp(a.startedAt ?? a.createdAt);
      const bStart = timestamp(b.startedAt ?? b.createdAt);
      const aEnd = a.status === "RUNNING" ? Number.POSITIVE_INFINITY : (a.completedAt !== undefined ? timestamp(a.completedAt) : aStart);
      const bEnd = b.status === "RUNNING" ? Number.POSITIVE_INFINITY : (b.completedAt !== undefined ? timestamp(b.completedAt) : bStart);
      if (aEnd < aStart || bEnd < bStart) continue; // malformed interval is reported by run-lifecycle
      if (Math.max(aStart, bStart) < Math.min(aEnd, bEnd)) {
        problems.push(
          `runs ${a.id} [${a.startedAt ?? a.createdAt}, ${a.completedAt ?? "now"}] and ${b.id} [${b.startedAt ?? b.createdAt}, ${b.completedAt ?? "now"}] overlap`
        );
      }
    }
  }
  return problems;
}

/**
 * Audits one scenario world. Independent of every other scenario, so each
 * scenario can be validated and reported in isolation.
 */
export function auditScenario(scenario: MockScenario, world: MockWorld): TimelineAudit {
  const violations: TimelineViolation[] = [];
  const push = (rule: TimelineViolation["rule"], message: string) => {
    violations.push({ rule, scenario, message });
  };

  const runsById = new Map(world.runs.map((run) => [run.id, run]));

  // 1. Per-Run event sequence / occurredAt monotonicity.
  for (const [runId, events] of Object.entries(world.runEvents)) {
    let previousSequence = 0;
    let previousTime = -Infinity;
    let previousOccurredAt: string | undefined;
    for (const event of events) {
      if (event.sequence <= previousSequence) {
        push(
          "event-order",
          `run ${runId} event sequence ${event.sequence} is not strictly increasing (previous ${previousSequence})`
        );
      }
      const time = timestamp(event.occurredAt);
      if (time < previousTime) {
        push(
          "event-order",
          `run ${runId} event at ${event.occurredAt} precedes the previous event at ${previousOccurredAt ?? "?"}`
        );
      }
      previousSequence = event.sequence;
      previousTime = time;
      previousOccurredAt = event.occurredAt;
    }
  }

  // 2. Run lifecycle: every run's events replay into its recorded status.
  for (const run of world.runs) {
    const events = world.runEvents[run.id] ?? [];
    for (const message of validateRunLifecycle(run, events)) {
      push("run-lifecycle", message);
    }
  }

  // 3. R05 exact stage chain in every scenario that features R05.
  const r05 = runsById.get("run-main-r05");
  if (r05 !== undefined) {
    for (const message of validateR05Causality(scenario, r05, world.runEvents[r05.id] ?? [])) {
      push("r05-variants", message);
    }
  }

  // 4. REJECTED reviews are recorded after their source Run completed.
  for (const message of validateRejectSource(world)) {
    push("reject-source", message);
  }

  // 5. Every Model is produced by a COMPLETED source Run and every COMPLETED
  // Run publishes exactly one Model via one last Completed event.
  for (const message of validateModelSource(world)) {
    push("model-source", message);
  }

  // 6. Sole RUNNING + no RUNNING run may overlap a completed R05. QUEUED runs
  // are created any time and simply wait, so only RUNNING runs are constrained.
  const running = world.runs.filter((run) => run.status === "RUNNING");
  if (running.length > 1) {
    push(
      "sole-running",
      `world has ${running.length} RUNNING runs: ${running.map((run) => run.id).join(", ")}`
    );
  }
  if (r05 !== undefined && r05.status === "COMPLETED") {
    const r05Done = timestamp(r05.completedAt ?? r05.createdAt);
    for (const run of world.runs) {
      if (run.id === r05.id || run.status !== "RUNNING") continue;
      const runStart = timestamp(run.startedAt ?? run.createdAt);
      if (runStart < r05Done) {
        push(
          "sole-running",
          `run ${run.id} is RUNNING from ${run.startedAt ?? run.createdAt} while R05 was still unfinished (R05 completed at ${r05.completedAt})`
        );
      }
    }
  }

  // 7. Cost reports depend on the then-current approved model.
  for (const message of validateCostReports(world)) {
    push("cost-reports", message);
  }

  // 8. Every Revision pointer equals the unique latest valid approval (or null).
  for (const message of validateApprovalPointers(world)) {
    push("approval-pointer", message);
  }

  // 9. Cost snapshots freeze only cost data effective by the capture instant.
  for (const message of validateCostSnapshotTimes(world)) {
    push("cost-snapshot", message);
  }

  // 10. Full cross-entity causal chain.
  for (const message of validateFullChain(world)) {
    push("timeline", message);
  }

  // 11. Run snapshots exactly freeze the visible facts/feedback at run creation.
  for (const message of validateSnapshotFreeze(world)) {
    push("snapshot-freeze", message);
  }

  // 12. Entity id uniqueness and runEvents ownership.
  for (const message of validateUniqueIds(world)) {
    push("unique-ids", message);
  }

  // 13. Every timestamp parses to a finite number.
  for (const message of validateFiniteTimes(world)) {
    push("finite-times", message);
  }

  // 14. Executed Run intervals are globally non-overlapping.
  for (const message of validateRunIntervals(world)) {
    push("run-intervals", message);
  }

  // 15. Memory references (world and snapshots) never cross revisions.
  for (const message of validateCrossRevisionReferences(world)) {
    push("cross-revision", message);
  }

  return { scenario, violations };
}

/**
 * Audits every canonical scenario. `scenarios` may be narrowed (for example to
 * a single scenario) to keep a test failure close to the broken seed.
 */
export function auditAllScenarios(
  scenarios: readonly MockScenario[],
  buildWorld: (scenario: MockScenario) => MockWorld = buildScenario
): TimelineAudit[] {
  return scenarios.map((scenario) => auditScenario(scenario, buildWorld(scenario)));
}

/**
 * Aggregates every violation across an audit run, in deterministic order.
 * Returns an empty array when the fixture timeline is fully self-consistent.
 */
export function collectViolations(audits: readonly TimelineAudit[]): TimelineViolation[] {
  const out: TimelineViolation[] = [];
  for (const audit of audits) {
    out.push(...audit.violations);
  }
  return out;
}

/**
 * Adapter so the reusable validator also works against a live Mock Repository
 * world (the post-command world the UI observes), without re-implementing the
 * checks on a second data model.
 */
export function auditMockRepository(
  repository: { getSnapshot(): MockWorld },
  scenario: MockScenario
): TimelineAudit {
  return auditScenario(scenario, repository.getSnapshot());
}

// ---- Cross-entity helper predicates kept here so tests can reuse the same
// definitions that the audit rules are built from. ----

/** True when a model is the revision's current approved model. */
export function isCurrentApprovedModelOf(revision: DrawingRevision, modelId: string): boolean {
  return revision.currentApprovedModelId === modelId;
}

/** True when every event carries a strictly increasing sequence. */
export function hasStrictlyIncreasingSequence(events: readonly RunEvent[]): boolean {
  let previous = 0;
  for (const event of events) {
    if (event.sequence <= previous) return false;
    previous = event.sequence;
  }
  return true;
}
