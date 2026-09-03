import { describe, expect, it } from "vitest";

import { IPC_PROTOCOL_VERSION } from "@swpanel/contracts";
import type { IpcResponseEnvelope } from "@swpanel/contracts";

import {
  DEFAULT_IDEMPOTENCY_CAPACITY,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IdempotencyCache
} from "./idempotency-cache.js";

function responseFor(requestId: string, data: string): IpcResponseEnvelope {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId,
    ok: true,
    data: { tag: data }
  };
}

describe("IdempotencyCache", () => {
  it("remembers an idempotencyKey and returns it on replay", () => {
    const cache = new IdempotencyCache();
    cache.set("idem-1", responseFor("req-1", "a"));
    expect(cache.get("idem-1")?.data).toEqual({ tag: "a" });
    expect(cache.size).toBe(1);
  });

  it("keys entries by idempotencyKey alone (requestId does not participate)", () => {
    const cache = new IdempotencyCache();
    cache.set("idem-1", responseFor("req-1", "a"));
    // Same key, different requestId: the FIRST response is returned (the
    // caller re-echoes the current request id when replaying).
    expect(cache.get("idem-1")?.requestId).toBe("req-1");
    cache.set("idem-2", responseFor("req-1", "b"));
    expect(cache.size).toBe(2);
    expect(cache.get("idem-1")?.data).toEqual({ tag: "a" });
    expect(cache.get("idem-2")?.data).toEqual({ tag: "b" });
    expect(cache.get("idem-missing")).toBeUndefined();
  });

  it("expires entries by TTL", () => {
    let now = 1_000;
    const cache = new IdempotencyCache({ ttlMs: 500, now: () => now });
    cache.set("idem-1", responseFor("req-1", "a"));
    expect(cache.get("idem-1")).toBeDefined();

    now = 1_500; // exactly at expiry boundary
    expect(cache.get("idem-1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry when capacity is reached", () => {
    const cache = new IdempotencyCache({ capacity: 2 });
    cache.set("idem-1", responseFor("req-1", "a"));
    cache.set("idem-2", responseFor("req-2", "b"));
    // Touching idem-1 makes idem-2 the LRU victim.
    cache.get("idem-1");
    cache.set("idem-3", responseFor("req-3", "c"));

    expect(cache.size).toBe(2);
    expect(cache.get("idem-1")).toBeDefined();
    expect(cache.get("idem-3")).toBeDefined();
    expect(cache.get("idem-2")).toBeUndefined();
  });

  it("refresh on read only reorders LRU recency, not the TTL expiry", () => {
    // Reads update LRU ordering (eviction preference) but deliberately do NOT
    // extend the TTL: an idempotent replay window is fixed from the moment the
    // command was first executed.
    let now = 1_000;
    const cache = new IdempotencyCache({ ttlMs: 1_000, now: () => now });
    cache.set("idem-1", responseFor("req-1", "a"));
    now = 1_900;
    expect(cache.get("idem-1")).toBeDefined(); // within TTL
    now = 2_100; // past the original 2_000 expiry
    expect(cache.get("idem-1")).toBeUndefined();
  });

  it("clear() drops every entry", () => {
    const cache = new IdempotencyCache();
    cache.set("idem-1", responseFor("req-1", "a"));
    cache.set("idem-2", responseFor("req-2", "b"));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("idem-1")).toBeUndefined();
  });

  it("pins the default capacity and TTL", () => {
    expect(DEFAULT_IDEMPOTENCY_CAPACITY).toBe(1024);
    expect(DEFAULT_IDEMPOTENCY_TTL_MS).toBe(30 * 60 * 1000);
  });
});
