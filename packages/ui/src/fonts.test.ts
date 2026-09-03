import { describe, expect, it } from "vitest";

import { fonts } from "./fonts.js";

describe("fonts", () => {
  it("pins the locally bundled font families", () => {
    expect(fonts).toEqual({ sans: "Inter", mono: "JetBrains Mono" });
  });
});
