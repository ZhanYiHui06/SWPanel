/**
 * IPC layer of the Agent Runner: the Windows Named Pipe server (architecture.md
 * §12.1), the newline-delimited JSON framing, the per-user DACL enforcement,
 * the request dispatch that maps validated envelopes to the Runner application
 * service, and the real per-Run event subscriptions (run.subscribe over the
 * wire, persisted backlog + after-commit live batches). The client side of the
 * wire lives in `apps/desktop/src/main/ipc-client`.
 */

export type {
  PipeDaclContext,
  PipeDaclEvidence,
  PipeDaclResult,
  PipeDaclStatus
} from "./acl.js";
export {
  applyPipeDaclToServer,
  applyPipeDaclWithIcacls,
  PIPE_DACL_ACE_MASK,
  readPipeDaclEvidence,
  SYSTEM_SID,
  SYSTEM_SID_CONST,
  verifyPipeDacl,
  writePipeDaclEvidence
} from "./acl.js";
export type { IpcRequestHandler } from "./request-handler.js";
export { RunnerRequestHandler } from "./request-handler.js";
export { IdempotencyCache, DEFAULT_IDEMPOTENCY_CAPACITY, DEFAULT_IDEMPOTENCY_TTL_MS } from "./idempotency-cache.js";
export { FrameCodec, FrameError, MAX_IPC_FRAME_BYTES } from "./frame-codec.js";
export type { DuplexPipePair } from "./duplex-pair.js";
export { createDuplexPipePair } from "./duplex-pair.js";
export {
  newServerInstanceId,
  pipePathForServerInstance,
  PIPE_PREFIX,
  supportsWindowsPipes
} from "./pipe-name.js";
export {
  IpcServer,
  MAX_FRAME_BYTES,
  SHUTDOWN_ERROR_CODE,
  type IpcEventStream,
  type IpcServerOptions,
  type IpcServerStartResult
} from "./server.js";
