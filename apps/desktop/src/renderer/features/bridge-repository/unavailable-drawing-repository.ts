/**
 * Error-state DrawingRepository for a product renderer WITHOUT the Electron
 * bridge (`window.swpanel` missing outside development). Every operation fails
 * with a truthful structured error so the Drawing-management pages render an
 * explicit error state with retry — the product runtime never silently shows
 * Phase 1 fixture data.
 */

import type { Drawing, ModelingFeedback, RevisionFact } from "@swpanel/domain";
import type {
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  RevisionDetailView,
  RevisionHistoryView,
  StorageSettingsView
} from "@swpanel/contracts";
import { drawingStatusFromListItem } from "../drawing-status.js";
import type { DrawingStatusPresentation } from "../drawing-status.js";
import {
  DrawingRepositoryError,
  type AddRevisionResult,
  type DrawingRepository,
  type ImportDrawingResult,
  type SelectedDrawingFileInput
} from "./drawing-repository.js";

const UNAVAILABLE_ERROR = new DrawingRepositoryError(
  "RUNNER_UNAVAILABLE",
  "SWPanel 桌面桥接不可用：请通过 Electron 桌面应用启动，并确认图纸处理服务（Runner）已就绪。"
);

export class UnavailableDrawingRepository implements DrawingRepository {
  readonly mode = "unavailable" as const;
  readonly mock = null;

  listDrawings(): Promise<readonly DrawingListItemView[]> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  getDrawingDetail(): Promise<DrawingDetailView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  getDrawingHistory(): Promise<DrawingHistoryView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  getRevisionDetail(): Promise<RevisionDetailView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  getRevisionHistory(): Promise<RevisionHistoryView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  selectDrawingFile(): Promise<SelectedDrawingFileInput | null> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  importDrawing(): Promise<ImportDrawingResult> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  addRevision(): Promise<AddRevisionResult> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  setCurrentRevision(): Promise<Drawing> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  deleteRevision(): Promise<{ drawing: Drawing; deletedRevisionId: string }> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  addRevisionFact(): Promise<RevisionFact> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  addModelingFeedback(): Promise<ModelingFeedback> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  getStorageSettings(): Promise<StorageSettingsView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  updateStorageSettings(): Promise<StorageSettingsView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  /** Ids pass through so pages render the unavailable error (never fixtures). */
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
