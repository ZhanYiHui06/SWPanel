import { RUN_STAGES, type RunStage } from "@swpanel/domain";

import {
  CODEX_CLI_VERSION,
  CODEX_PROTOCOL_VERSION
} from "../../agent/codex/builders.js";

/**
 * Phase 5 (P5-4): protocol-pinned thread-session recovery decision helper.
 *
 * A Codex thread session (the adapter's persisted `AgentSessionRecord` thread
 * at `runtime/agent-session.json`) may prove a resume of the modeling thread
 * ONLY while the attempt's last proven stage is `null` (nothing reached yet),
 * PREPARING, ANALYZING or PLANNING. Once the thread entered MODELING /
 * VALIDATING / PACKAGING, the SolidWorks-side state can no longer be proven
 * consistent with the stored session: `hasSafeCheckpoint` is ALWAYS false for
 * those stages — this is a hard pin that no injected predicate can loosen.
 *
 * The helper is deliberately isolated from the Codex adapter files (it accepts
 * an INJECTED session lookup — the adapter worker's session surface — and a
 * pinned protocol predicate); it imports ONLY the shared protocol constants so
 * the default pin can never drift from the session protocol fields the adapter
 * actually writes (`CODEX_PROTOCOL_VERSION`, the app-server protocol major "2"
 * of the `runtime/agent-session.json` records). The codex-cli RELEASE
 * (`CODEX_CLI_VERSION` / 0.147.0) stays pinned SEPARATELY — a resume decision
 * keys on the session protocol field, never on the CLI release, so a protocol
 * change can never silently resume a thread the current protocol cannot prove.
 * A malformed session (unknown stage, wrong field types) is NEVER trusted for
 * a resume.
 */

/** Stages at which a thread session may prove a resume (plus `null` = none reached). */
export const THREAD_SESSION_RESUME_STAGES: readonly RunStage[] = [
  "PREPARING",
  "ANALYZING",
  "PLANNING"
];

/** Stages at which a safe checkpoint is ALWAYS false (hard pin). */
export const THREAD_SESSION_NO_CHECKPOINT_STAGES: readonly RunStage[] = [
  "MODELING",
  "VALIDATING",
  "PACKAGING"
];

/** The pinned thread protocol a resume decision may rely on. */
export const PINNED_THREAD_SESSION_PROTOCOL = "codex-app-server" as const;

/**
 * The pinned thread protocol VERSION a resume decision may rely on — the
 * session protocol field the adapter writes into every `AgentSessionRecord`
 * (the app-server protocol major `CODEX_PROTOCOL_VERSION`), NOT the codex-cli
 * release. Shared with the adapter's own constant so an adapter-produced
 * session can never be rejected by a stale pin (the CLI release stays
 * separately pinned in {@link PINNED_CODEX_CLI_VERSION}).
 */
export const PINNED_THREAD_SESSION_PROTOCOL_VERSION = CODEX_PROTOCOL_VERSION;

/**
 * The pinned codex-cli RELEASE (0.147.0), tracked separately from the session
 * protocol version: a resume decision keys on the session protocol field, and
 * the CLI release is only identity/versioning metadata of the adapter.
 */
export const PINNED_CODEX_CLI_VERSION = CODEX_CLI_VERSION;

/**
 * The minimal thread-session view the decision helper reads. The injected
 * lookup maps a Run id to this shape; protocol fields are optional so callers
 * whose session shape predates the pin must inject their own predicate (the
 * default predicate REQUIRES the pinned protocol, conservatively).
 */
export interface ThreadSessionLike {
  /** The last Run stage the thread session proved; null = none reached yet. */
  readonly stage: RunStage | null;
  readonly protocol?: string;
  readonly protocolVersion?: string;
}

/**
 * The minimal protocol identity the pin reads. A strict stored session record
 * (`AgentSessionRecord`) satisfies it without carrying a Run stage, so callers
 * that only need to verify the protocol pin (e.g. the executor before handing
 * a loaded session to the adapter) can reuse the SAME pin instead of
 * duplicating the pinned constants.
 */
export interface ThreadProtocolIdentity {
  readonly protocol?: string;
  readonly protocolVersion?: string;
}

/** Why a thread-session resume could not be proven. */
export type ThreadResumeDeniedReason =
  | "no-session"
  | "malformed-session"
  | "stage-not-resumable"
  | "protocol-unpinned";

export type ThreadResumeDecision =
  | { resume: true; runId: string; stage: RunStage | null }
  | {
      resume: false;
      runId: string;
      stage: RunStage | null;
      reason: ThreadResumeDeniedReason;
    };

export interface ThreadResumeInput {
  runId: string;
  /** Injected session lookup (e.g. the Codex adapter's session store). */
  lookupSession: (runId: string) => ThreadSessionLike | null;
  /**
   * Stage resumability predicate, default {@link isPinnedResumeStage}. May
   * only TIGHTEN the pin: MODELING / VALIDATING / PACKAGING are never
   * resumable regardless of the injected predicate.
   */
  isResumableStage?: (stage: RunStage | null) => boolean;
  /**
   * Protocol predicate, default {@link isPinnedThreadSessionProtocol}. A
   * session that fails it can never prove a resume.
   */
  isPinnedProtocol?: (session: ThreadSessionLike) => boolean;
}

export interface SafeCheckpointInput {
  isResumableStage?: (stage: RunStage | null) => boolean;
  isPinnedProtocol?: (session: ThreadSessionLike) => boolean;
}

/** Default stage pin: `null` / PREPARING / ANALYZING / PLANNING are resumable. */
export function isPinnedResumeStage(stage: RunStage | null): boolean {
  return stage === null || THREAD_SESSION_RESUME_STAGES.includes(stage);
}

/**
 * Hard pin: MODELING / VALIDATING / PACKAGING can never carry a safe
 * checkpoint. Independent of any injected predicate — always false there.
 */
export function hasHardNoCheckpointStage(stage: RunStage | null): boolean {
  return stage !== null && THREAD_SESSION_NO_CHECKPOINT_STAGES.includes(stage);
}

/** Default protocol pin: the repo-pinned `codex-app-server` / session protocol v2. */
export function isPinnedThreadSessionProtocol(session: ThreadProtocolIdentity): boolean {
  return (
    session.protocol === PINNED_THREAD_SESSION_PROTOCOL &&
    session.protocolVersion === PINNED_THREAD_SESSION_PROTOCOL_VERSION
  );
}

/**
 * Strict shape validation of the injected session view: an unknown stage or
 * malformed protocol fields are NEVER trusted for a resume (mirrors the
 * adapter's strict stored-session validation — a malformed session is treated
 * as absent, never as proof).
 */
export function isWellFormedThreadSession(session: ThreadSessionLike): boolean {
  if (session.stage !== null && !(RUN_STAGES as readonly string[]).includes(session.stage)) {
    return false;
  }
  if (session.protocol !== undefined && typeof session.protocol !== "string") {
    return false;
  }
  if (session.protocolVersion !== undefined && typeof session.protocolVersion !== "string") {
    return false;
  }
  return true;
}

/**
 * Proves (or denies) a thread-session resume decision for one Run through the
 * injected lookup. Resume is proven ONLY when a well-formed session exists,
 * its stage is resumable (hard pin: never MODELING / VALIDATING / PACKAGING)
 * and its protocol is pinned. Every denial carries the structured reason.
 */
export function decideThreadResume(input: ThreadResumeInput): ThreadResumeDecision {
  const session = input.lookupSession(input.runId);
  if (session === null) {
    return { resume: false, runId: input.runId, stage: null, reason: "no-session" };
  }
  if (!isWellFormedThreadSession(session)) {
    return { resume: false, runId: input.runId, stage: null, reason: "malformed-session" };
  }
  const stage = session.stage;
  if (hasHardNoCheckpointStage(stage)) {
    return { resume: false, runId: input.runId, stage, reason: "stage-not-resumable" };
  }
  const isResumableStage = input.isResumableStage ?? isPinnedResumeStage;
  if (!isResumableStage(stage)) {
    return { resume: false, runId: input.runId, stage, reason: "stage-not-resumable" };
  }
  const isPinnedProtocol = input.isPinnedProtocol ?? isPinnedThreadSessionProtocol;
  if (!isPinnedProtocol(session)) {
    return { resume: false, runId: input.runId, stage, reason: "protocol-unpinned" };
  }
  return { resume: true, runId: input.runId, stage };
}

/**
 * True only when the session proves a safe checkpoint to resume from. Always
 * false for MODELING / VALIDATING / PACKAGING (hard pin), for a malformed or
 * absent session, and for a session whose protocol is not pinned.
 */
export function hasSafeCheckpoint(session: ThreadSessionLike | null, input?: SafeCheckpointInput): boolean {
  if (session === null || !isWellFormedThreadSession(session)) {
    return false;
  }
  if (hasHardNoCheckpointStage(session.stage)) {
    return false;
  }
  const isResumableStage = input?.isResumableStage ?? isPinnedResumeStage;
  if (!isResumableStage(session.stage)) {
    return false;
  }
  const isPinnedProtocol = input?.isPinnedProtocol ?? isPinnedThreadSessionProtocol;
  return isPinnedProtocol(session);
}
