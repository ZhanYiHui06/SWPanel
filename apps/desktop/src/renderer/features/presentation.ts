import type { CostBasis, RevisionFactSource, StockType } from "@swpanel/domain";

/**
 * Presentation helpers shared by the Phase 1 cost / memory pages. All labels
 * match the confirmed `.design` prototype copy and the UI content fixtures.
 */

/** Formats a cost in the prototype's `¥3,280` style (no decimals). */
export function formatCny(value: number): string {
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

/** Formats a volume in cubic meters, e.g. `0.031 m³`. */
export function formatVolumeCubicMeters(value: number): string {
  return `${value.toFixed(3)} m³`;
}

export function stockTypeLabel(stockType: StockType): string {
  return stockType === "CYLINDER" ? "圆柱料" : "矩形料";
}

export function stockTypeName(stockType: StockType): string {
  return stockType === "CYLINDER" ? "圆柱毛坯" : "矩形毛坯";
}

/** Fixed-cost billing basis suffix, e.g. `/ 件` or `/ 批次`. */
export function basisSuffix(basis: CostBasis): string {
  return basis === "PER_PIECE" ? "/ 件" : "/ 批次";
}

/**
 * User-visible fact source. Clarification answers are recorded by the user, so
 * both USER_SUPPLEMENT and CLARIFICATION map to the prototype's "用户补充".
 */
export function factSourceLabel(source: RevisionFactSource): string {
  switch (source) {
    case "DRAWING_CONFIRMED":
      return "图纸确认";
    case "USER_SUPPLEMENT":
    case "CLARIFICATION":
      return "用户补充";
  }
}

/** Relative date in the prototype's `今天 23:21` / `昨天 19:06` style. */
export function formatSmartDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round(
    (startOfToday.getTime() - startOfTarget.getTime()) / 86_400_000
  );
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (dayDifference === 0) return `今天 ${time}`;
  if (dayDifference === 1) return `昨天 ${time}`;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}
