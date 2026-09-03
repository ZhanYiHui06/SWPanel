import { describe, expect, it } from "vitest";

import { STORAGE_CONSTRAINTS } from "./settings.js";

describe("storage settings", () => {
  it("exposes exactly the local fixed NTFS constraint", () => {
    expect(STORAGE_CONSTRAINTS).toEqual(["LOCAL_FIXED_NTFS"]);
  });

  it("serializes a settings record as plain JSON", () => {
    const settings = {
      dataRoot: "C:\\Users\\engineer\\AppData\\Local\\JANGHI\\SWPanel",
      workspaceRoot: "C:\\Users\\engineer\\AppData\\Local\\JANGHI\\SWPanel\\workspaces",
      constraint: "LOCAL_FIXED_NTFS" as const,
      updatedAt: "2026-08-12T10:00:00.000Z"
    };
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
  });
});
