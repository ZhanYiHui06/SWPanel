import { describe, expect, it } from "vitest";

import { SELECTED_FILE_TOKEN_PATTERN } from "../bridge/bridge-contract.js";
import {
  SELECTED_FILE_REGISTRY_CAPACITY,
  SELECTED_FILE_TOKEN_TTL_MS,
  SelectedFileRegistry
} from "./selected-file-registry.js";

function stagedInput(token?: string) {
  return {
    absolutePath: token === undefined ? "C:\\users\\alice\\drawing.pdf" : `C:\\users\\alice\\${token}.pdf`,
    fileName: "drawing.pdf",
    format: "PDF" as const,
    sizeBytes: 1024,
    sha256: "a".repeat(64)
  };
}

function registryWithClock(start: number) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    registry: new SelectedFileRegistry({ now: () => now })
  };
}

describe("SelectedFileRegistry", () => {
  it("stages a file and returns an opaque token matching the exact pattern", () => {
    const clock = registryWithClock(1_000);
    const staged = clock.registry.stage(stagedInput());
    expect(SELECTED_FILE_TOKEN_PATTERN.test(staged.token)).toBe(true);
    expect(staged.token).toMatch(/^swsel_[0-9a-f]{32}$/);
    expect(staged.absolutePath).toBe("C:\\users\\alice\\drawing.pdf");
    expect(clock.registry.size).toBe(1);
  });

  it("consumes a token exactly once", () => {
    const clock = registryWithClock(1_000);
    const staged = clock.registry.stage(stagedInput());
    const first = clock.registry.consume(staged.token);
    expect(first.status).toBe("ok");
    if (first.status === "ok") expect(first.file.absolutePath).toBe(staged.absolutePath);
    // The token is gone; replaying it can never resolve a path again.
    expect(clock.registry.consume(staged.token).status).toBe("missing");
    expect(clock.registry.size).toBe(0);
  });

  it("expires a token after the TTL", () => {
    const clock = registryWithClock(1_000);
    const staged = clock.registry.stage(stagedInput());
    expect(clock.registry.has(staged.token)).toBe(true);
    clock.advance(SELECTED_FILE_TOKEN_TTL_MS + 1);
    expect(clock.registry.consume(staged.token).status).toBe("expired");
    // The expired token was consumed once: it can never be consumed again.
    expect(clock.registry.consume(staged.token).status).toBe("missing");
    expect(clock.registry.has(staged.token)).toBe(false);
  });

  it("evicts the oldest entries beyond capacity", () => {
    const registry = new SelectedFileRegistry({ capacity: 2, now: () => 1_000 });
    const first = registry.stage({ ...stagedInput(), sha256: "b".repeat(64) });
    const second = registry.stage({ ...stagedInput(), sha256: "c".repeat(64) });
    const third = registry.stage({ ...stagedInput(), sha256: "d".repeat(64) });
    expect(registry.size).toBe(2);
    expect(registry.has(first.token)).toBe(false);
    expect(registry.has(second.token)).toBe(true);
    expect(registry.has(third.token)).toBe(true);
  });

  it("mints unique tokens even with a colliding factory", () => {
    let call = 0;
    const registry = new SelectedFileRegistry({
      now: () => 1_000,
      tokenFactory: () => {
        call++;
        return call === 1 ? `swsel_${"0".repeat(32)}` : `swsel_${"1".repeat(32)}`;
      }
    });
    const a = registry.stage({ ...stagedInput(), sha256: "e".repeat(64) });
    const b = registry.stage({ ...stagedInput(), sha256: "f".repeat(64) });
    expect(a.token).not.toBe(b.token);
  });

  it("exposes sane defaults", () => {
    expect(SELECTED_FILE_TOKEN_TTL_MS).toBe(5 * 60 * 1000);
    expect(SELECTED_FILE_REGISTRY_CAPACITY).toBe(32);
  });

  describe("reserve / commit / release semantics", () => {
    it("a failed command releases the reservation so the token stays usable", () => {
      const clock = registryWithClock(1_000);
      const staged = clock.registry.stage(stagedInput());
      const reserved = clock.registry.reserve(staged.token);
      expect(reserved.status).toBe("ok");
      expect(clock.registry.has(staged.token)).toBe(true);

      // Failure: release instead of consume — the pick is NOT burned.
      clock.registry.release(staged.token);
      expect(clock.registry.has(staged.token)).toBe(true);

      // The retry reserves again and commits on success.
      const retried = clock.registry.reserve(staged.token);
      expect(retried.status).toBe("ok");
      clock.registry.commit(staged.token);
      expect(clock.registry.size).toBe(0);
      expect(clock.registry.reserve(staged.token).status).toBe("missing");
    });

    it("denies concurrent reservations of the same token (in_use)", () => {
      const clock = registryWithClock(1_000);
      const staged = clock.registry.stage(stagedInput());
      expect(clock.registry.reserve(staged.token).status).toBe("ok");
      expect(clock.registry.reserve(staged.token).status).toBe("in_use");
      // The staged entry is still present while reserved.
      expect(clock.registry.has(staged.token)).toBe(true);

      clock.registry.release(staged.token);
      expect(clock.registry.reserve(staged.token).status).toBe("ok");
      clock.registry.commit(staged.token);
      expect(clock.registry.size).toBe(0);
    });

    it("successful use is one-time: commit burns the token exactly once", () => {
      const clock = registryWithClock(1_000);
      const staged = clock.registry.stage(stagedInput());
      expect(clock.registry.reserve(staged.token).status).toBe("ok");
      clock.registry.commit(staged.token);
      clock.registry.commit(staged.token); // idempotent no-op
      expect(clock.registry.size).toBe(0);
      expect(clock.registry.reserve(staged.token).status).toBe("missing");
      expect(clock.registry.has(staged.token)).toBe(false);
    });

    it("an expired token cannot be reserved (expired result, entry removed)", () => {
      const clock = registryWithClock(1_000);
      const staged = clock.registry.stage(stagedInput());
      clock.advance(SELECTED_FILE_TOKEN_TTL_MS + 1);
      expect(clock.registry.reserve(staged.token).status).toBe("expired");
      expect(clock.registry.size).toBe(0);
      expect(clock.registry.reserve(staged.token).status).toBe("missing");
    });

    it("consume still burns a reserved token (backward-compatible one-shot)", () => {
      const clock = registryWithClock(1_000);
      const staged = clock.registry.stage(stagedInput());
      expect(clock.registry.reserve(staged.token).status).toBe("ok");
      const consumed = clock.registry.consume(staged.token);
      expect(consumed.status).toBe("ok");
      expect(clock.registry.size).toBe(0);
      expect(clock.registry.reserve(staged.token).status).toBe("missing");
    });
  });
});
