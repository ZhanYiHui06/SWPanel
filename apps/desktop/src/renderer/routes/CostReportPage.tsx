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

import { resolveDrawingId, resolveReportId, resolveRevisionId } from "../features/ids.js";
import {
  basisSuffix,
  formatCny,
  formatSmartDate,
  formatVolumeCubicMeters,
  stockTypeName
} from "../features/presentation.js";
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

  const { data: drawingDetail } = useDrawingDetailQuery(drawingId);
  const { data: revisionDetail } = useRevisionDetailQuery(drawingId, revisionId);
  const { data: reportDetail, loading, error } = useCostReportDetailQuery(reportId);

  if (!drawingId || !revisionId || !reportId) {
    return <Navigate to="/drawings" replace />;
  }

  if (loading && !reportDetail) {
    return (
      <div className="page-content" data-route-id="cost-report">
        <div className="section">
          <p className="text-muted">正在加载成本测算报告...</p>
        </div>
      </div>
    );
  }

  if (error || !reportDetail || !drawingDetail || !revisionDetail) {
    return (
      <div className="page-content" data-route-id="cost-report">
        <Card>
          <CardBody>
            <EmptyState
              title="未找到成本测算报告"
              description="报告参数无效或报告已被删除，请返回成本测算列表重新选择。"
            />
          </CardBody>
        </Card>
      </div>
    );
  }

  const { snapshot } = reportDetail;
  const { input, result } = snapshot;
  const model = revisionDetail.models.find((m) => m.modelId === reportDetail.modelId);
  const material = input.costData.materials.find((m) => m.id === input.materialId);
  const packagingLine = result.fixedCostLines.find((line) => line.basis === "PER_BATCH");
  const costsBackLink = `/drawings/${drawingId}/revisions/${revisionId}/costs`;

  return (
    <div className="page-content" data-route-id="cost-report">
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <div className="flex-row-gap-3">
              <h1 className="workspace-drawing-number" style={{ fontSize: 18 }}>
                {reportDetail.label}
              </h1>
              <StatusBadge variant="no-model">内部参考</StatusBadge>
            </div>
            <div className="workspace-drawing-name" style={{ marginTop: 6 }}>
              成本测算报告 · {formatSmartDate(reportDetail.createdAt, now)} 生成
            </div>
          </div>
          <div className="workspace-header-actions">
            <Link className="btn btn-ghost btn-sm" to={costsBackLink}>
              返回成本测算
            </Link>
            <Button variant="secondary" size="sm" disabled buttonProps={{ title: "Phase 7 尚未实现导出" }}>
              导出
            </Button>
            <Button variant="ghost-muted" size="sm" onClick={() => setDeleteOpen(true)}>
              删除报告
            </Button>
          </div>
        </div>
      </div>

      {deleteOpen && reportDetail !== undefined && (
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

      <div className="section">
        <Card>
          <CardBody>
            <ReportSection number="01" title="零件与模型信息">
              <div className="report-properties-grid">
                <ReportProperty label="图纸编号" value={drawingDetail.drawing.drawingNumber} />
                <ReportProperty label="零件名称" value={drawingDetail.drawing.name} />
                <ReportProperty label="版本" value={revisionDetail.revision.revisionLabel} mono />
                <ReportProperty label="依据模型" value={model?.modelLabel ?? reportDetail.modelId} mono />
                <ReportProperty label="测算数量" value={`${reportDetail.quantity} 件`} mono />
              </div>
            </ReportSection>

            <ReportSection number="02" title="毛坯与原料参数">
              <div className="report-properties-grid">
                <ReportProperty label="毛坯形式" value={stockTypeName(input.stockType)} />
                <ReportProperty label="毛坯规格" value={input.stockSpec} mono />
                <ReportProperty
                  label="加工余量"
                  value={input.allowances.map((a) => `${a.name.replace("默认余量", "")} +${a.valueMm} mm`).join("，") || "无"}
                />
                <ReportProperty
                  label="原料体积 (估算)"
                  value={formatVolumeCubicMeters(result.rawStockVolume)}
                  mono
                />
              </div>
            </ReportSection>

            <ReportSection number="03" title="成本计算依据">
              <div className="report-properties-grid">
                <ReportProperty
                  label="选用材料"
                  value={material ? `${material.name} (密度 ${material.density ?? 7.85} ${material.densityUnit ?? "g/cm³"})` : "—"}
                />
                <ReportProperty
                  label="材料基准价"
                  value={material ? `¥${material.purchasePrice} / ${material.priceUnit}` : "—"}
                  mono
                />
                <ReportProperty
                  label="固定成本"
                  value={input.costData.fixedCosts.map((f) => `${f.name} ¥${f.amount}${basisSuffix(f.basis)}`).join("，") || "无"}
                />
                <ReportProperty
                  label="快照时间"
                  value={formatSmartDate(input.capturedAt, now)}
                  mono
                />
              </div>
            </ReportSection>

            <ReportSection number="04" title="成本明细">
              <div className="report-properties-grid">
                <ReportProperty
                  label="单件材料费"
                  value={formatCny(result.materialCost / (reportDetail.quantity || 1))}
                  mono
                />
                {result.fixedCostLines
                  .filter((line) => line.basis === "PER_PIECE")
                  .map((line) => (
                    <ReportProperty
                      key={line.name}
                      label={`单件${line.name}`}
                      value={formatCny(line.subtotal)}
                      mono
                    />
                  ))}
                {packagingLine && (
                  <ReportProperty
                    label={`批次${packagingLine.name}`}
                    value={`${formatCny(packagingLine.subtotal)} (分摊 ${formatCny(packagingLine.subtotal / (reportDetail.quantity || 1))} / 件)`}
                    mono
                  />
                )}
              </div>
            </ReportSection>

            <ReportSection number="05" title="测算汇总结果">
              <div className="report-properties-grid">
                <ReportProperty
                  label="预估单件成本"
                  value={formatCny(result.perPieceCost)}
                  mono
                />
                <ReportProperty
                  label={`总估算成本 (${reportDetail.quantity} 件)`}
                  value={
                    <span style={{ fontSize: 18, fontWeight: 700, color: "var(--color-primary-600, #2563eb)" }}>
                      {formatCny(result.totalCost)}
                    </span>
                  }
                  mono
                />
              </div>
            </ReportSection>
          </CardBody>
        </Card>
      </div>

      <InlineNotice tone="neutral" className="mt-6">
        成本测算报告为内部成本参考，不构成最终对客报价。
      </InlineNotice>
    </div>
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

  if (report === undefined || drawing === undefined || revision === undefined) {
    return (
      <div className="page-content" data-route-id="cost-report">
        <Card>
          <CardBody>
            <EmptyState
              title="未找到成本测算报告"
              description="报告参数无效或报告已被删除，请返回成本测算列表重新选择。"
            />
          </CardBody>
        </Card>
      </div>
    );
  }

  const { input, result } = report.snapshot;
  const model = repository.getModel(report.modelId);
  const material = input.costData.materials.find((candidate) => candidate.id === input.materialId);
  const packagingLine = result.fixedCostLines.find((line) => line.basis === "PER_BATCH");
  const costsBackLink = `/drawings/${drawingId}/revisions/${revisionId}/costs`;

  return (
    <div className="page-content" data-route-id="cost-report">
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <div className="flex-row-gap-3">
              <h1 className="workspace-drawing-number" style={{ fontSize: 18 }}>
                {report.label}
              </h1>
              <StatusBadge variant="no-model">内部参考</StatusBadge>
            </div>
            <div className="workspace-drawing-name" style={{ marginTop: 6 }}>
              成本测算报告 · {formatSmartDate(report.createdAt, now)} 生成
            </div>
          </div>
          <div className="workspace-header-actions">
            <Link className="btn btn-ghost btn-sm" to={costsBackLink}>
              返回成本测算
            </Link>
            <Button variant="secondary" size="sm" disabled buttonProps={{ title: "Phase 1 尚未实现导出" }}>
              导出
            </Button>
            <Button variant="ghost-muted" size="sm" onClick={() => setDeleteOpen(true)}>
              删除报告
            </Button>
          </div>
        </div>
      </div>

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

      <div className="section">
        <Card>
          <CardBody>
            <ReportSection number="01" title="零件与模型信息">
              <div className="report-properties-grid">
                <ReportProperty label="图纸编号" value={drawing.drawingNumber} />
                <ReportProperty label="零件名称" value={drawing.name} />
                <ReportProperty label="版本" value={revision.sequence} mono />
                <ReportProperty label="依据模型" value={model?.number ?? report.modelId} mono />
                <ReportProperty label="测算数量" value={`${report.quantity} 件`} mono />
              </div>
            </ReportSection>

            <ReportSection number="02" title="毛坯与原料参数">
              <div className="report-properties-grid">
                <ReportProperty label="毛坯形式" value={stockTypeName(input.stockType)} />
                <ReportProperty label="毛坯规格" value={input.stockSpec} mono />
                <ReportProperty
                  label="加工余量"
                  value={input.allowances.map((a) => `${a.name.replace("默认余量", "")} +${a.valueMm} mm`).join("，") || "无"}
                />
                <ReportProperty
                  label="原料体积 (估算)"
                  value={formatVolumeCubicMeters(result.rawStockVolume)}
                  mono
                />
              </div>
            </ReportSection>

            <ReportSection number="03" title="成本计算依据">
              <div className="report-properties-grid">
                <ReportProperty
                  label="选用材料"
                  value={material ? `${material.name} (密度 ${material.density ?? 7.85} ${material.densityUnit ?? "g/cm³"})` : "—"}
                />
                <ReportProperty
                  label="材料基准价"
                  value={material ? `¥${material.purchasePrice} / ${material.priceUnit}` : "—"}
                  mono
                />
                <ReportProperty
                  label="固定成本"
                  value={input.costData.fixedCosts.map((f) => `${f.name} ¥${f.amount}${basisSuffix(f.basis)}`).join("，") || "无"}
                />
                <ReportProperty
                  label="快照时间"
                  value={formatSmartDate(input.capturedAt, now)}
                  mono
                />
              </div>
            </ReportSection>

            <ReportSection number="04" title="成本明细">
              <div className="report-properties-grid">
                <ReportProperty
                  label="单件材料费"
                  value={formatCny(result.materialCost / (report.quantity || 1))}
                  mono
                />
                {result.fixedCostLines
                  .filter((line) => line.basis === "PER_PIECE")
                  .map((line) => (
                    <ReportProperty
                      key={line.name}
                      label={`单件${line.name}`}
                      value={formatCny(line.subtotal)}
                      mono
                    />
                  ))}
                {packagingLine && (
                  <ReportProperty
                    label={`批次${packagingLine.name}`}
                    value={`${formatCny(packagingLine.subtotal)} (分摊 ${formatCny(packagingLine.subtotal / (report.quantity || 1))} / 件)`}
                    mono
                  />
                )}
              </div>
            </ReportSection>

            <ReportSection number="05" title="成本测算结果">
              <div className="report-properties-grid">
                <ReportProperty
                  label="预估单件成本"
                  value={formatCny(result.perPieceCost)}
                  mono
                />
                <ReportProperty
                  label={`总估算成本（${report.quantity} 件）`}
                  value={
                    <span style={{ fontSize: 18, fontWeight: 700, color: "var(--color-primary-600, #2563eb)" }}>
                      {formatCny(result.totalCost)}
                    </span>
                  }
                  mono
                />
              </div>
            </ReportSection>
          </CardBody>
        </Card>
      </div>

      <InlineNotice tone="neutral" className="mt-6">
        成本测算报告为内部成本参考，不构成最终对客报价。
      </InlineNotice>
    </div>
  );
}

export default CostReportPage;
