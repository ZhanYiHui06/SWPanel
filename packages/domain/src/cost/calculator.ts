import { DomainInvariantError } from "../errors.js";
import type { AllowanceValue, FixedCostValue, MaterialCostValue } from "./cost-data.js";
import type {
  CostEstimateInputSnapshot,
  CostEstimateResult,
  FixedCostLine,
  StockType
} from "./cost-estimate.js";

/**
 * Phase 7 deterministic cost calculator.
 *
 * Pure function: the same `CostEstimateInputSnapshot` always produces the same
 * `CostEstimateResult`. No I/O, no market lookup, no LLM involvement — every
 * number is derived from the frozen input snapshot (which itself freezes the
 * effective Cost Data, model geometry and user-confirmed parameters).
 *
 * Pricing scope: internal reference estimate only. Profit, tax, freight and
 * commercial terms stay out of scope.
 *
 * # Raw stock volume resolution (documented precedence)
 *
 *   1. Parse the user-confirmed `stockSpec` geometry ("Ø320 × 820 mm" cylinder,
 *      "200 × 100 × 400 mm" rectangular bar). The blank spec already reflects
 *      the machining allowances, so its geometric volume is the raw stock
 *      volume in m³.
 *   2. Otherwise, derive it from `finishedVolume` + `allowances` via
 *      volume-preserving inflation: the part is modeled with characteristic
 *      dimension side = cbrt(finishedVolume); each machining allowance (mm) is
 *      added along its named axis (直径 diameter / 长度 length for CYLINDER,
 *      长度/宽度/高度 for RECTANGULAR_BAR) and the finished volume is scaled by
 *      the resulting per-axis ratios (radial² × axial). Only used when at least
 *      one positive allowance is present.
 *   3. Otherwise fall back to `finishedVolume * DEFAULT_STOCK_VOLUME_FACTOR`
 *      (conservative factor > 1 because machining removes material; the raw
 *      blank is always larger than the finished part).
 *
 * # Mass and material billing
 *
 *   massKg = finishedVolume (m³) × density (g/cm³) × 1000.
 *
 *   1 m³ = 10⁶ cm³, and mass(kg) = mass(g) / 1000, so
 *   massKg = volume(m³) × 10⁶ × density(g/cm³) / 1000
 *          = volume(m³) × density(g/cm³) × 1000.
 *
 *   The material cost is priced on the FINISHED-part mass (matching the
 *   pre-existing fixture convention in
 *   `apps/desktop/src/renderer/fixtures/cost-reports.ts`). This is
 *   deterministic; raw-stock-mass pricing is intentionally not used while the
 *   blank is captured as free-text geometry only.
 *
 * # Material per-piece cost by price unit
 *
 *   元/吨 or 元/t: purchasePrice / 1000 × massKg (per-ton price → per-kg).
 *   元/kg:         purchasePrice × massKg.
 *   元/件:         purchasePrice (per-piece purchase price, no mass involved).
 *   unrecognized units: treated as per-kg (same convention as the existing
 *   fixture logic that only singled out per-ton pricing).
 *
 * # Fixed costs
 *
 *   A fixed cost participates when `defaultEnabled === true` (the snapshot has
 *   no per-report enable/disable override, so the effective basis is the
 *   captured global default).
 *     PER_PIECE: line subtotal = amount; contributes `amount` per piece.
 *     PER_BATCH: line subtotal = amount; contributes `amount / quantity` per
 *                piece (the whole batch is spread over the order quantity).
 *
 * # Totals (rounded half-up to CNY cents)
 *
 *   perPieceCost = round( materialCostPerPiece + ΣPER_PIECE + ΣPER_BATCH / quantity )
 *   totalCost     = round( perPieceCost × quantity )
 *   materialCost  = round( materialCostPerPiece × quantity )
 */

/** Default steel density in g/cm³ when a material omits its density. */
export const DEFAULT_STEEL_DENSITY = 7.85;

/**
 * Deterministic fallback ratio for the raw stock volume when neither the stock
 * spec nor the finished volume + allowances can be used. Machining removes
 * material, so the raw blank is always larger than the finished part.
 */
export const DEFAULT_STOCK_VOLUME_FACTOR = 2;

const MILLIMETER_PER_METER = 1000;
const CUBIC_MILLIMETER_PER_CUBIC_METER = 1e9;

/** Rounds a CNY value to 2 decimal places, half up. */
export function roundCny(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/** Parses a human stock spec into an m³ volume, or null when not parseable. */
function parseStockSpec(stockSpec: string, stockType: StockType): number | null {
  const spec = stockSpec.trim();
  if (spec.length === 0) return null;

  // Linear unit defaults to mm when absent ("Ø320 × 820 mm" vs "Ø0.32 × 0.82 m").
  const unitMatch = spec.match(/\b(?:mm|cm|m)\b/i);
  const unit = unitMatch === null || unitMatch[0] === undefined ? null : unitMatch[0].toLowerCase();
  const mmFactor =
    unit === "m" ? MILLIMETER_PER_METER : unit === "cm" ? 10 : 1;

  const numbers = [...spec.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (numbers.length === 0) return null;
  const dims = numbers.map((value) => value * mmFactor);
  if (dims.some((dimension) => !Number.isFinite(dimension) || dimension <= 0)) {
    return null;
  }

  if (stockType === "CYLINDER") {
    const [diameter, length] = dims;
    if (diameter === undefined || length === undefined) return null;
    const radius = diameter / 2;
    return (Math.PI * radius * radius * length) / CUBIC_MILLIMETER_PER_CUBIC_METER;
  }
  if (stockType === "RECTANGULAR_BAR") {
    const [length, width, height] = dims;
    if (length === undefined || width === undefined || height === undefined) return null;
    return (length * width * height) / CUBIC_MILLIMETER_PER_CUBIC_METER;
  }
  return null;
}

const DIAMETER_MARKERS = ["直径"];
const LENGTH_MARKERS = ["长度"];
const WIDTH_MARKERS = ["宽度"];
const HEIGHT_MARKERS = ["高度"];

/** Selects the first allowance matching one of the given name markers (mm). */
function allowanceMm(allowances: readonly AllowanceValue[], markers: readonly string[]): number {
  const match = allowances.find((allowance) =>
    markers.some((marker) => allowance.name.includes(marker))
  );
  return match?.valueMm ?? 0;
}

/**
 * Raw stock volume from the finished volume + allowances (branch 2).
 *
 * The finished part's geometry is not recorded in the snapshot (only its
 * volume), so the raw blank is estimated by volume-preserving inflation: the
 * finished part is modeled with a characteristic dimension of
 * side = cbrt(finishedVolume), each machining allowance (mm) is added along its
 * named axis, and the finished volume is scaled by the resulting per-axis
 * ratios. For RECTANGULAR_BAR this reproduces the exact bounding-box volume
 * (L × W × H inflated by 长度/宽度/高度); for CYLINDER it scales radially² ×
 * axially (直径/长度). Since every ratio is ≥ 1, the raw stock volume is always
 * ≥ the finished volume. Returns null when there is no usable finished volume
 * or no positive machining allowance.
 */
function stockVolumeFromFinishedAndAllowances(
  input: CostEstimateInputSnapshot
): number | null {
  const { finishedVolume, allowances, stockType } = input;
  if (!(finishedVolume > 0)) return null;
  if (!allowances.some((allowance) => allowance.valueMm > 0)) return null;

  const sideMm = Math.cbrt(finishedVolume * CUBIC_MILLIMETER_PER_CUBIC_METER);
  if (!Number.isFinite(sideMm) || sideMm <= 0) return null;

  if (stockType === "CYLINDER") {
    const diameterRatio = (sideMm + allowanceMm(allowances, DIAMETER_MARKERS)) / sideMm;
    const lengthRatio = (sideMm + allowanceMm(allowances, LENGTH_MARKERS)) / sideMm;
    return finishedVolume * diameterRatio * diameterRatio * lengthRatio;
  }
  if (stockType === "RECTANGULAR_BAR") {
    const lengthRatio = (sideMm + allowanceMm(allowances, LENGTH_MARKERS)) / sideMm;
    const widthRatio = (sideMm + allowanceMm(allowances, WIDTH_MARKERS)) / sideMm;
    const heightRatio = (sideMm + allowanceMm(allowances, HEIGHT_MARKERS)) / sideMm;
    return finishedVolume * lengthRatio * widthRatio * heightRatio;
  }
  return null;
}

/** Resolves the raw stock volume with the documented 3-stage precedence. */
function resolveRawStockVolume(input: CostEstimateInputSnapshot): number {
  const parsed = parseStockSpec(input.stockSpec, input.stockType);
  if (parsed !== null) return parsed;

  const fromFinishedAndAllowances = stockVolumeFromFinishedAndAllowances(input);
  if (fromFinishedAndAllowances !== null) return fromFinishedAndAllowances;

  return input.finishedVolume * DEFAULT_STOCK_VOLUME_FACTOR;
}

/** Mass in kg of the finished part: volume(m³) × density(g/cm³) × 1000. */
function finishedMassKg(finishedVolume: number, density: number): number {
  return finishedVolume * density * 1000;
}

/** Per-piece material cost from the purchase price unit and finished mass. */
function materialCostPerPieceFor(
  material: MaterialCostValue,
  massKg: number
): number {
  const unit = material.priceUnit.trim().toLowerCase();
  if (unit.includes("吨") || /(^|\/)\s*t\b/.test(unit)) {
    return (material.purchasePrice / 1000) * massKg;
  }
  if (unit.includes("件")) {
    return material.purchasePrice;
  }
  // 元/kg (and unrecognized units, preserving the existing per-kg convention).
  return material.purchasePrice * massKg;
}

interface ComputedFixedCosts {
  fixedCostLines: FixedCostLine[];
  perPieceFixed: number;
  perBatchFixed: number;
}

/** Builds fixed cost lines for enabled costs and the per-piece contributions. */
function computeFixedCosts(fixedCosts: readonly FixedCostValue[]): ComputedFixedCosts {
  const fixedCostLines: FixedCostLine[] = [];
  let perPieceFixed = 0;
  let perBatchFixed = 0;
  for (const fixedCost of fixedCosts) {
    if (!fixedCost.defaultEnabled) continue;
    fixedCostLines.push({
      name: fixedCost.name,
      amount: fixedCost.amount,
      basis: fixedCost.basis,
      subtotal: fixedCost.amount
    });
    if (fixedCost.basis === "PER_BATCH") {
      perBatchFixed += fixedCost.amount;
    } else {
      perPieceFixed += fixedCost.amount;
    }
  }
  return { fixedCostLines, perPieceFixed, perBatchFixed };
}

/**
 * Deterministically computes a cost estimate from a frozen input snapshot.
 * Rejects invalid input with a `DomainInvariantError` (non-positive quantity or
 * an unknown material id).
 */
export function calculateCostEstimate(
  input: CostEstimateInputSnapshot
): CostEstimateResult {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new DomainInvariantError(`quantity must be a positive integer, got ${input.quantity}`);
  }
  const material = input.costData.materials.find(
    (candidate) => candidate.id === input.materialId
  );
  if (material === undefined) {
    throw new DomainInvariantError(`unknown material ${input.materialId}`);
  }

  const rawStockVolume = resolveRawStockVolume(input);

  const density = material.density ?? DEFAULT_STEEL_DENSITY;
  const massKg = finishedMassKg(input.finishedVolume, density);

  const materialCostPerPiece = materialCostPerPieceFor(material, massKg);

  const { fixedCostLines, perPieceFixed, perBatchFixed } = computeFixedCosts(
    input.costData.fixedCosts
  );

  const perPieceCost = roundCny(
    materialCostPerPiece + perPieceFixed + perBatchFixed / input.quantity
  );
  const totalCost = roundCny(perPieceCost * input.quantity);
  const materialCost = roundCny(materialCostPerPiece * input.quantity);

  return {
    rawStockVolume,
    // 计价量: mass in kg used for material billing.
    materialQuantity: roundCny(massKg),
    materialCost,
    fixedCostLines,
    perPieceCost,
    totalCost,
    currency: "CNY"
  };
}
