import { canCreateCostEstimateReport } from "@swpanel/domain";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  InlineNotice,
  StatusBadge
} from "@swpanel/ui";
import { useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";

import { DrawingWorkspace } from "../features/drawing/DrawingWorkspace.js";
import { DeleteCostReportDialog } from "../features/drawing/DrawingDialogs.js";
import { resolveDrawingId, resolveRevisionId, revisionLabelOrId } from "../features/ids.js";
import { formatCny } from "../features/cost-format.js";
import { formatSmartDate } from "../features/presentation.js";
import { useRepository } from "../features/repository-provider.js";
import {
  useDrawingRepository,
  useDrawingQuery
} from "../features/bridge-repository/drawing-repository-provider.js";
import { isNotFoundError } from "../features/bridge-repository/drawing-repository.js";
import { useCostInvalidate, useCostRepository } from "../features/cost-repository/cost-repository-provider.js";
import { MockCostRepository } from "../features/cost-repository/mock-cost-repository.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";

export interface DrawingCostsPageProps {
  readonly now?: Date;
}

/**
 * Empty state for "no report can be generated here". Two different causes need
 * two different next steps: a non-current Revision must first be made current,
 * while the current Revision still needs an approved model.
 */
function NoEligibleModelState({
  isCurrentRevision,
  overviewPath
}: {
  readonly isCurrentRevision: boolean;
  readonly overviewPath: string;
}): React.JSX.Element {
  if (!isCurrentRevision) {
    return (
      <EmptyState
        title="该版本不是当前版本"
        description="只有当前版本的正式模型可以测算成本。请先在概览页将该版本设为当前版本。"
        action={
          <Link to={overviewPath} className="btn btn-secondary btn-sm">
            前往概览
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      title="当前版本暂无正式模型"
      description="完成自动建模并通过人工审核后，可生成内部成本测算报告。"
    />
  );
}

export function DrawingCostsPage({ now = new Date() }: DrawingCostsPageProps): React.JSX.Element {
  const drawingRepository = useDrawingRepository();
  if (drawingRepository.mode !== "mock") {
    return <ProductDrawingCostsPage now={now} />;
  }
  return <MockDrawingCostsPage now={now} />;
}

function ProductDrawingCostsPage({ now }: { readonly now: Date }): React.JSX.Element {
  const repository = useDrawingRepository();
  const parameters = useParams();
  const costRepository = useCostRepository();
  const invalidateCosts = useCostInvalidate();
  const [deleteTarget, setDeleteTarget] = useState<{ costReportId: string; label: string } | null>(null);
  const drawingId = repository.resolveDrawingParam(parameters.drawingId);
  const revisionId = repository.resolveRevisionParam(drawingId, parameters.revisionId);

  const detailQuery = useDrawingQuery(
    drawingId === null ? "drawing:detail:" : `drawing:detail:${drawingId}`,
    () => repository.getDrawingDetail(drawingId as string),
    { enabled: drawingId !== null }
  );
  const revisionQuery = useDrawingQuery(
    drawingId === null || revisionId === null ? "revision:detail:" : `revision:detail:${drawingId}:${revisionId}`,
    () => repository.getRevisionDetail(drawingId as string, revisionId as string),
    { enabled: drawingId !== null && revisionId !== null }
  );

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <div className="page-content wide" data-route-id="drawing-costs">
      <div className="section section-tight">
        <h1 className="page-header-title">图纸 · 成本测算</h1>
      </div>
      {children}
    </div>
  );

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  if (detailQuery.status === "loading" || (revisionQuery.status === "loading" && revisionQuery.data === undefined)) {
    return shell(<QueryLoadingState label="正在加载成本测算信息…" />);
  }

  if (detailQuery.status === "error") {
    if (isNotFoundError(detailQuery.error)) {
      return shell(
        <div className="data-sheet">
          <p className="text-sm text-muted mb-4">无法打开该图纸的成本测算页面。</p>
          <Link to="/drawings" className="btn btn-secondary btn-sm">
            返回图纸库
          </Link>
        </div>
      );
    }
    return shell(
      <QueryErrorState
        title="加载图纸详情失败"
        error={detailQuery.error}
        onRetry={() => detailQuery.retry()}
      />
    );
  }

  if (revisionQuery.status === "error") {
    if (isNotFoundError(revisionQuery.error)) {
      return <Navigate to="/drawings" replace />;
    }
    return shell(
      <QueryErrorState
        title="加载版本成本测算失败"
        error={revisionQuery.error}
        onRetry={() => revisionQuery.retry()}
      />
    );
  }

  const drawingDetail = detailQuery.data;
  const revisionDetail = revisionQuery.data;
  if (drawingDetail === undefined || revisionDetail === undefined) {
    return <Navigate to="/drawings" replace />;
  }

  // Same invariant as `canCreateCostEstimateReport`: only the current
  // Revision's current Approved Model may generate a new cost report.
  const isCurrentRevision = drawingDetail.drawing.currentRevisionId === revisionDetail.revision.revisionId;
  const eligible = isCurrentRevision && revisionDetail.revision.currentApprovedModelId !== null;
  const approvedModelId = revisionDetail.revision.currentApprovedModelId;
  const approvedModel = approvedModelId ? revisionDetail.models.find((m) => m.modelId === approvedModelId) : undefined;
  const reports = revisionDetail.costReports ?? [];

  return (
    <div className="page-content wide" data-route-id="drawing-costs">
      <DrawingWorkspace
        drawingId={drawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={revisionId}
        revisionLabelById={(id) => {
          const rev = drawingDetail.revisions.find((r) => r.revisionId === id);
          return rev ? rev.revisionLabel : id;
        }}
        activeTab="costs"
      >
        <div className="section">
          {eligible && approvedModel !== undefined ? (
            <Card>
              <CardHeader>
                <CardTitle>当前正式模型</CardTitle>
                <StatusBadge variant="approved">审核通过</StatusBadge>
              </CardHeader>
              <CardBody>
                <div className="flex-between">
                  <div className="flex-row-gap-3">
                    <span className="text-mono" style={{ fontSize: 18, fontWeight: 600 }}>
                      {approvedModel.modelLabel}
                    </span>
                    <div>
                      <div className="text-sm" style={{ fontWeight: 500 }}>
                        {formatSmartDate(approvedModel.generatedAt, now)}
                      </div>
                      <div className="text-xs text-muted" style={{ marginTop: 2 }}>
                        基于当前正式模型生成内部成本测算报告
                      </div>
                    </div>
                  </div>
                  <Link
                    className="btn btn-primary"
                    to={`/drawings/${drawingId}/revisions/${revisionId}/costs/new`}
                  >
                    生成成本测算报告
                  </Link>
                </div>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody>
                <NoEligibleModelState
                  isCurrentRevision={isCurrentRevision}
                  overviewPath={`/drawings/${drawingId}/revisions/${revisionId}/overview`}
                />
              </CardBody>
            </Card>
          )}
        </div>

        <div className="section">
          <div className="section-header">
            <span className="section-title">历史报告</span>
          </div>
          {reports.length === 0 ? (
            <Card>
              <CardBody>
                <EmptyState
                  title="当前版本还没有成本测算报告"
                  description="当前正式模型审核通过后，即可基于模型生成第一份内部成本测算报告。"
                />
              </CardBody>
            </Card>
          ) : (
            <DataTable
              label="历史成本测算报告"
              keyColumn="costReportId"
              columns={[
                { header: "报告", key: "label", cellClass: "mono", width: "12%" },
                { header: "生成时间", key: "createdAt", cellClass: "date", width: "22%" },
                { header: "数量", key: "quantity", cellClass: "numeric", width: "12%" },
                { header: "单件估算成本", key: "perPieceCost", cellClass: "mono", align: "right", width: "18%" },
                { header: "总估算成本", key: "totalCost", cellClass: "mono", align: "right", width: "18%" },
                { header: "", key: "actions", cellClass: "actions" }
              ]}
              rows={reports.map((report) => ({
                costReportId: report.costReportId,
                label: report.label,
                createdAt: formatSmartDate(report.createdAt, now),
                quantity: report.quantity,
                perPieceCost: formatCny(report.perPieceCost),
                totalCost: formatCny(report.totalCost),
                actions: (
                  <>
                    <Link
                      className="btn btn-ghost btn-sm btn-ghost-muted"
                      to={`/drawings/${drawingId}/revisions/${revisionId}/costs/${report.costReportId}`}
                    >
                      查看详情
                    </Link>
                    <Button
                      variant="ghost-muted"
                      size="sm"
                      onClick={() => setDeleteTarget({ costReportId: report.costReportId, label: report.label })}
                    >
                      删除报告
                    </Button>
                  </>
                )
              }))}
            />
          )}
          <InlineNotice tone="neutral" className="mt-6">
            成本测算报告为内部成本参考，不构成最终对客报价。
          </InlineNotice>
        </div>
      </DrawingWorkspace>

      {deleteTarget !== null && (
        <DeleteCostReportDialog
          repository={costRepository}
          costReportId={deleteTarget.costReportId}
          revisionId={revisionId}
          reportLabel={deleteTarget.label}
          onCancel={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            invalidateCosts();
          }}
        />
      )}
    </div>
  );
}

function MockDrawingCostsPage({ now }: { readonly now: Date }): React.JSX.Element {
  const repository = useRepository();
  const parameters = useParams();
  const [deleteTarget, setDeleteTarget] = useState<{ costReportId: string; label: string } | null>(null);
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

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  const drawingDetail = repository.getDrawingDetail(drawingId);
  const drawing = repository.getDrawing(drawingId);
  const revision = repository.getRevision(revisionId);
  const detail = repository.getRevisionDetail(drawingId, revisionId);

  const eligible =
    drawing !== undefined && revision !== undefined && canCreateCostEstimateReport(drawing, revision);
  const isCurrentRevision = drawing !== undefined && drawing.currentRevisionId === revisionId;
  const approvedModelId = revision?.currentApprovedModelId ?? null;
  const approvedModel = approvedModelId !== null ? repository.getModel(approvedModelId) : undefined;
  const approvedRun = approvedModel !== undefined ? repository.getRun(approvedModel.runId) : undefined;
  const reports = detail.costReports;

  return (
    <div className="page-content wide" data-route-id="drawing-costs">
      <DrawingWorkspace
        drawingId={drawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={revisionId}
        revisionLabelById={(id) => revisionLabelOrId(repository, id)}
        activeTab="costs"
      >
        <div className="section">
          {eligible && approvedModel !== undefined ? (
            <Card>
              <CardHeader>
                <CardTitle>当前正式模型</CardTitle>
                <StatusBadge variant="approved">审核通过</StatusBadge>
              </CardHeader>
              <CardBody>
                <div className="flex-between">
                  <div className="flex-row-gap-3">
                    <span className="text-mono" style={{ fontSize: 18, fontWeight: 600 }}>
                      {approvedModel.number}
                    </span>
                    <div>
                      <div className="text-sm" style={{ fontWeight: 500 }}>
                        来源 {approvedRun?.number ?? "—"} · {formatSmartDate(approvedModel.generatedAt, now)}
                      </div>
                      <div className="text-xs text-muted" style={{ marginTop: 2 }}>
                        基于当前正式模型生成内部成本测算报告
                      </div>
                    </div>
                  </div>
                  <Link
                    className="btn btn-primary"
                    to={`/drawings/${drawingId}/revisions/${revisionId}/costs/new`}
                  >
                    生成成本测算报告
                  </Link>
                </div>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody>
                <NoEligibleModelState
                  isCurrentRevision={isCurrentRevision}
                  overviewPath={`/drawings/${drawingId}/revisions/${revisionId}/overview`}
                />
              </CardBody>
            </Card>
          )}
        </div>

        <div className="section">
          <div className="section-header">
            <span className="section-title">历史报告</span>
          </div>
          {reports.length === 0 ? (
            <Card>
              <CardBody>
                <EmptyState
                  title="当前版本还没有成本测算报告"
                  description="当前正式模型审核通过后，即可基于模型生成第一份内部成本测算报告。"
                />
              </CardBody>
            </Card>
          ) : (
            <DataTable
              label="历史成本测算报告"
              keyColumn="costReportId"
              columns={[
                { header: "报告", key: "label", cellClass: "mono", width: "12%" },
                { header: "生成时间", key: "createdAt", cellClass: "date", width: "22%" },
                { header: "数量", key: "quantity", cellClass: "numeric", width: "12%" },
                { header: "单件估算成本", key: "perPieceCost", cellClass: "mono", align: "right", width: "18%" },
                { header: "总估算成本", key: "totalCost", cellClass: "mono", align: "right", width: "18%" },
                { header: "", key: "actions", cellClass: "actions" }
              ]}
              rows={reports.map((report) => ({
                costReportId: report.costReportId,
                label: report.label,
                createdAt: formatSmartDate(report.createdAt, now),
                quantity: report.quantity,
                perPieceCost: formatCny(report.perPieceCost),
                totalCost: formatCny(report.totalCost),
                actions: (
                  <>
                    <Link
                      className="btn btn-ghost btn-sm btn-ghost-muted"
                      to={`/drawings/${drawingId}/revisions/${revisionId}/costs/${report.costReportId}`}
                    >
                      查看详情
                    </Link>
                    <Button
                      variant="ghost-muted"
                      size="sm"
                      onClick={() => setDeleteTarget({ costReportId: report.costReportId, label: report.label })}
                    >
                      删除报告
                    </Button>
                  </>
                )
              }))}
            />
          )}
          <InlineNotice tone="neutral" className="mt-6">
            成本测算报告为内部成本参考，不构成最终对客报价。
          </InlineNotice>
        </div>
      </DrawingWorkspace>

      {deleteTarget !== null && (
        <DeleteCostReportDialog
          repository={deleteRepository}
          costReportId={deleteTarget.costReportId}
          revisionId={revisionId}
          reportLabel={deleteTarget.label}
          onCancel={() => setDeleteTarget(null)}
          onDeleted={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

export default DrawingCostsPage;
