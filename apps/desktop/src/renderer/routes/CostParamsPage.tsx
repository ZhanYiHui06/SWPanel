import { canCreateCostEstimateReport } from "@swpanel/domain";
import type { CostEstimateInputSnapshot, CostEstimateResult, StockType } from "@swpanel/domain";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  InputGroup,
  InputSuffix,
  InlineNotice,
  NumberInput,
  PropertyList,
  Select,
  TextInput
} from "@swpanel/ui";
import { useMemo, useState, useEffect } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import {
  CANONICAL_FINISHED_VOLUME,
  CANONICAL_STOCK_SPEC,
  defaultAllowancesFor
} from "../fixtures/index.js";
import { resolveDrawingId, resolveRevisionId } from "../features/ids.js";
import { basisSuffix, formatVolumeCubicMeters } from "../features/presentation.js";
import { useRepository } from "../features/repository-provider.js";
import { useDrawingRepository } from "../features/bridge-repository/drawing-repository-provider.js";
import { useDrawingDetailQuery, useRevisionDetailQuery } from "../features/bridge-repository/index.js";
import {
  useCostRepository,
  useEffectiveCostDataQuery,
  useCostInvalidate
} from "../features/cost-repository/index.js";

export interface CostParamsPageProps {
  readonly now?: Date;
}

const STOCK_TYPE_OPTIONS: ReadonlyArray<{ label: string; value: StockType }> = [
  { label: "圆柱料", value: "CYLINDER" },
  { label: "矩形料", value: "RECTANGULAR_BAR" }
];

function parseAllowance(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\+/, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function CostParamsPage(props: CostParamsPageProps): React.JSX.Element {
  const drawingRepository = useDrawingRepository();
  if (drawingRepository.mode !== "mock") {
    return <ProductCostParamsPage {...props} />;
  }
  return <MockCostParamsPage {...props} />;
}

function ProductCostParamsPage(props: CostParamsPageProps): React.JSX.Element {
  void props;
  const parameters = useParams();
  const navigate = useNavigate();
  const costRepo = useCostRepository();
  const costInvalidate = useCostInvalidate();

  const drawingId = parameters.drawingId ?? null;
  const revisionId = parameters.revisionId ?? null;

  const { data: drawingDetail } = useDrawingDetailQuery(drawingId);
  const { data: revisionDetail } = useRevisionDetailQuery(drawingId, revisionId);
  const { data: costData, loading: costLoading } = useEffectiveCostDataQuery();

  const [quantity, setQuantity] = useState("1");
  const [materialId, setMaterialId] = useState("");
  const [stockType, setStockType] = useState<StockType>("CYLINDER");
  const [stockSpec, setStockSpec] = useState(CANONICAL_STOCK_SPEC);
  const [allowances, setAllowances] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(defaultAllowancesFor("CYLINDER").map((allowance) => [allowance.name, `+${allowance.valueMm}`]))
  );
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (costData && costData.materials.length > 0 && !materialId) {
      const materialFact = revisionDetail?.facts.find((f) => f.field === "材料");
      const matched = materialFact
        ? costData.materials.find((m) => m.name === materialFact.value)
        : undefined;
      setMaterialId(matched?.id ?? costData.materials[0]!.id);
    }
  }, [costData, revisionDetail, materialId]);

  if (!drawingId || !revisionId) {
    return <Navigate to="/drawings" replace />;
  }

  if ((!drawingDetail || !revisionDetail || costLoading) && !costData) {
    return (
      <div className="page-content" data-route-id="cost-params">
        <div className="section">
          <p className="text-muted">正在加载测算参数...</p>
        </div>
      </div>
    );
  }

  if (!drawingDetail || !revisionDetail || !costData) {
    return (
      <div className="page-content" data-route-id="cost-params">
        <div className="section">
          <div className="data-sheet">
            <p className="text-sm text-muted mb-4">无法打开该图纸的成本测算参数确认页面。</p>
            <Link to="/drawings" className="btn btn-secondary btn-sm">
              返回图纸库
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Same invariant as `canCreateCostEstimateReport`: only the current
  // Revision's current Approved Model may generate a new cost report.
  const eligible =
    drawingDetail.drawing.currentRevisionId === revisionDetail.revision.revisionId &&
    revisionDetail.revision.currentApprovedModelId !== null;
  const modelId = revisionDetail.revision.currentApprovedModelId;
  const model = modelId ? revisionDetail.models.find((m) => m.modelId === modelId) : undefined;

  const handleStockTypeChange = (newStockType: StockType) => {
    setStockType(newStockType);
    setAllowances(
      Object.fromEntries(defaultAllowancesFor(newStockType).map((allowance) => [allowance.name, `+${allowance.valueMm}`]))
    );
  };

  const handleAllowanceChange = (name: string, value: string) => {
    setAllowances((prev) => ({ ...prev, [name]: value }));
  };

  const handleGenerate = async () => {
    setError(null);
    const parsedQty = Number(quantity);
    if (!Number.isInteger(parsedQty) || parsedQty < 1) {
      setError("测算数量必须是大于或等于 1 的整数");
      return;
    }
    if (!stockSpec.trim()) {
      setError("毛坯规格不能为空");
      return;
    }
    if (!materialId) {
      setError("请选择材料");
      return;
    }

    const parsedAllowances = Object.entries(allowances).map(([name, raw]) => {
      const val = parseAllowance(raw);
      return { name, valueMm: val ?? 0 };
    });

    const inputSnapshot: CostEstimateInputSnapshot = {
      drawingId,
      revisionId,
      modelId: modelId!,
      quantity: parsedQty,
      materialId,
      stockType,
      stockSpec: stockSpec.trim(),
      finishedVolume: CANONICAL_FINISHED_VOLUME,
      allowances: parsedAllowances,
      costData,
      formulaVersion: "2026.08-p7",
      capturedAt: new Date().toISOString()
    };

    try {
      setGenerating(true);
      const created = await costRepo.createCostReport(inputSnapshot, new Date().toISOString());
      costInvalidate();
      void navigate(`/drawings/${drawingId}/revisions/${revisionId}/costs/${created.costReportId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "生成成本测算报告失败");
      setGenerating(false);
    }
  };

  const selectedMaterial = costData.materials.find((m) => m.id === materialId);
  const costsBackLink = `/drawings/${drawingId}/revisions/${revisionId}/costs`;

  return (
    <div className="page-content" data-route-id="cost-params">
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <div className="flex-row-gap-3">
              <h1 className="workspace-drawing-number" style={{ fontSize: 18 }}>
                成本测算参数确认
              </h1>
            </div>
            <div className="workspace-drawing-name" style={{ marginTop: 6 }}>
              {drawingDetail.drawing.drawingNumber} · {revisionDetail.revision.revisionLabel} · {drawingDetail.drawing.name}
            </div>
          </div>
          <div className="workspace-header-actions">
            <Link className="btn btn-ghost btn-sm" to={costsBackLink}>
              取消
            </Link>
            <Button
              variant="primary"
              size="sm"
              disabled={!eligible || model === undefined || generating}
              onClick={handleGenerate}
            >
              {generating ? "正在测算..." : "生成成本测算报告"}
            </Button>
          </div>
        </div>
      </div>

      {!eligible || model === undefined ? (
        <Card className="mt-4">
          <CardBody>
            <EmptyState
              title="当前版本暂无正式模型"
              description="完成自动建模并通过人工审核后，方可进行成本测算。"
            />
          </CardBody>
        </Card>
      ) : (
        <>
          {error && (
            <InlineNotice tone="error" className="mb-4">
              {error}
            </InlineNotice>
          )}

          <div className="grid-2">
            <div>
              <Card>
                <CardHeader>
                  <CardTitle>参数设置</CardTitle>
                </CardHeader>
                <CardBody>
                  <FormField label="测算数量">
                    <NumberInput
                      value={quantity}
                      onValueChange={setQuantity}
                      min={1}
                      step={1}
                    />
                  </FormField>

                  <FormField label="材料选择" className="mt-4">
                    <Select
                      value={materialId}
                      onValueChange={setMaterialId}
                      options={costData.materials.map((m) => ({
                        value: m.id,
                        label: `${m.name} (¥${m.purchasePrice}/${m.priceUnit})`
                      }))}
                    />
                  </FormField>

                  <FormField label="毛坯类型" className="mt-4">
                    <Select
                      value={stockType}
                      onValueChange={(value) => handleStockTypeChange(value as StockType)}
                      options={STOCK_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    />
                  </FormField>

                  <FormField label="毛坯规格" className="mt-4">
                    <TextInput
                      value={stockSpec}
                      onValueChange={setStockSpec}
                    />
                  </FormField>

                  <div className="mt-4">
                    <label className="form-label">加工余量 (mm)</label>
                    <div className="grid-2 mt-2">
                      {Object.entries(allowances).map(([name, val]) => (
                        <InputGroup key={name}>
                          <TextInput
                            value={val}
                            onValueChange={(v) => handleAllowanceChange(name, v)}
                          />
                          <InputSuffix>mm</InputSuffix>
                        </InputGroup>
                      ))}
                    </div>
                  </div>
                </CardBody>
              </Card>
            </div>

            <div>
              <Card>
                <CardHeader>
                  <CardTitle>计算依据快照预览</CardTitle>
                </CardHeader>
                <CardBody>
                  <PropertyList
                    items={[
                      { key: "依据模型", value: model.modelLabel },
                      {
                        key: "材料基准",
                        value: selectedMaterial
                          ? `${selectedMaterial.name} · ¥${selectedMaterial.purchasePrice} / ${selectedMaterial.priceUnit}`
                          : "—"
                      },
                      {
                        key: "零件精加工体积",
                        value: formatVolumeCubicMeters(CANONICAL_FINISHED_VOLUME)
                      },
                      {
                        key: "固定成本配置",
                        value: costData.fixedCosts
                          .map((f) => `${f.name} ¥${f.amount}${basisSuffix(f.basis)}`)
                          .join("，") || "无"
                      }
                    ]}
                  />
                </CardBody>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MockCostParamsPage(props: CostParamsPageProps): React.JSX.Element {
  void props;
  const repository = useRepository();
  const parameters = useParams();
  const navigate = useNavigate();

  const drawingId = useMemo(
    () => resolveDrawingId(repository, parameters.drawingId),
    [repository, parameters.drawingId]
  );
  const revisionId = useMemo(
    () => resolveRevisionId(repository, drawingId, parameters.revisionId),
    [repository, drawingId, parameters.revisionId]
  );

  const drawing = drawingId !== null ? repository.getDrawing(drawingId) : undefined;
  const revision = revisionId !== null ? repository.getRevision(revisionId) : undefined;
  const eligible =
    drawingId !== null &&
    revisionId !== null &&
    drawing !== undefined &&
    revision !== undefined &&
    canCreateCostEstimateReport(drawing, revision);
  const modelId = revision?.currentApprovedModelId ?? null;
  const model = modelId !== null ? repository.getModel(modelId) : undefined;
  const costData = repository.getEffectiveCostData();

  const [quantity, setQuantity] = useState("1");
  const [materialId, setMaterialId] = useState(() => {
    const materialFact =
      revisionId !== null
        ? repository.listFacts().find((fact) => fact.revisionId === revisionId && fact.field === "材料")
        : undefined;
    const matched =
      materialFact !== undefined
        ? costData.materials.find((material) => material.name === materialFact.value)
        : undefined;
    return matched?.id ?? costData.materials[0]?.id ?? "";
  });
  const [stockType, setStockType] = useState<StockType>("CYLINDER");
  const [stockSpec, setStockSpec] = useState(CANONICAL_STOCK_SPEC);
  const [allowances, setAllowances] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(defaultAllowancesFor("CYLINDER").map((allowance) => [allowance.name, `+${allowance.valueMm}`]))
  );
  const [error, setError] = useState<string | null>(null);

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  function handleStockTypeChange(nextStockType: StockType): void {
    setStockType(nextStockType);
    setAllowances(
      Object.fromEntries(
        defaultAllowancesFor(nextStockType).map((allowance) => [allowance.name, `+${allowance.valueMm}`])
      )
    );
  }

  function handleAllowanceChange(name: string, raw: string): void {
    setAllowances((current) => ({ ...current, [name]: raw }));
  }

  const handleGenerate = (): void => {
    setError(null);
    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
      setError("测算数量必须是大于 0 的整数");
      return;
    }
    if (stockSpec.trim().length === 0) {
      setError("毛坯规格不能为空");
      return;
    }
    if (materialId.length === 0) {
      setError("请选择材料");
      return;
    }
    const parsedAllowances = Object.entries(allowances).map(([name, raw]) => {
      const parsed = parseAllowance(raw);
      return { name, parsed, raw };
    });
    const invalidAllowance = parsedAllowances.find((entry) => entry.parsed === null);
    if (invalidAllowance !== undefined) {
      setError(`余量 "${invalidAllowance.name}" 输入无效: "${invalidAllowance.raw}"`);
      return;
    }

    const inputSnapshot: CostEstimateInputSnapshot = {
      drawingId,
      revisionId,
      modelId: modelId ?? "",
      quantity: parsedQuantity,
      materialId,
      stockType,
      stockSpec: stockSpec.trim(),
      finishedVolume: CANONICAL_FINISHED_VOLUME,
      allowances: parsedAllowances.map((entry) => ({
        name: entry.name,
        valueMm: entry.parsed ?? 0
      })),
      costData: repository.getEffectiveCostData(),
      formulaVersion: "2026.08-p7",
      capturedAt: new Date().toISOString()
    };

    const emptyResult: CostEstimateResult = {
      rawStockVolume: 0,
      materialQuantity: 0,
      materialCost: 0,
      fixedCostLines: [],
      perPieceCost: 0,
      totalCost: 0,
      currency: "CNY"
    };

    const outcome = repository.createCostReport({
      drawingId,
      revisionId,
      modelId: modelId ?? "",
      inputSnapshot,
      result: emptyResult,
      createdAt: new Date().toISOString()
    });

    if (outcome) {
      void navigate(`/drawings/${drawingId}/revisions/${revisionId}/costs/${outcome}`);
    }
  };

  const selectedMaterial = costData.materials.find((material) => material.id === materialId);
  const costsBackLink = `/drawings/${drawingId}/revisions/${revisionId}/costs`;

  return (
    <div className="page-content" data-route-id="cost-params">
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <div className="flex-row-gap-3">
              <h1 className="workspace-drawing-number" style={{ fontSize: 18 }}>
                成本测算参数确认
              </h1>
            </div>
            <div className="workspace-drawing-name" style={{ marginTop: 6 }}>
              {drawing?.drawingNumber} · {revision?.sequence} · {drawing?.name}
            </div>
          </div>
          <div className="workspace-header-actions">
            <Link className="btn btn-ghost btn-sm" to={costsBackLink}>
              取消
            </Link>
            {eligible && model !== undefined && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleGenerate}
              >
                生成成本测算报告
              </Button>
            )}
          </div>
        </div>
      </div>

      {!eligible || model === undefined ? (
        <Card className="mt-4">
          <CardBody>
            <EmptyState
              title="当前版本暂无正式模型"
              description="完成自动建模并通过人工审核后，方可进行成本测算。"
            />
          </CardBody>
        </Card>
      ) : (
        <>
          {error && (
            <InlineNotice tone="error" className="mb-4">
              {error}
            </InlineNotice>
          )}

          <div className="grid-2">
            <div>
              <Card>
                <CardHeader>
                  <CardTitle>模型信息</CardTitle>
                </CardHeader>
                <CardBody>
                  <FormField label="数量" htmlFor="cost-param-quantity">
                    <NumberInput
                      inputProps={{ id: "cost-param-quantity", "aria-label": "数量" }}
                      value={quantity}
                      onValueChange={setQuantity}
                      min={1}
                      step={1}
                    />
                  </FormField>

                  <FormField label="材料选择" htmlFor="cost-param-material" className="mt-4">
                    <Select
                      selectProps={{ id: "cost-param-material", "aria-label": "材料选择" }}
                      value={materialId}
                      onValueChange={setMaterialId}
                      options={costData.materials.map((m) => ({
                        value: m.id,
                        label: `${m.name} (¥${m.purchasePrice}/${m.priceUnit})`
                      }))}
                    />
                  </FormField>

                  <FormField label="毛坯类型" htmlFor="cost-param-stock-type" className="mt-4">
                    <Select
                      selectProps={{ id: "cost-param-stock-type", "aria-label": "毛坯类型" }}
                      value={stockType}
                      onValueChange={(value) => handleStockTypeChange(value as StockType)}
                      options={STOCK_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    />
                  </FormField>

                  <FormField label="毛坯规格" htmlFor="cost-param-stock-spec" className="mt-4">
                    <TextInput
                      inputProps={{ id: "cost-param-stock-spec", "aria-label": "毛坯规格" }}
                      value={stockSpec}
                      onValueChange={setStockSpec}
                    />
                  </FormField>

                  <div className="mt-4">
                    <label className="form-label">加工余量 (mm)</label>
                    <div className="grid-2 mt-2">
                      {Object.entries(allowances).map(([name, val]) => (
                        <InputGroup key={name}>
                          <TextInput
                            inputProps={{ "aria-label": name }}
                            value={val}
                            onValueChange={(v) => handleAllowanceChange(name, v)}
                          />
                          <InputSuffix>mm</InputSuffix>
                        </InputGroup>
                      ))}
                    </div>
                  </div>
                </CardBody>
              </Card>
            </div>

            <div>
              <Card>
                <CardHeader>
                  <CardTitle>成本数据摘要</CardTitle>
                </CardHeader>
                <CardBody>
                  <PropertyList
                    items={[
                      { key: "依据模型", value: `MODEL ${model.number}` },
                      {
                        key: "材料基准",
                        value: selectedMaterial
                          ? `${selectedMaterial.name} · ¥${selectedMaterial.purchasePrice} / ${selectedMaterial.priceUnit}`
                          : "—"
                      },
                      {
                        key: "零件精加工体积",
                        value: formatVolumeCubicMeters(CANONICAL_FINISHED_VOLUME)
                      },
                      {
                        key: "固定成本配置",
                        value: costData.fixedCosts
                          .map((f) => `${f.name} ¥${f.amount}${basisSuffix(f.basis)}`)
                          .join("，") || "无"
                      }
                    ]}
                  />
                </CardBody>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default CostParamsPage;
