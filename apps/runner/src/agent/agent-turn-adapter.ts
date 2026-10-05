import type { ClarificationQuestion } from "@swpanel/domain";
import type { ArtifactDefect } from "../artifacts/result-artifact-set.js";
import type { AgentSessionRecord } from "./codex/agent-session.js";
import type { RawAgentRecord } from "./raw-agent-records.js";

/**
 * The structural shape of a legacy SYNCHRONOUS result adapter (the Phase 4
 * `RawAgentAdapter` of `fake-agent-adapter.ts` — deliberately not imported
 * from there so this seam module stays dependency-free of the fake).
 */
export interface SyncResultAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocol: string;
  readonly protocolVersion: string;
  /** Deterministic session thread identity of one Run. */
  threadIdFor(runId: string): string;
  produceResult(input: AgentResultInput): readonly RawAgentRecord[];
}
/**
 * Async Agent turn seam (Phase 5, P5-3). One `runTurn` invocation performs the
 * whole Agent result turn of one Run attempt and settles with the discriminated
 * terminal outcome (the technical raw record stream the executor must
 * translate — the SAME raw record protocol (Phase 4, P4-3) the deterministic
 * Fake Agent Adapter emits, so the shared translator / validator /
 * publication path is adapter-agnostic — plus, for a clarification outcome,
 * the strictly validated structured question set).
 *
 * Unlike the synchronous legacy result adapter (which stays for Phase 4
 * compatibility), the turn adapter is Promise-based because a real runtime
 * turn is asynchronous, and it MAY expose an optional cooperative
 * `interruptTurn` the executor's cancellation flow calls BEFORE its bounded
 * wait: the running turn is asked to stop, the bounded wait stays the safety
 * net for adapters that ignore the interrupt (a turn that ignores the
 * interrupt settles through its own timeout instead).
 *
 * The strict NDJSON client, child transport and adapter are repository-tested,
 * and real HIL has exercised technical failure paths. Successful CAD modeling,
 * a real engineering clarification and ownership-safe cancellation remain
 * unverified; see `codex/` and the Phase 5 engineering status documents.
 */

/** The minimal write surface the turn adapter persists its files through. */
export interface AgentWorkspace {
  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): {
    relativePath: string;
    absolutePath: string;
    sha256: string;
    sizeBytes: number;
  };
}

/** The Phase 4 result input every Agent result turn starts from. */
export interface AgentResultInput {
  runId: string;
  attemptId: string;
  attemptSequence: number;
  workspace: AgentWorkspace;
  nowIso: () => string;
  /** MP4 recording was requested for this attempt. */
  recordMp4: boolean;
  /** Test-harness defect injection into the produced result set (fake only). */
  resultDefect?: ArtifactDefect;
  /**
   * Test-harness terminal-state injection (fake only): when true the fake
   * adapter settles the turn with the `clarification` outcome instead of a
   * completed result set — runtime raw records WITHOUT any manifest claim and
   * WITHOUT any `clarification_requested` record (the ClarificationRequired
   * product event is owned by the orchestrator). Ignored by real adapters.
   */
  produceClarification?: boolean;
}

/**
 * Content-free live activity of a running turn (fixed counters only — never
 * commands, paths, reasoning or output text). Delivered best-effort and
 * unthrottled; the consumer decides how often to publish it.
 */
export interface AgentActivityUpdate {
  commandCount: number;
  fileChangeCount: number;
  toolCount: number;
  messageCount: number;
}

/** The frozen inputs of ONE Agent result turn (superset of the Phase 4 result input). */
export interface AgentTurnInput extends AgentResultInput {
  /** Absolute attempt-workspace root the runtime may write into (its ONLY writable root). */
  workspaceRoot: string;
  /** The controlled rendered prompt text of the attempt. */
  promptText: string;
  /** Absolute path of the derived Skill input image of the attempt. */
  localImageAbsolutePath: string;
  /** Skill the turn must invoke: frozen name + resolved absolute path. */
  skill: {
    name: string;
    resolvedPath: string;
  };
  /**
   * Prior technical session of the same Run (a previously completed attempt's
   * thread) to RESUME, or null / absent for a FRESH thread. The adapter never
   * trusts the raw record: the session is strictly validated before any
   * `thread/resume` is attempted.
   */
  priorSession?: AgentSessionRecord | null;
  /** Optional live activity observer of the running turn; must never throw into the turn. */
  onActivity?: (update: AgentActivityUpdate) => void;
}

/** The identity of the turn a cooperative interrupt must target. */
export interface AgentInterruptInput {
  runId: string;
  attemptId: string;
}

/** Stable structured turn failure the executor maps onto Run failure codes. */
export const AGENT_TURN_ERROR_CODES = [
  "AGENT_TIMEOUT",
  "AGENT_PROTOCOL_INCOMPATIBLE",
  "AGENT_INTERRUPTED",
  "AGENT_RUNTIME_UNAVAILABLE"
] as const;
export type AgentTurnErrorCode = (typeof AGENT_TURN_ERROR_CODES)[number];

/**
 * Typed Agent turn failure. Every code is a REAL `@swpanel/domain` Run failure
 * code, so the executor maps the turn failure onto the accurate terminal
 * classification without inventing new codes:
 *
 * - `AGENT_TIMEOUT` — the turn did not complete within the bounded wait (the
 *   runtime request / turn wait timed out);
 * - `AGENT_PROTOCOL_INCOMPATIBLE` — malformed wire messages, malformed or
 *   contract-invalid final Agent Turn Output document (0 / multiple /
 *   malformed), incomplete turn input or an RPC error on the used protocol
 *   subset;
 * - `AGENT_INTERRUPTED` — the runtime reported the turn as interrupted
 *   (usually after a cooperative `turn/interrupt`);
 * - `AGENT_RUNTIME_UNAVAILABLE` — the runtime process exited / reported a
 *   failed turn, so no result can ever arrive.
 *
 * The failure message never carries raw reasoning content — the UI only ever
 * sees the structured code through the orchestrator's generic message.
 */
export class AgentTurnError extends Error {
  readonly code: AgentTurnErrorCode;
  /** Optional SANITIZED (redacted, bounded) diagnostic that is safe to show to the user. */
  readonly detail: string | undefined;

  constructor(code: AgentTurnErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "AgentTurnError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Discriminated terminal outcome of ONE Agent result turn (Phase 5): the
 * adapter settles with EXACTLY one of the two legal terminal states of the
 * versioned Agent Turn Output contract —
 *
 * - `completed` — the turn produced the technical raw records (ending
 *   `result_manifest`) and the manifest claim the independent validator must
 *   verify;
 * - `clarification` — the turn produced runtime raw records (metadata +
 *   turn, WITHOUT any `result_manifest` and WITHOUT any
 *   `clarification_requested` record: the ClarificationRequired product event
 *   is owned by the orchestrator's `clarifyAttempt`, never duplicated from raw
 *   content) and the strictly validated structured question set the
 *   orchestrator persists.
 */
export type AgentTurnOutcome =
  | { kind: "completed"; records: readonly RawAgentRecord[] }
  | {
      kind: "clarification";
      records: readonly RawAgentRecord[];
      questions: readonly ClarificationQuestion[];
    };

/**
 * Async Agent turn adapter of one Run attempt. `runTurn` MUST settle with the
 * discriminated {@link AgentTurnOutcome} (translator-compatible raw records) or
 * throw a structured {@link AgentTurnError} — never raw runtime output.
 * `interruptTurn` is optional and best-effort: the executor's bounded wait is
 * the safety net.
 */
export interface AgentTurnAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocol: string;
  readonly protocolVersion: string;
  /** Deterministic session thread identity of one Run (technical only). */
  threadIdFor(runId: string): string;
  /** Performs ONE Agent result turn and settles with the discriminated outcome. */
  runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome>;
  /**
   * Cooperative interruption of the in-flight turn of the given Run attempt.
   * Absent on adapters without an interruptible runtime (the executor's
   * bounded wait is the safety net). Best-effort: a throw never blocks the
   * cancellation flow.
   */
  interruptTurn?(input: AgentInterruptInput): Promise<void>;
  /**
   * Releases the adapter's owned runtime resources (e.g. the live Codex child
   * process and its stdio pipes). Absent on adapters without owned resources.
   * Idempotent; safe once the last turn settled — the executor calls it from
   * its `stop()` when it OWNS the adapter (`FakeExecutorOptions.ownsAgent`),
   * whether or not a queue loop ever started, so an eagerly spawned runtime
   * is never orphaned and a caller-injected adapter stays open for reuse.
   */
  close?(): void;
}

/**
 * Normalizes either adapter surface onto the async {@link AgentTurnAdapter}
 * seam: a legacy synchronous result adapter is wrapped so its `produceResult`
 * settles as an immediately-resolved `completed` outcome (deterministic
 * behavior and existing Phase 4 tests are preserved byte-for-byte; a legacy
 * adapter only ever claims completion, never clarification).
 */
export function toAgentTurnAdapter(agent: SyncResultAdapter | AgentTurnAdapter): AgentTurnAdapter {
  if ("runTurn" in agent) {
    return agent;
  }
  return {
    adapterId: agent.adapterId,
    adapterVersion: agent.adapterVersion,
    protocol: agent.protocol,
    protocolVersion: agent.protocolVersion,
    threadIdFor: (runId) => agent.threadIdFor(runId),
    runTurn: (input) =>
      Promise.resolve({ kind: "completed", records: agent.produceResult(input) })
  };
}
