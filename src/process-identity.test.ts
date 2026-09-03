import { describe, expect, it } from "vitest";

import {
  createIdentityProvider,
  queryProcessIdentity
} from "../scripts/process-identity.mjs";

describe("process identity provider", () => {
  it("returns null for a pid that cannot exist", async () => {
    const provider = createIdentityProvider();
    expect(await provider(99999999)).toBeNull();
  });

  it("returns null for invalid pids", async () => {
    expect(await queryProcessIdentity(0)).toBeNull();
    expect(await queryProcessIdentity(-1)).toBeNull();
    expect(await queryProcessIdentity(Number.NaN)).toBeNull();
  });

  it(
    "queries the current process start time and it matches the recorded one",
    async () => {
      const identity = await queryProcessIdentity(process.pid);
      expect(identity).not.toBeNull();
      expect(identity?.pid).toBe(process.pid);
      expect(identity?.startTime).toBeGreaterThan(0);
      expect(Number.isFinite(identity?.startTime)).toBe(true);
      // A second query must be stable: the start time is fixed for a process.
      const again = await queryProcessIdentity(process.pid);
      expect(again?.startTime).toBe(identity?.startTime);
    }
  );
});
