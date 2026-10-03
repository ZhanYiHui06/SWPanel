/**
 * Phase 2 async Drawing Repository surface (WP6).
 *
 * This is the runtime data contract behind every Drawing-management page
 * (Drawing Library, Drawing Overview, Revision memory/history, storage
 * settings). It is deliberately asynchronous so the SAME pages run against:
 *
 * - the real WP5 `window.swpanel` Electron bridge (`BridgeDrawingRepository`)
 *   in the packaged/desktop product runtime — data comes from the real Runner
 *   (SQLite + drawing file ledger), never from Phase 1 fixtures;
 * - an explicit `MockBridgeDrawingRepository` adapter in browser dev/tests —
 *   this is the ONLY place the Phase 1 `MockRepository` may serve
 *   Drawing-management pages, and it is an explicit, documented adapter, never
 *   a silent product fallback;
 * - `UnavailableDrawingRepository` when the product renderer has no bridge
 *   (an error state, never fixture data).
 *
 * The Phase 1 `MockRepository` remains the data source for the later-phase
 * Run / Model / Cost pages (Workbench, Runs, Models, Cost Data, Cost Report)
 * until their own phases migrate them; see `repository-provider.tsx`.
 *
 * Every method rejects with a `DrawingRepositoryError` carrying the stable
 * bridge error code (e.g. NOT_FOUND, ENTITY_CONFLICT, RUNNER_UNAVAILABLE) and a
 * path-redacted, renderer-safe message. Mutations NEVER create Modeling Runs:
 * `run.create` is not part of this surface and no bridge method here can reach
 * it.
 */

import type { DrawingFileFormat, Drawing, DrawingRevision, ModelingFeedback, RevisionFact, StorageSettings } from "@swpanel/domain";
import type {
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  RevisionDetailView,
  RevisionHistoryView,
  StorageSettingsView
} from "@swpanel/contracts";
import type { SwpanelBridgeApi } from "../../../main/bridge/bridge-contract.js";
import type { MockRepository } from "../mock-repository/mock-repository.js";
import type { DrawingStatusPresentation } from "../drawing-status.js";
import type { BusinessDeletionCapability } from "../deletion/BusinessDeletionDialog.js";

/**
 * Structured repository error. `code` mirrors the stable bridge error codes so
 * pages can branch on business failures (NOT_FOUND, ENTITY_CONFLICT, ...)
 * without parsing prose.
 */
export class DrawingRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DrawingRepositoryError";
    this.code = code;
  }
}

/** Converts any thrown value into a structured repository error. */
export function toDrawingRepositoryError(error: unknown): DrawingRepositoryError {
  if (error instanceof DrawingRepositoryError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return new DrawingRepositoryError((error as { code: string }).code, error.message);
  }
  return new DrawingRepositoryError("UNKNOWN", error instanceof Error ? error.message : String(error));
}

/** True when the error is the structured NOT_FOUND business failure. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof DrawingRepositoryError && error.code === "NOT_FOUND";
}

/** Renderer-visible file picked through the platform file dialog. */
export interface SelectedDrawingFileInput {
  /** One-use token minted by Main (bridge mode) or the mock picker (tests). */
  readonly token: string;
  readonly fileName: string;
  readonly format: DrawingFileFormat;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ImportDrawingInput {
  readonly drawingNumber: string;
  readonly name: string;
  readonly file: SelectedDrawingFileInput;
  readonly createdAt?: string;
  readonly createdBy?: string;
}

export interface AddRevisionInput {
  readonly drawingId: string;
  readonly file: SelectedDrawingFileInput;
  readonly createdAt?: string;
}

export interface SetCurrentRevisionInput {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly updatedAt?: string;
}

export interface DeleteRevisionInput {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly updatedAt?: string;
}

export interface AddRevisionFactInput {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly field: string;
  readonly value: string;
  readonly unit?: string;
  readonly source: RevisionFact["source"];
  readonly sourceRunId?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
  /**
   * Opaque per-form-submission intent id (`swint_` + 32 lowercase hex chars).
   * The submitting dialog mints ONE id per submission and reuses it only when
   * retrying the identical form, so Main can tell a retry (same id) apart from
   * a deliberate duplicate submission of identical content (new id).
   */
  readonly clientIntentId: string;
}

export interface AddModelingFeedbackInput {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly content: string;
  readonly createdAt?: string;
  /** See {@link AddRevisionFactInput.clientIntentId}. */
  readonly clientIntentId: string;
}

/** Import result mirroring the bridge `ImportDrawingBridgeResult` shape. */
export interface ImportDrawingResult {
  readonly drawing: Drawing;
  readonly revision: DrawingRevision;
  readonly sourceFile: DrawingRevision["sourceFile"];
}

export interface AddRevisionResult {
  readonly revision: DrawingRevision;
  readonly sourceFile: DrawingRevision["sourceFile"];
}

export interface DeleteRevisionResult {
  readonly drawing: Drawing;
  readonly deletedRevisionId: string;
}

/**
 * Async data + command surface consumed by Drawing-management pages.
 * Implementations: BridgeDrawingRepository (product), MockBridgeDrawingRepository
 * (explicit dev/test adapter), UnavailableDrawingRepository (error state).
 */
export interface DrawingRepository extends BusinessDeletionCapability {
  /** Which runtime the adapter represents (documented separation). */
  readonly mode: "bridge" | "mock" | "unavailable";
  /**
   * The Phase 1 MockRepository backing this adapter, or null. Mock-only pages
   * and the mock-mode extras (Model card, Run dispatch, source-run labels) use
   * this; product pages must treat null as "not available in this runtime".
   */
  readonly mock: MockRepository | null;

  /** Browser-safe original file endpoint, when supported by this adapter. */
  sourceFileUrl?(drawingId: string, revisionId: string, download?: boolean): string;

  // ── Reads (all bridge-backed in the product runtime) ───────────────────
  listDrawings(): Promise<readonly DrawingListItemView[]>;
  getDrawingDetail(drawingId: string): Promise<DrawingDetailView>;
  getDrawingHistory(drawingId: string): Promise<DrawingHistoryView>;
  getRevisionDetail(drawingId: string, revisionId: string): Promise<RevisionDetailView>;
  getRevisionHistory(drawingId: string, revisionId: string): Promise<RevisionHistoryView>;

  // ── Drawing workflow commands (never create a Run) ─────────────────────
  /** Opens the platform file picker; resolves null when the user cancels. */
  selectDrawingFile(): Promise<SelectedDrawingFileInput | null>;
  importDrawing(input: ImportDrawingInput): Promise<ImportDrawingResult>;
  addRevision(input: AddRevisionInput): Promise<AddRevisionResult>;
  setCurrentRevision(input: SetCurrentRevisionInput): Promise<Drawing>;
  /**
   * Conservative deletion of a NON-current Revision (the current pointer is
   * protected by the Runner). Deleting a whole Drawing is not supported.
   */
  deleteRevision(input: DeleteRevisionInput): Promise<DeleteRevisionResult>;
  addRevisionFact(input: AddRevisionFactInput): Promise<RevisionFact>;
  addModelingFeedback(input: AddModelingFeedbackInput): Promise<ModelingFeedback>;

  // ── Storage settings ────────────────────────────────────────────────────
  getStorageSettings(): Promise<StorageSettingsView>;
  updateStorageSettings(settings: StorageSettings): Promise<StorageSettingsView>;

  // ── Route param resolution (sync) ───────────────────────────────────────
  /** Maps a drawing URL segment to a repository drawing id, or null. */
  resolveDrawingParam(param: string | undefined): string | null;
  /** Maps a revision URL segment to a revision id scoped to `drawingId`, or null. */
  resolveRevisionParam(drawingId: string | null, param: string | undefined): string | null;

  /** Business status presentation for a library row. */
  drawingBusinessStatus(item: DrawingListItemView): DrawingStatusPresentation;
}

/** The exact `window.swpanel` shape the bridge adapter reads (for typing). */
export type SwpanelBridge = SwpanelBridgeApi;
