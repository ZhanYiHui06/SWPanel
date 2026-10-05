import type {
  FakeExecutorScenario,
  InputAdapterResult,
  InputAdapterScenario,
  PreflightCheckItem,
  PreflightReport,
  PreflightScenario,
  RunAttempt,
  RunEventPayload,
  RunFailureCode,
  RunStage
} from "@swpanel/domain";
import { isLeaseExpired, isRunTerminal } from "@swpanel/domain";
import { Phase4ContractError, type InvocationPackage } from "@swpanel/contracts";

import { InvalidArgumentError, NotFoundError, RunnerInvariantError } from "../errors.js";
import { RunRepository } from "../db/run-repository.js";
import {
  LiveForeignLeaseError,
  RunOrchestrator,
  type RecoveryScanResult
} from "../orchestration/run-orchestrator.js";
import type { RunWorkspaceLayout, StoredRunFile } from "../ledger/run-workspace-ledger.js";
import {
  FakeAgentAdapter,
  type RawAgentAdapter
} from "../agent/fake-agent-adapter.js";
import {
  AgentTurnError,
  toAgentTurnAdapter,
  type AgentTurnAdapter,
  type AgentActivityUpdate,
  type AgentTurnInput,
  type AgentTurnOutcome
} from "../agent/agent-turn-adapter.js";
import {
  readAgentSessionRecord,
  type AgentSessionRecord
} from "../agent/codex/agent-session.js";
import { isPinnedThreadSessionProtocol } from "./recovery/thread-session-recovery.js";
import { join } from "node:path";
import {
  translateRawAgentRecords,
  RAW_PROTOCOL_FAILURE_CODE
} from "../agent/product-event-translator.js";
import type { ArtifactDefect } from "../artifacts/result-artifact-set.js";
import { ArtifactValidator } from "../artifacts/artifact-validator.js";
import {
  FakeInputAdapter,
  mapInputAdapterFailureCode,
  type InputAdapter,
  type InputAdapterSource
} from "../adaptation/input-adapter.js";
import {
  buildPreflightReport,
  FakePreflightProbe,
  isConsistentEnvironmentResult,
  mapPreflightFailureCode,
  PreflightGate,
  type Preflight,
  type PreflightEnvironmentResult,
  type PreflightProbeContext
} from "../preflight/preflight.js";
import { buildInvocationPackage } from "../adaptation/invocation-package.js";
import { renderPrompt } from "../adaptation/prompt-template.js";
import { redactSensitivePaths } from "../adaptation/path-redaction.js";
import {
  isOwnedCloseSafeForCancellation,
  type CloseOnlyOwnedOutcome,
  type OwnershipRecord,
  type SnapshotOwnershipInput
} from "./ownership/solidworks-ownership-guard.js";
import { readSolidWorksOwnershipRegistry } from "./ownership/solidworks-ownership-registry.js";

export type { CancelQueuedRunRequest, CancelRunAttemptRequest } from "../orchestration/run-orchestrator.js";

/** A scheduled unit of work of the Fake Executor; cancel() removes it. */
export interface ScheduledTask {
  cancel(): void;
}

/**
 * Phase 5 (P5-4): the ownership-safe SolidWorks cancellation surface injected
 * into the executor. {@link SolidWorksOwnershipGuard} satisfies it; a narrower
 * adapter or a test stub may too. `snapshotRecord` returns the frozen record of
 * the identities the current attempt attested (null when the integration has no
 * record for the pair); `closeOnlyOwned` closes EXACTLY the proven identities
 * of that record — the closer underneath only ever sees individually attested
 * identities, and no "kill all SLDWORKS.exe" style path exists on this surface
 * by construction (see `solidworks-ownership-guard.ts`).
 */
export interface SolidWorksOwnershipSurface {
  snapshotRecord(input: SnapshotOwnershipInput): OwnershipRecord | null;
  closeOnlyOwned(record: OwnershipRecord): CloseOnlyOwnedOutcome;
}

/**
 * Injectible scheduler of the Fake Executor. The production default schedules
 * on the wall clock (`TimerExecutorScheduler`); tests inject a deterministic
 * manual scheduler that runs tasks only when the test flushes it. A scheduler
 * may expose its own clock (`now`) so the orchestrator and the executor share
 * one deterministic timeline.
 */
export interface ExecutorScheduler {
  schedule(fn: () => void, delayMs: number): ScheduledTask;
  /** Deterministic clock the scheduler advances; wall-clock schedulers omit it. */
  now?: () => Date;
}

/** Wall-clock scheduler used by the production default. */
export class TimerExecutorScheduler implements ExecutorScheduler {
  schedule(fn: () => void, delayMs: number): ScheduledTask {
    const handle = setTimeout(fn, Math.max(0, delayMs));
    return { cancel: () => clearTimeout(handle) };
  }
}

/**
 * The isolated attempt workspace surface the executor and the cancel cleanup
 * touch. `RunWorkspaceLedger` satisfies it; tests may stub `deleteAttemptWorkspace`
 * to exercise the cleanup-failure policy.
 */
export interface AttemptWorkspace {
  createAttemptWorkspace(runId: string, attemptSequence: number): RunWorkspaceLayout;
  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): StoredRunFile;
  /**
   * Independent read surface of one attempt-scoped file (Phase 4, P4-5): the
   * Artifact validator reads the Agent's manifest + artifacts ONLY through
   * this guard, which refuses unsafe paths and symlink/junction escapes.
   */
  readOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): (StoredRunFile & { content: Buffer }) | null;
  deleteAttemptWorkspace(runId: string, attemptSequence: number): void;
}

export interface FakeExecutorOptions {
  orchestrator: RunOrchestrator;
  runs: RunRepository;
  /** Isolated per-attempt workspace; cancel cleanup only touches it. */
  workspace: AttemptWorkspace;
  /**
   * Deterministic scenario matrix selection. ONLY Runner construction / test
   * harness configuration may choose a scenario — the production Renderer and
   * IPC payloads never carry one; the normal product path is the default
   * `success` scenario.
   */
  scenario?: FakeExecutorScenario;
  /** Shared deterministic clock (defaults to the scheduler's / wall clock). */
  now?: () => Date;
  scheduler?: ExecutorScheduler;
  /** Bounded wait for a cooperative stop during RUNNING cancellation. */
  cooperativeStopTimeoutMs?: number;
  /**
   * Phase 5 (P5-4): the ownership-safe SolidWorks cancellation boundary.
   * Absent (default) keeps cancellation exactly as before — this executor
   * never closes any SolidWorks identity. When injected, the RUNNING cancel
   * flow closes ONLY the proven identities of the current attempt (between
   * the cooperative-stop wait and the workspace cleanup); an unproven /
   * partial / failed / thrown close routes through the existing
   * cleanup-failure policy (FAILED / CANCEL_CLEANUP_PENDING, never
   * CANCELLED). A live foreign lease never reaches the surface.
   */
  ownership?: SolidWorksOwnershipSurface | null;
  /**
   * Wall-clock delay between scenario steps in milliseconds (default 0).
   * Deterministic E2E test harnesses may slow the default `success` script so
   * the UI can observe every stage transition live; the production product
   * path and unit tests keep the default instant steps.
   */
  stepDelayMs?: number;
  /**
   * Raw Agent adapter of the result phase (Phase 4, P4-3): produces the
   * technical raw record stream + synthetic artifacts/manifest. Phase 5
   * (P5-3): the async {@link AgentTurnAdapter} seam is preferred; a legacy
   * synchronous {@link RawAgentAdapter} is wrapped so existing behavior/tests
   * remain deterministic. Defaults to the deterministic {@link FakeAgentAdapter}.
   */
  agent?: RawAgentAdapter | AgentTurnAdapter;
  /**
   * Batch C lifecycle: EXPLICIT ownership of the configured agent adapter.
   * `true` — this executor owns the adapter and `stop()` closes it (releasing
   * its runtime resources: a live Codex child process is terminated, bounded
   * and idempotent, never orphaned) EVEN when the queue loop never started —
   * an eagerly spawned transport must never survive the executor. `false`
   * (the default for a caller-INJECTED adapter) — the CALLER owns the adapter
   * lifecycle: `stop()` never closes it, so a caller-injected (possibly
   * shared / reused across Runner open-close cycles) adapter stays open for
   * reuse. The executor-created default FakeAgentAdapter is always owned by
   * the executor (its close is a harmless no-op).
   */
  ownsAgent?: boolean;
  /**
   * Phase 5 (P5-3): the resolved absolute path of the modeling Skill the turn
   * must invoke. The fake executor has NO skill resolver (external
   * `$solidworks-build-mechanical-models` resolution remains a later batch) —
   * the turn input carries this injected value verbatim; the production
   * default is empty and only the fake adapter (which ignores it) is used.
   */
  skillResolvedPath?: string;
  /**
   * Independent artifact validator gating completion (Phase 4, P4-5).
   * Defaults to a validator over this executor's attempt workspace.
   */
  artifactValidator?: ArtifactValidator;
  /**
   * The authoritative SolidWorks version the Runner attests for the attempt
   * (e.g. the live SolidWorks probe snapshot of the Desktop main live branch).
   * A non-empty value is handed to the DEFAULT artifact validator, which then
   * fails the Result Manifest closed (`ARTIFACT_MANIFEST_INVALID`, before any
   * artifact read) unless the Agent's `solidWorksVersion` EXACTLY equals it,
   * and is rendered into the controlled prompt so the Agent records the exact
   * version instead of guessing. Absent (or empty) keeps the version-agnostic
   * synthetic/default behavior unchanged; an INJECTED artifact validator is
   * authoritative and never receives this value.
   */
  expectedSolidWorksVersion?: string;
  /**
   * MP4 recording was requested for the attempt: the processMp4 artifact
   * becomes required by the result manifest. Defaults to false.
   */
  recordMp4?: boolean;
  /**
   * Phase 5 (P5-2): when true the success path publishes a PENDING_REVIEW
   * Model atomically through `publishModelPublication` (Model + artifact
   * metadata rows + Completed event with the Model id + FINISHED attempt in
   * ONE transaction). Defaults to FALSE so legacy isolated scenarios/tests
   * keep the Phase 3/4 model-less completion; the Runner product path enables
   * it explicitly when product expectations (e2e) are updated.
   */
  publishModel?: boolean;
  /**
   * Phase 4 (P4-1): the injected deterministic Input Adapter boundary. Runs at
   * PREPARING: it converts the immutable original drawing into the Skill input
   * image + provenance inside the attempt workspace (the original file is never
   * modified) and fails the Run closed on any structured conversion failure.
   * Absent by default at this level; the Runner injects it (or a scenario).
   */
  inputAdapter?: InputAdapter | null;
  /**
   * Scenario convenience (test-only configuration, mirrors `scenario`): builds
   * the deterministic {@link FakeInputAdapter}. Ignored when `inputAdapter` is
   * provided.
   */
  inputAdapterScenario?: InputAdapterScenario;
  /**
   * Resolves the immutable original source file of a Run (metadata + absolute
   * path). Absent or `null` result means the source cannot be resolved and the
   * attempt fails closed with `INPUT_ADAPTER_FAILED` when an adapter is active.
   */
  resolveInputSource?: ((runId: string) => InputAdapterSource | null) | null;
  /**
   * Phase 5 (P5-1): the injected preflight gate. Runs at PREPARING BEFORE the
   * Input Adapter: the eight environment capabilities are probed fail-fast and
   * `input_adapter_succeeded` is marked true only AFTER the adaptation
   * succeeds; any failure terminates the attempt with the accurate code and
   * the redacted report is persisted at `runtime/preflight-report.json`.
   * Absent by default at this level; the Runner always injects the gate (or a
   * scenario) so the product path cannot leave PREPARING ungated. A gate
   * requires an active Input Adapter — without adaptation the ninth item could
   * never be marked truthfully.
   */
  preflight?: Preflight | null;
  /**
   * Scenario convenience (test-only configuration, mirrors `scenario`): builds
   * the deterministic {@link PreflightGate} over {@link FakePreflightProbe}.
   * Ignored when `preflight` is provided.
   */
  preflightScenario?: PreflightScenario;
}

/**
 * Outcome of one `cancelRun` call. Terminal repeat behaviour is stable:
 * cancelling an already-CANCELLED Run returns `alreadyCancelled: true` without
 * touching history; a cleanup failure returns FAILED with
 * `CANCEL_CLEANUP_PENDING` and NEVER falsely claims a full cancellation; a
 * foreign-owned attempt with a still-valid lease returns the explicit
 * `CANCEL_PENDING` outcome (the cancellation stays requested, the attempt and
 * its workspace are untouched — a live foreign lease is never stolen); a
 * RUNNING Run that reached its OWN terminal state (COMPLETED /
 * CLARIFICATION_REQUIRED / FAILED) during the cooperative wait returns the
 * stable `ALREADY_TERMINAL` outcome — the cancellation is never confirmed, no
 * ownership is closed and no workspace is cleaned (the terminal Run owns its
 * output), and the persisted CancellationRequested stays the truthful trace.
 */
export type CancelRunResult =
  | { runId: string; status: "CANCELLED"; alreadyCancelled: boolean }
  | { runId: string; status: "FAILED"; failureCode: "CANCEL_CLEANUP_PENDING" }
  | {
      runId: string;
      status: "CANCEL_PENDING";
      detail: "FOREIGN_LIVE_LEASE";
      leaseDeadlineAt: string | null;
    }
  | {
      runId: string;
      status: "ALREADY_TERMINAL";
      finalStatus: "COMPLETED" | "CLARIFICATION_REQUIRED" | "FAILED";
    };

/** Internal signal: the scenario stops without a terminal event (crash / interrupted). */
class ExecutorInterruptedSignal extends Error {
  constructor() {
    super("the Fake Executor stopped without a terminal event (crash / interruption)");
    this.name = "ExecutorInterruptedSignal";
  }
}

/**
 * Internal control-flow marker: the PREPARING input preparation already
 * terminated the attempt (adapter / package failure was written atomically
 * through the orchestrator), so the stage walk must stop without touching the
 * now-terminal attempt again.
 */
class PreparationTerminatedSignal extends Error {
  constructor() {
    super("input preparation terminated the attempt at PREPARING");
    this.name = "PreparationTerminatedSignal";
  }
}

/** One claim's cooperative-stop token: the cancel flow flips it, steps honor it. */
interface CancelToken {
  requested: boolean;
}

/** Wake-up slack after the earliest lease deadline (lease expiry is inclusive). */
const RECOVERY_WAKEUP_EPSILON_MS = 1 as const;

/**
 * Bounded idle re-check interval after a recovery scan that left an
 * immediately-expired blocker unresolved: a CancellationRequested RUNNING Run
 * awaiting its explicit cancel retry, or a scan that failed on a candidate /
 * wedged run (SCAN_FAILED). The recovery scan leaves such runs untouched, so
 * their expired lease / wedged slot would otherwise make the idle loop re-scan
 * instantly on the same past deadline forever — one bounded wait before the
 * next reconsideration instead (a cancel settling the Run still wakes the loop
 * through the recovery signal).
 */
const RECOVERY_RESCAN_WAIT_MS = 60_000 as const;

/** Default bounded wait for the executor to stop its current claim. */
const DEFAULT_COOPERATIVE_STOP_TIMEOUT_MS = 5_000 as const;

/** Canonical user-visible activity wording emitted per stage. */
const STAGE_ACTIVITIES: Readonly<Record<RunStage, string>> = {
  PREPARING: "准备建模任务",
  ANALYZING: "分析图纸",
  PLANNING: "规划建模方案",
  MODELING: "SolidWorks 建模中",
  VALIDATING: "校验模型",
  PACKAGING: "生成结果"
};

/** Shown while a real agent turn runs (no fake per-stage progress is published meanwhile). */
const LIVE_AGENT_ACTIVITY = "Codex 正在分析图纸并建模，可能需要几分钟";

const LIVE_PROGRESS_FLOOR = 20 as const;
const LIVE_PROGRESS_CEILING = 90 as const;
/** Observed runtime events at which ~63% of the floor-to-ceiling range is reached. */
const LIVE_PROGRESS_SCALE = 150 as const;
const LIVE_PROGRESS_MIN_INTERVAL_MS = 2_000 as const;

/** The six user-visible stages walked in order by the success path. */
const ALL_STAGES: readonly RunStage[] = [
  "PREPARING",
  "ANALYZING",
  "PLANNING",
  "MODELING",
  "VALIDATING",
  "PACKAGING"
];

/**
 * First-class deterministic Fake Executor / coordinator of Phase 3 (Batch
 * P3-3). It is the ONLY consumer of the serial queue in this batch:
 *
 * - claims Runs serially through the atomic orchestrator claim (exactly one
 *   RUNNING Run globally; one unfinished attempt per owner), or continues the
 *   ACTIVE attempt the recovery scan re-issued to this owner;
 * - creates the isolated `runs/{runId}/attempt-NNN/...` workspace per attempt;
 * - emits ordered stage / activity / progress events referencing the ACTIVE
 *   attempt and renews the attempt lease while working;
 * - ends every scenario through the atomic orchestrator terminal operations
 *   (`completeAttempt` / `failAttempt` / `clarifyAttempt` / `cancelAttempt`).
 *
 * Phase 4 (P4-3 + P4-5) wires the result phase into every successful walk: the
 * raw Agent adapter produces the synthetic artifacts + versioned Result
 * Manifest and the technical raw logs; the translator derives the validated
 * product events (`RuntimeMetadataUpdated` / `AgentTurnCompleted` /
 * `ResultManifestReceived`); the INDEPENDENT artifact validator gates
 * `completeAttempt` — an Agent claim of completion is never authoritative.
 * Rejections append `ArtifactValidationFailed` with the accurate code and fail
 * with the pinned terminal code (missing/zero-byte/hash -> VALIDATION_REJECTED,
 * manifest/path/rebuild -> their accurate code); raw protocol incompatibilities
 * fail with `AGENT_PROTOCOL_INCOMPATIBLE` without exposing raw reasoning.
 *
 * Scenario selection happens ONLY through construction configuration (Runner
 * config / test harness); the production default is `success`, which completes
 * through all six stages without creating a Model.
 *
 * Cancellation semantics (`cancelRun`):
 * - QUEUED: cancelled atomically without any normal execution claim — a
 *   cancellation-scoped persisted attempt carries the cancellation pair, no
 *   stage event, no workspace, no Model;
 * - RUNNING: `CancellationRequested` is persisted FIRST (exactly once — a
 *   concurrent or retried cancel shares the in-flight outcome and never
 *   appends a second request event), the current claim is signalled to abort
 *   cooperatively (a scripted hang settles through the same signal), the
 *   in-flight Agent turn is asked to interrupt (P5-3), the executor is awaited
 *   (bounded — the timeout is the safety net; F2: a timeout result rechecks
 *   the claim slot once in the same tick before declaring the stop failed),
 *   the authoritative active attempt is re-read and re-validated against the
 *   captured one (F1: a foreign takeover — no longer the same ACTIVE attempt,
 *   or a now-LIVE foreign lease — returns the stable CANCEL_PENDING outcome
 *   before ANY destructive step; Phase 5 makes this re-validation ATOMIC: the
 *   cancel seizes the cleanup ownership of the exact RUNNING Run + ACTIVE
 *   attempt with a fresh lease BEFORE the destructive steps, so a takeover
 *   between the re-check and the cleanup can no longer be followed by an
 *   ownership close / workspace deletion of the now-foreign attempt — either
 *   the fence wins (the attempt holds our live lease) or the fence throws the
 *   live foreign lease and the stable pending outcome is returned), the injected ownership surface closes ONLY
 *   the proven SolidWorks identities of the current attempt (P5-4, between
 *   the stop wait and the workspace cleanup), only the allowlisted current
 *   Run/attempt generated files are cleaned, and finally
 *   `CancellationConfirmed` + attempt CANCELLED are written atomically;
 * - cleanup failure NEVER claims a full cancellation: the Run fails with
 *   `CANCEL_CLEANUP_PENDING` and the attempt is INTERRUPTED (never CANCELLED);
 *   an ownership close that is unproven / partial / failed / thrown is such a
 *   cleanup failure (a cancellation is never confirmed while a SolidWorks
 *   identity of the attempt may still be live), and a stale foreign-owned
 *   attempt is re-owned safely inside that transaction;
 * - a foreign-owned attempt with a still-VALID lease is never stolen: the
 *   cancellation stays requested and the explicit `CANCEL_PENDING` outcome is
 *   returned without touching the attempt or its workspace;
 * - a RUNNING Run that reaches its OWN terminal state while the claim is being
 *   stopped (a turn that completed despite the cancel) is never confirmed as a
 *   cancellation: the stable `ALREADY_TERMINAL` outcome is returned (the
 *   terminal Run owns its output; nothing is closed or cleaned);
 * - an unexpected interruption (crash, close, lease expiry) is never written
 *   as CANCELLED: it stays FAILED / INTERRUPTED through the recovery scan.
 *
 * Ongoing recovery while the Runner is open (`runQueue`): whenever the loop is
 * idle (nothing claimable), it schedules a lease-deadline-aware recovery
 * wake-up at the earliest ACTIVE lease deadline and reconsiders every expired
 * attempt / wedged Run exactly then — never a busy loop. A quick restart
 * inside a lease and an in-process lease expiry therefore recover and unblock
 * the queue automatically. `stop()` is awaitable and settles the queue-loop
 * promise (the in-flight claim unwinds as an unexpected interruption).
 */
export class FakeExecutor {
  private readonly orchestrator: RunOrchestrator;
  private readonly runs: RunRepository;
  private readonly workspace: AttemptWorkspace;
  private readonly scenario: FakeExecutorScenario;
  private readonly scheduler: ExecutorScheduler;
  private readonly cooperativeStopTimeoutMs: number;
  private readonly stepDelayMs: number;
  private readonly now: () => Date;
  private readonly agent: AgentTurnAdapter;
  private readonly ownsAgent: boolean;
  /**
   * True when a REAL agent (explicitly handed over, e.g. live Codex) does the
   * work. The scripted stage walk would then announce every stage — and 100%
   * progress — before the agent has done anything, so only the genuine local
   * preparation step is announced and the agent turn runs behind an honest
   * "in progress" activity.
   */
  private readonly liveAgent: boolean;
  private readonly skillResolvedPath: string;
  private readonly artifactValidator: ArtifactValidator;
  private readonly expectedSolidWorksVersion: string;
  private readonly recordMp4: boolean;
  private readonly publishModel: boolean;
  private readonly inputAdapter: InputAdapter | null;
  private readonly preflight: Preflight | null;
  private readonly resolveInputSource: ((runId: string) => InputAdapterSource | null) | null;
  private readonly ownership: SolidWorksOwnershipSurface | null;

  private stopped = false;
  private queueLoop: Promise<void> | null = null;
  private stopSignal: Promise<void> = Promise.resolve();
  private resolveStopSignal: () => void = () => {};
  /** Fires when a cancel settles a blocking attempt, waking an idle recovery wait. */
  private wakeRecovery: (() => void) | null = null;
  private inflightCancels = new Map<string, Promise<CancelRunResult>>();
  /**
   * Incident scenarios (hang / crash / recovery-*) simulate ONE deterministic
   * incident per executor instance: after the incident ran (or the Run was
   * recovered / cancelled), later claims of the same queue loop behave like
   * the default success script, so the queue can genuinely proceed.
   */
  private incidentConsumed = false;
  private activeClaim: {
    runId: string;
    attemptId: string;
    attemptSequence: number;
    token: CancelToken;
    /** Resolves the scripted hang of the current claim (cancel / stop settle it). */
    resolveHang: () => void;
  } | null = null;
  private claimDone: Promise<void> | null = null;

  constructor(options: FakeExecutorOptions) {
    this.orchestrator = options.orchestrator;
    this.runs = options.runs;
    this.workspace = options.workspace;
    this.scenario = options.scenario ?? "success";
    this.scheduler = options.scheduler ?? new TimerExecutorScheduler();
    this.cooperativeStopTimeoutMs =
      options.cooperativeStopTimeoutMs ?? DEFAULT_COOPERATIVE_STOP_TIMEOUT_MS;
    this.stepDelayMs = options.stepDelayMs ?? 0;
    this.now = options.now ?? this.scheduler.now ?? (() => new Date());
    // The async turn seam is the single result path (P5-3): a legacy
    // synchronous RawAgentAdapter is wrapped with an immediately-resolved
    // runTurn, so Phase 4 behavior is preserved deterministically.
    this.agent = toAgentTurnAdapter(options.agent ?? new FakeAgentAdapter());
    // Batch C lifecycle ownership: the executor owns the adapter it created
    // itself (the default FakeAgentAdapter) and any adapter the caller
    // EXPLICITLY handed over; a caller-injected adapter without `ownsAgent`
    // stays caller-owned so it can be reused across Runner open/close cycles.
    this.ownsAgent = options.ownsAgent === true || options.agent === undefined;
    this.liveAgent = options.ownsAgent === true && options.agent !== undefined;
    this.skillResolvedPath = options.skillResolvedPath ?? "";
    this.expectedSolidWorksVersion = options.expectedSolidWorksVersion ?? "";
    // The independent validator reads the attempt workspace through the same
    // guarded surface the executor writes (the ledger satisfies both). The
    // attested expected version (non-empty only) is handed to the DEFAULT
    // validator; an injected validator is authoritative and never receives it.
    this.artifactValidator =
      options.artifactValidator ??
      new ArtifactValidator(this.workspace, {
        now: this.now,
        ...(this.expectedSolidWorksVersion.length === 0
          ? {}
          : { expectedSolidWorksVersion: this.expectedSolidWorksVersion })
      });
    this.recordMp4 = options.recordMp4 ?? false;
    this.publishModel = options.publishModel ?? false;
    this.resolveInputSource = options.resolveInputSource ?? null;
    this.inputAdapter =
      options.inputAdapter ??
      (options.inputAdapterScenario === undefined
        ? null
        : new FakeInputAdapter({ scenario: options.inputAdapterScenario, now: this.now }));
    this.preflight =
      options.preflight ??
      (options.preflightScenario === undefined
        ? null
        : new PreflightGate(new FakePreflightProbe({ scenario: options.preflightScenario })));
    if (this.preflight !== null && this.inputAdapter === null) {
      throw new InvalidArgumentError(
        "a preflight gate requires an inputAdapter: input_adapter_succeeded can only be marked after the adaptation succeeds"
      );
    }
    this.ownership = options.ownership ?? null;
  }

  /** True while the serial queue loop is running. */
  get isRunning(): boolean {
    return this.queueLoop !== null;
  }

  /**
   * Starts (or re-enters) the serial queue loop. One claim runs to its
   * terminal event at a time; the promise resolves when the queue drains (no
   * QUEUED Run and no future lease deadline to wait for) or the executor is
   * stopped. While idle the loop schedules lease-deadline-aware recovery
   * wake-ups (never a busy loop), so expired attempts / wedged Runs recover
   * automatically. Re-entrant: a second call while running returns the same
   * in-flight promise.
   */
  runQueue(): Promise<void> {
    if (this.queueLoop !== null) return this.queueLoop;
    this.stopped = false;
    let resolveStop: () => void = () => {};
    this.stopSignal = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    this.resolveStopSignal = resolveStop;
    const loop = this.runLoop();
    this.queueLoop = loop.finally(() => {
      if (this.queueLoop === loop) this.queueLoop = null;
    });
    return this.queueLoop;
  }

  /**
   * Stops the queue loop and settles its promise: the stop signal unwinds the
   * loop at its current await (step tick, idle recovery wake-up or scripted
   * hang) and the in-flight claim is aborted cooperatively WITHOUT a terminal
   * event — exactly an unexpected interruption, which recovery classifies as
   * FAILED / INTERRUPTED, never CANCELLED. Awaitable: the returned promise
   * settles when the queue loop settles.
   *
   * Batch C lifecycle: an OWNED agent adapter's runtime resources are released
   * (`close`) whether or not a queue loop ever started — a live Codex child
   * process spawned eagerly by the transport is terminated (bounded,
   * idempotent) instead of orphaned, even when the executor never ran a
   * single claim. A caller-injected adapter WITHOUT explicit ownership
   * (`ownsAgent: true`) is never closed by the executor — it stays open for
   * reuse across Runner open/close cycles (the recovery model reopens and
   * resumes the same adapter).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.resolveStopSignal();
    if (this.activeClaim !== null) {
      this.activeClaim.token.requested = true;
      this.activeClaim.resolveHang();
    }
    await (this.queueLoop ?? Promise.resolve());
    if (this.ownsAgent) {
      this.agent.close?.();
    }
  }

  /**
   * Cancels one Run with the explicit semantics above. QUEUED Runs cancel
   * atomically without execution; RUNNING Runs persist CancellationRequested
   * first, signal the cooperative abort, wait (bounded), clean the allowlisted
   * attempt workspace and confirm atomically. A RUNNING Run that reaches its
   * own terminal state during the wait resolves the stable `ALREADY_TERMINAL`
   * outcome instead of an error. Repeats on a CANCELLED Run are stable;
   * cancelling COMPLETED / CLARIFICATION_REQUIRED / FAILED Runs is a
   * structured error. Never creates a Model.
   */
  async cancelRun(runId: string, reason?: string): Promise<CancelRunResult> {
    const run = this.runs.getRun(runId);
    if (run === null) {
      throw new NotFoundError(`Run ${runId} was not found`, { runId });
    }
    if (run.status === "CANCELLED") {
      return { runId, status: "CANCELLED", alreadyCancelled: true };
    }
    if (isRunTerminal(run.status)) {
      throw new RunnerInvariantError(
        `Run ${runId} is ${run.status}; only QUEUED or RUNNING Runs can be cancelled`,
        { runId, status: run.status }
      );
    }
    if (run.status === "QUEUED") {
      try {
        this.orchestrator.cancelQueuedRun({
          runId,
          ...(reason === undefined ? {} : { reason }),
          finishedAt: this.nowIso()
        });
      } catch (error) {
        if (error instanceof LiveForeignLeaseError) {
          return this.pendingForeignLeaseOutcome(runId);
        }
        throw error;
      }
      this.signalRecoveryWake();
      return { runId, status: "CANCELLED", alreadyCancelled: false };
    }
    // RUNNING: concurrent / retried cancels are serialized — a second caller
    // shares the in-flight outcome and exactly one CancellationRequested is
    // ever persisted per Run.
    const inflight = this.inflightCancels.get(runId);
    if (inflight !== undefined) return inflight;
    const started = this.performRunningCancel(runId, reason);
    this.inflightCancels.set(runId, started);
    try {
      return await started;
    } finally {
      this.inflightCancels.delete(runId);
    }
  }

  /**
   * The serialized RUNNING-cancel pipeline. Runs synchronously up to the first
   * await, so concurrent callers can never interleave inside it; the in-flight
   * map (and the persisted CancellationRequested guard) keeps the request
   * event unique across concurrent AND retried cancels.
   */
  private async performRunningCancel(
    runId: string,
    reason: string | undefined
  ): Promise<CancelRunResult> {
    // Fresh read: the Run may have settled between the caller's check and here
    // (the executor completed it while this call was queued).
    const run = this.runs.getRun(runId);
    if (run === null) {
      throw new NotFoundError(`Run ${runId} was not found`, { runId });
    }
    if (run.status === "CANCELLED") {
      return { runId, status: "CANCELLED", alreadyCancelled: true };
    }
    if (run.status !== "RUNNING") {
      throw new RunnerInvariantError(
        `Run ${runId} is ${run.status}; only QUEUED or RUNNING Runs can be cancelled`,
        { runId, status: run.status }
      );
    }
    const attempt = this.orchestrator.getActiveAttempt(runId);
    if (attempt === null) {
      throw new RunnerInvariantError(
        `Run ${runId} is RUNNING but has no ACTIVE attempt; the cancellation cannot proceed`,
        { runId }
      );
    }
    // 1. Persist CancellationRequested FIRST — exactly once. A retried cancel
    //    after a mid-flight process crash must not append a second request.
    if (this.runs.getCancellationRequestedAt(runId) === null) {
      this.runs.appendRunEvents({
        runId,
        attemptId: attempt.id,
        entries: [
          {
            payload: {
              type: "CancellationRequested",
              ...(reason === undefined ? {} : { reason })
            },
            occurredAt: this.nowIso()
          }
        ]
      });
    }
    // Never steal a live foreign lease: the cancellation stays requested, the
    // Run stays RUNNING and the workspace is untouched — the eligible recovery
    // path settles the stale attempt later (as FAILED / INTERRUPTED, never a
    // false cancellation).
    const lease = attempt.leaseDeadlineAt;
    const liveForeign =
      attempt.ownerToken !== this.orchestrator.ownerToken &&
      lease !== undefined &&
      !isLeaseExpired(lease, this.nowIso());
    if (liveForeign) {
      return { runId, status: "CANCEL_PENDING", detail: "FOREIGN_LIVE_LEASE", leaseDeadlineAt: lease };
    }
    // 2. Signal the cooperative abort to the claim this executor runs (the
    //    scripted hang settles through the same signal).
    if (this.activeClaim !== null && this.activeClaim.runId === runId) {
      this.activeClaim.token.requested = true;
      this.activeClaim.resolveHang();
    }
    // 3. P5-3: ask the running turn adapter to interrupt its in-flight turn
    //    BEFORE the bounded wait. A DELIVERY FAILURE is meaningful: the turn
    //    may still be running server-side, so the cancellation must NEVER be
    //    confirmed afterwards (the claim could recreate workspace files a
    //    cleanup already deleted). The bounded wait remains the safety net for
    //    the claim itself.
    let interruptDelivered = false;
    try {
      await this.agent.interruptTurn?.({ runId, attemptId: attempt.id });
      interruptDelivered = true;
    } catch {
      // stays false: the interrupt could not be delivered
    }
    // 4. Bounded wait; the timeout is the safety net for claims that ignore the
    //    signal. `stopped` tells whether the claim actually finished.
    const stopped = await this.waitForClaimStop();
    if (!interruptDelivered || !stopped) {
      // The claim did NOT stop within the bound (or the interrupt could not be
      // delivered): the attempt may still be live — ownership is NEVER closed,
      // the workspace is NEVER deleted and CANCELLED is NEVER confirmed.
      // Re-read FIRST: the claim may have settled the Run while we waited (a
      // turn that completed despite the failed interrupt delivery). A now
      // terminal Run returns its stable outcome (CANCELLED ->
      // alreadyCancelled; COMPLETED / CLARIFICATION_REQUIRED / FAILED ->
      // ALREADY_TERMINAL) — it can no longer fail a cancel cleanup. Only a Run
      // that is STILL RUNNING routes to the shared failCancelCleanup policy:
      // FAILED with CANCEL_CLEANUP_PENDING, attempt INTERRUPTED (never
      // CANCELLED).
      const settled = this.settledCancelOutcome(runId);
      if (settled !== null) return settled;
      return this.failCancelCleanup(
        runId,
        attempt.id,
        "取消时 Agent 结果回合未在限定时间内停止（或中断未能送达），取消无法确认；Run 以 CANCEL_CLEANUP_PENDING 失败"
      );
    }
    // 5. Re-read after the wait: the claim may have settled the Run while we
    //    waited (e.g. a turn that completed despite the cancel). Never close
    //    ownership / delete the workspace / confirm against a terminal Run —
    //    the stable outcome of a natural settle replaces a thrown
    //    DOMAIN_INVARIANT (the terminal Run owns its output; nothing is closed
    //    or cleaned; the persisted CancellationRequested stays the truthful
    //    trace).
    const settled = this.settledCancelOutcome(runId);
    if (settled !== null) return settled;
    // 5b. Phase 5 cancellation lease fence: atomically establish THIS
    //    orchestrator as the cleanup owner of the exact RUNNING Run + ACTIVE
    //    attempt BEFORE any destructive step (ownership close / workspace
    //    deletion). The transaction re-validates the pair and either refreshes
    //    the same owner's lease (even an expired one), re-owns a stale foreign
    //    attempt with a FRESH lease, or refuses a live foreign lease — a plain
    //    re-read could be overtaken by a foreign recovery resume right after
    //    the read, letting destructive work run on a now-foreign attempt with
    //    only the final cancelAttempt transaction noticing. With the fence
    //    either this cancel wins (the attempt holds OUR live lease, so a
    //    foreign recovery scan SKIPs it) or the foreign owner won first and
    //    this call throws before ownership or the workspace is touched — the
    //    stable CANCEL_PENDING outcome, never destructive work after a
    //    takeover. The fence lease is the load-bearing protection of the
    //    synchronous cleanup section below (fence -> ownership close ->
    //    workspace delete -> cancelAttempt MUST stay free of awaits: a yield
    //    between those steps would reopen the takeover window).
    try {
      this.orchestrator.seizeCancelCleanupOwnership({
        runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken
      });
    } catch (error) {
      if (error instanceof LiveForeignLeaseError) {
        return this.pendingForeignLeaseOutcome(runId);
      }
      if (error instanceof RunnerInvariantError || error instanceof NotFoundError) {
        // The exact pair could not be fenced: the Run / attempt settled between
        // the last re-read and the fence (a foreign cancel confirmed the
        // cancellation, a foreign recovery failed the Run, or the attempt is
        // no longer the same ACTIVE one). A now-terminal Run returns its stable
        // outcome; a still-RUNNING Run whose attempt the fence could not seize
        // is the same pending outcome the pre-destructive re-validation
        // returned — NEVER a destructive step on an unfenced attempt.
        const settled = this.settledCancelOutcome(runId);
        if (settled !== null) return settled;
        return this.pendingForeignLeaseOutcome(runId);
      }
      throw error;
    }
    // 6. P5-4: ownership-safe close of EXACTLY the proven SolidWorks identities
    //    of the current attempt — AFTER the claim stopped (no further work can
    //    spawn identities), BEFORE the workspace cleanup. A record with nothing
    //    attested closes as `nothing-owned` (safe); `null` from the snapshot
    //    means the integration holds no record for the pair (safe). Any
    //    unproven / partial / failed / thrown close is a cleanup failure: the
    //    cancellation is never confirmed while a SolidWorks identity of the
    //    attempt may still be live. The live foreign lease was already excluded
    //    above — the surface is never consulted for it.
    if (this.ownership !== null) {
      let record: OwnershipRecord | null;
      try {
        record = this.ownership.snapshotRecord({ runId, attemptId: attempt.id });
      } catch (error) {
        return this.failCancelCleanup(
          runId,
          attempt.id,
          `取消时无法读取当前 Run/attempt 的 SolidWorks 所有权记录，取消无法确认；Run 以 CANCEL_CLEANUP_PENDING 失败（${errorMessage(error)}）`
        );
      }
      if (record !== null) {
        let outcome: CloseOnlyOwnedOutcome;
        try {
          outcome = this.ownership.closeOnlyOwned(record);
        } catch (error) {
          return this.failCancelCleanup(
            runId,
            attempt.id,
            `取消时关闭当前 Run/attempt 的 SolidWorks 资源抛出异常，取消无法确认；Run 以 CANCEL_CLEANUP_PENDING 失败（${errorMessage(error)}）`
          );
        }
        if (!isOwnedCloseSafeForCancellation(outcome)) {
          const detail =
            outcome.status === "ownership-unproven"
              ? "所有权无法证明"
              : outcome.status === "partial"
                ? "部分资源关闭失败"
                : "资源关闭失败";
          return this.failCancelCleanup(
            runId,
            attempt.id,
            `取消时 SolidWorks 资源所有权关闭未完成（${detail}），取消无法确认；Run 以 CANCEL_CLEANUP_PENDING 失败`
          );
        }
      }
    }
    // 7. Clean ONLY the allowlisted current Run/attempt generated files.
    const cleaned = this.cleanAttemptWorkspace(runId, attempt.attemptSequence);
    if (!cleaned) {
      return this.failCancelCleanup(
        runId,
        attempt.id,
        "取消时清理当前 Run/attempt 工作区失败，取消无法确认；Run 以 CANCEL_CLEANUP_PENDING 失败"
      );
    }
    // 8. Atomically confirm: CancellationConfirmed + attempt CANCELLED. The
    //    final guard re-validates ownership inside the terminal transaction —
    //    the fence lease above holds until here, so a takeover inside the
    //    cleanup can only surface here as a live foreign lease (CANCEL_PENDING)
    //    and can never be confirmed as ours.
    //
    //    LOAD-BEARING INVARIANT: the section from the lease fence (5b) through
    //    this terminal confirm is deliberately SYNCHRONOUS — no await between
    //    the fence, the ownership close, the workspace deletion and the confirm.
    //    The fence lease alone bounds FOREIGN (cross-process) takeover; the
    //    absence of awaits additionally guarantees that no IN-PROCESS writer
    //    can interleave destructive steps. If an await is ever introduced
    //    here, the fence lease must be re-verified after it.
    try {
      this.orchestrator.cancelAttempt({
        runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken,
        finishedAt: this.nowIso()
      });
    } catch (error) {
      if (error instanceof LiveForeignLeaseError) {
        return this.pendingForeignLeaseOutcome(runId);
      }
      throw error;
    }
    this.signalRecoveryWake();
    return { runId, status: "CANCELLED", alreadyCancelled: false };
  }

  /**
   * Re-reads the Run after (or during) a cancel wait and maps a natural settle
   * to the stable cancel outcome. Returns null ONLY while the Run is still
   * RUNNING (the caller may proceed with the cleanup path); a terminal Run
   * returns its stable outcome (CANCELLED -> alreadyCancelled; COMPLETED /
   * CLARIFICATION_REQUIRED / FAILED -> ALREADY_TERMINAL); a vanished Run
   * throws NotFoundError and any other status is a defensive invariant.
   */
  private settledCancelOutcome(runId: string): CancelRunResult | null {
    const settled = this.runs.getRun(runId);
    if (settled === null) {
      throw new NotFoundError(`Run ${runId} was not found`, { runId });
    }
    if (settled.status === "CANCELLED") {
      return { runId, status: "CANCELLED", alreadyCancelled: true };
    }
    if (
      settled.status === "COMPLETED" ||
      settled.status === "CLARIFICATION_REQUIRED" ||
      settled.status === "FAILED"
    ) {
      // The Run reached its OWN terminal state while the claim was being
      // stopped (a turn that completed despite the cancel): the cancellation
      // is never confirmed and nothing is closed or cleaned — the terminal Run
      // owns its output. The persisted CancellationRequested stays the
      // truthful trace; the stable structured outcome replaces a thrown
      // DOMAIN_INVARIANT on this natural settle race.
      return { runId, status: "ALREADY_TERMINAL", finalStatus: settled.status };
    }
    if (settled.status !== "RUNNING") {
      // Unreachable from RUNNING (no RUNNING -> QUEUED transition); kept as a
      // defensive invariant, never a natural-settle outcome.
      throw new RunnerInvariantError(
        `Run ${runId} is ${settled.status}; only QUEUED or RUNNING Runs can be cancelled`,
        { runId, status: settled.status }
      );
    }
    return null;
  }

  /**
   * The shared cleanup-failure terminal path (P5-4): the cancellation is never
   * confirmed while the attempt's owned resources may still be live — the Run
   * fails with `CANCEL_CLEANUP_PENDING` and the attempt is INTERRUPTED (never
   * CANCELLED). A stale foreign-owned attempt is re-owned safely inside the
   * transaction; a live foreign lease (changed meanwhile) surfaces as pending.
   *
   * Every failure message is path-redacted before it is persisted (F2): the
   * persisted Failed event / UI must never expose the user home, the OS temp
   * dir or any supplied absolute path echoed by an underlying error — the
   * ownership snapshot / close / workspace cleanup messages all route through
   * this single choke point.
   *
   * The second settle race is absorbed here: the Run / attempt may settle
   * between the caller's re-read and this transaction (e.g. the claim
   * completed while the ownership surface was consulted). A now-terminal Run
   * returns its stable outcome (alreadyCancelled / ALREADY_TERMINAL) instead
   * of the raw invariant; a genuine invariant on a STILL-RUNNING active
   * attempt is never hidden.
   */
  private failCancelCleanup(
    runId: string,
    attemptId: string,
    failureMessage: string
  ): CancelRunResult {
    try {
      this.orchestrator.failCancelCleanup({
        runId,
        attemptId,
        ownerToken: this.orchestrator.ownerToken,
        failureMessage: redactSensitivePaths(failureMessage)
      });
    } catch (error) {
      if (error instanceof LiveForeignLeaseError) {
        return this.pendingForeignLeaseOutcome(runId);
      }
      if (error instanceof RunnerInvariantError) {
        // Second settle race: the Run / attempt settled between the caller's
        // re-read and this transaction. A now-terminal Run can no longer fail
        // a cancel cleanup — return the stable terminal outcome. A genuine
        // invariant on a still-RUNNING active attempt (or a vanished Run)
        // stays visible.
        const settled = this.runs.getRun(runId);
        if (settled !== null && settled.status === "CANCELLED") {
          return { runId, status: "CANCELLED", alreadyCancelled: true };
        }
        if (
          settled !== null &&
          (settled.status === "COMPLETED" ||
            settled.status === "CLARIFICATION_REQUIRED" ||
            settled.status === "FAILED")
        ) {
          return { runId, status: "ALREADY_TERMINAL", finalStatus: settled.status };
        }
      }
      throw error;
    }
    // The blocking attempt was settled: wake an idle recovery wait (if any)
    // so the queue re-checks immediately instead of sleeping until the lease
    // deadline of the now-finished attempt.
    this.signalRecoveryWake();
    return { runId, status: "FAILED", failureCode: "CANCEL_CLEANUP_PENDING" };
  }

  /** The explicit pending outcome for a run whose attempt holds a live foreign lease. */
  private pendingForeignLeaseOutcome(runId: string): CancelRunResult {
    const lease = this.orchestrator.getActiveAttempt(runId)?.leaseDeadlineAt ?? null;
    return { runId, status: "CANCEL_PENDING", detail: "FOREIGN_LIVE_LEASE", leaseDeadlineAt: lease };
  }

  /** Fires when a cancel settled a blocking attempt; an idle wait re-checks. */
  private signalRecoveryWake(): void {
    this.wakeRecovery?.();
  }

  // -------------------------------------------------------------------------
  // Serial queue loop
  // -------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      // Continue ONLY attempts the recovery scan re-issued to this owner with
      // a persisted RESUME decision. A claim this executor interrupted itself
      // (crash / cooperative stop) is never re-entered here: its attempt stays
      // ACTIVE without a RESUME decision, `claimNextQueuedRun` refuses while
      // the owner is busy, and the cancel flow or the recovery scan owns the
      // aftermath.
      const resumed = this.orchestrator.getActiveAttemptForOwner();
      if (resumed !== null && resumed.recoveryDecision === "RESUME") {
        await this.executeClaim(resumed, true);
        continue;
      }
      const claim = this.orchestrator.claimNextQueuedRun();
      if (claim === null) {
        // Idle: nothing QUEUED is claimable right now. Either the queue is
        // drained, or the slot is blocked by an ACTIVE attempt whose lease has
        // not expired yet (an own interrupted claim, a quick restart inside
        // the lease, a foreign claim). Ongoing recovery wakes exactly at the
        // earliest lease deadline — never a busy loop — so an in-process
        // expiry and a restart inside the lease recover / unblock on their own.
        if (await this.waitForNextRecoveryDeadline()) continue;
        break;
      }
      await this.executeClaim(claim.attempt, false);
    }
  }

  /**
   * Ongoing-recovery wake-up of the idle loop. With any ACTIVE lease in
   * flight, waits until its earliest deadline (lease-deadline-aware retry)
   * and then reconsiders every expired attempt / wedged Run. The wait also
   * ends the moment a cancel settles a blocking attempt (`signalRecoveryWake`)
   * or the loop is stopped, so the queue re-checks and settles immediately
   * instead of sleeping until the deadline. Without any lease but with QUEUED
   * Runs, one sweep repairs a wedged RUNNING Run holding the single-active
   * slot. Returns false only when the loop is truly drained.
   */
  private async waitForNextRecoveryDeadline(): Promise<boolean> {
    const deadline = this.orchestrator.nextActiveLeaseDeadline();
    if (deadline !== null) {
      const delayMs = Date.parse(deadline) - this.nowMs() + RECOVERY_WAKEUP_EPSILON_MS;
      let resolveWake: () => void = () => {};
      const wake = new Promise<void>((resolve) => {
        resolveWake = resolve;
      });
      this.wakeRecovery = resolveWake;
      try {
        if (delayMs > 0) await Promise.race([this.tick(delayMs), this.stopSignal, wake]);
      } finally {
        this.wakeRecovery = null;
      }
      if (this.stopped) return false;
      // The earliest ACTIVE lease has expired (or a cancel settled the blocking
      // attempt): reconsider every expired attempt and wedged Run now (the
      // classifier never invents a cancellation and never publishes a Model).
      const scan = this.orchestrator.recoverExpiredAttempts();
      // A scan that left an immediately-expired blocker unresolved (a
      // CancellationRequested RUNNING Run, a SCAN_FAILED candidate/wedge) must
      // not make the idle loop re-wake instantly on the same past deadline:
      // one bounded retry/backoff before the next reconsideration (never a
      // busy loop; a cancel settling the Run wakes us).
      await this.boundRecoveryRescan(scan);
      return true;
    }
    if (this.orchestrator.hasQueuedRuns()) {
      // No lease to wait for, yet the queue is not claimable: a wedged RUNNING
      // Run (no live attempt) may hold the single-active slot. Sweep once.
      const scan = this.orchestrator.recoverExpiredAttempts();
      // Same bounded retry/backoff as above: a scan that left an unresolved
      // blocker must not make the idle loop re-sweep instantly forever.
      await this.boundRecoveryRescan(scan);
      return true;
    }
    return false;
  }

  /**
   * Bounded wait after a recovery scan that left an immediately-expired
   * blocker unresolved: an ACTIVE attempt still holding an already-expired
   * lease (the scan SKIPped a CancellationRequested RUNNING Run — the explicit
   * cancel retry owns the aftermath — or SCAN_FAILED without resolving it), a
   * CancellationRequested RUNNING wedge with no ACTIVE lease, or a SCAN_FAILED
   * candidate/wedge. The expired lease / wedged slot would otherwise make the
   * idle loop reconsider the same
   * state instantly forever. One bounded wait before the next
   * reconsideration — still interruptible by the loop stop signal and by a
   * cancel settling the blocking run (the recovery wake signal), so the queue
   * re-checks immediately when the blocker is finally settled.
   */
  private async boundRecoveryRescan(scan: RecoveryScanResult): Promise<void> {
    const deadline = this.orchestrator.nextActiveLeaseDeadline();
    const expiredBlockerUnresolved =
      (deadline !== null && Date.parse(deadline) <= this.nowMs()) ||
      scan.entries.some((entry) => entry.outcome === "SCAN_FAILED") ||
      this.orchestrator.hasCancellationRequestedRunningRun();
    if (!expiredBlockerUnresolved) return;
    let resolveWake: () => void = () => {};
    const wake = new Promise<void>((resolve) => {
      resolveWake = resolve;
    });
    this.wakeRecovery = resolveWake;
    try {
      await Promise.race([this.tick(RECOVERY_RESCAN_WAIT_MS), this.stopSignal, wake]);
    } finally {
      this.wakeRecovery = null;
    }
  }

  private async executeClaim(attempt: RunAttempt, resumed: boolean): Promise<void> {
    const token: CancelToken = { requested: false };
    let resolveHang: () => void = () => {};
    const hangSignal = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    this.activeClaim = {
      runId: attempt.runId,
      attemptId: attempt.id,
      attemptSequence: attempt.attemptSequence,
      token,
      resolveHang
    };
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.claimDone = done;
    try {
      const layout = this.workspace.createAttemptWorkspace(attempt.runId, attempt.attemptSequence);
      await this.runScenario(attempt, token, resumed, hangSignal, layout);
    } catch (error) {
      if (
        error instanceof ExecutorInterruptedSignal ||
        error instanceof PreparationTerminatedSignal
      ) {
        return;
      }
      // M2 per-claim error boundary: a thrown workspace / adapter / prompt /
      // agent IO exception of ONE claimed Run must never kill the serial queue
      // nor leave it indefinitely stalled — the claim is settled and the loop
      // continues with the next Run.
      this.settleUnexpectedClaimFailure(attempt, resumed, error);
    } finally {
      this.activeClaim = null;
      this.claimDone = null;
      resolveDone();
    }
  }

  /**
   * The per-claim error boundary (M2). A thrown workspace / adapter / prompt /
   * agent IO exception of one claimed Run is scoped to that claim: it is
   * settled truthfully and the serial queue keeps running.
   *
   * - Errors raised DURING input preparation were already converted by
   *   `prepareInput` into the accurate structured terminal failure
   *   (INPUT_ADAPTER_FAILED / PREFLIGHT_FAILED) through the atomic
   *   `failAttempt`; that path terminates the claim via
   *   {@link PreparationTerminatedSignal} and never reaches this boundary.
   * - Any other claim error (workspace IO mid-execution, thrown Agent adapter /
   *   validator exceptions, heartbeat failures) leaves the attempt ACTIVE
   *   WITHOUT a recovery decision, so the loop's lease-deadline-aware recovery
   *   classifies it truthfully (FAILED / INTERRUPTED, never CANCELLED) while
   *   the queue itself continues — a fresh claim can never re-enter it (no
   *   RESUME decision), so the idle loop simply waits for the lease deadline.
   * - A RESUMED claim (persisted recovery decision RESUME) that fails again can
   *   NOT be left ACTIVE: the loop would re-enter the same claim forever. It is
   *   therefore ended truthfully NOW with RECOVERY_FAILED — and only when it is
   *   still ACTIVE and owned by this orchestrator, so a concurrent cancel can
   *   never produce a second terminal event.
   */
  private settleUnexpectedClaimFailure(attempt: RunAttempt, resumed: boolean, error: unknown): void {
    if (!resumed) return;
    const active = this.orchestrator.getActiveAttempt(attempt.runId);
    if (
      active === null ||
      active.id !== attempt.id ||
      active.ownerToken !== this.orchestrator.ownerToken
    ) {
      // A concurrent cancel already settled the attempt: never a second event.
      return;
    }
    try {
      this.orchestrator.failAttempt({
        runId: attempt.runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken,
        failureCode: "RECOVERY_FAILED",
        failureMessage: `恢复后的执行再次遇到意外错误，Run 以 RECOVERY_FAILED 失败：${errorMessage(error)}`
      });
    } catch {
      // The attempt changed concurrently and could not be ended here: never a
      // second terminal event — anything still ACTIVE is settled by recovery.
    }
  }

  // -------------------------------------------------------------------------
  // Deterministic scenario machine
  // -------------------------------------------------------------------------

  private async runScenario(
    attempt: RunAttempt,
    token: CancelToken,
    resumed: boolean,
    hangSignal: Promise<void>,
    layout: RunWorkspaceLayout
  ): Promise<void> {
    switch (this.scenario) {
      case "success":
      case "cooperative-cancel": {
        if (this.liveAgent) {
          await this.walkStages(
            attempt,
            token,
            ["PREPARING"],
            { progressTotal: ALL_STAGES.length },
            resumed,
            layout
          );
          if (token.requested) return;
          this.runs.appendRunEvents({
            runId: attempt.runId,
            attemptId: attempt.id,
            entries: [
              {
                payload: { type: "ActivityUpdated", activity: LIVE_AGENT_ACTIVITY },
                occurredAt: this.nowIso()
              }
            ]
          });
        } else {
          await this.walkStages(attempt, token, ALL_STAGES, { writeResult: true }, resumed, layout);
        }
        if (token.requested) return; // cooperative stop: the cancel flow finishes the attempt
        await this.finalizeWithAgentResults(attempt, undefined, token, layout, resumed);
        return;
      }
      case "clarification": {
        await this.walkStages(
          attempt,
          token,
          ["PREPARING", "ANALYZING", "PLANNING"],
          {},
          resumed,
          layout
        );
        if (token.requested) return;
        // The clarification terminal state comes from the AGENT TURN outcome
        // (P5): the runtime events are translated/persisted first, then the
        // F5 fail-closed pre-CAD guard requires the attempt's runtime
        // ownership registry to be ABSENT (clarification must precede any
        // CAD / ownership registration — see finalizeWithAgentResults) and
        // only then the orchestrator persists the OPEN request +
        // ClarificationRequired — ArtifactValidator / Model are never touched
        // (see finalizeWithAgentResults).
        await this.finalizeWithAgentResults(
          attempt,
          undefined,
          token,
          layout,
          resumed,
          { produceClarification: true }
        );
        return;
      }
      case "failure": {
        await this.walkStages(
          attempt,
          token,
          ["PREPARING", "ANALYZING", "PLANNING"],
          {},
          resumed,
          layout
        );
        if (token.requested) return;
        this.orchestrator.failAttempt({
          runId: attempt.runId,
          attemptId: attempt.id,
          ownerToken: this.orchestrator.ownerToken,
          failureCode: "AGENT_RUNTIME_UNAVAILABLE",
          failureMessage: "Fake 场景：模拟 Agent 运行时不可用"
        });
        return;
      }
      case "hang": {
        if (this.incidentConsumed) {
          // The one incident already ran: later claims behave like success.
          await this.walkStages(attempt, token, ALL_STAGES, { writeResult: true }, resumed, layout);
          if (token.requested) return;
          await this.finalizeWithAgentResults(attempt, undefined, token, layout, resumed);
          return;
        }
        // The lease is renewed during the walked stages and then never again:
        // the attempt stays ACTIVE with an expiring lease and no further work.
        await this.walkStages(
          attempt,
          token,
          ["PREPARING", "ANALYZING"],
          {},
          resumed,
          layout
        );
        if (token.requested) return;
        this.incidentConsumed = true;
        // Scripted hang: the claim stays stuck until the cooperative abort
        // signal (user cancel / Runner stop) settles it, so a cancellation
        // terminates the claim and the queue can continue.
        await this.hangForever(hangSignal);
        return;
      }
      case "crash":
      case "recovery-supported":
      case "recovery-unsupported": {
        if (this.incidentConsumed) {
          // The one incident already ran: later claims behave like success.
          await this.walkStages(attempt, token, ALL_STAGES, { writeResult: true }, resumed, layout);
          if (token.requested) return;
          await this.finalizeWithAgentResults(attempt, undefined, token, layout, resumed);
          return;
        }
        // The interrupt scenarios walk the FULL six-stage script but stop
        // without a terminal event at a deterministic stage (crash at
        // MODELING, recovery-supported at ANALYZING, recovery-unsupported at
        // PLANNING). A recovery-resumed walk IGNORES the interrupt point and
        // continues through the remaining stages to completion — the resumed
        // attempt is never re-interrupted (that would loop forever).
        const interruptAfter: RunStage =
          this.scenario === "crash"
            ? "MODELING"
            : this.scenario === "recovery-supported"
              ? "ANALYZING"
              : "PLANNING";
        // Partial workspace files stay behind; the attempt is left ACTIVE so
        // the recovery scan classifies it (never CANCELLED). A RESUMED walk
        // writes the result artifact like a normal completion (the completed
        // Run's output must exist); an interrupted walk never does.
        await this.walkStages(
          attempt,
          token,
          ALL_STAGES,
          { interruptAfter, writeMarker: true, ...(resumed ? { writeResult: true } : {}) },
          resumed,
          layout
        );
        if (token.requested) return;
        this.incidentConsumed = true;
        if (!resumed) throw new ExecutorInterruptedSignal();
        // A resumed walk that completed the full script ends like success:
        // the result artifacts + manifest are produced and independently
        // validated before the Run may complete.
        await this.finalizeWithAgentResults(attempt, undefined, token, layout, resumed);
        return;
      }
      case "artifact-validation-failure": {
        await this.walkStages(
          attempt,
          token,
          ["PREPARING", "ANALYZING", "PLANNING", "MODELING", "VALIDATING"],
          {},
          resumed,
          layout
        );
        if (token.requested) return;
        // The fake agent submits a defective result set (the sldprt artifact is
        // declared but never written); the INDEPENDENT validator must reject it
        // with ARTIFACT_MISSING before any terminal event is written.
        await this.finalizeWithAgentResults(attempt, { kind: "missing-artifact" }, token, layout, resumed);
        return;
      }
    }
  }

  /**
   * Walks the scenario's stage script: one StageChanged + ActivityUpdated +
   * ProgressUpdated trio per stage (referencing the ACTIVE attempt), a lease
   * renewal around every step, a cooperative-stop check at every boundary. A
   * non-resumed walk of an interrupt scenario stops after `interruptAfter`;
   * on a resume the walk continues from the Run's persisted stage (the
   * checkpoint the recovery scan proved safe) through the FULL script.
   *
   * A fresh (non-resumed) walk starts with the Phase 4 (P4-1/P4-2) input
   * preparation BEFORE the PREPARING trio is announced: the Input Adapter
   * converts the immutable original drawing into the Skill input image +
   * provenance and the validated Invocation Package + rendered prompt are
   * written into the attempt workspace. Because preparation is synchronous
   * with the claim, a persisted PREPARING stage always means preparation
   * already completed — a resumed walk (startIndex > 0) never re-runs it, and
   * an interrupted null-stage walk re-runs it idempotently. A preparation
   * failure terminates the attempt atomically (Failed event + INTERRUPTED
   * attempt) and aborts the walk through {@link PreparationTerminatedSignal}.
   */
  private async walkStages(
    attempt: RunAttempt,
    token: CancelToken,
    stages: readonly RunStage[],
    opts: { writeResult?: boolean; writeMarker?: boolean; interruptAfter?: RunStage; progressTotal?: number },
    resumed: boolean,
    layout: RunWorkspaceLayout
  ): Promise<void> {
    const limit =
      resumed || opts.interruptAfter === undefined
        ? stages.length
        : stages.indexOf(opts.interruptAfter) + 1;
    const startIndex = resumed ? this.resumeIndex(attempt.runId, stages) : 0;
    if (startIndex === 0 && stages[0] === "PREPARING") {
      this.prepareInput(attempt, layout);
    }
    for (let index = startIndex; index < limit; index++) {
      if (token.requested) return;
      const stage = stages[index];
      if (stage === undefined) return; // unreachable inside the bounds; satisfies strict indexing
      const progressPercent = Math.round(((index + 1) / (opts.progressTotal ?? stages.length)) * 100);
      this.runs.appendRunEvents({
        runId: attempt.runId,
        attemptId: attempt.id,
        entries: [
          {
            payload: { type: "StageChanged", stage, activity: STAGE_ACTIVITIES[stage] },
            occurredAt: this.nowIso()
          },
          {
            payload: { type: "ActivityUpdated", activity: STAGE_ACTIVITIES[stage] },
            occurredAt: this.nowIso()
          },
          {
            payload: { type: "ProgressUpdated", progressPercent, activity: STAGE_ACTIVITIES[stage] },
            occurredAt: this.nowIso()
          }
        ]
      });
      this.renewLease(attempt);
      await this.raceStop(this.tick(this.stepDelayMs));
      if (token.requested) return;
      this.renewLease(attempt);
    }
    if (opts.writeResult === true) {
      this.workspace.writeOwnedFile({
        runId: attempt.runId,
        attemptSequence: attempt.attemptSequence,
        relativePath: "output/fake-result.txt",
        content: Buffer.from("fake executor deterministic result\n", "utf8")
      });
    }
    if (opts.writeMarker === true) {
      this.workspace.writeOwnedFile({
        runId: attempt.runId,
        attemptSequence: attempt.attemptSequence,
        relativePath: "working/partial.txt",
        content: Buffer.from("partial work before the interruption\n", "utf8")
      });
    }
  }

  /**
   * Phase 4 (P4-1 + P4-2) + Phase 5 (P5-1) input preparation of the PREPARING
   * stage:
   *
   * 0. the preflight capability gate runs FIRST (P5-1): the eight environment
   *    capabilities are probed fail-fast BEFORE any input adaptation — a Run
   *    cannot leave PREPARING unless the gate holds. A failing capability
   *    terminates the attempt with its accurate code (runtime / skill /
   *    protocol / workspace / SolidWorks) and the redacted report
   *    is persisted at `runtime/preflight-report.json`; a THROWN gate, an
   *    INTERNALLY INCONSISTENT gate result or a report write failure also
   *    fails closed with `PREFLIGHT_FAILED` before adaptation;
   * 1. resolves the frozen snapshot's immutable original source file through
   *    the injected resolver (an unresolvable source fails closed);
   * 2. runs the injected deterministic Input Adapter — the derived Skill
   *    input image + preview + the strictly validated `adapter-result.json`
   *    envelope are written into the attempt workspace, never the original;
   *    the ninth gate item `input_adapter_succeeded` is marked true ONLY after
   *    the adaptation succeeds (a conversion failure marks it false and fails
   *    closed with the mapped INPUT_UNSUPPORTED / INPUT_ADAPTER_FAILED code);
   * 3. builds the Invocation Package from the frozen `RunInputSnapshot` + the
   *    adapter provenance + the attempt workspace, strictly validates it
   *    through the shared contracts validator and writes
   *    `runtime/invocation-package.json`;
   * 4. renders the controlled versioned prompt template into
   *    `runtime/prompt.md`;
   * 5. ONLY after the complete pipeline succeeded is the final PASSED
   *    preflight report persisted — a passed report can never mislead about a
   *    later failure. Failure reports persist at the failing point; a
   *    post-gate failure (steps 3/4 after a successful adaptation) persists a
   *    FAILED report recording the ten evaluated checks with
   *    `input_adapter_succeeded` truthfully true.
   *
   * Any failure terminates the attempt atomically (Failed event with the
   * accurate code + INTERRUPTED attempt) and aborts the walk. A THROWN adapter /
   * gate / package / workspace / prompt exception is a preparation failure of
   * the claim just like a structured one (M2): it fails closed with the
   * accurate code and never reaches the per-claim boundary or kills the serial
   * queue.
   */
  private prepareInput(attempt: RunAttempt, layout: RunWorkspaceLayout): void {
    const adapter = this.inputAdapter;
    const preflight = this.preflight;
    if (adapter === null && preflight === null) return;
    // The constructor guard guarantees a preflight gate implies an active
    // adapter (the ninth item can only be marked after adaptation); fail
    // loudly if that pairing ever regressed.
    if (adapter === null) {
      throw new RunnerInvariantError(
        "a preflight gate requires an inputAdapter: input_adapter_succeeded can only be marked after the adaptation succeeds"
      );
    }
    const failPreparation = (
      failureCode: RunFailureCode,
      failureMessage: string
    ): void => {
      this.orchestrator.failAttempt({
        runId: attempt.runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken,
        failureCode,
        failureMessage
      });
      throw new PreparationTerminatedSignal();
    };

    // 0. P5-1 capability gate: eight environment capabilities, fail-fast, BEFORE
    //    input adaptation. The report is redacted (boolean checks only) — a
    //    probe throw is recorded as a failed check without any error content.
    let envChecks: readonly PreflightCheckItem[] = [];
    if (preflight !== null) {
      const snapshot = this.runs.getRunSnapshot(attempt.runId);
      let gate: PreflightEnvironmentResult;
      try {
        // The real probe checks the writable-workspace capability against the
        // CURRENT attempt root (executor-owned context); synthetic fixtures
        // ignore it.
        gate = preflight.run({
          skill: snapshot.skill,
          workspaceRoot: layout.absoluteRoot
        } satisfies PreflightProbeContext);
      } catch (error) {
        void error;
        if (!this.writePreflightReport(attempt, [], false, preflight.synthetic)) {
          failPreparation(
            "PREFLIGHT_FAILED",
            "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
          );
          return;
        }
        failPreparation(
          "PREFLIGHT_FAILED",
          "预检失败：能力门检查抛出异常，Run 以 PREFLIGHT_FAILED 失败"
        );
        return;
      }
      envChecks = gate.checks;
      // A gate result that is internally inconsistent (a passed result with a
      // failure or an incomplete evaluation, a failed result without its
      // failing capability) cannot be trusted: fail closed at PREPARING
      // BEFORE any adaptation and persist a redacted report without checks —
      // nothing derived from an inconsistent result may proceed.
      if (!isConsistentEnvironmentResult(gate)) {
        if (!this.writePreflightReport(attempt, [], false, preflight.synthetic)) {
          failPreparation(
            "PREFLIGHT_FAILED",
            "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
          );
          return;
        }
        failPreparation(
          "PREFLIGHT_FAILED",
          "预检失败：能力门返回不一致的结果，Run 以 PREFLIGHT_FAILED 失败"
        );
        return;
      }
      if (!gate.ok && gate.failedCapability !== null) {
        const code = mapPreflightFailureCode(gate.failedCapability);
        if (!this.writePreflightReport(attempt, envChecks, false, preflight.synthetic)) {
          failPreparation(
            "PREFLIGHT_FAILED",
            "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
          );
          return;
        }
        failPreparation(
          code,
          `预检失败：能力 ${gate.failedCapability} 未通过，Run 以 ${code} 失败`
        );
        return;
      }
    }

    // 1. Resolve the immutable original source of the frozen snapshot.
    const sourceInfo = this.safeResolveInputSource(attempt.runId);
    if (sourceInfo === null) {
      if (preflight !== null) {
        if (!this.writePreflightReport(attempt, this.withAdapterCheck(envChecks, false), false, preflight.synthetic)) {
          failPreparation(
            "PREFLIGHT_FAILED",
            "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
          );
          return;
        }
      }
      failPreparation(
        "INPUT_ADAPTER_FAILED",
        "输入适配失败：无法解析原始图纸（Revision 源文件缺失或不可读），Run 以 INPUT_ADAPTER_FAILED 失败"
      );
      return;
    }

    // 2. Deterministic Input Adapter conversion (original file never modified).
    //    An adapter that THROWS instead of returning a structured failure is
    //    still a preparation failure of this claim: the attempt fails closed
    //    with the accurate code and the serial queue continues (M2).
    const snapshot = this.runs.getRunSnapshot(attempt.runId);
    let result: InputAdapterResult;
    try {
      result = adapter.adapt({
        runId: attempt.runId,
        attemptSequence: attempt.attemptSequence,
        source: sourceInfo.source,
        sourceAbsolutePath: sourceInfo.absolutePath,
        outputFormat: "PNG",
        workspace: this.workspace
      });
    } catch (error) {
      void error;
      if (preflight !== null) {
        if (!this.writePreflightReport(attempt, this.withAdapterCheck(envChecks, false), false, preflight.synthetic)) {
          failPreparation(
            "PREFLIGHT_FAILED",
            "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
          );
          return;
        }
      }
      failPreparation(
        "INPUT_ADAPTER_FAILED",
        `输入适配失败（适配器抛出异常）：${errorMessage(error)}`
      );
      return;
    }
    if (!result.ok) {
      if (preflight !== null) {
        if (!this.writePreflightReport(attempt, this.withAdapterCheck(envChecks, false), false, preflight.synthetic)) {
          failPreparation(
            "PREFLIGHT_FAILED",
            "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
          );
          return;
        }
      }
      failPreparation(
        mapInputAdapterFailureCode(result.error.code),
        `输入适配失败（${result.error.code}）：${result.error.message}`
      );
      return;
    }
    const provenance = result.provenance;

    // 2b. `input_adapter_succeeded` is TRUE only after the adaptation
    //     succeeded. The final report itself is persisted at step 5 — after
    //     the COMPLETE PREPARING pipeline — so a passed report can never
    //     mislead about a later Invocation Package / prompt failure.

    // 3. Invocation Package from the frozen snapshot + provenance + workspace,
    //    strictly validated before it is written to the attempt workspace. A
    //    post-gate failure persists the FAILED report (never a passed one).
    let invocationPackage: InvocationPackage;
    try {
      invocationPackage = buildInvocationPackage({
        runId: attempt.runId,
        snapshot,
        provenance,
        workspace: {
          root: layout.absoluteRoot,
          output: layout.directories.output.absolutePath
        }
      });
    } catch (error) {
      if (
        preflight !== null &&
        !this.writePostAdapterFailureReport(attempt, envChecks, preflight)
      ) {
        failPreparation(
          "PREFLIGHT_FAILED",
          "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
        );
        return;
      }
      if (error instanceof Phase4ContractError) {
        failPreparation(
          "PREFLIGHT_FAILED",
          `输入准备失败：Invocation Package 未通过契约校验（${error.message}）`
        );
        return;
      }
      failPreparation(
        "PREFLIGHT_FAILED",
        `输入准备失败：Invocation Package 构建抛出异常（${errorMessage(error)}）`
      );
      return;
    }
    try {
      this.workspace.writeOwnedFile({
        runId: attempt.runId,
        attemptSequence: attempt.attemptSequence,
        relativePath: "runtime/invocation-package.json",
        content: Buffer.from(JSON.stringify(invocationPackage, null, 2), "utf8")
      });
    } catch (error) {
      if (
        preflight !== null &&
        !this.writePostAdapterFailureReport(attempt, envChecks, preflight)
      ) {
        failPreparation(
          "PREFLIGHT_FAILED",
          "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
        );
        return;
      }
      failPreparation(
        "PREFLIGHT_FAILED",
        `输入准备失败：无法写入 Invocation Package（${errorMessage(error)}）`
      );
      return;
    }

    // 4. Controlled versioned prompt rendered from the same frozen inputs. The
    //    attested expected SolidWorks version (non-empty only) is rendered so
    //    the Agent records the exact version instead of guessing; absent keeps
    //    the rendered prompt byte-identical to the version-agnostic default.
    try {
      this.workspace.writeOwnedFile({
        runId: attempt.runId,
        attemptSequence: attempt.attemptSequence,
        relativePath: "runtime/prompt.md",
        content: Buffer.from(
          renderPrompt({
            snapshot,
            provenance,
            workspace: layout,
            invocationPackage,
            attemptId: attempt.id,
            attemptSequence: attempt.attemptSequence,
            ...(this.expectedSolidWorksVersion.length === 0
              ? {}
              : { expectedSolidWorksVersion: this.expectedSolidWorksVersion })
          }),
          "utf8"
        )
      });
    } catch (error) {
      if (
        preflight !== null &&
        !this.writePostAdapterFailureReport(attempt, envChecks, preflight)
      ) {
        failPreparation(
          "PREFLIGHT_FAILED",
          "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
        );
        return;
      }
      failPreparation(
        "PREFLIGHT_FAILED",
        `输入准备失败：无法写入渲染后的 Prompt（${errorMessage(error)}）`
      );
    }

    // 5. The final passed preflight report is persisted ONLY after the entire
    //    PREPARING pipeline (gate + adaptation + Invocation Package + prompt)
    //    succeeded. A report write failure fails closed even at this last
    //    step — a Run never completes without its truthful report.
    if (preflight !== null) {
      if (!this.writePreflightReport(attempt, this.withAdapterCheck(envChecks, true), true, preflight.synthetic)) {
        failPreparation(
          "PREFLIGHT_FAILED",
          "预检失败：无法写入预检报告，Run 以 PREFLIGHT_FAILED 失败"
        );
        return;
      }
    }
  }

  /** Appends the post-adaptation gate item to the evaluated environment checks. */
  private withAdapterCheck(
    envChecks: readonly PreflightCheckItem[],
    inputAdapterSucceeded: boolean
  ): readonly PreflightCheckItem[] {
    return [
      ...envChecks,
      { capability: "input_adapter_succeeded", ok: inputAdapterSucceeded }
    ];
  }

  /**
   * Persists the failed preflight report of a post-gate preparation failure
   * (the gate passed and the adaptation succeeded, but the Invocation Package
   * or prompt step failed afterwards): the report records all ten evaluated
   * checks (`input_adapter_succeeded` truthfully true) with `passed: false`.
   * A passed report is only ever persisted after the COMPLETE PREPARING
   * pipeline succeeded, so this failure never leaves a misleading passed
   * report behind.
   */
  private writePostAdapterFailureReport(
    attempt: RunAttempt,
    envChecks: readonly PreflightCheckItem[],
    preflight: Preflight
  ): boolean {
    return this.writePreflightReport(
      attempt,
      this.withAdapterCheck(envChecks, true),
      false,
      preflight.synthetic
    );
  }

  /**
   * Persists the redacted preflight report at `runtime/preflight-report.json`
   * (P5-1). Returns false when the write fails so the caller fails closed with
   * `PREFLIGHT_FAILED` — a report that cannot be written never blocks the
   * accurate terminal classification of the attempt.
   */
  private writePreflightReport(
    attempt: RunAttempt,
    checks: readonly PreflightCheckItem[],
    passed: boolean,
    synthetic: boolean
  ): boolean {
    try {
      const report: PreflightReport = buildPreflightReport({
        checks,
        passed,
        synthetic,
        checkedAt: this.nowIso()
      });
      this.workspace.writeOwnedFile({
        runId: attempt.runId,
        attemptSequence: attempt.attemptSequence,
        relativePath: "runtime/preflight-report.json",
        content: Buffer.from(JSON.stringify(report, null, 2), "utf8")
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Resolves the attempt's input source; any resolver failure resolves to null. */
  private safeResolveInputSource(runId: string): InputAdapterSource | null {
    try {
      return this.resolveInputSource?.(runId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Builds the frozen {@link AgentTurnInput} of the result phase (P5-3): the
   * Phase 4 result input plus the absolute attempt workspace root, the
   * controlled rendered prompt text (`runtime/prompt.md`), the absolute
   * derived Skill input image path (from the persisted Invocation Package)
   * and the Skill name + injected resolved path. A file that was never
   * produced (no Input Adapter configured) resolves to an empty string — the
   * deterministic fake adapter ignores the extras; a REAL turn adapter fails
   * the incomplete turn input closed as a structured protocol error.
   *
   * Phase 5 (P5-4): a RESUMED claim carries the strictly validated prior
   * technical session of the SAME attempt (`runtime/agent-session.json`,
   * loaded through the attempt workspace ledger) as `priorSession`, so the
   * Codex adapter issues `thread/resume` on the interrupted thread instead of
   * a fresh `thread/start`. A resumed claim WITHOUT a pinned, well-formed
   * session never passes one (see {@link loadPriorSession}).
   */
  private buildAgentTurnInput(
    attempt: RunAttempt,
    resultDefect: ArtifactDefect | undefined,
    layout: RunWorkspaceLayout,
    resumed: boolean,
    produceClarification: boolean
  ): AgentTurnInput {
    const snapshot = this.runs.getRunSnapshot(attempt.runId);
    return {
      runId: attempt.runId,
      attemptId: attempt.id,
      attemptSequence: attempt.attemptSequence,
      workspace: this.workspace,
      nowIso: () => this.nowIso(),
      recordMp4: this.recordMp4,
      ...(resultDefect === undefined ? {} : { resultDefect }),
      ...(produceClarification ? { produceClarification: true } : {}),
      priorSession: resumed ? this.loadPriorSession(attempt) : null,
      workspaceRoot: layout.absoluteRoot,
      promptText: this.readAttemptTextFile(attempt, "runtime/prompt.md") ?? "",
      localImageAbsolutePath: this.resolveDerivedImagePath(attempt, layout),
      skill: {
        name: snapshot.skill.name,
        // The fake executor has NO skill resolver (external skill resolution is
        // a later batch): the configured value is passed verbatim.
        resolvedPath: this.skillResolvedPath
      },
      ...(this.liveAgent && this.scenario === "success" && !produceClarification
        ? { onActivity: this.createLiveProgressObserver(attempt) }
        : {})
    };
  }

  /**
   * Publishes REAL, content-free progress while a live agent turn runs: the
   * stage moves ANALYZING -> MODELING once the runtime starts doing work, and
   * the percentage is an estimate derived from how much runtime activity has
   * been observed (it never reaches 100% — completion is owned by the
   * validated terminal event). Throttled; never throws into the turn.
   */
  private createLiveProgressObserver(attempt: RunAttempt): (update: AgentActivityUpdate) => void {
    const startedAt = Date.now();
    let lastEmitAt = 0;
    let lastPercent: number = LIVE_PROGRESS_FLOOR;
    let stage: RunStage = "ANALYZING";
    try {
      this.runs.appendRunEvents({
        runId: attempt.runId,
        attemptId: attempt.id,
        entries: [
          { payload: { type: "StageChanged", stage, activity: STAGE_ACTIVITIES.ANALYZING }, occurredAt: this.nowIso() },
          { payload: { type: "ProgressUpdated", progressPercent: lastPercent, activity: STAGE_ACTIVITIES.ANALYZING }, occurredAt: this.nowIso() }
        ]
      });
    } catch {
      // Advisory only.
    }
    return (update) => {
      try {
        const now = Date.now();
        if (now - lastEmitAt < LIVE_PROGRESS_MIN_INTERVAL_MS) return;
        const work = update.commandCount + update.fileChangeCount + update.toolCount;
        const entries: { payload: RunEventPayload; occurredAt: string }[] = [];
        const nextStage: RunStage = work > 0 ? "MODELING" : "ANALYZING";
        const percent = Math.max(
          lastPercent,
          Math.min(
            LIVE_PROGRESS_CEILING,
            Math.round(LIVE_PROGRESS_FLOOR + (LIVE_PROGRESS_CEILING - LIVE_PROGRESS_FLOOR) * (1 - Math.exp(-work / LIVE_PROGRESS_SCALE)))
          )
        );
        const seconds = Math.floor((now - startedAt) / 1000);
        const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        const activity = `${STAGE_ACTIVITIES[nextStage]} · 已收到 ${work + update.messageCount} 条运行事件 · 用时 ${elapsed}`;
        if (nextStage !== stage) {
          stage = nextStage;
          entries.push({ payload: { type: "StageChanged", stage, activity }, occurredAt: this.nowIso() });
        }
        lastPercent = percent;
        entries.push({ payload: { type: "ProgressUpdated", progressPercent: percent, activity }, occurredAt: this.nowIso() });
        lastEmitAt = now;
        this.runs.appendRunEvents({ runId: attempt.runId, attemptId: attempt.id, entries });
        this.renewLease(attempt);
      } catch {
        // Progress is advisory: a lost lease / closed run must not break the turn.
      }
    };
  }

  /**
   * Loads the prior technical session of a RESUMED attempt through the
   * attempt workspace ledger — the recovery scan re-issues the SAME attempt
   * (its persisted `runtime/agent-session.json` is the session of the
   * interrupted execution), identified deterministically by the persisted Run
   * id + attempt sequence. Absolute user-supplied paths are never read: the
   * ledger's strict containment guards the whole read.
   *
   * The returned session is NEVER trusted blindly: the strict store read
   * (`readAgentSessionRecord`) returns null for an absent or malformed
   * session, and the repo-pinned thread protocol is re-checked here
   * (defense in depth behind the recovery approval) — an unpinned session is
   * treated exactly like an absent one, so the adapter can only ever resume a
   * well-formed, pinned thread.
   */
  private loadPriorSession(attempt: RunAttempt): AgentSessionRecord | null {
    const session = readAgentSessionRecord(this.workspace, {
      runId: attempt.runId,
      attemptSequence: attempt.attemptSequence
    });
    if (session === null) return null;
    if (!isPinnedThreadSessionProtocol(session)) return null;
    return session;
  }

  /** Reads one attempt-scoped UTF-8 text file; null when absent/unreadable. */
  private readAttemptTextFile(
    attempt: RunAttempt,
    relativePath: string
  ): string | null {
    try {
      const file = this.workspace.readOwnedFile({
        runId: attempt.runId,
        attemptSequence: attempt.attemptSequence,
        relativePath
      });
      return file === null ? null : file.content.toString("utf8");
    } catch {
      return null;
    }
  }

  /**
   * Resolves the absolute path of the derived Skill input image from the
   * persisted Invocation Package (`runtime/invocation-package.json` ->
   * `input.imagePath`, attempt-root-relative). Empty string when the package
   * or its image path is unavailable/malformed.
   */
  private resolveDerivedImagePath(
    attempt: RunAttempt,
    layout: RunWorkspaceLayout
  ): string {
    const raw = this.readAttemptTextFile(attempt, "runtime/invocation-package.json");
    if (raw === null) return "";
    try {
      const packageValue = JSON.parse(raw) as { input?: { imagePath?: unknown } };
      const imagePath = packageValue.input?.imagePath;
      if (typeof imagePath === "string" && imagePath.length > 0) {
        return join(layout.absoluteRoot, imagePath);
      }
    } catch {
      // malformed package: no derived image path
    }
    return "";
  }

  /**
   * The result phase (P4-3 + P4-5, P5-3 async seam, Phase 5 terminal-state
   * dispatch) every successful walk ends with:
   *
   * 1. the Agent TURN ADAPTER settles with the discriminated terminal outcome
   *    — `completed` (raw record stream + the versioned Result Manifest /
   *    synthetic artifacts inside the attempt workspace) or `clarification`
   *    (runtime raw records + the strictly validated structured question set;
   *    no manifest claim, no artifact set) — `runTurn` is AWAITED (the async
   *    seam); a typed {@link AgentTurnError} (timeout / protocol / interrupt /
   *    runtime-unavailable) fails the Run with the ACCURATE code immediately —
   *    unless the user cancellation is already in flight (token.requested), in
   *    which case the cancel flow owns the terminal event and this path never
   *    writes a second one;
   * 2. the translator derives the validated Product Event payloads from the
   *    outcome's raw records (RuntimeMetadataUpdated / AgentTurnCompleted /
   *    ResultManifestReceived) and they are persisted — for BOTH outcomes
   *    FIRST; a protocol incompatibility fails the Run with
   *    AGENT_PROTOCOL_INCOMPATIBLE WITHOUT any raw reasoning content and
   *    without a manifest claim;
   * 3. then the outcome is dispatched:
   *    - `clarification` — the F5 fail-closed pre-CAD guard runs FIRST: the
   *      attempt's runtime ownership registry must be ABSENT (clarification
   *      must occur before any CAD / ownership registration); a present
   *      (valid or malformed) registry or a throwing read fails the Run with
   *      AGENT_PROTOCOL_INCOMPATIBLE (generic path-free message, workspace
   *      retained for manual inspection, nothing closed or cleaned) and
   *      otherwise the orchestrator's `clarifyAttempt` persists the OPEN
   *      request with the outcome's questions and appends the single
   *      ClarificationRequired event; ArtifactValidator and Model publication
   *      are NEVER touched. The raw stream of a clarification outcome carries
   *      NO `clarification_requested` record (the adapters never emit one), so
   *      the translator can never produce a second ClarificationRequired that
   *      would duplicate the orchestrator's;
   *    - `completed` — the INDEPENDENT artifact validator verifies the
   *      manifest document (schema/version), the safe workspace-relative
   *      manifest path, the required artifact set (existence, non-zero bytes,
   *      size, sha256, no links / no escape) and the declared rebuild minimum;
   *      ONLY a validator `ok` allows `completeAttempt` / the atomic Model
   *      publication — an Agent claim of completion is never authoritative. A
   *      rejection appends `ArtifactValidationFailed` with the accurate
   *      failure code first, then fails with the terminal code
   *      (missing/zero-byte/hash failures terminate as the pinned validation
   *      failure VALIDATION_REJECTED; manifest / path / rebuild rejections
   *      terminate with their accurate code).
   *
   * Terminal events stay orchestrator-owned on every path.
   */
  private async finalizeWithAgentResults(
    attempt: RunAttempt,
    resultDefect: ArtifactDefect | undefined,
    token: CancelToken,
    layout: RunWorkspaceLayout,
    resumed: boolean,
    options: { produceClarification?: boolean } = {}
  ): Promise<void> {
    let outcome: AgentTurnOutcome;
    try {
      outcome = await this.agent.runTurn(
        this.buildAgentTurnInput(
          attempt,
          resultDefect,
          layout,
          resumed,
          options.produceClarification === true
        )
      );
    } catch (error) {
      if (error instanceof AgentTurnError) {
        // A cooperative stop is already in flight: the cancel flow owns the
        // terminal event — NEVER a second one from the interrupted turn.
        if (token.requested) return;
        this.orchestrator.failAttempt({
          runId: attempt.runId,
          attemptId: attempt.id,
          ownerToken: this.orchestrator.ownerToken,
          failureCode: error.code,
          failureMessage: `Agent 结果回合失败（${error.code}），Run 已失败${error.detail === undefined ? "" : `：${error.detail}`}`
        });
        return;
      }
      // Other adapter exceptions stay inside the per-claim M2 boundary.
      throw error;
    }
    const translated = translateRawAgentRecords(outcome.records, { attemptId: attempt.id });
    if (!translated.ok) {
      // Stable structured failure; the raw reasoning content stays out of the
      // product stream and out of the failure message.
      this.orchestrator.failAttempt({
        runId: attempt.runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken,
        failureCode: RAW_PROTOCOL_FAILURE_CODE,
        failureMessage: "Agent 运行时输出与产品事件合同不兼容，Run 已失败"
      });
      return;
    }
    this.runs.appendRunEvents({
      runId: attempt.runId,
      attemptId: attempt.id,
      entries: translated.payloads.map((payload) => ({ payload, occurredAt: this.nowIso() }))
    });
    // The clarification terminal state: the orchestrator persists the OPEN
    // request + the SINGLE ClarificationRequired event and finishes the
    // attempt — no manifest exists, so ArtifactValidator / Model publication
    // are skipped entirely. The adapters' raw streams never carry a
    // `clarification_requested` record, so the translator above could never
    // have emitted a duplicate ClarificationRequired.
    //
    // F5 fail-closed pre-CAD guard: clarification must happen BEFORE any CAD /
    // ownership registration — the attempt's runtime ownership registry
    // (`runtime/solidworks-ownership.json`) must be ABSENT here. A present
    // (valid OR malformed) registry, or a registry read that throws, is a
    // controlled Agent protocol violation: the attempt fails with
    // AGENT_PROTOCOL_INCOMPATIBLE (generic path-free message, no
    // ClarificationRequired, no Result Manifest, no ArtifactValidator / Model
    // publication) and the workspace is retained for manual inspection — this
    // guard only DETECTS, it never cleans up or closes resources (a valid
    // registration does not prove the complete live state, and an invalid one
    // is untrusted).
    if (outcome.kind === "clarification") {
      if (!this.isClarificationPreCad(attempt)) {
        this.orchestrator.failAttempt({
          runId: attempt.runId,
          attemptId: attempt.id,
          ownerToken: this.orchestrator.ownerToken,
          failureCode: RAW_PROTOCOL_FAILURE_CODE,
          failureMessage:
            "Agent 在请求澄清前已注册 SolidWorks 所有权（澄清必须先于建模与所有权登记），违反协议顺序；Run 以 AGENT_PROTOCOL_INCOMPATIBLE 失败"
        });
        return;
      }
      this.orchestrator.clarifyAttempt({
        runId: attempt.runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken,
        questions: outcome.questions
      });
      return;
    }
    // completed: the validator independently reads the manifest file the EVENT
    // referenced; a stream without a manifest claim cannot be validated and
    // must not pass.
    const records = outcome.records;
    const manifestRef = lastManifestRef(records);
    if (manifestRef === null) {
      this.runs.appendRunEvents({
        runId: attempt.runId,
        attemptId: attempt.id,
        entries: [
          {
            payload: { type: "ArtifactValidationFailed", failureCode: "ARTIFACT_MANIFEST_INVALID" },
            occurredAt: this.nowIso()
          }
        ]
      });
      this.orchestrator.failAttempt({
        runId: attempt.runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken,
        failureCode: "ARTIFACT_MANIFEST_INVALID",
        failureMessage: "产物校验失败：Agent 未提交 Result Manifest"
      });
      return;
    }
    const validation = this.artifactValidator.validate({
      runId: attempt.runId,
      attemptSequence: attempt.attemptSequence,
      manifestRef,
      recordMp4Required: this.recordMp4
    });
    if (!validation.ok && validation.issue !== null) {
      this.runs.appendRunEvents({
        runId: attempt.runId,
        attemptId: attempt.id,
        entries: [
          {
            payload: { type: "ArtifactValidationFailed", failureCode: validation.issue.code },
            occurredAt: this.nowIso()
          }
        ]
      });
      // P4-5 accurate terminal codes: a manifest/path/rebuild rejection carries
      // its accurate code; a missing/zero-byte/hash rejection terminates as the
      // pinned validation failure (the ArtifactValidationFailed event already
      // recorded the accurate ARTIFACT_MISSING).
      const terminalCode =
        validation.issue.code === "ARTIFACT_MISSING" ? "VALIDATION_REJECTED" : validation.issue.code;
      this.orchestrator.failAttempt({
        runId: attempt.runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken,
        failureCode: terminalCode,
        failureMessage: validation.issue.message
      });
      return;
    }
    if (validation.ok) {
      // P5-2: the publication mode ends the Run by publishing a PENDING_REVIEW
      // Model atomically (Model + artifact metadata + Completed event with the
      // Model id + FINISHED attempt in ONE transaction), persisting EXACTLY the
      // validator's verified records. The legacy default stays model-less.
      if (this.publishModel) {
        this.orchestrator.publishModelPublication({
          runId: attempt.runId,
          attemptId: attempt.id,
          ownerToken: this.orchestrator.ownerToken,
          validation,
          finishedAt: this.nowIso()
        });
        return;
      }
      this.orchestrator.completeAttempt({
        runId: attempt.runId,
        attemptId: attempt.id,
        ownerToken: this.orchestrator.ownerToken
      });
    }
  }

  /**
   * F5 fail-closed pre-CAD clarification guard: reads the attempt's runtime
   * ownership registry (`runtime/solidworks-ownership.json`) through the
   * attempt workspace ledger and returns true ONLY when it is ABSENT —
   * clarification must occur before any CAD / ownership registration. A
   * present registry (valid or malformed) is a controlled Agent protocol
   * violation; a registry read that throws is treated the same (fail closed).
   * Nothing is cleaned up or closed here — this is detection only.
   */
  private isClarificationPreCad(attempt: RunAttempt): boolean {
    try {
      const registry = readSolidWorksOwnershipRegistry(
        {
          readOwnedFile: (input) => this.workspace.readOwnedFile(input)?.content ?? null
        },
        {
          runId: attempt.runId,
          attemptId: attempt.id,
          attemptSequence: attempt.attemptSequence
        }
      );
      return registry.status === "absent";
    } catch {
      return false;
    }
  }

  /** Stage index the resumed walk continues from (the Run's persisted stage). */
  private resumeIndex(runId: string, stages: readonly RunStage[]): number {
    const stage = this.runs.getRun(runId)?.stage ?? null;
    if (stage === null) return 0;
    const index = stages.indexOf(stage);
    return index === -1 ? 0 : index + 1;
  }

  /** Renews the attempt lease; a heartbeat failure aborts the claim loudly. */
  private renewLease(attempt: RunAttempt): void {
    this.orchestrator.renewAttemptLease({
      runId: attempt.runId,
      attemptId: attempt.id,
      ownerToken: this.orchestrator.ownerToken
    });
  }

  /** Scheduler yield between steps (manual schedulers control when it resumes). */
  private tick(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.scheduler.schedule(resolve, delayMs);
    });
  }

  /**
   * Resolves when the scheduled task OR the loop stop signal fires first. The
   * stop signal unwinds the loop at its current await, so `stop()` settles the
   * queue-loop promise without waiting for the next scheduled wake-up.
   */
  private raceStop<T>(task: Promise<T>): Promise<T | void> {
    return Promise.race([task, this.stopSignal]);
  }

  /**
   * Scripted hang: the claim stays stuck until the cooperative abort signal
   * (user cancel / Runner stop) resolves it — a cancellation terminates the
   * claim, so the queue settles and the next Run can execute.
   */
  private hangForever(signal: Promise<void>): Promise<void> {
    return signal;
  }

  // -------------------------------------------------------------------------
  // Cancel coordination
  // -------------------------------------------------------------------------

  /**
   * Bounded wait for the current claim to stop. Resolves `true` when the
   * claim actually finished, `false` when the scheduler timeout fired first
   * (hang / stale RUNNING Run with no live claim / a turn that ignores the
   * cooperative stop). A `false` result means the claim may still write — the
   * caller must never delete the workspace or confirm a cancellation.
   *
   * F2 hardening: a timeout result performs ONE same-tick post-race recheck
   * before returning false. The claim may have completed in the very same tick
   * the timeout task fired — its cooperative unwind spans several microtask
   * continuations (walkStages -> runScenario -> executeClaim's finally), so a
   * synchronous observation of the claim slot right here can still see the
   * claim "alive" even though its finally (which clears `activeClaim` /
   * `claimDone` and settles the watched `done`) is already queued in the same
   * tick. The recheck therefore re-waits on the claim's own `done` promise
   * against ONE zero-delay scheduler task: the settle wins when it lands in
   * this same tick, and the zero-delay task bounds the wait — never a second
   * full timeout, never an unbounded wait.
   */
  private async waitForClaimStop(): Promise<boolean> {
    const done = this.claimDone;
    if (done === null) return true;
    let timer: ScheduledTask | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = this.scheduler.schedule(() => resolve(false), this.cooperativeStopTimeoutMs);
    });
    const stopped = await Promise.race([done.then(() => true as const), timeout]);
    timer?.cancel();
    if (stopped) return true;
    let recheckTimer: ScheduledTask | undefined;
    const recheck = new Promise<false>((resolve) => {
      recheckTimer = this.scheduler.schedule(() => resolve(false), 0);
    });
    const resettled = await Promise.race([done.then(() => true as const), recheck]);
    recheckTimer?.cancel();
    return resettled;
  }

  /**
   * Deletes exactly the current Run/attempt workspace subtree ("already gone"
   * is success). Any other ledger failure is a cleanup failure: the
   * cancellation must not be confirmed.
   */
  private cleanAttemptWorkspace(runId: string, attemptSequence: number): boolean {
    try {
      this.workspace.deleteAttemptWorkspace(runId, attemptSequence);
      return true;
    } catch {
      return false;
    }
  }

  /** Canonical UTC ISO timestamp from the shared deterministic clock. */
  private nowIso(): string {
    const value = this.now();
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (!Number.isFinite(ms)) {
      throw new RunnerInvariantError("The injected clock returned a non-finite timestamp");
    }
    return new Date(ms).toISOString();
  }

  /** Millisecond epoch of the shared deterministic clock. */
  private nowMs(): number {
    const value = this.now();
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (!Number.isFinite(ms)) {
      throw new RunnerInvariantError("The injected clock returned a non-finite timestamp");
    }
    return ms;
  }
}

/**
 * The manifest reference of the LAST `result_manifest` raw record of the
 * adapter stream, or null when the stream carried no manifest claim. The
 * validator is pointed at exactly the path the ResultManifestReceived event
 * referenced.
 */
function lastManifestRef(records: readonly unknown[]): string | null {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (
      typeof record === "object" &&
      record !== null &&
      !Array.isArray(record) &&
      (record as Record<string, unknown>).type === "result_manifest" &&
      typeof (record as Record<string, unknown>).manifestRef === "string" &&
      ((record as Record<string, unknown>).manifestRef as string).length > 0
    ) {
      return (record as Record<string, unknown>).manifestRef as string;
    }
  }
  return null;
}

/** Error message extraction for unexpected claim failures (M2 boundary). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
