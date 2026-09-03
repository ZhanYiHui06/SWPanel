import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataTable,
  FormField,
  InlineNotice,
  NumberInput,
  SearchInput,
  Tabs
} from "@swpanel/ui";
import type { FixedCostValue, MaterialCostValue, CostDataSnapshot } from "@swpanel/domain";
import { useState } from "react";

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

function ProductCostDataPage({ now: _now = new Date() }: CostDataPageProps): React.JSX.Element {
  const costRepo = useCostRepository();
  const invalidate = useCostInvalidate();
  const { data: snapshot, loading, error, retry } = useEffectiveCostDataQuery();

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
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loading && !snapshot) {
    return (
      <div className="page-content" data-route-id="cost-data">
        <div className="section">
          <p className="text-muted">正在加载成本数据...</p>
        </div>
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="page-content" data-route-id="cost-data">
        <div className="section">
          <InlineNotice tone="error">
            加载成本数据失败: {error?.message ?? "未知错误"}
          </InlineNotice>
          <Button variant="secondary" size="sm" onClick={retry} className="mt-4">
            重试
          </Button>
        </div>
      </div>
    );
  }

  const filteredMaterials = snapshot.materials.filter((material) =>
    material.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  function startMaterialEdit(material: MaterialCostValue): void {
    setDraft({ tab: "materials", materialId: material.id, fixedCostId: "" });
    setMaterialPrice(String(material.purchasePrice));
    setMaterialDensity(material.density !== undefined ? String(material.density) : "");
    setSaved(false);
    setSaveError(null);
  }

  function startFixedCostEdit(fixedCost: FixedCostValue): void {
    setDraft({ tab: "fixed-costs", materialId: "", fixedCostId: fixedCost.id });
    setFixedCostAmount(String(fixedCost.amount));
    setSaved(false);
    setSaveError(null);
  }

  function cancelEdit(): void {
    setDraft(null);
    setSaveError(null);
  }

  async function saveEdits(): Promise<void> {
    const updatedAt = new Date().toISOString();
    const newMaterials = snapshot!.materials.map((m) => {
      if (draft?.tab === "materials" && m.id === draft.materialId) {
        const updated = {
          ...m,
          purchasePrice: Number(materialPrice),
          updatedAt
        };
        if (materialDensity) {
          updated.density = Number(materialDensity);
        } else {
          delete updated.density;
        }
        return updated;
      }
      return m;
    });

    const newFixedCosts = snapshot!.fixedCosts.map((f) => {
      if (draft?.tab === "fixed-costs" && f.id === draft.fixedCostId) {
        return {
          ...f,
          amount: Number(fixedCostAmount),
          updatedAt
        };
      }
      return f;
    });

    const newSnapshot: CostDataSnapshot = {
      ...snapshot!,
      materials: newMaterials,
      fixedCosts: newFixedCosts,
      capturedAt: updatedAt
    };

    try {
      await costRepo.updateCostData(newSnapshot);
      invalidate("cost:effective");
      setDraft(null);
      setSaved(true);
      setSaveError(null);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
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

      {saveError && (
        <InlineNotice tone="error" className="mb-4">
          {saveError}
        </InlineNotice>
      )}

      {tab === "materials" && (
        <div className="section">
          <div className="flex-between mb-4">
            <SearchInput
              placeholder="搜索材料"
              value={query}
              onValueChange={setQuery}
              wide
            />
            <Button variant="primary" size="sm" disabled buttonProps={{ title: "Phase 7 仅支持编辑现有材料" }}>
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
              price: `¥${material.purchasePrice.toLocaleString()}`,
              priceUnit: material.priceUnit,
              density: material.density !== undefined ? `${material.density} ${material.densityUnit ?? "g/cm³"}` : "—",
              updatedAt: formatSmartDate(material.updatedAt, _now),
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
                  编辑材料 · {snapshot.materials.find((m) => m.id === draft.materialId)?.name}
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
            rows={snapshot.allowances.flatMap((def) =>
              def.allowances.map((allowance, index) => ({
                id: `${def.id}-${index}`,
                stockType: index === 0 ? stockTypeName(def.stockType) : "",
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
            <Button variant="primary" size="sm" disabled buttonProps={{ title: "Phase 7 仅支持编辑现有固定成本" }}>
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
            rows={snapshot.fixedCosts.map((fixedCost) => ({
              id: fixedCost.id,
              name: fixedCost.name,
              amount: `¥${fixedCost.amount.toLocaleString()}`,
              basis: basisSuffix(fixedCost.basis),
              updatedAt: formatSmartDate(fixedCost.updatedAt, _now),
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
                  编辑固定成本 · {snapshot.fixedCosts.find((f) => f.id === draft.fixedCostId)?.name}
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
              price: `¥${material.purchasePrice.toLocaleString()}`,
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
              amount: `¥${fixedCost.amount.toLocaleString()}`,
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
