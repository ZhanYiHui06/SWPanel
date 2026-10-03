import type { Drawing, ModelingFeedback, RevisionFact, StorageSettings } from "@swpanel/domain";
import { HttpTransport, httpIntentKey, type HttpRepositoryOptions } from "../http-transport.js";
export type { HttpRepositoryOptions } from "../http-transport.js";
import type {
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  RevisionDetailView,
  RevisionHistoryView,
  StorageSettingsView
} from "@swpanel/contracts";
import type {
  AddModelingFeedbackInput,
  AddRevisionFactInput,
  AddRevisionInput,
  AddRevisionResult,
  DeleteRevisionInput,
  DeleteRevisionResult,
  DrawingRepository,
  ImportDrawingInput,
  ImportDrawingResult,
  SelectedDrawingFileInput,
  SetCurrentRevisionInput
} from "./drawing-repository.js";
import { DrawingRepositoryError } from "./drawing-repository.js";
import { drawingStatusFromListItem, type DrawingStatusPresentation } from "../drawing-status.js";

export class HttpDrawingRepository implements DrawingRepository {
  readonly mode = "bridge" as const;
  readonly mock = null;
  private readonly transport: HttpTransport;

  constructor(options: HttpRepositoryOptions = {}) {
    this.transport = new HttpTransport(options, DrawingRepositoryError);
  }

  sourceFileUrl(drawingId: string, revisionId: string, download = false): string {
    return `${this.transport.baseUrl}/api/drawings/${encodeURIComponent(drawingId)}/revisions/${encodeURIComponent(revisionId)}/source${download ? "?download=1" : ""}`;
  }

  getDeletionImpact(drawingId: string): Promise<import("@swpanel/contracts").DeletionImpact> { return this.transport.query("drawing.getDeletionImpact", { drawingId }); }
  deleteObject(drawingId: string, confirmationToken: string): Promise<{ deletedId: string; cleanupWarnings: string[] }> { return this.transport.command("drawing.delete", { drawingId, confirmationToken }); }

  listDrawings(): Promise<readonly DrawingListItemView[]> {
    return this.transport.query<{ recentDrawings: readonly DrawingListItemView[] }>("workspace.getDashboard")
      .then((data) => data.recentDrawings ?? []);
  }

  getDrawingDetail(drawingId: string): Promise<DrawingDetailView> {
    return this.transport.query<DrawingDetailView>("drawing.getDetail", { drawingId });
  }

  getDrawingHistory(drawingId: string): Promise<DrawingHistoryView> {
    return this.transport.query<DrawingHistoryView>("drawing.getHistory", { drawingId });
  }

  getRevisionDetail(drawingId: string, revisionId: string): Promise<RevisionDetailView> {
    return this.transport.query<RevisionDetailView>("revision.getDetail", { drawingId, revisionId });
  }

  getRevisionHistory(drawingId: string, revisionId: string): Promise<RevisionHistoryView> {
    return this.transport.query<RevisionHistoryView>("revision.getHistory", { drawingId, revisionId });
  }

  async selectDrawingFile(): Promise<SelectedDrawingFileInput | null> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".pdf,.dwg,.dxf";
      input.hidden = true;
      document.body.append(input);
      let settled = false;
      const cleanup = () => { settled = true; window.removeEventListener("focus", onWindowFocus); input.remove(); };
      // Browsers without the `cancel` event (older Chrome/Safari/Firefox) never
      // tell us the dialog was dismissed: when the window regains focus and no
      // file shows up shortly after (`change` may fire slightly after focus),
      // treat it as cancelled so the caller's "picking" state ends.
      const onWindowFocus = () => {
        setTimeout(() => {
          if (settled || (input.files?.length ?? 0) > 0) return;
          cleanup();
          resolve(null);
        }, 1000);
      };
      window.addEventListener("focus", onWindowFocus);
      input.oncancel = () => { cleanup(); resolve(null); };
      input.onchange = () => {
        const file = input.files?.[0];
        cleanup();
        if (!file) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => {
          if (!(reader.result instanceof ArrayBuffer)) {
            reject(new DrawingRepositoryError("FILE_READ_FAILED", "无法读取所选文件"));
            return;
          }
          const bytes = new Uint8Array(reader.result);
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 32768) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          }
          this.transport.post<SelectedDrawingFileInput>("/api/upload", { fileName: file.name, contentBase64: btoa(binary) }).then(resolve, reject);
        };
        reader.onerror = () => reject(new DrawingRepositoryError("FILE_READ_FAILED", "无法读取所选文件"));
        reader.onabort = () => reject(new DrawingRepositoryError("FILE_READ_FAILED", "所选文件读取被中止"));
        try { reader.readAsArrayBuffer(file); }
        catch { reject(new DrawingRepositoryError("FILE_READ_FAILED", "无法读取所选文件")); }
      };
      try { input.click(); }
      catch { cleanup(); reject(new DrawingRepositoryError("FILE_PICKER_FAILED", "无法打开文件选择器")); }
    });
  }

  async importDrawing(input: ImportDrawingInput): Promise<ImportDrawingResult> {
    const payload = {
      drawingNumber: input.drawingNumber,
      name: input.name,
      selectedFileToken: input.file.token,
      createdAt: input.createdAt ?? new Date().toISOString(),
      createdBy: input.createdBy
    };
    return this.transport.command<ImportDrawingResult>("drawing.create", payload, await httpIntentKey("drawing.create", input.file.token, payload));
  }

  async addRevision(input: AddRevisionInput): Promise<AddRevisionResult> {
    const payload = {
      drawingId: input.drawingId,
      selectedFileToken: input.file.token,
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    return this.transport.command<AddRevisionResult>("drawing.createRevision", payload, await httpIntentKey("drawing.createRevision", input.file.token, payload));
  }

  setCurrentRevision(input: SetCurrentRevisionInput): Promise<Drawing> {
    return this.transport.command("drawing.setCurrentRevision", {
      drawingId: input.drawingId,
      revisionId: input.revisionId,
      updatedAt: input.updatedAt ?? new Date().toISOString()
    });
  }

  async deleteRevision(input: DeleteRevisionInput): Promise<DeleteRevisionResult> {
    return this.transport.command<DeleteRevisionResult>("drawing.deleteRevision", {
      drawingId: input.drawingId,
      revisionId: input.revisionId,
      updatedAt: input.updatedAt ?? new Date().toISOString()
    });
  }

  async addRevisionFact(input: AddRevisionFactInput): Promise<RevisionFact> {
    const { clientIntentId, ...fields } = input;
    const payload = { ...fields, createdAt: input.createdAt ?? new Date().toISOString() };
    return this.transport.command("drawing.addRevisionFact", payload, await httpIntentKey("drawing.addRevisionFact", clientIntentId, payload));
  }

  async addModelingFeedback(input: AddModelingFeedbackInput): Promise<ModelingFeedback> {
    const { clientIntentId, ...fields } = input;
    const payload = { ...fields, createdAt: input.createdAt ?? new Date().toISOString() };
    return this.transport.command("drawing.addModelingFeedback", payload, await httpIntentKey("drawing.addModelingFeedback", clientIntentId, payload));
  }

  getStorageSettings(): Promise<StorageSettingsView> {
    return this.transport.query<StorageSettingsView>("storage.getSettings");
  }

  async updateStorageSettings(settings: StorageSettings): Promise<StorageSettingsView> {
    return this.transport.command<StorageSettingsView>("storage.updateSettings", { settings });
  }

  resolveDrawingParam(param: string | undefined): string | null {
    return param ? param : null;
  }

  resolveRevisionParam(drawingId: string | null, param: string | undefined): string | null {
    if (drawingId === null || !param) return null;
    return param;
  }

  drawingBusinessStatus(item: DrawingListItemView): DrawingStatusPresentation {
    return drawingStatusFromListItem(item);
  }
}
