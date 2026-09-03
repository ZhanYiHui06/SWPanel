import type {
  AllowanceValue,
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  CostEstimateReport,
  CostEstimateResult,
  FixedCostLine,
  FixedCostValue,
  MaterialCostValue
} from "@swpanel/domain";
import { MOCK_FORMULA_VERSION } from "./execution.js";
import { deepClone, deepFreeze } from "./immutable.js";

/** Stable fixture ids for the canonical visual Cost Estimate Reports. */
export const REPORT_IDS = {
  q01: "report-q01",
  q02: "report-q02",
  q03: "report-q03"
} as const;

export const CANONICAL_STOCK_SPEC = "Ø320 × 820 mm";
export const CANONICAL_FINISHED_VOLUME = 0.031;

/**
 * Canonical fixed cost values that participate in every estimation (global
 * fixed costs default to enabled). Derived from `ui-content-fixtures.md`.
 */
export const CANONICAL_FIXED_COST_LINES: readonly FixedCostLine[] = [
  { name: "基础加工成本", amount: 500, basis: "PER_PIECE", subtotal: 500 },
  { name: "检测成本", amount: 100, basis: "PER_PIECE", subtotal: 100 },
  { name: "包装成本", amount: 80, basis: "PER_BATCH", subtotal: 80 }
];

/**
 * Deterministic synthetic cost calculation shared by the canonical fixture
 * reports and the reports the Mock Repository generates.
 *
 * Coherence rules (the visual numbers in `ui-content-fixtures.md` were not
 * internally coherent: e.g. 材料成本 ¥2,600/件 + 基础加工 ¥500/件 + 检测 ¥100/件
 * + 包装 ¥80/批次 does not sum to 单件 ¥3,280 at any quantity). The synthetic
 * engine guarantees:
 * - perPieceCost = materialCostPerPiece + Σ PER_PIECE fixed + Σ PER_BATCH fixed / quantity
 * - totalCost     = perPieceCost × quantity
 * - materialCost  = materialCostPerPiece × quantity
 * - every number is finite, non-negative and deterministic for the same input.
 *
 * The Phase 7 deterministic calculator replaces this visual placeholder.
 */
export function computeSyntheticCostResult(input: {
  quantity: number;
  /** Deterministic per-piece material cost in CNY (volume × density × price). */
  materialCostPerPiece: number;
  /** Global fixed costs participating in the estimation. */
  fixedCosts: readonly FixedCostValue[];
}): CostEstimateResult {
  const perPieceFixed = input.fixedCosts
    .filter((fixedCost) => fixedCost.defaultEnabled && fixedCost.basis === "PER_PIECE")
    .reduce((sum, fixedCost) => sum + fixedCost.amount, 0);
  const perBatchFixed = input.fixedCosts
    .filter((fixedCost) => fixedCost.defaultEnabled && fixedCost.basis === "PER_BATCH")
    .reduce((sum, fixedCost) => sum + fixedCost.amount, 0);

  const perPieceCost = input.materialCostPerPiece + perPieceFixed + perBatchFixed / input.quantity;
  const totalCost = perPieceCost * input.quantity;
  const materialCost = input.materialCostPerPiece * input.quantity;

  const fixedCostLines: FixedCostLine[] = input.fixedCosts
    .filter((fixedCost) => fixedCost.defaultEnabled)
    .map((fixedCost) => ({
      name: fixedCost.name,
      amount: fixedCost.amount,
      basis: fixedCost.basis,
      subtotal: fixedCost.amount
    }));

  return {
    rawStockVolume: 0,
    materialQuantity: 0,
    materialCost,
    fixedCostLines,
    perPieceCost,
    totalCost,
    currency: "CNY"
  };
}

/**
 * Deterministic per-piece material cost from a finished-part volume and the
 * selected material's density and purchase price (converted to CNY/kg).
 */
export function syntheticMaterialCostPerPiece(input: {
  finishedVolume: number;
  material: Pick<MaterialCostValue, "density" | "priceUnit" | "purchasePrice">;
}): number {
  const density = input.material.density ?? 7.85;
  const pricePerKg = input.material.priceUnit.includes("吨")
    ? input.material.purchasePrice / 1000
    : input.material.purchasePrice;
  // density is g/cm³; finishedVolume is m³. massKg = volume(m³) × density(g/cm³) × 1000.
  return input.finishedVolume * density * 1000 * pricePerKg;
}

/**
 * Builds a canonical visual Cost Estimate Report record whose result totals are
 * produced by the shared deterministic synthetic calculator, so generated and
 * fixture reports agree. Only metadata is modeled; bytes live on NTFS (Phase 2).
 */
export function buildVisualReport(input: {
  id: string;
  label: string;
  createdAt: string;
  drawingId: string;
  revisionId: string;
  modelId: string;
  quantity: number;
  material: MaterialCostValue;
  stockType: "CYLINDER" | "RECTANGULAR_BAR";
  stockSpec: string;
  finishedVolume: number;
  allowances: readonly AllowanceValue[];
  fixedCosts: readonly FixedCostValue[];
  costData: CostDataSnapshot;
}): CostEstimateReport {
  const materialCostPerPiece = syntheticMaterialCostPerPiece({
    finishedVolume: input.finishedVolume,
    material: input.material
  });
  const result = computeSyntheticCostResult({
    quantity: input.quantity,
    materialCostPerPiece,
    fixedCosts: input.fixedCosts
  });

  const estimateInput: CostEstimateInputSnapshot = {
    drawingId: input.drawingId,
    revisionId: input.revisionId,
    modelId: input.modelId,
    quantity: input.quantity,
    materialId: input.material.id,
    stockType: input.stockType,
    stockSpec: input.stockSpec,
    finishedVolume: input.finishedVolume,
    allowances: input.allowances,
    // The report must own its cost-data snapshot: clone the caller-provided
    // snapshot so later Cost Data edits can never rewrite a historical report.
    costData: deepClone(input.costData),
    formulaVersion: MOCK_FORMULA_VERSION,
    capturedAt: input.createdAt
  };

  // The returned report is defensively frozen so callers cannot mutate the
  // immutable snapshot in place.
  return deepFreeze({
    id: input.id,
    label: input.label,
    drawingId: input.drawingId,
    revisionId: input.revisionId,
    modelId: input.modelId,
    quantity: input.quantity,
    snapshot: {
      input: estimateInput,
      result,
      createdAt: input.createdAt
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}
