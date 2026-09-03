import { Card, CardBody, CardHeader, CardTitle } from "@swpanel/ui";
import { Link, Navigate, useParams } from "react-router-dom";

import { useMemo } from "react";

import type { RunDetailView, RunListItemView } from "@swpanel/contracts";

import { useRepository } from "../features/repository-provider.js";
import { useDrawingQuery, useDrawingRepository } from "../features/bridge-repository/drawing-repository-provider.js";
import { useRunQuery, useRunRepository } from "../features/run-repository/run-repository-provider.js";
import { resolveDrawingId, resolveRevisionId, revisionLabelOrId } from "../features/ids.js";
import { DrawingWorkspace } from "../features/drawing/DrawingWorkspace.js";
import { RunTimeline, toRunTimelineItem, type RunTimelineItem } from "../features/runs/RunTimeline.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";

export interface DrawingRunsPageProps {
  readonly now?: Date;
}

/**
 * Drawing Workspace · 建模记录 product runtime: real async runs of the active
 * revision over the RunRepository, rendered as the canonical status-colored
 * timeline inside the real Drawing workspace scaffold.
 */
function ProductDrawingRunsPage({ now }: { readonly now: Date }): React.JSX.Element {
  const parameters = useParams();
  const drawingRepository = useDrawingRepository();
  const runRepository = useRunRepository();

  const drawingId = drawingRepository.resolveDrawingParam(parameters.drawingId);
  const revisionId = drawingRepository.resolveRevisionParam(drawingId, parameters.revisionId);

  const detailQuery = useDrawingQuery(
    drawingId === null ? "drawing:detail:" : `drawing:detail:${drawingId}`,
    () => drawingRepository.getDrawingDetail(drawingId as string),
    { enabled: drawingId !== null }
  );

  const timelineQuery = useRunQuery(
    revisionId === null ? "revision:runs:" : `revision:runs:${revisionId}`,
    async (): Promise<readonly RunTimelineItem[]> => {
      const all = await runRepository.listRuns();
      // RunListItemView has no drawing/revision ids, so the drawing/revision
      // scope is resolved through the (parallel, cached) run details.
      const details = await Promise.all(
        all.map((run) => runRepository.getRunDetail(run.runId).catch(() => null))
      );
      const scoped: { run: RunListItemView; detail: RunDetailView }[] = [];
      for (let index = 0; index < all.length; index++) {
        const detail = details[index] as RunDetailView | null;
        if (detail !== null && detail.run.revisionId === revisionId) {
          scoped.push({ run: all[index] as RunListItemView, detail });
        }
      }
      scoped.sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
      return scoped.map(({ run, detail }) => ({
        ...toRunTimelineItem({
          runId: run.runId,
          runLabel: run.runLabel,
          status: run.status,
          createdAt: run.createdAt,
          modelId: run.modelId,
          clarificationRequestId: run.clarificationRequestId,
          failureMessage: detail.run.failureMessage ?? null,
          now
        }),
        detailHref: `/runs/${run.runId}`
      }));
    },
    { enabled: revisionId !== null }
  );

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <div className="page-content wide" data-route-id="drawing-runs">
      <div className="section section-tight">
        <h1 className="page-header-title">Drawing Workspace · 建模记录</h1>
      </div>
      {children}
    </div>
  );

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  if (detailQuery.status === "loading" || detailQuery.data === undefined) {
    return shell(<QueryLoadingState label="正在加载图纸详情…" />);
  }

  if (detailQuery.status === "error") {
    return shell(
      <QueryErrorState
        title="图纸详情加载失败"
        error={detailQuery.error}
        onRetry={() => detailQuery.retry()}
        action={
          <Link to="/drawings" className="btn btn-ghost btn-sm">
            返回图纸库
          </Link>
        }
      />
    );
  }

  const drawingDetail = detailQuery.data;
  const revisionLabelById = (id: string): string =>
    drawingDetail.revisions.find((revision) => revision.revisionId === id)?.revisionLabel ?? id;
  const runCount = timelineQuery.data?.length ?? 0;

  return (
    <div className="page-content wide" data-route-id="drawing-runs">
      <DrawingWorkspace
        drawingId={drawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={revisionId}
        revisionLabelById={revisionLabelById}
        activeTab="runs"
      >
        <Card>
          <CardHeader>
            <CardTitle>建模记录</CardTitle>
            <span className="text-xs text-muted text-mono">
              {drawingDetail.drawing.drawingNumber} · {revisionLabelById(revisionId)} · {runCount} 次 Run
            </span>
          </CardHeader>
          <CardBody>
            {timelineQuery.status === "loading" && (
              <div className="text-sm text-muted" role="status">
                正在加载建模记录…
              </div>
            )}
            {timelineQuery.status === "error" && (
              <QueryErrorState
                title="建模记录加载失败"
                error={timelineQuery.error}
                onRetry={() => timelineQuery.retry()}
              />
            )}
            {timelineQuery.status === "success" && timelineQuery.data !== undefined && (
              <>
                <RunTimeline items={timelineQuery.data} />
                {runCount === 0 && (
                  <div className="mt-4">
                    <Link
                      to={`/drawings/${drawingId}/revisions/${revisionId}/overview`}
                      className="btn btn-secondary btn-sm"
                    >
                      前往概览开始自动建模
                    </Link>
                  </div>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </DrawingWorkspace>
    </div>
  );
}

/**
 * Drawing Workspace · 建模记录 (`/drawings/:drawingId/revisions/:revisionId/runs`).
 * Lists every Modeling Run of the active revision as a status-colored timeline,
 * newest first, matching the `.design/pages/drawing-runs.html` story.
 *
 * Mock runtime: deterministic Phase 1 fixture UI (sync). Product runtime (real
 * bridge / no bridge): real async data over the RunRepository (the timeline
 * refetches when the run cache is invalidated after create/cancel).
 */
export function DrawingRunsPage({ now = new Date() }: DrawingRunsPageProps): React.JSX.Element {
  const repository = useRepository();
  const parameters = useParams();

  const drawingId = useMemo(
    () => resolveDrawingId(repository, parameters.drawingId),
    [repository, parameters.drawingId]
  );
  const revisionId = useMemo(
    () => resolveRevisionId(repository, drawingId, parameters.revisionId),
    [repository, drawingId, parameters.revisionId]
  );

  const drawingRepository = useDrawingRepository();
  if (drawingRepository.mode !== "mock") {
    return <ProductDrawingRunsPage now={now} />;
  }

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  const detail = repository.getRevisionDetail(drawingId, revisionId);
  const drawingDetail = repository.getDrawingDetail(drawingId);

  const runsDescending = [...detail.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const timelineItems = runsDescending.map((run: RunListItemView) => {
    const rawRun = repository.getRun(run.runId);
    const item = toRunTimelineItem({
      runId: run.runId,
      runLabel: run.runLabel,
      status: run.status,
      createdAt: run.createdAt,
      modelId: run.modelId,
      clarificationRequestId: run.clarificationRequestId,
      failureMessage: rawRun?.failureMessage ?? null,
      now
    });
    return { ...item, detailHref: `/runs/${run.runId}` };
  });

  return (
    <div className="page-content wide" data-route-id="drawing-runs">
      <DrawingWorkspace
        drawingId={drawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={revisionId}
        revisionLabelById={(id) => revisionLabelOrId(repository, id)}
        activeTab="runs"
      >
        <Card>
          <CardHeader>
            <CardTitle>建模记录</CardTitle>
            <span className="text-xs text-muted text-mono">
              {drawingDetail.drawing.drawingNumber} · {detail.revision.revisionLabel} · {detail.runs.length} 次 Run
            </span>
          </CardHeader>
          <CardBody>
            <RunTimeline items={timelineItems} />
          </CardBody>
        </Card>
      </DrawingWorkspace>
    </div>
  );
}

export default DrawingRunsPage;
