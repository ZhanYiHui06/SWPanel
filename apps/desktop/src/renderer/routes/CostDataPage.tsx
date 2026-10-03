import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataTable,
  Dialog,
  EmptyState,
  FormField,
  InlineNotice,
  NumberInput,
  SearchInput,
  Select,
  TextInput,
  Tabs
} from "@swpanel/ui";
import type { AllowanceDefinition, CustomCostField, FixedCostValue, MaterialCostValue, CostDataSnapshot, CostBasis } from "@swpanel/domain";
import { COST_DENSITY_UNITS, COST_PRICE_UNITS } from "@swpanel/domain";
import { useEffect, useRef, useState } from "react";

import { formatCny, formatUnitPriceValue } from "../features/cost-format.js";
import { describeError } from "../features/error-messages.js";
import { randomId } from "../features/ids.js";
import { basisSuffix, formatSmartDate, stockTypeName } from "../features/presentation.js";
import { useRepository } from "../features/repository-provider.js";
import { useDrawingRepository } from "../features/bridge-repository/drawing-repository-provider.js";
import {
  useCostRepository,
  useEffectiveCostDataQuery,
  useCostInvalidate
} from "../features/cost-repository/index.js";

export interface CostDataPageProps {
  readonly now?: Date;
}

type CostDataTab = "materials" | "allowances" | "fixed-costs";

export function CostDataPage(props: CostDataPageProps): React.JSX.Element {
  const drawingRepository = useDrawingRepository();
  if (drawingRepository.mode !== "mock") {
    return <ProductCostDataPage {...props} />;
  }
  return <MockCostDataPage {...props} />;
}

type ProductTab = CostDataTab | "custom";
interface CostDraft {
  tab: ProductTab;
  id: string;
  creating: boolean;
  name: string;
  amount: string;
  priceUnit: string;
  density: string;
  densityUnit: string;
  basis: CostBasis;
  enabled: boolean;
  key: string;
  value: string;
  unit: string;
  allowances: readonly { name: string; value: string }[];
}

/** Mirrors the server-side limits in `packages/contracts` (ipc-validation). */
const MAX_COST_AMOUNT = 1e9;
const MAX_DENSITY = 100;
const MAX_ALLOWANCE_MM = 100_000;
const MAX_NAME_LENGTH = 200;
const MAX_KEY_LENGTH = 100;
const MAX_COST_ITEMS = 500;

function numberValue(raw: string, label: string, positive = false, max = MAX_COST_AMOUNT): number {
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${label}必须填写${positive ? "大于 0" : "大于或等于 0"}的有限数字`);
  }
  if (value > max) {
    throw new Error(`${label}不能超过 ${max.toLocaleString("zh-CN")}`);
  }
  return value;
}

function validateCostSnapshot(snapshot: CostDataSnapshot): void {
  const all = [...snapshot.materials, ...snapshot.fixedCosts, ...snapshot.customFields, ...snapshot.allowances];
  if (all.some((entry) => !entry.id.trim()) || new Set(all.map((entry) => entry.id)).size !== all.length) {
    throw new Error("成本数据 ID 为空或重复，请重新加载后重试");
  }
  for (const group of [snapshot.materials, snapshot.fixedCosts, snapshot.customFields]) {
    const names = group.map((entry) => entry.name.trim().toLowerCase());
    if (names.some((name) => !name) || new Set(names).size !== names.length) throw new Error("名称不能为空，同一分类内不能重名");
  }
  const keys = snapshot.customFields.map((entry) => entry.key.trim().toLowerCase());
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error("自定义字段标识不能为空或重复");
}

function ProductCostDataPage({ now = new Date() }: CostDataPageProps): React.JSX.Element {
  const costRepo = useCostRepository();
  const invalidate = useCostInvalidate();
  const { data: snapshot, loading, error, retry } = useEffectiveCostDataQuery();
  const [tab, setTab] = useState<ProductTab>("materials");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<CostDraft | null>(null);
  const [deleting, setDeleting] = useState<{ tab: ProductTab; id: string; name: string } | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftBaseline, setDraftBaseline] = useState("");
  const [pendingTab, setPendingTab] = useState<ProductTab | null>(null);
  const draftErrorRef = useRef<HTMLDivElement>(null);
  // A draft is "dirty" once the user changed anything after opening it.
  const dirty = draft !== null && JSON.stringify(draft) !== draftBaseline;

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (saveError !== null) draftErrorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [saveError]);

  if (loading && !snapshot) return <div className="page-content" data-route-id="cost-data"><p className="text-muted" role="status">正在加载成本数据…</p></div>;
  if (error || !snapshot) {
    const described = describeError(error);
    return <div className="page-content" data-route-id="cost-data"><InlineNotice tone="error" title="加载成本数据失败" role="alert">{described.message}</InlineNotice><div className="mt-4"><Button variant="secondary" onClick={() => retry()}>重试</Button></div></div>;
  }
  const current = snapshot;

  function begin(editTab: ProductTab, entry?: MaterialCostValue | FixedCostValue | CustomCostField | AllowanceDefinition): void {
    setSaved(false);
    setSaveError(null);
    const initial: CostDraft = { tab: editTab, id: entry?.id ?? `cost-${randomId()}`, creating: !entry,
      name: entry && "name" in entry ? entry.name : "", amount: entry && "purchasePrice" in entry ? String(entry.purchasePrice) : entry && "amount" in entry ? String(entry.amount) : "",
      priceUnit: entry && "priceUnit" in entry ? entry.priceUnit : "元/吨", density: entry && "density" in entry && entry.density !== undefined ? String(entry.density) : "",
      densityUnit: entry && "densityUnit" in entry ? entry.densityUnit ?? "" : "g/cm³", basis: entry && "basis" in entry ? entry.basis : "PER_PIECE",
      enabled: entry && "defaultEnabled" in entry ? entry.defaultEnabled : true, key: entry && "key" in entry ? entry.key : "",
      value: entry && "value" in entry ? entry.value : "", unit: entry && "unit" in entry ? entry.unit ?? "" : "",
      allowances: entry && "allowances" in entry ? entry.allowances.map((allowance) => ({ name: allowance.name, value: String(allowance.valueMm) })) : []
    };
    setDraft(initial);
    setDraftBaseline(JSON.stringify(initial));
  }
  function change(patch: Partial<CostDraft>): void { setDraft((value) => value ? { ...value, ...patch } : null); }

  async function persist(next: CostDataSnapshot): Promise<void> {
    if (pendingRef.current) return;
    validateCostSnapshot(next);
    pendingRef.current = true;
    setPending(true);
    setSaveError(null);
    try {
      await costRepo.updateCostData(next);
      invalidate("cost:effective");
      setDraft(null);
      setDeleting(null);
      setSaved(true);
    } catch (caught) {
      throw new Error(describeError(caught).message, { cause: caught });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function save(): Promise<void> {
    if (!draft || pendingRef.current) return;
    try {
      const updatedAt = new Date().toISOString();
      const next: CostDataSnapshot = { ...current, capturedAt: updatedAt };
      const name = draft.name.trim();
      if (draft.tab !== "allowances" && !name) throw new Error("名称不能为空");
      if (name.length > MAX_NAME_LENGTH) throw new Error(`名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
      if (draft.creating) {
        const count = draft.tab === "materials" ? current.materials.length : draft.tab === "fixed-costs" ? current.fixedCosts.length : current.customFields.length;
        if (count >= MAX_COST_ITEMS) throw new Error(`该分类最多 ${MAX_COST_ITEMS} 条，无法继续新增`);
      }
      if (draft.tab === "materials") {
        if (!draft.priceUnit.trim() || !draft.densityUnit.trim()) throw new Error("价格单位和密度单位不能为空");
        if (!(COST_PRICE_UNITS as readonly string[]).includes(draft.priceUnit.trim())) throw new Error("价格单位不在支持范围内，请从列表中选择");
        if (!(COST_DENSITY_UNITS as readonly string[]).includes(draft.densityUnit.trim())) throw new Error("密度单位不在支持范围内，请从列表中选择");
        const old = current.materials.find((entry) => entry.id === draft.id);
        const value: MaterialCostValue = { id: draft.id, name, purchasePrice: numberValue(draft.amount, "采购价格", true), priceUnit: draft.priceUnit.trim(),
          density: numberValue(draft.density, "密度", true, MAX_DENSITY), densityUnit: draft.densityUnit.trim(), effectiveFrom: old?.effectiveFrom ?? updatedAt, updatedAt };
        next.materials = draft.creating ? [...current.materials, value] : current.materials.map((entry) => entry.id === draft.id ? value : entry);
      } else if (draft.tab === "fixed-costs") {
        const value: FixedCostValue = { id: draft.id, name, amount: numberValue(draft.amount, "金额"), basis: draft.basis, currency: current.fixedCosts.find((entry) => entry.id === draft.id)?.currency ?? "CNY", defaultEnabled: draft.enabled, updatedAt };
        next.fixedCosts = draft.creating ? [...current.fixedCosts, value] : current.fixedCosts.map((entry) => entry.id === draft.id ? value : entry);
      } else if (draft.tab === "custom") {
        if (!draft.key.trim() || !draft.value.trim()) throw new Error("字段标识和值不能为空");
        if (draft.key.trim().length > MAX_KEY_LENGTH) throw new Error(`字段标识不能超过 ${MAX_KEY_LENGTH} 个字符`);
        const value: CustomCostField = { id: draft.id, name, key: draft.key.trim(), value: draft.value.trim(), ...(draft.unit.trim() ? { unit: draft.unit.trim() } : {}), semantics: "DISPLAY_ONLY", updatedAt };
        next.customFields = draft.creating ? [...current.customFields, value] : current.customFields.map((entry) => entry.id === draft.id ? value : entry);
      } else {
        next.allowances = current.allowances.map((entry) => entry.id === draft.id ? { ...entry, updatedAt,
          allowances: draft.allowances.map((allowance) => ({ name: allowance.name, valueMm: numberValue(allowance.value, allowance.name, false, MAX_ALLOWANCE_MM) })) } : entry);
      }
      await persist(next);
    } catch (caught) { setSaveError(caught instanceof Error ? caught.message : describeError(caught).message); }
  }

  async function remove(): Promise<void> {
    if (!deleting || pendingRef.current) return;
    try {
      const next: CostDataSnapshot = { ...current, capturedAt: new Date().toISOString() };
      if (deleting.tab === "materials") next.materials = current.materials.filter((entry) => entry.id !== deleting.id);
      if (deleting.tab === "fixed-costs") next.fixedCosts = current.fixedCosts.filter((entry) => entry.id !== deleting.id);
      if (deleting.tab === "custom") next.customFields = current.customFields.filter((entry) => entry.id !== deleting.id);
      await persist(next);
    } catch (caught) { setSaveError(caught instanceof Error ? caught.message : describeError(caught).message); }
  }

  const actions = (entry: MaterialCostValue | FixedCostValue | CustomCostField | AllowanceDefinition) => <div className="table-actions">
    <Button variant="ghost" size="sm" disabled={pending || draft !== null || deleting !== null} onClick={() => begin(tab, entry)}>编辑</Button>
    {"name" in entry && <Button variant="ghost" size="sm" disabled={pending || draft !== null || deleting !== null} onClick={() => { setSaveError(null); setSaved(false); setDeleting({ tab, id: entry.id, name: entry.name }); }}>删除</Button>}
  </div>;
  const textField = (label: string, value: string, setter: (value: string) => void, maxLength = MAX_NAME_LENGTH) => <FormField label={label}>
    <TextInput inputProps={{ "aria-label": label, disabled: pending, maxLength }} value={value} onValueChange={setter} />
  </FormField>;
  const numberField = (label: string, value: string, setter: (value: string) => void, min = 0, max = MAX_COST_AMOUNT) => <FormField label={label}>
    <NumberInput inputProps={{ "aria-label": label, disabled: pending }} value={value} onValueChange={setter} min={min} max={max} step={0.01} />
  </FormField>;
  const requestTab = (value: ProductTab): void => {
    if (pending || value === tab) return;
    if (dirty) { setPendingTab(value); return; }
    switchTab(value);
  };
  const switchTab = (value: ProductTab): void => {
    setTab(value); setDraft(null); setDeleting(null); setQuery(""); setSaved(false); setSaveError(null); setPendingTab(null);
  };
  const saveErrorNotice = saveError ? <div ref={draftErrorRef}><InlineNotice tone="error" className="mt-4" role="alert">{saveError}</InlineNotice></div> : null;

  return <div className="page-content" data-route-id="cost-data">
    <div className="section section-tight"><h1 className="page-header-title">成本数据</h1><p className="text-muted text-sm">企业级材料、加工余量与固定成本配置</p></div>
    <Tabs label="成本数据分类" value={tab} onChange={requestTab} options={[
      { value: "materials", label: "材料数据" }, { value: "allowances", label: "加工余量" }, { value: "fixed-costs", label: "固定成本" }, { value: "custom", label: "自定义字段" }
    ]} />
    {saveError && draft === null && deleting === null && <InlineNotice tone="error" className="mb-4" role="alert">{saveError}</InlineNotice>}
    {saved && <InlineNotice tone="success" className="mb-4">成本数据已保存，历史报告的计算依据保持不变。</InlineNotice>}
    <div className="section">
      <div className="flex-between mb-4">
        {tab === "materials" ? <SearchInput placeholder="搜索材料" value={query} onValueChange={setQuery} wide /> : <div />}
        {tab !== "allowances" && <Button variant="primary" size="sm" disabled={pending || draft !== null || deleting !== null} onClick={() => begin(tab)}>{tab === "materials" ? "新增材料" : tab === "fixed-costs" ? "新增成本项" : "新增自定义字段"}</Button>}
      </div>
      {tab === "materials" && current.materials.filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase())).length === 0 && (
        <EmptyState title={query.trim() ? "没有匹配的材料" : "暂无材料数据"} description={query.trim() ? "请调整搜索关键词。" : "点击“新增材料”添加第一条材料。"} />
      )}
      {tab === "materials" && current.materials.filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase())).length > 0 && <DataTable label="材料列表" keyColumn="id" columns={[
        { header: "材料", key: "name" }, { header: "采购价格", key: "price", cellClass: "numeric" }, { header: "价格单位", key: "priceUnit" }, { header: "密度", key: "density", cellClass: "numeric" }, { header: "最后更新", key: "updatedAt" }, { header: "操作", key: "actions", cellClass: "actions" }
      ]} rows={current.materials.filter((entry) => entry.name.toLowerCase().includes(query.trim().toLowerCase())).map((entry) => ({ id: entry.id, name: entry.name, price: formatUnitPriceValue(entry.purchasePrice), priceUnit: entry.priceUnit,
        density: entry.density === undefined ? "—" : `${entry.density} ${entry.densityUnit ?? "单位未设置"}`, updatedAt: formatSmartDate(entry.updatedAt, now), actions: actions(entry) }))} />}
      {tab === "fixed-costs" && current.fixedCosts.length === 0 && <EmptyState title="暂无固定成本" description="点击“新增成本项”添加。" />}
      {tab === "fixed-costs" && current.fixedCosts.length > 0 && <DataTable label="固定成本列表" keyColumn="id" columns={[
        { header: "成本项", key: "name" }, { header: "金额", key: "amount", cellClass: "numeric" }, { header: "计费基准", key: "basis" }, { header: "默认参与", key: "enabled" }, { header: "操作", key: "actions", cellClass: "actions" }
      ]} rows={current.fixedCosts.map((entry) => ({ id: entry.id, name: entry.name, amount: formatCny(entry.amount), basis: basisSuffix(entry.basis), enabled: entry.defaultEnabled ? "是" : "否", actions: actions(entry) }))} />}
      {tab === "allowances" && <DataTable label="默认加工余量" keyColumn="id" columns={[
        { header: "毛坯类型", key: "stockType" }, { header: "方向与默认余量", key: "values" }, { header: "操作", key: "actions", cellClass: "actions" }
      ]} rows={current.allowances.map((entry) => ({ id: entry.id, stockType: stockTypeName(entry.stockType), values: entry.allowances.map((allowance) => `${allowance.name} +${allowance.valueMm} mm`).join("；"), actions: actions(entry) }))} />}
      {tab === "custom" && current.customFields.length === 0 && <EmptyState title="暂无自定义字段" description="点击“新增自定义字段”添加。" />}
      {tab === "custom" && current.customFields.length > 0 && <DataTable label="自定义字段列表" keyColumn="id" columns={[
        { header: "字段名", key: "name" }, { header: "标识", key: "key" }, { header: "值", key: "value" }, { header: "单位", key: "unit" }, { header: "操作", key: "actions", cellClass: "actions" }
      ]} rows={current.customFields.map((entry) => ({ id: entry.id, name: entry.name, key: entry.key, value: entry.value, unit: entry.unit ?? "—", actions: actions(entry) }))} />}

      {draft && <Card className="mt-4"><CardHeader><CardTitle>{draft.creating ? "新增" : "编辑"}{draft.tab === "materials" ? "材料" : draft.tab === "fixed-costs" ? "固定成本" : draft.tab === "custom" ? "自定义字段" : "加工余量"}</CardTitle></CardHeader><CardBody>
        <div className="grid-2">
          {draft.tab !== "allowances" && textField("名称", draft.name, (name) => change({ name }))}
          {(draft.tab === "materials" || draft.tab === "fixed-costs") && numberField(draft.tab === "materials" ? "采购价格" : "金额 (¥)", draft.amount, (amount) => change({ amount }))}
          {draft.tab === "materials" && <>
            <FormField label="价格单位"><Select selectProps={{ "aria-label": "价格单位", disabled: pending }} value={draft.priceUnit} onValueChange={(priceUnit) => change({ priceUnit })} options={[
              ...(!["元/吨", "元/kg", "元/千克", "元/件"].includes(draft.priceUnit) ? [{ value: draft.priceUnit, label: draft.priceUnit || "请选择单位" }] : []),
              { value: "元/吨", label: "元/吨" }, { value: "元/kg", label: "元/kg" }, { value: "元/千克", label: "元/千克" }, { value: "元/件", label: "元/件" }
            ]} /></FormField>
            {numberField("密度", draft.density, (density) => change({ density }), 0.001, MAX_DENSITY)}
            <FormField label="密度单位"><Select selectProps={{ "aria-label": "密度单位", disabled: pending }} value={draft.densityUnit} onValueChange={(densityUnit) => change({ densityUnit })} options={[
              ...(!["g/cm³", "g/cm3"].includes(draft.densityUnit) ? [{ value: draft.densityUnit, label: draft.densityUnit || "请选择单位" }] : []),
              { value: "g/cm³", label: "g/cm³" }, { value: "g/cm3", label: "g/cm3" }
            ]} /></FormField>
          </>}
          {draft.tab === "fixed-costs" && <>
            <FormField label="计费基准"><Select selectProps={{ "aria-label": "计费基准", disabled: pending }} value={draft.basis} onValueChange={(basis) => change({ basis: basis as CostBasis })} options={[{ value: "PER_PIECE", label: "每件" }, { value: "PER_BATCH", label: "每批" }]} /></FormField>
            <FormField label="默认参与测算"><Select selectProps={{ "aria-label": "默认参与测算", disabled: pending }} value={String(draft.enabled)} onValueChange={(enabled) => change({ enabled: enabled === "true" })} options={[{ value: "true", label: "参与" }, { value: "false", label: "不参与" }]} /></FormField>
          </>}
          {draft.tab === "custom" && <>{textField("字段标识", draft.key, (key) => change({ key }), MAX_KEY_LENGTH)}{textField("字段值", draft.value, (value) => change({ value }), 4000)}{textField("单位（可选）", draft.unit, (unit) => change({ unit }), 100)}</>}
          {draft.tab === "allowances" && draft.allowances.map((allowance, index) => <div key={allowance.name}>
            {numberField(`${allowance.name} (mm)`, allowance.value, (value) => change({ allowances: draft.allowances.map((entry, position) => position === index ? { ...entry, value } : entry) }), 0, MAX_ALLOWANCE_MM)}
          </div>)}
        </div>
        {draft.tab === "allowances" && <p className="text-xs text-muted mt-4">方向与单位保持原定义，仅修改各方向的默认余量数值。</p>}
        {saveErrorNotice}
        <div className="flex-row-gap-2 mt-4"><Button variant="primary" size="sm" disabled={pending} onClick={() => void save()}>{pending ? "正在保存…" : "保存"}</Button><Button variant="ghost" size="sm" disabled={pending} onClick={() => { setDraft(null); setSaveError(null); }}>取消</Button></div>
      </CardBody></Card>}
    </div>
    <InlineNotice tone="neutral" className="mt-6">自定义成本字段仅用于记录与展示，不参与自动成本计算。</InlineNotice>
    {deleting && <Dialog labelledBy="delete-cost-title" onClose={() => setDeleting(null)} dismissible={!pending}>
      <div className="dialog-header"><h2 id="delete-cost-title" className="dialog-title">删除成本数据</h2></div><div className="dialog-body"><p>确认删除「{deleting.name}」？此操作仅影响后续测算，历史报告保留原有快照。</p>{saveError && <InlineNotice tone="error" className="mt-4" role="alert">{saveError}</InlineNotice>}</div>
      <div className="dialog-footer"><Button variant="ghost" disabled={pending} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={pending} onClick={() => void remove()}>{pending ? "正在删除…" : "确认删除"}</Button></div>
    </Dialog>}
    {pendingTab !== null && <Dialog labelledBy="discard-cost-draft-title" onClose={() => setPendingTab(null)}>
      <div className="dialog-header"><h2 id="discard-cost-draft-title" className="dialog-title">放弃未保存的修改？</h2></div><div className="dialog-body"><p>当前编辑的内容尚未保存，切换分类后将丢失。</p></div>
      <div className="dialog-footer"><Button variant="ghost" onClick={() => setPendingTab(null)}>继续编辑</Button><Button variant="danger" onClick={() => switchTab(pendingTab)}>放弃修改</Button></div>
    </Dialog>}
  </div>;
}

function MockCostDataPage(props: CostDataPageProps): React.JSX.Element {
  void props;
  const repo = useRepository();
  const state = repo.getCostData();
  const [tab, setTab] = useState<CostDataTab>("materials");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{
    tab: CostDataTab;
    materialId: string;
    fixedCostId: string;
  } | null>(null);
  const [materialPrice, setMaterialPrice] = useState("");
  const [materialDensity, setMaterialDensity] = useState("");
  const [fixedCostAmount, setFixedCostAmount] = useState("");
  const [saved, setSaved] = useState(false);

  const filteredMaterials = state.materials.filter((material) =>
    material.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  function startMaterialEdit(material: MaterialCostValue): void {
    setDraft({ tab: "materials", materialId: material.id, fixedCostId: "" });
    setMaterialPrice(String(material.purchasePrice));
    setMaterialDensity(material.density !== undefined ? String(material.density) : "");
    setSaved(false);
  }

  function startFixedCostEdit(fixedCost: FixedCostValue): void {
    setDraft({ tab: "fixed-costs", materialId: "", fixedCostId: fixedCost.id });
    setFixedCostAmount(String(fixedCost.amount));
    setSaved(false);
  }

  function cancelEdit(): void {
    setDraft(null);
  }

  function saveEdits(): void {
    const updatedAt = new Date().toISOString();
    const materialEdits =
      draft?.tab === "materials"
        ? [
            ...state.materials
              .filter((material) => material.id === draft.materialId)
              .map((material) => ({
                id: material.id,
                name: material.name,
                purchasePrice: Number(materialPrice),
                priceUnit: material.priceUnit,
                density: materialDensity ? Number(materialDensity) : (material.density ?? 0),
                densityUnit: material.densityUnit ?? "g/cm³"
              }))
          ]
        : [];
    const fixedCostEdits =
      draft?.tab === "fixed-costs"
        ? [
            ...state.fixedCosts
              .filter((fixedCost) => fixedCost.id === draft.fixedCostId)
              .map((fixedCost) => ({
                id: fixedCost.id,
                name: fixedCost.name,
                amount: Number(fixedCostAmount),
                currency: fixedCost.currency,
                basis: fixedCost.basis
              }))
          ]
        : [];
    const outcome = repo.editCostData({
      materials: materialEdits,
      fixedCosts: fixedCostEdits,
      updatedAt
    });
    if (outcome.ok) {
      setDraft(null);
      setSaved(true);
    }
  }

  return (
    <div className="page-content" data-route-id="cost-data">
      <div className="section section-tight">
        <div className="flex-between">
          <div>
            <h1 className="page-header-title">成本数据</h1>
            <p className="text-muted text-sm">企业级材料、加工余量与固定成本配置</p>
          </div>
        </div>
      </div>

      <Tabs
        label="成本数据分类"
        value={tab}
        onChange={(value) => {
          setTab(value);
          setDraft(null);
          setQuery("");
        }}
        options={[
          { value: "materials", label: "材料数据" },
          { value: "allowances", label: "加工余量" },
          { value: "fixed-costs", label: "固定成本" }
        ]}
      />

      {tab === "materials" && (
        <div className="section">
          <div className="flex-between mb-4">
            <SearchInput
              placeholder="搜索材料"
              value={query}
              onValueChange={setQuery}
              wide
            />
            <Button variant="primary" size="sm" disabled buttonProps={{ title: "Phase 1 仅支持编辑现有材料" }}>
              新增材料
            </Button>
          </div>

          {saved && draft === null && (
            <InlineNotice tone="success" className="mb-4">
              材料数据已保存
            </InlineNotice>
          )}

          <DataTable
            label="材料列表"
            keyColumn="id"
            columns={[
              { header: "材料", key: "name", width: "24%" },
              { header: "采购价格", key: "price", cellClass: "mono", width: "20%" },
              { header: "价格单位", key: "priceUnit", width: "16%" },
              { header: "密度", key: "density", cellClass: "mono", width: "16%" },
              { header: "最后更新", key: "updatedAt", cellClass: "date", width: "16%" },
              { header: "", key: "actions", width: "8%" }
            ]}
            rows={filteredMaterials.map((material) => ({
              id: material.id,
              name: material.name,
              price: formatUnitPriceValue(material.purchasePrice),
              priceUnit: material.priceUnit,
              density: material.density !== undefined ? `${material.density} ${material.densityUnit ?? "g/cm³"}` : "—",
              updatedAt: formatSmartDate(material.updatedAt, props.now ?? new Date()),
              actions:
                draft === null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="btn-ghost-muted"
                    onClick={() => startMaterialEdit(material)}
                  >
                    编辑
                  </Button>
                ) : null
            }))}
          />

          {draft?.tab === "materials" && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>
                  编辑材料 · {state.materials.find((m) => m.id === draft.materialId)?.name}
                </CardTitle>
              </CardHeader>
              <CardBody>
                <div className="grid-2">
                  <FormField label="采购价格" htmlFor="edit-material-price">
                    <NumberInput
                      inputProps={{ id: "edit-material-price" }}
                      value={materialPrice}
                      onValueChange={setMaterialPrice}
                      min={0}
                    />
                  </FormField>
                  <FormField label="密度 (g/cm³)" htmlFor="edit-material-density">
                    <NumberInput
                      inputProps={{ id: "edit-material-density" }}
                      value={materialDensity}
                      onValueChange={setMaterialDensity}
                      min={0}
                      step={0.01}
                    />
                  </FormField>
                </div>
                <div className="flex-row-gap-2 mt-4">
                  <Button variant="primary" size="sm" onClick={saveEdits}>
                    保存
                  </Button>
                  <Button variant="ghost" size="sm" onClick={cancelEdit}>
                    取消
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      {tab === "allowances" && (
        <div className="section">
          <DataTable
            label="默认加工余量"
            keyColumn="id"
            columns={[
              { header: "毛坯类型", key: "stockType", width: "25%" },
              { header: "方向", key: "direction", width: "35%" },
              { header: "默认余量", key: "allowance", cellClass: "mono", width: "40%" }
            ]}
            rows={state.allowances.flatMap((def) =>
              def.allowances.map((allowance, index) => ({
                id: `${def.id}-${index}`,
                stockType: def.stockType === "CYLINDER" ? "圆柱毛坯" : "矩形毛坯",
                direction: allowance.name.replace("默认余量", ""),
                allowance: `+${allowance.valueMm} mm`
              }))
            )}
          />
        </div>
      )}

      {tab === "fixed-costs" && (
        <div className="section">
          <div className="flex-between mb-4">
            <div />
            <Button variant="primary" size="sm" disabled buttonProps={{ title: "Phase 1 仅支持编辑现有固定成本" }}>
              新增成本项
            </Button>
          </div>

          {saved && draft === null && (
            <InlineNotice tone="success" className="mb-4">
              固定成本已保存
            </InlineNotice>
          )}

          <DataTable
            label="固定成本列表"
            keyColumn="id"
            columns={[
              { header: "成本项", key: "name", width: "35%" },
              { header: "金额", key: "amount", cellClass: "mono", width: "25%" },
              { header: "计费基准", key: "basis", width: "20%" },
              { header: "最后更新", key: "updatedAt", cellClass: "date", width: "20%" },
              { header: "", key: "actions", width: "8%" }
            ]}
            rows={state.fixedCosts.map((fixedCost) => ({
              id: fixedCost.id,
              name: fixedCost.name,
              amount: formatCny(fixedCost.amount),
              basis: fixedCost.name === "包装成本" ? `${basisSuffix(fixedCost.basis)} (默认参与每次成本测算)` : basisSuffix(fixedCost.basis),
              updatedAt: formatSmartDate(fixedCost.updatedAt, props.now ?? new Date()),
              actions:
                draft === null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="btn-ghost-muted"
                    onClick={() => startFixedCostEdit(fixedCost)}
                  >
                    编辑
                  </Button>
                ) : null
            }))}
          />

          {draft?.tab === "fixed-costs" && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>
                  编辑固定成本 · {state.fixedCosts.find((f) => f.id === draft.fixedCostId)?.name}
                </CardTitle>
              </CardHeader>
              <CardBody>
                <FormField label="金额 (¥)">
                  <NumberInput
                    value={fixedCostAmount}
                    onValueChange={setFixedCostAmount}
                    min={0}
                  />
                </FormField>
                <div className="flex-row-gap-2 mt-4">
                  <Button variant="primary" size="sm" onClick={saveEdits}>
                    保存
                  </Button>
                  <Button variant="ghost" size="sm" onClick={cancelEdit}>
                    取消
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      <InlineNotice tone="neutral" className="mt-6">
        自定义成本字段仅用于记录与展示，不参与自动成本计算。
      </InlineNotice>
    </div>
  );
}

export default CostDataPage;
