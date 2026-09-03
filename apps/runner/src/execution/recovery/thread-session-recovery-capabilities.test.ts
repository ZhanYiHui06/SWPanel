import { describe, expect, it } from "vitest";

import type { RunStage } from "@swpanel/domain";
import type { RunRecoveryCapabilities } from "../../orchestration/run-orchestrator.js";
import {
  threadSessionRecoveryCapabilities,
  type ThreadSessionLookup
} from "./thread-session-recovery-capabilities.js";
import {
  PINNED_THREAD_SESSION_PROTOCOL,
  PINNED_THREAD_SESSION_PROTOCOL_VERSION,
  THREAD_SESSION_NO_CHECKPOINT_STAGES,
  THREAD_SESSION_RESUME_STAGES,
  type ThreadSessionLike
} from "./thread-session-recovery.js";

const PINNED_SESSION: ThreadSessionLike = {
  stage: null,
  protocol: PINNED_THREAD_SESSION_PROTOCOL,
  protocolVersion: PINNED_THREAD_SESSION_PROTOCOL_VERSION
};

function sessionOf(stage: RunStage | null): ThreadSessionLike {
  return { ...PINNED_SESSION, stage };
}

function lookupOf(runId: string, session: ThreadSessionLike | null): ThreadSessionLookup {
  return (lookedUpRunId: string) => (lookedUpRunId === runId ? session : null);
}

describe("thread-session recovery capabilities adapter (P5-4)", () => {
  it("builds a RunRecoveryCapabilities surface with both proofs", () => {
    const capabilities: RunRecoveryCapabilities = threadSessionRecoveryCapabilities(() => null);
    expect(Object.keys(capabilities).sort()).toEqual(["canSafelyResume", "hasSafeCheckpoint"]);
  });

  it("proves resume only for a pinned session at null / PREPARING / ANALYZING / PLANNING", () => {
    const capabilities = threadSessionRecoveryCapabilities(
      lookupOf("run-1", sessionOf("ANALYZING"))
    );
    for (const stage of [null, "PREPARING", "ANALYZING", "PLANNING"] as const) {
      const withStage = threadSessionRecoveryCapabilities(lookupOf("run-1", sessionOf(stage)));
      expect(withStage.canSafelyResume?.({ runId: "run-1", attemptId: "attempt-1", stage })).toBe(
        true
      );
    }
    // A run with NO session is never resumable.
    expect(capabilities.canSafelyResume?.({ runId: "run-other", attemptId: "attempt-9", stage: "ANALYZING" })).toBe(false);
  });

  it("refuses resume without a session or with an unpinned protocol", () => {
    const noSession = threadSessionRecoveryCapabilities(() => null);
    expect(
      noSession.canSafelyResume?.({ runId: "run-1", attemptId: "attempt-1", stage: "PLANNING" })
    ).toBe(false);
    const unpinned = threadSessionRecoveryCapabilities(
      lookupOf("run-1", {
        stage: "PLANNING",
        protocol: "codex-cli",
        protocolVersion: "1.0.0"
      })
    );
    expect(
      unpinned.canSafelyResume?.({ runId: "run-1", attemptId: "attempt-1", stage: "PLANNING" })
    ).toBe(false);
    // A malformed session (unknown stage) is never trusted either.
    const malformed = threadSessionRecoveryCapabilities(
      lookupOf("run-1", { stage: "EXPLORING" } as unknown as ThreadSessionLike)
    );
    expect(
      malformed.canSafelyResume?.({ runId: "run-1", attemptId: "attempt-1", stage: null })
    ).toBe(false);
  });

  it("ALWAYS refuses resume at MODELING / VALIDATING / PACKAGING despite a pinned session", () => {
    for (const stage of THREAD_SESSION_NO_CHECKPOINT_STAGES) {
      const capabilities = threadSessionRecoveryCapabilities(lookupOf("run-1", sessionOf(stage)));
      expect(capabilities.canSafelyResume?.({ runId: "run-1", attemptId: "attempt-1", stage })).toBe(false);
    }
  });

  it("hasSafeCheckpoint is ALWAYS false at MODELING / VALIDATING / PACKAGING (hard pin)", () => {
    for (const stage of THREAD_SESSION_NO_CHECKPOINT_STAGES) {
      const capabilities = threadSessionRecoveryCapabilities(lookupOf("run-1", sessionOf(stage)));
      expect(capabilities.hasSafeCheckpoint?.({ runId: "run-1", attemptId: "attempt-1", stage })).toBe(
        false
      );
    }
  });

  it("hasSafeCheckpoint is true only for a pinned session at a resumable stage", () => {
    for (const stage of THREAD_SESSION_RESUME_STAGES) {
      const capabilities = threadSessionRecoveryCapabilities(lookupOf("run-1", sessionOf(stage)));
      expect(capabilities.hasSafeCheckpoint?.({ runId: "run-1", attemptId: "attempt-1", stage })).toBe(
        true
      );
    }
    // null stage session: checkpoint proven too (nothing reached yet).
    const nullStage = threadSessionRecoveryCapabilities(lookupOf("run-1", sessionOf(null)));
    expect(
      nullStage.hasSafeCheckpoint?.({ runId: "run-1", attemptId: "attempt-1", stage: null })
    ).toBe(true);
    // No session, malformed session or unpinned protocol: never a checkpoint.
    const absent = threadSessionRecoveryCapabilities(() => null);
    expect(
      absent.hasSafeCheckpoint?.({ runId: "run-1", attemptId: "attempt-1", stage: "PLANNING" })
    ).toBe(false);
    const unpinned = threadSessionRecoveryCapabilities(
      lookupOf("run-1", { stage: "PLANNING", protocol: "codex-cli", protocolVersion: "1.0.0" })
    );
    expect(
      unpinned.hasSafeCheckpoint?.({ runId: "run-1", attemptId: "attempt-1", stage: "PLANNING" })
    ).toBe(false);
  });
});
