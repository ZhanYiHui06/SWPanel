/**
 * Explicit Mock bridge adapter (WP6).
 *
 * Serves Drawing-management pages from the Phase 1 `MockRepository` in browser
 * dev/tests and canonical scenario tests. This is an EXPLICIT adapter selected
 * by `resolveDrawingRepository` — the product runtime never falls back to it:
 * production without `window.swpanel` resolves to
 * `UnavailableDrawingRepository` (an error state, never fixture data).
 *
 * All methods are asynchronous (resolved on the microtask queue) so the pages
 * exercise exactly the same loading/error/race paths as the real bridge. The
 * file picker is injectable (`pickFile`) so tests can script uploads; the
 * default picker returns a deterministic sample file so dev previews can walk
 * the whole workflow without Electron.
 *
 * Mutations map to the canonical MockRepository commands
 * (`drawing.create`, `drawing.createRevision`, `drawing.setCurrentRevision`,
 * `drawing.addRevisionFact`, `drawing.addModelingFeedback`,
 * `storage.updateSettings`). None of them creates a Modeling Run —
 * `run.create` is never invoked from the Drawing-management workflow.
 */

import type { Drawing, DrawingRevision, ModelingFeedback, RevisionFact, StorageSettings } from "@swpanel/domain";
import { DomainInvariantError } from "@swpanel/domain";
import type {
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  RevisionDetailView,
  RevisionHistoryView,
  StorageSettingsView
} from "@swpanel/contracts";

import { mockSha256, type MockScenario } from "../../fixtures/index.js";
import { resolveDrawingId, resolveRevisionId } from "../ids.js";
import type { MockRepository } from "../mock-repository/mock-repository.js";
import { MockRepository as MockRepositoryClass } from "../mock-repository/mock-repository.js";
import {
  listDrawingItems,
  mockDrawingBusinessStatus
} from "../drawing-status.js";
import type { DrawingStatusPresentation } from "../drawing-status.js";
import {
  DrawingRepositoryError,
  toDrawingRepositoryError,
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

/** Deterministic sample file for dev previews without an injected picker. */
function defaultMockPicker(): SelectedDrawingFileInput {
  return {
    token: `mock-token-${mockSha256("default-picker")}`,
    fileName: "PDJF001.01.pdf",
    format: "PDF",
    sizeBytes: 1_234_567,
    sha256: mockSha256("default-picker")
  };
}

/** Maps MockRepository invariant failures into structured repository errors. */
function mapFailure(error: unknown): never {
  if (error instanceof DomainInvariantError) {
    throw new DrawingRepositoryError("INVALID_INPUT", error.message);
  }
  throw toDrawingRepositoryError(error);
}

export class MockBridgeDrawingRepository implements DrawingRepository {
  readonly mode = "mock" as const;
  readonly mock: MockRepository;
  private readonly picker: () => SelectedDrawingFileInput | null | Promise<SelectedDrawingFileInput | null>;

  constructor(
    mockRepository: MockRepository,
    options: { pickFile?: () => SelectedDrawingFileInput | null | Promise<SelectedDrawingFileInput | null> } = {}
  ) {
    this.mock = mockRepository;
    this.picker = options.pickFile ?? defaultMockPicker;
  }

  /** Adapter seeded from a canonical scenario (explicit, not a fallback). */
  static create(
    scenario: MockScenario,
    options: { pickFile?: () => SelectedDrawingFileInput | null | Promise<SelectedDrawingFileInput | null> } = {}
  ): MockBridgeDrawingRepository {
    return new MockBridgeDrawingRepository(MockRepositoryClass.create(scenario), options);
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  listDrawings(): Promise<readonly DrawingListItemView[]> {
    return Promise.resolve(listDrawingItems(this.mock));
  }

  getDrawingDetail(drawingId: string): Promise<DrawingDetailView> {
    try {
      return Promise.resolve(this.mock.getDrawingDetail(drawingId));
    } catch (error) {
      return Promise.reject(toDrawingRepositoryError(error));
    }
  }

  getDrawingHistory(drawingId: string): Promise<DrawingHistoryView> {
    try {
      return Promise.resolve(this.mock.getDrawingHistory(drawingId));
    } catch (error) {
      return Promise.reject(toDrawingRepositoryError(error));
    }
  }

  getRevisionDetail(drawingId: string, revisionId: string): Promise<RevisionDetailView> {
    try {
      return Promise.resolve(this.mock.getRevisionDetail(drawingId, revisionId));
    } catch (error) {
      return Promise.reject(toDrawingRepositoryError(error));
    }
  }

  getRevisionHistory(drawingId: string, revisionId: string): Promise<RevisionHistoryView> {
    try {
      return Promise.resolve(this.mock.getRevisionHistory(drawingId, revisionId));
    } catch (error) {
      return Promise.reject(toDrawingRepositoryError(error));
    }
  }

  // ── Commands (pure Drawing workflow; never create a Run) ─────────────────

  async selectDrawingFile(): Promise<SelectedDrawingFileInput | null> {
    return this.picker();
  }

  importDrawing(input: ImportDrawingInput): Promise<ImportDrawingResult> {
    try {
      const result = this.mock.createDrawing({
        drawingNumber: input.drawingNumber,
        name: input.name,
        sourceFile: {
          fileName: input.file.fileName,
          format: input.file.format,
          sizeBytes: input.file.sizeBytes,
          sha256: input.file.sha256
        },
        createdAt: input.createdAt ?? clock(),
        ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy })
      });
      return Promise.resolve({
        drawing: result.drawing,
        revision: result.revision,
        sourceFile: result.revision.sourceFile
      });
    } catch (error) {
      mapFailure(error);
    }
  }

  addRevision(input: AddRevisionInput): Promise<AddRevisionResult> {
    try {
      const revision: DrawingRevision = this.mock.createRevision({
        drawingId: input.drawingId,
        sourceFile: {
          fileName: input.file.fileName,
          format: input.file.format,
          sizeBytes: input.file.sizeBytes,
          sha256: input.file.sha256
        },
        createdAt: input.createdAt ?? clock()
      });
      return Promise.resolve({ revision, sourceFile: revision.sourceFile });
    } catch (error) {
      mapFailure(error);
    }
  }

  setCurrentRevision(input: SetCurrentRevisionInput): Promise<Drawing> {
    try {
      return Promise.resolve(
        this.mock.setCurrentRevision({
          drawingId: input.drawingId,
          revisionId: input.revisionId,
          updatedAt: input.updatedAt ?? clock()
        })
      );
    } catch (error) {
      mapFailure(error);
    }
  }

  deleteRevision(input: DeleteRevisionInput): Promise<DeleteRevisionResult> {
    try {
      const drawing = this.mock.deleteRevision({
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        updatedAt: input.updatedAt ?? clock()
      });
      return Promise.resolve({ drawing, deletedRevisionId: input.revisionId });
    } catch (error) {
      mapFailure(error);
    }
  }

  addRevisionFact(input: AddRevisionFactInput): Promise<RevisionFact> {
    try {
      return Promise.resolve(
        this.mock.createRevisionFact({
          drawingId: input.drawingId,
          revisionId: input.revisionId,
          field: input.field,
          value: input.value,
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          source: input.source,
          ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
          createdAt: input.createdAt ?? clock(),
          ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy })
        })
      );
    } catch (error) {
      mapFailure(error);
    }
  }

  addModelingFeedback(input: AddModelingFeedbackInput): Promise<ModelingFeedback> {
    try {
      const createdAt = input.createdAt ?? clock();
      this.mock.createModelingFeedback({
        drawingId: input.drawingId,
        revisionId: input.revisionId,
        content: input.content,
        createdAt
      });
      // The mock command returns void; mirror the bridge result shape so the
      // pages have a deterministic return value (identity not used by pages).
      return Promise.resolve({
        id: `feedback-${input.revisionId}-${createdAt}`,
        revisionId: input.revisionId,
        content: input.content,
        source: "USER_SUPPLEMENT",
        createdAt
      });
    } catch (error) {
      mapFailure(error);
    }
  }

  // ── Storage settings ─────────────────────────────────────────────────────

  getStorageSettings(): Promise<StorageSettingsView> {
    return Promise.resolve(this.mock.getStorageSettings());
  }

  updateStorageSettings(settings: StorageSettings): Promise<StorageSettingsView> {
    try {
      this.mock.updateStorageSettings(settings);
      return Promise.resolve({ settings });
    } catch (error) {
      mapFailure(error);
    }
  }

  // ── Route params: fixture aliases (drawing-main, revision-v3, ...) ───────

  resolveDrawingParam(param: string | undefined): string | null {
    return resolveDrawingId(this.mock, param);
  }

  resolveRevisionParam(drawingId: string | null, param: string | undefined): string | null {
    return resolveRevisionId(this.mock, drawingId, param);
  }

  drawingBusinessStatus(item: DrawingListItemView): DrawingStatusPresentation {
    return mockDrawingBusinessStatus(this.mock, item);
  }
}
