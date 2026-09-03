/**
 * WP5 Step 3 Desktop Main SafeStorage-backed API-key store.
 *
 * Stores the company-global automation API key encrypted at rest under Electron's
 * per-user data directory using `safeStorage` (DPAPI-backed on Windows). The
 * plaintext key NEVER crosses the bridge to the Renderer: the IPC surface only
 * ever exposes `getApiKeyStatus` (has + masked preview); `getApiKey` is
 * main-internal only.
 *
 * The store deliberately NEVER imports `electron` directly so it stays unit
 * testable: the `SafeStorageLike` facade and the secrets file path are injected
 * (main.ts wires the real `safeStorage` from `electron`; tests inject a fake).
 *
 * Fallback posture: when `safeStorage.isEncryptionAvailable()` is false (e.g. a
 * headless dev/test host without a usable OS keychain) the store, by default,
 * persists a clearly-marked NON-security XOR-obfuscated payload so development
 * and test flows keep working — the obfuscation is NOT a real vault and callers
 * must never rely on it for protection. `fallbackMode: "refuse"` makes a
 * production call fail closed instead.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync
} from "node:fs";
import { dirname } from "node:path";

/** Minimal Electron `safeStorage` surface used by the store (DI seam). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Filesystem facade (defaults to `node:fs`) so tests can use temp/in-memory fs. */
export interface SecretStoreFsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, data: Buffer): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, options: { recursive: true }): void;
}

/** Status exposed over the bridge: presence + a short masked preview only. */
export interface SecretApiKeyStatus {
  hasApiKey: boolean;
  /** Masked preview (e.g. `sk-****abcd`) when a key is stored, else null. */
  maskedApiKey: string | null;
}

export type SecretStoreFallbackMode = "obfuscate" | "refuse";

export interface SecretStoreDependencies {
  /** Absolute path of the encrypted secrets file (e.g. `<userData>/secrets.enc`). */
  filePath: string;
  /** Electron `safeStorage` facade used to encrypt/decrypt the payload. */
  safeStorage: SafeStorageLike;
  /** Filesystem facade; defaults to `node:fs`. */
  fs?: SecretStoreFsLike;
  /**
   * Behaviour when `safeStorage.isEncryptionAvailable()` is false:
   * - `"obfuscate"` (default): store a NON-security XOR-obfuscated payload so
   *   dev/test flows keep working (documented, never a real vault);
   * - `"refuse"`: throw {@link SecretStoreError}`ENCRYPTION_UNAVAILABLE` so a
   *   caller can never silently persist a weakly-protected key.
   */
  fallbackMode?: SecretStoreFallbackMode;
}

/** Structured failures surfaced by the store (mapped to INTERNAL over the bridge). */
export class SecretStoreError extends Error {
  readonly code: "ENCRYPTION_UNAVAILABLE" | "VAULT_CORRUPT";

  constructor(code: "ENCRYPTION_UNAVAILABLE" | "VAULT_CORRUPT", message: string) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
  }
}

/** Format version of the secrets file; a different version is refused as corrupt. */
const FORMAT_VERSION = 1 as const;

/**
 * File write mode for POSIX platforms (Windows uses the per-user profile ACL;
 * the mode is ignored). The file lives inside the user's own data directory.
 */
const SECRETS_FILE_MODE = 0o600 as const;

const FALLBACK_SALT = "swpanel.secrets.v1" as const;
const OBFUSCATION_NONCE_BYTES = 16 as const;

/** Masks a secret as `first3****last4` (short keys collapse to `****`). */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 7) return "****";
  return `${apiKey.slice(0, 3)}****${apiKey.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic pseudo-random stream (NOT a security primitive) derived from a
 * random nonce + the fixed non-secret salt. Used ONLY for the documented
 * non-encryption fallback so a plaintext key never sits literally at rest.
 */
function fallbackStream(length: number, nonce: Buffer): Buffer {
  const out = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 32) {
    createHash("sha256")
      .update(FALLBACK_SALT)
      .update(nonce)
      .update(String(Math.floor(offset / 32)))
      .digest()
      .copy(out, offset);
  }
  return out;
}

function obfuscateString(plainText: string): Buffer {
  const nonce = randomBytes(OBFUSCATION_NONCE_BYTES);
  const input = Buffer.from(plainText, "utf8");
  const stream = fallbackStream(input.length, nonce);
  const body = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i += 1) {
    body.writeUInt8(input.readUInt8(i) ^ stream.readUInt8(i), i);
  }
  return Buffer.concat([nonce, body]);
}

function deobfuscateString(payload: Buffer): string {
  if (payload.length < OBFUSCATION_NONCE_BYTES) {
    throw new SecretStoreError("VAULT_CORRUPT", "The obfuscated secrets payload is truncated");
  }
  const nonce = payload.subarray(0, OBFUSCATION_NONCE_BYTES);
  const body = payload.subarray(OBFUSCATION_NONCE_BYTES);
  const stream = fallbackStream(body.length, nonce);
  const out = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) {
    out.writeUInt8(body.readUInt8(i) ^ stream.readUInt8(i), i);
  }
  return out.toString("utf8");
}

/** Default filesystem facade over `node:fs` (owner-only write on POSIX). */
function nodeFs(): SecretStoreFsLike {
  return {
    existsSync: nodeExistsSync,
    readFileSync: nodeReadFileSync,
    writeFileSync: (path, data) => nodeWriteFileSync(path, data, { mode: SECRETS_FILE_MODE }),
    renameSync: nodeRenameSync,
    unlinkSync: nodeUnlinkSync,
    mkdirSync: nodeMkdirSync
  };
}

export class SecretStore {
  private readonly filePath: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly fs: SecretStoreFsLike;
  private readonly fallbackMode: SecretStoreFallbackMode;

  constructor(deps: SecretStoreDependencies) {
    this.filePath = deps.filePath;
    this.safeStorage = deps.safeStorage;
    this.fs = deps.fs ?? nodeFs();
    this.fallbackMode = deps.fallbackMode ?? "obfuscate";
  }

  /**
   * Stores the API key, replacing any previous value. The key is encrypted with
   * `safeStorage` when available; otherwise (and only with the `"obfuscate"`
   * fallback) it stores the documented non-security obfuscated form. The write
   * is atomic (temp file + rename) so a crash can never leave a torn vault.
   */
  setApiKey(apiKey: string): Promise<void> {
    return Promise.resolve().then(() => {
      const payloadInfo = this.encryptPayload(apiKey);
      const payload = Buffer.from(
        JSON.stringify({
          formatVersion: FORMAT_VERSION,
          method: payloadInfo.method,
          data: payloadInfo.data.toString("base64")
        }),
        "utf8"
      );
      this.fs.mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      this.fs.writeFileSync(tmpPath, payload);
      try {
        this.fs.renameSync(tmpPath, this.filePath);
      } catch (error) {
        // Best effort: never leave the temp file behind on a failed rename.
        try {
          this.fs.unlinkSync(tmpPath);
        } catch {
          // best effort
        }
        throw error;
      }
    });
  }

  /**
   * Returns the plaintext key for main-internal use only, or null when none is
   * stored. Throws {@link SecretStoreError}`VAULT_CORRUPT` on a malformed or
   * undecryptable vault — a real key must never silently look absent.
   */
  getApiKey(): Promise<string | null> {
    return Promise.resolve().then(() => this.readPlaintext());
  }

  /** Presence + masked preview for the bridge; the plaintext never leaves Main. */
  getApiKeyStatus(): Promise<SecretApiKeyStatus> {
    return Promise.resolve().then(() => {
      const apiKey = this.readPlaintext();
      if (apiKey === null) return { hasApiKey: false, maskedApiKey: null };
      return { hasApiKey: true, maskedApiKey: maskApiKey(apiKey) };
    });
  }

  /** Removes any stored key (no error when the vault is already gone). */
  clearApiKey(): Promise<void> {
    return Promise.resolve().then(() => {
      if (!this.fs.existsSync(this.filePath)) return;
      this.fs.unlinkSync(this.filePath);
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private encryptPayload(apiKey: string): { method: "safeStorage" | "obfuscated"; data: Buffer } {
    if (this.safeStorage.isEncryptionAvailable()) {
      return { method: "safeStorage", data: this.safeStorage.encryptString(apiKey) };
    }
    if (this.fallbackMode === "refuse") {
      throw new SecretStoreError(
        "ENCRYPTION_UNAVAILABLE",
        "safeStorage encryption is unavailable; refusing to store the API key at rest"
      );
    }
    // Documented NON-security fallback for dev/test hosts only.
    return { method: "obfuscated", data: obfuscateString(apiKey) };
  }

  private readPlaintext(): string | null {
    if (!this.fs.existsSync(this.filePath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.fs.readFileSync(this.filePath).toString("utf8"));
    } catch (error) {
      throw new SecretStoreError(
        "VAULT_CORRUPT",
        `The secrets file could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.formatVersion !== FORMAT_VERSION ||
      typeof parsed.data !== "string" ||
      typeof parsed.method !== "string"
    ) {
      throw new SecretStoreError("VAULT_CORRUPT", "The secrets file has an unsupported shape");
    }
    const data = Buffer.from(parsed.data, "base64");
    try {
      switch (parsed.method) {
        case "safeStorage":
          return this.safeStorage.decryptString(data);
        case "obfuscated":
          return deobfuscateString(data);
        default:
          throw new SecretStoreError(
            "VAULT_CORRUPT",
            `The secrets file uses an unknown protection method: ${parsed.method}`
          );
      }
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError("VAULT_CORRUPT", "The secrets file could not be decrypted");
    }
  }
}
