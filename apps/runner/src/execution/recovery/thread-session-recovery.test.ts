import { describe, expect, it } from "vitest";

import type { RunStage } from "@swpanel/domain";
import { CODEX_APP_SERVER_ADAPTER_ID } from "../../agent/codex/codex-app-server-adapter.js";
import {
  CODEX_CLI_VERSION,
  CODEX_PROTOCOL_VERSION
} from "../../agent/codex/builders.js";
import { buildAgentSessionRecord } from "../../agent/codex/agent-session.js";
import {
  decideThreadResume,
  hasSafeCheckpoint,
  isPinnedResumeStage,
  isPinnedThreadSessionProtocol,
  isWellFormedThreadSession,
  PINNED_CODEX_CLI_VERSION,
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

function lookupReturning(session: ThreadSessionLike | null): (runId: string) => ThreadSessionLike | null {
  return (runId: string) => (runId === "run-1" ? session : null);
}

/** A permissive injected stage predicate: everything is resumable. */
const PERMISSIVE_STAGE = (): boolean => true;

describe("thread-session recovery decision", () => {
  it("proves resume ONLY at null / PREPARING / ANALYZING / PLANNING", () => {
    for (const stage of [null, "PREPARING", "ANALYZING", "PLANNING"] as const) {
      const decision = decideThreadResume({
        runId: "run-1",
        lookupSession: lookupReturning(sessionOf(stage))
      });
      expect(decision).toEqual({ resume: true, runId: "run-1", stage });
    }
    for (const stage of THREAD_SESSION_NO_CHECKPOINT_STAGES) {
      const decision = decideThreadResume({
        runId: "run-1",
        lookupSession: lookupReturning(sessionOf(stage))
      });
      expect(decision).toEqual({
        resume: false,
        runId: "run-1",
        stage,
        reason: "stage-not-resumable"
      });
    }
  });

  it("never proves resume at MODELING / VALIDATING / PACKAGING even with a permissive injected predicate", () => {
    for (const stage of THREAD_SESSION_NO_CHECKPOINT_STAGES) {
      const decision = decideThreadResume({
        runId: "run-1",
        lookupSession: lookupReturning(sessionOf(stage)),
        isResumableStage: PERMISSIVE_STAGE
      });
      expect(decision.resume).toBe(false);
      if (!decision.resume) {
        expect(decision.reason).toBe("stage-not-resumable");
      }
    }
  });

  it("hasSafeCheckpoint is ALWAYS false for MODELING / VALIDATING / PACKAGING", () => {
    for (const stage of THREAD_SESSION_NO_CHECKPOINT_STAGES) {
      expect(hasSafeCheckpoint(sessionOf(stage))).toBe(false);
      // Even a fully permissive injected policy cannot flip the hard pin.
      expect(hasSafeCheckpoint(sessionOf(stage), { isResumableStage: PERMISSIVE_STAGE })).toBe(
        false
      );
    }
  });

  it("hasSafeCheckpoint is true only for pinned-protocol sessions at resumable stages", () => {
    expect(hasSafeCheckpoint(null)).toBe(false);
    for (const stage of [null, "PREPARING", "ANALYZING", "PLANNING"] as const) {
      expect(hasSafeCheckpoint(sessionOf(stage))).toBe(true);
    }
  });

  it("denies resume when no session exists", () => {
    const decision = decideThreadResume({
      runId: "run-other",
      lookupSession: lookupReturning(null)
    });
    expect(decision).toEqual({
      resume: false,
      runId: "run-other",
      stage: null,
      reason: "no-session"
    });
  });

  it("never trusts a malformed session for a resume (unknown stage / wrong types)", () => {
    const unknownStage = { ...PINNED_SESSION, stage: "EXPLORING" } as unknown as ThreadSessionLike;
    expect(isWellFormedThreadSession(unknownStage)).toBe(false);
    expect(
      decideThreadResume({ runId: "run-1", lookupSession: lookupReturning(unknownStage) })
    ).toEqual({ resume: false, runId: "run-1", stage: null, reason: "malformed-session" });
    expect(hasSafeCheckpoint(unknownStage)).toBe(false);

    const numericProtocol = { ...PINNED_SESSION, protocol: 42 } as unknown as ThreadSessionLike;
    expect(
      decideThreadResume({ runId: "run-1", lookupSession: lookupReturning(numericProtocol) })
    ).toEqual({ resume: false, runId: "run-1", stage: null, reason: "malformed-session" });
    expect(hasSafeCheckpoint(numericProtocol)).toBe(false);
  });

  it("denies resume when the session protocol is not pinned", () => {
    const foreign = {
      stage: "PLANNING",
      protocol: "codex-cli",
      protocolVersion: "1.0.0"
    } satisfies ThreadSessionLike;
    expect(isPinnedThreadSessionProtocol(foreign)).toBe(false);
    expect(
      decideThreadResume({ runId: "run-1", lookupSession: lookupReturning(foreign) })
    ).toEqual({
      resume: false,
      runId: "run-1",
      stage: "PLANNING",
      reason: "protocol-unpinned"
    });
    expect(hasSafeCheckpoint(foreign)).toBe(false);
  });

  it("accepts an injected protocol predicate (integration seam)", () => {
    const foreign = {
      stage: "PLANNING",
      protocol: "codex-cli",
      protocolVersion: "1.0.0"
    } satisfies ThreadSessionLike;
    const acceptForeign = (session: ThreadSessionLike): boolean =>
      session.protocol === "codex-cli" && session.protocolVersion === "1.0.0";
    const decision = decideThreadResume({
      runId: "run-1",
      lookupSession: lookupReturning(foreign),
      isPinnedProtocol: acceptForeign
    });
    expect(decision).toEqual({ resume: true, runId: "run-1", stage: "PLANNING" });
    expect(hasSafeCheckpoint(foreign, { isPinnedProtocol: acceptForeign })).toBe(true);
  });

  it("injected stage predicates may only tighten the pin (never loosen it)", () => {
    // null stage denied by an injected predicate.
    const denyNull = (stage: RunStage | null): boolean => stage !== null;
    expect(isPinnedResumeStage(null)).toBe(true);
    const decision = decideThreadResume({
      runId: "run-1",
      lookupSession: lookupReturning(sessionOf(null)),
      isResumableStage: denyNull
    });
    expect(decision).toEqual({
      resume: false,
      runId: "run-1",
      stage: null,
      reason: "stage-not-resumable"
    });
    expect(hasSafeCheckpoint(sessionOf(null), { isResumableStage: denyNull })).toBe(false);
    // Loosening MODELING is refused by the hard pin (covered above).
  });

  it("pins the protocol this repo's Codex adapter uses", () => {
    expect(PINNED_THREAD_SESSION_PROTOCOL).toBe("codex-app-server");
    expect(PINNED_THREAD_SESSION_PROTOCOL_VERSION).toBe(CODEX_PROTOCOL_VERSION);
    expect(THREAD_SESSION_RESUME_STAGES).toEqual(["PREPARING", "ANALYZING", "PLANNING"]);
    expect(THREAD_SESSION_NO_CHECKPOINT_STAGES).toEqual([
      "MODELING",
      "VALIDATING",
      "PACKAGING"
    ]);
  });

  it("pins the codex-cli RELEASE separately from the session protocol version", () => {
    // The session protocol field of an AgentSessionRecord is the app-server
    // protocol major ("2"), while the codex-cli release stays 0.147.0. A
    // resume decision keys on the SESSION protocol field only — pinning the
    // CLI release there would reject every adapter-produced session.
    expect(PINNED_CODEX_CLI_VERSION).toBe("0.147.0");
    expect(PINNED_CODEX_CLI_VERSION).toBe(CODEX_CLI_VERSION);
    expect(PINNED_THREAD_SESSION_PROTOCOL_VERSION).not.toBe(PINNED_CODEX_CLI_VERSION);
  });

  it("regression: an adapter-produced session record passes the recovery pin (session protocol field, not the CLI release)", () => {
    // The record EXACTLY as CodexAppServerAdapter.runTurn persists it: the
    // adapter constants fill protocol / protocolVersion, the CLI release fills
    // adapterVersion. The recovery pin must accept this record — previously it
    // held the CLI release ("0.147.0") while the adapter wrote the protocol
    // major ("2"), so executor recovery rejected adapter-produced sessions.
    const adapterProduced = buildAgentSessionRecord({
      threadId: "thread-1",
      status: "interrupted",
      adapterId: CODEX_APP_SERVER_ADAPTER_ID,
      adapterVersion: CODEX_CLI_VERSION,
      protocol: CODEX_APP_SERVER_ADAPTER_ID,
      protocolVersion: CODEX_PROTOCOL_VERSION,
      nowIso: () => "2026-08-13T09:00:00.000Z"
    });
    expect(isPinnedThreadSessionProtocol(adapterProduced)).toBe(true);
    // The pin constants equal the adapter's own constants.
    expect(PINNED_THREAD_SESSION_PROTOCOL).toBe(CODEX_APP_SERVER_ADAPTER_ID);
    expect(PINNED_THREAD_SESSION_PROTOCOL_VERSION).toBe(CODEX_PROTOCOL_VERSION);
  });

  it("regression: high-stage refusal holds for an adapter-produced session record", () => {
    // Even a MODELING session produced with the adapter's OWN protocol fields
    // proves no checkpoint and never resumes (hard pin).
    const adapterProduced = buildAgentSessionRecord({
      threadId: "thread-1",
      status: "interrupted",
      adapterId: CODEX_APP_SERVER_ADAPTER_ID,
      adapterVersion: CODEX_CLI_VERSION,
      protocol: CODEX_APP_SERVER_ADAPTER_ID,
      protocolVersion: CODEX_PROTOCOL_VERSION,
      nowIso: () => "2026-08-13T09:00:00.000Z"
    });
    const modeling: ThreadSessionLike = { stage: "MODELING", ...adapterProduced };
    expect(isPinnedThreadSessionProtocol(modeling)).toBe(true);
    expect(hasSafeCheckpoint(modeling)).toBe(false);
    expect(
      decideThreadResume({ runId: "run-1", lookupSession: () => modeling })
    ).toEqual({
      resume: false,
      runId: "run-1",
      stage: "MODELING",
      reason: "stage-not-resumable"
    });
  });
});
