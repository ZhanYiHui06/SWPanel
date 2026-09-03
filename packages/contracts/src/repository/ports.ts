import type {
  Artifact,
  ClarificationRequest,
  CostDataSnapshot,
  CostEstimateReport,
  Drawing,
  DrawingRevision,
  ModelingFeedback,
  ModelingRun,
  ModelReview,
  Model,
  RevisionFact,
  RunEvent,
  StorageSettings
} from "@swpanel/domain";
import type {
  ClarificationView,
  CostReportDetailView,
  DrawingDetailView,
  DrawingHistoryView,
  ModelDetailView,
  RevisionDetailView,
  RevisionHistoryView,
  RunDetailView,
  StorageSettingsView,
  WorkspaceDashboardView
} from "../queries.js";

/**
 * Read-only aggregate queries. In Phase 1 these are served by the in-memory
 * Mock Repository; later they are served over Runner IPC. Consumers never touch
 * persistence details.
 */
export interface RepositoryReader {
  getDrawingDetail(drawingId: string): DrawingDetailView;
  getDrawingHistory(drawingId: string): DrawingHistoryView;
  getRevisionDetail(drawingId: string, revisionId: string): RevisionDetailView;
  getRevisionHistory(drawingId: string, revisionId: string): RevisionHistoryView;
  getRunDetail(runId: string): RunDetailView;
  getModelDetail(modelId: string): ModelDetailView;
  getClarification(clarificationRequestId: string): ClarificationView;
  getCostReportDetail(costReportId: string): CostReportDetailView;
  getWorkspaceDashboard(): WorkspaceDashboardView;
  getEffectiveCostData(): CostDataSnapshot;
  getStorageSettings(): StorageSettingsView;
}

/**
 * Low-level persistence primitives for the future SQLite-backed store owned by
 * the Agent Runner. These are intentionally shape-level so a real store can
 * implement them without leaking SQL.
 */
export interface RepositoryWriter {
  saveDrawing(drawing: Drawing): void;
  saveRevision(revision: DrawingRevision): void;
  saveRun(run: ModelingRun): void;
  appendRunEvent(event: RunEvent): void;
  saveClarification(request: ClarificationRequest): void;
  saveModel(model: Model): void;
  saveModelReview(review: ModelReview): void;
  addRevisionFact(fact: RevisionFact): void;
  addModelingFeedback(feedback: ModelingFeedback): void;
  saveArtifact(artifact: Artifact): void;
  saveCostEstimateReport(report: CostEstimateReport): void;
  saveCostDataSnapshot(snapshot: CostDataSnapshot): void;
  saveStorageSettings(settings: StorageSettings): void;
}
