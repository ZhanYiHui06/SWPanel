/**
 * Stable public API of the SWPanel Agent Runner process boundary.
 *
 * Phase 2 ships the real persistence foundation, the Drawing workflow
 * application service and the WP4 IPC boundary: SQLite WAL structured store,
 * immutable source-file ledger, the user-managed Drawing workflow use cases,
 * the strict per-user Windows Named Pipe server with its current-user-only
 * DACL enforcement, and the validated query/command dispatch. Phase 3 adds the
 * Run repository (atomic create + frozen snapshot, aggregate reads,
 * transactional event projection, clarification persistence), the Run
 * orchestration primitives (atomic claim, lease heartbeat, attempt finish,
 * expired-lease recovery), the serial Fake Executor queue, and the real per-Run
 * event subscriptions over the pipe (after-commit event stream, persisted
 * backlog + live batches). Phase 4 adds the Input Adapter, the Invocation
 * Package + prompt, the raw Agent record protocol with the product-event
 * translator and the independent artifact validator. Phase 5 (P5-3) adds the
 * async Agent turn seam and the strict NDJSON JSON-RPC Codex App Server
 * client + adapter (codex-cli 0.147.0 / protocol v2, contract-tested only —
 * the live spawn of the TURN adapter remains disabled; see `agent/codex/`).
 * The preflight probe seam (`preflight/codex-live-probe.ts`) is the one
 * production path that spawns a bounded app-server child (initialize +
 * skills/list discovery + a bounded thread/start compatibility probe, owned
 * and closed by the probe). The live SolidWorks
 * probe (`preflight/solidworks-live-probe.ts`) is the async counterpart of
 * the synchronous SolidWorks seam: the Electron Main host awaits it inside
 * the live-Codex mode and injects a FIXED seam into RealPreflightProbe — the
 * probe attaches read-only to a pre-existing instance or spawns SLDWORKS.exe
 * directly from Node (shell:false, windowsHide:true), proves COM ownership by
 * exact pid, closes ONLY its own spawned process and never touches a user
 * process. Phase 5 (P5-4) adds
 * the ownership-safe SolidWorks cancellation boundary (explicit per-attempt
 * identity proof, contract-tested only — never HIL-verified) and the
 * protocol-pinned thread-session recovery helper + orchestrator capabilities
 * adapter. The Electron bridge
 * and renderer run pages remain later batches.
 */

export {
  Runner,
  DEFAULT_RUN_PROFILE,
  type RunnerConfig
} from "./runner.js";
export {
  DEFAULT_INPUT_ADAPTER_SCENARIO,
  FakeInputAdapter,
  INPUT_ADAPTER_ID,
  INPUT_ADAPTER_VERSION,
  TEST_ONLY_INPUT_ADAPTER_ID,
  mapInputAdapterFailureCode,
  type FakeInputAdapterOptions,
  type InputAdapter,
  type InputAdapterContext,
  type InputAdapterSource,
  type InputAdapterWorkspace
} from "./adaptation/input-adapter.js";
export {
  PDF_RASTERIZER_FAILURE_CODES,
  RASTERIZER_UNAVAILABILITY_REASONS,
  REAL_PDF_DEFAULT_DPI,
  REAL_PDF_INPUT_ADAPTER_ID,
  REAL_PDF_INPUT_ADAPTER_VERSION,
  RealPdfInputAdapter,
  type PdfInspectResult,
  type PdfRasterizeRequest,
  type PdfRasterizeResult,
  type PdfRasterizer,
  type PdfRasterizerAvailability,
  type PdfRasterizerFailureCode,
  type RasterizerUnavailabilityReason,
  type RealPdfInputAdapterOptions
} from "./adaptation/real-pdf-input-adapter.js";
export {
  DEFAULT_PYTHON_COMMAND_RUNNER,
  PYTHON_PDFIUM_HELPER_FILE_NAME,
  PYTHON_PDFIUM_INSPECT_TIMEOUT_MS,
  PYTHON_PDFIUM_MAX_BUFFER_BYTES,
  PYTHON_PDFIUM_RASTERIZER_ID,
  PYTHON_PDFIUM_RASTERIZER_UNKNOWN_VERSION,
  PYTHON_PDFIUM_RENDER_TIMEOUT_MS,
  PythonPdfiumRasterizer,
  type PdfiumHelperJson,
  type PdfiumProbeHelperJson,
  type PythonCommandRunResult,
  type PythonCommandRunner,
  type PythonPdfiumRasterizerOptions
} from "./adaptation/python-pdfium-rasterizer.js";
export {
  buildPreflightReport,
  DEFAULT_PREFLIGHT_SCENARIO,
  FAKE_PREFLIGHT_SKILL_SHA256,
  FakePreflightProbe,
  isConsistentEnvironmentResult,
  mapPreflightFailureCode,
  PREFLIGHT_ENV_CAPABILITIES,
  PreflightGate,
  type FakePreflightProbeOptions,
  type Preflight,
  type PreflightEnvironmentResult,
  type PreflightProbe,
  type PreflightProbeContext
} from "./preflight/preflight.js";
export {
  codexVersionProbe,
  FAIL_CLOSED_RUNTIME_PROBE,
  FAIL_CLOSED_SOLIDWORKS_PROBE,
  RealPreflightProbe,
  type CodexVersionProbeOptions,
  type CommandRunner,
  type RealPreflightProbeOptions,
  type RuntimeProbe,
  type RuntimeProbeResult,
  type SolidWorksProbe,
  type SolidWorksProbeResult
} from "./preflight/real-preflight-probe.js";
export {
  DEFAULT_LIVE_CODEX_PROBE_TIMEOUT_MS,
  failClosedLiveCodexResult,
  probeLiveCodexRuntime,
  runtimeProbeResultOf,
  type LiveCodexProbeOptions,
  type LiveCodexProbeResult
} from "./preflight/codex-live-probe.js";
export {
  DEFAULT_SOLIDWORKS_ATTACH_PROBE_TIMEOUT_MS,
  DEFAULT_SOLIDWORKS_CLOSE_GRACE_MS,
  DEFAULT_SOLIDWORKS_COM_HELPER_RUNNER,
  DEFAULT_SOLIDWORKS_DISCOVER_HELPER_TIMEOUT_MS,
  DEFAULT_SOLIDWORKS_HELPER_GRACE_MS,
  DEFAULT_SOLIDWORKS_INSTALLATION_DISCOVERY,
  DEFAULT_SOLIDWORKS_SPAWNER,
  DEFAULT_SOLIDWORKS_SPAWN_PROBE_TIMEOUT_MS,
  SOLIDWORKS_COM_PROGID,
  SOLIDWORKS_EXECUTABLE_FILE_NAME,
  SolidWorksComHelperAbortedError,
  SolidWorksComHelperTimeoutError,
  failClosedSolidWorksResult,
  parseSolidWorksHelperOutcome,
  probeSolidWorksRuntime,
  runSolidWorksComHelper,
  solidWorksProbeResultOf,
  type SolidWorksComHelperMode,
  type SolidWorksComHelperOutcome,
  type SolidWorksComHelperRequest,
  type SolidWorksComHelperRunner,
  type SolidWorksComHelperRunnerOptions,
  type SolidWorksInstallation,
  type SolidWorksInstallationDiscovery,
  type SolidWorksLiveProbeOptions,
  type SolidWorksLiveProbeResult,
  type SolidWorksProbeReason,
  type SolidWorksProcessSpawner,
  type SpawnedSolidWorksProcess
} from "./preflight/solidworks-live-probe.js";
export {
  hashSkillDirectory,
  SkillHashError,
  type SkillHashErrorCode
} from "./preflight/skill-directory-hash.js";
export {
  PROMPT_TEMPLATE_VERSION,
  REQUIRED_MODEL_ARTIFACTS,
  renderPrompt,
  type RenderPromptInput
} from "./adaptation/prompt-template.js";
export {
  buildInvocationPackage,
  type InvocationPackageBuildInput,
  type InvocationPackageWorkspacePaths
} from "./adaptation/invocation-package.js";
export type {
  AddModelingFeedbackInput,
  AddRevisionFactInput,
  AddRevisionInput,
  AddRevisionResult,
  ImportDrawingInput,
  ImportDrawingResult,
  SetCurrentRevisionInput,
  SourceFileImport
} from "./service/drawing-workflow-service.js";
export {
  DrawingWorkflowService
} from "./service/drawing-workflow-service.js";
export {
  ModelWorkflowService,
  type ReviewModelInput
} from "./service/model-workflow-service.js";
export {
  DrawingFileLedger,
  DRAWING_MIME_TYPES,
  type LedgerOptions,
  type StoredDrawingFile
} from "./ledger/drawing-file-ledger.js";
export {
  SCHEMA_VERSION,
  type SchemaMigration
} from "./db/schema.js";
export {
  SqliteDatabase,
  type SqliteDatabaseOptions
} from "./db/database.js";
export {
  SqliteRepository,
  isUniqueConstraintError
} from "./db/repository.js";
export {
  RunRepository,
  type AppendRunEventsInput,
  type CreateRunInput,
  type RunEventEntry,
  type RunProfile
} from "./db/run-repository.js";
export {
  DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS,
  DEFAULT_RUN_LEASE_DURATION_MS,
  RunOrchestrator,
  RECOVERY_SCAN_OUTCOMES,
  type CancelQueuedRunRequest,
  type CancelRunAttemptRequest,
  type ClarifyRunAttemptRequest,
  type CompleteRunAttemptRequest,
  type FailRunAttemptRequest,
  type FinishRunAttemptRequest,
  type PublishModelPublicationInput,
  type PublishedModelPublication,
  type RecoveryCapabilityContext,
  type RecoveryScanEntry,
  type RecoveryScanOutcome,
  type RecoveryScanResult,
  type RenewAttemptLeaseInput,
  type RunClaim,
  type RunOrchestratorOptions,
  type RunRecoveryCapabilities,
  type SeizeCancelCleanupOwnershipInput
} from "./orchestration/run-orchestrator.js";
export {
  FakeExecutor,
  TimerExecutorScheduler,
  type AttemptWorkspace,
  type CancelRunResult,
  type ExecutorScheduler,
  type FakeExecutorOptions,
  type ScheduledTask,
  type SolidWorksOwnershipSurface
} from "./execution/fake-executor.js";
export {
  buildOwnershipRecord,
  documentOf,
  isOwnedCloseSafeForCancellation,
  pidOf,
  SolidWorksOwnershipGuard,
  type BuildOwnershipRecordInput,
  type CloseOnlyOwnedOutcome,
  type FailedSolidWorksIdentity,
  type OwnershipRecord,
  type OwnershipUnprovenReason,
  type RecordIdentityInput,
  type RecordOwnershipInput,
  type SnapshotOwnershipInput,
  type SolidWorksDocumentIdentity,
  type SolidWorksIdentity,
  type SolidWorksIdentityCloser,
  type SolidWorksOwnershipGuardOptions,
  type SolidWorksPidIdentity
} from "./execution/ownership/solidworks-ownership-guard.js";
export {
  DEFAULT_SOLIDWORKS_CLOSE_MAX_BUFFER_BYTES,
  DEFAULT_SOLIDWORKS_CLOSE_PYTHON_COMMAND,
  DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS,
  DEFAULT_SOLIDWORKS_DOCUMENT_CLOSE_RUNNER,
  SolidWorksDocumentCloseError,
  SolidWorksDocumentCloser,
  parseCloseHelperJson,
  type SolidWorksDocumentCloseHelperJson,
  type SolidWorksDocumentCloseRunInput,
  type SolidWorksDocumentCloseRunner,
  type SolidWorksDocumentCloserOptions
} from "./execution/ownership/solidworks-document-closer.js";
export {
  isSolidWorksOwnedStage,
  normalizeRegistryPath,
  readSolidWorksOwnershipRegistry,
  SOLIDWORKS_OWNED_STAGES,
  SOLIDWORKS_OWNERSHIP_FILE_RELATIVE_PATH,
  SOLIDWORKS_OWNERSHIP_MAX_DOCUMENTS,
  SOLIDWORKS_OWNERSHIP_SCHEMA_VERSION,
  validateSolidWorksOwnershipRegistry,
  type SolidWorksOwnershipRegistryBinding,
  type SolidWorksOwnershipRegistryReadResult,
  type SolidWorksOwnershipRegistryReadSurface,
  type SolidWorksOwnershipRegistryRecord
} from "./execution/ownership/solidworks-ownership-registry.js";
export {
  SolidWorksOwnershipSurfaceError,
  WorkspaceSolidWorksOwnershipSurface,
  type SolidWorksOwnershipSurfaceContext,
  type WorkspaceSolidWorksOwnershipSurfaceOptions
} from "./execution/ownership/workspace-solidworks-ownership-surface.js";
export {
  decideThreadResume,
  hasHardNoCheckpointStage,
  hasSafeCheckpoint,
  isPinnedResumeStage,
  isPinnedThreadSessionProtocol,
  isWellFormedThreadSession,
  PINNED_CODEX_CLI_VERSION,
  PINNED_THREAD_SESSION_PROTOCOL,
  PINNED_THREAD_SESSION_PROTOCOL_VERSION,
  THREAD_SESSION_NO_CHECKPOINT_STAGES,
  THREAD_SESSION_RESUME_STAGES,
  type SafeCheckpointInput,
  type ThreadProtocolIdentity,
  type ThreadResumeDecision,
  type ThreadResumeDeniedReason,
  type ThreadResumeInput,
  type ThreadSessionLike
} from "./execution/recovery/thread-session-recovery.js";
export {
  threadSessionRecoveryCapabilities,
  type ThreadSessionLookup
} from "./execution/recovery/thread-session-recovery-capabilities.js";
export {
  AgentTurnError,
  AGENT_TURN_ERROR_CODES,
  toAgentTurnAdapter,
  type AgentInterruptInput,
  type AgentTurnAdapter,
  type AgentTurnErrorCode,
  type AgentTurnInput,
  type AgentTurnOutcome,
  type AgentWorkspace
} from "./agent/agent-turn-adapter.js";
export {
  JSON_RPC_DEFAULT_MAX_LINE_BYTES,
  JsonRpcCodecError,
  decodeJsonRpcLine,
  encodeJsonRpcLine,
  jsonRpcLineBytes,
  splitJsonRpcChunk,
  type DecodedJsonRpcLine,
  type JsonRpcErrorObject,
  type JsonRpcErrorResponse,
  type JsonRpcLineKind,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcRequestId,
  type JsonRpcResponse,
  type SplitJsonRpcChunkResult
} from "./agent/codex/jsonrpc-codec.js";
export {
  CODEX_APPROVAL_POLICY,
  CODEX_CLIENT_INFO,
  CODEX_CLI_VERSION,
  CODEX_PROTOCOL_VERSION,
  CODEX_SANDBOX_MODE,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnInterruptParams,
  buildTurnStartParams,
  type ThreadResumeBuildInput,
  type ThreadStartBuildInput,
  type TurnInterruptBuildInput,
  type TurnStartBuildInput
} from "./agent/codex/builders.js";
export {
  AGENT_SESSION_FILE_RELATIVE_PATH,
  AGENT_SESSION_SCHEMA_VERSION,
  AGENT_SESSION_STATUSES,
  buildAgentSessionRecord,
  readAgentSessionRecord,
  validateAgentSessionRecord,
  withAgentSessionStatus,
  writeAgentSessionRecord,
  type AgentSessionRecord,
  type AgentSessionReadInput,
  type AgentSessionReadSurface,
  type AgentSessionStatus,
  type AgentSessionUpdateInput,
  type AgentSessionWriteInput,
  type AgentSessionWriteSurface,
  type BuildAgentSessionRecordInput
} from "./agent/codex/agent-session.js";
export {
  CodexAppServerClient,
  CodexClientError,
  DEFAULT_CODEX_REQUEST_TIMEOUT_MS,
  DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS,
  type CodexAppServerClientOptions,
  type CodexClientErrorCode,
  type CodexInitializeResult,
  type CodexThreadStartedResult,
  type CodexTransport,
  type CodexTransportFactory,
  type CodexTurnCompleted,
  type CodexTurnStartedResult
} from "./agent/codex/codex-app-server-client.js";
export {
  CODEX_APP_SERVER_COMMAND,
  CODEX_APP_SERVER_STDIO_ARGS,
  CodexChildTransport,
  CodexCommandResolutionError,
  DEFAULT_CODEX_KILL_TIMEOUT_MS,
  DEFAULT_CODEX_STDERR_MAX_CHARS,
  DEFAULT_CODEX_STDIN_MAX_BUFFER_BYTES,
  codexChildTransportFactory,
  resolveCodexAppServerCommand,
  type CodexChildTransportOptions,
  type CodexCommandResolution
} from "./agent/codex/codex-child-transport.js";
export {
  CODEX_APP_SERVER_ADAPTER_ID,
  CodexAppServerAdapter,
  type CodexAppServerAdapterOptions
} from "./agent/codex/codex-app-server-adapter.js";
export {
  RunWorkspaceLedger,
  RUN_WORKSPACE_RELATIVE_DIR,
  RUN_WORKSPACE_SUBDIRS,
  type RunWorkspaceLayout,
  type RunWorkspaceOptions,
  type RunWorkspaceSubdir,
  type StoredRunFile
} from "./ledger/run-workspace-ledger.js";
export {
  RunnerError,
  NotFoundError,
  EntityConflictError,
  RunnerInvariantError,
  InvalidArgumentError,
  InvalidStorageSettingsError,
  UnsupportedPhaseOperationError,
  LedgerError,
  LedgerFileMissingError,
  LedgerHashMismatchError,
  LedgerSizeMismatchError,
  LedgerPathUnsafeError,
  LedgerEscapeDetectedError,
  LedgerCopyFailedError,
  type RunnerErrorCode,
  type RunnerErrorFields,
  SourceFileNotRegisteredError
} from "./errors.js";
export { generateId, assertSafeIdToken, SAFE_PATH_TOKEN } from "./ids.js";
export {
  RUNNER_BOUNDARY_VERSION,
  type RunnerApplicationReadModel,
  type RunnerPersistence,
  type RunnerEventStream,
  type RunnerService
} from "./boundary.js";
export * from "./ipc/index.js";

/**
 * Version marker of the Runner public surface. Bumped whenever the exported
 * shape breaks; internal implementation changes do not bump it.
 */
export const RUNNER_API_VERSION = 3 as const;
