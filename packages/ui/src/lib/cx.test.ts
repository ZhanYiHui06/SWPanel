import { describe, expect, it } from "vitest";

import { cx } from "./cx.js";

describe("cx", () => {
  it("joins truthy class names", () => {
    expect(cx("a", "b", "c")).toBe("a b c");
  });

  it("filters false/null/undefined", () => {
    expect(cx("a", false, null, undefined, "b")).toBe("a b");
  });

  it("returns an empty string for no truthy parts", () => {
    expect(cx(false, null)).toBe("");
  });
});
