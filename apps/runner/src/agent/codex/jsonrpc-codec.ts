/**
 * Strict NDJSON JSON-RPC core for the USED subset of the Codex App Server
 * protocol 0.147.0 (Phase 5, P5-3). The wire envelopes follow the actual
 * 0.147.0 schema documents in `.scratch/codex-app-server-schema-0.147.0`
 * (JSONRPCMessage / JSONRPCRequest / JSONRPCResponse / JSONRPCError /
 * JSONRPCNotification):
 *
 * - request:  { id, method, params? }            (id + method required)
 * - response: { id, result }                     (id + result required)
 * - error:    { id, error: { code, message, data? } }
 * - notification: { method, params? }            (method required, NO id)
 *
 * NOTE: the 0.147.0 envelopes carry NO `jsonrpc` version field — this codec
 * never invents one. `RequestId` is a string OR an integer (never null).
 * Incoming server→client REQUESTS are outside the used subset and rejected as
 * a protocol incompatibility.
 *
 * Transport framing is NDJSON: exactly one message per line, `\n`-terminated
 * (a trailing `\r` is tolerated for Windows hosts). A line larger than the
 * configured maximum is rejected (OVERSIZED) BEFORE parsing, so a hostile or
 * malformed peer cannot exhaust memory through one giant line; chunk input is
 * split at line boundaries with the incomplete tail preserved for the next
 * chunk.
 */

/** Default maximum size of one NDJSON line in UTF-8 bytes (8 MiB). */
export const JSON_RPC_DEFAULT_MAX_LINE_BYTES = 8_388_608;

/** The 0.147.0 `RequestId` union: string or integer (never null). */
export type JsonRpcRequestId = string | number;

export interface JsonRpcRequest {
  id: JsonRpcRequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: JsonRpcRequestId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  id: JsonRpcRequestId;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcErrorResponse;

/** Classification of a decoded line. `request` = an incoming server request. */
export type JsonRpcLineKind = "request" | "notification" | "response" | "error_response";

export interface DecodedJsonRpcLine {
  kind: JsonRpcLineKind;
  message: JsonRpcMessage;
}

/** Structured codec failure (never raw peer content). */
export type JsonRpcCodecErrorCode = "MALFORMED" | "OVERSIZED";

export class JsonRpcCodecError extends Error {
  readonly code: JsonRpcCodecErrorCode;
  readonly lineBytes: number;

  constructor(code: JsonRpcCodecErrorCode, message: string, lineBytes: number) {
    super(message);
    this.name = "JsonRpcCodecError";
    this.code = code;
    this.lineBytes = lineBytes;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is JsonRpcRequestId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isErrorObject(value: unknown): value is JsonRpcErrorObject {
  if (!isRecord(value)) return false;
  if (typeof value.code !== "number" || !Number.isSafeInteger(value.code)) return false;
  if (typeof value.message !== "string") return false;
  return true;
}

function nonEmptyMethod(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function fail(
  code: JsonRpcCodecErrorCode,
  message: string,
  lineBytes: number
): never {
  throw new JsonRpcCodecError(code, message, lineBytes);
}

/** Returns the UTF-8 byte length of the line. */
export function jsonRpcLineBytes(line: string): number {
  return Buffer.byteLength(line, "utf8");
}

/**
 * Encodes ONE message into a single NDJSON line (no trailing newline — the
 * transport delimits lines). The envelope is validated BEFORE serialization:
 * a malformed envelope is a caller bug and throws {@link JsonRpcCodecError}.
 */
export function encodeJsonRpcLine(message: JsonRpcMessage, maxLineBytes = JSON_RPC_DEFAULT_MAX_LINE_BYTES): string {
  if (!isRecord(message)) {
    fail("MALFORMED", "a JSON-RPC message must be a JSON object", 0);
  }
  if ("id" in message) {
    if (!isRequestId(message.id)) {
      fail("MALFORMED", "a JSON-RPC message id must be a string or an integer", 0);
    }
    if ("error" in message) {
      if (!isErrorObject(message.error)) {
        fail("MALFORMED", "a JSON-RPC error response error must carry code + message", 0);
      }
      if ("method" in message || "result" in message) {
        fail("MALFORMED", "a JSON-RPC error response cannot also carry method/result", 0);
      }
    } else if ("result" in message) {
      if ("method" in message) {
        fail("MALFORMED", "a JSON-RPC response cannot also carry a method", 0);
      }
    } else if ("method" in message) {
      if (!nonEmptyMethod(message.method)) {
        fail("MALFORMED", "a JSON-RPC request method must be a non-empty string", 0);
      }
    } else {
      fail("MALFORMED", "a JSON-RPC message with an id must be a request, response or error response", 0);
    }
  } else {
    if (!("method" in message) || !nonEmptyMethod(message.method)) {
      fail("MALFORMED", "a JSON-RPC notification must carry a non-empty method and no id", 0);
    }
  }
  const line = JSON.stringify(message);
  const bytes = jsonRpcLineBytes(line);
  if (bytes > maxLineBytes) {
    fail("OVERSIZED", `encoded JSON-RPC line exceeds the ${maxLineBytes}-byte limit`, bytes);
  }
  return line;
}

/**
 * Decodes + strictly validates ONE NDJSON line. Throws {@link JsonRpcCodecError}
 * on malformed JSON, a non-object message, an invalid id, an ambiguous
 * envelope (both result and error, etc.) or an oversized line.
 */
export function decodeJsonRpcLine(
  line: string,
  maxLineBytes = JSON_RPC_DEFAULT_MAX_LINE_BYTES
): DecodedJsonRpcLine {
  const bytes = jsonRpcLineBytes(line);
  if (bytes > maxLineBytes) {
    fail("OVERSIZED", `JSON-RPC line exceeds the ${maxLineBytes}-byte limit`, bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail("MALFORMED", "JSON-RPC line is not valid JSON", bytes);
  }
  if (!isRecord(parsed)) {
    fail("MALFORMED", "a JSON-RPC message must be a JSON object", bytes);
  }
  if ("id" in parsed) {
    if (!isRequestId(parsed.id)) {
      fail("MALFORMED", "a JSON-RPC message id must be a string or an integer", bytes);
    }
    if ("error" in parsed) {
      if (!isErrorObject(parsed.error)) {
        fail("MALFORMED", "a JSON-RPC error response error must carry code + message", bytes);
      }
      if ("method" in parsed || "result" in parsed) {
        fail("MALFORMED", "a JSON-RPC error response cannot also carry method/result", bytes);
      }
      return {
        kind: "error_response",
        message: { id: parsed.id, error: parsed.error }
      };
    }
    if ("result" in parsed) {
      if ("method" in parsed) {
        fail("MALFORMED", "a JSON-RPC response cannot also carry a method", bytes);
      }
      return { kind: "response", message: { id: parsed.id, result: parsed.result } };
    }
    if ("method" in parsed) {
      if (!nonEmptyMethod(parsed.method)) {
        fail("MALFORMED", "a JSON-RPC request method must be a non-empty string", bytes);
      }
      // Server→client requests exist in the full protocol but are OUTSIDE the
      // used subset of this client: they surface as a protocol incompatibility.
      return {
        kind: "request",
        message: {
          id: parsed.id,
          method: parsed.method,
          ...(parsed.params === undefined ? {} : { params: parsed.params })
        }
      };
    }
    fail("MALFORMED", "a JSON-RPC message with an id must be a request, response or error response", bytes);
  }
  if (!("method" in parsed) || !nonEmptyMethod(parsed.method)) {
    fail("MALFORMED", "a JSON-RPC notification must carry a non-empty method and no id", bytes);
  }
  return {
    kind: "notification",
    message: {
      method: parsed.method,
      ...(parsed.params === undefined ? {} : { params: parsed.params })
    }
  };
}

export interface SplitJsonRpcChunkResult {
  /** Complete NDJSON lines of the chunk, in order, WITHOUT their delimiter. */
  lines: string[];
  /** Incomplete trailing line (no `\n` yet) to prepend to the next chunk. */
  remainder: string;
}

/**
 * Splits an NDJSON chunk into complete lines + the incomplete tail. A trailing
 * `\r` is stripped (Windows host tolerance). An OVERSIZED complete line is
 * rejected BEFORE it is returned — a peer that exceeds the limit is a protocol
 * violation, never memory pressure.
 */
export function splitJsonRpcChunk(
  chunk: string,
  maxLineBytes = JSON_RPC_DEFAULT_MAX_LINE_BYTES
): SplitJsonRpcChunkResult {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < chunk.length; index++) {
    if (chunk.charCodeAt(index) !== 10 /* \n */) continue;
    let line = chunk.slice(start, index);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (jsonRpcLineBytes(line) > maxLineBytes) {
      fail("OVERSIZED", `JSON-RPC line exceeds the ${maxLineBytes}-byte limit`, jsonRpcLineBytes(line));
    }
    lines.push(line);
    start = index + 1;
  }
  return { lines, remainder: chunk.slice(start) };
}
