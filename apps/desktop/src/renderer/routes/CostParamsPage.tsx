import {
  COST_DENSITY_UNITS,
  COST_PRICE_UNITS,
  MAX_COST_QUANTITY,
  canCreateCostEstimateReport,
  parseStockSpec
} from "@swpanel/domain";
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
import { useMemo, useRef, useState, useEffect } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import {
  CANONICAL_FINISHED_VOLUME,
  CANONICAL_STOCK_SPEC,
  defaultAllowancesFor
} from "../fixtures/index.js";
import { resolveDrawingId, resolveRevisionId } from "../features/ids.js";
import { formatCny, formatPriceWithUnit, formatVolumeM3 } from "../features/cost-format.js";
import { describeError } from "../features/error-messages.js";
import { basisSuffix } from "../features/presentation.js";
import { useModelDetailQuery } from "../features/model-repository/model-repository-provider.js";
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

/** Placeholder sent with the request; the server stamps its own formula version. */
const CLIENT_FORMULA_VERSION = "web";

const STOCK_SPEC_HINT: Readonly<Record<StockType, { readonly example: string; readonly format: string }>> = {
  CYLINDER: { example: "Ø320 × 820 mm", format: "直径 × 长度" },
  RECTANGULAR_BAR: { example: "320 × 200 × 820 mm", format: "长 × 宽 × 高" }
};

interface FieldErrors {
  quantity?: string;
  material?: string;
  stockSpec?: string;
  allowances?: string;
}

const FIELD_FOCUS_IDS: Readonly<Record<keyof FieldErrors, string>> = {
  quantity: "cost-param-quantity",
  material: "cost-param-material",
  stockSpec: "cost-param-stock-spec",
  allowances: "cost-param-allowances"
};

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
  const [stockSpec, setStockSpec] = useState("");
  const [allowances, setAllowances] = useState<Readonly<Record<string, string>>>({});
  const modelId = revisionDetail?.revision.currentApprovedModelId ?? null;
  const modelQuery = useModelDetailQuery(modelId);
  const geometry = modelQuery.data?.geometry;
  const finishedVolume = geometry?.finishedVolumeM3;
  const geometryReady = modelQuery.data?.model.productionVerified === true && finishedVolume !== undefined
    && Number.isFinite(finishedVolume) && finishedVolume > 0;

  // Default allowances are seeded once per stock type. A later refetch of the
  // cost data (focus revalidation, invalidation) must never overwrite values
  // the user has already edited.
  const allowancesSeededFor = useRef<StockType | null>(null);
  useEffect(() => {
    if (costData === null || allowancesSeededFor.current === stockType) return;
    allowancesSeededFor.current = stockType;
    const configured = costData.allowances.find((entry) => entry.stockType === stockType);
    setAllowances(Object.fromEntries((configured?.allowances ?? []).map((entry) => [entry.name, String(entry.valueMm)])));
  }, [costData, stockType]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (costData && costData.materials.length > 0 && !materialId) {
      const materialFact = revisionDetail?.facts.find((f) => f.field === "材料");
      const matched = materialFact
        ? costData.materials.find((m) => m.name === materialFact.value)
        : undefined;
      if (matched) setMaterialId(matched.id);
    }
  }, [costData, revisionDetail, materialId]);

  if (!drawingId || !revisionId) {
    return <Navigate to="/drawings" replace />;
  }

  if ((!drawingDetail || !revisionDetail || costLoading) && !costData) {
    return (
      <div className="page-content" data-route-id="cost-params">
        <div className="section">
          <p className="text-muted" role="status">正在加载测算参数…</p>
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
  const isCurrentRevision = drawingDetail.drawing.currentRevisionId === revisionDetail.revision.revisionId;
  const eligible = isCurrentRevision && revisionDetail.revision.currentApprovedModelId !== null;
  const model = modelId ? revisionDetail.models.find((m) => m.modelId === modelId) : undefined;
  const specHint = STOCK_SPEC_HINT[stockType];
  // Client-side preview only: the report generated by the server is authoritative.
  const previewSpec = stockSpec.trim() === "" ? null : parseStockSpec(stockSpec, stockType, { requireUnit: true });

  const handleStockTypeChange = (newStockType: StockType) => {
    setStockType(newStockType);
    setStockSpec("");
    setFieldErrors((current) => {
      const next = { ...current };
      delete next.stockSpec;
      return next;
    });
  };

  const handleAllowanceChange = (name: string, value: string) => {
    setAllowances((prev) => ({ ...prev, [name]: value }));
  };

  const handleGenerate = async () => {
    setError(null);
    setFieldErrors({});
    if (!eligible || !geometryReady || !finishedVolume) {
      setError("当前正式模型缺少可信体积，无法生成成本测算报告");
      return;
    }
    // Validate every field at once so each message sits next to its field.
    const errors: FieldErrors = {};
    const parsedQty = Number(quantity);
    if (quantity.trim() === "" || !Number.isInteger(parsedQty) || parsedQty < 1 || parsedQty > MAX_COST_QUANTITY) {
      errors.quantity = `测算数量必须是 1 到 ${MAX_COST_QUANTITY.toLocaleString("zh-CN")} 之间的整数`;
    }
    const material = costData.materials.find((entry) => entry.id === materialId);
    if (!materialId) {
      errors.material = "请选择材料";
    } else if (
      !material
      || !(COST_PRICE_UNITS as readonly string[]).includes(material.priceUnit)
      || !(material.purchasePrice > 0)
      || !(material.density && Number.isFinite(material.density) && material.density > 0)
      || !(COST_DENSITY_UNITS as readonly string[]).includes(material.densityUnit ?? "")
    ) {
      errors.material = "材料价格或密度缺少明确的有效单位，请先在成本数据中补全";
    }
    const spec = stockSpec.trim();
    if (!spec) {
      errors.stockSpec = `毛坯规格不能为空，请填写${specHint.format}及单位，例如 ${specHint.example}`;
    } else {
      const parsedSpec = parseStockSpec(spec, stockType, { requireUnit: true });
      if (parsedSpec === null) {
        errors.stockSpec = stockType === "CYLINDER"
          ? "请填写直径 × 长度及单位，例如 Ø320 × 820 mm"
          : "请填写长 × 宽 × 高及单位，例如 320 × 200 × 820 mm";
      } else if (parsedSpec.volumeM3 < finishedVolume) {
        errors.stockSpec = "毛坯体积不得小于模型精加工体积，请核对尺寸与单位";
      }
    }
    const parsedAllowances = Object.entries(allowances).map(([name, raw]) => ({ name, valueMm: parseAllowance(raw) }));
    if (parsedAllowances.some((entry) => entry.valueMm === null || entry.valueMm < 0)) {
      errors.allowances = "加工余量必须为大于或等于 0 的数字（单位 mm）";
    }
    const firstInvalid = (Object.keys(FIELD_FOCUS_IDS) as (keyof FieldErrors)[]).find((key) => errors[key] !== undefined);
    if (firstInvalid !== undefined) {
      setFieldErrors(errors);
      document.getElementById(FIELD_FOCUS_IDS[firstInvalid])?.focus();
      return;
    }

    const inputSnapshot: CostEstimateInputSnapshot = {
      drawingId,
      revisionId,
      modelId: modelId!,
      quantity: parsedQty,
      materialId,
      stockType,
      stockSpec: spec,
      finishedVolume,
      allowances: parsedAllowances.map((entry) => ({ name: entry.name, valueMm: entry.valueMm! })),
      costData,
      formulaVersion: CLIENT_FORMULA_VERSION,
      capturedAt: new Date().toISOString()
    };

    try {
      setGenerating(true);
      const created = await costRepo.createCostReport(inputSnapshot, new Date().toISOString());
      costInvalidate();
      void navigate(`/drawings/${drawingId}/revisions/${revisionId}/costs/${created.costReportId}`);
    } catch (err: unknown) {
      setError(describeError(err).message);
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
              disabled={!eligible || model === undefined || !geometryReady || generating}
              onClick={handleGenerate}
            >
              {generating ? "正在测算…" : "生成成本测算报告"}
            </Button>
          </div>
        </div>
      </div>

      {!eligible || model === undefined ? (
        <Card className="mt-4">
          <CardBody>
            {!isCurrentRevision ? (
              <EmptyState
                title="该版本不是当前版本"
                description="只有当前版本的正式模型可以测算成本。请先在概览页将该版本设为当前版本。"
                action={
                  <Link
                    to={`/drawings/${drawingId}/revisions/${revisionId}/overview`}
                    className="btn btn-secondary btn-sm"
                  >
                    前往概览
                  </Link>
                }
              />
            ) : (
              <EmptyState
                title="当前版本暂无正式模型"
                description="完成自动建模并通过人工审核后，方可进行成本测算。"
              />
            )}
          </CardBody>
        </Card>
      ) : (
        <>
          {error && (
            <InlineNotice tone="error" className="mb-4" role="alert">
              {error}
            </InlineNotice>
          )}

          {!geometryReady && <InlineNotice tone={modelQuery.status === "error" ? "error" : "warning"} className="mb-4">
            {modelQuery.status === "loading" ? "正在读取正式模型体积…" : "当前正式模型缺少可信的精加工体积，暂不能生成成本测算报告。请重新建模并发布经验证的几何数据。"}
            {modelQuery.status === "error" && <Button variant="ghost" size="sm" onClick={() => modelQuery.retry()}>重试读取模型</Button>}
          </InlineNotice>}
          <div className="grid-2">
            <div>
              <Card>
                <CardHeader>
                  <CardTitle>参数设置</CardTitle>
                </CardHeader>
                <CardBody>
                  <FormField
                    label="测算数量"
                    htmlFor="cost-param-quantity"
                    required
                    hint={`整数，1 到 ${MAX_COST_QUANTITY.toLocaleString("zh-CN")} 件`}
                    {...(fieldErrors.quantity === undefined ? {} : { error: fieldErrors.quantity })}
                  >
                    <NumberInput
                      inputProps={{ id: "cost-param-quantity", "aria-label": "测算数量" }}
                      value={quantity}
                      onValueChange={setQuantity}
                      min={1}
                      max={MAX_COST_QUANTITY}
                      step={1}
                      invalid={fieldErrors.quantity !== undefined}
                    />
                  </FormField>

                  <FormField
                    label="材料选择"
                    htmlFor="cost-param-material"
                    required
                    className="mt-4"
                    {...(fieldErrors.material === undefined ? {} : { error: fieldErrors.material })}
                  >
                    <Select
                      value={materialId}
                      onValueChange={setMaterialId}
                      selectProps={{ id: "cost-param-material", "aria-label": "材料选择" }}
                      invalid={fieldErrors.material !== undefined}
                      options={[{ value: "", label: "请选择材料" }, ...costData.materials.map((m) => ({
                        value: m.id,
                        label: `${m.name}（${formatPriceWithUnit(m.purchasePrice, m.priceUnit)}）`
                      }))]}
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

                  <FormField
                    label="毛坯规格"
                    htmlFor="cost-param-stock-spec"
                    required
                    className="mt-4"
                    hint={`填写${specHint.format}及单位（mm、cm 或 m），例如 ${specHint.example}`}
                    {...(fieldErrors.stockSpec === undefined ? {} : { error: fieldErrors.stockSpec })}
                  >
                    <TextInput
                      inputProps={{ id: "cost-param-stock-spec", "aria-label": "毛坯规格", placeholder: specHint.example }}
                      value={stockSpec}
                      onValueChange={setStockSpec}
                      invalid={fieldErrors.stockSpec !== undefined}
                    />
                    <p className="text-xs text-muted mt-2">请填写实际采购毛坯规格，包含加工余量及明确单位。</p>
                    {geometry?.boundingBoxMm && <p className="text-xs text-muted mt-2">模型包围盒参考：{geometry.boundingBoxMm.length} × {geometry.boundingBoxMm.width} × {geometry.boundingBoxMm.height} mm（不含毛坯余量）</p>}
                  </FormField>

                  <fieldset className="mt-4" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="form-label">加工余量 (mm)</legend>
                    {Object.keys(allowances).length === 0 && <p className="text-xs text-muted">当前成本数据未配置该毛坯类型的默认余量；请在毛坯规格中填写实际尺寸。</p>}
                    <div className="grid-2 mt-2">
                      {Object.entries(allowances).map(([name, val], index) => (
                        <InputGroup key={name}>
                          <TextInput
                            inputProps={{ "aria-label": name, ...(index === 0 ? { id: FIELD_FOCUS_IDS.allowances } : {}) }}
                            value={val}
                            onValueChange={(v) => handleAllowanceChange(name, v)}
                            invalid={fieldErrors.allowances !== undefined}
                          />
                          <InputSuffix>mm</InputSuffix>
                        </InputGroup>
                      ))}
                    </div>
                    {fieldErrors.allowances !== undefined && (
                      <p className="form-hint form-hint-error mt-2" role="alert">{fieldErrors.allowances}</p>
                    )}
                  </fieldset>
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
                          ? `${selectedMaterial.name} · ${formatPriceWithUnit(selectedMaterial.purchasePrice, selectedMaterial.priceUnit)}`
                          : "—"
                      },
                      {
                        key: "零件精加工体积",
                        value: geometryReady && finishedVolume ? formatVolumeM3(finishedVolume) : "暂无可信体积"
                      },
                      {
                        key: "毛坯体积（预估）",
                        value: previewSpec === null ? "—" : `${formatVolumeM3(previewSpec.volumeM3)}（预估，以生成的报告为准）`
                      },
                      {
                        key: "固定成本配置",
                        value: costData.fixedCosts
                          .map((f) => `${f.name} ${formatCny(f.amount)} ${basisSuffix(f.basis)}`)
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
            {drawing !== undefined && drawing.currentRevisionId !== revisionId ? (
              <EmptyState
                title="该版本不是当前版本"
                description="只有当前版本的正式模型可以测算成本。请先在概览页将该版本设为当前版本。"
                action={
                  <Link
                    to={`/drawings/${drawingId}/revisions/${revisionId}/overview`}
                    className="btn btn-secondary btn-sm"
                  >
                    前往概览
                  </Link>
                }
              />
            ) : (
              <EmptyState
                title="当前版本暂无正式模型"
                description="完成自动建模并通过人工审核后，方可进行成本测算。"
              />
            )}
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
                        label: `${m.name}（${formatPriceWithUnit(m.purchasePrice, m.priceUnit)}）`
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
                          ? `${selectedMaterial.name} · ${formatPriceWithUnit(selectedMaterial.purchasePrice, selectedMaterial.priceUnit)}`
                          : "—"
                      },
                      {
                        key: "零件精加工体积",
                        value: formatVolumeM3(CANONICAL_FINISHED_VOLUME)
                      },
                      {
                        key: "固定成本配置",
                        value: costData.fixedCosts
                          .map((f) => `${f.name} ${formatCny(f.amount)} ${basisSuffix(f.basis)}`)
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
