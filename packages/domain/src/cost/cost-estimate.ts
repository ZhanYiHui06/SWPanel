import type { AllowanceValue, CostBasis, CostDataSnapshot } from "./cost-data.js";

/** Supported raw stock forms. 圆柱料 / 矩形毛坯. */
export const STOCK_TYPES = ["CYLINDER", "RECTANGULAR_BAR"] as const;
export type StockType = (typeof STOCK_TYPES)[number];

export const COST_CURRENCIES = ["CNY"] as const;
export type CostCurrency = (typeof COST_CURRENCIES)[number];

/**
 * Complete deterministic input recorded when a Cost Estimate Report is created.
 * The snapshot freezes the model reference, confirmed quantity/material/stock
 * parameters, allowances, effective cost data and formula version so later
 * global price changes never rewrite a historical report.
 */
export interface CostEstimateInputSnapshot {
  drawingId: string;
  revisionId: string;
  modelId: string;
  quantity: number;
  materialId: string;
  stockType: StockType;
  /** Human-readable stock specification, e.g. Ø320 × 820 mm. */
  stockSpec: string;
  /** Finished-part volume from deterministic model geometry (m³). */
  finishedVolume: number;
  allowances: readonly AllowanceValue[];
  costData: CostDataSnapshot;
  formulaVersion: string;
  capturedAt: string;
}

export interface FixedCostLine {
  name: string;
  amount: number;
  basis: CostBasis;
  /** Line total after applying the quantity/basis rule. */
  subtotal: number;
}

/** Deterministic cost result produced by the pure calculator (Phase 7). */
export interface CostEstimateResult {
  rawStockVolume: number;
  materialQuantity: number;
  materialCost: number;
  fixedCostLines: readonly FixedCostLine[];
  perPieceCost: number;
  totalCost: number;
  currency: CostCurrency;
}

/** Immutable input + result captured for one report generation. */
export interface CostEstimateSnapshot {
  input: CostEstimateInputSnapshot;
  result: CostEstimateResult;
  createdAt: string;
}

/**
 * Internal reference cost estimate report. It is never a final customer quote:
 * profit, tax, freight and commercial terms stay out of scope. Multiple reports
 * per Approved Model are distinguished by a light sequence label (Q01/Q02/Q03);
 * there is no DRAFT/FINALIZED state machine.
 */
export interface CostEstimateReport {
  /** Stable timestamp-based identifier. */
  id: string;
  /** Business sequence label, e.g. Q01 / Q02 / Q03. */
  label: string;
  drawingId: string;
  revisionId: string;
  modelId: string;
  quantity: number;
  snapshot: CostEstimateSnapshot;
  createdAt: string;
  updatedAt: string;
}
