import type { StockType } from "./cost-estimate.js";

/**
 * Enterprise-maintained cost basis data. Cost data is company-global and never
 * belongs to a single Drawing. Phase 1 is fully user-maintained; no external
 * market price sync. The system distinguishes CALCULABLE structured fields from
 * DISPLAY_ONLY custom fields that must never enter a formula.
 */
export const COST_DATA_KINDS = ["MATERIAL", "ALLOWANCE", "FIXED_COST", "CUSTOM"] as const;
export type CostDataKind = (typeof COST_DATA_KINDS)[number];

export const COST_DATA_SEMANTICS = ["CALCULABLE", "DISPLAY_ONLY"] as const;
export type CostDataSemantics = (typeof COST_DATA_SEMANTICS)[number];

export const COST_BASES = ["PER_PIECE", "PER_BATCH"] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** Price units understood by the cost workflow (shared by validation and quoting). */
export const COST_PRICE_UNITS = ["元/吨", "元/kg", "元/千克", "元/件"] as const;
/** Density units understood by the cost workflow. */
export const COST_DENSITY_UNITS = ["g/cm³", "g/cm3"] as const;

/** Definition describing one configurable cost data item. */
export interface CostDataDefinition {
  id: string;
  key: string;
  name: string;
  kind: CostDataKind;
  semantics: CostDataSemantics;
  unit?: string;
  /** Billing basis for fixed costs (per piece / per batch). */
  basis?: CostBasis;
  /** Global fixed costs default to enabled in every estimation. */
  defaultEnabled: boolean;
  updatedAt: string;
}

export interface MaterialCostValue {
  id: string;
  name: string;
  purchasePrice: number;
  priceUnit: string;
  density?: number;
  densityUnit?: string;
  /** Date from which the value is effective. */
  effectiveFrom: string;
  updatedAt: string;
}

/** One allowance dimension, e.g. 直径方向默认余量 +20 mm. */
export interface AllowanceValue {
  name: string;
  valueMm: number;
}

/** Default machining allowances per stock type (company-global). */
export interface AllowanceDefinition {
  id: string;
  stockType: StockType;
  allowances: readonly AllowanceValue[];
  updatedAt: string;
}

export interface FixedCostValue {
  id: string;
  name: string;
  amount: number;
  currency: string;
  basis: CostBasis;
  defaultEnabled: boolean;
  updatedAt: string;
}

/** Unknown-semantics fields are preserved for display but never computed. */
export interface CustomCostField {
  id: string;
  key: string;
  name: string;
  value: string;
  unit?: string;
  semantics: "DISPLAY_ONLY";
  updatedAt: string;
}

export type CostDataValue =
  | MaterialCostValue
  | AllowanceDefinition
  | FixedCostValue
  | CustomCostField;

/** Effective cost data captured at report creation. */
export interface CostDataSnapshot {
  materials: readonly MaterialCostValue[];
  allowances: readonly AllowanceDefinition[];
  fixedCosts: readonly FixedCostValue[];
  customFields: readonly CustomCostField[];
  /** Effective date/time the snapshot was taken. */
  capturedAt: string;
}
