import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256.js";

describe("sha256Hex (pure JS fallback)", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
  });

  it("matches crypto.subtle for multi-block unicode input", async () => {
    const text = "江海冶金".repeat(100);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(sha256Hex(text)).toBe(expected);
  });
});
