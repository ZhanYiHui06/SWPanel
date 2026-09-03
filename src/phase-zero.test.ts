import { describe, expect, it } from "vitest";

import { hasPhaseZeroBaseline, phaseZeroBaseline } from "./phase-zero.js";

describe("Phase 0 engineering selections", () => {
  it("pins each selected technology", () => {
    expect(phaseZeroBaseline).toEqual({
      desktopShell: "electron",
      frontend: "react-typescript-vite",
      runner: "node",
      modelingSkill: "solidworks-autobuild"
    });
  });

  it("keeps every selected technology value non-empty", () => {
    expect(hasPhaseZeroBaseline()).toBe(true);
  });
});
