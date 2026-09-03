import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  revisionLabel,
  declaresSafeRecovery,
  type ClarificationAnswer,
  type ClarificationRequest,
  type CostDataSnapshot,
  type CostEstimateInputSnapshot,
  type FakeExecutorScenario,
  type InputAdapterScenario,
  type ModelingRun,
  type PreflightScenario,
  type RecoveryStatusSummary,
  type RunEvent,
  type RunInputSnapshot,
  type StorageSettings
} from "@swpanel/domain";
import type {
  ClarificationView,
  CostReportDetailView,
  CostReportListItemView,
  DrawingDetailView,
  DrawingHistoryView,
  ModelDetailView,
  RevisionDetailView,
  RevisionHistoryView,
  RunDetailView,
  RunListItemView,
  StorageSettingsView,
  WorkspaceDashboardView
} from "@swpanel/contracts";

import { SqliteDatabase } from "./db/database.js";
import { SqliteRepository } from "./db/repository.js";
import {
  RunRepository,
  type AppendRunEventsInput,
  type DeleteRunResult,
  type RunProfile
} from "./db/run-repository.js";
import {
  InvalidArgumentError,
  InvalidStorageSettingsError,
  RunnerError,
  SourceFileNotRegisteredError
} from "./errors.js";
import { DrawingFileLedger, DRAWING_MIME_TYPES } from "./ledger/drawing-file-ledger.js";
import { RunWorkspaceLedger } from "./ledger/run-workspace-ledger.js";
import {
  RunOrchestrator,
  type CompleteRunAttemptRequest,
  type FailRunAttemptRequest,
  type FinishRunAttemptRequest,
  type RecoveryScanResult,
  type RenewAttemptLeaseInput,
  type RunClaim,
  type RunRecoveryCapabilities
} from "./orchestration/run-orchestrator.js";
import {
  FakeExecutor,
  type CancelRunResult,
  type ExecutorScheduler,
  type SolidWorksOwnershipSurface
} from "./execution/fake-executor.js";
import type {
  SolidWorksOwnershipSurfaceContext
} from "./execution/ownership/workspace-solidworks-ownership-surface.js";
import type { RawAgentAdapter } from "./agent/fake-agent-adapter.js";
import type { AgentTurnAdapter } from "./agent/agent-turn-adapter.js";
import { readAgentSessionRecord } from "./agent/codex/agent-session.js";
import { CODEX_APP_SERVER_ADAPTER_ID } from "./agent/codex/codex-app-server-adapter.js";
import { threadSessionRecoveryCapabilities } from "./execution/recovery/thread-session-recovery-capabilities.js";
import type { ThreadSessionLike } from "./execution/recovery/thread-session-recovery.js";
import {
  DEFAULT_INPUT_ADAPTER_SCENARIO,
  type InputAdapter,
  type InputAdapterSource
} from "./adaptation/input-adapter.js";
import {
  DEFAULT_PREFLIGHT_SCENARIO,
  FAKE_PREFLIGHT_SKILL_SHA256,
  type Preflight
} from "./preflight/preflight.js";
import { PROMPT_TEMPLATE_VERSION } from "./adaptation/prompt-template.js";
import {
  DrawingWorkflowService,
  type AddModelingFeedbackInput,
  type AddRevisionFactInput,
  type AddRevisionInput,
  type DeleteRevisionInput,
  type ImportDrawingInput,
  type SetCurrentRevisionInput
} from "./service/drawing-workflow-service.js";
import {
  ModelWorkflowService,
  type ReviewModelInput
} from "./service/model-workflow-service.js";
import { CostWorkflowService } from "./service/cost-workflow-service.js";

export interface RunnerConfig {
  /** Absolute path of the SQLite database file (default `{dataRoot}/state/swpanel.db`). */
  dbPath?: string;
  /** SQLite busy timeout in milliseconds. */
  busyTimeoutMs?: number;
  /**
   * Runner-owned values pinned into every frozen Run Input Snapshot (prompt
   * template version, Skill identity + hash, agent/model config id). Required
   * before `createRun` can freeze a snapshot.
   */
  runProfile?: RunProfile;
  /**
   * Injected clock of the Run orchestration (Phase 3, P3-2). Defaults to the
   * wall clock; tests inject a deterministic one.
   */
  now?: () => Date;
  /** Lease length of claimed Run attempts in milliseconds. */
  leaseDurationMs?: number;
  /**
   * Injected recovery proofs consulted by the expired-lease recovery scan.
   * Absent capabilities refuse every resume (conservative default). When the
   * Fake Executor scenario is configured for the test harness, the default
   * instead consults `declaresSafeRecovery(scenario)`: only the
   * `recovery-supported` scenario proves interrupted work resumable.
   */
  recoveryCapabilities?: RunRecoveryCapabilities;
  /**
   * Deterministic scenario matrix of the Fake Executor (Phase 3, P3-3).
   * Scenario selection exists ONLY at Runner construction / test harness
   * configuration — the production Renderer and IPC payloads never carry an
   * arbitrary scenario; the normal product path is the default `success`
   * scenario (all six stages in order, COMPLETED without a Model).
   */
  fakeExecutorScenario?: FakeExecutorScenario;
  /**
   * Injectible scheduler of the Fake Executor. The production default
   * schedules on the wall clock; deterministic tests inject a manual scheduler
   * and share its clock (`scheduler.now`) with the orchestration.
   */
  scheduler?: ExecutorScheduler;
  /** Bounded wait for a cooperative stop during RUNNING cancellation. */
  cooperativeStopTimeoutMs?: number;
  /**
   * Wall-clock delay between Fake Executor scenario steps in milliseconds
   * (default 0 = instant steps). Only Runner construction / test harness
   * configuration may set it — the production Renderer and IPC payloads never
   * carry a step delay; E2E harnesses use it so the UI can observe every
   * stage transition of the default success script deterministically.
   */
  fakeExecutorStepDelayMs?: number;
  /**
   * Deterministic scenario matrix of the Input Adapter (Phase 4, P4-1).
   * Scenario selection exists ONLY at Runner construction / test harness
   * configuration — the production Renderer and IPC payloads never carry one;
   * the normal product path is the default `single-page-pdf` scenario, which
   * adapts the immutable original drawing at PREPARING (derived image +
   * provenance + Invocation Package inside the attempt workspace) and fails
   * closed on any structured conversion failure.
   */
  inputAdapterScenario?: InputAdapterScenario;
  /**
   * Phase 5 (Batch E): the injected real Input Adapter boundary (e.g. the
   * {@link RealPdfInputAdapter} over an injected {@link PdfRasterizer}).
   * Runner construction / test-harness configuration only — the production
   * Renderer and IPC payloads never carry an adapter. When provided it
   * overrides `inputAdapterScenario` exactly like the executor-level injection
   * (the scenario convenience is ignored); an explicit `null` disables
   * adaptation and is rejected while the preflight gate is active (the ninth
   * capability could never be marked truthfully). The product default keeps
   * the deterministic fake `single-page-pdf` scenario.
   */
  inputAdapter?: InputAdapter | null;
  /**
   * Deterministic scenario matrix of the preflight capability gate (Phase 5,
   * P5-1). Scenario selection exists ONLY at Runner construction / test
   * harness configuration — the production Renderer and IPC payloads never
   * carry one; the normal product path is the default `all-pass` scenario,
   * which runs the EXPLICITLY synthetic/unverified probe fixture at PREPARING
   * (eight environment capabilities fail-fast before input adaptation, the
   * redacted report is persisted at `runtime/preflight-report.json`, and
   * `input_adapter_succeeded` is marked only after the adaptation succeeds).
   * The gate is ALWAYS active in the Runner: a Run can never leave PREPARING
   * ungated, and the 0*64 placeholder skill hash never passes.
   */
  preflightScenario?: PreflightScenario;
  /**
   * Phase 5 (Batch D): the injected REAL preflight gate (e.g. a
   * {@link PreflightGate} over the {@link RealPreflightProbe}). Runner
   * construction / test-harness configuration only — the production Renderer
   * and IPC payloads never carry a gate. When provided it overrides
   * `preflightScenario` exactly like the executor-level injection; the
   * product default keeps the deterministic synthetic all-pass fixture (the
   * default path stays `synthetic: true` and never pretends the real probes
   * pass). An explicit `null` means "no injection" and the deterministic
   * synthetic scenario applies — the gate itself is ALWAYS active in the
   * Runner and can never be disabled.
   */
  preflight?: Preflight | null;
  /**
   * Phase 5 (P5-4): the ownership-safe SolidWorks cancellation boundary of the
   * Fake Executor. Absent by default at this level — the Runner has no
   * SolidWorks process surface yet, so cancellation behaves exactly as before.
   * Injection is Runner construction / test-harness configuration only (no
   * product UI or IPC control ever carries it).
   */
  ownership?: SolidWorksOwnershipSurface | null;
  /**
   * Phase 5 (P5-4 / Batch 2): constructs the ownership-safe cancellation
   * surface of the LIVE seam (e.g. the workspace-backed
   * {@link WorkspaceSolidWorksOwnershipSurface} over the bounded document
   * closer) from the Runner-bound runtime context. The surface needs the
   * persisted run stage, the active attempt binding and the attempt workspace
   * ledger — all of which only exist AFTER `open()`, so the Runner calls this
   * factory exactly once at open() with the real seams bound. When
   * `ownership` is provided it wins and the factory is never consulted;
   * absent (default) keeps the synthetic/default path unchanged (no
   * ownership, cancellation exactly as before). Runner construction /
   * test-harness configuration only.
   */
  buildOwnershipSurface?: (
    context: SolidWorksOwnershipSurfaceContext
  ) => SolidWorksOwnershipSurface | null;
  /**
   * Phase 5 (P5-2): when true the success path publishes a PENDING_REVIEW
   * Model atomically through the orchestrator (Model + artifact metadata rows
   * + Completed event with the Model id + FINISHED attempt in ONE
   * transaction). The Runner product default is TRUE — every real Runner
   * success publishes a Model. Set it explicitly to `false` only for Phase 3/4
   * model-less compatibility scenarios (legacy isolated FakeExecutor
   * constructions keep their own model-less default).
   */
  publishModel?: boolean;
  /**
   * Phase 5 (P5-4): the Agent turn adapter of the Fake Executor (a legacy
   * synchronous {@link RawAgentAdapter} is wrapped). Runner construction /
   * test-harness configuration only — the production Renderer and IPC
   * payloads never carry one; absent (default) keeps the deterministic Fake
   * Agent Adapter and the scenario-based recovery capability. When a Codex
   * adapter (`adapterId === "codex-app-server"`) is configured, the default
   * recovery capability becomes the PROTOCOL-PINNED thread-session proof
   * ({@link threadSessionRecoveryCapabilities} over the persisted
   * `runtime/agent-session.json` read through the open run workspace ledger)
   * instead of the Fake-scenario declaration — an interrupted low-stage
   * attempt resumes ONLY with a pinned, well-formed session; everything else
   * is refused truthfully.
   */
  agent?: RawAgentAdapter | AgentTurnAdapter;
  /**
   * Batch C lifecycle: whether the Runner's executor OWNS the configured
   * `agent` adapter. `true` — the executor closes the adapter (a live Codex
   * child process is terminated, bounded and never orphaned) whenever the
   * Runner closes, EVEN if no queue loop ever started. `false` (default for
   * an injected adapter) — the adapter is caller-owned and the executor never
   * closes it, so a caller-injected adapter can be reused across Runner
   * open/close cycles. The executor-created default FakeAgentAdapter is
   * always owned. Passed through to `FakeExecutorOptions.ownsAgent`.
   */
  ownsAgent?: boolean;
  /**
   * Phase 5 (P5-3): the resolved absolute path of the modeling Skill the
   * configured turn adapter must invoke. The Runner has NO skill resolver yet
   * (external resolution stays a later batch) — the value is passed verbatim
   * into every turn input; absent (default) is empty and only the fake
   * adapter (which ignores it) can be used. Construction / test-harness
   * configuration only.
   */
  skillResolvedPath?: string;
  /**
   * The authoritative SolidWorks version attested for every attempt (e.g. the
   * live SolidWorks probe snapshot of the Desktop main live branch). A
   * non-empty value is forwarded to the Fake Executor, which hands it to the
   * DEFAULT artifact validator (fail closed with ARTIFACT_MANIFEST_INVALID
   * before artifact reads unless the Agent's `solidWorksVersion` EXACTLY
   * matches) and renders it into the controlled prompt so the Agent records
   * the exact version instead of guessing. Absent (or empty) keeps the
   * version-agnostic synthetic/default behavior unchanged.
   */
  expectedSolidWorksVersion?: string;
}

/**
 * Application facade of the Agent Runner. Opens the SQLite WAL store and the
 * immutable drawing file ledger under one data root, seeds the storage
 * settings, and exposes the Drawing workflow service plus the repository reader
 * surface. Phase 3 adds the Run capabilities on top of the same store: the Run
 * repository (atomic create + frozen snapshot, aggregate reads, transactional
 * event projection, clarification persistence), the orchestration primitives
 * (atomic claim, lease heartbeat, attempt finish, expired-lease recovery), the
 * serial Fake Executor queue, and the after-commit event stream that powers the
 * IPC subscriptions. The Runner is the sole database writer; the Electron
 * bridge and renderer run pages land in later batches.
 */

/**
 * Canonical Runner-pinned run profile used when no profile is injected (the
 * production default). The Runner freezes these exact version values into every
 * Run Input Snapshot at creation time — the Renderer never supplies them. The
 * prompt template version is the controlled Phase 5 (P5) template version
 * (the Phase 4 P4-2 template plus the Final Turn Contract).
 *
 * The pinned skill hash is the SYNTHETIC preflight fixture digest (P5-1): the
 * deterministic synthetic gate only ever "verifies" against its fixture record
 * and every report is marked `synthetic` — this is NOT production verification
 * of the external skill digest. The explicit 0*64 placeholder NEVER passes the
 * gate (a placeholder must never be silently treated as a verified hash); real
 * skill-hash verification against the external environment is a later batch.
 */
export const DEFAULT_RUN_PROFILE: RunProfile = Object.freeze({
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  skill: {
    name: "solidworks-autobuild",
    sha256: FAKE_PREFLIGHT_SKILL_SHA256
  },
  agentConfigId: "codex-app-server"
});

export class Runner {
  private readonly config: Required<Pick<RunnerConfig, "busyTimeoutMs">> & RunnerConfig;
  private readonly db: SqliteDatabase;
  private readonly repository: SqliteRepository;
  private readonly runRepository: RunRepository;
  private readonly orchestrator: RunOrchestrator;
  private readonly ledger: DrawingFileLedger;
  private readonly workflow: DrawingWorkflowService;
  private readonly modelWorkflow: ModelWorkflowService;
  private readonly costWorkflow: CostWorkflowService;
  private readonly now: () => Date;
  private readonly sourceFiles = new Map<string, string>();
  private runWorkspace: RunWorkspaceLedger | null = null;
  private executor: FakeExecutor | null = null;
  private lastRecoveryScan: RecoveryScanResult | null = null;
  private opened = false;

  constructor(
    readonly dataRoot: string,
    config: RunnerConfig = {}
  ) {
    if (typeof dataRoot !== "string" || dataRoot.trim().length === 0) {
      throw new InvalidArgumentError("dataRoot must be a non-empty path");
    }
    this.config = { ...config, busyTimeoutMs: config.busyTimeoutMs ?? 5_000 };
    this.now = config.now ?? config.scheduler?.now ?? (() => new Date());
    this.db = new SqliteDatabase({
      dbPath: this.config.dbPath ?? join(dataRoot, "state", "swpanel.db"),
      busyTimeoutMs: this.config.busyTimeoutMs
    });
    this.repository = new SqliteRepository(this.db);
    this.runRepository = new RunRepository(this.db, this.repository);
    this.orchestrator = new RunOrchestrator(this.db, this.runRepository, {
      now: this.now,
      ...(config.leaseDurationMs === undefined ? {} : { leaseDurationMs: config.leaseDurationMs }),
      recoveryCapabilities: this.resolveRecoveryCapabilities(config)
    });
    this.ledger = new DrawingFileLedger({ dataRoot });
    this.workflow = new DrawingWorkflowService(this.repository, this.ledger, this.runRepository);
    this.modelWorkflow = new ModelWorkflowService(this.repository, this.runRepository);
    this.costWorkflow = new CostWorkflowService(this.repository, this.runRepository);
  }

  open(): void {
    if (this.opened) return;
    mkdirSync(this.dataRoot, { recursive: true });
    this.db.open();
    this.ledger.open();
    try {
      this.db.transaction(() => {
        const now = new Date().toISOString();
        const settings = this.repository.readStorageSettings();
        if (settings === null) {
          this.repository.seedStorageSettings({
            dataRoot: this.dataRoot,
            workspaceRoot: join(this.dataRoot, "workspaces"),
            updatedAt: now
          });
        } else {
          this.validateSettingsDataRoot(settings, this.dataRoot);
        }
      });
    } catch (error) {
      // Do not leak the database connection or the ledger when the open
      // sequence fails (e.g. settings validation).
      this.ledger.close();
      this.db.close();
      throw error;
    }
    try {
      // The isolated Run workspace ledger is anchored to the persisted
      // workspace root (seeded or already present after the block above).
      const settings = this.repository.readStorageSettings();
      this.runWorkspace = new RunWorkspaceLedger({
        workspaceRoot: settings?.workspaceRoot ?? join(this.dataRoot, "workspaces")
      });
      this.runWorkspace.open();
    } catch (error) {
      this.ledger.close();
      this.db.close();
      this.runWorkspace = null;
      throw error;
    }
    // Startup recovery: expired-lease attempts and wedged RUNNING Runs are
    // reconsidered the moment the Runner opens (capabilities were injected at
    // construction). Per-candidate failures are isolated inside the scan; an
    // unexpected scan-level failure still closes the resources this open
    // sequence already acquired before it propagates.
    try {
      this.lastRecoveryScan = this.orchestrator.recoverExpiredAttempts();
    } catch (error) {
      this.runWorkspace?.close();
      this.runWorkspace = null;
      this.ledger.close();
      this.db.close();
      throw error;
    }
    // The first-class Fake Executor / coordinator (Phase 3, P3-3) is bound to
    // the opened workspace ledger. Scenario selection came from construction
    // config; the default product path is the deterministic `success` scenario.
    // Phase 4 (P4-1): the Input Adapter is active by default at PREPARING with
    // the deterministic `single-page-pdf` scenario; the injected resolver maps
    // the frozen snapshot's original file to the verified immutable ledger
    // copy (an unresolvable source fails the Run closed).
    this.executor = new FakeExecutor({
      orchestrator: this.orchestrator,
      runs: this.runRepository,
      workspace: this.runWorkspace,
      scenario: this.config.fakeExecutorScenario ?? "success",
      now: this.now,
      ...(this.config.scheduler === undefined ? {} : { scheduler: this.config.scheduler }),
      ...(this.config.cooperativeStopTimeoutMs === undefined
        ? {}
        : { cooperativeStopTimeoutMs: this.config.cooperativeStopTimeoutMs }),
      ...(this.config.fakeExecutorStepDelayMs === undefined
        ? {}
        : { stepDelayMs: this.config.fakeExecutorStepDelayMs }),
      inputAdapterScenario: this.config.inputAdapterScenario ?? DEFAULT_INPUT_ADAPTER_SCENARIO,
      ...(this.config.inputAdapter === undefined
        ? {}
        : { inputAdapter: this.config.inputAdapter }),
      preflightScenario: this.config.preflightScenario ?? DEFAULT_PREFLIGHT_SCENARIO,
      ...(this.config.preflight === undefined
        ? {}
        : { preflight: this.config.preflight }),
      // The Runner product default publishes a Model; only an explicit `false`
      // keeps the Phase 3/4 model-less completion.
      publishModel: this.config.publishModel ?? true,
      // The LIVE ownership surface is constructed exactly once here, with the
      // real seams bound (persisted stage, active attempt binding, attempt
      // workspace root + guarded reads): the surface cannot exist before the
      // ledger/repository are open. An injected `ownership` wins; absent
      // factory keeps the synthetic default (no ownership) unchanged.
      ...(this.config.ownership === undefined && this.config.buildOwnershipSurface === undefined
        ? {}
        : {
            ownership:
              this.config.ownership === undefined
                ? this.config.buildOwnershipSurface!(this.bindOwnershipSurfaceContext())
                : this.config.ownership
          }),
      ...(this.config.agent === undefined ? {} : { agent: this.config.agent }),
      ...(this.config.ownsAgent === undefined ? {} : { ownsAgent: this.config.ownsAgent }),
      ...(this.config.skillResolvedPath === undefined
        ? {}
        : { skillResolvedPath: this.config.skillResolvedPath }),
      ...(this.config.expectedSolidWorksVersion === undefined
        ? {}
        : { expectedSolidWorksVersion: this.config.expectedSolidWorksVersion }),
      resolveInputSource: (runId) => this.resolveInputSource(runId)
    });
    // Startup recovery (P3-2 / F2): start the serial queue loop whenever a
    // previous process left recoverable work behind — an ACTIVE attempt whose
    // lease is still live (a quick restart inside the lease, reconsidered at
    // its deadline) OR QUEUED Runs waiting for a claim (restarted queues drain
    // without needing a new `run.create`). The loop self-terminates when
    // drained (no QUEUED Run and no future lease deadline) and errors never
    // fail the open: recovery owns the aftermath. Every `run.create` wakes the
    // loop through the request handler — `runQueue` is re-entrant.
    if (
      this.orchestrator.nextActiveLeaseDeadline() !== null ||
      this.orchestrator.hasQueuedRuns()
    ) {
      void this.executor.runQueue().catch((error: unknown) => {
        void error;
      });
    }
    this.opened = true;
  }

  /**
   * Synchronous close: identical resource teardown to {@link Runner.shutdown},
   * without awaiting the executor stop. The stop is kicked off and settles in
   * the background (the in-flight claim unwinds as an unexpected interruption,
   * an OWNED live agent adapter is closed even if the queue never started).
   * Awaitable callers — RunnerHost.close, process shutdown — MUST use
   * {@link Runner.shutdown} so no Codex child process outlives the close.
   */
  close(): void {
    void this.shutdown();
  }

  /**
   * Explicit async shutdown seam (Batch C lifecycle). Stops the executor —
   * settling the queue-loop promise and closing an OWNED live agent (an
   * eagerly spawned CodexChildTransport child process is terminated, bounded
   * and idempotent, never orphaned) EVEN when the queue never started — and
   * tears down the run workspace ledger, drawing ledger and database exactly
   * once. The resource teardown is synchronous (a same-tick reopen stays
   * safe); the returned promise settles when the executor's stop finished, so
   * the caller (e.g. RunnerHost.close) can hold process exit until no Codex
   * child is left behind. Idempotent: every call fires the stop of the then
   * current executor and runs the (internally guarded) resource teardown.
   */
  shutdown(): Promise<void> {
    // Stopping the executor mid-claim is an unexpected interruption: the
    // attempt is left ACTIVE without a terminal event and the next open's
    // recovery scan classifies it FAILED / INTERRUPTED — never CANCELLED.
    // `FakeExecutor.stop()` is awaitable and settles the queue-loop promise
    // and releases an OWNED agent turn adapter's runtime resources (Batch C:
    // a live Codex child process is terminated, bounded and idempotent, never
    // orphaned — even when no queue loop ever started — see
    // `FakeExecutor.stop()`); `close()` stays synchronous and lets the loop
    // unwind on its own.
    const executor = this.executor;
    this.executor = null;
    let stopping: Promise<void>;
    if (executor === null) {
      stopping = Promise.resolve();
    } else {
      // The stop signal is fired synchronously; the promise is awaited by
      // shutdown() callers and never leaves an unhandled rejection.
      stopping = Promise.resolve(executor.stop()).then(
        () => {},
        () => {}
      );
    }
    this.runWorkspace?.close();
    this.runWorkspace = null;
    this.ledger.close();
    this.db.close();
    this.lastRecoveryScan = null;
    this.opened = false;
    return stopping;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** MIME type mapping of the allowlisted drawing formats. */
  static readonly DRAWING_MIME_TYPES = DRAWING_MIME_TYPES;

  /** Name of the drawing library directory relative to the data root. */
  static readonly drawingLibraryRelativeDir = DrawingFileLedger.libraryRelativeDir;

  /** Structured storage settings currently persisted. */
  getStorageSettings(): StorageSettingsView {
    return this.repository.getStorageSettings();
  }

  /** Lists drawings only after validating every immutable source file. */
  getDrawingList(): readonly import("@swpanel/contracts").DrawingListItemView[] {
    for (const drawingId of this.repository.listDrawingIds()) this.verifyDrawingLedgerFiles(drawingId);
    return this.repository.getWorkspaceDashboard().recentDrawings;
  }

  /**
   * Persists storage settings. Changing the data root is rejected: moving the
   * data root is a controlled application use case (ADR-002), not a raw setting
   * edit, and the SQLite database + ledger are opened under the fixed root.
   */
  updateStorageSettings(settings: StorageSettings): void {
    if (settings.dataRoot !== this.dataRoot) {
      throw new InvalidStorageSettingsError(
        `Storage settings data root (${settings.dataRoot}) differs from the opened data root (${this.dataRoot}); moving the data root is a controlled application use case (ADR-002)`,
        { attemptedDataRoot: settings.dataRoot, openedDataRoot: this.dataRoot }
      );
    }
    this.repository.saveStorageSettings(settings);
  }

  // -------------------------------------------------------------------------
  // Drawing workflow use cases
  // -------------------------------------------------------------------------

  importDrawing(input: ImportDrawingInput) {
    return this.workflow.importDrawing(input);
  }

  addRevision(input: AddRevisionInput) {
    return this.workflow.addRevision(input);
  }

  setCurrentRevision(input: SetCurrentRevisionInput) {
    return this.workflow.setCurrentRevision(input);
  }

  /** Conservative non-current-Revision deletion (whole-Drawing deletion is out of scope). */
  deleteRevision(input: DeleteRevisionInput) {
    return this.workflow.deleteRevision(input);
  }

  addRevisionFact(input: AddRevisionFactInput) {
    return this.workflow.addRevisionFact(input);
  }

  addModelingFeedback(input: AddModelingFeedbackInput) {
    return this.workflow.addModelingFeedback(input);
  }

  // -------------------------------------------------------------------------
  // Model workflow use cases (Phase 6, P6-*)
  // -------------------------------------------------------------------------

  /**
   * Performs a human review of one PENDING_REVIEW Model atomically (Review row
   * + status transition + approved pointer / rejected feedback in ONE
   * transaction) and returns the refreshed Model detail. A Model can be
   * reviewed exactly once; a rejected Model requires a new Modeling Run.
   */
  reviewModel(input: ReviewModelInput): ModelDetailView {
    return this.modelWorkflow.reviewModel(input);
  }

  /** Aggregate read of one Model (head, published artifacts, review history). */
  getModelDetail(modelId: string): ModelDetailView {
    return this.modelWorkflow.getModelDetail(modelId);
  }

  // -------------------------------------------------------------------------
  // History reads
  // -------------------------------------------------------------------------

  getDrawingDetail(drawingId: string): DrawingDetailView {
    this.verifyDrawingLedgerFiles(drawingId);
    return this.repository.getDrawingDetail(drawingId);
  }

  getDrawingHistory(drawingId: string): DrawingHistoryView {
    this.verifyDrawingLedgerFiles(drawingId);
    return this.repository.getDrawingHistory(drawingId);
  }

  getRevisionDetail(drawingId: string, revisionId: string): RevisionDetailView {
    this.verifyRevisionLedgerFile(drawingId, revisionId);
    const detail = this.repository.getRevisionDetail(drawingId, revisionId);
    // Phase 3 (P3-1): the Revision detail Run list now reads real Runs.
    // Phase 6: the Model list reads real published Models.
    return {
      ...detail,
      runs: this.runRepository.listRunItemsByRevision(revisionId),
      models: this.runRepository.listModelsByRevision(revisionId)
    };
  }

  getRevisionHistory(drawingId: string, revisionId: string): RevisionHistoryView {
    this.verifyRevisionLedgerFile(drawingId, revisionId);
    return this.repository.getRevisionHistory(drawingId, revisionId);
  }

  /** Fails reads with the same structured ledger error used by integrity checks. */
  private verifyDrawingLedgerFiles(drawingId: string): void {
    for (const revision of this.repository.listDrawingRevisions(drawingId)) {
      this.verifyRevisionSourceFile(revision);
    }
  }

  private verifyRevisionLedgerFile(drawingId: string, revisionId: string): void {
    const revision = this.repository
      .listDrawingRevisions(drawingId)
      .find((candidate) => candidate.id === revisionId);
    if (revision === undefined) {
      // Preserve the repository's canonical NOT_FOUND response for unknown ids.
      this.repository.getRevisionDetail(drawingId, revisionId);
      return;
    }
    this.verifyRevisionSourceFile(revision);
  }

  private verifyRevisionSourceFile(revision: import("@swpanel/domain").DrawingRevision): void {
    const absolutePath = this.ledger.toAbsolute(revision.sourceFile.relativePath);
    const result = this.ledger.verifyStoredFile(
      absolutePath,
      revision.sourceFile.relativePath,
      revision.sourceFile.sizeBytes,
      revision.sourceFile.sha256
    );
    if (!result.ok) throw result.error;
  }

  getWorkspaceDashboard(): WorkspaceDashboardView {
    const base = this.repository.getWorkspaceDashboard();
    // Phase 3 (P3-1): the dashboard's current-Run and queue fields now read
    // real persisted Runs. Phase 6: the pending-review queue reads real
    // PENDING_REVIEW Models.
    return {
      ...base,
      currentRun: this.runRepository.getCurrentRunDetail(),
      queuedRunLabels: this.runRepository.getQueuedRunLabels(),
      pendingReviews: this.runRepository.listPendingReviewItems()
    };
  }

  /** Effective cost data snapshot (Phase 7). */
  getEffectiveCostData(): CostDataSnapshot {
    return this.costWorkflow.getEffectiveCostData();
  }

  /** Updates company-global cost data basis (Phase 7). */
  updateCostData(snapshot: CostDataSnapshot): CostDataSnapshot {
    return this.costWorkflow.updateCostData(snapshot);
  }

  /** Gets cost report detail by report ID (Phase 7). */
  getCostReportDetail(reportId: string): CostReportDetailView {
    return this.costWorkflow.getCostReportDetail(reportId);
  }

  /** Lists all cost reports for a revision (Phase 7). */
  listCostReportsByRevision(drawingId: string, revisionId: string): readonly CostReportListItemView[] {
    return this.costWorkflow.listCostReportsByRevision(drawingId, revisionId);
  }

  /** Creates a new Cost Estimate Report (Phase 7). */
  createCostReport(input: CostEstimateInputSnapshot, createdAt: string): CostReportDetailView {
    return this.costWorkflow.createCostReport(input, createdAt);
  }

  /** Deletes ONE Cost Estimate Report of its owning Revision (Phase 8). */
  deleteCostReport(costReportId: string, revisionId: string): { costReportId: string } {
    return this.costWorkflow.deleteCostReport(costReportId, revisionId);
  }

  /** Number of persisted Modeling Runs (0 until the first `createRun`). */
  getRunCount(): number {
    return this.workflow.getRunCount();
  }

  // -------------------------------------------------------------------------
  // Run application surface (Phase 3, P3-1)
  // -------------------------------------------------------------------------

  /**
   * Creates a QUEUED Run for the drawing/revision pair. The Renderer submits
   * ONLY this identity pair; the Runner freezes the Input Snapshot inside the
   * repository transaction from the persisted Revision, Facts, Feedback and its
   * own run profile.
   */
  createRun(input: { drawingId: string; revisionId: string }): ModelingRun {
    const profile = this.requireRunProfile();
    return this.runRepository.createRun({
      drawingId: input.drawingId,
      revisionId: input.revisionId,
      profile,
      createdAt: new Date().toISOString()
    });
  }

  /** Aggregate read of one Run: read model + ordered events + last sequence. */
  getRunDetail(runId: string): RunDetailView {
    return this.runRepository.getRunDetail(runId);
  }

  /** Every persisted Run, newest first (the workspace-wide Run list). */
  getRunList(): readonly RunListItemView[] {
    return this.runRepository.listAllRunItems();
  }

  /** The frozen Input Snapshot of one Run (fresh object graph per read). */
  getRunSnapshot(runId: string): RunInputSnapshot {
    return this.runRepository.getRunSnapshot(runId);
  }

  /** Appends events with DB-allocated sequences and transactional projection. */
  appendRunEvents(input: AppendRunEventsInput) {
    return this.runRepository.appendRunEvents(input);
  }

  /**
   * Ordered persisted event backlog of one Run starting at `fromSequence`
   * (inclusive). Throws a structured NOT_FOUND for unknown Runs, so a
   * subscription can never silently attach to a phantom Run.
   */
  listRunEventsFrom(runId: string, fromSequence: number): readonly RunEvent[] {
    return this.runRepository.listRunEventsFrom(runId, fromSequence);
  }

  /**
   * Registers an event-stream notification hook (Phase 3, P3-4): the listener
   * receives every appended event batch ONLY after its enclosing write
   * transaction committed — never for a rolled-back batch. Returns an
   * unsubscribe function.
   */
  subscribeRunEventCommits(listener: (events: readonly RunEvent[]) => void): () => void {
    return this.runRepository.addRunEventsCommittedListener(listener);
  }

  /**
   * Aggregate read of one Clarification Request (with its persisted answers),
   * or a structured NOT_FOUND.
   */
  getClarificationView(clarificationRequestId: string): ClarificationView {
    return this.runRepository.getClarificationView(clarificationRequestId);
  }

  /**
   * Persists submitted answers of an OPEN Clarification Request and marks it
   * ANSWERED in ONE transaction. The referenced Run stays terminal
   * (CLARIFICATION_REQUIRED) and is NEVER resumed: a new Run is created for
   * any follow-up modeling instead.
   */
  submitClarificationAnswers(input: {
    clarificationRequestId: string;
    answers: readonly ClarificationAnswer[];
    answeredAt: string;
    answeredBy: string;
  }): ClarificationView {
    return this.runRepository.submitClarificationAnswers(input);
  }

  /**
   * Deletes ONE terminal Run (COMPLETED / FAILED / CANCELLED) that belongs to
   * the exact drawing/revision identity pair. The database transaction removes
   * the Run's events, clarification items, frozen input snapshot, attempts,
   * artifact records and any Model it published (clearing the Revision's
   * approved-Model pointer when the Model was current-approved). Active Runs
   * (QUEUED / RUNNING) are rejected with `RUN_NOT_TERMINAL`; a
   * CLARIFICATION_REQUIRED Run is refused because its outstanding clarification
   * session is still the user's responsibility. After the transaction commits,
   * every attempt's isolated workspace subtree is removed via the run workspace
   * ledger (an already-missing workspace is "already gone").
   */
  deleteRun(runId: string, drawingId: string, revisionId: string): DeleteRunResult {
    const deleted = this.runRepository.deleteRun(runId, drawingId, revisionId);
    if (this.runWorkspace !== null) {
      for (const attemptSequence of deleted.attemptSequences) {
        this.runWorkspace.deleteAttemptWorkspace(runId, attemptSequence);
      }
    }
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Run orchestration facade (Phase 3, P3-2)
  // -------------------------------------------------------------------------

  /**
   * The atomic claim (P3-2) is the ONLY path to RUNNING: it mints the
   * persisted ACTIVE attempt in the same transaction as the QUEUED -> RUNNING
   * transition, so a RUNNING Run can never exist without a live attempt.
   */
  claimNextQueuedRun(): RunClaim | null {
    return this.orchestrator.claimNextQueuedRun();
  }

  /**
   * Renews the lease of an ACTIVE attempt (heartbeat). Requires the exact
   * run/attempt/owner triple; stale owners and expired leases cannot renew.
   */
  renewAttemptLease(input: RenewAttemptLeaseInput) {
    return this.orchestrator.renewAttemptLease(input);
  }

  /**
   * Atomically ends a successful execution: appends the terminal Completed
   * event (optionally publishing a persisted Model) and finishes the attempt
   * FINISHED in one transaction.
   */
  completeRunAttempt(input: CompleteRunAttemptRequest) {
    return this.orchestrator.completeAttempt(input);
  }

  /**
   * Atomically ends a failed execution: appends the terminal Failed event and
   * finishes the attempt INTERRUPTED with `UNEXPECTED_INTERRUPTION` in one
   * transaction — a failure is never written as a cancellation.
   */
  failRunAttempt(input: FailRunAttemptRequest) {
    return this.orchestrator.failAttempt(input);
  }

  /**
   * The guarded raw finish: ends an ACTIVE attempt whose Run has ALREADY
   * reached its terminal status through a persisted terminal event. FINISHED
   * only when the Run is COMPLETED or CLARIFICATION_REQUIRED, CANCELLED only
   * when the Run is CANCELLED, INTERRUPTED only when the Run is FAILED. Use
   * `completeRunAttempt` / `failRunAttempt` for the atomic transition.
   */
  finishRunAttempt(input: FinishRunAttemptRequest) {
    return this.orchestrator.finishAttempt(input);
  }

  /**
   * Startup / expired-lease recovery scan: reconsiders every ACTIVE attempt
   * whose lease expired and un-wedges RUNNING Runs with no live attempt.
   * QUEUED Runs are safe; candidate stages resume only on an injected safety
   * proof; MODELING/VALIDATING/PACKAGING resume only with an explicit safe
   * checkpoint; otherwise a Failed interruption/recovery event is appended and
   * the attempt is marked INTERRUPTED (never CANCELLED, never publishing a
   * Model). The scan already ran during `open()`; this re-runs it on demand.
   */
  recoverExpiredAttempts(): RecoveryScanResult {
    this.lastRecoveryScan = this.orchestrator.recoverExpiredAttempts();
    return this.lastRecoveryScan;
  }

  /**
   * The user-facing summary of the most recent recovery scan, or null when no
   * scan has run yet. Maps the raw scan entries to the stable
   * `RecoveryStatusSummary` counts: a resumed attempt counts as resumed; a
   * fail-closed mark failed (RECOVERY_FAILED) and an un-resolvable candidate
   * (SCAN_FAILED) count as failed; a refused recovery path counts as
   * unsupported (RECOVERY_UNSUPPORTED); a deliberate policy skip counts as
   * skipped. SAFE entries (a QUEUED / terminal Run whose dangling attempt was
   * reconciled without resuming or failing) are counted as checked but fall in
   * no action bucket.
   */
  getRecoveryStatus(): RecoveryStatusSummary | null {
    const scan = this.lastRecoveryScan;
    if (scan === null) return null;
    let resumedCount = 0;
    let failedCount = 0;
    let unsupportedCount = 0;
    let skippedCount = 0;
    for (const entry of scan.entries) {
      switch (entry.outcome) {
        case "RESUMED":
          resumedCount += 1;
          break;
        case "RECOVERY_FAILED":
        case "SCAN_FAILED":
          failedCount += 1;
          break;
        case "RECOVERY_UNSUPPORTED":
          unsupportedCount += 1;
          break;
        case "SKIPPED":
          skippedCount += 1;
          break;
        default:
          // SAFE: reconciled safely (no execution claimed / dangling attempt
          // finished) — checked, but in no action bucket.
          break;
      }
    }
    return {
      scanTime: scan.scannedAt,
      totalActiveChecked: scan.entries.length,
      resumedCount,
      failedCount,
      unsupportedCount,
      skippedCount
    };
  }

  /** Result of the recovery scan that ran when the Runner opened (null before open). */
  get recoveryScanResult(): RecoveryScanResult | null {
    return this.lastRecoveryScan;
  }

  /** The persisted attempt of a Run mapped to the domain shape, or null. */
  getRunAttempt(attemptId: string) {
    return this.orchestrator.getRunAttempt(attemptId);
  }

  // -------------------------------------------------------------------------
  // Fake Executor / coordinator facade (Phase 3, P3-3)
  // -------------------------------------------------------------------------

  /**
   * Starts the serial queue loop of the Fake Executor: one claim runs to its
   * terminal event at a time (exactly one RUNNING Run globally), the isolated
   * attempt workspace is created, ordered stage/activity/progress events
   * reference the ACTIVE attempt, the lease is renewed while working and the
   * terminal event + attempt finish are written atomically through the
   * orchestrator. Resolves when the queue drains or the executor stops.
   */
  runQueue(): Promise<void> {
    return this.requireExecutor().runQueue();
  }

  /**
   * Explicit cancel semantics (Phase 3, P3-3): QUEUED Runs cancel atomically
   * without any normal execution claim; RUNNING Runs persist
   * CancellationRequested first, signal the cooperative abort, wait (bounded),
   * clean only the allowlisted current Run/attempt files and confirm
   * CancellationConfirmed + attempt CANCELLED atomically. Cleanup failure
   * fails the Run with CANCEL_CLEANUP_PENDING (never a false CANCELLED);
   * repeats on a CANCELLED Run are stable. Never creates a Model.
   */
  cancelRun(runId: string, reason?: string): Promise<CancelRunResult> {
    return this.requireExecutor().cancelRun(runId, reason);
  }

  /** The persisted OPEN Clarification Request with its questions, or null. */
  getClarificationRequest(requestId: string): ClarificationRequest | null {
    return this.runRepository.getClarificationRequest(requestId);
  }

  /** Claim identity of this Runner's orchestrator (owner of claimed attempts). */
  get runOwnerToken(): string {
    return this.orchestrator.ownerToken;
  }

  /** Current SQLite schema version applied to the open database. */
  get schemaVersion(): number {
    return this.db.schemaVersion;
  }

  /** Resolves a ledger-relative path to an absolute path under the data root. */
  resolveLedgerPath(relativePath: string): string {
    return this.ledger.toAbsolute(relativePath);
  }

  /** Helpers exposed for the application layer to label revisions. */
  static revisionLabel(sequence: number): string {
    return revisionLabel(sequence);
  }

  // -------------------------------------------------------------------------
  // Source-file registration (IPC host bridge)
  // -------------------------------------------------------------------------
  //
  // The IPC wire contract never carries absolute paths. The Electron Main host
  // registers the user-picked file (by sha256) before dispatching a
  // `drawing.create` / `drawing.createRevision` command; the command payload
  // then resolves to the registered absolute path inside the Runner process.

  /**
   * Registers an absolute source-file path under its sha256 so a later IPC
   * command can resolve it. Registration is scoped to this Runner instance and
   * is intentionally NOT persisted: a new Runner process (Phase 8) must
   * re-register through the host file picker.
   */
  registerSourceFile(sha256: string, absolutePath: string): void {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new InvalidArgumentError("sha256 must be a 64-character lowercase hex digest");
    }
    if (typeof absolutePath !== "string" || absolutePath.trim().length === 0) {
      throw new InvalidArgumentError("absolutePath must be a non-empty string");
    }
    this.sourceFiles.set(sha256, absolutePath);
  }

  /** Absolute path registered for a sha256, or `null` when not registered. */
  resolveRegisteredSourceFile(sha256: string): string | null {
    return this.sourceFiles.get(sha256) ?? null;
  }

  /** Resolves a registered sha256 or throws `SourceFileNotRegisteredError`. */
  assertRegisteredSourceFile(sha256: string): string {
    const absolutePath = this.sourceFiles.get(sha256);
    if (absolutePath === undefined) {
      throw new SourceFileNotRegisteredError(sha256);
    }
    return absolutePath;
  }

  private validateSettingsDataRoot(settings: StorageSettings, expectedDataRoot: string): void {
    if (settings.dataRoot !== expectedDataRoot) {
      throw new InvalidStorageSettingsError(
        `Persisted storage settings data root (${settings.dataRoot}) does not match the data root this Runner opened (${expectedDataRoot})`,
        { persistedDataRoot: settings.dataRoot, openedDataRoot: expectedDataRoot }
      );
    }
  }

  /** The Fake Executor bound to this open Runner, or a structured error. */
  private requireExecutor(): FakeExecutor {
    if (this.executor === null) {
      throw new RunnerError({
        code: "RUNNER_NOT_OPEN",
        message: "The Runner is not open; the Fake Executor is not available"
      });
    }
    return this.executor;
  }

  /**
   * Conservative default recovery capability when none was injected: only the
   * test-harness `recovery-supported` scenario proves interrupted work safely
   * resumable (`declaresSafeRecovery`); the production default (`success`)
   * refuses every resume and every checkpoint, so an interrupted Run fails
   * truthfully and is never silently continued.
   */
  private defaultRecoveryCapabilities(scenario?: FakeExecutorScenario): RunRecoveryCapabilities {
    return {
      canSafelyResume: () => declaresSafeRecovery(scenario ?? "success"),
      hasSafeCheckpoint: () => false
    };
  }

  /**
   * Resolves the recovery capability of the orchestration (Phase 5, P5-4).
   * Precedence:
   *
   * 1. an injected `recoveryCapabilities` is authoritative (never overridden);
   * 2. otherwise a CONFIGURED Codex adapter turns the default into the
   *    protocol-pinned THREAD-SESSION proof: `threadSessionRecoveryCapabilities`
   *    over the persisted `runtime/agent-session.json` of the interrupted
   *    attempt, read through the OPEN run workspace ledger (the SAME single
   *    ledger instance the executor writes — the lookup is never a second
   *    writer and weakens no ownership). Only a well-formed session at
   *    `null` / PREPARING / ANALYZING / PLANNING under the pinned protocol
   *    proves a resume; MODELING / VALIDATING / PACKAGING and malformed /
   *    absent / unpinned sessions are refused truthfully.
   * 3. otherwise the Fake-scenario declaration (existing behavior).
   *
   * Construction order note: the orchestrator is built BEFORE the ledger is
   * opened, so the lookup is deferred — it reads through `this.runWorkspace`
   * which is only assigned during `open()` (before the open-time recovery
   * scan), and conservatively refuses (no session) before that.
   */
  private resolveRecoveryCapabilities(config: RunnerConfig): RunRecoveryCapabilities {
    if (config.recoveryCapabilities !== undefined) return config.recoveryCapabilities;
    if (config.agent !== undefined && config.agent.adapterId === CODEX_APP_SERVER_ADAPTER_ID) {
      return threadSessionRecoveryCapabilities((runId) => this.lookupThreadSession(runId));
    }
    return this.defaultRecoveryCapabilities(config.fakeExecutorScenario);
  }

  /**
   * The thread-session lookup of a configured Codex adapter (P5-4): maps a Run
   * id to the minimal {@link ThreadSessionLike} view by reading the attempt's
   * persisted `runtime/agent-session.json` through the OPEN run workspace
   * ledger (strict containment + strict store validation — a malformed
   * session reads as absent) and combining it with the Run's persisted stage.
   * The attempt identity is derived deterministically from the database
   * (active attempt of the Run), never from an absolute user-supplied path.
   */
  private lookupThreadSession(runId: string): ThreadSessionLike | null {
    const workspace = this.runWorkspace;
    if (workspace === null) return null;
    const attempt = this.orchestrator.getActiveAttempt(runId);
    if (attempt === null) return null;
    const session = readAgentSessionRecord(workspace, {
      runId,
      attemptSequence: attempt.attemptSequence
    });
    if (session === null) return null;
    const stage = this.runRepository.getRun(runId)?.stage ?? null;
    return { stage, protocol: session.protocol, protocolVersion: session.protocolVersion };
  }

  /**
   * Resolves the immutable original source file of a Run for the Input Adapter
   * (Phase 4, P4-1): revision source-file metadata from the frozen snapshot +
   * the absolute ledger copy. The ledger copy is verified against the recorded
   * size/hash; a missing Revision, a missing file or a hash mismatch resolves
   * to `null` so the attempt fails closed at PREPARING.
   */
  private resolveInputSource(runId: string): InputAdapterSource | null {
    const meta = this.runRepository.getRunInputSource(runId);
    if (meta === null) return null;
    const absolutePath = this.ledger.toAbsolute(meta.relativePath);
    const verification = this.ledger.verifyStoredFile(
      absolutePath,
      meta.relativePath,
      meta.sizeBytes,
      meta.sha256
    );
    if (!verification.ok) return null;
    return {
      source: {
        fileName: meta.fileName,
        format: meta.format,
        sizeBytes: meta.sizeBytes,
        sha256: meta.sha256
      },
      absolutePath
    };
  }

  /**
   * Binds the LIVE ownership surface context of Phase 5 (Batch 2): the
   * persisted run stage, the current ACTIVE attempt binding (only the active
   * attempt of the run can ever be cancelled, so only its registry is
   * readable), the attempt workspace root and the guarded attempt-scoped file
   * reads. Called exactly once from `open()` after the ledger/repository are
   * open — the surface itself is seam-injected and never touches the
   * database/filesystem directly.
   */
  private bindOwnershipSurfaceContext(): SolidWorksOwnershipSurfaceContext {
    return {
      stageOf: (runId) => this.runRepository.getRun(runId)?.stage ?? null,
      attemptSequenceOf: (runId, attemptId) => {
        const attempt = this.orchestrator.getActiveAttempt(runId);
        return attempt !== null && attempt.id === attemptId ? attempt.attemptSequence : null;
      },
      attemptRootOf: (runId, attemptSequence) =>
        this.runWorkspace === null
          ? null
          : this.runWorkspace.workspaceLayout(runId, attemptSequence).absoluteRoot,
      readAttemptFile: (input) => {
        if (this.runWorkspace === null) return null;
        const file = this.runWorkspace.readOwnedFile(input);
        return file === null ? null : file.content;
      }
    };
  }

  /** Resolves and shape-checks the Runner-owned snapshot profile. */
  private requireRunProfile(): RunProfile {
    const profile = this.config.runProfile ?? DEFAULT_RUN_PROFILE;
    if (typeof profile.promptTemplateVersion !== "string" || profile.promptTemplateVersion.length === 0) {
      throw new InvalidArgumentError("runProfile.promptTemplateVersion must be a non-empty string");
    }
    if (typeof profile.skill?.name !== "string" || profile.skill.name.length === 0) {
      throw new InvalidArgumentError("runProfile.skill.name must be a non-empty string");
    }
    if (typeof profile.skill?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(profile.skill.sha256)) {
      throw new InvalidArgumentError(
        "runProfile.skill.sha256 must be a 64-character lowercase hex digest"
      );
    }
    if (typeof profile.agentConfigId !== "string" || profile.agentConfigId.length === 0) {
      throw new InvalidArgumentError("runProfile.agentConfigId must be a non-empty string");
    }
    return {
      promptTemplateVersion: profile.promptTemplateVersion,
      skill: { name: profile.skill.name, sha256: profile.skill.sha256 },
      agentConfigId: profile.agentConfigId
    };
  }
}

export type {
  ImportDrawingInput,
  AddRevisionInput,
  SetCurrentRevisionInput,
  DeleteRevisionInput,
  AddRevisionFactInput,
  AddModelingFeedbackInput
} from "./service/drawing-workflow-service.js";
