/**
 * Structured error surface of the Electron Main IPC client. Codes are stable
 * identifiers the Main process (and later the Preload bridge) can map to
 * user-visible messages; they are not free-form prose.
 */

export type IpcClientErrorCode =
  | "CONNECT_FAILED"
  | "PROTOCOL_VERSION_MISMATCH"
  | "SERVER_INSTANCE_CHANGED"
  | "REQUEST_TIMEOUT"
  | "CONNECTION_LOST"
  | "INVALID_RESPONSE"
  | "CLIENT_CLOSED";

/** Base structured error of the IPC client. */
export class IpcClientError extends Error {
  readonly code: IpcClientErrorCode;

  constructor(code: IpcClientErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IpcClientError";
    this.code = code;
  }
}

/** The client could not establish a connection to the Runner pipe. */
export class IpcConnectError extends IpcClientError {
  constructor(message: string, cause?: unknown) {
    super("CONNECT_FAILED", message, { cause });
    this.name = "IpcConnectError";
  }
}

/** The peer spoke a different protocol version than the client. */
export class IpcProtocolVersionError extends IpcClientError {
  constructor(message: string) {
    super("PROTOCOL_VERSION_MISMATCH", message);
    this.name = "IpcProtocolVersionError";
  }
}

/**
 * The Runner restarted: a reconnect handshake carried a different
 * `serverInstanceId` than the one the client was bound to. In-flight requests
 * are invalidated and the caller must re-read its snapshot.
 */
export class IpcServerInstanceChangedError extends IpcClientError {
  constructor(previousInstanceId: string, currentInstanceId: string) {
    super(
      "SERVER_INSTANCE_CHANGED",
      `The Runner server instance changed (${previousInstanceId} -> ${currentInstanceId}); ` +
        "in-flight requests were invalidated and snapshots must be re-read"
    );
    this.name = "IpcServerInstanceChangedError";
  }
}

/** A request exceeded the client-side timeout. */
export class IpcRequestTimeoutError extends IpcClientError {
  constructor(requestId: string, timeoutMs: number) {
    super(
      "REQUEST_TIMEOUT",
      `IPC request ${requestId} timed out after ${timeoutMs}ms`
    );
    this.name = "IpcRequestTimeoutError";
  }
}

/** The connection dropped before a response arrived. */
export class IpcConnectionLostError extends IpcClientError {
  constructor(message: string) {
    super("CONNECTION_LOST", message);
    this.name = "IpcConnectionLostError";
  }
}

/** The peer sent a malformed or invalid response envelope. */
export class IpcInvalidResponseError extends IpcClientError {
  constructor(message: string) {
    super("INVALID_RESPONSE", message);
    this.name = "IpcInvalidResponseError";
  }
}

/** A request was made after {@link IpcClientImpl.close}. */
export class IpcClientClosedError extends IpcClientError {
  constructor() {
    super("CLIENT_CLOSED", "The IPC client is closed");
    this.name = "IpcClientClosedError";
  }
}
