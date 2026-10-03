import { afterEach, describe, expect, it, vi } from "vitest";

import { randomId } from "./ids.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe("randomId", () => {
  it("returns a v4 UUID", () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  it("falls back to getRandomValues when randomUUID is unavailable (non-secure context)", () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const first = randomId();
    expect(first).toMatch(UUID_V4);
    expect(randomId()).not.toBe(first);
  });

  it("still produces a UUID without any Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(randomId()).toMatch(UUID_V4);
  });
});
