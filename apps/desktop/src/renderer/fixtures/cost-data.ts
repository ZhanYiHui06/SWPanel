import type {
  AllowanceDefinition,
  AllowanceValue,
  CostDataDefinition,
  CostDataSnapshot,
  CustomCostField,
  FixedCostValue,
  MaterialCostValue,
  StockType
} from "@swpanel/domain";
import { TIME } from "./timeline.js";

/** Stable fixture ids for the canonical company-global Cost Data. */
export const COST_DATA_IDS = {
  material42crmo: "material-42crmo",
  material45: "material-45steel",
  material40cr: "material-40cr",
  allowanceCylinder: "allowance-cylinder",
  allowanceRectangularBar: "allowance-rectangular-bar",
  fixedBasicProcessing: "fixed-basic-processing",
  fixedInspection: "fixed-inspection",
  fixedPackaging: "fixed-packaging",
  customNote: "custom-note"
} as const;

const DEFAULT_ALLOWANCES: Readonly<Record<StockType, readonly AllowanceValue[]>> = {
  CYLINDER: [
    { name: "直径方向默认余量", valueMm: 20 },
    { name: "长度方向默认余量", valueMm: 20 }
  ],
  RECTANGULAR_BAR: [
    { name: "长度方向默认余量", valueMm: 20 },
    { name: "宽度方向默认余量", valueMm: 20 },
    { name: "高度方向默认余量", valueMm: 20 }
  ]
};

export function defaultAllowancesFor(
  stockType: StockType
): readonly AllowanceValue[] {
  return DEFAULT_ALLOWANCES[stockType];
}

export interface CostDataState {
  definitions: readonly CostDataDefinition[];
  materials: readonly MaterialCostValue[];
  allowances: readonly AllowanceDefinition[];
  fixedCosts: readonly FixedCostValue[];
  customFields: readonly CustomCostField[];
}

/**
 * Canonical company-global Cost Data used by every non-empty scenario. Values
 * are public placeholder data from `ui-content-fixtures.md`, never real
 * enterprise purchasing data.
 */
export function defaultCostData(): CostDataState {
  const definitions: CostDataDefinition[] = [
    {
      id: "def-material-price",
      key: "material.purchasePrice",
      name: "材料采购价",
      kind: "MATERIAL",
      semantics: "CALCULABLE",
      unit: "元/吨",
      defaultEnabled: true,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: "def-allowance-diameter",
      key: "allowance.diameter",
      name: "直径方向余量",
      kind: "ALLOWANCE",
      semantics: "CALCULABLE",
      unit: "mm",
      defaultEnabled: true,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: "def-allowance-length",
      key: "allowance.length",
      name: "长度方向余量",
      kind: "ALLOWANCE",
      semantics: "CALCULABLE",
      unit: "mm",
      defaultEnabled: true,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: "def-fixed-processing",
      key: "fixedCost.basicProcessing",
      name: "基础加工成本",
      kind: "FIXED_COST",
      semantics: "CALCULABLE",
      unit: "元/件",
      basis: "PER_PIECE",
      defaultEnabled: true,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: "def-fixed-packaging",
      key: "fixedCost.packaging",
      name: "包装成本",
      kind: "FIXED_COST",
      semantics: "CALCULABLE",
      unit: "元/批次",
      basis: "PER_BATCH",
      defaultEnabled: true,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: "def-custom-note",
      key: "custom.note",
      name: "备注",
      kind: "CUSTOM",
      semantics: "DISPLAY_ONLY",
      defaultEnabled: false,
      updatedAt: TIME.costDataUpdated
    }
  ];

  const materials: MaterialCostValue[] = [
    {
      id: COST_DATA_IDS.material42crmo,
      name: "42CrMo",
      purchasePrice: 5200,
      priceUnit: "元/吨",
      density: 7.85,
      densityUnit: "g/cm³",
      effectiveFrom: TIME.materialEffectiveFrom,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: COST_DATA_IDS.material45,
      name: "45#钢",
      purchasePrice: 4800,
      priceUnit: "元/吨",
      density: 7.85,
      densityUnit: "g/cm³",
      effectiveFrom: TIME.materialEffectiveFrom,
      updatedAt: "2026-08-09T00:00:00.000Z"
    },
    {
      id: COST_DATA_IDS.material40cr,
      name: "40Cr",
      purchasePrice: 5000,
      priceUnit: "元/吨",
      density: 7.85,
      densityUnit: "g/cm³",
      effectiveFrom: TIME.materialEffectiveFrom,
      updatedAt: "2026-08-08T00:00:00.000Z"
    }
  ];

  const allowances: AllowanceDefinition[] = [
    {
      id: COST_DATA_IDS.allowanceCylinder,
      stockType: "CYLINDER",
      allowances: DEFAULT_ALLOWANCES.CYLINDER,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: COST_DATA_IDS.allowanceRectangularBar,
      stockType: "RECTANGULAR_BAR",
      allowances: DEFAULT_ALLOWANCES.RECTANGULAR_BAR,
      updatedAt: TIME.costDataUpdated
    }
  ];

  const fixedCosts: FixedCostValue[] = [
    {
      id: COST_DATA_IDS.fixedBasicProcessing,
      name: "基础加工成本",
      amount: 500,
      currency: "CNY",
      basis: "PER_PIECE",
      defaultEnabled: true,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: COST_DATA_IDS.fixedInspection,
      name: "检测成本",
      amount: 100,
      currency: "CNY",
      basis: "PER_PIECE",
      defaultEnabled: true,
      updatedAt: TIME.costDataUpdated
    },
    {
      id: COST_DATA_IDS.fixedPackaging,
      name: "包装成本",
      amount: 80,
      currency: "CNY",
      basis: "PER_BATCH",
      defaultEnabled: true,
      updatedAt: TIME.costDataUpdated
    }
  ];

  const customFields: CustomCostField[] = [
    {
      id: COST_DATA_IDS.customNote,
      key: "custom.note",
      name: "备注",
      value: "测试环境占位数据，不代表真实企业成本。",
      semantics: "DISPLAY_ONLY",
      updatedAt: TIME.costDataUpdated
    }
  ];

  return { definitions, materials, allowances, fixedCosts, customFields };
}

/**
 * Historical company-global Cost Data as it stood before the 08-10 08:00 update.
 * The values are the same placeholders, but every item's `updatedAt` is the last
 * pre-update maintenance instant (`TIME.costDataUpdatedHistorical`), so a report
 * captured before 08-10 (Q01/Q02) can freeze a version that never references a
 * cost item stamped after its capture instant.
 */
export function historicalCostData(): CostDataState {
  const updatedAt = TIME.costDataUpdatedHistorical;
  const current = defaultCostData();
  return {
    definitions: current.definitions.map((definition) => ({ ...definition, updatedAt })),
    materials: current.materials.map((material) => ({ ...material, updatedAt })),
    allowances: current.allowances.map((allowance) => ({ ...allowance, updatedAt })),
    fixedCosts: current.fixedCosts.map((fixedCost) => ({ ...fixedCost, updatedAt })),
    customFields: current.customFields.map((custom) => ({ ...custom, updatedAt }))
  };
}

/** Freezes the effective Cost Data into an immutable snapshot. */
export function costDataSnapshot(
  state: CostDataState,
  capturedAt: string
): CostDataSnapshot {
  return {
    materials: state.materials,
    allowances: state.allowances,
    fixedCosts: state.fixedCosts,
    customFields: state.customFields,
    capturedAt
  };
}
