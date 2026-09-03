import type {
  ClarificationQuestion,
  Model,
  ModelValidationSummary,
  RunAttempt,
  RunAttemptStatus,
  RunFailureCode,
  RunInterruptionKind,
  RunRecoveryDecision,
  RunStage,
  TerminalRunAttemptStatus
} from "@swpanel/domain";
import {
  DomainInvariantError,
  finishRunAttempt,
  isLeaseExpired,
  isRecoveryCandidateStage,
  modelLabel,
  RUN_ATTEMPT_STATUSES,
  RUN_INTERRUPTION_KINDS,
  RUN_RECOVERY_DECISIONS,
  RUN_STAGES,
  type FinishRunAttemptInput
} from "@swpanel/domain";

import type { ArtifactValidationSuccess } from "../artifacts/artifact-validator.js";
import { EntityConflictError, InvalidArgumentError, NotFoundError, RunnerInvariantError } from "../errors.js";
import { assertSafeIdToken, generateId } from "../ids.js";
import type { SqliteDatabase } from "../db/database.js";
import { isUniqueConstraintError } from "../db/repository.js";
import { RunRepository } from "../db/run-repository.js";

/** Default lease length of a claimed attempt (heartbeats renew the deadline). */
export const DEFAULT_RUN_LEASE_DURATION_MS = 60_000 as const;

/**
 * The dedicated minimum lease of the Phase 5 cancellation cleanup fence. The
 * fence deadline is `max(normal run lease duration, this minimum)` after the
 * fence instant, so a short configured run lease can NEVER shorten the
 * cleanup window below the bound the live cleanup provably needs.
 *
 * Proof of the live product bound:
 * - the Phase 5 single-part contract keeps EXACTLY ONE live editable `.SLDPRT`
 *   per Run (the ownership registry enforces at most one document,
 *   `SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS`);
 * - the default live `SolidWorksDocumentCloser` hard bound is
 *   `DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS` (20 s) per synchronous helper
 *   invocation;
 * - the cleanup section (fence -> ownership snapshot/close -> workspace
 *   delete -> terminal confirm) is fully SYNCHRONOUS, so one close helper
 *   invocation is the only in-flight step that can approach its bound;
 * - 60 s therefore bounds the one 20 s close helper with >3x margin for the
 *   snapshot / delete / confirm steps. The numerical invariant
 *   `DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS > DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS`
 *   is asserted by a test in the live ownership/closer area (the orchestrator
 *   deliberately does not import execution-layer constants).
 *
 * This is a LIVE PRODUCT guarantee only: it does NOT claim to bound arbitrary
 * injected unbounded test surfaces (a test may inject a closer or workspace
 * implementation that blocks arbitrarily long — the fence lease bounds
 * FOREIGN takeover, never an injected blocking implementation).
 */
export const DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS = 60_000 as const;

/** Internal control-flow marker: another writer won the claim race. */
class ClaimLostError extends Error {
  constructor() {
    super("another writer claimed the Run first");
    this.name = "ClaimLostError";
  }
}

/**
 * Internal control-flow marker: the cancel path must never re-own (or
 * otherwise end) an ACTIVE attempt that belongs to ANOTHER owner while its
 * lease is still VALID — that would steal a live foreign lease. The cancel
 * coordinator surfaces an explicit pending outcome instead of touching the
 * attempt or its workspace.
 */
export class LiveForeignLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveForeignLeaseError";
  }
}

/**
 * Internal control-flow marker: resuming the attempt collided with the
 * one-unfinished-attempt-per-owner uniqueness constraint.
 */
class ResumeOwnerConflictError extends Error {
  constructor() {
    super("the current owner already holds another unfinished attempt");
    this.name = "ResumeOwnerConflictError";
  }
}

/**
 * The guarded raw finish maps each terminal attempt status onto the Run
 * statuses in which it is legal: the terminal Run event must already be
 * persisted before the attempt is finished.
 */
const RUN_STATUS_PIN: Readonly<Record<TerminalRunAttemptStatus, readonly string[]>> = {
  FINISHED: ["COMPLETED", "CLARIFICATION_REQUIRED"],
  CANCELLED: ["CANCELLED"],
  INTERRUPTED: ["FAILED"]
};

/**
 * Injected proof the Run orchestration consults when an interrupted attempt is
 * reconsidered. Nothing is resumed without a proof: the default (absent)
 * capability refuses everything, so a fresh Runner can never silently continue
 * unknown executor work.
 */
export interface RunRecoveryCapabilities {
  /**
   * Proves the interrupted work at a PREPARING / ANALYZING / PLANNING stage (or
   * with no stage recorded) is safely resumable / idempotent. Returning `false`
   * means the executor declares recovery unsupported; throwing means the probe
   * itself failed.
   */
  canSafelyResume?(context: RecoveryCapabilityContext): boolean;
  /**
   * Proves an explicit safe checkpoint exists for a MODELING / VALIDATING /
   * PACKAGING stage. These stages are never resumed without one.
   */
  hasSafeCheckpoint?(context: RecoveryCapabilityContext): boolean;
}

/** Identity the recovery capability is asked to prove safety for. */
export interface RecoveryCapabilityContext {
  runId: string;
  attemptId: string;
  /** Stage the interrupted Run had reached (`null` when none was recorded). */
  stage: RunStage | null;
}

/** Injected clock and lease tuning of the orchestrator (tests drive `now`). */
export interface RunOrchestratorOptions {
  /** Deterministic clock; defaults to the wall clock. */
  now?: () => Date;
  /** Lease length in milliseconds; defaults to {@link DEFAULT_RUN_LEASE_DURATION_MS}. */
  leaseDurationMs?: number;
  /** Injected recovery proofs; defaults to the conservative refuse-everything capability. */
  recoveryCapabilities?: RunRecoveryCapabilities;
}

/** One successful atomic claim: the attempt minted for the claimed Run. */
export interface RunClaim {
  runId: string;
  runNumber: string;
  attempt: RunAttempt;
}

export interface RenewAttemptLeaseInput {
  runId: string;
  attemptId: string;
  ownerToken: string;
}

export interface FinishRunAttemptRequest {
  runId: string;
  attemptId: string;
  ownerToken: string;
  /**
   * Terminal attempt status. `finishRunAttempt` domain semantics pin the
   * interruption kind to the status — FINISHED records none, INTERRUPTED
   * records `UNEXPECTED_INTERRUPTION`, CANCELLED records `CANCELLED` — so an
   * unexpected stop can never be written as a user cancellation. The request
   * exposes NO caller-chosen `interruptionKind`: the kind is always derived
   * from the status (P3-3 review fix, type and behavior are one).
   *
   * The raw finish is GUARDED by the Run's already-terminal status: FINISHED
   * only when the Run is COMPLETED or CLARIFICATION_REQUIRED, CANCELLED only
   * when the Run is CANCELLED, INTERRUPTED only when the Run is FAILED. The
   * terminal Run event must be appended first; the atomic `completeAttempt` /
   * `failAttempt` / `cancelAttempt` / `clarifyAttempt` operations do both
   * steps in one transaction.
   */
  status: TerminalRunAttemptStatus;
  /** Canonicalized on write; defaults to the injected clock. */
  finishedAt?: string;
}

/** Atomic terminal operation: appends the Completed event and finishes FINISHED. */
export interface CompleteRunAttemptRequest {
  runId: string;
  attemptId: string;
  ownerToken: string;
  /** Optional Model id the Completed event publishes (must already persist). */
  modelId?: string;
  /** Canonicalized on write; defaults to the injected clock. */
  finishedAt?: string;
}

/**
 * Atomic Model publication (Phase 5, P5-2): ends a successful execution by
 * publishing a PENDING_REVIEW Model in ONE transaction. The input carries ONLY
 * what the independent ArtifactValidator returned on `ok` — the strictly
 * validated normalized Result Manifest and the verified artifact records — so
 * the in-memory Agent claim is never re-read or trusted separately. The
 * transaction derives the drawing/revision/run identities from the persisted
 * Run, allocates the next per-revision M-number, inserts the Model with its
 * validation summary and production-verification claim (both taken from the
 * strictly validated manifest — a synthetic manifest always persists
 * `production_verified = 0`) and every declared artifact metadata row
 * (including the optional processMp4), appends the Completed event with the
 * new Model id and finishes the attempt FINISHED. Any failure rolls back all
 * rows, events, projection and attempt changes.
 */
export interface PublishModelPublicationInput {
  runId: string;
  attemptId: string;
  ownerToken: string;
  /** The strictly validated manifest + verified artifact records (P5-2). */
  validation: ArtifactValidationSuccess;
  /**
   * Optional build report summary. Normalized on write: `null`, `undefined`
   * and empty strings all persist NULL and leave the domain Model without the
   * field. Only a trustworthy non-empty source supplies a summary — the
   * synthetic Phase 4/5 adapter never does, so the persisted column stays NULL
   * on the product path.
   */
  buildReportSummary?: string;
  /** Canonicalized on write; defaults to the injected clock. */
  finishedAt?: string;
}

/** Outcome of one atomic Model publication. */
export interface PublishedModelPublication {
  attempt: RunAttempt;
  model: Model;
}

/**
 * Atomic terminal operation: appends the Failed event (failure code/message)
 * and finishes the attempt INTERRUPTED with `UNEXPECTED_INTERRUPTION`.
 */
export interface FailRunAttemptRequest {
  runId: string;
  attemptId: string;
  ownerToken: string;
  failureCode: RunFailureCode;
  failureMessage?: string;
  /** Canonicalized on write; defaults to the injected clock. */
  finishedAt?: string;
}

/**
 * Atomic clarification terminal operation (Phase 3, P3-3): persists the OPEN
 * Clarification Request with its questions, appends the ClarificationRequired
 * event and finishes the attempt FINISHED — all in ONE transaction. The
 * request and the event are never observable apart, and the old Run never
 * resumes after answers (a new Run is created instead).
 */
export interface ClarifyRunAttemptRequest {
  runId: string;
  attemptId: string;
  ownerToken: string;
  /** Question contents; request/question/option ids are minted by the writer. */
  questions: readonly ClarificationQuestion[];
  /** Canonicalized on write; defaults to the injected clock. */
  finishedAt?: string;
}

/**
 * Atomic queued-cancellation (Phase 3, P3-3): a QUEUED Run is cancelled
 * WITHOUT any normal execution claim. The event envelope still requires a
 * persisted attempt reference, so a cancellation-scoped attempt is minted and
 * finished CANCELLED inside the same transaction as the cancellation pair —
 * it is never observable as an execution attempt. An existing ACTIVE attempt
 * of the Run (a claim that never committed) is reused instead of minted.
 */
export interface CancelQueuedRunRequest {
  runId: string;
  reason?: string;
  /** Canonicalized on write; defaults to the injected clock. */
  finishedAt?: string;
}

/**
 * Atomic cancel confirmation (Phase 3, P3-3): appends the terminal
 * CancellationConfirmed event and finishes the attempt CANCELLED in ONE
 * transaction. The user's cancel intent is authoritative for the Run: an
 * ACTIVE attempt owned by another (dead) owner is re-owned in the same
 * transaction — but ONLY when its lease is no longer valid (a live foreign
 * lease is never stolen; `LiveForeignLeaseError` surfaces instead).
 */
export interface CancelRunAttemptRequest {
  runId: string;
  attemptId: string;
  ownerToken: string;
  /** Canonicalized on write; defaults to the injected clock. */
  finishedAt?: string;
}

/**
 * Atomic cancel-cleanup failure (Phase 3, P3-3): when the cancel cleanup could
 * not remove the allowlisted attempt workspace, the Run must NEVER claim a
 * full cancellation. This appends the terminal Failed event with
 * `CANCEL_CLEANUP_PENDING` and finishes the attempt INTERRUPTED (never
 * CANCELLED) in ONE transaction. A stale foreign-owned attempt is re-owned
 * safely inside the transaction (the eligibility guard refuses a live foreign
 * lease with `LiveForeignLeaseError`).
 */
export interface FailCancelCleanupRequest {
  runId: string;
  attemptId: string;
  ownerToken: string;
  failureMessage?: string;
  /** Canonicalized on write; defaults to the injected clock. */
  finishedAt?: string;
}

/**
 * Phase 5 cancellation lease fence: establishes THIS orchestrator as the
 * cleanup owner of the exact RUNNING Run + ACTIVE attempt atomically, BEFORE
 * the cancel coordinator touches anything destructive (ownership close /
 * workspace deletion). The transaction re-validates the pair and either
 * refreshes the same owner's lease (even an expired one), re-owns a stale
 * foreign attempt with a FRESH lease, or refuses a live foreign lease with
 * {@link LiveForeignLeaseError}. The attempt stays ACTIVE; no terminal event
 * and no recovery decision are written. The fence lease is the load-bearing
 * protection of the whole cleanup: while it is live, no other Runner's
 * recovery scan can re-own the attempt, so destructive work can never run on
 * an attempt that was taken over mid-cleanup.
 */
export interface SeizeCancelCleanupOwnershipInput {
  runId: string;
  attemptId: string;
  ownerToken: string;
  /** Canonicalized on write; defaults to the injected clock. */
  at?: string;
}

/** Outcome of one expired-lease attempt reconsidered by the recovery scan. */
export const RECOVERY_SCAN_OUTCOMES = [
  "SAFE",
  "RESUMED",
  "RECOVERY_UNSUPPORTED",
  "RECOVERY_FAILED",
  "SKIPPED",
  "SCAN_FAILED"
] as const;
export type RecoveryScanOutcome = (typeof RECOVERY_SCAN_OUTCOMES)[number];

export interface RecoveryScanEntry {
  /** Attempt the entry is about; null when a wedged Run had no attempt to reference. */
  attemptId: string | null;
  runId: string;
  outcome: RecoveryScanOutcome;
  /** Persisted recovery decision written to the attempt (`null` when not applicable). */
  decision: RunRecoveryDecision | null;
  /** Run stage at decision time (`null` when the Run had no stage). */
  stage: RunStage | null;
  /** Failure code of the appended Failed event (`null` when none was appended). */
  failureCode: RunFailureCode | null;
  /** Human-readable explanation of the classifier outcome. */
  reason: string;
}

export interface RecoveryScanResult {
  /** Canonical timestamp the scan used as "now". */
  scannedAt: string;
  /** Expired ACTIVE attempts found at scan start (wedge entries are additional). */
  found: number;
  entries: readonly RecoveryScanEntry[];
}

interface AttemptRow {
  id: string;
  run_id: string;
  attempt_sequence: number;
  status: string | null;
  kind: string | null;
  owner_token: string | null;
  claimed_at: string | null;
  lease_deadline_at: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  interruption_kind: string | null;
  recovery_decision: string | null;
  created_at: string;
}

interface OrchestratorRunRow {
  id: string;
  number: string;
  status: string;
  stage: string | null;
  completed_at: string | null;
  cancellation_requested_at: string | null;
}

/**
 * Run orchestration primitives (Phase 3, Batch P3-2). The Runner is the only
 * writer; this class composes the Run repository with the persisted attempt
 * lifecycle:
 *
 * - `claimNextQueuedRun` atomically claims the oldest QUEUED Run (FIFO by
 *   `created_at`, id tie-breaker), mints the persisted ACTIVE attempt with the
 *   next deterministic per-Run sequence and the owner/claim/start/heartbeat/
 *   lease timestamps, and transitions the Run QUEUED -> RUNNING. It is the ONLY
 *   path to RUNNING (the repository exposes no RUNNING transition primitive),
 *   so a RUNNING Run always has a live attempt.
 *   Exactly one Run may be RUNNING globally and one owner holds at most one
 *   unfinished attempt; a competing connection loses the claim cleanly (`null`)
 *   instead of surfacing a raw SQLite failure.
 * - `renewAttemptLease` renews the lease only for the exact run/attempt/owner
 *   triple in ACTIVE state; an expired or stale-owner attempt cannot renew.
 * - `completeAttempt` / `failAttempt` end execution atomically: the terminal
 *   Run event (Completed / Failed) and the attempt finish (FINISHED /
 *   INTERRUPTED with `UNEXPECTED_INTERRUPTION`) are written in ONE transaction.
 * - `publishModelPublication` (Phase 5, P5-2) ends a successful execution by
 *   publishing a PENDING_REVIEW Model atomically: it validates the active
 *   attempt ownership/state, derives the drawing/revision/run identities from
 *   the persisted Run, allocates the next per-revision M-number, inserts the
 *   Model with the validation summary from the STRICTLY validated Result
 *   Manifest plus every declared artifact metadata row (including the optional
 *   processMp4), appends the Completed event with the Model id and finishes the
 *   attempt FINISHED — all in ONE transaction; any failure rolls back all rows,
 *   events, projection and attempt changes.
 * - `clarifyAttempt` ends a clarification atomically: the OPEN Clarification
 *   Request with its questions, the ClarificationRequired event and the
 *   FINISHED attempt are written in ONE transaction.
 * - `cancelQueuedRun` cancels a QUEUED Run atomically without any normal
 *   execution claim: a cancellation-scoped attempt is minted (or a stale ACTIVE
 *   attempt reused), the cancellation pair is appended and the attempt is
 *   finished CANCELLED in ONE transaction.
 * - `cancelAttempt` confirms a running cancellation atomically: the terminal
 *   CancellationConfirmed event and the CANCELLED attempt (with `CANCELLED`
 *   interruption kind) are written in ONE transaction; an ACTIVE attempt owned
 *   by another (dead) owner is re-owned inside the same transaction.
 * - `finishAttempt` is the guarded raw finish: domain `finishRunAttempt`
 *   semantics (terminal status + canonical `finishedAt` written together; the
 *   interruption kind is DERIVED from the status — the request exposes no
 *   caller-chosen kind) AND the Run-status mapping — FINISHED only when
 *   the Run is COMPLETED or CLARIFICATION_REQUIRED, CANCELLED only when the Run
 *   is CANCELLED, INTERRUPTED only when the Run is FAILED.
 * - `recoverExpiredAttempts` is the startup / expired-lease recovery
 *   classifier: QUEUED Runs are safe; PREPARING/ANALYZING/PLANNING resume only
 *   when the injected capability proves the work safely resumable;
 *   MODELING/VALIDATING/PACKAGING resume only with an explicit safe checkpoint.
 *   Anything else appends a Failed interruption/recovery event (referencing the
 *   persisted attempt) and marks the attempt INTERRUPTED — never CANCELLED, and
 *   never publishing a Model. The scan also un-wedges RUNNING Runs with no live
 *   ACTIVE attempt (failing them with AGENT_INTERRUPTED / RECOVERY_FAILED,
 *   minting the canonical attempt reference when none exists), isolates
 *   per-candidate failures so one broken candidate never aborts the rest of
 *   the scan, and reconciles terminal Runs' dangling attempts (FINISHED for
 *   COMPLETED/CLARIFICATION_REQUIRED, INTERRUPTED for FAILED and for CANCELLED
 *   — recovery never invents a cancellation). A RUNNING Run with a persisted
 *   CancellationRequested is left untouched by BOTH sweeps (neither resumed nor
 *   auto-failed): the explicit cancel retry owns the aftermath, and the
 *   executor's idle loop bounds its own reconsideration of that state so the
 *   expired lease / wedged slot never turns into a busy loop.
 * - `seizeCancelCleanupOwnership` is the Phase 5 cancellation lease fence:
 *   atomically establishes this orchestrator as the cleanup owner of the exact
 *   RUNNING Run + ACTIVE attempt (only after a PERSISTED CancellationRequested
 *   exists — the fence is bound to real cancel intent, and without one it
 *   throws without mutating anything; refresh same-owner lease even when
 *   expired, re-own a stale foreign attempt with a fresh lease, refuse a live
 *   foreign lease with `LiveForeignLeaseError`) WITHOUT a terminal event or
 *   recovery decision — the cancel coordinator calls it before any destructive
 *   cleanup step, so destructive work can never follow a takeover. The fence
 *   lease deadline is at least `DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS` after
 *   the fence instant, regardless of the configured run lease.
 *
 * No executor loop, UI or IPC ships in this batch: the future executor host
 * calls these primitives, and the Runner facade runs the scan on open.
 */
export class RunOrchestrator {
  /** This Runner instance's claim identity (single unfinished attempt per owner). */
  readonly ownerToken: string;
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private readonly recovery: Required<RunRecoveryCapabilities>;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly runs: RunRepository,
    options: RunOrchestratorOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_RUN_LEASE_DURATION_MS;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new InvalidArgumentError(
        `leaseDurationMs must be a positive integer number of milliseconds, got ${options.leaseDurationMs}`
      );
    }
    const capabilities = options.recoveryCapabilities;
    // Wrap the probes so an unbound injected method reference is never stored;
    // the conservative default refuses everything.
    this.recovery = {
      canSafelyResume: (context) => capabilities?.canSafelyResume?.(context) ?? false,
      hasSafeCheckpoint: (context) => capabilities?.hasSafeCheckpoint?.(context) ?? false
    };
    this.ownerToken = generateId();
  }

  // -------------------------------------------------------------------------
  // Atomic claim
  // -------------------------------------------------------------------------

  /**
   * Atomically claims the oldest QUEUED Run (FIFO `created_at`, id tie-breaker)
   * for this owner: mints the ACTIVE attempt with the next deterministic
   * per-Run sequence plus owner/claim/start/heartbeat/lease timestamps and
   * transitions the Run QUEUED -> RUNNING in the same transaction.
   *
   * Returns `null` without any side effect when the queue is empty, when a
   * competing connection claimed the candidate first, or when the single-
   * active-Run / one-unfinished-attempt-per-owner invariants would be violated
   * — never a raw SQLite failure.
   */
  claimNextQueuedRun(): RunClaim | null {
    try {
      return this.db.transaction(() => {
        const candidate = this.db
          .prepare(
            "SELECT * FROM runs WHERE status = 'QUEUED' ORDER BY created_at ASC, id ASC LIMIT 1"
          )
          .get() as OrchestratorRunRow | undefined;
        if (candidate === undefined) return null;

        const now = this.canonicalNow();
        const leaseDeadlineAt = this.deadlineFrom(now);
        const attemptSequence = this.nextAttemptSequence(candidate.id);
        const attemptId = generateId();
        try {
          this.db
            .prepare(
              "INSERT INTO run_attempts " +
                "(id, run_id, attempt_sequence, status, kind, owner_token, claimed_at, " +
                " lease_deadline_at, heartbeat_at, started_at, created_at) " +
                "VALUES (?, ?, ?, 'ACTIVE', 'EXECUTION', ?, ?, ?, ?, ?, ?)"
            )
            .run(
              attemptId,
              candidate.id,
              attemptSequence,
              this.ownerToken,
              now,
              leaseDeadlineAt,
              now,
              now,
              now
            );
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            // The owner already holds an unfinished attempt, or a concurrent
            // writer minted the same per-Run sequence: no claim, no raw error.
            throw new ClaimLostError();
          }
          throw error;
        }
        try {
          const transition = this.db
            .prepare(
              "UPDATE runs SET status = 'RUNNING', started_at = COALESCE(started_at, ?) " +
                "WHERE id = ? AND status = 'QUEUED'"
            )
            .run(now, candidate.id);
          if (Number(transition.changes) !== 1) {
            // The candidate left QUEUED between the read and the write: lost.
            throw new ClaimLostError();
          }
        } catch (error) {
          if (error instanceof ClaimLostError) throw error;
          if (isUniqueConstraintError(error)) {
            // Another Run is already RUNNING (single-active invariant).
            throw new ClaimLostError();
          }
          throw error;
        }
        const attempt = this.readAttempt(attemptId);
        return { runId: candidate.id, runNumber: candidate.number, attempt };
      });
    } catch (error) {
      if (error instanceof ClaimLostError) return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Lease heartbeat
  // -------------------------------------------------------------------------

  /**
   * Renews the lease (heartbeat) of an ACTIVE attempt. Requires the exact
   * run/attempt/owner triple; a stale owner token, a wrong Run reference, a
   * finished attempt or an already-expired lease cannot renew and fails with a
   * structured invariant error.
   */
  renewAttemptLease(input: RenewAttemptLeaseInput): RunAttempt {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    return this.db.transaction(() => {
      const row = this.getAttemptRow(input.attemptId);
      if (row === null) {
        throw new NotFoundError(`Attempt ${input.attemptId} was not found`, {
          attemptId: input.attemptId
        });
      }
      if (row.run_id !== input.runId) {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} belongs to run ${row.run_id}, not ${input.runId}; the lease cannot be renewed`,
          { attemptId: input.attemptId, runId: input.runId }
        );
      }
      if (row.owner_token !== input.ownerToken) {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} is owned by another token; only the exact owner may renew its lease`,
          { attemptId: input.attemptId }
        );
      }
      if (row.status !== "ACTIVE") {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} is ${row.status ?? "unset"}; only an ACTIVE attempt can renew its lease`,
          { attemptId: input.attemptId, status: row.status }
        );
      }
      if (row.lease_deadline_at === null) {
        throw new RunnerInvariantError(`Attempt ${input.attemptId} has no lease to renew`, {
          attemptId: input.attemptId
        });
      }
      const now = this.canonicalNow();
      if (isLeaseExpired(row.lease_deadline_at, now)) {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} lease expired at ${row.lease_deadline_at}; expired attempts cannot renew — the recovery scan must reconsider them`,
          { attemptId: input.attemptId, leaseDeadlineAt: row.lease_deadline_at }
        );
      }
      const leaseDeadlineAt = this.deadlineFrom(now);
      const updated = this.db
        .prepare(
          "UPDATE run_attempts SET heartbeat_at = ?, lease_deadline_at = ? " +
            "WHERE id = ? AND status = 'ACTIVE' AND owner_token = ? AND lease_deadline_at > ?"
        )
        .run(now, leaseDeadlineAt, input.attemptId, input.ownerToken, now);
      if (Number(updated.changes) !== 1) {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} changed concurrently; the lease was not renewed`,
          { attemptId: input.attemptId }
        );
      }
      return this.readAttempt(input.attemptId);
    });
  }

  // -------------------------------------------------------------------------
  // Atomic terminal operations
  // -------------------------------------------------------------------------

  /**
   * Atomically ends a successful execution: appends the terminal Completed
   * event (optionally publishing a persisted Model) and finishes the attempt
   * FINISHED in ONE transaction. The event and the attempt finish are never
   * observable apart, and any failure rolls both back.
   */
  completeAttempt(input: CompleteRunAttemptRequest): RunAttempt {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    const finishedAt =
      input.finishedAt === undefined ? this.canonicalNow() : this.canonicalIso(input.finishedAt);
    return this.db.transaction(() => {
      const row = this.assertAttemptOwnership(input.runId, input.attemptId, input.ownerToken);
      const next = this.pinnedFinish(row, { status: "FINISHED", finishedAt });
      this.runs.appendRunEvents({
        runId: input.runId,
        attemptId: input.attemptId,
        entries: [
          {
            payload: {
              type: "Completed",
              ...(input.modelId === undefined ? {} : { modelId: input.modelId })
            },
            occurredAt: finishedAt
          }
        ]
      });
      return this.writeAttemptTransition(row, next, input.ownerToken);
    });
  }

  /**
   * Atomically publishes a PENDING_REVIEW Model (Phase 5, P5-2) and ends the
   * successful execution in ONE transaction:
   *
   * 1. the active attempt ownership/state is validated (exact run/attempt/
   *    owner triple, attempt not terminal);
   * 2. the drawing/revision/run identities are derived from the PERSISTED Run
   *    row — never from the caller;
   * 3. the next per-revision M-number is allocated under the write transaction
   *    (backed by the unique `idx_models_revision_number`);
   * 4. the Model row is inserted as PENDING_REVIEW with the validation summary
   *    and the production-verification claim derived from the STRICTLY
   *    validated Result Manifest — the independent validator rejects an
   *    unsupported `productionVerified: true` claim (no production/HIL
   *    verification record exists), so the publisher can only ever persist
   *    `0` and a synthetic manifest truthfully publishes an unverified Model
   *    (build report summary only when a trustworthy source supplied one);
   * 5. every declared artifact metadata row is inserted bound to the Model AND
   *    the Run, persisting exactly the validator's verified records (kind /
   *    canonical workspace-relative path / size / sha256 / file name /
   *    deterministic MIME), including the optional processMp4;
   * 6. the Completed event carrying the Model id is appended (its projection
   *    resolves the just-inserted Model) and the attempt is finished FINISHED.
   *
   * Any failure — an event/projection rejection, a constraint collision, a
   * concurrent attempt change — rolls back the Model, the artifacts, the
   * events, the projection and the attempt finish together; they are never
   * observable apart.
   */
  publishModelPublication(
    input: PublishModelPublicationInput
  ): PublishedModelPublication {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    if (input.validation.artifacts.length === 0) {
      throw new InvalidArgumentError(
        "Model publication requires at least one validated artifact record"
      );
    }
    const finishedAt =
      input.finishedAt === undefined ? this.canonicalNow() : this.canonicalIso(input.finishedAt);
    // Normalize the optional build report summary: null, undefined and empty
    // strings all mean "no summary" (persisted NULL, domain field omitted).
    const buildReportSummary =
      typeof input.buildReportSummary === "string" && input.buildReportSummary.length > 0
        ? input.buildReportSummary
        : undefined;
    return this.db.transaction(() => {
      // 1. Active attempt ownership/state (exact triple; the domain finish
      //    rejects an already-terminal attempt before anything is written).
      const row = this.assertAttemptOwnership(input.runId, input.attemptId, input.ownerToken);
      const next = this.pinnedFinish(row, { status: "FINISHED", finishedAt });

      // 2. Drawing / revision / run identities come from the persisted Run row.
      const run = this.db
        .prepare("SELECT id, drawing_id, revision_id FROM runs WHERE id = ?")
        .get(input.runId) as
        | { id: string; drawing_id: string; revision_id: string }
        | undefined;
      if (run === undefined) {
        throw new NotFoundError(`Run ${input.runId} was not found`, { runId: input.runId });
      }

      // 3. Next per-revision M-number, derived under the write transaction and
      //    defended by the unique (revision_id, number) index.
      const sequence = this.nextModelSequence(run.revision_id);
      const number = modelLabel(sequence);
      const modelId = generateId();

      // 4. Model row: PENDING_REVIEW with the validation summary and the
      //    production-verification claim from the strictly validated manifest
      //    (never a separate Agent claim). The normalized manifest ALWAYS
      //    carries the boolean `productionVerified`, so this is never a guess;
      //    the independent validator rejects unsupported true claims, so the
      //    persisted value is always false (fail closed).
      const validationSummary: ModelValidationSummary = {
        solidWorksVersion: input.validation.manifest.solidWorksVersion,
        units: input.validation.manifest.units,
        projectionDecision: input.validation.manifest.projectionDecision,
        featureCount: input.validation.manifest.featureCount,
        bodyCount: input.validation.manifest.bodyCount,
        rebuildStatus: input.validation.manifest.rebuildStatus,
        unresolvedAssumptions: input.validation.manifest.unresolvedAssumptions
      };
      const productionVerified = input.validation.manifest.productionVerified;
      try {
        this.db
          .prepare(
            "INSERT INTO models " +
              "(id, number, drawing_id, revision_id, run_id, review_status, generated_at, " +
              " validation_summary_json, build_report_summary, production_verified) " +
              "VALUES (?, ?, ?, ?, ?, 'PENDING_REVIEW', ?, ?, ?, ?)"
          )
          .run(
            modelId,
            number,
            run.drawing_id,
            run.revision_id,
            run.id,
            finishedAt,
            JSON.stringify(validationSummary),
            buildReportSummary ?? null,
            productionVerified ? 1 : 0
          );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new EntityConflictError(
            `A Model with number ${number} already exists for Revision ${run.revision_id}`,
            { revisionId: run.revision_id, number }
          );
        }
        throw error;
      }

      // 5. Artifact metadata rows bound to the Model AND the Run. Only the
      //    validator's verified records are persisted — the canonical
      //    workspace-relative path, size and sha256 of the actual bytes, the
      //    file name from the strictly validated manifest reference and the
      //    deterministic MIME — for all declared artifacts, including the
      //    optional processMp4.
      const artifactIds: string[] = [];
      const insertArtifact = this.db.prepare(
        "INSERT INTO artifacts " +
          "(id, run_id, model_id, kind, file_name, relative_path, size_bytes, sha256, mime_type, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const artifact of input.validation.artifacts) {
        const artifactId = generateId();
        try {
          insertArtifact.run(
            artifactId,
            run.id,
            modelId,
            artifact.kind,
            artifact.fileName,
            artifact.relativePath,
            artifact.sizeBytes,
            artifact.sha256,
            artifact.mimeType ?? null,
            finishedAt
          );
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            // Defense in depth: the validator already rejects duplicate
            // canonical paths as ARTIFACT_MANIFEST_INVALID, so reaching this
            // unique (run_id, relative_path) index means the same canonical
            // file was published twice for this Run — an invariant breach
            // surfaced structurally, never a silent overwrite (and the whole
            // transaction rolls back).
            throw new RunnerInvariantError(
              `Artifact metadata for run ${run.id} collides with an existing row (${artifact.relativePath})`,
              { runId: run.id, modelId, relativePath: artifact.relativePath }
            );
          }
          throw error;
        }
        artifactIds.push(artifactId);
      }

      // 6. Terminal event + attempt finish in the SAME transaction: the
      //    Completed projection resolves the just-inserted Model and the
      //    attempt is finished FINISHED.
      this.runs.appendRunEvents({
        runId: input.runId,
        attemptId: input.attemptId,
        entries: [{ payload: { type: "Completed", modelId }, occurredAt: finishedAt }]
      });
      const attempt = this.writeAttemptTransition(row, next, input.ownerToken);
      const model: Model = {
        id: modelId,
        number,
        drawingId: run.drawing_id,
        revisionId: run.revision_id,
        runId: run.id,
        reviewStatus: "PENDING_REVIEW",
        generatedAt: finishedAt,
        productionVerified,
        validationSummary,
        ...(buildReportSummary === undefined ? {} : { buildReportSummary }),
        artifactIds
      };
      return { attempt, model };
    });
  }

  /**
   * Atomically ends a failed execution: appends the terminal Failed event
   * (failure code/message) and finishes the attempt INTERRUPTED with
   * `UNEXPECTED_INTERRUPTION` in ONE transaction. A failure is an unexpected
   * stop for the attempt lifecycle, never a cancellation.
   */
  failAttempt(input: FailRunAttemptRequest): RunAttempt {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    const finishedAt =
      input.finishedAt === undefined ? this.canonicalNow() : this.canonicalIso(input.finishedAt);
    return this.db.transaction(() => {
      const row = this.assertAttemptOwnership(input.runId, input.attemptId, input.ownerToken);
      const next = this.pinnedFinish(row, {
        status: "INTERRUPTED",
        finishedAt,
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      this.runs.appendRunEvents({
        runId: input.runId,
        attemptId: input.attemptId,
        entries: [
          {
            payload: {
              type: "Failed",
              failureCode: input.failureCode,
              ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage })
            },
            occurredAt: finishedAt
          }
        ]
      });
      return this.writeAttemptTransition(row, next, input.ownerToken);
    });
  }

  /**
   * Atomically ends a clarification: persists the OPEN Clarification Request
   * with its questions, appends the ClarificationRequired event and finishes
   * the attempt FINISHED in ONE transaction. The request, the event and the
   * attempt finish are never observable apart; the old Run never resumes.
   */
  clarifyAttempt(input: ClarifyRunAttemptRequest): {
    attempt: RunAttempt;
    clarificationRequestId: string;
  } {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    const finishedAt =
      input.finishedAt === undefined ? this.canonicalNow() : this.canonicalIso(input.finishedAt);
    return this.db.transaction(() => {
      const row = this.assertAttemptOwnership(input.runId, input.attemptId, input.ownerToken);
      const request = this.runs.persistClarificationRequest({
        runId: input.runId,
        questions: input.questions,
        createdAt: finishedAt
      });
      this.runs.appendRunEvents({
        runId: input.runId,
        attemptId: input.attemptId,
        entries: [
          {
            payload: { type: "ClarificationRequired", clarificationRequestId: request.id },
            occurredAt: finishedAt
          }
        ]
      });
      const next = this.pinnedFinish(row, { status: "FINISHED", finishedAt });
      const attempt = this.writeAttemptTransition(row, next, input.ownerToken);
      return { attempt, clarificationRequestId: request.id };
    });
  }

  /**
   * Atomically cancels a QUEUED Run without execution: mints (or reuses) a
   * cancellation-scoped attempt, appends the cancellation pair and finishes
   * the attempt CANCELLED in ONE transaction. No stage event is ever emitted,
   * no workspace is created and no Model is published; the minted attempt is
   * never observable as an execution attempt.
   */
  cancelQueuedRun(input: CancelQueuedRunRequest): RunAttempt {
    assertSafeIdToken("runId", input.runId);
    const finishedAt =
      input.finishedAt === undefined ? this.canonicalNow() : this.canonicalIso(input.finishedAt);
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT id, status FROM runs WHERE id = ?").get(input.runId) as
        | { id: string; status: string }
        | undefined;
      if (run === undefined) {
        throw new NotFoundError(`Run ${input.runId} was not found`, { runId: input.runId });
      }
      if (run.status !== "QUEUED") {
        throw new RunnerInvariantError(
          `Run ${input.runId} is ${run.status}; only a QUEUED Run can be cancelled without execution`,
          { runId: input.runId, status: run.status }
        );
      }
      const existing = this.db
        .prepare(
          "SELECT * FROM run_attempts WHERE run_id = ? AND status = 'ACTIVE' " +
            "ORDER BY attempt_sequence DESC LIMIT 1"
        )
        .get(input.runId) as AttemptRow | undefined;
      let attemptId: string;
      if (existing !== undefined) {
        attemptId = existing.id;
        // A live foreign lease is never stolen, not even for reuse.
        this.assertCancelEligible(existing, finishedAt, "queued cancellation");
        if (existing.owner_token !== this.ownerToken) {
          this.reownAttempt(existing, finishedAt);
        }
      } else {
        attemptId = this.mintCancellationAttempt(input.runId, finishedAt);
      }
      this.runs.appendRunEvents({
        runId: input.runId,
        attemptId,
        entries: [
          {
            payload: {
              type: "CancellationRequested",
              ...(input.reason === undefined ? {} : { reason: input.reason })
            },
            occurredAt: finishedAt
          },
          { payload: { type: "CancellationConfirmed" }, occurredAt: finishedAt }
        ]
      });
      const row = this.getAttemptRow(attemptId);
      if (row === null) {
        throw new RunnerInvariantError(
          `The cancellation-scoped attempt ${attemptId} disappeared while being cancelled`,
          { attemptId }
        );
      }
      const next = this.pinnedFinish(row, {
        status: "CANCELLED",
        finishedAt,
        interruptionKind: "CANCELLED"
      });
      return this.writeAttemptTransition(row, next, this.ownerToken);
    });
  }

  /**
   * Atomically confirms a cancellation: appends the terminal
   * CancellationConfirmed event and finishes the attempt CANCELLED in ONE
   * transaction. An ACTIVE attempt owned by another (dead) owner is re-owned
   * in the same transaction, so a stale RUNNING Run's cancel can be confirmed
   * without inventing a cancellation anywhere else. CancellationRequested must
   * already be persisted (the cancel coordinator does that before signaling).
   */
  cancelAttempt(input: CancelRunAttemptRequest): RunAttempt {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    const finishedAt =
      input.finishedAt === undefined ? this.canonicalNow() : this.canonicalIso(input.finishedAt);
    return this.db.transaction(() => {
      const row = this.getAttemptRow(input.attemptId);
      if (row === null) {
        throw new NotFoundError(`Attempt ${input.attemptId} was not found`, {
          attemptId: input.attemptId
        });
      }
      if (row.run_id !== input.runId) {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} belongs to run ${row.run_id}, not ${input.runId}`,
          { attemptId: input.attemptId, runId: input.runId }
        );
      }
      if (row.status !== "ACTIVE") {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} is ${row.status ?? "unset"}; only an ACTIVE attempt can be cancelled`,
          { attemptId: input.attemptId, status: row.status }
        );
      }
      // A live foreign lease is never stolen: re-owning happens only when the
      // attempt is stale (its owner vanished past the lease).
      this.assertCancelEligible(row, finishedAt, "cancel confirmation");
      if (row.owner_token !== input.ownerToken) {
        this.reownAttempt(row, finishedAt);
      }
      this.runs.appendRunEvents({
        runId: input.runId,
        attemptId: input.attemptId,
        entries: [{ payload: { type: "CancellationConfirmed" }, occurredAt: finishedAt }]
      });
      const next = this.pinnedFinish(row, {
        status: "CANCELLED",
        finishedAt,
        interruptionKind: "CANCELLED"
      });
      return this.writeAttemptTransition(row, next, input.ownerToken);
    });
  }

  /**
   * Atomically records a cancel-cleanup failure: appends the terminal Failed
   * event with `CANCEL_CLEANUP_PENDING` and finishes the attempt INTERRUPTED
   * in ONE transaction — the Run never claims a full cancellation. A stale
   * foreign-owned attempt is re-owned safely inside the transaction; a live
   * foreign lease surfaces as `LiveForeignLeaseError` (never stolen).
   */
  failCancelCleanup(input: FailCancelCleanupRequest): RunAttempt {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    const finishedAt =
      input.finishedAt === undefined ? this.canonicalNow() : this.canonicalIso(input.finishedAt);
    return this.db.transaction(() => {
      const row = this.getAttemptRow(input.attemptId);
      if (row === null) {
        throw new NotFoundError(`Attempt ${input.attemptId} was not found`, {
          attemptId: input.attemptId
        });
      }
      if (row.run_id !== input.runId) {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} belongs to run ${row.run_id}, not ${input.runId}`,
          { attemptId: input.attemptId, runId: input.runId }
        );
      }
      if (row.status !== "ACTIVE") {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} is ${row.status ?? "unset"}; only an ACTIVE attempt can fail a cancel cleanup`,
          { attemptId: input.attemptId, status: row.status }
        );
      }
      this.assertCancelEligible(row, finishedAt, "cancel cleanup failure");
      if (row.owner_token !== input.ownerToken) {
        this.reownAttempt(row, finishedAt);
      }
      this.runs.appendRunEvents({
        runId: input.runId,
        attemptId: input.attemptId,
        entries: [
          {
            payload: {
              type: "Failed",
              failureCode: "CANCEL_CLEANUP_PENDING",
              ...(input.failureMessage === undefined ? {} : { failureMessage: input.failureMessage })
            },
            occurredAt: finishedAt
          }
        ]
      });
      const next = this.pinnedFinish(row, {
        status: "INTERRUPTED",
        finishedAt,
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      });
      return this.writeAttemptTransition(row, next, input.ownerToken);
    });
  }

  /**
   * Phase 5 cancellation lease fence (atomic): establishes THIS orchestrator as
   * the cleanup owner of the exact RUNNING Run + ACTIVE attempt BEFORE the
   * cancel coordinator performs any destructive step (ownership close /
   * workspace deletion / terminal confirm). One transaction:
   *
   * 1. the exact runId/attemptId pair must be the ACTIVE attempt of a RUNNING
   *    Run — anything else is a structured invariant (the coordinator maps a
   *    Run that settled in the meantime to its stable outcome);
   * 2. the Run must have a PERSISTED CancellationRequested — the cleanup fence
   *    is bound to REAL cancel intent, never to a mere run-state coincidence.
   *    A RUNNING Run without one is a structured invariant and NOTHING is
   *    mutated (no lease refresh, no re-own, no event);
   * 3. a live foreign lease is never stolen: `LiveForeignLeaseError` surfaces
   *    and the attempt is left byte-identical (the coordinator returns
   *    CANCEL_PENDING without touching ownership or the workspace);
   * 4. a stale foreign attempt (its owner vanished past the lease) is re-owned
   *    to this owner WITH A FRESH LEASE — unlike the terminal-path re-own whose
   *    lease is moot (the finish follows in the same transaction), the fence
   *    lease must be live so no other Runner's recovery scan can re-own the
   *    attempt while the cleanup runs;
   * 5. the same owner — even with an EXPIRED lease — refreshes heartbeat and
   *    lease in place (an own claim that stopped heartbeating during the
   *    cooperative stop must not leave the cleanup window unprotected).
   *
   * The fence lease deadline is `max(normal run lease duration,
   * DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS)` after the fence instant, so a
   * short configured run lease can never shorten the cleanup window below the
   * bound the live cleanup provably needs (see the minimum constant for the
   * proof).
   *
   * The attempt stays ACTIVE; no terminal event and no recovery decision are
   * written. Either this fence wins (the attempt holds OUR live lease and a
   * foreign recovery scan SKIPs it) or the foreign owner won first and this
   * call throws — destructive work can never follow a takeover.
   */
  seizeCancelCleanupOwnership(input: SeizeCancelCleanupOwnershipInput): RunAttempt {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    const at = input.at === undefined ? this.canonicalNow() : this.canonicalIso(input.at);
    return this.db.transaction(() => {
      const row = this.getAttemptRow(input.attemptId);
      if (row === null) {
        throw new NotFoundError(`Attempt ${input.attemptId} was not found`, {
          attemptId: input.attemptId
        });
      }
      if (row.run_id !== input.runId) {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} belongs to run ${row.run_id}, not ${input.runId}; the cleanup ownership cannot be established`,
          { attemptId: input.attemptId, runId: input.runId }
        );
      }
      if (row.status !== "ACTIVE") {
        throw new RunnerInvariantError(
          `Attempt ${input.attemptId} is ${row.status ?? "unset"}; only an ACTIVE attempt can hold the cleanup ownership`,
          { attemptId: input.attemptId, status: row.status }
        );
      }
      const run = this.db
        .prepare("SELECT status, cancellation_requested_at FROM runs WHERE id = ?")
        .get(input.runId) as
        | { status: string; cancellation_requested_at: string | null }
        | undefined;
      if (run === undefined) {
        throw new NotFoundError(`Run ${input.runId} was not found`, { runId: input.runId });
      }
      if (run.status !== "RUNNING") {
        throw new RunnerInvariantError(
          `Run ${input.runId} is ${run.status}; only a RUNNING Run can hold the cleanup ownership`,
          { runId: input.runId, status: run.status }
        );
      }
      if (run.cancellation_requested_at === null) {
        // The cleanup fence is bound to REAL cancel intent: without a persisted
        // CancellationRequested there is nothing to clean up after, and the
        // fence must never mint a lease on an uncancelled Run. Throw BEFORE
        // any mutation — the attempt and the Run stay byte-identical.
        throw new RunnerInvariantError(
          `Run ${input.runId} has no persisted CancellationRequested; the cleanup ownership ` +
            "fence requires real cancel intent and nothing was mutated",
          { runId: input.runId }
        );
      }
      // A live foreign lease is never stolen — not even for the cleanup fence.
      this.assertCancelEligible(row, at, "cancel cleanup ownership");
      const fenceLeaseDeadlineAt = this.cancelCleanupDeadlineFrom(at);
      if (row.owner_token !== input.ownerToken) {
        // Stale foreign attempt: re-own with a FRESH fence lease.
        this.reownAttempt(row, at, fenceLeaseDeadlineAt);
      } else {
        // Same owner, even expired: refresh heartbeat and lease in place so the
        // whole cleanup window stays fenced against foreign recovery re-owns.
        const updated = this.db
          .prepare(
            "UPDATE run_attempts SET heartbeat_at = ?, lease_deadline_at = ? " +
              "WHERE id = ? AND status = 'ACTIVE' AND owner_token = ?"
          )
          .run(at, fenceLeaseDeadlineAt, row.id, input.ownerToken);
        if (Number(updated.changes) !== 1) {
          throw new RunnerInvariantError(
            `Attempt ${row.id} changed concurrently; the cleanup lease was not established`,
            { attemptId: row.id }
          );
        }
      }
      return this.readAttempt(input.attemptId);
    });
  }

  // -------------------------------------------------------------------------
  // Guarded raw finish
  // -------------------------------------------------------------------------

  /**
   * The guarded raw finish: ends an ACTIVE attempt whose Run has ALREADY
   * reached its terminal status through a persisted terminal event. The
   * interruption kind is DERIVED from the requested status (FINISHED records
   * none, INTERRUPTED records `UNEXPECTED_INTERRUPTION`, CANCELLED records
   * `CANCELLED` — the request exposes no caller-chosen kind), and the
   * Run-status mapping pins the attempt status:
   *
   * - FINISHED only when the Run is COMPLETED or CLARIFICATION_REQUIRED;
   * - CANCELLED only when the Run is CANCELLED;
   * - INTERRUPTED only when the Run is FAILED.
   *
   * Callers that still own the terminal transition should use the atomic
   * `completeAttempt` / `failAttempt` / `cancelAttempt` / `clarifyAttempt`
   * operations instead.
   */
  finishAttempt(input: FinishRunAttemptRequest): RunAttempt {
    this.assertAttemptInput(input.runId, input.attemptId, input.ownerToken);
    const finishedAt =
      input.finishedAt === undefined ? this.canonicalNow() : this.canonicalIso(input.finishedAt);
    return this.db.transaction(() => {
      const row = this.assertAttemptOwnership(input.runId, input.attemptId, input.ownerToken);
      const interruptionKind = interruptionKindFor(input.status);
      const next = this.pinnedFinish(row, {
        status: input.status,
        finishedAt,
        ...(interruptionKind === undefined ? {} : { interruptionKind })
      });
      this.assertRunStatusPinsAttempt(input.status, input.runId, input.attemptId);
      return this.writeAttemptTransition(row, next, input.ownerToken);
    });
  }

  /**
   * Loads the attempt and enforces the exact run/attempt/owner triple inside
   * the current transaction.
   */
  private assertAttemptOwnership(runId: string, attemptId: string, ownerToken: string): AttemptRow {
    const row = this.getAttemptRow(attemptId);
    if (row === null) {
      throw new NotFoundError(`Attempt ${attemptId} was not found`, { attemptId });
    }
    if (row.run_id !== runId) {
      throw new RunnerInvariantError(`Attempt ${attemptId} belongs to run ${row.run_id}, not ${runId}`, {
        attemptId,
        runId
      });
    }
    if (row.owner_token !== ownerToken) {
      throw new RunnerInvariantError(
        `Attempt ${attemptId} is owned by another token; only the exact owner may end it`,
        { attemptId }
      );
    }
    return row;
  }

  /** Domain `finishRunAttempt` with the canonical error surface. */
  private pinnedFinish(row: AttemptRow, input: FinishRunAttemptInput): RunAttempt {
    try {
      return finishRunAttempt(this.mapAttempt(row), input);
    } catch (error) {
      if (error instanceof DomainInvariantError) {
        throw new RunnerInvariantError(error.message, {
          attemptId: row.id,
          status: input.status
        });
      }
      throw error;
    }
  }

  /**
   * The Run-status pin of the guarded finish: the Run must already be in the
   * terminal status the attempt status records.
   */
  private assertRunStatusPinsAttempt(
    attemptStatus: TerminalRunAttemptStatus,
    runId: string,
    attemptId: string
  ): void {
    const run = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    if (run === undefined) {
      throw new NotFoundError(`Run ${runId} was not found`, { runId });
    }
    const allowed = RUN_STATUS_PIN[attemptStatus];
    if (!allowed.includes(run.status)) {
      throw new RunnerInvariantError(
        `Attempt ${attemptId} may only be finished ${attemptStatus} when its Run is ` +
          `${allowed.join(" or ")}; the Run is ${run.status}. Append the terminal Run event ` +
          `first (or use completeAttempt / failAttempt for the atomic transition)`,
        { attemptId, runId, attemptStatus, runStatus: run.status }
      );
    }
  }

  /** Conditional terminal write of the public finish paths. */
  private writeAttemptTransition(row: AttemptRow, next: RunAttempt, ownerToken: string): RunAttempt {
    const updated = this.db
      .prepare(
        "UPDATE run_attempts SET status = ?, finished_at = ?, interruption_kind = ? " +
          "WHERE id = ? AND status = 'ACTIVE' AND owner_token = ?"
      )
      .run(
        next.status,
        next.finishedAt ?? null,
        next.interruptionKind ?? null,
        row.id,
        ownerToken
      );
    if (Number(updated.changes) !== 1) {
      throw new RunnerInvariantError(
        `Attempt ${row.id} changed concurrently and could not be finished`,
        { attemptId: row.id }
      );
    }
    return next;
  }

  /**
   * Mints the cancellation-scoped ACTIVE attempt of a QUEUED Run. The row is
   * created and finished CANCELLED inside the caller's transaction, so it is
   * never observable as an execution attempt; the event envelope requires a
   * persisted attempt reference even on the QUEUED path. The attempt is
   * KIND 'CANCELLATION': the one-unfinished-attempt-per-owner index is
   * EXECUTION-scoped (schema v3), so minting here never collides with the
   * execution attempt of a Run this Runner is currently executing — the
   * queued cancellation of one Run succeeds while another Run is RUNNING.
   */
  private mintCancellationAttempt(runId: string, at: string): string {
    const attemptId = generateId();
    try {
      this.db
        .prepare(
          "INSERT INTO run_attempts " +
            "(id, run_id, attempt_sequence, status, kind, owner_token, claimed_at, " +
            " lease_deadline_at, heartbeat_at, started_at, created_at) " +
            "VALUES (?, ?, ?, 'ACTIVE', 'CANCELLATION', ?, ?, ?, ?, ?, ?)"
        )
        .run(
          attemptId,
          runId,
          this.nextAttemptSequence(runId),
          this.ownerToken,
          at,
          at,
          at,
          at,
          at
        );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new RunnerInvariantError(
          `The cancellation-scoped attempt of run ${runId} collided with a concurrent writer; ` +
            "the queued cancellation could not be minted",
          { runId }
        );
      }
      throw error;
    }
    return attemptId;
  }

  /**
   * Re-owns an ACTIVE attempt of another (dead) owner for the cancel path, in
   * the caller's transaction. Mirrors the recovery resume: the user cancel
   * intent is authoritative for the Run, so the confirm finish can write the
   * attempt the current owner never claimed. Callers must run
   * `assertCancelEligible` first — a live foreign lease is never stolen.
   *
   * The lease deadline defaults to `at` itself (already expired) — the
   * terminal-path callers finish the attempt in the same transaction, so the
   * deadline is moot there. The cancellation lease fence
   * (`seizeCancelCleanupOwnership`) passes a FRESH deadline instead: its
   * re-owned attempt must hold a live lease for the whole cleanup window so no
   * other Runner's recovery scan can take it back mid-cleanup.
   */
  private reownAttempt(row: AttemptRow, at: string, leaseDeadlineAt: string = at): void {
    try {
      const updated = this.db
        .prepare(
          "UPDATE run_attempts SET owner_token = ?, heartbeat_at = ?, lease_deadline_at = ? " +
            "WHERE id = ? AND status = 'ACTIVE'"
        )
        .run(this.ownerToken, at, leaseDeadlineAt, row.id);
      if (Number(updated.changes) !== 1) {
        throw new RunnerInvariantError(
          `Attempt ${row.id} changed concurrently and could not be re-owned for the cancellation`,
          { attemptId: row.id }
        );
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new RunnerInvariantError(
          `This Runner already holds an unfinished attempt; the cancellation of attempt ${row.id} could not re-own it`,
          { attemptId: row.id }
        );
      }
      throw error;
    }
  }

  /**
   * The cancel-path eligibility guard: an ACTIVE attempt owned by ANOTHER
   * owner with a VALID lease must never be re-owned, finished or otherwise
   * touched by this orchestrator — that would steal a live foreign lease.
   * Throws `LiveForeignLeaseError`; the coordinator surfaces the explicit
   * pending outcome without touching the attempt or its workspace.
   */
  private assertCancelEligible(row: AttemptRow, now: string, operation: string): void {
    if (
      row.owner_token !== null &&
      row.owner_token !== this.ownerToken &&
      row.lease_deadline_at !== null &&
      !isLeaseExpired(row.lease_deadline_at, now)
    ) {
      throw new LiveForeignLeaseError(
        `${operation}: attempt ${row.id} belongs to another owner whose lease is still valid ` +
          `(${row.lease_deadline_at}); a live foreign lease must never be stolen`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Startup / expired-lease recovery
  // -------------------------------------------------------------------------

  /**
   * The startup / expired-lease recovery scan, safe to run at every open.
   * Two sweeps:
   *
   * 1. Every ACTIVE attempt whose lease expired is reconsidered per attempt:
   *    - the Run is QUEUED: SAFE — no execution was claimed, the dangling
   *      attempt is finished as an unexpected interruption without events, the
   *      Run stays claimable;
   *    - the Run is already terminal: SAFE cleanup — the dangling attempt is
   *      reconciled to the settled Run without further events (FINISHED for
   *      COMPLETED/CLARIFICATION_REQUIRED, INTERRUPTED for FAILED and for
   *      CANCELLED — recovery never invents a cancellation);
   *    - the Run is RUNNING at a PREPARING/ANALYZING/PLANNING stage (or has no
   *      recorded stage): RESUMED when the injected `canSafelyResume` proof
   *      holds, RECOVERY_UNSUPPORTED when it returns false, RECOVERY_FAILED
   *      when the probe throws — the latter two append a Failed interruption
   *      event and mark the attempt INTERRUPTED;
   *    - the Run is RUNNING at MODELING/VALIDATING/PACKAGING: RESUMED only
   *      with an explicit `hasSafeCheckpoint` proof, otherwise RECOVERY_FAILED
   *      (no checkpoint) with the Failed event + INTERRUPTED attempt.
   *    A resume that collides with the one-unfinished-attempt-per-owner
   *    constraint is SKIPPED (its resume is refused in this scan; the attempt
   *    still holds no live lease, so the wedge sweep below then fails the Run
   *    truthfully — a SKIPPED resume never aborts the rest of the scan), and
   *    any per-candidate failure is isolated as SCAN_FAILED so one broken
   *    candidate never aborts the rest of the scan.
   *
   * 2. RUNNING Runs with no live ACTIVE attempt (a wedged queue) are failed
   *    with AGENT_INTERRUPTED / RECOVERY_FAILED, referencing the most recent
   *    persisted attempt — or minting the canonical attempt record when none
   *    exists — so the single-active slot always frees.
   *
   * The Failed events always reference a persisted attempt (canonical attempt
   * existence requirement), never publish a Model and never write CANCELLED.
   */
  recoverExpiredAttempts(): RecoveryScanResult {
    const now = this.canonicalNow();
    const candidates = this.db
      .prepare(
        "SELECT ra.id AS attempt_id, ra.run_id AS run_id " +
          "FROM run_attempts ra JOIN runs r ON r.id = ra.run_id " +
          "WHERE ra.status = 'ACTIVE' AND ra.lease_deadline_at IS NOT NULL " +
          "  AND ra.lease_deadline_at <= ? " +
          "ORDER BY ra.lease_deadline_at ASC, ra.id ASC"
      )
      .all(now) as unknown as Array<{ attempt_id: string; run_id: string }>;
    const entries: RecoveryScanEntry[] = [];
    for (const candidate of candidates) {
      entries.push(this.recoverCandidateSafely(candidate, now));
    }
    for (const wedged of this.listWedgedRuns(now)) {
      entries.push(this.recoverWedgeSafely(wedged, now));
    }
    return { scannedAt: now, found: candidates.length, entries };
  }

  /** Isolates one expired-attempt candidate from the rest of the scan. */
  private recoverCandidateSafely(
    candidate: { attempt_id: string; run_id: string },
    now: string
  ): RecoveryScanEntry {
    try {
      return this.db.transaction(() => this.recoverOne(candidate.attempt_id, now));
    } catch (error) {
      if (error instanceof ResumeOwnerConflictError) {
        return {
          attemptId: candidate.attempt_id,
          runId: candidate.run_id,
          outcome: "SKIPPED",
          decision: null,
          stage: null,
          failureCode: null,
          reason:
            "the current owner already holds another unfinished attempt, so the resume was skipped; " +
            "the attempt holds no live lease and the wedged Run is failed by the wedge sweep of this scan"
        };
      }
      return {
        attemptId: candidate.attempt_id,
        runId: candidate.run_id,
        outcome: "SCAN_FAILED",
        decision: null,
        stage: null,
        failureCode: null,
        reason: `recovery could not complete and the attempt was left unchanged: ${errorMessage(error)}`
      };
    }
  }

  /** Isolates one wedged-Run repair from the rest of the scan. */
  private recoverWedgeSafely(
    wedged: { run_id: string; stage: string | null },
    now: string
  ): RecoveryScanEntry {
    try {
      return this.db.transaction(() => this.recoverWedge(wedged.run_id, wedged.stage, now));
    } catch (error) {
      return {
        attemptId: null,
        runId: wedged.run_id,
        outcome: "SCAN_FAILED",
        decision: null,
        stage: null,
        failureCode: null,
        reason: `the wedged Run could not be failed yet and stays for the next scan: ${errorMessage(error)}`
      };
    }
  }

  /**
   * RUNNING Runs whose attempts are all terminal (or whose ACTIVE attempts
   * hold no valid lease) have no live executor and would wedge the queue.
   */
  private listWedgedRuns(now: string): Array<{ run_id: string; stage: string | null }> {
    return this.db
      .prepare(
        "SELECT r.id AS run_id, r.stage AS stage FROM runs r " +
          "WHERE r.status = 'RUNNING' AND NOT EXISTS (" +
          "  SELECT 1 FROM run_attempts ra WHERE ra.run_id = r.id AND ra.status = 'ACTIVE' " +
          "    AND ra.lease_deadline_at IS NOT NULL AND ra.lease_deadline_at > ?" +
          ") ORDER BY r.created_at ASC, r.id ASC"
      )
      .all(now) as unknown as Array<{ run_id: string; stage: string | null }>;
  }

  /**
   * Fails a wedged RUNNING Run with AGENT_INTERRUPTED / RECOVERY_FAILED. The
   * Failed event references the most recent persisted attempt; when the Run
   * has no attempt at all, a minimal ACTIVE attempt record is minted so the
   * canonical event-attempt requirement holds — the event is appended while
   * the attempt is ACTIVE and the attempt is terminated right after (P3-3
   * review: execution events must reference an ACTIVE attempt). A stale ACTIVE
   * attempt (no valid lease) is terminated after the event as well.
   */
  private recoverWedge(runId: string, stageValue: string | null, now: string): RecoveryScanEntry {
    const run = this.db
      .prepare("SELECT status, cancellation_requested_at FROM runs WHERE id = ?")
      .get(runId) as { status: string; cancellation_requested_at: string | null } | undefined;
    if (run === undefined) {
      throw new RunnerInvariantError(`Wedged run ${runId} does not exist`, { runId });
    }
    // The user cancel owns the aftermath: a wedged RUNNING Run whose
    // cancellation was requested is never auto-failed — the explicit cancel
    // retry settles it. Left untouched (no minted attempt, no event); the
    // executor's idle loop bounds its own reconsideration of this state, so
    // the wedged slot never turns into a busy loop.
    if (run.cancellation_requested_at !== null) {
      return {
        attemptId: null,
        runId,
        outcome: "SKIPPED",
        decision: null,
        stage: this.toStage(stageValue, runId),
        failureCode: null,
        reason:
          "the wedged RUNNING Run has a persisted CancellationRequested: recovery must not auto-fail it — the explicit cancel retry owns the aftermath"
      };
    }
    const stage = this.toStage(stageValue, runId);
    const latest = this.db
      .prepare("SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt_sequence DESC LIMIT 1")
      .get(runId) as AttemptRow | undefined;
    let attemptId: string;
    let minted: AttemptRow | null = null;
    if (latest === undefined) {
      attemptId = generateId();
      this.db
        .prepare(
          "INSERT INTO run_attempts " +
            "(id, run_id, attempt_sequence, status, kind, created_at) " +
            "VALUES (?, ?, 1, 'ACTIVE', 'EXECUTION', ?)"
        )
        .run(attemptId, runId, now);
      const row = this.getAttemptRow(attemptId);
      if (row === null) {
        throw new RunnerInvariantError(
          `The minted wedge attempt ${attemptId} disappeared while being recovered`,
          { attemptId }
        );
      }
      minted = row;
    } else {
      attemptId = latest.id;
    }
    const reason =
      "the Run was RUNNING with no live attempt (its executing owner vanished); " +
      "it is failed with AGENT_INTERRUPTED so the queue cannot wedge";
    this.runs.appendRunEvents({
      runId,
      attemptId,
      entries: [
        {
          payload: { type: "Failed", failureCode: "AGENT_INTERRUPTED", failureMessage: reason },
          occurredAt: now
        }
      ]
    });
    if (minted !== null) {
      this.terminateAttempt(minted, "INTERRUPTED", now, "RECOVERY_FAILED");
    } else if (latest?.status === "ACTIVE") {
      this.terminateAttempt(latest, "INTERRUPTED", now, "RECOVERY_FAILED");
    }
    return {
      attemptId,
      runId,
      outcome: "RECOVERY_FAILED",
      decision: "RECOVERY_FAILED",
      stage,
      failureCode: "AGENT_INTERRUPTED",
      reason
    };
  }

  private recoverOne(attemptId: string, now: string): RecoveryScanEntry {
    const row = this.getAttemptRow(attemptId);
    if (row === null) {
      return {
        attemptId,
        runId: "",
        outcome: "SKIPPED",
        decision: null,
        stage: null,
        failureCode: null,
        reason: "the attempt no longer exists"
      };
    }
    const runId = row.run_id;
    if (row.status !== "ACTIVE") {
      return {
        attemptId,
        runId,
        outcome: "SKIPPED",
        decision: null,
        stage: null,
        failureCode: null,
        reason: `the attempt is already ${row.status ?? "unset"}`
      };
    }
    if (row.lease_deadline_at === null || !isLeaseExpired(row.lease_deadline_at, now)) {
      return {
        attemptId,
        runId,
        outcome: "SKIPPED",
        decision: null,
        stage: null,
        failureCode: null,
        reason: "the lease was renewed before the scan reached the attempt"
      };
    }
    const runRow = this.db
      .prepare("SELECT id, number, status, stage, completed_at, cancellation_requested_at FROM runs WHERE id = ?")
      .get(runId) as OrchestratorRunRow | undefined;
    if (runRow === undefined) {
      throw new RunnerInvariantError(`Attempt ${attemptId} references a Run that does not exist`, {
        attemptId,
        runId
      });
    }
    const stage = this.toStage(runRow.stage, runId);

    switch (runRow.status) {
      case "QUEUED":
        // The claim transition never committed for this Run: no execution was
        // claimed, so the Run is safe and stays claimable. Only the dangling
        // ACTIVE attempt is finished (no events: QUEUED accepts none).
        this.terminateAttempt(row, "INTERRUPTED", now, null);
        return {
          attemptId,
          runId,
          outcome: "SAFE",
          decision: null,
          stage: null,
          failureCode: null,
          reason:
            "the Run is QUEUED: no execution was ever claimed, the dangling attempt was finished as INTERRUPTED and the Run stays claimable"
        };
      case "RUNNING":
        // The user cancel owns the aftermath: recovery must neither resume nor
        // auto-fail a RUNNING Run whose cancellation was requested — the
        // explicit cancel retry settles it (it re-owns and confirms once the
        // cleanup lease expires). The attempt is left byte-identical; the
        // executor's idle loop bounds its own reconsideration of this state,
        // so the skipped expired lease never turns into a busy loop.
        if (runRow.cancellation_requested_at !== null) {
          return {
            attemptId,
            runId,
            outcome: "SKIPPED",
            decision: null,
            stage,
            failureCode: null,
            reason:
              "the RUNNING Run has a persisted CancellationRequested: recovery must not resume or fail it — the explicit cancel retry owns the aftermath"
          };
        }
        break;
      default: {
        // A terminal Run with a dangling ACTIVE attempt: the Run read-model is
        // already settled, only the attempt row is reconciled to it. No events
        // are appended (terminal Runs accept none) and nothing is published.
        const finishedAt = runRow.completed_at ?? now;
        if (runRow.status === "COMPLETED" || runRow.status === "CLARIFICATION_REQUIRED") {
          this.terminateAttempt(row, "FINISHED", finishedAt, null);
          return {
            attemptId,
            runId,
            outcome: "SAFE",
            decision: null,
            stage,
            failureCode: null,
            reason: `the Run is ${runRow.status}: the dangling ACTIVE attempt was reconciled as FINISHED without further events`
          };
        }
        // FAILED: the attempt that produced the failure was interrupted.
        // CANCELLED: the user-cancel path settled the Run; the dangling
        // attempt's owner vanished unexpectedly, and recovery never invents a
        // cancellation, so it is reconciled as INTERRUPTED.
        this.terminateAttempt(row, "INTERRUPTED", finishedAt, null);
        return {
          attemptId,
          runId,
          outcome: "SAFE",
          decision: null,
          stage,
          failureCode: null,
          reason: `the Run is ${runRow.status}: the dangling ACTIVE attempt was reconciled as INTERRUPTED without further events (recovery never invents a cancellation)`
        };
      }
    }

    const context: RecoveryCapabilityContext = { runId, attemptId, stage };
    const requiresCheckpoint = stage !== null && !isRecoveryCandidateStage(stage);
    if (requiresCheckpoint) {
      // MODELING / VALIDATING / PACKAGING: never resumed without an explicit
      // safe checkpoint; the domain recovery-candidate rule must not be faked.
      let hasCheckpoint: boolean;
      try {
        hasCheckpoint = this.recovery.hasSafeCheckpoint(context);
      } catch (error) {
        return this.failRecovery(
          row,
          stage,
          now,
          "RECOVERY_FAILED",
          `the safe-checkpoint capability could not be probed at stage ${stage}: ${errorMessage(error)}`
        );
      }
      if (hasCheckpoint) return this.resumeAttempt(row, stage, now);
      return this.failRecovery(
        row,
        stage,
        now,
        "RECOVERY_FAILED",
        `interrupted work at stage ${stage} has no explicit safe checkpoint and cannot be resumed`
      );
    }

    // PREPARING / ANALYZING / PLANNING (or no recorded stage): resume only when
    // the injected capability proves the work safely resumable / idempotent.
    let safe: boolean;
    try {
      safe = this.recovery.canSafelyResume(context);
    } catch (error) {
      return this.failRecovery(
        row,
        stage,
        now,
        "RECOVERY_FAILED",
        `the recovery capability could not be probed at stage ${stage ?? "unrecorded"}: ${errorMessage(error)}`
      );
    }
    if (safe) return this.resumeAttempt(row, stage, now);
    return this.failRecovery(
      row,
      stage,
      now,
      "RECOVERY_UNSUPPORTED",
      `the executor does not prove interrupted work at stage ${stage ?? "unrecorded"} safely resumable`
    );
  }

  /**
   * Re-owns the attempt to this Runner and re-issues its lease with the
   * persisted decision RESUME. The Run stays RUNNING (its stage is untouched);
   * the attempt stays ACTIVE so the executor continues it. When the current
   * owner already holds another unfinished attempt, the resume collides with
   * the uniqueness constraint and surfaces as `ResumeOwnerConflictError` (the
   * scan SKIPs the attempt without aborting).
   */
  private resumeAttempt(row: AttemptRow, stage: RunStage | null, now: string): RecoveryScanEntry {
    const leaseDeadlineAt = this.deadlineFrom(now);
    let updated: { changes: number | bigint };
    try {
      updated = this.db
        .prepare(
          "UPDATE run_attempts SET owner_token = ?, heartbeat_at = ?, lease_deadline_at = ?, " +
            "recovery_decision = 'RESUME' WHERE id = ? AND status = 'ACTIVE'"
        )
        .run(this.ownerToken, now, leaseDeadlineAt, row.id);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ResumeOwnerConflictError();
      }
      throw error;
    }
    if (Number(updated.changes) !== 1) {
      throw new RunnerInvariantError(
        `Attempt ${row.id} changed concurrently and could not be resumed`,
        { attemptId: row.id }
      );
    }
    return {
      attemptId: row.id,
      runId: row.run_id,
      outcome: "RESUMED",
      decision: "RESUME",
      stage,
      failureCode: null,
      reason: `interrupted work at stage ${stage ?? "unrecorded"} is proven safely resumable; the attempt was re-issued to the current owner with a fresh lease`
    };
  }

  /**
   * Appends the terminal Failed interruption/recovery event (referencing the
   * persisted attempt) and marks the attempt INTERRUPTED with the matching
   * recovery decision — in one transaction, never a cancellation, never a
   * Model publish. The failure code mirrors the decision: RECOVERY_UNSUPPORTED
   * when the injected capability explicitly refused, RECOVERY_FAILED when a
   * safe resume path could not be established at all.
   */
  private failRecovery(
    row: AttemptRow,
    stage: RunStage | null,
    now: string,
    code: "RECOVERY_UNSUPPORTED" | "RECOVERY_FAILED",
    reason: string
  ): RecoveryScanEntry {
    this.runs.appendRunEvents({
      runId: row.run_id,
      attemptId: row.id,
      entries: [
        {
          payload: { type: "Failed", failureCode: code, failureMessage: reason },
          occurredAt: now
        }
      ]
    });
    this.terminateAttempt(row, "INTERRUPTED", now, code);
    return {
      attemptId: row.id,
      runId: row.run_id,
      outcome: code,
      decision: code,
      stage,
      failureCode: code,
      reason
    };
  }

  /**
   * The scan's own reconciliation writer: ends an ACTIVE attempt with the
   * domain-pinned semantics (FINISHED records no interruption kind;
   * INTERRUPTED records `UNEXPECTED_INTERRUPTION`) plus the recovery decision
   * column. Used for dangling/failed attempts the scan itself resolves — the
   * public guarded finish path is stricter.
   */
  private terminateAttempt(
    row: AttemptRow,
    status: "FINISHED" | "INTERRUPTED",
    finishedAt: string,
    decision: RunRecoveryDecision | null
  ): void {
    const next = finishRunAttempt(this.mapAttempt(row), {
      status,
      finishedAt,
      ...(status === "INTERRUPTED"
        ? { interruptionKind: "UNEXPECTED_INTERRUPTION" as const }
        : {})
    });
    const updated = this.db
      .prepare(
        "UPDATE run_attempts SET status = ?, finished_at = ?, interruption_kind = ?, " +
          "recovery_decision = ? WHERE id = ? AND status = 'ACTIVE'"
      )
      .run(
        next.status,
        next.finishedAt ?? null,
        next.interruptionKind ?? null,
        decision,
        row.id
      );
    if (Number(updated.changes) !== 1) {
      throw new RunnerInvariantError(
        `Attempt ${row.id} changed concurrently and could not be terminated`,
        { attemptId: row.id }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The persisted attempt mapped to the domain shape, or null. */
  getRunAttempt(attemptId: string): RunAttempt | null {
    assertSafeIdToken("attemptId", attemptId);
    const row = this.getAttemptRow(attemptId);
    return row === null ? null : this.mapAttempt(row);
  }

  /**
   * The single ACTIVE attempt of a Run (the executor's live claim or a stale
   * one awaiting recovery), or null. The RUNNING-cancel coordinator uses it to
   * reference the attempt its CancellationRequested / CancellationConfirmed
   * events must point at. Only EXECUTION attempts qualify: a cancellation
   * attempt is never ACTIVE outside its minting transaction.
   */
  getActiveAttempt(runId: string): RunAttempt | null {
    assertSafeIdToken("runId", runId);
    const row = this.db
      .prepare(
        "SELECT * FROM run_attempts WHERE run_id = ? AND status = 'ACTIVE' AND kind = 'EXECUTION' " +
          "ORDER BY attempt_sequence DESC LIMIT 1"
      )
      .get(runId) as AttemptRow | undefined;
    return row === undefined ? null : this.mapAttempt(row);
  }

  /**
   * The single ACTIVE EXECUTION attempt currently owned by THIS orchestrator,
   * or null. The executor loop consults it first so a recovery-resumed attempt
   * (re-issued to this owner with a fresh lease) continues instead of being
   * re-claimed.
   */
  getActiveAttemptForOwner(): RunAttempt | null {
    const row = this.db
      .prepare(
        "SELECT * FROM run_attempts WHERE owner_token = ? AND status = 'ACTIVE' AND kind = 'EXECUTION' " +
          "ORDER BY attempt_sequence DESC LIMIT 1"
      )
      .get(this.ownerToken) as AttemptRow | undefined;
    return row === undefined ? null : this.mapAttempt(row);
  }

  /**
   * Earliest lease deadline among all ACTIVE attempts, or null when no ACTIVE
   * attempt holds a lease. The executor's idle loop schedules its ongoing
   * recovery wake-up exactly at this instant (lease-deadline-aware retry —
   * never a busy loop), so an in-process lease expiry or a quick restart
   * inside a lease automatically recovers / unblocks.
   */
  nextActiveLeaseDeadline(): string | null {
    const row = this.db
      .prepare(
        "SELECT MIN(lease_deadline_at) AS deadline FROM run_attempts " +
          "WHERE status = 'ACTIVE' AND lease_deadline_at IS NOT NULL"
      )
      .get() as { deadline: string | null };
    return row.deadline;
  }

  /** True when at least one Run is QUEUED (the idle loop re-sweeps wedges). */
  hasQueuedRuns(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS one FROM runs WHERE status = 'QUEUED' LIMIT 1")
      .get() as { one: number } | undefined;
    return row !== undefined;
  }

  /**
   * True when a RUNNING Run has a persisted CancellationRequested. The recovery
   * scan leaves exactly such runs untouched (never resumed, never auto-failed —
   * the explicit cancel retry owns the aftermath), so the executor's idle loop
   * consults this after a scan to bound its next reconsideration instead of
   * re-waking instantly on the same expired lease / wedged slot (no busy loop).
   */
  hasCancellationRequestedRunningRun(): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS one FROM runs WHERE status = 'RUNNING' AND cancellation_requested_at IS NOT NULL LIMIT 1"
      )
      .get() as { one: number } | undefined;
    return row !== undefined;
  }

  // -------------------------------------------------------------------------
  // Row access and mapping
  // -------------------------------------------------------------------------

  private getAttemptRow(attemptId: string): AttemptRow | null {
    const row = this.db.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId) as
      | AttemptRow
      | undefined;
    return row ?? null;
  }

  private readAttempt(attemptId: string): RunAttempt {
    const row = this.getAttemptRow(attemptId);
    if (row === null) {
      throw new RunnerInvariantError(`Attempt ${attemptId} disappeared while being read`, {
        attemptId
      });
    }
    return this.mapAttempt(row);
  }

  private mapAttempt(row: AttemptRow): RunAttempt {
    const status = this.toAttemptStatus(row.status, row.id);
    // Schema v3 kind: EXECUTION or CANCELLATION. NULL rows are pre-v3 legacy
    // execution attempts (raw/legacy inserts); any other value fails truthfully.
    if (row.kind !== null && row.kind !== "EXECUTION" && row.kind !== "CANCELLATION") {
      throw new RunnerInvariantError(
        `Stored attempt ${row.id} has an unknown kind ${row.kind}`,
        { attemptId: row.id, kind: row.kind }
      );
    }
    let interruptionKind: RunInterruptionKind | undefined;
    if (row.interruption_kind !== null) {
      if (!RUN_INTERRUPTION_KINDS.includes(row.interruption_kind as RunInterruptionKind)) {
        throw new RunnerInvariantError(
          `Stored attempt ${row.id} has an unknown interruption kind ${row.interruption_kind}`,
          { attemptId: row.id, interruptionKind: row.interruption_kind }
        );
      }
      interruptionKind = row.interruption_kind as RunInterruptionKind;
    }
    let recoveryDecision: RunRecoveryDecision | undefined;
    if (row.recovery_decision !== null) {
      if (!RUN_RECOVERY_DECISIONS.includes(row.recovery_decision as RunRecoveryDecision)) {
        throw new RunnerInvariantError(
          `Stored attempt ${row.id} has an unknown recovery decision ${row.recovery_decision}`,
          { attemptId: row.id, recoveryDecision: row.recovery_decision }
        );
      }
      recoveryDecision = row.recovery_decision as RunRecoveryDecision;
    }
    return {
      id: row.id,
      runId: row.run_id,
      attemptSequence: row.attempt_sequence,
      status,
      ...(row.owner_token === null ? {} : { ownerToken: row.owner_token }),
      ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
      ...(row.lease_deadline_at === null ? {} : { leaseDeadlineAt: row.lease_deadline_at }),
      ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at }),
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(interruptionKind === undefined ? {} : { interruptionKind }),
      ...(recoveryDecision === undefined ? {} : { recoveryDecision })
    };
  }

  private toAttemptStatus(value: string | null, attemptId: string): RunAttemptStatus {
    if (value !== null && RUN_ATTEMPT_STATUSES.includes(value as RunAttemptStatus)) {
      return value as RunAttemptStatus;
    }
    throw new RunnerInvariantError(
      `Stored attempt ${attemptId} has no supported lifecycle status (${value ?? "null"})`,
      { attemptId, status: value }
    );
  }

  private toStage(value: string | null, runId: string): RunStage | null {
    if (value === null) return null;
    if (RUN_STAGES.includes(value as RunStage)) return value as RunStage;
    throw new RunnerInvariantError(`Stored run ${runId} has an unknown stage ${value}`, {
      runId,
      stage: value
    });
  }

  private nextAttemptSequence(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(attempt_sequence), 0) AS max FROM run_attempts WHERE run_id = ?"
      )
      .get(runId) as { max: number };
    return row.max + 1;
  }

  /** Next per-revision Model sequence (M01/M02/...), derived under the write transaction. */
  private nextModelSequence(revisionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(CAST(SUBSTR(number, 2) AS INTEGER)), 0) AS max " +
          "FROM models WHERE revision_id = ? AND number LIKE 'M%'"
      )
      .get(revisionId) as { max: number };
    return row.max + 1;
  }

  // -------------------------------------------------------------------------
  // Validation and canonical timestamps
  // -------------------------------------------------------------------------

  private assertAttemptInput(runId: string, attemptId: string, ownerToken: string): void {
    assertSafeIdToken("runId", runId);
    assertSafeIdToken("attemptId", attemptId);
    assertSafeIdToken("ownerToken", ownerToken);
  }

  /** Canonical UTC ISO timestamp from the injected clock. */
  private canonicalNow(): string {
    const value = this.now();
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (!Number.isFinite(ms)) {
      throw new RunnerInvariantError("The injected clock returned a non-finite timestamp");
    }
    return new Date(ms).toISOString();
  }

  /** Canonicalizes a caller-supplied timestamp (UTC ISO with millisecond Z). */
  private canonicalIso(value: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new InvalidArgumentError("finishedAt must be a non-empty ISO timestamp");
    }
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw new InvalidArgumentError(`finishedAt must be a valid ISO timestamp: ${value}`);
    }
    return new Date(ms).toISOString();
  }

  /** Lease deadline `leaseDurationMs` after a canonical instant. */
  private deadlineFrom(canonicalNow: string): string {
    return new Date(Date.parse(canonicalNow) + this.leaseDurationMs).toISOString();
  }

  /**
   * Cancellation cleanup fence deadline: `max(normal run lease duration,
   * DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS)` after the fence instant. A short
   * configured run lease can never shorten the cleanup window below the bound
   * the live cleanup provably needs (see the minimum constant for the proof).
   */
  private cancelCleanupDeadlineFrom(canonicalNow: string): string {
    return new Date(
      Date.parse(canonicalNow) +
        Math.max(this.leaseDurationMs, DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS)
    ).toISOString();
  }
}

/** Error message extraction for injected capability probe failures. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The interruption kind pinned to a terminal attempt status (P3-3 review fix):
 * the raw `FinishRunAttemptRequest` exposes no caller-chosen kind, the kind is
 * always derived here — FINISHED records none, INTERRUPTED records
 * `UNEXPECTED_INTERRUPTION`, CANCELLED records `CANCELLED`.
 */
function interruptionKindFor(status: TerminalRunAttemptStatus): RunInterruptionKind | undefined {
  switch (status) {
    case "FINISHED":
      return undefined;
    case "INTERRUPTED":
      return "UNEXPECTED_INTERRUPTION";
    case "CANCELLED":
      return "CANCELLED";
  }
}
