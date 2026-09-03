import type {
  Artifact,
  ClarificationRequest,
  CostEstimateReport,
  Drawing,
  DrawingRevision,
  Model,
  ModelingFeedback,
  ModelingRun,
  ModelReview,
  RevisionFact,
  RunEvent,
  StorageSettings
} from "@swpanel/domain";
import type { CostDataState } from "./cost-data.js";

/**
 * The complete in-memory snapshot of the mock application data. Every scenario
 * seed produces one coherent `MockWorld`; the repository holds one world at a
 * time and never mutates it in place (commands produce a new world).
 *
 * `runEvents` maps a Run id to its ordered structured event stream. Runs that
 * never started (QUEUED) or have no events yet carry an empty array.
 */
export interface MockWorld {
  drawings: readonly Drawing[];
  revisions: readonly DrawingRevision[];
  facts: readonly RevisionFact[];
  feedback: readonly ModelingFeedback[];
  runs: readonly ModelingRun[];
  runEvents: Readonly<Record<string, readonly RunEvent[]>>;
  models: readonly Model[];
  reviews: readonly ModelReview[];
  clarifications: readonly ClarificationRequest[];
  artifacts: readonly Artifact[];
  costData: CostDataState;
  reports: readonly CostEstimateReport[];
  storageSettings: StorageSettings;
}

/** Default storage layout matching ADR-002 (`%LOCALAPPDATA%\JANGHI\SWPanel\`). */
export function defaultStorageSettings(): StorageSettings {
  return {
    dataRoot: "%LOCALAPPDATA%\\JANGHI\\SWPanel",
    workspaceRoot: "%LOCALAPPDATA%\\JANGHI\\SWPanel\\workspaces",
    constraint: "LOCAL_FIXED_NTFS",
    updatedAt: "1970-01-01T00:00:00.000Z"
  };
}

/** Returns a deep-equivalent empty world (empty drawing library scenario). */
export function emptyWorld(): MockWorld {
  return {
    drawings: [],
    revisions: [],
    facts: [],
    feedback: [],
    runs: [],
    runEvents: {},
    models: [],
    reviews: [],
    clarifications: [],
    artifacts: [],
    costData: {
      definitions: [],
      materials: [],
      allowances: [],
      fixedCosts: [],
      customFields: []
    },
    reports: [],
    storageSettings: defaultStorageSettings()
  };
}
