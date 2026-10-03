import type { CostBasis, RevisionFactSource, StockType } from "@swpanel/domain";

import { formatRelativeTime } from "./format.js";

/**
 * Presentation helpers shared by the Phase 1 cost / memory pages. All labels
 * match the confirmed `.design` prototype copy and the UI content fixtures.
 */

/**
 * Money / volume formatting lives in `cost-format.ts` (two-decimal CNY that
 * matches the domain's fen rounding, adaptive volume units). Re-exported under
 * the legacy names so existing imports keep working.
 */
export { formatCny, formatVolumeM3 as formatVolumeCubicMeters } from "./cost-format.js";

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

/**
 * Relative date (`今天 23:21` / `昨天 19:06` / `8月10日 22:31`, with the year
 * when it differs from `now`). Delegates to `formatRelativeTime` so every page
 * shares one date format.
 */
export function formatSmartDate(iso: string, now: Date = new Date()): string {
  return formatRelativeTime(iso, now);
}
