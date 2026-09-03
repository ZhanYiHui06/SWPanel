import { contextBridge, ipcRenderer } from "electron";

import { MAIN_CHANNELS } from "../main/bridge/bridge-contract.js";
import type {
  AddModelingFeedbackBridgeInput,
  AddModelingFeedbackBridgeResult,
  AddRevisionBridgeInput,
  AddRevisionBridgeResult,
  AddRevisionFactBridgeInput,
  AddRevisionFactBridgeResult,
  BridgeResult,
  ClarificationBridgeResult,
  ClarificationSubmitBridgeInput,
  ClarificationSubmitBridgeResult,
  CostDataBridgeResult,
  CostReportCreateBridgeInput,
  CostReportCreateBridgeResult,
  CostReportDeleteBridgeInput,
  CostReportDeleteBridgeResult,
  CostReportDetailBridgeResult,
  DeleteRevisionBridgeInput,
  DeleteRevisionBridgeResult,
  DrawingDetailBridgeResult,
  DrawingHistoryBridgeResult,
  DrawingListBridgeResult,
  ImportDrawingBridgeInput,
  ImportDrawingBridgeResult,
  ModelDetailBridgeResult,
  RecoveryStatusBridgeResult,
  RevisionDetailBridgeResult,
  RevisionHistoryBridgeResult,
  ReviewModelBridgeInput,
  ReviewModelBridgeResult,
  RunCancelBridgeInput,
  RunCancelBridgeResult,
  RunCreateBridgeInput,
  RunCreateBridgeResult,
  RunDeleteBridgeInput,
  RunDeleteBridgeResult,
  RunDetailBridgeResult,
  RunEventsBridgePush,
  RunListBridgeResult,
  RunnerHealthState,
  RunSubscribeBridgeInput,
  SecretsStatusBridgeResult,
  SelectDrawingFileResult,
  SetCurrentRevisionBridgeInput,
  SetCurrentRevisionBridgeResult,
  StorageSettingsBridgeResult,
  SwpanelBridgeApi,
  UpdateStorageSettingsBridgeInput
} from "../main/bridge/bridge-contract.js";

/**
 * WP5 Preload bridge.
 *
 * Exposes a frozen, typed `window.swpanel` with explicit methods backed ONLY by
 * the allowlisted channels in {@link MAIN_CHANNELS} via `ipcRenderer.invoke`.
 * There is no generic `invoke(channel, ...)`, no listener/channel parameter from
 * the Renderer, no `readFile(path)`, no `spawn` and no raw pipe endpoint.
 *
 * The Renderer never receives an absolute source path: file selection returns an
 * opaque one-use token + metadata. Every method resolves a serializable
 * `BridgeResult<T>` discriminated union (typed); Main converts Runner/IpcClient
 * failures into structured, path-redacted bridge errors.
 *
 * The Phase 3 (P3-4) Run surface: `runs.subscribe` attaches an `ipcRenderer`
 * listener on the frozen `runEvents` push channel, tells Main to subscribe
 * (validated), and returns an unsubscribe function that removes the listener
 * and tells Main to release the subscription. Batches received over the push
 * channel are already validated/deduplicated/gap-checked by the Main-side
 * Runner client.
 *
 * This file is bundled (esbuild) into `dist/preload/preload.cjs` so the sandboxed
 * Preload can share the channel constants and types with Main without a
 * `require` of a sibling module (which the sandbox forbids). `electron` stays
 * external so the sandbox resolves the real API.
 */

const metadata = Object.freeze({
  platform: process.platform,
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron
  })
});

/** Invokes exactly one allowlisted channel and returns the typed bridge result. */
function invoke<T>(channel: string, payload: unknown): Promise<BridgeResult<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<BridgeResult<T>>;
}

const health = Object.freeze({
  get: (): Promise<BridgeResult<RunnerHealthState>> =>
    invoke<RunnerHealthState>(MAIN_CHANNELS.health, {})
});

const files = Object.freeze({
  selectDrawingFile: (): Promise<BridgeResult<SelectDrawingFileResult>> =>
    invoke<SelectDrawingFileResult>(MAIN_CHANNELS.selectDrawingFile, {})
});

const drawings = Object.freeze({
  list: (): Promise<BridgeResult<DrawingListBridgeResult>> =>
    invoke<DrawingListBridgeResult>(MAIN_CHANNELS.drawingList, {}),
  getHistory: (
    drawingId: string
  ): Promise<BridgeResult<DrawingHistoryBridgeResult>> =>
    invoke<DrawingHistoryBridgeResult>(MAIN_CHANNELS.drawingHistory, { drawingId }),
  getDetail: (
    drawingId: string
  ): Promise<BridgeResult<DrawingDetailBridgeResult>> =>
    invoke<DrawingDetailBridgeResult>(MAIN_CHANNELS.drawingDetail, { drawingId }),
  getRevisionHistory: (
    drawingId: string,
    revisionId: string
  ): Promise<BridgeResult<RevisionHistoryBridgeResult>> =>
    invoke<RevisionHistoryBridgeResult>(MAIN_CHANNELS.revisionHistory, {
      drawingId,
      revisionId
    }),
  getRevisionDetail: (
    drawingId: string,
    revisionId: string
  ): Promise<BridgeResult<RevisionDetailBridgeResult>> =>
    invoke<RevisionDetailBridgeResult>(MAIN_CHANNELS.revisionDetail, {
      drawingId,
      revisionId
    }),
  importDrawing: (
    input: ImportDrawingBridgeInput
  ): Promise<BridgeResult<ImportDrawingBridgeResult>> =>
    invoke<ImportDrawingBridgeResult>(MAIN_CHANNELS.importDrawing, input),
  addRevision: (
    input: AddRevisionBridgeInput
  ): Promise<BridgeResult<AddRevisionBridgeResult>> =>
    invoke<AddRevisionBridgeResult>(MAIN_CHANNELS.addRevision, input),
  setCurrentRevision: (
    input: SetCurrentRevisionBridgeInput
  ): Promise<BridgeResult<SetCurrentRevisionBridgeResult>> =>
    invoke<SetCurrentRevisionBridgeResult>(MAIN_CHANNELS.setCurrentRevision, input),
  deleteRevision: (
    input: DeleteRevisionBridgeInput
  ): Promise<BridgeResult<DeleteRevisionBridgeResult>> =>
    invoke<DeleteRevisionBridgeResult>(MAIN_CHANNELS.deleteRevision, input),
  addRevisionFact: (
    input: AddRevisionFactBridgeInput
  ): Promise<BridgeResult<AddRevisionFactBridgeResult>> =>
    invoke<AddRevisionFactBridgeResult>(MAIN_CHANNELS.addRevisionFact, input),
  addModelingFeedback: (
    input: AddModelingFeedbackBridgeInput
  ): Promise<BridgeResult<AddModelingFeedbackBridgeResult>> =>
    invoke<AddModelingFeedbackBridgeResult>(MAIN_CHANNELS.addModelingFeedback, input)
});

const storage = Object.freeze({
  getSettings: (): Promise<BridgeResult<StorageSettingsBridgeResult>> =>
    invoke<StorageSettingsBridgeResult>(MAIN_CHANNELS.storageGetSettings, {}),
  updateSettings: (
    input: UpdateStorageSettingsBridgeInput
  ): Promise<BridgeResult<StorageSettingsBridgeResult>> =>
    invoke<StorageSettingsBridgeResult>(MAIN_CHANNELS.updateStorageSettings, input)
});

const runs = Object.freeze({
  list: (): Promise<BridgeResult<RunListBridgeResult>> =>
    invoke<RunListBridgeResult>(MAIN_CHANNELS.runList, {}),
  getDetail: (runId: string): Promise<BridgeResult<RunDetailBridgeResult>> =>
    invoke<RunDetailBridgeResult>(MAIN_CHANNELS.runDetail, { runId }),
  create: (input: RunCreateBridgeInput): Promise<BridgeResult<RunCreateBridgeResult>> =>
    invoke<RunCreateBridgeResult>(MAIN_CHANNELS.runCreate, input),
  cancel: (input: RunCancelBridgeInput): Promise<BridgeResult<RunCancelBridgeResult>> =>
    invoke<RunCancelBridgeResult>(MAIN_CHANNELS.runCancel, input),
  delete: (input: RunDeleteBridgeInput): Promise<BridgeResult<RunDeleteBridgeResult>> =>
    invoke<RunDeleteBridgeResult>(MAIN_CHANNELS.runDelete, input),
  subscribe: (
    input: RunSubscribeBridgeInput,
    onPush: (push: RunEventsBridgePush) => void
  ): (() => void) => {
    // The listener is attached BEFORE Main is asked to subscribe, so a batch
    // pushed immediately (the persisted backlog) is never missed. Pushes for
    // OTHER runs are filtered out here, so concurrent subscriptions stay
    // isolated even though they share the one frozen push channel.
    const listener = (_event: unknown, push: RunEventsBridgePush): void => {
      if (push.runId !== input.runId) return;
      onPush(push);
    };
    ipcRenderer.on(MAIN_CHANNELS.runEvents, listener);
    const unsubscribe = (): void => {
      ipcRenderer.removeListener(MAIN_CHANNELS.runEvents, listener);
      void invoke<{ unsubscribed: true }>(MAIN_CHANNELS.runUnsubscribe, { runId: input.runId });
    };
    // A rejected subscription surfaces DETERMINISTICALLY as a runEventsError
    // push (Main's validated bridge error, or RUNNER_UNAVAILABLE when the
    // invoke itself failed) and the dangling listener is detached — the
    // renderer never waits forever on a subscription Main refused.
    void invoke<{ subscribed: true }>(MAIN_CHANNELS.runSubscribe, input).then(
      (result) => {
        if (result.ok) return;
        unsubscribe();
        onPush({
          kind: "runEventsError",
          runId: input.runId,
          error: { code: result.error.code, message: result.error.message }
        });
      },
      () => {
        unsubscribe();
        onPush({
          kind: "runEventsError",
          runId: input.runId,
          error: { code: "RUNNER_UNAVAILABLE", message: "订阅图纸处理服务的 Run 事件流失败" }
        });
      }
    );
    return unsubscribe;
  }
});

const clarifications = Object.freeze({
  get: (clarificationRequestId: string): Promise<BridgeResult<ClarificationBridgeResult>> =>
    invoke<ClarificationBridgeResult>(MAIN_CHANNELS.clarificationGet, { clarificationRequestId }),
  submit: (
    input: ClarificationSubmitBridgeInput
  ): Promise<BridgeResult<ClarificationSubmitBridgeResult>> =>
    invoke<ClarificationSubmitBridgeResult>(MAIN_CHANNELS.clarificationSubmit, input)
});

/**
 * Model Review surface (Phase 6). `getDetail` resolves the aggregated Model
 * detail; `review` applies an APPROVE / REJECT decision for a PENDING_REVIEW
 * model and resolves the refreshed detail. Both map 1:1 onto the frozen
 * `swpanel:models:*` channels.
 */
const models = Object.freeze({
  getDetail: (modelId: string): Promise<BridgeResult<ModelDetailBridgeResult>> =>
    invoke<ModelDetailBridgeResult>(MAIN_CHANNELS.modelDetail, { modelId }),
  review: (input: ReviewModelBridgeInput): Promise<BridgeResult<ReviewModelBridgeResult>> =>
    invoke<ReviewModelBridgeResult>(MAIN_CHANNELS.modelReview, input)
});

/**
 * Cost Data and Estimation surface (Phase 7). `deleteReport` (Step 3) removes
 * ONE Cost Estimate Report of its owning Revision.
 */
const cost = Object.freeze({
  getEffectiveCostData: (): Promise<BridgeResult<CostDataBridgeResult>> =>
    invoke<CostDataBridgeResult>(MAIN_CHANNELS.costDataGet, {}),
  updateCostData: (snapshot: CostDataBridgeResult): Promise<BridgeResult<CostDataBridgeResult>> =>
    invoke<CostDataBridgeResult>(MAIN_CHANNELS.costDataUpdate, snapshot),
  getReportDetail: (costReportId: string): Promise<BridgeResult<CostReportDetailBridgeResult>> =>
    invoke<CostReportDetailBridgeResult>(MAIN_CHANNELS.costReportDetail, { costReportId }),
  createReport: (input: CostReportCreateBridgeInput): Promise<BridgeResult<CostReportCreateBridgeResult>> =>
    invoke<CostReportCreateBridgeResult>(MAIN_CHANNELS.costReportCreate, input),
  deleteReport: (
    input: CostReportDeleteBridgeInput
  ): Promise<BridgeResult<CostReportDeleteBridgeResult>> =>
    invoke<CostReportDeleteBridgeResult>(MAIN_CHANNELS.costReportDelete, input)
});

/**
 * System surface (Step 3): the latest startup Run-recovery scan summary.
 */
const system = Object.freeze({
  getRecoveryStatus: (): Promise<BridgeResult<RecoveryStatusBridgeResult>> =>
    invoke<RecoveryStatusBridgeResult>(MAIN_CHANNELS.recoveryStatus, {})
});

/**
 * Secrets surface (Step 3): the company-global automation API key is stored at
 * rest by Main's SafeStorage-backed store. Only presence + a masked preview
 * ever cross the bridge — the plaintext key never leaves the Main process.
 */
const secrets = Object.freeze({
  getStatus: (): Promise<BridgeResult<SecretsStatusBridgeResult>> =>
    invoke<SecretsStatusBridgeResult>(MAIN_CHANNELS.secretsGetStatus, {}),
  setApiKey: (apiKey: string): Promise<BridgeResult<SecretsStatusBridgeResult>> =>
    invoke<SecretsStatusBridgeResult>(MAIN_CHANNELS.secretsSetApiKey, { apiKey }),
  clearApiKey: (): Promise<BridgeResult<SecretsStatusBridgeResult>> =>
    invoke<SecretsStatusBridgeResult>(MAIN_CHANNELS.secretsClearApiKey, {})
});

const api: SwpanelBridgeApi = Object.freeze({
  metadata,
  health,
  files,
  drawings,
  storage,
  runs,
  clarifications,
  models,
  cost,
  system,
  secrets
});

contextBridge.exposeInMainWorld("swpanel", api);
