import type { CostEstimateInputSnapshot, CostEstimateResult } from "@swpanel/domain";
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  InlineNotice,
  StatusBadge
} from "@swpanel/ui";
import { type ReactNode, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import {
  EMPTY_VALUE,
  formatCny,
  formatDensity,
  formatPriceWithUnit,
  formatVolumeM3
} from "../features/cost-format.js";
import { describeError } from "../features/error-messages.js";
import { resolveDrawingId, resolveReportId, resolveRevisionId } from "../features/ids.js";
import { basisSuffix, formatSmartDate, stockTypeName } from "../features/presentation.js";
import { useRepository } from "../features/repository-provider.js";
import { useDrawingRepository } from "../features/bridge-repository/drawing-repository-provider.js";
import { useDrawingDetailQuery, useRevisionDetailQuery } from "../features/bridge-repository/index.js";
import { useCostReportDetailQuery } from "../features/cost-repository/index.js";
import { useCostInvalidate, useCostRepository } from "../features/cost-repository/cost-repository-provider.js";
import { MockCostRepository } from "../features/cost-repository/mock-cost-repository.js";
import { DeleteCostReportDialog } from "../features/drawing/DrawingDialogs.js";

export interface CostReportPageProps {
  readonly now?: Date;
}

function ReportSection({
  number,
  title,
  children
}: {
  number: string;
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="report-section">
      <div className="report-section-header">
        <span className="report-section-number">{number}</span>
        <span className="report-section-title">{title}</span>
      </div>
      {children}
    </div>
  );
}

function ReportProperty({
  label,
  value,
  mono = false
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="property-row">
      <span className="property-key">{label}</span>
      <span className={`property-value${mono ? " mono" : ""}`}>{value}</span>
    </div>
  );
}

/** Everything the report body needs, independent of mock / product data sources. */
interface ReportViewData {
  readonly label: string;
  readonly createdAt: string;
  readonly quantity: number;
  readonly drawingNumber: string;
  readonly drawingName: string;
  readonly revisionText: ReactNode;
  readonly modelText: string;
  readonly input: CostEstimateInputSnapshot;
  readonly result: CostEstimateResult;
}

/**
 * Report header + the five report sections. Every number is read straight from
 * the frozen snapshot (the domain already rounds money to fen): the page never
 * divides rounded totals again and never substitutes defaults for missing data.
 */
function CostReportView({
  data,
  now,
  costsBackLink,
  exportTitle,
  onDelete,
  children
}: {
  readonly data: ReportViewData;
  readonly now: Date;
  readonly costsBackLink: string;
  readonly exportTitle: string;
  readonly onDelete: () => void;
  readonly children?: ReactNode;
}): React.JSX.Element {
  const { input, result, quantity } = data;
  const material = input.costData.materials.find((candidate) => candidate.id === input.materialId);
  const pieceLines = result.fixedCostLines.filter((line) => line.basis === "PER_PIECE");
  const batchLines = result.fixedCostLines.filter((line) => line.basis === "PER_BATCH");
  const batchTotal = batchLines.reduce((sum, line) => sum + line.subtotal, 0);
  const appliedFixedCosts = input.costData.fixedCosts.filter((fixedCost) => fixedCost.defaultEnabled);

  return (
    <div className="page-content" data-route-id="cost-report">
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <div className="flex-row-gap-3">
              <h1 className="workspace-drawing-number" style={{ fontSize: 18 }}>
                {data.label}
              </h1>
              <StatusBadge variant="no-model">内部参考</StatusBadge>
            </div>
            <div className="workspace-drawing-name" style={{ marginTop: 6 }}>
              成本测算报告 · {formatSmartDate(data.createdAt, now)} 生成
            </div>
          </div>
          <div className="workspace-header-actions">
            <Link className="btn btn-ghost btn-sm" to={costsBackLink}>
              返回成本测算
            </Link>
            <Button variant="secondary" size="sm" disabled buttonProps={{ title: exportTitle }}>
              导出
            </Button>
            <Button variant="ghost-muted" size="sm" onClick={onDelete}>
              删除报告
            </Button>
          </div>
        </div>
      </div>

      {children}

      <div className="section">
        <Card>
          <CardBody>
            <ReportSection number="01" title="零件与模型信息">
              <div className="property-list">
                <ReportProperty label="图纸编号" value={data.drawingNumber} />
                <ReportProperty label="零件名称" value={data.drawingName} />
                <ReportProperty label="版本" value={data.revisionText} mono />
                <ReportProperty label="依据模型" value={data.modelText} mono />
                <ReportProperty label="测算数量" value={`${quantity} 件`} mono />
              </div>
            </ReportSection>

            <ReportSection number="02" title="毛坯与原料参数">
              <div className="property-list">
                <ReportProperty label="毛坯形式" value={stockTypeName(input.stockType)} />
                <ReportProperty label="毛坯规格" value={input.stockSpec} mono />
                <ReportProperty
                  label="加工余量"
                  value={input.allowances.map((a) => `${a.name.replace("默认余量", "")} +${a.valueMm} mm`).join("，") || "无"}
                />
                <ReportProperty
                  label="原料体积（估算）"
                  value={formatVolumeM3(result.rawStockVolume)}
                  mono
                />
              </div>
            </ReportSection>

            <ReportSection number="03" title="成本计算依据">
              <div className="property-list">
                <ReportProperty
                  label="选用材料"
                  value={
                    material
                      ? `${material.name}（密度 ${formatDensity(material.density, material.densityUnit)}）`
                      : EMPTY_VALUE
                  }
                />
                <ReportProperty
                  label="材料基准价"
                  value={material ? formatPriceWithUnit(material.purchasePrice, material.priceUnit) : EMPTY_VALUE}
                  mono
                />
                <ReportProperty
                  label="固定成本"
                  value={
                    appliedFixedCosts
                      .map((f) => `${f.name} ${formatCny(f.amount)} ${basisSuffix(f.basis)}`)
                      .join("，") || "无"
                  }
                />
                <ReportProperty
                  label="快照时间"
                  value={formatSmartDate(input.capturedAt, now)}
                  mono
                />
              </div>
            </ReportSection>

            <ReportSection number="04" title="成本明细">
              <div className="property-list">
                <ReportProperty
                  label={`材料费合计（${quantity} 件）`}
                  value={formatCny(result.materialCost)}
                  mono
                />
                {pieceLines.map((line, index) => (
                  <ReportProperty
                    key={`piece-${index}-${line.name}`}
                    label={`单件${line.name}`}
                    value={formatCny(line.subtotal)}
                    mono
                  />
                ))}
                {batchLines.map((line, index) => (
                  <ReportProperty
                    key={`batch-${index}-${line.name}`}
                    label={`批次${line.name}`}
                    value={`${formatCny(line.subtotal)}（整批）`}
                    mono
                  />
                ))}
              </div>
            </ReportSection>

            <ReportSection number="05" title="成本测算结果">
              <div>
                <div className="cost-result-row">
                  <span className="cost-result-label">单件估算成本</span>
                  <span className="cost-result-value">{formatCny(result.perPieceCost)}</span>
                </div>
                {batchLines.length > 0 && (
                  <div className="cost-result-row">
                    <span className="cost-result-label">批次固定成本合计</span>
                    <span className="cost-result-value">{formatCny(batchTotal)}</span>
                  </div>
                )}
                <div className="cost-result-row highlight">
                  <span className="cost-result-label">总估算成本（{quantity} 件）</span>
                  <span className="cost-result-value">{formatCny(result.totalCost)}</span>
                </div>
              </div>
            </ReportSection>
          </CardBody>
        </Card>
      </div>

      <div className="report-disclaimer mt-6">
        成本测算报告为内部成本参考，不构成最终对客报价。
      </div>
    </div>
  );
}

function NotFoundReportState({ costsBackLink }: { readonly costsBackLink: string | null }): React.JSX.Element {
  return (
    <div className="page-content" data-route-id="cost-report">
      <Card>
        <CardBody>
          <EmptyState
            title="未找到成本测算报告"
            description="报告参数无效或报告已被删除，请返回成本测算列表重新选择。"
            action={
              <Link to={costsBackLink ?? "/drawings"} className="btn btn-secondary btn-sm">
                {costsBackLink === null ? "返回图纸库" : "返回成本测算"}
              </Link>
            }
          />
        </CardBody>
      </Card>
    </div>
  );
}

export function CostReportPage(props: CostReportPageProps): React.JSX.Element {
  const drawingRepository = useDrawingRepository();
  if (drawingRepository.mode !== "mock") {
    return <ProductCostReportPage {...props} />;
  }
  return <MockCostReportPage {...props} />;
}

function ProductCostReportPage({ now = new Date() }: CostReportPageProps): React.JSX.Element {
  const parameters = useParams();
  const drawingId = parameters.drawingId ?? null;
  const revisionId = parameters.revisionId ?? null;
  const reportId = parameters.reportId ?? null;
  const costRepository = useCostRepository();
  const invalidateCosts = useCostInvalidate();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const drawingQuery = useDrawingDetailQuery(drawingId);
  const revisionQuery = useRevisionDetailQuery(drawingId, revisionId);
  const reportQuery = useCostReportDetailQuery(reportId);
  const { data: drawingDetail } = drawingQuery;
  const { data: revisionDetail } = revisionQuery;
  const { data: reportDetail, loading, error } = reportQuery;

  if (!drawingId || !revisionId || !reportId) {
    return <Navigate to="/drawings" replace />;
  }

  const costsBackLink = `/drawings/${drawingId}/revisions/${revisionId}/costs`;

  if (loading && !reportDetail) {
    return (
      <div className="page-content" data-route-id="cost-report">
        <div className="data-sheet" role="status" aria-live="polite">
          <div className="empty-state">
            <div className="empty-state-title">正在加载成本测算报告…</div>
          </div>
        </div>
      </div>
    );
  }

  if (error !== null && error.code === "NOT_FOUND") {
    return <NotFoundReportState costsBackLink={costsBackLink} />;
  }

  const loadError = error ?? (reportDetail === null ? null : drawingQuery.error ?? revisionQuery.error);
  if (loadError !== null || reportDetail === null) {
    const described = describeError(loadError);
    return (
      <div className="page-content" data-route-id="cost-report">
        <div className="data-sheet">
          <InlineNotice tone="error" title="成本测算报告加载失败" role="alert">
            {described.message}
            {described.code !== undefined && (
              <span className="text-xs text-muted text-mono" data-error-code={described.code}>
                {" "}（技术详情：{described.code}）
              </span>
            )}
          </InlineNotice>
          <div className="flex-row-gap-3 mt-4" style={{ justifyContent: "flex-start" }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                reportQuery.retry();
                drawingQuery.retry();
                revisionQuery.retry();
              }}
            >
              重试
            </Button>
            <Link to={costsBackLink} className="btn btn-ghost btn-sm">
              返回成本测算
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!drawingDetail || !revisionDetail) {
    // Report is present; the identity context is still being fetched.
    return (
      <div className="page-content" data-route-id="cost-report">
        <div className="data-sheet" role="status" aria-live="polite">
          <div className="empty-state">
            <div className="empty-state-title">正在加载成本测算报告…</div>
          </div>
        </div>
      </div>
    );
  }

  const model = revisionDetail.models.find((candidate) => candidate.modelId === reportDetail.modelId);
  const data: ReportViewData = {
    label: reportDetail.label,
    createdAt: reportDetail.createdAt,
    quantity: reportDetail.quantity,
    drawingNumber: drawingDetail.drawing.drawingNumber,
    drawingName: drawingDetail.drawing.name,
    revisionText: revisionDetail.revision.revisionLabel,
    modelText: model?.modelLabel ?? EMPTY_VALUE,
    input: reportDetail.snapshot.input,
    result: reportDetail.snapshot.result
  };

  return (
    <CostReportView
      data={data}
      now={now}
      costsBackLink={costsBackLink}
      exportTitle="导出功能暂未开放"
      onDelete={() => setDeleteOpen(true)}
    >
      {deleteOpen && (
        <DeleteCostReportDialog
          repository={costRepository}
          costReportId={reportDetail.costReportId}
          revisionId={revisionId}
          reportLabel={reportDetail.label}
          onCancel={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false);
            invalidateCosts();
            void navigate(costsBackLink);
          }}
        />
      )}
    </CostReportView>
  );
}

function MockCostReportPage({ now = new Date() }: CostReportPageProps): React.JSX.Element {
  const repository = useRepository();
  const parameters = useParams();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Mock-mode deletion runs through the explicit MockCostRepository adapter so
  // the exact Phase 1 MockRepository instance the page reads is mutated.
  const deleteRepository = useMemo(() => new MockCostRepository(repository), [repository]);

  const drawingId = useMemo(
    () => resolveDrawingId(repository, parameters.drawingId),
    [repository, parameters.drawingId]
  );
  const revisionId = useMemo(
    () => resolveRevisionId(repository, drawingId, parameters.revisionId),
    [repository, drawingId, parameters.revisionId]
  );
  const reportId = useMemo(
    () => resolveReportId(repository, drawingId, revisionId, parameters.reportId),
    [repository, drawingId, revisionId, parameters.reportId]
  );

  if (drawingId === null || revisionId === null || reportId === null) {
    return <Navigate to="/drawings" replace />;
  }

  const report = repository
    .listReports()
    .find((candidate) => candidate.id === reportId && candidate.revisionId === revisionId);
  const drawing = repository.getDrawing(drawingId);
  const revision = repository.getRevision(revisionId);
  const costsBackLink = `/drawings/${drawingId}/revisions/${revisionId}/costs`;

  if (report === undefined || drawing === undefined || revision === undefined) {
    return <NotFoundReportState costsBackLink={costsBackLink} />;
  }

  const model = repository.getModel(report.modelId);
  const data: ReportViewData = {
    label: report.label,
    createdAt: report.createdAt,
    quantity: report.quantity,
    drawingNumber: drawing.drawingNumber,
    drawingName: drawing.name,
    revisionText: revision.sequence,
    modelText: model?.number ?? report.modelId,
    input: report.snapshot.input,
    result: report.snapshot.result
  };

  return (
    <CostReportView
      data={data}
      now={now}
      costsBackLink={costsBackLink}
      exportTitle="导出功能暂未开放"
      onDelete={() => setDeleteOpen(true)}
    >
      {deleteOpen && (
        <DeleteCostReportDialog
          repository={deleteRepository}
          costReportId={report.id}
          revisionId={revisionId}
          reportLabel={report.label}
          onCancel={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false);
            void navigate(costsBackLink);
          }}
        />
      )}
    </CostReportView>
  );
}

export default CostReportPage;
