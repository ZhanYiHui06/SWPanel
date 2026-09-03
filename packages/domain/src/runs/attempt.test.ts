import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "../errors.js";
import {
  finishRunAttempt,
  isLeaseExpired,
  isRecoveryCandidateStage,
  isRunAttemptTerminal,
  RUN_ATTEMPT_STATUSES,
  RUN_INTERRUPTION_KINDS,
  RUN_RECOVERY_DECISIONS,
  TERMINAL_RUN_ATTEMPT_STATUSES,
  type RunAttempt
} from "./attempt.js";

describe("run attempt domain", () => {
  it("pins the attempt statuses, interruption kinds and recovery decisions", () => {
    expect(RUN_ATTEMPT_STATUSES).toEqual(["ACTIVE", "FINISHED", "INTERRUPTED", "CANCELLED"]);
    expect(RUN_INTERRUPTION_KINDS).toEqual(["CANCELLED", "UNEXPECTED_INTERRUPTION"]);
    expect(RUN_RECOVERY_DECISIONS).toEqual(["RESUME", "RECOVERY_UNSUPPORTED", "RECOVERY_FAILED"]);
  });

  it("carries claim/lease/heartbeat fields on an ACTIVE attempt", () => {
    const attempt: RunAttempt = {
      id: "attempt-1",
      runId: "run-1",
      attemptSequence: 1,
      status: "ACTIVE",
      ownerToken: "runner-1",
      claimedAt: "2026-08-13T10:00:00.000Z",
      leaseDeadlineAt: "2026-08-13T10:00:30.000Z",
      heartbeatAt: "2026-08-13T10:00:10.000Z",
      startedAt: "2026-08-13T10:00:00.000Z"
    };
    expect(attempt.ownerToken).toBe("runner-1");
    expect("finishedAt" in attempt).toBe(false);
    expect(JSON.parse(JSON.stringify(attempt))).toEqual(attempt);
  });

  it("records an unexpected interruption without confusing it with a cancel", () => {
    const attempt: RunAttempt = {
      id: "attempt-1",
      runId: "run-1",
      attemptSequence: 1,
      status: "INTERRUPTED",
      ownerToken: "runner-1",
      finishedAt: "2026-08-13T10:05:00.000Z",
      interruptionKind: "UNEXPECTED_INTERRUPTION",
      recoveryDecision: "RECOVERY_UNSUPPORTED"
    };
    expect(attempt.interruptionKind).toBe("UNEXPECTED_INTERRUPTION");
    expect(attempt.recoveryDecision).toBe("RECOVERY_UNSUPPORTED");
  });

  it("restricts safe recovery candidates to PREPARING/ANALYZING/PLANNING", () => {
    expect(isRecoveryCandidateStage("PREPARING")).toBe(true);
    expect(isRecoveryCandidateStage("ANALYZING")).toBe(true);
    expect(isRecoveryCandidateStage("PLANNING")).toBe(true);
    expect(isRecoveryCandidateStage("MODELING")).toBe(false);
    expect(isRecoveryCandidateStage("VALIDATING")).toBe(false);
    expect(isRecoveryCandidateStage("PACKAGING")).toBe(false);
  });

  it("expires a lease at the inclusive deadline", () => {
    expect(isLeaseExpired("2026-08-13T10:00:30.000Z", "2026-08-13T10:00:29.999Z")).toBe(false);
    expect(isLeaseExpired("2026-08-13T10:00:30.000Z", "2026-08-13T10:00:30.000Z")).toBe(true);
    expect(isLeaseExpired("2026-08-13T10:00:30.000Z", "2026-08-13T10:00:31.000Z")).toBe(true);
  });

  it("pins the terminal attempt statuses", () => {
    expect(TERMINAL_RUN_ATTEMPT_STATUSES).toEqual(["FINISHED", "INTERRUPTED", "CANCELLED"]);
    expect(isRunAttemptTerminal("ACTIVE")).toBe(false);
    expect(isRunAttemptTerminal("FINISHED")).toBe(true);
    expect(isRunAttemptTerminal("INTERRUPTED")).toBe(true);
    expect(isRunAttemptTerminal("CANCELLED")).toBe(true);
  });

  it("finishes an ACTIVE attempt with a finishedAt and no interruption kind", () => {
    const attempt: RunAttempt = {
      id: "attempt-1",
      runId: "run-1",
      attemptSequence: 1,
      status: "ACTIVE",
      startedAt: "2026-08-13T10:00:00.000Z"
    };
    const finished = finishRunAttempt(attempt, {
      status: "FINISHED",
      finishedAt: "2026-08-13T10:05:00.000Z"
    });
    expect(finished.status).toBe("FINISHED");
    expect(finished.finishedAt).toBe("2026-08-13T10:05:00.000Z");
    expect("interruptionKind" in finished).toBe(false);
    expect(attempt.status).toBe("ACTIVE");
  });

  it("distinguishes a user cancel from an unexpected interruption by interruptionKind", () => {
    const cancelled = finishRunAttempt(
      { id: "attempt-1", runId: "run-1", attemptSequence: 1, status: "ACTIVE" },
      { status: "CANCELLED", finishedAt: "2026-08-13T10:05:00.000Z", interruptionKind: "CANCELLED" }
    );
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.finishedAt).toBe("2026-08-13T10:05:00.000Z");
    expect(cancelled.interruptionKind).toBe("CANCELLED");

    const interrupted = finishRunAttempt(
      { id: "attempt-2", runId: "run-1", attemptSequence: 2, status: "ACTIVE" },
      {
        status: "INTERRUPTED",
        finishedAt: "2026-08-13T10:05:00.000Z",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      }
    );
    expect(interrupted.status).toBe("INTERRUPTED");
    expect(interrupted.interruptionKind).toBe("UNEXPECTED_INTERRUPTION");
  });

  it("rejects terminal attempts that lack or mismatch their interruption kind", () => {
    const active: RunAttempt = { id: "attempt-1", runId: "run-1", attemptSequence: 1, status: "ACTIVE" };
    expect(() =>
      finishRunAttempt(active, { status: "INTERRUPTED", finishedAt: "2026-08-13T10:05:00.000Z" })
    ).toThrowError(DomainInvariantError);
    expect(() =>
      finishRunAttempt(active, { status: "CANCELLED", finishedAt: "2026-08-13T10:05:00.000Z" })
    ).toThrowError(DomainInvariantError);
    expect(() =>
      finishRunAttempt(active, {
        status: "INTERRUPTED",
        finishedAt: "2026-08-13T10:05:00.000Z",
        interruptionKind: "CANCELLED"
      })
    ).toThrowError(DomainInvariantError);
    expect(() =>
      finishRunAttempt(active, {
        status: "FINISHED",
        finishedAt: "2026-08-13T10:05:00.000Z",
        interruptionKind: "UNEXPECTED_INTERRUPTION"
      })
    ).toThrowError(DomainInvariantError);
  });

  it("rejects finishing an already terminal attempt or a bad timestamp", () => {
    const finished: RunAttempt = {
      id: "attempt-1",
      runId: "run-1",
      attemptSequence: 1,
      status: "FINISHED",
      finishedAt: "2026-08-13T10:05:00.000Z"
    };
    expect(() =>
      finishRunAttempt(finished, { status: "FINISHED", finishedAt: "2026-08-13T10:06:00.000Z" })
    ).toThrowError(/already FINISHED/);
    const active: RunAttempt = { id: "attempt-2", runId: "run-1", attemptSequence: 2, status: "ACTIVE" };
    expect(() => finishRunAttempt(active, { status: "FINISHED", finishedAt: "" })).toThrowError(
      DomainInvariantError
    );
    expect(() =>
      finishRunAttempt(active, { status: "FINISHED", finishedAt: "not-a-timestamp" })
    ).toThrowError(/valid timestamp/);
  });
});
