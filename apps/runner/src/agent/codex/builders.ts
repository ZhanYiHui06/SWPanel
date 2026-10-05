/**
 * Pure parameter builders for the USED subset of the Codex App Server
 * protocol 0.147.0 (Phase 5, P5-3). Every builder emits EXACTLY the field
 * names of the actual 0.147.0 schema documents
 * (`.scratch/codex-app-server-schema-0.147.0/v2/ThreadStartParams.json`,
 * `ThreadResumeParams.json`, `TurnStartParams.json`,
 * `TurnInterruptParams.json`) — no invented wire fields:
 *
 * - `thread/start` params: `cwd`, `sandbox: "workspace-write"`,
 *   `approvalPolicy: "never"` — the STABLE 0.147.0 thread-open fields ONLY.
 *   `runtimeWorkspaceRoots` is a GATED field (native Codex 0.147.0 rejects it
 *   with JSON-RPC -32600 unless the client declares
 *   `capabilities.experimentalApi: true`), and the SWPanel client explicitly
 *   declares `experimentalApi: false` — so it is NEVER emitted;
 * - `thread/resume` params: `threadId` + the same stable thread-open fields
 *   (`cwd`, `sandbox: "workspace-write"`, `approvalPolicy: "never"`, never the
 *   gated field);
 * - `turn/start` params: `threadId`, `input` (text prompt, `localImage`
 *   absolute path, `skill` name + resolved path — the actual `UserInput`
 *   variants of 0.147.0), `outputSchema` (the PROVIDER-FACING Agent Turn
 *   Output wire schema — the flattened, Structured Outputs-compatible
 *   projection of the canonical contract; native Codex 0.147.0 rejects the
 *   canonical root-oneOf document) and
 *   `sandboxPolicy: { type: "workspaceWrite", writableRoots }` limited to the
 *   attempt root ONLY;
 * - `turn/interrupt` params: `threadId` + `turnId`;
 * - `skills/list` params: optional `cwds` (scan working directories) +
 *   optional `forceReload` (bypass the skills cache).
 *
 * The builders are pure and defensive: they validate their own inputs
 * (absolute, non-empty) and throw {@link InvalidArgumentError} on a caller
 * violation — the seam that supplies `writableRoots` is contractually limited
 * to the attempt workspace root and never widens it. The writable roots are
 * validated on the thread-open builders too (defensive guard of the shared
 * seam), but they are emitted ONLY via `turn/start.sandboxPolicy` — never as
 * the gated `runtimeWorkspaceRoots` thread field.
 *
 * `approvalPolicy: "never"` is pinned EXPLICITLY on both thread-open builders
 * (never left to the app-server default): the background Runner must never
 * depend on interactive approval (with the default policy the app server
 * routes approval-required actions to the client via `permissions/request`,
 * which the non-interactive Runner client neither serves nor answers), and
 * `never` never auto-approves out-of-scope operations either — native Codex
 * 0.147.0 treats actions that would require approval as FORBIDDEN under this
 * policy (see codex-rs `exec_policy`), so containment stays with the
 * `workspace-write` sandbox and the attempt-root `writableRoots`.
 */
import { CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA } from "./codex-agent-turn-output.js";
import { isAbsolute, posix, win32 } from "node:path";

function isPlatformOrCrossAbsolute(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value);
}

import { InvalidArgumentError } from "../../errors.js";

/** Pinned codex-cli release this adapter subset is contract-tested against. */
export const CODEX_CLI_VERSION = "0.147.0" as const;

/** The app-server protocol major the used subset speaks (no invented version). */
export const CODEX_PROTOCOL_VERSION = "2" as const;

/** Client identity of the SWPanel app-server client (initialize.clientInfo). */
export const CODEX_CLIENT_INFO = {
  name: "swpanel",
  version: "0.1.0"
} as const;

/** The 0.147.0 `SandboxMode` the used subset declares for threads. */
export const CODEX_SANDBOX_MODE = "workspace-write" as const;

/**
 * The 0.147.0 `AskForApproval` value pinned on thread/start AND thread/resume:
 * never prompt the user (no interactive approval dependency for the background
 * Runner) and never auto-approve out-of-scope actions (native Codex treats
 * approval-required actions as forbidden under this policy).
 */
export const CODEX_APPROVAL_POLICY = "never" as const;

export interface ThreadStartBuildInput {
  /** Absolute attempt-workspace root (the runtime cwd). */
  cwd: string;
  /** Writable roots — the seam MUST supply the attempt root ONLY. */
  writableRoots: readonly string[];
}

export interface ThreadResumeBuildInput {
  /** The prior thread the session resumes. */
  threadId: string;
  cwd: string;
  writableRoots: readonly string[];
}

export interface TurnStartBuildInput {
  threadId: string;
  /** Optional per-turn model override (null/undefined/"" = the CLI default). */
  model?: string | null;
  /** Controlled rendered prompt text of the attempt. */
  promptText: string;
  /** Absolute path of the derived Skill input image. */
  localImageAbsolutePath: string;
  /** Skill the turn must invoke: frozen name + resolved absolute path. */
  skill: {
    name: string;
    resolvedPath: string;
  };
  /** Writable roots — the seam MUST supply the attempt root ONLY. */
  writableRoots: readonly string[];
}

export interface TurnInterruptBuildInput {
  threadId: string;
  turnId: string;
}

/** The 0.147.0 `UserInput` objects the used subset emits (in this order). */
export const CODEX_TURN_INPUT_ORDER = ["text", "localImage", "skill"] as const;

function assertAbsolutePath(value: string, field: string): void {
  if (value.length === 0) {
    throw new InvalidArgumentError(`${field} must be a non-empty string`);
  }
  if (!isPlatformOrCrossAbsolute(value)) {
    throw new InvalidArgumentError(`${field} must be an absolute path`);
  }
}

function assertWritableRoots(value: readonly string[]): void {
  if (value.length === 0) {
    throw new InvalidArgumentError("writableRoots must not be empty");
  }
  for (const root of value) {
    assertAbsolutePath(root, "writableRoots entry");
  }
}

function threadWorkspaceFields(input: {
  cwd: string;
  writableRoots: readonly string[];
}): Record<string, unknown> {
  assertAbsolutePath(input.cwd, "cwd");
  assertWritableRoots(input.writableRoots);
  // STABLE thread-open fields ONLY: the gated `runtimeWorkspaceRoots` field
  // requires the `experimentalApi` capability (never declared by this client,
  // `experimentalApi: false`), so emitting it would make native Codex 0.147.0
  // reject the request with -32600. Containment comes from `cwd` + the
  // `workspace-write` sandbox mode; the writable roots are emitted ONLY via
  // `turn/start.sandboxPolicy` (see `buildTurnStartParams`).
  //
  // `approvalPolicy: "never"` is explicit, never the app-server default: the
  // background Runner must not depend on interactive approval, and native
  // Codex 0.147.0 forbids (does not auto-approve) actions that would require
  // approval under this policy — the sandbox stays the only boundary.
  return {
    cwd: input.cwd,
    sandbox: CODEX_SANDBOX_MODE,
    approvalPolicy: CODEX_APPROVAL_POLICY
  };
}

/** Builds the `thread/start` params (0.147.0 `ThreadStartParams`). */
export function buildThreadStartParams(input: ThreadStartBuildInput): Record<string, unknown> {
  return threadWorkspaceFields(input);
}

/** Builds the `thread/resume` params (0.147.0 `ThreadResumeParams`). */
export function buildThreadResumeParams(input: ThreadResumeBuildInput): Record<string, unknown> {
  if (input.threadId.length === 0) {
    throw new InvalidArgumentError("threadId must be a non-empty string");
  }
  return {
    threadId: input.threadId,
    ...threadWorkspaceFields(input)
  };
}

/** Builds the `turn/start` params (0.147.0 `TurnStartParams`). */
export function buildTurnStartParams(input: TurnStartBuildInput): Record<string, unknown> {
  if (input.threadId.length === 0) {
    throw new InvalidArgumentError("threadId must be a non-empty string");
  }
  if (input.promptText.length === 0) {
    throw new InvalidArgumentError("promptText must be a non-empty string");
  }
  assertAbsolutePath(input.localImageAbsolutePath, "localImageAbsolutePath");
  if (input.skill.name.length === 0) {
    throw new InvalidArgumentError("skill.name must be a non-empty string");
  }
  assertAbsolutePath(input.skill.resolvedPath, "skill.resolvedPath");
  assertWritableRoots(input.writableRoots);
  return {
    threadId: input.threadId,
    // Optional per-turn model override (the user's Settings choice); omitted = the CLI's own default.
    ...(input.model === undefined || input.model === null || input.model === "" ? {} : { model: input.model }),
    input: [
      { type: "text", text: input.promptText },
      { type: "localImage", path: input.localImageAbsolutePath },
      { type: "skill", name: input.skill.name, path: input.skill.resolvedPath }
    ],
    // The PROVIDER-FACING Agent Turn Output wire schema constrains the final
    // assistant message to EXACTLY ONE terminal state: completed (the embedded
    // Result Manifest v1) or clarification_required (structured questions
    // only). The canonical registered contract uses a root oneOf which native
    // Codex 0.147.0 rejects as outputSchema; this flattened projection
    // (closed objects, required nullable sentinels, no oneOf/anyOf/allOf/not)
    // is what the provider accepts. The canonical @swpanel/contracts validator
    // stays the authoritative semantic gate after projection.
    outputSchema: CODEX_AGENT_TURN_OUTPUT_WIRE_SCHEMA,
    // `workspaceWrite` writableRoots are the attempt root ONLY — the runtime
    // can never write outside the attempt workspace through this seam.
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [...input.writableRoots]
    }
  };
}

/** Builds the `turn/interrupt` params (0.147.0 `TurnInterruptParams`). */
export function buildTurnInterruptParams(input: TurnInterruptBuildInput): Record<string, unknown> {
  if (input.threadId.length === 0) {
    throw new InvalidArgumentError("threadId must be a non-empty string");
  }
  if (input.turnId.length === 0) {
    throw new InvalidArgumentError("turnId must be a non-empty string");
  }
  return {
    threadId: input.threadId,
    turnId: input.turnId
  };
}

export interface SkillsListBuildInput {
  /**
   * Working directories to scan for repo-scoped skills. Empty (absent)
   * defaults to the current session working directory (0.147.0 semantics).
   */
  cwds?: readonly string[];
  /** When true, bypass the skills cache and re-scan skills from disk. */
  forceReload?: boolean;
}

/** Builds the `skills/list` params (0.147.0 `SkillsListParams`). */
export function buildSkillsListParams(input: SkillsListBuildInput = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.cwds !== undefined) {
    if (input.cwds.length === 0) {
      throw new InvalidArgumentError("cwds must not be an empty array (absent defaults to the session cwd)");
    }
    for (const cwd of input.cwds) {
      if (cwd.length === 0) {
        throw new InvalidArgumentError("cwds entries must be non-empty strings");
      }
    }
    params.cwds = [...input.cwds];
  }
  if (input.forceReload !== undefined) {
    if (typeof input.forceReload !== "boolean") {
      throw new InvalidArgumentError("forceReload must be a boolean");
    }
    params.forceReload = input.forceReload;
  }
  return params;
}
