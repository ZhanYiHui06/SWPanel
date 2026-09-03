/**
 * Product-runtime DrawingRepository backed by the real WP5 `window.swpanel`
 * Electron bridge. Every method maps 1:1 onto an allowlisted, typed bridge
 * method and unwraps the `BridgeResult<T>` envelope into data (or a structured
 * `DrawingRepositoryError`). No Node imports, no globals besides the frozen
 * bridge object, no generic channel/path access.
 */

import type { Drawing, ModelingFeedback, RevisionFact, StorageSettings } from "@swpanel/domain";
import type {
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  RevisionDetailView,
  RevisionHistoryView,
  StorageSettingsView
} from "@swpanel/contracts";
import type {
  AddRevisionBridgeResult,
  BridgeResult,
  ImportDrawingBridgeResult,
  SwpanelBridgeApi
} from "../../../main/bridge/bridge-contract.js";
import { drawingStatusFromListItem } from "../drawing-status.js";
import type { DrawingStatusPresentation } from "../drawing-status.js";
import {
  DrawingRepositoryError,
  type AddModelingFeedbackInput,
  type AddRevisionFactInput,
  type AddRevisionInput,
  type AddRevisionResult,
  type DeleteRevisionInput,
  type DeleteRevisionResult,
  type DrawingRepository,
  type ImportDrawingInput,
  type ImportDrawingResult,
  type SelectedDrawingFileInput,
  type SetCurrentRevisionInput
} from "./drawing-repository.js";

function clock(): string {
  return new Date().toISOString();
}

export class BridgeDrawingRepository implements DrawingRepository {
  readonly mode = "bridge" as const;
  readonly mock = null;

  constructor(private readonly api: SwpanelBridgeApi) {}

  /** Unwraps the bridge envelope: data on ok, structured error on failure. */
  private async unwrap<T>(result: Promise<BridgeResult<T>>): Promise<T> {
    const resolved = await result;
    if (resolved.ok) return resolved.data;
    throw new DrawingRepositoryError(resolved.error.code, resolved.error.message);
  }

  listDrawings(): Promise<readonly DrawingListItemView[]> {
    return this.unwrap(this.api.drawings.list());
  }

  getDrawingDetail(drawingId: string): Promise<DrawingDetailView> {
    return this.unwrap(this.api.drawings.getDetail(drawingId));
  }

  getDrawingHistory(drawingId: string): Promise<DrawingHistoryView> {
    return this.unwrap(this.api.drawings.getHistory(drawingId));
  }

  getRevisionDetail(drawingId: string, revisionId: string): Promise<RevisionDetailView> {
    return this.unwrap(this.api.drawings.getRevisionDetail(drawingId, revisionId));
  }

  getRevisionHistory(drawingId: string, revisionId: string): Promise<RevisionHistoryView> {
    return this.unwrap(this.api.drawings.getRevisionHistory(drawingId, revisionId));
  }

  async selectDrawingFile(): Promise<SelectedDrawingFileInput | null> {
    const selected = await this.unwrap(this.api.files.selectDrawingFile());
    if (selected.canceled || selected.file === null) return null;
    return selected.file;
  }

  importDrawing(input: ImportDrawingInput): Promise<ImportDrawingResult> {
    return this.unwrap(
      this.api.drawings.importDrawing({
        drawingNumber: input.drawingNumber,
        name: input.name,
        selectedFileToken: input.file.token,
        createdAt: input.createdAt ?? clock(),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy })
      })
    ).then((result: ImportDrawingBridgeResult) => result);
  }

  addRevision(input: AddRevisionInput): Promise<AddRevisionResult> {
    return this.unwrap(
      this.api.drawings.addRevision({
        drawingId: input.drawingId,
        selectedFileToken: input.file.token,
        createdAt: input.createdAt ?? clock()
      })
    ).then((result: AddRevisionBridgeResult) => result);
  }

  setCurrentRevision(input: SetCurrentRevisionInput): Promise<Drawing> {
    return this.unwrap(
      this.api.drawings.setCurrentRevision({
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        updatedAt: input.updatedAt ?? clock()
      })
    );
  }

  deleteRevision(input: DeleteRevisionInput): Promise<DeleteRevisionResult> {
    return this.unwrap(
      this.api.drawings.deleteRevision({
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        updatedAt: input.updatedAt ?? clock()
      })
    );
  }

  addRevisionFact(input: AddRevisionFactInput): Promise<RevisionFact> {
    return this.unwrap(
      this.api.drawings.addRevisionFact({
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        field: input.field,
        value: input.value,
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        source: input.source,
        ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
        createdAt: input.createdAt ?? clock(),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
        clientIntentId: input.clientIntentId
      })
    );
  }

  addModelingFeedback(input: AddModelingFeedbackInput): Promise<ModelingFeedback> {
    return this.unwrap(
      this.api.drawings.addModelingFeedback({
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        content: input.content,
        createdAt: input.createdAt ?? clock(),
        clientIntentId: input.clientIntentId
      })
    );
  }

  getStorageSettings(): Promise<StorageSettingsView> {
    return this.unwrap(this.api.storage.getSettings());
  }

  updateStorageSettings(settings: StorageSettings): Promise<StorageSettingsView> {
    return this.unwrap(this.api.storage.updateSettings({ settings }));
  }

  // Real Runner ids ARE the route segments (UUIDs); no fixture aliases apply.
  resolveDrawingParam(param: string | undefined): string | null {
    return param !== undefined && param.length > 0 ? param : null;
  }

  resolveRevisionParam(drawingId: string | null, param: string | undefined): string | null {
    if (drawingId === null) return null;
    return param !== undefined && param.length > 0 ? param : null;
  }

  drawingBusinessStatus(item: DrawingListItemView): DrawingStatusPresentation {
    return drawingStatusFromListItem(item);
  }
}
