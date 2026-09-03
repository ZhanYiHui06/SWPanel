import type { IpcResponseEnvelope } from "@swpanel/contracts";

/**
 * Idempotency cache (architecture.md §12.1: "request ID and idempotency key").
 *
 * A command carrying the SAME `idempotencyKey` is answered from cache so the
 * Runner applies the mutation exactly once even when the client retries after a
 * dropped response — the key is a stable per-intent identifier supplied by the
 * caller and does NOT depend on the (fresh, per-attempt) requestId. Serving
 * from cache re-echoes the CURRENT request id on the stored envelope (see
 * `IpcServer.dispatch`), so the client always receives a response matching its
 * pending request. Entries expire by TTL and the cache is bounded by capacity
 * (LRU eviction).
 */

export interface IdempotencyCacheOptions {
  /** Maximum number of remembered idempotencyKey responses. */
  capacity?: number;
  /** Time-to-live of a remembered response in milliseconds. */
  ttlMs?: number;
  /** Clock used for tests; defaults to `Date.now`. */
  now?: () => number;
}

export const DEFAULT_IDEMPOTENCY_CAPACITY = 1024;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  response: IpcResponseEnvelope;
  expiresAt: number;
}

/** LRU + TTL cache keyed by the stable `idempotencyKey`. */
export class IdempotencyCache {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(options: IdempotencyCacheOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_IDEMPOTENCY_CAPACITY;
    this.ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Returns the cached response when the exact `idempotencyKey` was already
   * served and has not expired; otherwise `undefined`. The stored envelope
   * carries the ORIGINAL request id; callers must re-echo the current request
   * id when replaying it to a new request.
   */
  get(idempotencyKey: string): IpcResponseEnvelope | undefined {
    const entry = this.entries.get(idempotencyKey);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(idempotencyKey);
      return undefined;
    }
    // Refresh LRU recency.
    this.entries.delete(idempotencyKey);
    this.entries.set(idempotencyKey, entry);
    return entry.response;
  }

  /** Remembers the response for an `idempotencyKey`. */
  set(idempotencyKey: string, response: IpcResponseEnvelope): void {
    this.entries.delete(idempotencyKey);
    this.entries.set(idempotencyKey, { response, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drops every cached response (used when the server restarts a runner). */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
