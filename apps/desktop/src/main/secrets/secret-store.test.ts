import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  maskApiKey,
  SecretStore,
  SecretStoreError,
  type SafeStorageLike
} from "./secret-store.js";

/**
 * A reversible test-only facade standing in for Electron `safeStorage`: it
 * proves the plaintext never rests unchanged in the vault. The REAL store is
 * wired to Electron's DPAPI-backed `safeStorage` in main.ts.
 */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(plainText, "utf8").reverse(),
    decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString("utf8")
  };
}

describe("maskApiKey", () => {
  it("masks a long key as first3 + **** + last4", () => {
    expect(maskApiKey("sk-proj-abc1234567890wxyz")).toBe("sk-****wxyz");
  });

  it("collapses short keys to a full mask (never leaks length fragments)", () => {
    expect(maskApiKey("abc")).toBe("****");
    expect(maskApiKey("abcdef")).toBe("****");
    expect(maskApiKey("1234567")).toBe("****");
  });

  it("handles the exact threshold edge deterministically", () => {
    // 8 chars: first 3 + **** + last 4 -> "abc****efgh"
    expect(maskApiKey("abcdefgh")).toBe("abc****efgh");
  });
});

describe("SecretStore", () => {
  const tempDirs: string[] = [];

  function newVault(
    overrides: {
      available?: boolean;
      fallbackMode?: "obfuscate" | "refuse";
      filePath?: string;
    } = {}
  ): { store: SecretStore; filePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "swpanel-secrets-"));
    tempDirs.push(dir);
    const filePath = overrides.filePath ?? join(dir, "secrets.enc");
    const store = new SecretStore({
      filePath,
      safeStorage: fakeSafeStorage(overrides.available ?? true),
      ...(overrides.fallbackMode === undefined ? {} : { fallbackMode: overrides.fallbackMode })
    });
    return { store, filePath };
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop() as string;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts empty: no key, no masked preview", async () => {
    const { store } = newVault();
    expect(await store.getApiKey()).toBeNull();
    expect(await store.getApiKeyStatus()).toEqual({ hasApiKey: false, maskedApiKey: null });
  });

  it("set/get round-trips the plaintext for main-internal use", async () => {
    const { store } = newVault();
    const key = "sk-proj-0123456789abcdef";
    await store.setApiKey(key);
    expect(await store.getApiKey()).toBe(key);
  });

  it("getApiKeyStatus returns a masked preview, never the plaintext", async () => {
    const { store } = newVault();
    await store.setApiKey("sk-proj-0123456789abcdefghijkl0123abcd");
    const status = await store.getApiKeyStatus();
    expect(status.hasApiKey).toBe(true);
    expect(status.maskedApiKey).toBe("sk-****abcd");
    expect(status.maskedApiKey).not.toContain("0123456789");
    expect(JSON.stringify(status)).not.toContain("sk-proj-0123456789");
  });

  it("persists across instances (file-backed), silently overwriting the previous key", async () => {
    const { filePath } = newVault();
    const first = new SecretStore({ filePath, safeStorage: fakeSafeStorage() });
    await first.setApiKey("key-one");
    const second = new SecretStore({ filePath, safeStorage: fakeSafeStorage() });
    expect(await second.getApiKey()).toBe("key-one");

    await second.setApiKey("key-two");
    const third = new SecretStore({ filePath, safeStorage: fakeSafeStorage() });
    expect(await third.getApiKey()).toBe("key-two");
    // "key-two" is exactly 7 chars, so the preview collapses to a full mask.
    expect(await third.getApiKeyStatus()).toEqual({
      hasApiKey: true,
      maskedApiKey: "****"
    });
  });

  it("clearApiKey removes the stored key and survives repeated clears", async () => {
    const { store } = newVault();
    await store.setApiKey("sk-proj-clear-me");
    expect(await store.getApiKey()).toBe("sk-proj-clear-me");
    await store.clearApiKey();
    expect(await store.getApiKey()).toBeNull();
    expect(await store.getApiKeyStatus()).toEqual({ hasApiKey: false, maskedApiKey: null });
    await store.clearApiKey();
    expect(await store.getApiKey()).toBeNull();
  });

  it("never writes the plaintext literally into the vault file (safeStorage path)", async () => {
    const { store, filePath } = newVault({ available: true });
    const key = "sk-proj-totally-secret-key";
    await store.setApiKey(key);
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain(key);
    // The encrypted payload is a transformed (reversed) buffer, never the key.
    expect(raw).not.toContain("totally-secret");
  });

  it("falls back to obfuscation when encryption is unavailable, still no plaintext at rest", async () => {
    const { store, filePath } = newVault({ available: false, fallbackMode: "obfuscate" });
    const key = "sk-proj-fallback-secret";
    await store.setApiKey(key);
    expect(await store.getApiKey()).toBe(key);
    expect(await store.getApiKeyStatus()).toEqual({ hasApiKey: true, maskedApiKey: "sk-****cret" });
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain(key);
    expect(raw).not.toContain("fallback-secret");
  });

  it("refuses to store when encryption is unavailable in refuse mode", async () => {
    const { store } = newVault({ available: false, fallbackMode: "refuse" });
    await expect(store.setApiKey("sk-proj-refused")).rejects.toMatchObject({
      name: "SecretStoreError",
      code: "ENCRYPTION_UNAVAILABLE"
    });
    // Nothing was persisted.
    expect(await store.getApiKey()).toBeNull();
  });

  it("treats a malformed vault as VAULT_CORRUPT instead of pretending there is no key", async () => {
    const { store, filePath } = newVault();
    writeFileSync(filePath, "{ this is not json", "utf8");
    await expect(store.getApiKey()).rejects.toMatchObject({
      name: "SecretStoreError",
      code: "VAULT_CORRUPT"
    });
    await expect(store.getApiKeyStatus()).rejects.toMatchObject({
      name: "SecretStoreError",
      code: "VAULT_CORRUPT"
    });
  });

  it("treats an unsupported format/version/method as VAULT_CORRUPT", async () => {
    const { store, filePath } = newVault();
    writeFileSync(
      filePath,
      JSON.stringify({ formatVersion: 999, method: "safeStorage", data: "AAAA" }),
      "utf8"
    );
    await expect(store.getApiKey()).rejects.toMatchObject({
      name: "SecretStoreError",
      code: "VAULT_CORRUPT"
    });

    writeFileSync(
      filePath,
      JSON.stringify({ formatVersion: 1, method: "rot13", data: "AAAA" }),
      "utf8"
    );
    await expect(store.getApiKey()).rejects.toMatchObject({
      name: "SecretStoreError",
      code: "VAULT_CORRUPT"
    });
  });

  it("a failed safeStorage decrypt surfaces VAULT_CORRUPT, never the raw payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swpanel-secrets-bad-"));
    tempDirs.push(dir);
    const filePath = join(dir, "secrets.enc");
    // Write a well-formed safeStorage vault whose payload the (throwing) safe
    // storage cannot decrypt — the store must surface VAULT_CORRUPT, never the
    // encrypted buffer or a phantom "no key".
    writeFileSync(
      filePath,
      JSON.stringify({
        formatVersion: 1,
        method: "safeStorage",
        data: Buffer.from("not-a-valid-encrypted-blob", "utf8").toString("base64")
      }),
      "utf8"
    );
    const throwingSafeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => Buffer.from(plainText, "utf8"),
      decryptString: () => {
        throw new Error("DPAPI could not decrypt the stored blob");
      }
    };
    const store = new SecretStore({ filePath, safeStorage: throwingSafeStorage });
    await expect(store.getApiKey()).rejects.toBeInstanceOf(SecretStoreError);
    await expect(store.getApiKey()).rejects.toMatchObject({ code: "VAULT_CORRUPT" });
  });

  it("creates the parent directory when it does not exist yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swpanel-secrets-dir-"));
    tempDirs.push(dir);
    const nested = join(dir, "nested", "deeper", "secrets.enc");
    const store = new SecretStore({ filePath: nested, safeStorage: fakeSafeStorage() });
    await store.setApiKey("sk-proj-nested");
    expect(await store.getApiKey()).toBe("sk-proj-nested");
  });
});
