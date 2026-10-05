/**
 * Codex App Server adapter of the async Agent turn seam (Phase 5, P5-3).
 * Driven by the injectable {@link CodexAppServerClient} (strict NDJSON
 * JSON-RPC, codex-cli 0.147.0 / protocol v2), one `runTurn` performs the
 * whole Agent result turn of one Run attempt:
 *
 *   initialize (handshake) → thread/start | thread/resume (fresh vs supplied
 *   prior session) → turn/start (text prompt + localImage + skill +
 *   provider-facing Agent Turn Output wire outputSchema + workspaceWrite
 *   writableRoots limited to the attempt root) → consume notifications until
 *   turn/completed → extract the schema-valid Agent Turn Output document from
 *   the final agentMessage JSON (EXACTLY ONE DISTINCT document per turn —
 *   semantically identical duplicates are folded into one; 0 / multiple
 *   DISTINCT / malformed fail AGENT_PROTOCOL_INCOMPATIBLE) → dispatch the
 *   terminal state: `completed`
 *   writes output/result-manifest.json + the technical session/log files and
 *   returns the success raw records; `clarification_required` writes NO
 *   manifest, returns metadata+turn raw records and the strictly validated
 *   question set → the raw records in translator-compatible order.
 *
 * Once the technical session is written, ANY failure while building/sending
 * `turn/start`, awaiting `turn/completed` or extracting the unique Agent Turn
 * Output document persists the session record as `failed` BEFORE the typed
 * failure propagates. A `turn/start` JSON-RPC error may contribute ONLY its
 * bounded/redacted `details.rpcMessage` through the shared turn-error
 * sanitizer; every other note is a stable generic category label. Raw agent
 * content, raw JSON, host paths, URLs, credentials and full client errors are
 * never persisted. A failed session write itself is best-effort: it never
 * masks the original typed failure and never leaks the write error.
 *
 * A `turn/completed` WAIT TIMEOUT is not just reported: the server-side turn
 * may still be running, so the adapter sends `turn/interrupt` for the EXACT
 * current threadId/turnId and waits a SHORT BOUNDED grace for the matching
 * `turn/completed`. Only a confirmed terminal completion (interrupted /
 * completed / failed) keeps the client reusable; an interrupt delivery
 * failure or a grace expiry leaves the connection state ambiguous, so the
 * client is POISONED (made non-reusable) before the ORIGINAL AGENT_TIMEOUT
 * propagates — a late completion of the old turn can never corrupt a later
 * turn on the same thread. The session note keeps its existing
 * content-independent timeout classification and gains ONLY a safe interrupt
 * outcome category and a FIXED bounded category summary of the current
 * threadId/turnId's activity (notification method counts + the last activity
 * category before the failure; `approval-request` when an inbound server→client
 * request failed the connection closed — the fail-closed client reports the
 * method name through a content-free observer). Params, deltas, commands,
 * paths, reasoning, raw method strings and raw content are NEVER persisted.
 * Successful turns never persist these diagnostics.
 *
 * Failure mapping (typed {@link AgentTurnError}, every code a REAL domain Run
 * failure code):
 *   - timeout                        → AGENT_TIMEOUT (original, always)
 *   - wire/malformed/final-JSON/RPC  → AGENT_PROTOCOL_INCOMPATIBLE
 *   - interrupted turn               → AGENT_INTERRUPTED
 *   - child exit / failed turn       → AGENT_RUNTIME_UNAVAILABLE
 *
 * Reasoning deltas and raw content are DROPPED from the product records — the
 * raw log (technical-only) carries the record stream, and the session record
 * is strictly validated / redacted. The adapter's in-turn delta collector is
 * BOUNDED (per-item chars, total chars, item count — see
 * {@link CodexAppServerAdapterOptions}): the Agent Turn Output document is the
 * head of the item content, so head-retention keeps extraction correct for the
 * supported flow while a flooding peer can never exhaust memory; a turn whose
 * document does not fit the bound fails loudly (AGENT_PROTOCOL_INCOMPATIBLE),
 * never silently succeeds with truncated content. Terminal events stay
 * orchestrator-owned: a clarification turn's raw records NEVER carry a
 * `clarification_requested` record, so the translator can never duplicate the
 * ClarificationRequired event the orchestrator's `clarifyAttempt` writes.
 *
 * The child-process stdio transport and live Runner wiring are implemented and
 * repository-tested. Real HIL has exercised technical failure paths, but no
 * successful CAD modeling, real engineering clarification or ownership-safe
 * cancellation HIL has completed.
 */
import { validateCodexAgentTurnOutputWire } from "./codex-agent-turn-output.js";

import { RESULT_MANIFEST_FILE_RELATIVE_PATH } from "../../artifacts/result-artifact-set.js";
import { RAW_AGENT_LOG_RELATIVE_PATH, RAW_AGENT_RECORDS_VERSION, type RawAgentRecord } from "../raw-agent-records.js";
import {
  AgentTurnError,
  type AgentInterruptInput,
  type AgentTurnAdapter,
  type AgentTurnInput,
  type AgentTurnOutcome,
  type AgentWorkspace
} from "../agent-turn-adapter.js";
import { InvalidArgumentError } from "../../errors.js";
import {
  buildAgentSessionRecord,
  validateAgentSessionRecord,
  withAgentSessionStatus,
  writeAgentSessionRecord,
  type AgentSessionRecord
} from "./agent-session.js";
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnInterruptParams,
  buildTurnStartParams,
  CODEX_CLI_VERSION,
  CODEX_PROTOCOL_VERSION
} from "./builders.js";
import {
  CodexClientError,
  DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS,
  type CodexAppServerClient,
  type CodexTurnCompleted
} from "./codex-app-server-client.js";
import { sanitizeCodexTurnErrorMessage } from "./turn-error-sanitizer.js";

export const CODEX_APP_SERVER_ADAPTER_ID = "codex-app-server" as const;

export interface CodexAppServerAdapterOptions {
  /** The injectable protocol client; tests script an in-memory transport. */
  client: CodexAppServerClient;
  /**
   * AUTHORITATIVE model image-input support recorded in the raw
   * `metadata_updated` record — NEVER invented by the adapter. The live
   * wiring must pass the SAME proven value the preflight gate used
   * (`RealPreflightProbeOptions.modelImageInputSupported`); absent (or
   * undefined) it fails CLOSED to `false`, so a wiring that cannot prove
   * image support never records a claim it cannot substantiate.
   */
  modelSupportsImageInput?: boolean;
  /** Bounded wait for the turn/completed notification (default 2 hours). */
  turnTimeoutMs?: number;
  /**
   * SHORT bounded grace AFTER a turn-wait timeout: the adapter sends
   * `turn/interrupt` for the exact current threadId/turnId and waits this
   * long for the matching `turn/completed` to confirm the interrupt
   * (default 5 seconds). A confirmed terminal completion keeps the client
   * reusable; any other outcome poisons it (non-reusable).
   */
  interruptGraceTimeoutMs?: number;
  /**
   * Per-item cap of the collected agentMessage delta text in characters
   * (default 256 KiB, head-retained). Deltas beyond the cap of an item are
   * dropped; the retained prefix of the item content always starts with its
   * Agent Turn Output document region (the supported flow emits the document
   * first, followed at most by a trailing summary), so extraction is
   * unaffected.
   */
  maxCollectedItemChars?: number;
  /**
   * Per-turn cap of ALL collected agentMessage delta text in characters
   * (default 4 MiB). Once exhausted, further deltas (including new items) are
   * dropped and the turn fails loudly at extraction when its document did not
   * fit — never silent success with truncated content.
   */
  maxCollectedTotalChars?: number;
}

export const DEFAULT_CODEX_COLLECTED_ITEM_MAX_CHARS = 262_144;
export const DEFAULT_CODEX_COLLECTED_TOTAL_MAX_CHARS = 4_194_304;
/** Default short bounded grace after a turn-wait timeout for the interrupt confirmation. */
export const DEFAULT_CODEX_INTERRUPT_GRACE_TIMEOUT_MS = 5_000 as const;
/** Cap of distinct collected items per turn; further items are dropped. */
const MAX_COLLECTED_ITEMS = 1_024 as const;
/** Compaction threshold: many tiny deltas are joined to bound per-part overhead. */
const MAX_COLLECTED_ITEM_PARTS = 512 as const;

/**
 * Stable generic session notes after the technical session was written. The
 * turn-start note may be replaced by a bounded/redacted JSON-RPC diagnostic;
 * wait/extraction notes remain fixed category labels. Raw agent content, raw
 * JSON and full client errors are never persisted.
 */
const SESSION_FAILED_NOTE_TURN_START = "Codex turn start failed" as const;
const SESSION_FAILED_NOTE_PREFIX = "Codex turn failed: " as const;
const SESSION_FAILED_NOTE_TURN_WAIT = "Codex turn wait failed" as const;
const SESSION_FAILED_NOTE_OUTPUT_EXTRACTION =
  "Agent Turn Output extraction failed" as const;

type AgentTurnOutputExtractionDiagnostic =
  | "no-agent-message-items"
  | "no-balanced-json-object"
  | "no-parseable-json-object"
  | "no-valid-provider-wire-document"
  | "multiple-valid-provider-wire-documents";

/**
 * Safe outcome categories of the interrupt-and-grace recovery AFTER a
 * turn-wait TIMEOUT (fixed labels, never raw peer content):
 * - `confirmed-*`: a matching turn/completed arrived within the grace and
 *   settles the turn — the client stays reusable;
 * - `request-failed` / `grace-timed-out`: the interrupt could not be
 *   delivered / no completion confirmed within the grace — the server-side
 *   turn state is unknown and the client is POISONED (non-reusable).
 */
export type CodexTurnWaitTimeoutInterruptOutcome =
  | "confirmed-interrupted"
  | "confirmed-completed"
  | "confirmed-failed"
  | "request-failed"
  | "grace-timed-out";

/**
 * Fixed safe categories of the CURRENT turn's activity, used ONLY for failed
 * session diagnostics. Every category is a fixed label; notification methods
 * map onto them and ONLY the fixed labels + bounded counts are ever persisted
 * — never params, deltas, commands, paths, reasoning or raw method strings
 * (raw method names exist transiently on the in-memory observer seam only and
 * are immediately reduced to a category).
 */
export type CodexTurnActivityCategory =
  | "agent-message"
  | "command-execution"
  | "file-change"
  | "tool-or-other"
  | "approval-request";

/** Fixed order of the persisted category summary (deterministic output). */
const ACTIVITY_CATEGORIES: readonly CodexTurnActivityCategory[] = [
  "agent-message",
  "command-execution",
  "file-change",
  "tool-or-other",
  "approval-request"
] as const;

/** Content-free aggregate of the CURRENT thread/turn; `lastActivity` is the last category before failure. */
export interface CodexTurnActivitySummary {
  counts: ReadonlyMap<CodexTurnActivityCategory, number>;
  lastActivity: CodexTurnActivityCategory | null;
}

/** Cap of distinct pre-turn-start / unattributable turn buffers during ONE run attempt. */
const MAX_TRACKED_PENDING_TURNS = 64 as const;

/** Server→client notification methods counted as `command-execution`. */
const COMMAND_EXECUTION_NOTIFICATION_METHODS = new Set([
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction"
]);

/** Server→client notification methods counted as `file-change`. */
const FILE_CHANGE_NOTIFICATION_METHODS = new Set([
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated"
]);

class AgentTurnOutputExtractionError extends AgentTurnError {
  readonly diagnostic: AgentTurnOutputExtractionDiagnostic;

  constructor(diagnostic: AgentTurnOutputExtractionDiagnostic, message: string) {
    super("AGENT_PROTOCOL_INCOMPATIBLE", message);
    this.name = "AgentTurnError";
    this.diagnostic = diagnostic;
  }
}

/** The bounded per-item text accumulator of one turn. */
interface CollectedItemText {
  turnId: string;
  parts: string[];
  chars: number;
}

function turnWaitFailureSessionNote(
  error: unknown,
  collected: ReadonlyMap<string, CollectedItemText>,
  turnId: string,
  activity: CodexTurnActivitySummary,
  interruptOutcome?: CodexTurnWaitTimeoutInterruptOutcome
): string {
  // Fixed bounded category summary of the CURRENT turn's activity (never raw
  // content): low-cardinality labels + small counts, so the note stays within
  // the schema note bounds and the sanitizer conventions.
  const activitySuffix = `; ${formatCodexTurnActivitySummary(activity)}`;
  if (!(error instanceof CodexClientError) || error.code !== "TIMEOUT") {
    return `${SESSION_FAILED_NOTE_TURN_WAIT}${activitySuffix}`;
  }
  const itemObserved = [...collected.values()].some((entry) => entry.turnId === turnId);
  // The existing content-independent classification is KEPT; a TIMEOUT always
  // went through the interrupt-and-grace recovery, so the note gains ONLY the
  // safe interrupt outcome category and the fixed activity summary — never raw
  // peer content.
  const base = `${SESSION_FAILED_NOTE_PREFIX}turn wait timed out: ${
    itemObserved ? "agent-message-items-observed" : "no-agent-message-items"
  }`;
  const note =
    interruptOutcome === undefined
      ? base
      : `${base}; interrupt outcome: ${interruptOutcome}`;
  return `${note}${activitySuffix}`;
}

/** Maps a server→client notification method onto a fixed category; null = ignored. */
function classifyCodexNotificationMethod(method: string): CodexTurnActivityCategory | null {
  if (method === "item/agentMessage/delta") return "agent-message";
  if (COMMAND_EXECUTION_NOTIFICATION_METHODS.has(method)) return "command-execution";
  if (FILE_CHANGE_NOTIFICATION_METHODS.has(method)) return "file-change";
  // turn/completed is a TERMINAL event, never an in-turn activity; every other
  // current-turn notification falls into the tool/other bucket.
  if (method === "turn/completed") return null;
  return "tool-or-other";
}

/** The threadId/turnId attribution of a notification, or null when unattributable. */
function notificationThreadTurn(params: unknown): { threadId: string; turnId: string } | null {
  if (!isRecord(params)) return null;
  if (typeof params.threadId !== "string" || typeof params.turnId !== "string") return null;
  if (params.threadId.length === 0 || params.turnId.length === 0) return null;
  return { threadId: params.threadId, turnId: params.turnId };
}

function pendingTurnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

/** A bounded per-turn activity aggregate buffered transiently in run memory. */
interface PendingTurnActivity {
  counts: Map<CodexTurnActivityCategory, number>;
  lastActivity: CodexTurnActivityCategory | null;
}

/**
 * Content-free tracker of the CURRENT thread/turn activity of ONE run attempt.
 * Every notification is attributed to its EXACT (threadId, turnId); only the
 * adapter's own in-flight turn counts, so foreign-turn and foreign-thread
 * notifications are never tallied. The stored state is only fixed categories
 * + bounded counts (+ the last category) — params, deltas, commands, paths,
 * reasoning and raw content never enter. Server→client REQUESTS (approved by
 * the client's content-free observer) are counted as a fixed
 * `approval-request` category while a turn is in flight.
 */
class TurnActivityTracker {
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private readonly currentCounts = new Map<CodexTurnActivityCategory, number>();
  private lastActivity: CodexTurnActivityCategory | null = null;
  /** Buffered activity observed BEFORE the turn/start response (listener race). */
  private readonly pending = new Map<string, PendingTurnActivity>();

  /** Pins the tracker to the started turn and promotes its pre-start buffer. */
  setCurrentTurn(threadId: string, turnId: string): void {
    this.currentThreadId = threadId;
    this.currentTurnId = turnId;
    const key = pendingTurnKey(threadId, turnId);
    const buffered = this.pending.get(key);
    if (buffered === undefined) return;
    this.pending.delete(key);
    for (const [category, count] of buffered.counts) {
      this.currentCounts.set(category, (this.currentCounts.get(category) ?? 0) + count);
    }
    if (buffered.lastActivity !== null) this.lastActivity = buffered.lastActivity;
  }

  observeNotification(method: string, params: unknown): void {
    const category = classifyCodexNotificationMethod(method);
    if (category === null) return;
    const attribution = notificationThreadTurn(params);
    if (attribution === null) return; // unattributable: never guessed into the current turn
    this.record(attribution, category);
  }

  /** Counts an inbound server→client request (e.g. approval) while a turn is in flight. */
  observeServerRequest(): void {
    if (this.currentTurnId === null) return; // no in-flight turn to attribute the request to
    const category: CodexTurnActivityCategory = "approval-request";
    this.currentCounts.set(category, (this.currentCounts.get(category) ?? 0) + 1);
    this.lastActivity = category;
  }

  summary(): CodexTurnActivitySummary {
    return { counts: this.currentCounts, lastActivity: this.lastActivity };
  }

  private record(
    attribution: { threadId: string; turnId: string },
    category: CodexTurnActivityCategory
  ): void {
    if (this.currentThreadId !== null && this.currentTurnId !== null) {
      if (
        attribution.threadId !== this.currentThreadId ||
        attribution.turnId !== this.currentTurnId
      ) {
        return; // foreign turn / thread: never counted into the current turn
      }
      this.currentCounts.set(category, (this.currentCounts.get(category) ?? 0) + 1);
      this.lastActivity = category;
      return;
    }
    // Before the turn/start response the upcoming turn id is unknown: buffer
    // per candidate (threadId, turnId) in a bounded set, so the listener-race
    // notifications of the about-to-start turn are still counted after the
    // turn/start response reveals the exact ids.
    const key = pendingTurnKey(attribution.threadId, attribution.turnId);
    let entry = this.pending.get(key);
    if (entry === undefined) {
      if (this.pending.size >= MAX_TRACKED_PENDING_TURNS) return;
      entry = { counts: new Map(), lastActivity: null };
      this.pending.set(key, entry);
    }
    entry.counts.set(category, (entry.counts.get(category) ?? 0) + 1);
    entry.lastActivity = category;
  }
}

/**
 * Deterministic, bounded, fixed-label summary of the current turn activity.
 * Layout is stable: every category appears in `ACTIVITY_CATEGORIES` order with
 * a small non-negative integer count, followed by the last activity category
 * (or `none`). Only fixed labels and counts — no high-cardinality strings.
 */
function formatCodexTurnActivitySummary(summary: CodexTurnActivitySummary): string {
  const counts = ACTIVITY_CATEGORIES.map(
    (category) => `${category}=${summary.counts.get(category) ?? 0}`
  ).join(" ");
  return `turn activity: ${counts}; last activity: ${summary.lastActivity ?? "none"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Best-effort persistence of the FAILED technical session record (stable or
 * bounded/redacted note) before the original failure propagates. Once the
 * session was written, a turn-start, wait or output-extraction failure MUST
 * leave it `failed`; the ORIGINAL typed failure is rethrown unchanged. A failed
 * session write never masks that classification and never leaks the write
 * error or raw content. `never` proves catch sites cannot continue afterwards.
 */
function failStartedSession(
  workspace: AgentWorkspace,
  input: AgentTurnInput,
  session: AgentSessionRecord,
  note: string,
  failure: unknown
): never {
  try {
    writeAgentSessionRecord(workspace, {
      runId: input.runId,
      attemptSequence: input.attemptSequence,
      record: withAgentSessionStatus(session, { status: "failed", nowIso: input.nowIso, note })
    });
  } catch {
    // best-effort: preserve the original typed failure, never leak the write error
  }
  throw failure;
}

/** Builds the bounded/redacted technical note of a failure before a turn id exists. */
function turnStartFailureSessionNote(error: unknown): string {
  if (
    error instanceof CodexClientError &&
    error.code === "RPC_ERROR" &&
    typeof error.details?.rpcMessage === "string"
  ) {
    return `${SESSION_FAILED_NOTE_PREFIX}${sanitizeCodexTurnErrorMessage(error.details.rpcMessage)}`;
  }
  const category = error instanceof CodexClientError ? `turn/start ${error.code}` : SESSION_FAILED_NOTE_TURN_START;
  return `${SESSION_FAILED_NOTE_PREFIX}${category}`;
}

/**
 * The Codex App Server adapter of the async turn seam. Every `runTurn` starts
 * with the idempotent handshake, then follows the fresh-vs-resume policy:
 * a supplied prior session (strictly validated) resumes its thread, otherwise
 * a fresh thread is started. The adapter tracks its OWN in-flight turn so a
 * cooperative `interruptTurn` targets exactly the running turn of the claim.
 */
export class CodexAppServerAdapter implements AgentTurnAdapter {
  readonly adapterId = CODEX_APP_SERVER_ADAPTER_ID;
  /** Pinned to the codex-cli release this adapter subset is contract-tested against. */
  readonly adapterVersion = CODEX_CLI_VERSION;
  readonly protocol = CODEX_APP_SERVER_ADAPTER_ID;
  readonly protocolVersion = CODEX_PROTOCOL_VERSION;

  private readonly client: CodexAppServerClient;
  private readonly modelSupportsImageInput: boolean;
  private readonly turnTimeoutMs: number;
  private readonly interruptGraceTimeoutMs: number;
  private readonly maxItemChars: number;
  private readonly maxTotalChars: number;
  private currentTurn: {
    runId: string;
    attemptId: string;
    threadId: string;
    turnId: string;
  } | null = null;
  private lastSessionThreadId: string | null = null;

  constructor(options: CodexAppServerAdapterOptions) {
    this.client = options.client;
    // Fail-closed: image support is an authoritative proven input, never a
    // hardcoded claim — absent it records false.
    this.modelSupportsImageInput = options.modelSupportsImageInput ?? false;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS;
    this.interruptGraceTimeoutMs =
      options.interruptGraceTimeoutMs ?? DEFAULT_CODEX_INTERRUPT_GRACE_TIMEOUT_MS;
    this.maxItemChars = options.maxCollectedItemChars ?? DEFAULT_CODEX_COLLECTED_ITEM_MAX_CHARS;
    this.maxTotalChars =
      options.maxCollectedTotalChars ?? DEFAULT_CODEX_COLLECTED_TOTAL_MAX_CHARS;
  }

  /** Deterministic fallback thread identity; the real thread id follows the first turn. */
  threadIdFor(runId: string): string {
    return this.lastSessionThreadId ?? `thread-${runId}`;
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnOutcome> {
    const { runId, attemptId, attemptSequence, workspace, workspaceRoot, nowIso } = input;

    // 1. Idempotent handshake: initialize (clientInfo + experimentalApi false)
    //    → validated codexHome/platformFamily/platformOs/userAgent → initialized.
    try {
      await this.client.initialize();
    } catch (error) {
      throw this.mapClientError(error);
    }

    // 2. Fresh start vs resume from the SUPPLIED prior session (strictly
    //    validated — a malformed supplied session is a protocol-level lie).
    let threadId: string;
    let resumedFromThreadId: string | undefined;
    const prior = input.priorSession ?? null;
    if (prior !== null) {
      if (validateAgentSessionRecord(prior) === null) {
        throw new AgentTurnError(
          "AGENT_PROTOCOL_INCOMPATIBLE",
          "the supplied prior agent session is malformed and cannot be resumed"
        );
      }
      const resumed = await this.requestOrThrow(() =>
        this.client.threadResume(
          buildThreadResumeParams({
            threadId: prior.threadId,
            cwd: workspaceRoot,
            writableRoots: [workspaceRoot]
          })
        )
      );
      threadId = resumed.thread.id;
      resumedFromThreadId = prior.threadId;
    } else {
      const started = await this.requestOrThrow(() =>
        this.client.threadStart(
          buildThreadStartParams({
            cwd: workspaceRoot,
            writableRoots: [workspaceRoot]
          })
        )
      );
      threadId = started.thread.id;
    }

    // 3. Technical session snapshot (redacted; strictly validated shape).
    let session = buildAgentSessionRecord({
      threadId,
      status: "started",
      adapterId: this.adapterId,
      adapterVersion: this.adapterVersion,
      protocol: this.protocol,
      protocolVersion: this.protocolVersion,
      nowIso,
      attemptId,
      ...(resumedFromThreadId === undefined
        ? {}
        : { resumedFromThreadId }),
      note: "technical session snapshot, never a product event"
    });
    writeAgentSessionRecord(workspace, { runId, attemptSequence, record: session });

    // 4. turn/start: text prompt + localImage absolute path + skill
    //    name/resolved path, provider-facing Agent Turn Output wire
    //    outputSchema, workspaceWrite writableRoots limited to the attempt
    //    root ONLY.
    //
    //    The agentMessage delta collector is registered BEFORE the request is
    //    sent: deltas the server emits between the request and its response
    //    (or before the response microtask is processed) must not be lost.
    //    The collected text is BOUNDED per item and across the turn
    //    (head-retention): deltas stream the item content in order and the
    //    Agent Turn Output JSON is the head of the final item's content, so
    //    dropping tail content never weakens extraction of the supported flow;
    //    a document that does not fit the bound fails loudly at extraction.
    let totalCollectedChars = 0;
    const collected = new Map<string, CollectedItemText>();
    const activity = new TurnActivityTracker();
    const unsubscribe = this.client.onNotification((notification) => {
      // Content-free current-turn activity diagnostics (never persisted on
      // success; a failed session note may attach the fixed category summary).
      activity.observeNotification(notification.method, notification.params);
      if (notification.method !== "item/agentMessage/delta") return;
      const params = notification.params;
      if (!isRecord(params)) return;
      if (params.threadId !== threadId) return;
      if (typeof params.itemId !== "string" || typeof params.delta !== "string") return;
      if (typeof params.turnId !== "string") return;
      const delta = params.delta;
      if (delta.length === 0) return;
      let entry = collected.get(params.itemId);
      if (entry === undefined) {
        if (collected.size >= MAX_COLLECTED_ITEMS) return; // item cap: drop, fail loud at extraction
        entry = { turnId: params.turnId, parts: [], chars: 0 };
        collected.set(params.itemId, entry);
      }
      const room = Math.min(
        this.maxItemChars - entry.chars,
        this.maxTotalChars - totalCollectedChars
      );
      if (room <= 0) return; // item/turn char cap: drop, fail loud at extraction
      const kept = delta.length <= room ? delta : delta.slice(0, room);
      entry.parts.push(kept);
      entry.chars += kept.length;
      totalCollectedChars += kept.length;
      // Bound the parts-array overhead of many tiny deltas: join occasionally.
      if (entry.parts.length >= MAX_COLLECTED_ITEM_PARTS) {
        entry.parts = [entry.parts.join("")];
      }
    });
    // Content-free inbound server-request observer: an incoming approval /
    // other server request fails the connection closed (the fail-closed
    // client), so the adapter only records a fixed `approval-request` category
    // — the method name and its params never enter the tracker or any
    // persisted record.
    const unsubscribeServerRequest = this.client.onServerRequest(() => {
      activity.observeServerRequest();
    });
    let turnId: string;
    try {
      let turnParams: Record<string, unknown>;
      try {
        turnParams = buildTurnStartParams({
          threadId,
          promptText: input.promptText,
          localImageAbsolutePath: input.localImageAbsolutePath,
          skill: input.skill,
          writableRoots: [workspaceRoot]
        });
      } catch (error) {
        const failure =
          error instanceof InvalidArgumentError
            ? new AgentTurnError(
                "AGENT_PROTOCOL_INCOMPATIBLE",
                `the turn input is incomplete: ${error.message}`
              )
            : error;
        failStartedSession(
          workspace,
          input,
          session,
          turnStartFailureSessionNote(error),
          failure
        );
      }
      let started: Awaited<ReturnType<CodexAppServerClient["turnStart"]>>;
      try {
        started = await this.client.turnStart(turnParams);
      } catch (error) {
        failStartedSession(
          workspace,
          input,
          session,
          turnStartFailureSessionNote(error),
          this.mapClientError(error)
        );
      }
      turnId = started.turn.id;
      this.currentTurn = { runId, attemptId, threadId, turnId };
      activity.setCurrentTurn(threadId, turnId);
      session = withAgentSessionStatus(session, {
        status: "in_progress",
        turnId,
        nowIso
      });
      writeAgentSessionRecord(workspace, { runId, attemptSequence, record: session });

      // 5. Consume notifications until turn/completed; agentMessage deltas are
      //    collected (content) but NEVER surface in the product records.
      let completed: CodexTurnCompleted;
      try {
        completed = await this.client.waitForTurnCompleted({
          threadId,
          turnId,
          timeoutMs: this.turnTimeoutMs
        });
      } catch (error) {
        // A TIMEOUT is NOT just reported: the server-side turn may still be
        // running, so the EXACT current threadId/turnId is interrupted and a
        // SHORT BOUNDED grace awaits the matching turn/completed. Only a
        // confirmed terminal completion (interrupted / completed / failed)
        // keeps the client reusable; any other outcome poisons it before the
        // ORIGINAL AGENT_TIMEOUT propagates. Non-timeout wait failures keep
        // their existing behavior (no interrupt, no poison).
        const interruptOutcome =
          error instanceof CodexClientError && error.code === "TIMEOUT"
            ? await this.recoverTimedOutTurn(threadId, turnId)
            : undefined;
        // The session was already written in_progress with a turnId: the
        // technical record MUST end failed before the typed failure
        // propagates — stable generic note (plus the safe interrupt outcome
        // category on timeout and the fixed current-turn activity category
        // summary), never the client error text or raw content.
        failStartedSession(
          workspace,
          input,
          session,
          turnWaitFailureSessionNote(
            error,
            collected,
            turnId,
            activity.summary(),
            interruptOutcome
          ),
          this.mapClientError(error)
        );
      }

      // 6. Terminal turn status handling (never a product terminal event).
      if (completed.turn.status === "interrupted") {
        session = withAgentSessionStatus(session, { status: "interrupted", nowIso });
        writeAgentSessionRecord(workspace, { runId, attemptSequence, record: session });
        throw new AgentTurnError(
          "AGENT_INTERRUPTED",
          "the Codex turn was interrupted before producing a result"
        );
      }
      if (completed.turn.status === "failed") {
        // The technical session record carries a sanitized, bounded digest of
        // the server's error message (never the raw text — it can embed host
        // paths / URLs / credential-like fragments). The product-facing
        // failure stays generic: the typed error below keeps its fixed
        // message and AGENT_RUNTIME_UNAVAILABLE code.
        session = withAgentSessionStatus(session, {
          status: "failed",
          nowIso,
          note: `Codex turn failed: ${sanitizeCodexTurnErrorMessage(completed.turn.errorMessage)}`
        });
        writeAgentSessionRecord(workspace, { runId, attemptSequence, record: session });
        throw new AgentTurnError(
          "AGENT_RUNTIME_UNAVAILABLE",
          "the Codex turn failed before producing a result",
          sanitizeCodexTurnErrorMessage(completed.turn.errorMessage)
        );
      }

      // 7. Extract the schema-valid Agent Turn Output document: EVERY
      //    collected item buffer is scanned (not only the last item — deltas
      //    of earlier items may also carry JSON fragments) and EXACTLY ONE
      //    DISTINCT document must be found — semantically identical duplicates
      //    (the same canonical validated terminal document) fold into one,
      //    while none or multiple DISTINCT documents are ambiguous and
      //    rejected. The terminal state is then dispatched:
      //    - completed: the embedded Result Manifest v1 is written to the
      //      attempt output workspace — the independent validator decides
      //      whether the claim holds — and the success raw records end
      //      `turn_completed` then `result_manifest`;
      //    - clarification_required: NO manifest is written, the runtime raw
      //      records (metadata + turn) are returned WITH the strictly
      //      validated question set and the session is recorded truthfully.
      const turnDeltas = new Map<string, string[]>();
      for (const [itemId, entry] of collected) {
        if (entry.turnId === turnId) turnDeltas.set(itemId, entry.parts);
      }
      let output: ReturnType<typeof validateCodexAgentTurnOutputWire>;
      try {
        output = extractAgentTurnOutput(turnDeltas);
      } catch (error) {
        // The session was already written in_progress with a turnId: the
        // technical record MUST end failed before the typed
        // AGENT_PROTOCOL_INCOMPATIBLE failure propagates — stable generic
        // note, never raw agent content / raw JSON.
        failStartedSession(
          workspace,
          input,
          session,
          error instanceof AgentTurnOutputExtractionError
            ? `${SESSION_FAILED_NOTE_PREFIX}${SESSION_FAILED_NOTE_OUTPUT_EXTRACTION}: ${error.diagnostic}`
            : SESSION_FAILED_NOTE_OUTPUT_EXTRACTION,
          error
        );
      }
      if (output.result === "completed") {
        const manifest = output.completed;
        workspace.writeOwnedFile({
          runId,
          attemptSequence,
          relativePath: RESULT_MANIFEST_FILE_RELATIVE_PATH,
          content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")
        });
        session = withAgentSessionStatus(session, {
          status: "completed",
          manifestRef: RESULT_MANIFEST_FILE_RELATIVE_PATH,
          nowIso
        });
        writeAgentSessionRecord(workspace, { runId, attemptSequence, record: session });

        // 8a. The technical raw records of a COMPLETED result turn,
        //     translator-compatible order ending turn_completed then
        //     result_manifest. Reasoning deltas / raw content never appear
        //     here.
        const occurredAt = nowIso();
        const records: readonly RawAgentRecord[] = [
          {
            recordVersion: RAW_AGENT_RECORDS_VERSION,
            type: "metadata_updated",
            occurredAt,
            threadId,
            adapterId: this.adapterId,
            adapterVersion: this.adapterVersion,
            protocol: this.protocol,
            protocolVersion: this.protocolVersion,
            modelSupportsImageInput: this.modelSupportsImageInput,
            ...(resumedFromThreadId === undefined ? {} : { resumedFromThreadId })
          },
          {
            recordVersion: RAW_AGENT_RECORDS_VERSION,
            type: "turn_completed",
            occurredAt,
            threadId,
            turnId,
            summary: "codex-app-server 0.147.0 result turn (technical only)"
          },
          {
            recordVersion: RAW_AGENT_RECORDS_VERSION,
            type: "result_manifest",
            occurredAt,
            threadId,
            manifestRef: RESULT_MANIFEST_FILE_RELATIVE_PATH
          }
        ];
        // Technical-only raw log (path-contained; never a product event).
        workspace.writeOwnedFile({
          runId,
          attemptSequence,
          relativePath: RAW_AGENT_LOG_RELATIVE_PATH,
          content: Buffer.from(
            records.map((record) => JSON.stringify(record)).join("\n") + "\n",
            "utf8"
          )
        });
        this.lastSessionThreadId = threadId;
        return { kind: "completed", records };
      }
      // clarification_required terminal state: the turn completed WITHOUT a
      // manifest claim. Session recorded truthfully (never failed/interrupted),
      // no manifest file, raw records WITHOUT result_manifest AND WITHOUT
      // clarification_requested — the orchestrator's clarifyAttempt owns the
      // ClarificationRequired product event, so the translator can never
      // duplicate it.
      session = withAgentSessionStatus(session, {
        status: "completed",
        nowIso,
        note: "turn completed with a clarification request; no Result Manifest was claimed"
      });
      writeAgentSessionRecord(workspace, { runId, attemptSequence, record: session });
      const occurredAt = nowIso();
      const records: readonly RawAgentRecord[] = [
        {
          recordVersion: RAW_AGENT_RECORDS_VERSION,
          type: "metadata_updated",
          occurredAt,
          threadId,
          adapterId: this.adapterId,
          adapterVersion: this.adapterVersion,
          protocol: this.protocol,
          protocolVersion: this.protocolVersion,
          modelSupportsImageInput: this.modelSupportsImageInput,
          ...(resumedFromThreadId === undefined ? {} : { resumedFromThreadId })
        },
        {
          recordVersion: RAW_AGENT_RECORDS_VERSION,
          type: "turn_completed",
          occurredAt,
          threadId,
          turnId,
          summary: "codex-app-server 0.147.0 clarification turn (technical only)"
        }
      ];
      // Technical-only raw log (path-contained; never a product event).
      workspace.writeOwnedFile({
        runId,
        attemptSequence,
        relativePath: RAW_AGENT_LOG_RELATIVE_PATH,
        content: Buffer.from(
          records.map((record) => JSON.stringify(record)).join("\n") + "\n",
          "utf8"
        )
      });
      this.lastSessionThreadId = threadId;
      return { kind: "clarification", records, questions: output.questions };
    } finally {
      unsubscribe();
      unsubscribeServerRequest();
      this.currentTurn = null;
    }
  }

  /**
   * Cooperative interruption of the in-flight turn of the claim (executor's
   * running-cancel calls this BEFORE its bounded wait). A DELIVERY FAILURE is
   * meaningful: the interrupt request could not be delivered, so the turn may
   * still be running server-side and the executor must NEVER confirm a
   * cancellation — the failure is rethrown as the typed {@link AgentTurnError}
   * (never swallowed), and the executor's bounded wait stays the safety net
   * for the claim itself.
   */
  async interruptTurn(input: AgentInterruptInput): Promise<void> {
    const turn = this.currentTurn;
    if (turn === null || turn.runId !== input.runId || turn.attemptId !== input.attemptId) {
      return;
    }
    try {
      await this.client.turnInterrupt(
        buildTurnInterruptParams({ threadId: turn.threadId, turnId: turn.turnId })
      );
    } catch (error) {
      throw this.mapClientError(error);
    }
  }

  /**
   * Bounded cleanup of a turn whose wait timed out (the original AGENT_TIMEOUT
   * always propagates afterwards): the server-side turn may still be running,
   * so `turn/interrupt` is sent for the EXACT current threadId/turnId and a
   * SHORT BOUNDED grace awaits the matching `turn/completed` (buffered + live
   * stream — a completion that arrived between the wait timeout and the grace
   * registration is consumed too).
   *
   * Only a confirmed terminal completion (interrupted / completed / failed)
   * settles the turn server-side and keeps the client REUSABLE. An interrupt
   * delivery failure or a grace expiry leaves the server-side turn state
   * UNKNOWN: the client is poisoned (made non-reusable, fail-closed) so a
   * LATE turn/completed of the old turn can never corrupt a later turn on the
   * same thread. Never throws — every outcome is a fixed safe category label.
   */
  private async recoverTimedOutTurn(
    threadId: string,
    turnId: string
  ): Promise<CodexTurnWaitTimeoutInterruptOutcome> {
    try {
      await this.client.turnInterrupt(
        buildTurnInterruptParams({ threadId, turnId })
      );
    } catch {
      // The interrupt could not be delivered: the turn may still be running
      // server-side and the connection state is ambiguous — never reusable.
      this.poisonClientForTurnTimeout();
      return "request-failed";
    }
    try {
      const completed = await this.client.waitForTurnCompleted({
        threadId,
        turnId,
        timeoutMs: this.interruptGraceTimeoutMs
      });
      return completed.turn.status === "interrupted"
        ? "confirmed-interrupted"
        : completed.turn.status === "failed"
          ? "confirmed-failed"
          : "confirmed-completed";
    } catch {
      // No matching completion within the grace (or the connection failed
      // while waiting): the server-side turn state is unknown — never
      // reusable. The client is already closed in the latter case; the poison
      // is idempotent either way.
      this.poisonClientForTurnTimeout();
      return "grace-timed-out";
    }
  }

  /** Makes the client permanently non-reusable with a fixed safe reason. */
  private poisonClientForTurnTimeout(): void {
    this.client.poison(
      "a turn wait timed out and the interrupt outcome was not confirmed"
    );
  }

  /**
   * Releases the client + its transport (idempotent, Batch C lifecycle seam):
   * a live Codex child process is terminated (bounded, never orphaned) and
   * every pending request / turn wait rejects with CLOSED. Safe once the last
   * turn settled — the executor calls it from its `stop()` after the queue
   * loop settled, so no in-flight turn is disturbed here.
   */
  close(): void {
    this.client.close();
  }

  /** Maps client/protocol failures onto the typed AgentTurnError surface. */
  private mapClientError(error: unknown): unknown {
    if (error instanceof AgentTurnError) return error;
    if (!(error instanceof CodexClientError)) return error;
    switch (error.code) {
      case "TIMEOUT":
        return new AgentTurnError("AGENT_TIMEOUT", `the Codex turn timed out: ${error.message}`);
      case "CHILD_EXIT":
      case "NOT_INITIALIZED":
      case "TRANSPORT":
      case "CLOSED":
        return new AgentTurnError(
          "AGENT_RUNTIME_UNAVAILABLE",
          `the Codex App Server runtime is unavailable: ${error.message}`
        );
      case "PROTOCOL":
      case "RPC_ERROR":
        return new AgentTurnError(
          "AGENT_PROTOCOL_INCOMPATIBLE",
          `the Codex App Server response is incompatible with the used protocol subset: ${error.message}`
        );
    }
  }

  private async requestOrThrow<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw this.mapClientError(error);
    }
  }
}

/**
 * Extracts the schema-valid Agent Turn Output document from the turn's
 * agentMessage items: EVERY collected item buffer (joined deltas) is scanned
 * for a valid Agent Turn Output JSON — not only the last item, because earlier
 * items may carry JSON fragments too and a trailing summary may follow the
 * JSON of the final item. EXACTLY ONE DISTINCT document must be found:
 *
 * - none found (no item, malformed JSON, contract violation everywhere) and
 * - more than one item carrying a DIFFERENT valid document (ambiguous)
 *
 * are both AGENT_PROTOCOL_INCOMPATIBLE turn failures — the raw content never
 * surfaces. Semantically IDENTICAL duplicate documents (the same canonical
 * validated terminal output, compared by deep equivalence) are FOLDED into
 * one: a repeated/echoed statement of the SAME terminal result is not
 * ambiguity, so a real HIL turn that emits the document more than once is not
 * rejected. A document is accepted only through the strict PROVIDER-WIRE pass
 * `validateCodexAgentTurnOutputWire` (unknown/missing fields, nullable
 * sentinels, contradictory terminal payloads all fail closed), which projects
 * the wire document onto the canonical Agent Turn Output shape via the shared
 * `validateAgentTurnOutput` contract pass. Each item is scanned linearly for
 * balanced JSON objects with string/escape awareness, so prose or a fenced
 * response may precede/follow the document (including prose containing braces)
 * without making the terminal document ambiguous. Two valid documents in the
 * same item are still two terminal documents: they fail closed unless the
 * canonical outputs are deep-equal.
 */
function extractAgentTurnOutput(
  deltas: ReadonlyMap<string, readonly string[]>
): ReturnType<typeof validateCodexAgentTurnOutputWire> {
  if (deltas.size === 0) {
    throw new AgentTurnOutputExtractionError(
      "no-agent-message-items",
      "the turn carried no collected agent message items"
    );
  }

  const outputs: ReturnType<typeof validateCodexAgentTurnOutputWire>[] = [];
  let balancedCandidates = 0;
  let parseableCandidates = 0;
  for (const itemId of deltas.keys()) {
    const buffer = (deltas.get(itemId) ?? []).join("");
    const extracted = extractAgentTurnOutputs(buffer);
    balancedCandidates += extracted.balancedCandidates;
    parseableCandidates += extracted.parseableCandidates;
    outputs.push(...extracted.outputs);
  }
  if (outputs.length === 0) {
    const diagnostic: AgentTurnOutputExtractionDiagnostic =
      balancedCandidates === 0
        ? "no-balanced-json-object"
        : parseableCandidates === 0
          ? "no-parseable-json-object"
          : "no-valid-provider-wire-document";
    throw new AgentTurnOutputExtractionError(
      diagnostic,
      "the agent messages of the turn carry no valid Agent Turn Output JSON"
    );
  }
  // Fold semantically IDENTICAL duplicates into one: the same canonical
  // validated terminal document may legitimately appear more than once (a
  // repeated or echoed statement across items, a redundant copy inside one
  // item) and is NOT ambiguity. Only DISTINCT canonical outputs count; any two
  // genuinely DIFFERENT documents (different terminal states, different
  // manifest claims, different question content) still fail closed below.
  const distinctOutputs: ReturnType<typeof validateCodexAgentTurnOutputWire>[] = [];
  for (const output of outputs) {
    if (!distinctOutputs.some((existing) => canonicalOutputsDeepEqual(existing, output))) {
      distinctOutputs.push(output);
    }
  }
  if (distinctOutputs.length > 1) {
    throw new AgentTurnOutputExtractionError(
      "multiple-valid-provider-wire-documents",
      "multiple DISTINCT Agent Turn Output documents were extracted (ambiguous)"
    );
  }
  return distinctOutputs[0] as ReturnType<typeof validateCodexAgentTurnOutputWire>;
}

/**
 * Deep equality of two canonical (strictly validated) Agent Turn Output
 * documents: object KEY ORDER is not significant, while array order and
 * primitives are. Only canonical validated values reach this comparison, so
 * the recursion is JSON-safe and never sees raw wire content — no raw JSON is
 * recorded, compared verbatim or surfaced.
 */
function canonicalOutputsDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!canonicalOutputsDeepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length) return false;
    for (const key of leftKeys) {
      if (!(key in rightRecord)) return false;
      if (!canonicalOutputsDeepEqual(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Extracts every valid terminal document from ONE item buffer. Balanced object
 * candidates are found with JSON string/escape awareness; invalid brace pairs
 * in surrounding prose are ignored. Only fixed counts leave this function —
 * never raw content — so the caller can persist a safe diagnostic category.
 * Duplicate canonical documents of one buffer are folded by the caller.
 */
function extractAgentTurnOutputs(buffer: string): {
  outputs: ReturnType<typeof validateCodexAgentTurnOutputWire>[];
  balancedCandidates: number;
  parseableCandidates: number;
} {
  const outputs: ReturnType<typeof validateCodexAgentTurnOutputWire>[] = [];
  const candidates = balancedJsonObjectCandidates(stripJsonFence(buffer));
  let parseableCandidates = 0;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
      parseableCandidates += 1;
    } catch {
      continue;
    }
    try {
      outputs.push(validateCodexAgentTurnOutputWire(parsed));
    } catch {
      // parseable, but not a valid provider-wire terminal document
    }
  }
  return {
    outputs,
    balancedCandidates: candidates.length,
    parseableCandidates
  };
}

/** Returns top-level balanced `{...}` candidates without treating braces inside strings as structure. */
function balancedJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start === -1) {
      if (character === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

/** Strips a ```json ... ``` code fence around the message when present. */
function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const newline = trimmed.indexOf("\n");
  if (newline === -1 || !trimmed.endsWith("```")) return trimmed;
  return trimmed.slice(newline + 1, -3).trim();
}
