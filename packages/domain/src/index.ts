export { DomainInvariantError } from "./errors.js";

export {
  clarificationAnswerLabel,
  clarificationQuestionLabel,
  costReportLabel,
  formatSequenceLabel,
  modelLabel,
  runLabel
} from "./labeling.js";

export {
  isCurrentRevision,
  type Drawing
} from "./drawings/drawing.js";

export {
  DRAWING_FILE_FORMATS,
  nextRevisionSequence,
  revisionLabel,
  type DrawingFileFormat,
  type DrawingRevision,
  type RevisionSourceFile
} from "./revisions/revision.js";

export {
  MODELING_FEEDBACK_SOURCES,
  type ModelingFeedback,
  type ModelingFeedbackSource
} from "./memory/feedback.js";

export {
  REVISION_FACT_SOURCES,
  type RevisionFact,
  type RevisionFactSource
} from "./memory/facts.js";

export { type RevisionMemory } from "./memory/memory.js";

export {
  canCancelRun,
  isRunTerminal,
  RUN_STAGE_LABELS,
  RUN_STAGES,
  RUN_STATUS_LABELS,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  transitionRunStatus,
  type RunStage,
  type RunStatus
} from "./runs/status.js";

export {
  RUN_FAILURE_CODES,
  type ModelingRun,
  type RunFailureCode,
  type RunInputSnapshot,
  type SkillIdentity
} from "./runs/run.js";

export {
  finishRunAttempt,
  isLeaseExpired,
  isRecoveryCandidateStage,
  isRunAttemptTerminal,
  RUN_ATTEMPT_STATUSES,
  RUN_INTERRUPTION_KINDS,
  RUN_RECOVERY_DECISIONS,
  TERMINAL_RUN_ATTEMPT_STATUSES,
  type FinishRunAttemptInput,
  type RunAttempt,
  type RunAttemptStatus,
  type RunInterruptionKind,
  type RunRecoveryDecision,
  type TerminalRunAttemptStatus
} from "./runs/attempt.js";

export {
  declaresSafeRecovery,
  FAKE_EXECUTOR_SCENARIOS,
  type FakeExecutorScenario
} from "./runs/fake-executor.js";

export {
  isPreflightCapability,
  isPreflightScenario,
  PLACEHOLDER_SKILL_SHA256,
  PREFLIGHT_CAPABILITIES,
  PREFLIGHT_REPORT_CONTRACT_VERSION,
  PREFLIGHT_SCENARIOS,
  type PreflightCapability,
  type PreflightCheckItem,
  type PreflightReport,
  type PreflightScenario
} from "./runs/preflight.js";

export {
  isCancellationRunEventType,
  isTerminalRunEventType,
  RUN_EVENT_CONTRACT_VERSION,
  RUN_EVENT_TYPES,
  TERMINAL_RUN_EVENT_TYPES,
  type RunEvent,
  type RunEventEnvelope,
  type RunEventPayload,
  type RunEventType,
  type TerminalRunEventType
} from "./runs/events.js";

export {
  canAnswerClarification,
  CLARIFICATION_QUESTION_TYPES,
  CLARIFICATION_STATUSES,
  CLARIFICATION_STATUS_LABELS,
  markClarificationAnswered,
  type ClarificationAnswer,
  type ClarificationAnswerValue,
  type ClarificationQuestion,
  type ClarificationQuestionOption,
  type ClarificationQuestionType,
  type ClarificationRequest,
  type ClarificationStatus
} from "./clarifications/clarification.js";

export {
  MODEL_REVIEW_STATUSES,
  MODEL_REVIEW_STATUS_LABELS,
  transitionModelStatus,
  type Model,
  type ModelReviewStatus,
  type ModelValidationSummary
} from "./models/model.js";

export {
  MODEL_REVIEW_RESULTS,
  type ModelReview,
  type ModelReviewResult
} from "./reviews/review.js";

export {
  ADAPTER_MODEL_ARTIFACT_KINDS,
  ARTIFACT_KINDS,
  HARD_MODEL_ARTIFACT_KINDS,
  type Artifact,
  type ArtifactKind
} from "./artifacts/artifact.js";

export {
  COST_BASES,
  COST_DATA_KINDS,
  COST_DATA_SEMANTICS,
  COST_DENSITY_UNITS,
  COST_PRICE_UNITS,
  type AllowanceDefinition,
  type AllowanceValue,
  type CostBasis,
  type CostDataDefinition,
  type CostDataKind,
  type CostDataSemantics,
  type CostDataSnapshot,
  type CostDataValue,
  type CustomCostField,
  type FixedCostValue,
  type MaterialCostValue
} from "./cost/cost-data.js";

export {
  COST_CURRENCIES,
  STOCK_TYPES,
  type CostCurrency,
  type CostEstimateInputSnapshot,
  type CostEstimateReport,
  type CostEstimateResult,
  type CostEstimateSnapshot,
  type FixedCostLine,
  type StockType
} from "./cost/cost-estimate.js";

export {
  calculateCostEstimate,
  MAX_COST_QUANTITY,
  parseStockSpec,
  roundCny
} from "./cost/calculator.js";
export type { ParsedStockSpec, StockSpecUnit } from "./cost/calculator.js";

export {
  canCreateCostEstimateReport,
  canReviewModel,
  canSetCurrentRevision,
  hasCurrentApprovedModel
} from "./invariants.js";

export {
  canDeleteCostReport,
  canDeleteRevision,
  canDeleteRun,
  DELETABLE_RUN_STATUSES,
  REVISION_DELETION_BLOCKERS,
  type CanDeleteRevisionInput,
  type CanDeleteRevisionResult,
  type DeletionDecision,
  type RevisionDeletionBlocker
} from "./deletion/index.js";

export {
  INPUT_ADAPTER_FAILURE_CODES,
  INPUT_ADAPTER_IMAGE_FORMATS,
  INPUT_ADAPTER_SCENARIOS,
  INPUT_ADAPTER_TEST_ONLY_SCENARIOS,
  isInputAdapterFailure,
  isInputAdapterScenario,
  isInputAdapterSuccess,
  isTestOnlyResult,
  isTestOnlyScenario,
  type InputAdapterFailureCode,
  type InputAdapterImageFormat,
  type InputAdapterOutputImage,
  type InputAdapterPageSelection,
  type InputAdapterProvenance,
  type InputAdapterRenderer,
  type InputAdapterRequest,
  type InputAdapterResult,
  type InputAdapterScenario,
  type InputAdapterSourceRef
} from "./input/input-adapter.js";

export {
  STORAGE_CONSTRAINTS,
  type StorageConstraint,
  type StorageSettings
} from "./storage/settings.js";

export {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TONES,
  type NotificationCategory,
  type NotificationItem,
  type NotificationTone,
  type RecoveryStatusSummary
} from "./notifications/index.js";
