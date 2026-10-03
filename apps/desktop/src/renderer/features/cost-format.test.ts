import { describe, expect, it } from "vitest";

import {
  formatCny,
  formatDensity,
  formatPriceWithUnit,
  formatUnitPriceValue,
  formatVolumeM3
} from "./cost-format.js";

describe("cost display formatting", () => {
  it("formats money with two decimals and a thousands separator", () => {
    expect(formatCny(1873.42)).toBe("¥1,873.42");
    expect(formatCny(18734.2)).toBe("¥18,734.20");
    expect(formatCny(12)).toBe("¥12.00");
    expect(formatCny(12.4)).not.toBe(formatCny(12.49));
  });

  it("never renders NaN / Infinity / missing money", () => {
    expect(formatCny(Number.NaN)).toBe("—");
    expect(formatCny(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCny(undefined)).toBe("—");
    expect(formatCny(null)).toBe("—");
    expect(formatCny(-0.001)).toBe("¥0.00");
  });

  it("shows the price unit exactly once", () => {
    expect(formatPriceWithUnit(5200, "元/吨")).toBe("5,200.00 元/吨");
    expect(formatPriceWithUnit(4.85, "元/kg")).toBe("4.85 元/kg");
    expect(formatPriceWithUnit(1, "米")).toBe("¥1.00 / 米");
    expect(formatPriceWithUnit(Number.NaN, "元/吨")).toBe("—");
    expect(formatUnitPriceValue(5200)).toBe("¥5,200.00");
    expect(formatUnitPriceValue(4.855)).toBe("¥4.855");
  });

  it("keeps the prototype volume style for regular parts and adapts small ones", () => {
    expect(formatVolumeM3(0.066)).toBe("0.066 m³");
    expect(formatVolumeM3(0.031)).toBe("0.031 m³");
    expect(formatVolumeM3(0.0004)).toBe("400 cm³");
    expect(formatVolumeM3(0.0004)).not.toContain("0.000");
    expect(formatVolumeM3(Number.NaN)).toBe("—");
    expect(formatVolumeM3(0)).toBe("0 m³");
  });

  it("does not invent a density", () => {
    expect(formatDensity(undefined, undefined)).toBe("未提供");
    expect(formatDensity(7.85, "g/cm³")).toBe("7.85 g/cm³");
    expect(formatDensity(7.85, undefined)).toBe("7.85（单位未记录）");
  });
});
