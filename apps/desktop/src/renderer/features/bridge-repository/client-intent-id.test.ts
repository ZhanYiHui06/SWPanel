import { describe, expect, it } from "vitest";

import { CLIENT_INTENT_ID_PATTERN } from "../../../main/bridge/bridge-contract.js";
import { newClientIntentId } from "./client-intent-id.js";

describe("newClientIntentId", () => {
  it("mints unique opaque ids matching the exact Main-validated token shape", () => {
    const ids = new Set(Array.from({ length: 64 }, () => newClientIntentId()));
    expect(ids.size).toBe(64);
    for (const id of ids) {
      expect(id).toMatch(CLIENT_INTENT_ID_PATTERN);
    }
  });
});
