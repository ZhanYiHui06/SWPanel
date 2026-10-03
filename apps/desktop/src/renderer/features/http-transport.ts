/** Browser-only transport shared by the HTTP repository adapters. */
import { sha256Bytes } from "./sha256.js";

export interface HttpRepositoryOptions {
  baseUrl?: string;
}

type RepositoryErrorConstructor = new (code: string, message: string) => Error;

export class HttpTransport {
  readonly baseUrl: string;

  constructor(options: HttpRepositoryOptions, private readonly ErrorType: RepositoryErrorConstructor) {
    this.baseUrl = (options.baseUrl ?? (typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3001")).replace(/\/$/, "");
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch {
      throw new this.ErrorType("NETWORK_ERROR", "无法连接 Web API 服务");
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new this.ErrorType(response.ok ? "INVALID_RESPONSE" : "NETWORK_ERROR", `HTTP ${response.status}: 服务响应无效`);
    }
    if (typeof envelope !== "object" || envelope === null || !("ok" in envelope)) {
      throw new this.ErrorType("INVALID_RESPONSE", "Web API 响应缺少结果信封");
    }
    if (envelope.ok === false && "error" in envelope && typeof envelope.error === "object" && envelope.error !== null) {
      const error = envelope.error as { code?: unknown; message?: unknown };
      throw new this.ErrorType(typeof error.code === "string" ? error.code : "UNKNOWN", typeof error.message === "string" ? error.message : "Web API 请求失败");
    }
    if (!response.ok) throw new this.ErrorType("NETWORK_ERROR", `HTTP ${response.status}: ${response.statusText}`);
    if (envelope.ok !== true || !("data" in envelope)) throw new this.ErrorType("INVALID_RESPONSE", "Web API 响应缺少数据");
    return envelope.data as T;
  }

  query<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
    return this.post<T>("/api/query", { operation, payload });
  }

  command<T>(operation: string, payload: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    return this.post<T>("/api/command", { operation, payload: { command: operation, ...payload }, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  }
}

/** Same submission and semantic content survive regenerated transport timestamps. */
export async function httpIntentKey(operation: string, clientIntentId: string, payload: Record<string, unknown>): Promise<string> {
  const semantic = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "createdAt" && key !== "createdBy"));
  const bytes = new TextEncoder().encode(JSON.stringify({ operation, clientIntentId, ...semantic }));
  // `crypto.subtle` only exists in secure contexts (HTTPS / localhost); plain
  // HTTP intranet deployments fall back to an identical pure-JS SHA-256, so the
  // key is the same either way (the server only requires a non-empty string).
  const subtle = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto.subtle;
  const digest = subtle === undefined ? sha256Bytes(bytes) : new Uint8Array(await subtle.digest("SHA-256", bytes));
  return `intent:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
