import type {
  RecoveryCapabilityContext,
  RunRecoveryCapabilities
} from "../../orchestration/run-orchestrator.js";
import {
  decideThreadResume,
  hasSafeCheckpoint,
  type ThreadSessionLike
} from "./thread-session-recovery.js";

/**
 * Phase 5 (P5-4): {@link RunRecoveryCapabilities} adapter around the
 * protocol-pinned thread-session recovery helper.
 *
 * The orchestrator's recovery scan proves resumes through the injected
 * `RunRecoveryCapabilities` surface (see `run-orchestrator.ts`): an interrupted
 * Run at PREPARING / ANALYZING / PLANNING (or with no recorded stage) resumes
 * only when `canSafelyResume` proves the work idempotently resumable, and a
 * MODELING / VALIDATING / PACKAGING stage resumes only when `hasSafeCheckpoint`
 * proves an explicit checkpoint.
 *
 * This adapter answers BOTH proofs from the Codex thread-session store: a
 * resume is proven exactly when the injected session lookup returns a
 * well-formed session whose stage is resumable (`null` / PREPARING / ANALYZING
 * / PLANNING) under the pinned protocol — MODELING / VALIDATING / PACKAGING
 * are ALWAYS refused regardless of any session (hard pin in
 * `thread-session-recovery.ts`, no injected predicate can loosen it).
 *
 * The adapter is deliberately file/workspace-agnostic: the injected lookup maps
 * a Run id to the minimal {@link ThreadSessionLike} view (e.g. a Codex adapter
 * worker's persisted `runtime/agent-session.json` read surface), so wiring the
 * real session store stays a later-batch concern of the Runner process.
 */
export type ThreadSessionLookup = (runId: string) => ThreadSessionLike | null;

/**
 * Builds the orchestrator recovery capabilities from an injected thread-session
 * lookup. `canSafelyResume` proves a resume only for a pinned-protocol session
 * at a resumable stage; `hasSafeCheckpoint` is ALWAYS false at MODELING /
 * VALIDATING / PACKAGING (the hard pin), true only for a pinned-protocol
 * session at a resumable stage, false for absent / malformed sessions.
 */
export function threadSessionRecoveryCapabilities(
  lookupSession: ThreadSessionLookup
): RunRecoveryCapabilities {
  return {
    canSafelyResume(context: RecoveryCapabilityContext): boolean {
      return decideThreadResume({ runId: context.runId, lookupSession }).resume;
    },
    hasSafeCheckpoint(context: RecoveryCapabilityContext): boolean {
      return hasSafeCheckpoint(lookupSession(context.runId));
    }
  };
}
