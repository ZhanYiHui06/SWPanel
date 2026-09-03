import type { ClarificationQuestion } from "@swpanel/domain";
import {
  produceSyntheticResultArtifactSet
} from "../artifacts/result-artifact-set.js";
import {
  RAW_AGENT_RECORDS_VERSION,
  RAW_AGENT_LOG_RELATIVE_PATH,
  type RawAgentRecord
} from "./raw-agent-records.js";
import {
  buildAgentSessionRecord,
  writeAgentSessionRecord
} from "./codex/agent-session.js";
import type {
  AgentInterruptInput,
  AgentResultInput,
  AgentTurnAdapter,
  AgentTurnInput,
  AgentTurnOutcome
} from "./agent-turn-adapter.js";

export {
  RAW_AGENT_LOG_RELATIVE_PATH,
  RAW_AGENT_SESSION_RELATIVE_PATH
} from "./raw-agent-records.js";

export type { AgentWorkspace, AgentResultInput } from "./agent-turn-adapter.js";

/**
 * Fake Agent Adapter (Phase 4, P4-3 + P4-5): the deterministic stand-in for a
 * real Agent runtime. It produces the technical raw record stream of one
 * attempt's result turn AND the synthetic result artifact set + versioned
 * Result Manifest in the attempt output workspace. Raw records and logs are
 * technical-only: they are written into the `logs/` / `runtime/` workspace
 * dirs and never enter the UI event stream directly — the translator derives
 * the validated Product Events.
 *
 * The adapter is deterministic per Run: the same run/attempt always yields the
 * same thread identity, the same raw records and the same artifact bytes. A
 * test harness may inject an {@link ArtifactDefect} so the produced set fails
 * the independent validation gate end to end.
 *
 * Phase 5 (P5-3): the fake ALSO implements the async {@link AgentTurnAdapter}
 * seam — `runTurn` settles with the SAME deterministic `produceResult` records
 * wrapped in a `completed` outcome (existing behavior/tests unchanged), or with
 * the deterministic `clarification` outcome when the terminal-state harness
 * requests it; `interruptTurn` is a no-op because the fake turn is
 * instantaneous and nothing is ever in flight.
 */

/** The raw Agent surface the executor drives for the result phase. */
export interface RawAgentAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocol: string;
  readonly protocolVersion: string;
  /** Deterministic session thread identity of one Run. */
  threadIdFor(runId: string): string;
  /**
   * Produces the deterministic result of one attempt: writes the synthetic
   * artifact set, the manifest and the technical raw logs into the attempt
   * workspace, then returns the raw records the executor must translate.
   */
  produceResult(input: AgentResultInput): readonly RawAgentRecord[];
}

export const FAKE_AGENT_ADAPTER_ID = "codex-app-server" as const;
export const FAKE_AGENT_ADAPTER_VERSION = "0.1.0" as const;
export const FAKE_AGENT_PROTOCOL = "codex-app-server" as const;
export const FAKE_AGENT_PROTOCOL_VERSION = "1" as const;

/**
 * The SolidWorks version the synthetic fixture records as the one it actually
 * used (the local installation at the time of this batch). The preflight gate
 * and Result Manifest contract are version-agnostic — the recorded value is
 * whatever the builder actually used, never a required release.
 */
export const FAKE_AGENT_SOLIDWORKS_VERSION = "2025" as const;

/**
 * Deterministic clarification questions the fake adapter raises when the
 * terminal-state harness requests a clarification turn. The SAME question set
 * the fake executor's clarification scenario persists through the orchestrator.
 */
export const FAKE_CLARIFICATION_QUESTIONS: readonly ClarificationQuestion[] = [
  {
    id: "dimension",
    type: "dimension",
    question: "底板厚度是多少？",
    hint: "例如 12",
    unit: "mm"
  },
  {
    id: "weld-treatment",
    type: "choice",
    question: "焊缝处理方式？",
    options: [
      { id: "none", label: "无需焊缝" },
      { id: "full", label: "全周满焊" }
    ]
  }
];

/**
 * Deterministic Fake Agent Adapter of the Phase 4 protocol chain. The result
 * turn always emits `metadata_updated` -> `turn_completed` -> `result_manifest`
 * (all at the same instant), writes the technical raw log + session snapshot,
 * and produces the synthetic artifacts whose manifest the independent
 * validator must accept — unless a defect makes the set false.
 */
export class FakeAgentAdapter implements RawAgentAdapter, AgentTurnAdapter {
  readonly adapterId = FAKE_AGENT_ADAPTER_ID;
  readonly adapterVersion = FAKE_AGENT_ADAPTER_VERSION;
  readonly protocol = FAKE_AGENT_PROTOCOL;
  readonly protocolVersion = FAKE_AGENT_PROTOCOL_VERSION;

  threadIdFor(runId: string): string {
    return `thread-${runId}`;
  }

  produceResult(input: AgentResultInput): readonly RawAgentRecord[] {
    const { runId, attemptId, attemptSequence, workspace, nowIso, recordMp4, resultDefect } = input;
    const threadId = this.threadIdFor(runId);
    const occurredAt = nowIso();

    // 1. Synthetic result artifact set + versioned Result Manifest (P4-5).
    const set = produceSyntheticResultArtifactSet({
      runId,
      attemptSequence,
      recordMp4,
      solidWorksVersion: FAKE_AGENT_SOLIDWORKS_VERSION,
      ...(resultDefect === undefined ? {} : { defect: resultDefect }),
      adapterId: this.adapterId,
      adapterVersion: this.adapterVersion
    });

    // 2. The adapter's raw records of the result turn (technical stream).
    const records: readonly RawAgentRecord[] = [
      {
        recordVersion: RAW_AGENT_RECORDS_VERSION,
        type: "metadata_updated",
        occurredAt,
        threadId,
        adapterId: this.adapterId,
        adapterVersion: this.adapterVersion,
        protocol: this.protocol,
        protocolVersion: this.protocolVersion,
        modelId: this.adapterId,
        modelSupportsImageInput: true
      },
      {
        recordVersion: RAW_AGENT_RECORDS_VERSION,
        type: "turn_completed",
        occurredAt,
        threadId,
        turnId: `turn-${runId}-1`,
        summary: "fake deterministic builder turn (technical only)"
      },
      {
        recordVersion: RAW_AGENT_RECORDS_VERSION,
        type: "result_manifest",
        occurredAt,
        threadId,
        manifestRef: set.manifestRef
      }
    ];

    // 3. Write the manifest + artifacts, then the technical-only raw logs.
    for (const file of set.files) {
      workspace.writeOwnedFile({
        runId,
        attemptSequence,
        relativePath: file.relativePath,
        content: file.content
      });
    }
    workspace.writeOwnedFile({
      runId,
      attemptSequence,
      relativePath: RAW_AGENT_LOG_RELATIVE_PATH,
      content: Buffer.from(
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
        "utf8"
      )
    });
    // 4. Technical session snapshot through the shared session store (P5-3):
    //    strictly validated / redacted — only technical fields, never raw
    //    reasoning content, prompt text or absolute host paths.
    writeAgentSessionRecord(workspace, {
      runId,
      attemptSequence,
      record: buildAgentSessionRecord({
        threadId,
        status: "completed",
        adapterId: this.adapterId,
        adapterVersion: this.adapterVersion,
        protocol: this.protocol,
        protocolVersion: this.protocolVersion,
        nowIso,
        attemptId,
        note: "technical session snapshot, never a product event"
      })
    });
    return records;
  }

  runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
    // The deterministic fake turn is instantaneous. The terminal-state harness
    // may ask for the clarification outcome; otherwise the async seam settles
    // with exactly the Phase 4 synchronous completed result (behavior
    // unchanged).
    if (input.produceClarification === true) {
      return Promise.resolve(this.produceClarification(input));
    }
    return Promise.resolve({ kind: "completed", records: this.produceResult(input) });
  }

  /**
   * The deterministic clarification terminal state (fake only): runtime raw
   * records (metadata + turn, WITHOUT any `result_manifest` claim and WITHOUT
   * any `clarification_requested` record — the ClarificationRequired product
   * event is owned by the orchestrator's `clarifyAttempt`, never duplicated
   * from raw content), the technical raw log + session snapshot (no manifest,
   * no artifact set) and the structured question set.
   */
  private produceClarification(input: AgentTurnInput): Extract<AgentTurnOutcome, { kind: "clarification" }> {
    const { runId, attemptId, attemptSequence, workspace, nowIso } = input;
    const threadId = this.threadIdFor(runId);
    const occurredAt = nowIso();

    // The technical raw records of a clarification turn: NO result_manifest,
    // NO clarification_requested — the orchestrator owns the terminal event.
    const records: readonly RawAgentRecord[] = [
      {
        recordVersion: RAW_AGENT_RECORDS_VERSION,
        type: "metadata_updated",
        occurredAt,
        threadId,
        adapterId: this.adapterId,
        adapterVersion: this.adapterVersion,
        protocol: this.protocol,
        protocolVersion: this.protocolVersion,
        modelId: this.adapterId,
        modelSupportsImageInput: true
      },
      {
        recordVersion: RAW_AGENT_RECORDS_VERSION,
        type: "turn_completed",
        occurredAt,
        threadId,
        turnId: `turn-${runId}-1`,
        summary: "fake deterministic clarification turn (technical only)"
      }
    ];

    // Technical-only raw log (path-contained; never a product event).
    workspace.writeOwnedFile({
      runId,
      attemptSequence,
      relativePath: RAW_AGENT_LOG_RELATIVE_PATH,
      content: Buffer.from(
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
        "utf8"
      )
    });
    // Technical session snapshot: the turn completed WITHOUT a manifest claim —
    // recorded truthfully, never as a failed or interrupted session.
    writeAgentSessionRecord(workspace, {
      runId,
      attemptSequence,
      record: buildAgentSessionRecord({
        threadId,
        status: "completed",
        adapterId: this.adapterId,
        adapterVersion: this.adapterVersion,
        protocol: this.protocol,
        protocolVersion: this.protocolVersion,
        nowIso,
        attemptId,
        note: "turn completed with a clarification request; no Result Manifest was claimed"
      })
    });
    return { kind: "clarification", records, questions: FAKE_CLARIFICATION_QUESTIONS };
  }

  interruptTurn(_input: AgentInterruptInput): Promise<void> {
    void _input;
    // Nothing is ever in flight: the fake turn resolves immediately.
    return Promise.resolve();
  }
}
