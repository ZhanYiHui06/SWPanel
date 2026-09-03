/**
 * Truthful "later phase" states for the PRODUCT runtime.
 *
 * When the real Electron bridge is present (or the product renderer has no
 * bridge at all), Run / Model / Cost pages must NEVER render Phase 1 fixture
 * data or dead fixture links. These components render an explicit
 * "该能力将在后续阶段启用（暂无真实数据）" state instead. Browser dev / canonical
 * Phase 1 tests keep the fixture UI because they run in EXPLICIT mock mode
 * (`DrawingRepository.mode === "mock"`), so their screenshots and assertions
 * stay deterministic.
 */

import { Card, CardBody, EmptyState } from "@swpanel/ui";
import { Link, Navigate } from "react-router-dom";

import type { DrawingRepository } from "../features/bridge-repository/drawing-repository.js";
import {
  useDrawingQuery
} from "../features/bridge-repository/drawing-repository-provider.js";
import { isNotFoundError } from "../features/bridge-repository/drawing-repository.js";
import type { DrawingWorkspaceTabKey } from "../features/drawing/DrawingWorkspace.js";
import { DrawingWorkspace } from "../features/drawing/DrawingWorkspace.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";

/** Full-page placeholder for later-phase product routes (Runs, Cost Data, ...). */
export interface LaterPhasePageStateProps {
  readonly routeId: string;
  readonly title: string;
  readonly description: string;
}

export function LaterPhasePageState({
  routeId,
  title,
  description
}: LaterPhasePageStateProps): React.JSX.Element {
  return (
    <div className="page-content" data-route-id={routeId}>
      <section className="section section-tight">
        <h1 className="page-header-title">{title}</h1>
      </section>
      <div className="data-sheet">
        <EmptyState
          title="该能力将在后续阶段启用"
          description={description}
          action={
            <Link to="/drawings" className="btn btn-secondary">
              打开图纸库
            </Link>
          }
        />
      </div>
    </div>
  );
}

/** Drawing-workspace tab placeholder for later-phase revision-scoped pages. */
export interface LaterPhaseDrawingTabProps {
  readonly repository: DrawingRepository;
  readonly drawingIdParam: string | undefined;
  readonly revisionIdParam: string | undefined;
  readonly activeTab: DrawingWorkspaceTabKey;
  readonly routeId: string;
  readonly title: string;
  readonly description: string;
}

/**
 * Renders the REAL Drawing workspace scaffold (drawing header, revision rail,
 * tabs) with a truthful empty-state tab body. The real drawing detail is
 * loaded from the DrawingRepository so the route keeps working for real Runner
 * ids; fixture ids resolve to a structured not-found state.
 */
export function LaterPhaseDrawingTab({
  repository,
  drawingIdParam,
  revisionIdParam,
  activeTab,
  routeId,
  title,
  description
}: LaterPhaseDrawingTabProps): React.JSX.Element {
  const drawingId = repository.resolveDrawingParam(drawingIdParam);
  const revisionId = repository.resolveRevisionParam(drawingId, revisionIdParam);

  const detailQuery = useDrawingQuery(
    drawingId === null ? "drawing:detail:" : `drawing:detail:${drawingId}`,
    () => repository.getDrawingDetail(drawingId as string),
    { enabled: drawingId !== null }
  );

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <div className="page-content wide" data-route-id={routeId}>
      <div className="section section-tight">
        <h1 className="page-header-title">Drawing Workspace · {title}</h1>
      </div>
      {children}
    </div>
  );

  if (detailQuery.status === "loading" || detailQuery.data === undefined) {
    return shell(<QueryLoadingState label="正在加载图纸详情…" />);
  }

  if (detailQuery.status === "error") {
    if (isNotFoundError(detailQuery.error)) {
      return shell(
        <div className="data-sheet">
          <p className="text-sm text-muted mb-4">无法打开该图纸的{title}页面。</p>
          <Link to="/drawings" className="btn btn-secondary btn-sm">
            返回图纸库
          </Link>
        </div>
      );
    }
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

  return (
    <div className="page-content wide" data-route-id={routeId}>
      <DrawingWorkspace
        drawingId={drawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={revisionId}
        activeTab={activeTab}
        revisionLabelById={revisionLabelById}
      >
        <Card>
          <CardBody>
            <EmptyState title="该能力将在后续阶段启用" description={description} />
          </CardBody>
        </Card>
      </DrawingWorkspace>
    </div>
  );
}
