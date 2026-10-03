import type {
  CostDataSnapshot,
  CostEstimateSnapshot,
  ModelingFeedback,
  RevisionFact,
  RunEvent,
  StorageSettings
} from "@swpanel/domain";

/**
 * Aggregate read snapshots returned by queries. They are meant to be consumed
 * directly by the UI view models and to seed the UI reconnect sequence before
 * subscribing to events after the last known sequence.
 */

export interface DrawingListItemView {
  drawingId: string;
  drawingNumber: string;
  name: string;
  currentRevisionId: string | null;
  currentRevisionLabel: string | null;
  currentApprovedModelId: string | null;
  runStatus: string | null;
  updatedAt: string;
  /** Total number of Revisions of this Drawing (used by the library history list). */
  totalRevisionCount: number;
  /** Label of the newest Revision, or null when the Drawing has none. */
  latestRevisionLabel: string | null;
  /** Whether the current Revision has an OPEN Clarification. */
  hasOpenClarification: boolean;
  /**
   * Whether the current Revision has a Model awaiting human review
   * (PENDING_REVIEW). Optional so existing fixtures and older producers stay
   * valid; absent means "unknown/false".
   */
  hasPendingReview?: boolean;
}

export interface DeletionImpact {
  kind: "drawing" | "model";
  id: string;
  confirmationToken: string;
  canDelete: boolean;
  blockingReason: string | null;
  counts: { revisions: number; runs: number; models: number; reviews: number; costReports: number; artifacts: number; sourceFiles: number };
  clearsCurrentApproved: boolean;
}

export interface RevisionListItemView {
  revisionId: string;
  revisionLabel: string;
  isCurrent: boolean;
  currentApprovedModelId: string | null;
  /** Whether the current approved model of the whole Drawing lives on this Revision. */
  isCurrentApprovedModel: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RunListItemView {
  runId: string;
  runLabel: string;
  status: string;
  stage: string | null;
  createdAt: string;
  modelId: string | null;
  clarificationRequestId: string | null;
  failureCode: string | null;
}

export interface ModelListItemView {
  modelId: string;
  modelLabel: string;
  reviewStatus: string;
  isCurrentApproved: boolean;
  generatedAt: string;
  runId: string;
}

export interface CostReportListItemView {
  costReportId: string;
  label: string;
  quantity: number;
  perPieceCost: number;
  totalCost: number;
  currency: string;
  createdAt: string;
}

export interface DrawingDetailView {
  drawing: {
    drawingId: string;
    drawingNumber: string;
    name: string;
    currentRevisionId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  revisions: readonly RevisionListItemView[];
}

export interface RevisionDetailView {
  revision: {
    revisionId: string;
    revisionLabel: string;
    drawingId: string;
    drawingNumber: string;
    drawingName: string;
    isCurrent: boolean;
    currentApprovedModelId: string | null;
    sourceFile: {
      fileName: string;
      format: string;
      sizeBytes: number;
      uploadedAt: string;
    };
    createdAt: string;
  };
  runs: readonly RunListItemView[];
  models: readonly ModelListItemView[];
  costReports: readonly CostReportListItemView[];
  /** Authoritative engineering facts of this Revision, oldest first. */
  facts: readonly RevisionFact[];
  /** Modeling experience of this Revision, newest first. */
  modelingFeedback: readonly ModelingFeedback[];
}

export interface RunDetailView {
  run: {
    runId: string;
    runLabel: string;
    drawingId: string;
    revisionId: string;
    status: string;
    stage: string | null;
    activity: string | null;
    progressPercent: number | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    modelId: string | null;
    clarificationRequestId: string | null;
  };
  events: readonly RunEvent[];
  /** Events after this sequence have already been consumed by the subscriber. */
  lastEventSequence: number;
}

export interface ModelDetailView {
  geometry?: {
    finishedVolumeM3: number;
    boundingBoxMm: { length: number; width: number; height: number } | null;
    sourceArtifactId: string;
  } | null;
  model: {
    modelId: string;
    modelLabel: string;
    drawingId: string;
    revisionId: string;
    runId: string;
    reviewStatus: string;
    isCurrentApproved: boolean;
    generatedAt: string;
    /**
     * Truthful production-verification claim persisted from the strictly
     * validated Result Manifest (P5 truthfulness hardening). A synthetic
     * Fake Agent / preflight publication is always `false`, so the product can
     * distinguish an unverified model before review. Read-only.
     */
    productionVerified: boolean;
    validationSummary: {
      solidWorksVersion: string;
      featureCount: number;
      bodyCount: number;
      rebuildStatus: string;
    } | null;
    buildReportSummary: string | null;
  };
  artifacts: readonly {
    artifactId: string;
    kind: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
  }[];
  reviews: readonly {
    reviewId: string;
    result: string;
    reviewerId: string;
    comment: string | null;
    createdAt: string;
  }[];
}

export interface ClarificationView {
  clarificationRequestId: string;
  runId: string;
  revisionId: string;
  status: string;
  questions: readonly {
    questionId: string;
    type: string;
    question: string;
    hint: string | null;
    unit: string | null;
    options: readonly { id: string; label: string }[];
  }[];
  answers: readonly {
    answerId: string;
    questionId: string;
    value: unknown;
    answeredAt: string;
  }[];
  createdAt: string;
}

export interface CostReportDetailView {
  costReportId: string;
  label: string;
  drawingId: string;
  revisionId: string;
  modelId: string;
  quantity: number;
  createdAt: string;
  snapshot: CostEstimateSnapshot;
  result: {
    rawStockVolume: number;
    materialCost: number;
    fixedCostLines: readonly { name: string; amount: number; basis: string; subtotal: number }[];
    perPieceCost: number;
    totalCost: number;
    currency: string;
  };
}

export interface WorkspaceDashboardView {
  currentRun: RunDetailView["run"] | null;
  queuedRunLabels: readonly string[];
  pendingReviews: readonly {
    drawingId: string;
    drawingNumber: string;
    revisionLabel: string;
    /** Owning Revision id (for deep links); optional for older producers. */
    revisionId?: string;
    modelId: string;
    modelLabel: string;
  }[];
  pendingClarifications: readonly {
    drawingId: string;
    drawingNumber: string;
    revisionLabel: string;
    runId: string;
    runLabel: string;
    openQuestionCount: number;
  }[];
  recentDrawings: readonly DrawingListItemView[];
}

/**
 * Version history of one Drawing: every Revision in ascending order with its
 * file metadata. The current Revision is identified by `isCurrent`; this is the
 * read model behind the Drawing history list.
 */
export interface DrawingHistoryView {
  drawingId: string;
  drawingNumber: string;
  name: string;
  currentRevisionId: string | null;
  revisions: readonly {
    revisionId: string;
    revisionLabel: string;
    isCurrent: boolean;
    sourceFile: {
      fileName: string;
      format: string;
      sizeBytes: number;
      sha256: string;
      uploadedAt: string;
    };
    createdAt: string;
  }[];
}

/**
 * Audit-style history of one Revision: the fixed work version plus every
 * Revision Fact and Modeling Feedback entry appended over time, each with its
 * provenance. Never includes Runs or Models — those stay on Revision Detail.
 */
export interface RevisionHistoryView {
  revisionId: string;
  revisionLabel: string;
  drawingId: string;
  drawingNumber: string;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
  facts: readonly RevisionFact[];
  modelingFeedback: readonly ModelingFeedback[];
}

/** Read model of the persisted storage configuration (data/workspace roots). */
export interface StorageSettingsView {
  settings: StorageSettings;
}

export type QueryResult =
  | DeletionImpact
  | DrawingDetailView
  | RevisionDetailView
  | RunDetailView
  | ModelDetailView
  | ClarificationView
  | CostReportDetailView
  | WorkspaceDashboardView
  | DrawingHistoryView
  | RevisionHistoryView
  | StorageSettingsView
  /** Effective company-global Cost Data returned by `costData.get`. */
  | CostDataSnapshot;
