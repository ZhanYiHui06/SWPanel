import { describe, expect, it, vi } from "vitest";

import { InvalidArgumentError } from "../../errors.js";
import {
  buildOwnershipRecord,
  documentOf,
  isOwnedCloseSafeForCancellation,
  pidOf,
  SolidWorksOwnershipGuard,
  type CloseOnlyOwnedOutcome,
  type OwnershipRecord,
  type SolidWorksIdentity,
  type SolidWorksIdentityCloser
} from "./solidworks-ownership-guard.js";

// ---------------------------------------------------------------------------
// Compile-time proof: the guard surface must NEVER expose a command-style /
// process-name kill or enumeration API. If a forbidden member is ever added,
// the constant below stops typechecking (the conditional resolves to `never`).
// ---------------------------------------------------------------------------
type ForbiddenGuardKeys = Extract<
  Exclude<keyof SolidWorksOwnershipGuard, number | symbol>,
  "kill" | "killAll" | "enumerate" | "enumerateProcesses" | "closeAll" | "closeByProcessName"
>;
type IsNever<T> = [T] extends [never] ? true : false;
type GuardHasNoForbiddenApi = IsNever<ForbiddenGuardKeys> extends true ? true : never;
const guardHasNoForbiddenApi: GuardHasNoForbiddenApi = true;

type CloseSpy = ReturnType<typeof vi.fn<(identity: SolidWorksIdentity) => void>>;

function recordingCloser(): { close: CloseSpy; closer: SolidWorksIdentityCloser } {
  const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
    void _identity;
  });
  return { close, closer: { close } };
}

describe("SolidWorksOwnershipGuard", () => {
  it("mints a frozen immutable record bound to runId+attemptId", () => {
    const { closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    const record = guard.record({
      runId: "run-1",
      attemptId: "attempt-1",
      pids: [101, 202],
      documentIdentities: ["C:\\parts\\plate.sldprt"]
    });
    expect(record.runId).toBe("run-1");
    expect(record.attemptId).toBe("attempt-1");
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.identities)).toBe(true);
    for (const identity of record.identities) {
      expect(Object.isFrozen(identity)).toBe(true);
    }
    // No mutator API: mutating the frozen record must throw.
    expect(() => {
      (record.identities as SolidWorksIdentity[]).push(pidOf(999));
    }).toThrow(TypeError);
  });

  it("normalizes duplicates (pid and document identities) at record time", () => {
    const { closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    const record = guard.record({
      runId: "run-1",
      attemptId: "attempt-1",
      pids: [101, 101, 202, 101],
      documentIdentities: ["  C:\\a.sldprt  ", "C:\\a.sldprt", "C:\\b.sldprt"]
    });
    expect(record.identities).toEqual([
      { kind: "pid", pid: 101 },
      { kind: "pid", pid: 202 },
      { kind: "document", documentIdentity: "C:\\a.sldprt" },
      { kind: "document", documentIdentity: "C:\\b.sldprt" }
    ]);
  });

  it("passes ONLY the recorded matching run/attempt identities to the closer, one per call", () => {
    const { close, closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    const record = guard.record({
      runId: "run-1",
      attemptId: "attempt-1",
      pids: [101, 202],
      documentIdentities: ["C:\\parts\\plate.sldprt"]
    });
    const outcome = guard.closeOnlyOwned(record);
    expect(outcome).toEqual({
      status: "closed",
      closed: [
        { kind: "pid", pid: 101 },
        { kind: "pid", pid: 202 },
        { kind: "document", documentIdentity: "C:\\parts\\plate.sldprt" }
      ]
    });
    expect(close).toHaveBeenCalledTimes(3);
    // Individual verified identities, in record order — never a batch, never
    // anything beyond the recorded set.
    expect(close.mock.calls).toEqual([
      [{ kind: "pid", pid: 101 }],
      [{ kind: "pid", pid: 202 }],
      [{ kind: "document", documentIdentity: "C:\\parts\\plate.sldprt" }]
    ]);
  });

  it("recordIdentity extends the attestation; snapshotRecord closes everything recorded", () => {
    const { close, closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [101] });
    guard.recordIdentity({ runId: "run-1", attemptId: "attempt-1", identity: pidOf(202) });
    guard.recordIdentity({
      runId: "run-1",
      attemptId: "attempt-1",
      identity: documentOf("C:\\late.sldprt")
    });
    const snapshot = guard.snapshotRecord({ runId: "run-1", attemptId: "attempt-1" });
    expect(snapshot.identities).toEqual([
      { kind: "pid", pid: 101 },
      { kind: "pid", pid: 202 },
      { kind: "document", documentIdentity: "C:\\late.sldprt" }
    ]);
    const outcome = guard.closeOnlyOwned(snapshot);
    expect(outcome.status).toBe("closed");
    expect(close).toHaveBeenCalledTimes(3);
    expect(close.mock.calls.map(([identity]) => identity)).toEqual([
      { kind: "pid", pid: 101 },
      { kind: "pid", pid: 202 },
      { kind: "document", documentIdentity: "C:\\late.sldprt" }
    ]);
  });

  it("never passes foreign / unrecorded pids: the whole close is unproven and the closer is untouched", () => {
    const { close, closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [101] });
    // A record mixing a recorded pid with a foreign one.
    const forged = {
      runId: "run-1",
      attemptId: "attempt-1",
      identities: [pidOf(101), pidOf(999)] as readonly SolidWorksIdentity[]
    } as OwnershipRecord;
    const outcome = guard.closeOnlyOwned(forged);
    expect(outcome).toEqual({ status: "ownership-unproven", reason: "identity-not-attested" });
    expect(close).not.toHaveBeenCalled();
    // A record carrying ONLY foreign identities.
    const onlyForeign = {
      runId: "run-1",
      attemptId: "attempt-1",
      identities: [pidOf(999)] as readonly SolidWorksIdentity[]
    } as OwnershipRecord;
    expect(guard.closeOnlyOwned(onlyForeign)).toEqual({
      status: "ownership-unproven",
      reason: "identity-not-attested"
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("never closes identities attested under another run/attempt pair (record bound to runId+attemptId)", () => {
    const { close, closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [101] });
    guard.record({ runId: "run-1", attemptId: "attempt-2", pids: [202] });
    // Same pids, wrong attempt binding.
    const wrongAttempt = {
      runId: "run-1",
      attemptId: "attempt-2",
      identities: [pidOf(101)] as readonly SolidWorksIdentity[]
    } as OwnershipRecord;
    expect(guard.closeOnlyOwned(wrongAttempt)).toEqual({
      status: "ownership-unproven",
      reason: "identity-not-attested"
    });
    // No attestation at all for this attempt pair.
    const unattestedAttempt = {
      runId: "run-2",
      attemptId: "attempt-9",
      identities: [pidOf(101)] as readonly SolidWorksIdentity[]
    } as OwnershipRecord;
    expect(guard.closeOnlyOwned(unattestedAttempt)).toEqual({
      status: "ownership-unproven",
      reason: "attempt-not-attested"
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("missing proof (record built without attestation) never invokes the closer", () => {
    const { close, closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    const unproven = buildOwnershipRecord({
      runId: "run-1",
      attemptId: "attempt-1",
      identities: [pidOf(101)]
    });
    expect(guard.closeOnlyOwned(unproven)).toEqual({
      status: "ownership-unproven",
      reason: "attempt-not-attested"
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("a record from a previous guard instance (process restart) cannot prove ownership", () => {
    const first = new SolidWorksOwnershipGuard({ closer: { close: () => {} } });
    const record = first.record({ runId: "run-1", attemptId: "attempt-1", pids: [101] });
    const { close, closer } = recordingCloser();
    const restarted = new SolidWorksOwnershipGuard({ closer });
    expect(restarted.closeOnlyOwned(record)).toEqual({
      status: "ownership-unproven",
      reason: "attempt-not-attested"
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("nothing-owned never invokes the closer (normal cancellation may proceed)", () => {
    const { close, closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    const empty = guard.record({ runId: "run-1", attemptId: "attempt-1" });
    expect(empty.identities).toEqual([]);
    expect(guard.closeOnlyOwned(empty)).toEqual({ status: "nothing-owned" });
    // Even a forged empty record is harmless.
    const forgedEmpty = {
      runId: "run-1",
      attemptId: "attempt-1",
      identities: [] as readonly SolidWorksIdentity[]
    } as OwnershipRecord;
    expect(guard.closeOnlyOwned(forgedEmpty)).toEqual({ status: "nothing-owned" });
    expect(close).not.toHaveBeenCalled();
  });

  it("a throwing closer yields a structured partial outcome and still attempts the rest", () => {
    const close = vi.fn((identity: SolidWorksIdentity): void => {
      if (identity.kind === "pid" && identity.pid === 202) {
        throw new Error("close rejected for 202");
      }
    });
    const guard = new SolidWorksOwnershipGuard({ closer: { close } });
    const record = guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [101, 202, 303] });
    const outcome = guard.closeOnlyOwned(record);
    expect(outcome.status).toBe("partial");
    if (outcome.status === "partial") {
      expect(outcome.closed).toEqual([
        { kind: "pid", pid: 101 },
        { kind: "pid", pid: 303 }
      ]);
      expect(outcome.failed).toHaveLength(1);
      expect(outcome.failed[0]?.identity).toEqual({ kind: "pid", pid: 202 });
      expect(outcome.failed[0]?.error).toBeInstanceOf(Error);
    }
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("a closer that throws for every identity yields the structured failed outcome", () => {
    const close = vi.fn<(identity: SolidWorksIdentity) => void>((_identity) => {
      void _identity;
      throw new Error("boom");
    });
    const guard = new SolidWorksOwnershipGuard({ closer: { close } });
    const record = guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [101, 202] });
    const outcome = guard.closeOnlyOwned(record);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.closed).toEqual([]);
      expect(outcome.failed.map(({ identity }) => identity)).toEqual([
        { kind: "pid", pid: 101 },
        { kind: "pid", pid: 202 }
      ]);
    }
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed identities at record time and refuses malformed records at close time", () => {
    const { closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    expect(() =>
      guard.record({ runId: "", attemptId: "attempt-1", pids: [101] })
    ).toThrow(InvalidArgumentError);
    expect(() =>
      guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [0] })
    ).toThrow(InvalidArgumentError);
    expect(() =>
      guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [-5] })
    ).toThrow(InvalidArgumentError);
    expect(() =>
      guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [1.5] })
    ).toThrow(InvalidArgumentError);
    expect(() =>
      guard.record({ runId: "run-1", attemptId: "attempt-1", documentIdentities: ["   "] })
    ).toThrow(InvalidArgumentError);
    const malformed = {
      runId: "run-1",
      attemptId: "attempt-1",
      identities: [{ kind: "pid", pid: -1 }] as readonly SolidWorksIdentity[]
    } as OwnershipRecord;
    expect(() => guard.closeOnlyOwned(malformed)).toThrow(InvalidArgumentError);
  });

  it("exposes no command/process-name kill or enumeration API on its runtime surface", () => {
    expect(guardHasNoForbiddenApi).toBe(true);
    const proto = Object.getOwnPropertyNames(SolidWorksOwnershipGuard.prototype).sort();
    expect(proto).toEqual(
      ["closeOnlyOwned", "constructor", "record", "recordIdentity", "snapshotRecord"].sort()
    );
    const instance = new SolidWorksOwnershipGuard({ closer: { close: () => {} } });
    const ownNames = Object.getOwnPropertyNames(instance);
    const forbiddenPattern = /kill|enumerate|closeAll|process|tasklist|taskkill|spawn|exec/i;
    for (const name of [...proto, ...ownNames]) {
      expect(name).not.toMatch(forbiddenPattern);
    }
  });

  it("maps close outcomes to the cancellation policy (nothing-owned allows normal cancellation)", () => {
    const { closer } = recordingCloser();
    const guard = new SolidWorksOwnershipGuard({ closer });
    const record = guard.record({ runId: "run-1", attemptId: "attempt-1", pids: [101] });
    const closed: CloseOnlyOwnedOutcome = guard.closeOnlyOwned(record);
    expect(isOwnedCloseSafeForCancellation(closed)).toBe(true);
    const nothing: CloseOnlyOwnedOutcome = guard.closeOnlyOwned(
      guard.record({ runId: "run-1", attemptId: "attempt-2" })
    );
    expect(isOwnedCloseSafeForCancellation(nothing)).toBe(true);
    const unproven: CloseOnlyOwnedOutcome = {
      status: "ownership-unproven",
      reason: "attempt-not-attested"
    };
    const partial: CloseOnlyOwnedOutcome = {
      status: "partial",
      closed: [pidOf(101)],
      failed: [{ identity: pidOf(202), error: new Error("x") }]
    };
    const failed: CloseOnlyOwnedOutcome = {
      status: "failed",
      closed: [],
      failed: [{ identity: pidOf(101), error: new Error("x") }]
    };
    expect(isOwnedCloseSafeForCancellation(unproven)).toBe(false);
    expect(isOwnedCloseSafeForCancellation(partial)).toBe(false);
    expect(isOwnedCloseSafeForCancellation(failed)).toBe(false);
  });
});
