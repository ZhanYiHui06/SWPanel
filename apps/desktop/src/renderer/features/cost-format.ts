/**
 * Cost display helpers shared by the cost pages.
 *
 * The domain layer rounds every money amount to whole fen (two decimals), so
 * the UI shows exactly two decimals and never re-derives numbers from already
 * rounded totals. Non-finite or missing values render as an em dash instead
 * of `¥NaN`.
 */

/** Placeholder for a value that is missing or not a finite number. */
export const EMPTY_VALUE = "—";

const MONEY_FORMAT = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UNIT_PRICE_FORMAT = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const SIGNIFICANT_FORMAT = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 3 });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `¥1,873.42`; `—` for missing / non-finite values. */
export function formatCny(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  // Avoid "-0.00" for values that round to zero.
  return `¥${MONEY_FORMAT.format(Math.abs(value) < 0.005 ? 0 : value)}`;
}

/** Unit price value with 2-4 decimals (the unit is shown separately), e.g. `¥5,200.00`. */
export function formatUnitPriceValue(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  return `¥${UNIT_PRICE_FORMAT.format(value)}`;
}

/**
 * Price together with its unit exactly once: unit strings such as `元/吨`
 * already contain the currency, so no extra `/` or `¥`-slash is appended
 * (`5,200.00 元/吨`, never `¥5200/元/吨`).
 */
export function formatPriceWithUnit(price: number | null | undefined, unit: string | null | undefined): string {
  if (!isFiniteNumber(price)) return EMPTY_VALUE;
  const text = UNIT_PRICE_FORMAT.format(price);
  const cleanUnit = unit?.trim() ?? "";
  if (cleanUnit === "") return `¥${text}`;
  return cleanUnit.startsWith("元") ? `${text} ${cleanUnit}` : `¥${text} / ${cleanUnit}`;
}

/**
 * Volume in cubic meters. Regular parts keep the prototype's `0.066 m³`;
 * small parts (below 0.001 m³) switch to cm³ so they never collapse to
 * `0.000 m³`.
 */
export function formatVolumeM3(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EMPTY_VALUE;
  if (value <= 0) return "0 m³";
  if (value >= 0.001) return `${value.toFixed(3)} m³`;
  const cubicCentimeters = value * 1_000_000;
  if (cubicCentimeters >= 0.001) return `${SIGNIFICANT_FORMAT.format(cubicCentimeters)} cm³`;
  return `${value.toExponential(2)} m³`;
}

/** Density with its recorded unit; `未提供` when the snapshot has no density. */
export function formatDensity(density: number | null | undefined, unit: string | null | undefined): string {
  if (!isFiniteNumber(density)) return "未提供";
  const cleanUnit = unit?.trim() ?? "";
  return cleanUnit === "" ? `${density}（单位未记录）` : `${density} ${cleanUnit}`;
}
