/**
 * Main-side Electron IPC allowlist (WP5).
 *
 * Registers EXACTLY the channels declared in {@link MAIN_CHANNELS}: health,
 * drawing-file selection, drawing list/history/detail, revision history/detail,
 * storage settings, the drawing workflow commands, the Phase 3 (P3-4) Run /
 * Clarification surface (run list/detail/create/cancel/subscribe/unsubscribe,
 * clarification get/submit), the Phase 6 model / Phase 7 cost surfaces, the
 * Step 3 deletion + system surface (run.delete, costReport.delete,
 * system.getRecoveryStatus) and the Step 3 SafeStorage-backed secrets channels
 * (presence + masked status only — the plaintext API key never crosses the
 * bridge), plus the single Main -> Renderer `runEvents` push channel. There is
 * no generic `invoke(channel, ...)` endpoint, no `readFile(path)`, no `spawn`
 * and no raw pipe access. Every payload is re-validated before it becomes a
 * Runner query/command/subscription, and every failure is converted to a
 * serializable, path-redacted {@link BridgeResult}. `dialog.showOpenDialog` is
 * the only way the Renderer can select a source file.
 */

import { createHash, randomUUID } from "node:crypto";

import type {
  CreateDrawingCommand,
  CreateRevisionCommand,
  Command,
  DrawingListItemView,
  IpcResponseEnvelope
} from "@swpanel/contracts";
import { IpcClientError } from "../ipc-client/index.js";

import {
  MAIN_CHANNELS,
  bridgeErr,
  bridgeOk,
  redactPaths,
  validateAddModelingFeedback,
  validateAddRevision,
  validateAddRevisionFact,
  validateClarificationRequestId,
  validateClarificationSubmit,
  validateCostDataUpdate,
  validateCostReportCreate,
  validateCostReportDelete,
  validateCostReportId,
  validateDeleteRevision,
  validateDrawingId,
  validateEmptyPayload,
  validateImportDrawing,
  validateModelDetailId,
  validateRevisionIds,
  validateReviewModel,
  validateRunCancel,
  validateRunCreate,
  validateRunDelete,
  validateRunDetailId,
  validateRunSubscribe,
  validateRunUnsubscribe,
  validateSetApiKey,
  validateSetCurrentRevision,
  validateUpdateStorageSettings,
  type BridgeError,
  type BridgeResult,
  type MainChannel,
  type RunEventsBridgePush
} from "../bridge/bridge-contract.js";
import type { DrawingFilePicker } from "../files/file-selection.js";
import type { SelectedFileRegistry, StagedSourceFile } from "../files/selected-file-registry.js";
import type { RunnerHost } from "../runner-host/runner-host.js";
import type { SecretApiKeyStatus } from "../secrets/secret-store.js";

/** The `ipcMain` surface Main registers against (injectable for tests). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** The sender surface a handler needs: id, push channel, destroy cleanup. */
export interface MainIpcSender {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): void;
  isDestroyed(): boolean;
}

export interface MainIpcDependencies {
  host: Pick<
    RunnerHost,
    "health" | "registerSourceFile" | "runQuery" | "runCommand" | "subscribeRunEvents"
  >;
  picker: Pick<DrawingFilePicker, "select">;
  registry: Pick<SelectedFileRegistry, "reserve" | "commit" | "release">;
  /**
   * The SafeStorage-backed Desktop Main secret store. `getApiKey` is deliberately
   * NOT part of the IPC surface: the plaintext key stays Main-internal, and the
   * bridge only ever resolves presence + masked status.
   */
  secrets: MainSecretsStore;
}

/** The store surface Main handlers need (structural DI seam for tests). */
export interface MainSecretsStore {
  setApiKey(apiKey: string): Promise<void>;
  getApiKeyStatus(): Promise<SecretApiKeyStatus>;
  clearApiKey(): Promise<void>;
}

interface MainIpcHandler {
  channel: MainChannel;
  handle(
    event: { sender: MainIpcSender },
    payload: unknown
  ): BridgeResult<unknown> | Promise<BridgeResult<unknown>>;
}

/** Maps a Runner response envelope to a bridge result, redacting paths. */
function envelopeResult(
  response: IpcResponseEnvelope,
  select?: (data: unknown) => unknown
): BridgeResult<unknown> {
  if (response.ok) {
    return bridgeOk(select === undefined ? response.data : select(response.data));
  }
  const error = response.error ?? { code: "RUNNER_ERROR", message: "The Runner failed" };
  return bridgeErr(error.code, redactPaths(error.message));
}

function validationResult(error: unknown): BridgeResult<never> {
  return bridgeErr(
    error instanceof Error && "code" in error && error.code === "INVALID_PAYLOAD"
      ? "INVALID_PAYLOAD"
      : "INTERNAL",
    error instanceof Error ? error.message : "The request payload is invalid"
  );
}

/** Stable, safe message for IPC-client failures (never leaks pipe/paths). */
function ipcClientBridgeError(error: IpcClientError): BridgeError {
  switch (error.code) {
    case "CONNECT_FAILED":
    case "CONNECTION_LOST":
      return { code: "RUNNER_UNAVAILABLE", message: "与图纸处理服务（Runner）的连接不可用" };
    case "REQUEST_TIMEOUT":
      return { code: "RUNNER_UNAVAILABLE", message: "图纸处理服务（Runner）响应超时" };
    case "PROTOCOL_VERSION_MISMATCH":
    case "SERVER_INSTANCE_CHANGED":
    case "INVALID_RESPONSE":
      return { code: "RUNNER_UNAVAILABLE", message: "图纸处理服务（Runner）协议不匹配" };
    default:
      return { code: "RUNNER_UNAVAILABLE", message: "图纸处理服务（Runner）不可用" };
  }
}

function tokenResult(
  reserved: ReturnType<SelectedFileRegistry["reserve"]>
): { ok: true; file: StagedSourceFile } | { ok: false; error: BridgeError } {
  if (reserved.status === "ok" && "file" in reserved) {
    return { ok: true, file: reserved.file };
  }
  if (reserved.status === "expired") {
    return { ok: false, error: { code: "TOKEN_EXPIRED", message: "所选文件已过期，请重新选择" } };
  }
  if (reserved.status === "in_use") {
    return { ok: false, error: { code: "TOKEN_IN_USE", message: "该文件正在被另一个操作使用，请稍候重试" } };
  }
  return { ok: false, error: { code: "TOKEN_NOT_FOUND", message: "所选文件令牌无效或已使用，请重新选择" } };
}

/**
 * Semantic per-intent fields identifying ONE user intent, independent of
 * transport-regenerated timestamps. `drawing.create`/`drawing.createRevision`
 * key on the source file's sha256 (a retry of the same file maps to the same
 * key, a different file is a different intent). Fact/feedback mutations
 * additionally require the Renderer's opaque per-submission `clientIntentId`,
 * so a deliberate second submission of identical content still counts as a
 * separate intent while a retry of the same submission is deduplicated.
 */
type IntentIdempotencySource =
  | { command: "drawing.create"; drawingNumber: string; name: string; fileSha256: string }
  | { command: "drawing.createRevision"; drawingId: string; fileSha256: string }
  | { command: "drawing.setCurrentRevision"; drawingId: string; revisionId: string }
  | { command: "drawing.deleteRevision"; drawingId: string; revisionId: string }
  | {
      command: "drawing.addRevisionFact";
      drawingId: string;
      revisionId: string;
      field: string;
      value: string;
      unit?: string;
      source: string;
      sourceRunId?: string;
      clientIntentId: string;
    }
  | {
      command: "drawing.addModelingFeedback";
      drawingId: string;
      revisionId: string;
      content: string;
      clientIntentId: string;
    }
  | {
      command: "storage.updateSettings";
      dataRoot: string;
      workspaceRoot: string;
      constraint: string;
    }
  | {
      command: "run.create";
      drawingId: string;
      revisionId: string;
    }
  | {
      command: "run.cancel";
      runId: string;
    }
  | {
      command: "run.delete";
      runId: string;
    }
  | {
      command: "costReport.delete";
      costReportId: string;
    }
  | {
      command: "clarification.submit";
      clarificationRequestId: string;
      // Semantic intent: questionId + value ONLY. Answer ids are minted by the
      // Runner, and transport timestamps/answeredBy are excluded so a retry
      // with a fresh timestamp deduplicates while different answers map to a
      // different intent (honestly rejected once the request is ANSWERED).
      answers: readonly { questionId: string; value: unknown }[];
    }
  | {
      command: "model.review";
      modelId: string;
      result: "APPROVED" | "REJECTED";
    };

/**
 * Stable per-intent idempotency key for a retryable mutation. The digest is
 * computed over the semantic intent fields ONLY — transport-generated
 * timestamps (createdAt/updatedAt) are deliberately excluded, so a retry that
 * carries a FRESH requestId and a regenerated timestamp but the same intent
 * still maps to the same key and is answered from the Runner's idempotency
 * cache instead of duplicating the mutation.
 */
function intentIdempotencyKey(source: IntentIdempotencySource): string {
  const digest = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  return `intent:${digest}`;
}

function importSourceFile(file: StagedSourceFile): {
  fileName: string;
  format: "PDF" | "DWG" | "DXF";
  sizeBytes: number;
  sha256: string;
} {
  return {
    fileName: file.fileName,
    format: file.format,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256
  };
}

/**
 * Builds the exact channel -> handler map. The channel keys come from
 * {@link MAIN_CHANNELS}, so registering this map registers precisely the
 * allowlist and nothing else.
 */
export function createMainIpcHandlers(
  deps: MainIpcDependencies
): readonly MainIpcHandler[] {
  // Per-sender subscription registry (Phase 3, P3-4): senderId -> (runId ->
  // unsubscribe). One live subscription per (sender, runId); a re-subscribe
  // replaces the previous one and a destroyed sender cleans all its
  // subscriptions up.
  const subscriptionsBySender = new Map<number, Map<string, () => void>>();

  const registerSubscription = (
    sender: MainIpcSender,
    runId: string,
    unsubscribe: () => void
  ): void => {
    let subscriptions = subscriptionsBySender.get(sender.id);
    if (subscriptions === undefined) {
      subscriptions = new Map();
      subscriptionsBySender.set(sender.id, subscriptions);
      sender.once("destroyed", () => {
        const cleanup = subscriptionsBySender.get(sender.id);
        if (cleanup === undefined) return;
        subscriptionsBySender.delete(sender.id);
        for (const unsub of cleanup.values()) {
          try {
            unsub();
          } catch {
            // best effort
          }
        }
      });
    }
    const existing = subscriptions.get(runId);
    if (existing !== undefined) {
      try {
        existing();
      } catch {
        // best effort
      }
    }
    subscriptions.set(runId, unsubscribe);
  };

  const unregisterSubscription = (sender: MainIpcSender, runId: string): void => {
    const subscriptions = subscriptionsBySender.get(sender.id);
    if (subscriptions === undefined) return;
    const unsubscribe = subscriptions.get(runId);
    if (unsubscribe === undefined) return;
    subscriptions.delete(runId);
    if (subscriptions.size === 0) {
      subscriptionsBySender.delete(sender.id);
    }
    try {
      unsubscribe();
    } catch {
      // best effort
    }
  };

  /** Pushes one validated batch / stream failure to a live sender. */
  const pushRunEvents = (sender: MainIpcSender, push: RunEventsBridgePush): void => {
    if (sender.isDestroyed()) return;
    sender.send(MAIN_CHANNELS.runEvents, push);
  };

  const handlers: MainIpcHandler[] = [
    {
      channel: MAIN_CHANNELS.health,
      handle: () => bridgeOk(deps.host.health)
    },
    {
      channel: MAIN_CHANNELS.selectDrawingFile,
      handle: async (event) => deps.picker.select({ id: event.sender.id })
    },
    {
      channel: MAIN_CHANNELS.drawingList,
      handle: async (_event, payload) => {
        try {
          validateEmptyPayload(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("workspace.getDashboard", {}),
            (data) =>
              (data as { recentDrawings: DrawingListItemView[] }).recentDrawings
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.drawingHistory,
      handle: async (_event, payload) => {
        let drawingId: string;
        try {
          drawingId = validateDrawingId(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("drawing.getHistory", { drawingId }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.drawingDetail,
      handle: async (_event, payload) => {
        let drawingId: string;
        try {
          drawingId = validateDrawingId(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("drawing.getDetail", { drawingId }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.revisionHistory,
      handle: async (_event, payload) => {
        let ids: { drawingId: string; revisionId: string };
        try {
          ids = validateRevisionIds(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("revision.getHistory", ids),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.revisionDetail,
      handle: async (_event, payload) => {
        let ids: { drawingId: string; revisionId: string };
        try {
          ids = validateRevisionIds(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("revision.getDetail", ids),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.storageGetSettings,
      handle: async (_event, payload) => {
        try {
          validateEmptyPayload(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("storage.getSettings", {}),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.importDrawing,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateImportDrawing>;
        try {
          input = validateImportDrawing(payload);
        } catch (error) {
          return validationResult(error);
        }
        // Reserve (do NOT consume) the token: it is only burned on success.
        // A failed command releases the reservation so the user can retry.
        const reserved = tokenResult(deps.registry.reserve(input.selectedFileToken));
        if (!reserved.ok) return reserved;
        const command: CreateDrawingCommand = {
          command: "drawing.create",
          drawingNumber: input.drawingNumber,
          name: input.name,
          sourceFile: importSourceFile(reserved.file),
          createdAt: input.createdAt,
          ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy })
        };
        try {
          const response = await deps.host.runCommand(command, {
            idempotencyKey: intentIdempotencyKey({
              command: "drawing.create",
              drawingNumber: command.drawingNumber,
              name: command.name,
              fileSha256: command.sourceFile.sha256
            })
          });
          if (response.ok) {
            deps.registry.commit(input.selectedFileToken);
          } else {
            // Business failure (e.g. duplicate number): the file was not stored;
            // release so the corrected submission can reuse the pick.
            deps.registry.release(input.selectedFileToken);
          }
          return envelopeResult(response, (data) => data);
        } catch (error) {
          deps.registry.release(input.selectedFileToken);
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.addRevision,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateAddRevision>;
        try {
          input = validateAddRevision(payload);
        } catch (error) {
          return validationResult(error);
        }
        const reserved = tokenResult(deps.registry.reserve(input.selectedFileToken));
        if (!reserved.ok) return reserved;
        const command: CreateRevisionCommand = {
          command: "drawing.createRevision",
          drawingId: input.drawingId,
          sourceFile: importSourceFile(reserved.file),
          createdAt: input.createdAt
        };
        try {
          const response = await deps.host.runCommand(command, {
            idempotencyKey: intentIdempotencyKey({
              command: "drawing.createRevision",
              drawingId: command.drawingId,
              fileSha256: command.sourceFile.sha256
            })
          });
          if (response.ok) {
            deps.registry.commit(input.selectedFileToken);
          } else {
            deps.registry.release(input.selectedFileToken);
          }
          return envelopeResult(response, (data) => data);
        } catch (error) {
          deps.registry.release(input.selectedFileToken);
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.setCurrentRevision,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateSetCurrentRevision>;
        try {
          input = validateSetCurrentRevision(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "drawing.setCurrentRevision",
          drawingId: input.drawingId,
          revisionId: input.revisionId,
          updatedAt: input.updatedAt
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: intentIdempotencyKey({
                command: "drawing.setCurrentRevision",
                drawingId: input.drawingId,
                revisionId: input.revisionId
              })
            })
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.deleteRevision,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateDeleteRevision>;
        try {
          input = validateDeleteRevision(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "drawing.deleteRevision",
          drawingId: input.drawingId,
          revisionId: input.revisionId,
          updatedAt: input.updatedAt
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: intentIdempotencyKey({
                command: "drawing.deleteRevision",
                drawingId: input.drawingId,
                revisionId: input.revisionId
              })
            })
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.addRevisionFact,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateAddRevisionFact>;
        try {
          input = validateAddRevisionFact(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "drawing.addRevisionFact",
          drawingId: input.drawingId,
          revisionId: input.revisionId,
          field: input.field,
          value: input.value,
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          source: input.source,
          ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
          createdAt: input.createdAt,
          ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy })
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: intentIdempotencyKey({
                command: "drawing.addRevisionFact",
                drawingId: input.drawingId,
                revisionId: input.revisionId,
                field: input.field,
                value: input.value,
                ...(input.unit === undefined ? {} : { unit: input.unit }),
                source: input.source,
                ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
                clientIntentId: input.clientIntentId
              })
            })
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.addModelingFeedback,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateAddModelingFeedback>;
        try {
          input = validateAddModelingFeedback(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "drawing.addModelingFeedback",
          drawingId: input.drawingId,
          revisionId: input.revisionId,
          content: input.content,
          createdAt: input.createdAt
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: intentIdempotencyKey({
                command: "drawing.addModelingFeedback",
                drawingId: input.drawingId,
                revisionId: input.revisionId,
                content: input.content,
                clientIntentId: input.clientIntentId
              })
            })
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.updateStorageSettings,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateUpdateStorageSettings>;
        try {
          input = validateUpdateStorageSettings(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "storage.updateSettings",
          settings: input.settings
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: intentIdempotencyKey({
                command: "storage.updateSettings",
                dataRoot: input.settings.dataRoot,
                workspaceRoot: input.settings.workspaceRoot,
                constraint: input.settings.constraint
              })
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.runList,
      handle: async (_event, payload) => {
        try {
          validateEmptyPayload(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(await deps.host.runQuery("run.list", {}), (data) => data);
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.runDetail,
      handle: async (_event, payload) => {
        let runId: string;
        try {
          runId = validateRunDetailId(payload).runId;
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("run.getDetail", { runId }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.runCreate,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateRunCreate>;
        try {
          input = validateRunCreate(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "run.create",
          drawingId: input.drawingId,
          revisionId: input.revisionId
        };
        try {
          // F1 resolution (2026-08-13): run.create uses a MAIN-MINTED unique
          // intent id per user invocation instead of a semantic (drawingId,
          // revisionId) pair key. Each explicit user create is therefore a
          // distinct intent (same-revision re-creates mint R01/R02), while
          // the key stays stable for THIS dispatch and its transport-level
          // retries (a repeated identical envelope with the same key is
          // answered from the Runner idempotency cache). The intent id is
          // opaque transport metadata — it never reaches the Renderer payload
          // (the bridge still validates drawingId/revisionId only) and never
          // appears in the Runner wire command.
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: `run-create:${randomUUID()}`
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.runCancel,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateRunCancel>;
        try {
          input = validateRunCancel(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "run.cancel",
          runId: input.runId,
          ...(input.reason === undefined ? {} : { reason: input.reason })
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              // Keyed on the Run only: the cancel intent is the Run itself, so
              // a retried cancel (fresh reason/timestamp) still deduplicates.
              idempotencyKey: intentIdempotencyKey({ command: "run.cancel", runId: input.runId })
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.runSubscribe,
      handle: (event, payload) => {
        let input: ReturnType<typeof validateRunSubscribe>;
        try {
          input = validateRunSubscribe(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          const sender = event.sender;
          const unsubscribe = deps.host.subscribeRunEvents(
            input.runId,
            {
              onRunEvents: (batch) =>
                pushRunEvents(sender, {
                  kind: "runEvents",
                  runId: batch.runId,
                  fromSequence: batch.fromSequence,
                  events: batch.events
                }),
              onRunEventsError: (error) =>
                pushRunEvents(sender, {
                  kind: "runEventsError",
                  runId: error.runId,
                  error: { code: error.code, message: redactPaths(error.message) }
                })
            },
            { fromSequence: input.fromSequence }
          );
          registerSubscription(sender, input.runId, unsubscribe);
          return bridgeOk({});
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.runUnsubscribe,
      handle: (event, payload) => {
        let input: ReturnType<typeof validateRunUnsubscribe>;
        try {
          input = validateRunUnsubscribe(payload);
        } catch (error) {
          return validationResult(error);
        }
        unregisterSubscription(event.sender, input.runId);
        return bridgeOk({});
      }
    },
    {
      channel: MAIN_CHANNELS.clarificationGet,
      handle: async (_event, payload) => {
        let clarificationRequestId: string;
        try {
          clarificationRequestId = validateClarificationRequestId(payload).clarificationRequestId;
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("clarification.get", { clarificationRequestId }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.clarificationSubmit,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateClarificationSubmit>;
        try {
          input = validateClarificationSubmit(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "clarification.submit",
          clarificationRequestId: input.clarificationRequestId,
          answers: input.answers,
          answeredAt: input.answeredAt,
          answeredBy: input.answeredBy
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: intentIdempotencyKey({
                command: "clarification.submit",
                clarificationRequestId: input.clarificationRequestId,
                answers: input.answers.map((answer) => ({
                  questionId: answer.questionId,
                  value: answer.value
                }))
              })
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.modelDetail,
      handle: async (_event, payload) => {
        let modelId: string;
        try {
          modelId = validateModelDetailId(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("model.getDetail", { modelId }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.modelReview,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateReviewModel>;
        try {
          input = validateReviewModel(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "model.review",
          modelId: input.modelId,
          result: input.result,
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          reviewerId: input.reviewerId,
          reviewedAt: input.reviewedAt
        };
        try {
          // Keyed on the semantic (modelId, result) intent: a transport-level
          // retry of the SAME review decision (fresh reviewedAt) deduplicates,
          // while a separate explicit review decision for the same model is a
          // distinct intent.
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: `model-review:${input.modelId}:${input.result}`
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.costDataGet,
      handle: async (_event, payload) => {
        try {
          validateEmptyPayload(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("costData.get", {}),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.costDataUpdate,
      handle: async (_event, payload) => {
        let snapshot: ReturnType<typeof validateCostDataUpdate>;
        try {
          snapshot = validateCostDataUpdate(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "costData.update",
          snapshot: {
            ...snapshot,
            updatedAt: snapshot.capturedAt
          }
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: `cost-data-update:${snapshot.capturedAt}`
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.costReportDetail,
      handle: async (_event, payload) => {
        let costReportId: string;
        try {
          costReportId = validateCostReportId(payload).costReportId;
        } catch (error) {
          return validationResult(error);
        }
        try {
          return envelopeResult(
            await deps.host.runQuery("costReport.getDetail", { costReportId }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.costReportCreate,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateCostReportCreate>;
        try {
          input = validateCostReportCreate(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "costReport.create",
          input: input.input,
          createdAt: input.createdAt
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: `cost-report-create:${input.input.revisionId}:${input.input.modelId}:${input.createdAt}`
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.runDelete,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateRunDelete>;
        try {
          input = validateRunDelete(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "run.delete",
          runId: input.runId,
          drawingId: input.drawingId,
          revisionId: input.revisionId
        };
        try {
          // Keyed on the Run only: the delete intent IS the Run itself, so a
          // transport-level retry of the same deletion deduplicates (Phase 8
          // guarded terminal-Run deletion with workspace cleanup is idempotent
          // under repeated delivery).
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: intentIdempotencyKey({ command: "run.delete", runId: input.runId })
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.costReportDelete,
      handle: async (_event, payload) => {
        let input: ReturnType<typeof validateCostReportDelete>;
        try {
          input = validateCostReportDelete(payload);
        } catch (error) {
          return validationResult(error);
        }
        const command: Command = {
          command: "costReport.delete",
          costReportId: input.costReportId,
          revisionId: input.revisionId
        };
        try {
          return envelopeResult(
            await deps.host.runCommand(command, {
              idempotencyKey: intentIdempotencyKey({
                command: "costReport.delete",
                costReportId: input.costReportId
              })
            }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.recoveryStatus,
      handle: async (_event, payload) => {
        try {
          validateEmptyPayload(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          // `system.getRecoveryStatus` is a READ command: it deliberately sends
          // NO idempotency key so the Runner never answers it from the replay
          // cache — every poll resolves the CURRENT recovery scan summary.
          return envelopeResult(
            await deps.host.runCommand({ command: "system.getRecoveryStatus" }),
            (data) => data
          );
        } catch (error) {
          return toResultError(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.secretsGetStatus,
      handle: async (_event, payload) => {
        try {
          validateEmptyPayload(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          // Presence + masked preview ONLY: the plaintext API key never leaves
          // the Main process (the bridge contract has no key-returning channel).
          const status = await deps.secrets.getApiKeyStatus();
          return bridgeOk(status);
        } catch (error) {
          return secretsErrorResult(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.secretsSetApiKey,
      handle: async (_event, payload) => {
        let apiKey: string;
        try {
          apiKey = validateSetApiKey(payload).apiKey;
        } catch (error) {
          return validationResult(error);
        }
        try {
          await deps.secrets.setApiKey(apiKey);
          const status = await deps.secrets.getApiKeyStatus();
          return bridgeOk(status);
        } catch (error) {
          return secretsErrorResult(error);
        }
      }
    },
    {
      channel: MAIN_CHANNELS.secretsClearApiKey,
      handle: async (_event, payload) => {
        try {
          validateEmptyPayload(payload);
        } catch (error) {
          return validationResult(error);
        }
        try {
          await deps.secrets.clearApiKey();
          const status = await deps.secrets.getApiKeyStatus();
          return bridgeOk(status);
        } catch (error) {
          return secretsErrorResult(error);
        }
      }
    }
  ];

  return Object.freeze(handlers);
}

/**
 * Maps a SecretStore failure to a sanitized INTERNAL bridge error. Vault
 * corruption and encryption-unavailable failures are deliberately collapsed to
 * one code with a generic message — the Renderer must never see vault internals.
 */
function secretsErrorResult(error: unknown): BridgeResult<never> {
  void error;
  return bridgeErr("INTERNAL", "密钥操作失败，请稍后重试");
}

/**
 * Registers the exact allowlisted channels on `ipcMain`. Each listener returns
 * a serializable {@link BridgeResult}; it never throws across the bridge.
 */
export function installMainIpc(ipcMain: IpcMainLike, deps: MainIpcDependencies): void {
  for (const handler of createMainIpcHandlers(deps)) {
    ipcMain.handle(handler.channel, (event, payload) =>
      Promise.resolve(handler.handle(event as { sender: MainIpcSender }, payload))
    );
  }
}

function toResultError(error: unknown): BridgeResult<never> {
  if (error instanceof IpcClientError) {
    return bridgeErr(ipcClientBridgeError(error).code, ipcClientBridgeError(error).message);
  }
  if (error instanceof Error && "code" in error && error.code === "HOST_NOT_READY") {
    return bridgeErr("RUNNER_NOT_READY", "图纸处理服务（Runner）尚未就绪");
  }
  return bridgeErr("INTERNAL", "请求未能完成");
}
