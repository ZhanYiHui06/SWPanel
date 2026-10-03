import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "../errors.js";
import {
  calculateCostEstimate,
  DEFAULT_STEEL_DENSITY,
  DEFAULT_STOCK_VOLUME_FACTOR,
  MAX_COST_QUANTITY,
  parseStockSpec,
  roundCny
} from "./calculator.js";
import type { AllowanceValue, CostDataSnapshot, FixedCostValue, MaterialCostValue } from "./cost-data.js";
import type { CostEstimateInputSnapshot } from "./cost-estimate.js";

// ---------------------------------------------------------------------------
// Fixture builders mirroring the canonical visual fixture values
// (apps/desktop/src/renderer/fixtures/cost-data.ts / cost-reports.ts).
// ---------------------------------------------------------------------------

const CANONICAL_FINISHED_VOLUME = 0.031;

function material(overrides: Partial<MaterialCostValue> = {}): MaterialCostValue {
  return {
    id: "material-42crmo",
    name: "42CrMo",
    purchasePrice: 5200,
    priceUnit: "元/吨",
    density: 7.85,
    densityUnit: "g/cm³",
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

function fixedCost(overrides: Partial<FixedCostValue> = {}): FixedCostValue {
  return {
    id: "fixed-base",
    name: "基础加工成本",
    amount: 500,
    currency: "CNY",
    basis: "PER_PIECE",
    defaultEnabled: true,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

const CANONICAL_FIXED_COSTS: readonly FixedCostValue[] = [
  fixedCost(),
  fixedCost({
    id: "fixed-inspection",
    name: "检测成本",
    amount: 100,
    basis: "PER_PIECE"
  }),
  fixedCost({
    id: "fixed-packaging",
    name: "包装成本",
    amount: 80,
    basis: "PER_BATCH"
  })
];

function costData(overrides: Partial<CostDataSnapshot> = {}): CostDataSnapshot {
  return {
    materials: [material()],
    allowances: [],
    fixedCosts: CANONICAL_FIXED_COSTS,
    customFields: [],
    capturedAt: "2026-08-10T23:21:00.000Z",
    ...overrides
  };
}

function makeInput(overrides: Partial<CostEstimateInputSnapshot> = {}): CostEstimateInputSnapshot {
  return {
    drawingId: "drawing-1",
    revisionId: "rev-3",
    modelId: "model-3",
    quantity: 10,
    materialId: material().id,
    stockType: "CYLINDER",
    stockSpec: "Ø320 × 820 mm",
    finishedVolume: CANONICAL_FINISHED_VOLUME,
    allowances: [],
    costData: costData(),
    formulaVersion: "7.0",
    capturedAt: "2026-08-10T23:21:00.000Z",
    ...overrides
  };
}

/** Exact mass in kg for the canonical finished volume at 7.85 g/cm³. */
const CANONICAL_MASS_KG = CANONICAL_FINISHED_VOLUME * DEFAULT_STEEL_DENSITY * 1000; // 243.35

/** Geometric volume of the canonical Ø320 × 820 mm cylinder in m³. */
const CANONICAL_RAW_VOLUME = (Math.PI * 160 * 160 * 820) / 1e9; // ≈ 0.0659475

// ---------------------------------------------------------------------------
// roundCny
// ---------------------------------------------------------------------------

describe("roundCny", () => {
  it("rounds half up to two decimal places", () => {
    expect(roundCny(1873.425)).toBe(1873.43);
    expect(roundCny(1873.424)).toBe(1873.42);
    expect(roundCny(0.005)).toBe(0.01);
  });

  it("handles floating point representation noise (ties)", () => {
    expect(roundCny(1.005)).toBe(1.01);
    expect(roundCny(2.675)).toBe(2.68);
    expect(roundCny(0.1 + 0.2)).toBe(0.3);
  });

  it("rounds decimal half-cent values up even when the binary form sits just below (BE-12)", () => {
    expect(roundCny(2.135)).toBe(2.14);
    expect(roundCny(2.175)).toBe(2.18);
    expect(roundCny(4.015)).toBe(4.02);
    expect(roundCny(1.255)).toBe(1.26);
    expect(roundCny(1234567.895)).toBe(1234567.9);
  });

  it("passes through non-finite values and tiny exponent-form values safely", () => {
    expect(roundCny(Infinity)).toBe(Infinity);
    expect(Number.isNaN(roundCny(NaN))).toBe(true);
    expect(roundCny(1e-9)).toBe(0);
  });

  it("rounds integers and exact-cent values unchanged", () => {
    expect(roundCny(1873.42)).toBe(1873.42);
    expect(roundCny(100)).toBe(100);
    expect(roundCny(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Raw stock volume
// ---------------------------------------------------------------------------

describe("rawStockVolume", () => {
  it("parses a cylinder stock spec into m³ (Ø320 × 820 mm)", () => {
    const result = calculateCostEstimate(makeInput());
    expect(result.rawStockVolume).toBeCloseTo(CANONICAL_RAW_VOLUME, 12);
    expect(result.rawStockVolume).toBeGreaterThan(CANONICAL_FINISHED_VOLUME);
  });

  it("parses a rectangular bar stock spec into m³ (L × W × H)", () => {
    const result = calculateCostEstimate(
      makeInput({
        stockType: "RECTANGULAR_BAR",
        stockSpec: "200 × 100 × 400 mm"
      })
    );
    expect(result.rawStockVolume).toBeCloseTo((200 * 100 * 400) / 1e9, 12);
  });

  it("accepts meter units and numeric separators", () => {
    const meters = calculateCostEstimate(
      makeInput({ stockSpec: "Ø0.32 × 0.82 m" })
    );
    expect(meters.rawStockVolume).toBeCloseTo(CANONICAL_RAW_VOLUME, 12);

    const noUnit = calculateCostEstimate(makeInput({ stockSpec: "320x820" }));
    expect(noUnit.rawStockVolume).toBeCloseTo(CANONICAL_RAW_VOLUME, 12);
  });

  it("reads units glued to the number, with any case, spacing and full-width characters (BE-11)", () => {
    for (const spec of ["Ø0.32 × 0.82m", "Ø0.32×0.82M", "Ø320 × 820mm", "Ø320x820 MM", "Ø32 × 82CM", "Ø３２０ ｘ ８２０ ｍｍ"]) {
      const result = calculateCostEstimate(makeInput({ stockSpec: spec }));
      expect(result.rawStockVolume, spec).toBeCloseTo(CANONICAL_RAW_VOLUME, 12);
    }
    const bar = calculateCostEstimate(makeInput({ stockType: "RECTANGULAR_BAR", stockSpec: "0.2×0.1×0.4m" }));
    expect(bar.rawStockVolume).toBeCloseTo((200 * 100 * 400) / 1e9, 12);
  });

  it("derives the raw volume from finishedVolume + allowances when the spec is unparseable", () => {
    const allowances: readonly AllowanceValue[] = [
      { name: "直径方向默认余量", valueMm: 20 },
      { name: "长度方向默认余量", valueMm: 20 }
    ];
    const result = calculateCostEstimate(
      makeInput({ stockSpec: "", allowances })
    );
    const sideMm = Math.cbrt(CANONICAL_FINISHED_VOLUME * 1e9);
    const expected =
      CANONICAL_FINISHED_VOLUME * ((sideMm + 20) / sideMm) ** 3;
    expect(result.rawStockVolume).toBeCloseTo(expected, 12);
    expect(result.rawStockVolume).toBeGreaterThan(CANONICAL_FINISHED_VOLUME);
  });

  it("derives the rectangular raw volume from finishedVolume + allowances", () => {
    const allowances: readonly AllowanceValue[] = [
      { name: "长度方向默认余量", valueMm: 20 },
      { name: "宽度方向默认余量", valueMm: 20 },
      { name: "高度方向默认余量", valueMm: 20 }
    ];
    const result = calculateCostEstimate(
      makeInput({ stockType: "RECTANGULAR_BAR", stockSpec: "", allowances })
    );
    const sideMm = Math.cbrt(CANONICAL_FINISHED_VOLUME * 1e9);
    const expected = CANONICAL_FINISHED_VOLUME * ((sideMm + 20) / sideMm) ** 3;
    expect(result.rawStockVolume).toBeCloseTo(expected, 12);
    expect(result.rawStockVolume).toBeGreaterThan(CANONICAL_FINISHED_VOLUME);
  });

  it("falls back to finishedVolume × factor when neither spec nor allowances are usable", () => {
    const result = calculateCostEstimate(
      makeInput({ stockSpec: "unparseable spec" })
    );
    expect(result.rawStockVolume).toBeCloseTo(
      CANONICAL_FINISHED_VOLUME * DEFAULT_STOCK_VOLUME_FACTOR,
      12
    );
  });

  it("returns zero raw volume when nothing is derivable and the finished volume is zero", () => {
    const result = calculateCostEstimate(makeInput({ stockSpec: "", finishedVolume: 0 }));
    expect(result.rawStockVolume).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mass / 计价量
// ---------------------------------------------------------------------------

describe("materialQuantity (mass kg)", () => {
  it("computes finished mass as volume × density × 1000", () => {
    const result = calculateCostEstimate(makeInput());
    expect(result.materialQuantity).toBeCloseTo(CANONICAL_MASS_KG, 12);
  });

  it("uses the default steel density when the material omits it", () => {
    const withoutDensity = material();
    delete withoutDensity.density;
    const result = calculateCostEstimate(
      makeInput({ costData: costData({ materials: [withoutDensity] }) })
    );
    expect(result.materialQuantity).toBeCloseTo(CANONICAL_MASS_KG, 12);
  });

  it("uses the custom density when provided", () => {
    const result = calculateCostEstimate(
      makeInput({
        costData: costData({ materials: [material({ density: 2.7 })] })
      })
    );
    expect(result.materialQuantity).toBeCloseTo(
      CANONICAL_FINISHED_VOLUME * 2.7 * 1000,
      12
    );
  });
});

// ---------------------------------------------------------------------------
// Material cost per piece by price unit
// ---------------------------------------------------------------------------

describe("material cost by price unit", () => {
  const perPieceBase = () =>
    calculateCostEstimate(
      makeInput({
        costData: costData({ fixedCosts: [] })
      })
    );

  it("prices 元/吨 as purchasePrice / 1000 × mass", () => {
    const result = perPieceBase();
    expect(result.materialCost).toBeCloseTo((5200 / 1000) * CANONICAL_MASS_KG * 10, 8);
  });

  it("prices 元/t identically to 元/吨", () => {
    const perTon = perPieceBase();
    const perT = calculateCostEstimate(
      makeInput({
        costData: costData({
          materials: [material({ priceUnit: "元/t" })],
          fixedCosts: []
        })
      })
    );
    expect(perT.materialCost).toBe(perTon.materialCost);
  });

  it("prices 元/kg as purchasePrice × mass", () => {
    const result = calculateCostEstimate(
      makeInput({
        costData: costData({
          materials: [material({ priceUnit: "元/kg", purchasePrice: 5.2 })],
          fixedCosts: []
        })
      })
    );
    expect(result.materialCost).toBeCloseTo(5.2 * CANONICAL_MASS_KG * 10, 8);
  });

  it("prices 元/件 as a flat per-piece purchase price", () => {
    const result = calculateCostEstimate(
      makeInput({
        costData: costData({
          materials: [material({ priceUnit: "元/件", purchasePrice: 150 })],
          fixedCosts: []
        })
      })
    );
    expect(result.materialQuantity).toBeCloseTo(CANONICAL_MASS_KG, 12);
    expect(result.materialCost).toBe(150 * 10);
    expect(result.perPieceCost).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Fixed costs
// ---------------------------------------------------------------------------

describe("fixed costs", () => {
  it("includes PER_PIECE lines with subtotal = amount, contributing amount per piece", () => {
    const result = calculateCostEstimate(
      makeInput({
        costData: costData({
          materials: [material({ priceUnit: "元/件", purchasePrice: 0 })],
          fixedCosts: CANONICAL_FIXED_COSTS
        })
      })
    );
    const base = result.fixedCostLines.find((line) => line.name === "基础加工成本");
    expect(base).toEqual({ name: "基础加工成本", amount: 500, basis: "PER_PIECE", subtotal: 500 });
    const inspection = result.fixedCostLines.find((line) => line.name === "检测成本");
    expect(inspection?.subtotal).toBe(100);
    expect(result.perPieceCost).toBe(0 + 500 + 100 + 80 / 10);
  });

  it("counts PER_BATCH lines with subtotal = amount, contributing amount / quantity per piece", () => {
    const result = calculateCostEstimate(
      makeInput({
        quantity: 4,
        costData: costData({
          materials: [material({ priceUnit: "元/件", purchasePrice: 0 })],
          fixedCosts: CANONICAL_FIXED_COSTS
        })
      })
    );
    const packaging = result.fixedCostLines.find((line) => line.name === "包装成本");
    expect(packaging).toEqual({ name: "包装成本", amount: 80, basis: "PER_BATCH", subtotal: 80 });
    expect(result.perPieceCost).toBe(roundCny(0 + 500 + 100 + 80 / 4));
  });

  it("excludes fixed costs that are not enabled", () => {
    const result = calculateCostEstimate(
      makeInput({
        costData: costData({
          materials: [material({ priceUnit: "元/件", purchasePrice: 0 })],
          fixedCosts: [
            fixedCost({ defaultEnabled: false }),
            fixedCost({ id: "f2", name: "可选项", amount: 999, defaultEnabled: true })
          ]
        })
      })
    );
    expect(result.fixedCostLines).toEqual([
      { name: "可选项", amount: 999, basis: "PER_PIECE", subtotal: 999 }
    ]);
    expect(result.perPieceCost).toBe(999);
  });

  it("yields an empty fixed cost list when all are disabled or none exist", () => {
    const result = calculateCostEstimate(
      makeInput({ costData: costData({ fixedCosts: [] }) })
    );
    expect(result.fixedCostLines).toEqual([]);
    expect(result.perPieceCost).toBeCloseTo(roundCny((5200 / 1000) * CANONICAL_MASS_KG), 8);
  });
});

// ---------------------------------------------------------------------------
// Totals, rounding and aggregation
// ---------------------------------------------------------------------------

describe("aggregate totals", () => {
  it("keeps totalCost = round(perPieceCost × quantity) and materialCost = round(materialCostPerPiece × quantity)", () => {
    for (const quantity of [1, 3, 10, 47]) {
      const result = calculateCostEstimate(makeInput({ quantity }));
      const materialCostPerPiece = (5200 / 1000) * CANONICAL_MASS_KG;
      expect(result.materialCost).toBe(roundCny(materialCostPerPiece * quantity));
      expect(result.totalCost).toBe(roundCny(result.perPieceCost * quantity));
      expect(result.currency).toBe("CNY");
    }
  });

  it("computes the canonical Q01/Q02/Q03 numbers coherently", () => {
    // Q03-style: quantity 10, 元/吨 5200, fixed 500/100 per piece + 80 per batch.
    const result = calculateCostEstimate(makeInput({ quantity: 10 }));
    expect(result.materialCost).toBe(roundCny((5200 / 1000) * CANONICAL_MASS_KG * 10));
    expect(result.perPieceCost).toBe(
      roundCny((5200 / 1000) * CANONICAL_MASS_KG + 500 + 100 + 80 / 10)
    );
    expect(result.totalCost).toBe(roundCny(result.perPieceCost * 10));
    expect(result.materialCost * 1).toBeGreaterThan(0);
  });

  it("rounds the per-piece material accumulation only at report level", () => {
    const result = calculateCostEstimate(
      makeInput({
        quantity: 3,
        costData: costData({
          materials: [material({ priceUnit: "元/吨", purchasePrice: 7777 })],
          fixedCosts: [
            fixedCost({ name: "基础加工成本", amount: 500 }),
            fixedCost({ id: "f-pack", name: "包装成本", amount: 80, basis: "PER_BATCH" })
          ]
        })
      })
    );
    const materialCostPerPiece = (7777 / 1000) * CANONICAL_MASS_KG;
    expect(result.materialCost).toBeCloseTo(roundCny(materialCostPerPiece * 3), 2);
    // per-piece total is the single half-up rounding of the unrounded accumulation.
    expect(result.perPieceCost).toBe(roundCny(materialCostPerPiece + 500 + 80 / 3));
    expect(result.totalCost).toBe(roundCny(result.perPieceCost * 3));
  });

  it("honors quantity 1 exactly (per-batch costs apply in full)", () => {
    const result = calculateCostEstimate(makeInput({ quantity: 1 }));
    expect(result.totalCost).toBe(result.perPieceCost);
    expect(result.perPieceCost).toBeCloseTo(
      roundCny((5200 / 1000) * CANONICAL_MASS_KG + 500 + 100 + 80),
      8
    );
  });

  it("produces zero material cost for a zero finished volume but keeps fixed costs", () => {
    const result = calculateCostEstimate(
      makeInput({ stockSpec: "", finishedVolume: 0 })
    );
    expect(result.materialCost).toBe(0);
    expect(result.materialQuantity).toBe(0);
    expect(result.perPieceCost).toBe(roundCny(500 + 100 + 80 / 10));
    expect(result.totalCost).toBe(roundCny(result.perPieceCost * 10));
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("rejects a non-positive quantity", () => {
    for (const quantity of [0, -1]) {
      expect(() => calculateCostEstimate(makeInput({ quantity }))).toThrow(DomainInvariantError);
    }
  });

  it("rejects a non-integer quantity", () => {
    expect(() => calculateCostEstimate(makeInput({ quantity: 2.5 }))).toThrow(
      DomainInvariantError
    );
  });

  it("rejects an excessive quantity and overflowing amounts", () => {
    expect(() => calculateCostEstimate(makeInput({ quantity: MAX_COST_QUANTITY + 1 }))).toThrow(DomainInvariantError);
    expect(() => calculateCostEstimate(makeInput({ quantity: MAX_COST_QUANTITY }))).not.toThrow();
    expect(() =>
      calculateCostEstimate(makeInput({ costData: costData({ materials: [material({ purchasePrice: 1e308 })] }) }))
    ).toThrow(DomainInvariantError);
  });

  it("rejects an unknown material id", () => {
    expect(() =>
      calculateCostEstimate(makeInput({ materialId: "material-unknown" }))
    ).toThrow(DomainInvariantError);
  });

  it("does not mutate its input snapshot", () => {
    const input = makeInput();
    const snapshot = JSON.stringify(input);
    calculateCostEstimate(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("parseStockSpec (single shared parser, BE-11)", () => {
  it("parses cylinders and bars into millimetres and m³", () => {
    const cylinder = parseStockSpec("Ø320 × 820 mm", "CYLINDER");
    expect(cylinder?.dimensionsMm).toEqual([320, 820]);
    expect(cylinder?.unit).toBe("mm");
    expect(cylinder?.volumeM3).toBeCloseTo(CANONICAL_RAW_VOLUME, 12);
    expect(parseStockSpec("200 * 100 x 400 cm", "RECTANGULAR_BAR")?.dimensionsMm).toEqual([2000, 1000, 4000]);
  });

  it("accepts glued, spaced, upper-case and full-width forms", () => {
    expect(parseStockSpec("820mm×320mm", "CYLINDER")).toBeNull(); // unit only allowed once, at the end
    expect(parseStockSpec("320×820mm", "CYLINDER")?.dimensionsMm).toEqual([320, 820]);
    expect(parseStockSpec("0.32 × 0.82 M", "CYLINDER")?.dimensionsMm).toEqual([320, 820]);
    expect(parseStockSpec("φ３２０×８２０ｍｍ", "CYLINDER")?.dimensionsMm).toEqual([320, 820]);
    expect(parseStockSpec("Ø32.5 × 82.5 mm", "CYLINDER")?.dimensionsMm).toEqual([32.5, 82.5]);
  });

  it("requires an explicit unit only when asked to", () => {
    expect(parseStockSpec("320x820", "CYLINDER")?.unit).toBeNull();
    expect(parseStockSpec("320x820", "CYLINDER", { requireUnit: true })).toBeNull();
    expect(parseStockSpec("320x820 mm", "CYLINDER", { requireUnit: true })?.unit).toBe("mm");
  });

  it("rejects wrong arity, zero/negative/garbage dimensions and unknown units", () => {
    expect(parseStockSpec("", "CYLINDER")).toBeNull();
    expect(parseStockSpec("Ø320 × 820 × 10 mm", "CYLINDER")).toBeNull();
    expect(parseStockSpec("200 × 100 mm", "RECTANGULAR_BAR")).toBeNull();
    expect(parseStockSpec("Ø0 × 820 mm", "CYLINDER")).toBeNull();
    expect(parseStockSpec("Ø-5 × 820 mm", "CYLINDER")).toBeNull();
    expect(parseStockSpec("Ø320 × 820 inch", "CYLINDER")).toBeNull();
    expect(parseStockSpec("unparseable spec", "CYLINDER")).toBeNull();
    expect(parseStockSpec("Ø1e999 × 1 mm", "CYLINDER")).toBeNull();
  });
});
