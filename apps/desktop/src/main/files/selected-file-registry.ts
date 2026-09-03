/**
 * Bounded, one-use registry of user-picked drawing files (WP5).
 *
 * The Renderer selects a drawing through the native dialog; Main validates and
 * hashes the file, registers it with the Runner, and stores the absolute path
 * HERE under an opaque one-use token. `importDrawing` / `addRevision` consume
 * the token exactly once (bounded TTL + capacity), so the Renderer can never
 * replay an arbitrary path: a path only exists in Main memory for the lifetime
 * of its token, and the absolute path never crosses the bridge.
 */

import { randomBytes } from "node:crypto";

import type { DrawingFileFormat } from "@swpanel/domain";

import {
  SELECTED_FILE_TOKEN_PATTERN,
  SELECTED_FILE_TOKEN_PREFIX
} from "../bridge/bridge-contract.js";

/** Default TTL of a staged file token. */
export const SELECTED_FILE_TOKEN_TTL_MS = 5 * 60 * 1000;
/** Default maximum number of concurrently staged files. */
export const SELECTED_FILE_REGISTRY_CAPACITY = 32;

export interface SelectedFileRegistryOptions {
  /** Token lifetime in milliseconds (default 5 minutes). */
  ttlMs?: number;
  /** Maximum staged entries; oldest are evicted first (default 32). */
  capacity?: number;
  /** Clock for tests. */
  now?: () => number;
  /** Token factory for tests; defaults to a CSPRNG token. */
  tokenFactory?: () => string;
}

/** A staged, validated source file held by the registry. */
export interface StagedSourceFile {
  readonly token: string;
  readonly absolutePath: string;
  readonly fileName: string;
  readonly format: DrawingFileFormat;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type ConsumeSelectedFileResult =
  | { readonly status: "ok"; readonly file: StagedSourceFile }
  | { readonly status: "missing" }
  | { readonly status: "expired" };

export type ReserveSelectedFileResult =
  | { readonly status: "ok"; readonly file: StagedSourceFile }
  | { readonly status: "missing" }
  | { readonly status: "expired" }
  | { readonly status: "in_use" };

export function defaultSelectedFileTokenFactory(): string {
  return `${SELECTED_FILE_TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
}

export class SelectedFileRegistry {
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly entries = new Map<string, StagedSourceFile>();
  /** Tokens currently RESERVED by an in-flight command (not yet consumed). */
  private readonly reservedTokens = new Set<string>();

  constructor(options: SelectedFileRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? SELECTED_FILE_TOKEN_TTL_MS;
    this.capacity = options.capacity ?? SELECTED_FILE_REGISTRY_CAPACITY;
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? defaultSelectedFileTokenFactory;
  }

  get size(): number {
    this.purge();
    return this.entries.size;
  }

  /**
   * Stages a validated file and returns its opaque token + metadata. Absolute
   * paths never leave the registry. Expired entries are purged and the oldest
   * entries are evicted when the registry is at capacity.
   */
  stage(input: {
    absolutePath: string;
    fileName: string;
    format: DrawingFileFormat;
    sizeBytes: number;
    sha256: string;
  }): StagedSourceFile {
    this.purge();
    const token = this.mintUniqueToken();
    const createdAt = this.now();
    const entry: StagedSourceFile = {
      token,
      absolutePath: input.absolutePath,
      fileName: input.fileName,
      format: input.format,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      createdAt,
      expiresAt: createdAt + this.ttlMs
    };
    this.entries.set(token, entry);
    // Evict oldest beyond capacity (Map preserves insertion order).
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  /**
   * Consumes a token EXACTLY ONCE. The entry is removed regardless of whether
   * it is still valid, so a replayed token can never be consumed twice.
   */
  consume(token: string): ConsumeSelectedFileResult {
    const entry = this.entries.get(token);
    if (entry === undefined) return { status: "missing" };
    this.entries.delete(token);
    this.reservedTokens.delete(token);
    if (this.now() > entry.expiresAt) return { status: "expired" };
    return { status: "ok", file: entry };
  }

  /**
   * Reserves a token for an in-flight command WITHOUT burning it. A reserved
   * token cannot be reserved again (concurrent replay protection); the caller
   * must end every reservation with exactly one `commit` (success: burn the
   * token) or `release` (failure: token usable again for a retry).
   */
  reserve(token: string): ReserveSelectedFileResult {
    const entry = this.entries.get(token);
    if (entry === undefined) return { status: "missing" };
    if (this.now() > entry.expiresAt) {
      this.entries.delete(token);
      this.reservedTokens.delete(token);
      return { status: "expired" };
    }
    if (this.reservedTokens.has(token)) return { status: "in_use" };
    this.reservedTokens.add(token);
    return { status: "ok", file: entry };
  }

  /**
   * Burns a previously RESERVED token exactly once (successful use). The entry
   * is removed regardless of validity, matching `consume`.
   */
  commit(token: string): void {
    const entry = this.entries.get(token);
    this.reservedTokens.delete(token);
    if (entry === undefined) return;
    this.entries.delete(token);
  }

  /**
   * Releases a RESERVED token after a failed command so the user can retry with
   * the same pick. Missing/never-reserved tokens are a no-op.
   */
  release(token: string): void {
    this.reservedTokens.delete(token);
  }

  /** True when the token is currently staged and not expired. */
  has(token: string): boolean {
    const entry = this.entries.get(token);
    if (entry === undefined) return false;
    if (this.now() > entry.expiresAt) {
      this.entries.delete(token);
      return false;
    }
    return true;
  }

  private mintUniqueToken(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const token = this.tokenFactory();
      if (SELECTED_FILE_TOKEN_PATTERN.test(token) && !this.entries.has(token)) {
        return token;
      }
    }
    throw new Error("Unable to mint a unique selected-file token");
  }

  private purge(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(token);
        this.reservedTokens.delete(token);
      }
    }
  }
}
