export {
  fail,
  ok,
  type DomainErrorResult,
  type DomainResult,
  type EntityId,
  type Page,
  type Result
} from "./types.js";

export type {
  ClarificationView,
  CostReportDetailView,
  CostReportListItemView,
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  ModelDetailView,
  ModelListItemView,
  QueryResult,
  RevisionDetailView,
  RevisionHistoryView,
  RevisionListItemView,
  RunDetailView,
  RunListItemView,
  StorageSettingsView,
  WorkspaceDashboardView
} from "./queries.js";

export {
  COMMAND_NAMES,
  type AddModelingFeedbackCommand,
  type AddRevisionFactCommand,
  type CancelRunCommand,
  type ClearApiKeyCommand,
  type Command,
  type CommandName,
  type CreateCostReportCommand,
  type CreateDrawingCommand,
  type CreateRevisionCommand,
  type CreateRunCommand,
  type DeleteCostReportCommand,
  type DeleteRevisionCommand,
  type DeleteRunCommand,
  type GetApiKeyStatusCommand,
  type GetRecoveryStatusCommand,
  type OpenModelInSolidWorksCommand,
  type RecoveryStatusResult,
  type ReviewModelCommand,
  type SecretApiKeyStatus,
  type SetApiKeyCommand,
  type SetCurrentRevisionCommand,
  type SubmitClarificationCommand,
  type UpdateCostDataCommand,
  type UpdateStorageSettingsCommand
} from "./commands.js";

export type { MockRepository } from "./repository/mock-repository.js";
export type { RepositoryReader, RepositoryWriter } from "./repository/ports.js";

export type { RunEventCursor, RunEventSubscriber, RunEventStreamError, RunEventStreamErrorCode, RunSubscription } from "./events.js";
export { RUN_EVENT_STREAM_ERROR_CODES } from "./events.js";

export {
  IPC_PROTOCOL_VERSION,
  QUERY_NAMES,
  SUBSCRIBE_NAMES,
  type IpcClient,
  type IpcEventEnvelope,
  type IpcHandshakeEnvelope,
  type IpcMessage,
  type IpcRequestEnvelope,
  type IpcResponseEnvelope,
  type IpcServer,
  type IpcTransport,
  type QueryName,
  type QueryRequest,
  type SubscribeName,
  type SubscribeRequest
} from "./ipc.js";

export {
  IpcValidationError,
  type IpcValidationErrorCode,
  isCommandOperation,
  isCommandPayload,
  isIpcRequestEnvelope,
  isQueryOperation,
  validateIpcEventEnvelope,
  validateIpcHandshakeEnvelope,
  validateIpcRequestEnvelope,
  validateIpcResponseEnvelope
} from "./ipc-validation.js";

export { FrameCodec, FrameError, MAX_IPC_FRAME_BYTES } from "./framing.js";

// --- Phase 4 contracts (Input Adapter and Agent Contract) ---

export {
  Phase4ContractError,
  type Phase4ContractErrorCode
} from "./phase4/shared.js";

export {
  PHASE4_SCHEMA_DRAFT,
  PHASE4_SCHEMA_IDS,
  AGENT_TURN_OUTPUT_SCHEMA_ID,
  CLARIFICATION_SCHEMA_ID,
  ERROR_SCHEMA_ID,
  INPUT_ADAPTATION_SCHEMA_ID,
  INVOCATION_PACKAGE_SCHEMA_ID,
  IPC_ENVELOPE_SCHEMA_ID,
  PRODUCT_EVENTS_SCHEMA_ID,
  RESULT_MANIFEST_SCHEMA_ID,
  RUNTIME_METADATA_SCHEMA_ID,
  type Phase4SchemaId
} from "./phase4/schema-ids.js";

export {
  IPC_ENVELOPE_CONTRACT_VERSION,
  IPC_ENVELOPE_JSON_SCHEMA
} from "./phase4/ipc-envelope.js";

export {
  INVOCATION_EXECUTION_VISIBILITIES,
  INVOCATION_PACKAGE_CONTRACT_VERSION,
  INVOCATION_PACKAGE_JSON_SCHEMA,
  validateInvocationPackage,
  type InvocationExecutionVisibility,
  type InvocationPackage,
  type InvocationPackageExecution,
  type InvocationPackageInput,
  type InvocationPackageMemory,
  type InvocationPackageSkill,
  type InvocationPackageWorkspace
} from "./phase4/invocation-package.js";

export {
  RUNTIME_METADATA_CONTRACT_VERSION,
  RUNTIME_METADATA_JSON_SCHEMA,
  validateRuntimeMetadata,
  type RuntimeMetadata,
  type RuntimeMetadataResume,
  type RuntimeMetadataRuntime,
  type RuntimeMetadataSession
} from "./phase4/runtime-metadata.js";

export {
  PRODUCT_EVENTS_CONTRACT_VERSION,
  PRODUCT_EVENTS_JSON_SCHEMA,
  validateProductEvent,
  validateProductEventPayload
} from "./phase4/product-events.js";

export {
  CLARIFICATION_CONTRACT_VERSION,
  CLARIFICATION_JSON_SCHEMA,
  validateClarificationAnswer,
  validateClarificationQuestion,
  validateClarificationRequest
} from "./phase4/clarification.js";

export {
  ERROR_CONTRACT_VERSION,
  ERROR_JSON_SCHEMA,
  validateErrorContract,
  type ErrorContract
} from "./phase4/error.js";

export {
  INPUT_ADAPTATION_CONTRACT_VERSION,
  INPUT_ADAPTATION_JSON_SCHEMA,
  validateInputAdapterProvenance,
  validateInputAdapterRequest,
  validateInputAdapterResult
} from "./phase4/input-adaptation.js";

export {
  REQUIRED_RESULT_MANIFEST_ARTIFACTS,
  RESULT_MANIFEST_CONTRACT_VERSION,
  RESULT_MANIFEST_JSON_SCHEMA,
  RESULT_MANIFEST_RESULTS,
  validateResultManifest,
  type ResultManifest,
  type ResultManifestArtifactKey,
  type ResultManifestArtifactRef,
  type ResultManifestArtifacts,
  type ResultManifestResult
} from "./phase4/result-manifest.js";

export {
  AGENT_TURN_OUTPUT_CONTRACT_VERSION,
  AGENT_TURN_OUTPUT_JSON_SCHEMA,
  AGENT_TURN_OUTPUT_RESULTS,
  validateAgentTurnOutput,
  type AgentTurnOutput,
  type AgentTurnOutputClarification,
  type AgentTurnOutputCompleted,
  type AgentTurnOutputResult
} from "./phase4/agent-turn-output.js";

export {
  PHASE4_REGISTRY_VERSION,
  PHASE4_SCHEMAS,
  getPhase4Schema,
  isPhase4SchemaId,
  validatePhase4SchemaRegistration,
  type Phase4SchemaDocument
} from "./phase4/schema-registry.js";
