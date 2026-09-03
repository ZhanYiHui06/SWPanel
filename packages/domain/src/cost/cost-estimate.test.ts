import { describe, expect, it } from "vitest";

import { COST_CURRENCIES, STOCK_TYPES } from "./cost-estimate.js";

describe("cost estimate domain types", () => {
  it("defines the supported stock types", () => {
    expect(STOCK_TYPES).toEqual(["CYLINDER", "RECTANGULAR_BAR"]);
  });

  it("pins the supported currency set", () => {
    expect(COST_CURRENCIES).toEqual(["CNY"]);
  });
});
