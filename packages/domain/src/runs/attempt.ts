import { DomainInvariantError } from "../errors.js";
import type { RunStage } from "./status.js";

/**
 * Lifecycle of one execution attempt of a Run. An attempt is claimed by
 * exactly one Runner owner and stays ACTIVE until it finishes normally, is
 * interrupted by an unexpected stop or is ended by a user cancellation.
 */
export const RUN_ATTEMPT_STATUSES = [
  "ACTIVE",
  "FINISHED",
  "INTERRUPTED",
  "CANCELLED"
] as const;
export type RunAttemptStatus = (typeof RUN_ATTEMPT_STATUSES)[number];

/** Attempt statuses that stop the attempt: they must always record `finishedAt`. */
export const TERMINAL_RUN_ATTEMPT_STATUSES = [
  "FINISHED",
  "INTERRUPTED",
  "CANCELLED"
] as const;
export type TerminalRunAttemptStatus = (typeof TERMINAL_RUN_ATTEMPT_STATUSES)[number];

/** True when the attempt status ends the attempt. */
export function isRunAttemptTerminal(status: RunAttemptStatus): boolean {
  return TERMINAL_RUN_ATTEMPT_STATUSES.includes(status as TerminalRunAttemptStatus);
}

/**
 * Why an attempt stopped. `CANCELLED` is exclusively the user-cancel path;
 * everything else (crash, lease expiry, host shutdown) is an unexpected
 * interruption and must never be written as `CANCELLED`.
 */
export const RUN_INTERRUPTION_KINDS = ["CANCELLED", "UNEXPECTED_INTERRUPTION"] as const;
export type RunInterruptionKind = (typeof RUN_INTERRUPTION_KINDS)[number];

/**
 * Outcome of the recovery decision made when an interrupted attempt is
 * reconsidered (usually after a Runner restart). `RESUME` means the executor
 * declared the work safely resumable and execution continues; the RECOVERY_*
 * outcomes surface as the Run failure codes of the same names.
 */
export const RUN_RECOVERY_DECISIONS = [
  "RESUME",
  "RECOVERY_UNSUPPORTED",
  "RECOVERY_FAILED"
] as const;
export type RunRecoveryDecision = (typeof RUN_RECOVERY_DECISIONS)[number];

/**
 * One execution attempt of a Run, bound to a single Runner owner through its
 * claim/lease/heartbeat fields. A Run keeps one row per attempt; the Run's
 * event envelope references the attempt by `attemptId`.
 */
export interface RunAttempt {
  id: string;
  runId: string;
  /** Monotonically increasing within one Run, starting at 1. */
  attemptSequence: number;
  status: RunAttemptStatus;
  /** Runner instance token that claimed this attempt (single active attempt per owner). */
  ownerToken?: string;
  claimedAt?: string;
  /** Absolute lease deadline; the claim expires when now >= leaseDeadlineAt. */
  leaseDeadlineAt?: string;
  /** Last successful heartbeat that renewed the lease. */
  heartbeatAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Set when the attempt stopped; distinguishes user cancel from unexpected interruption. */
  interruptionKind?: RunInterruptionKind;
  /** Recovery decision recorded when an interrupted attempt was reconsidered. */
  recoveryDecision?: RunRecoveryDecision;
}

/**
 * The execution stages at which an interrupted attempt may be considered for
 * safe recovery. MODELING/VALIDATING/PACKAGING have no explicit safe
 * checkpoint, so a recovery candidate must never be faked there.
 */
export function isRecoveryCandidateStage(stage: RunStage): boolean {
  return stage === "PREPARING" || stage === "ANALYZING" || stage === "PLANNING";
}

/** True when the lease has expired at `now` (deadline is inclusive). */
export function isLeaseExpired(leaseDeadlineAt: string, now: string): boolean {
  return Date.parse(now) >= Date.parse(leaseDeadlineAt);
}

export interface FinishRunAttemptInput {
  status: TerminalRunAttemptStatus;
  finishedAt: string;
  interruptionKind?: RunInterruptionKind;
}

/**
 * Ends an ACTIVE attempt. The terminal status and `finishedAt` are written
 * together: a terminal attempt can never exist without a finish timestamp, and
 * the interruption kind is pinned to the status (FINISHED records none,
 * INTERRUPTED records `UNEXPECTED_INTERRUPTION`, CANCELLED records `CANCELLED`)
 * so an unexpected stop is never silently written as a user cancel.
 */
export function finishRunAttempt(attempt: RunAttempt, input: FinishRunAttemptInput): RunAttempt {
  if (isRunAttemptTerminal(attempt.status)) {
    throw new DomainInvariantError(
      `Attempt ${attempt.id} is already ${attempt.status}; it cannot be finished again`
    );
  }
  if (typeof input.finishedAt !== "string" || input.finishedAt.length === 0) {
    throw new DomainInvariantError(`Attempt ${attempt.id} finishedAt must be a non-empty timestamp`);
  }
  if (!Number.isFinite(Date.parse(input.finishedAt))) {
    throw new DomainInvariantError(`Attempt ${attempt.id} finishedAt must be a valid timestamp`);
  }
  let interruptionKind: RunInterruptionKind | undefined;
  switch (input.status) {
    case "FINISHED":
      if (input.interruptionKind !== undefined) {
        throw new DomainInvariantError(
          `FINISHED attempt ${attempt.id} must not record an interruptionKind`
        );
      }
      break;
    case "INTERRUPTED":
      if (input.interruptionKind !== "UNEXPECTED_INTERRUPTION") {
        throw new DomainInvariantError(
          `INTERRUPTED attempt ${attempt.id} must record interruptionKind UNEXPECTED_INTERRUPTION`
        );
      }
      interruptionKind = input.interruptionKind;
      break;
    case "CANCELLED":
      if (input.interruptionKind !== "CANCELLED") {
        throw new DomainInvariantError(
          `CANCELLED attempt ${attempt.id} must record interruptionKind CANCELLED`
        );
      }
      interruptionKind = input.interruptionKind;
      break;
  }
  return {
    ...attempt,
    status: input.status,
    finishedAt: input.finishedAt,
    ...(interruptionKind === undefined ? {} : { interruptionKind })
  };
}
