/**
 * Electron Main-side IPC client of the Agent Runner (WP4 / architecture.md
 * §12.1). The client speaks the shared `@swpanel/contracts` wire format over
 * the per-user Windows Named Pipe: newline-delimited JSON frames with a 1 MiB
 * cap, a protocol-versioned handshake, validated request/response envelopes
 * and (requestId, idempotencyKey) replay support. The raw transport is owned
 * privately and never exposed to the Renderer or Preload.
 */

export type { IpcClientTransport } from "./transport.js";
export { createDuplexTransport, createNetPipeTransport } from "./transport.js";
export type {
  IpcClientErrorCode
} from "./errors.js";
export {
  IpcClientClosedError,
  IpcClientError,
  IpcConnectError,
  IpcConnectionLostError,
  IpcInvalidResponseError,
  IpcProtocolVersionError,
  IpcRequestTimeoutError,
  IpcServerInstanceChangedError
} from "./errors.js";
export {
  IpcClientImpl,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_CONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type IpcClientOptions,
  type IpcCommandOptions,
  type IpcQueryOptions,
  type IpcSubscribeOptions
} from "./client.js";
