import { Button, EmptyState, FilterTabs, PlusIcon, SearchInput } from "@swpanel/ui";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { formatRelativeTime } from "../features/format.js";
import {
  useDrawingInvalidate,
  useDrawingQuery,
  useDrawingRepository
} from "../features/bridge-repository/drawing-repository-provider.js";
import type { DrawingRepository, ImportDrawingResult } from "../features/bridge-repository/drawing-repository.js";
import { ImportDrawingDialog } from "../features/drawing/DrawingDialogs.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";
import { DrawingStatusBadge, type DrawingBusinessStatus } from "./page-data.js";
import { BusinessDeletionDialog } from "../features/deletion/BusinessDeletionDialog.js";
import { useOptionalNotifications } from "../features/notifications/notification-context.js";
import "../styles/phase1-pages.css";

const DISPLAY_NOW = new Date("2026-08-10T23:40:00.000Z");
type DrawingFilter = "all" | "attention" | "approved" | "no-model";

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "attention", label: "待处理" },
  { value: "approved", label: "有正式模型" },
  { value: "no-model", label: "尚未建模" }
] as const;

function matchesFilter(filter: DrawingFilter, status: DrawingBusinessStatus, hasApprovedModel: boolean): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return status === "pending-review" || status === "clarification";
  if (filter === "approved") return status === "approved" || hasApprovedModel;
  return status === "no-model";
}

export interface DrawingsPageProps {
  readonly now?: Date;
  /** Explicit adapter for tests; the provider default resolves the runtime. */
  readonly drawingRepository?: DrawingRepository;
}

/**
 * 图纸库 — loads the REAL drawing list from the async DrawingRepository
 * (product: Runner over the WP5 bridge; dev/tests: explicit mock adapter).
 * Supports search/filter, the real empty state and the 上传图纸 workflow:
 * file picker → focused metadata form → import → refresh → navigate to the new
 * Drawing. Cancelling does nothing and no Modeling Run is ever created.
 */
export function DrawingsPage({ now: nowProp, drawingRepository }: DrawingsPageProps): React.JSX.Element {
  const repository = useDrawingRepository(drawingRepository);
  // Fixture date only in mock mode; real data is relative to the real clock.
  const now = nowProp ?? (repository.mode === "mock" ? DISPLAY_NOW : new Date());
  const invalidate = useDrawingInvalidate();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DrawingFilter>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; label: string } | null>(null);
  const notifications = useOptionalNotifications();

  const listQuery = useDrawingQuery("drawings:list", () => repository.listDrawings());

  const rows = useMemo(() => {
    if (listQuery.status !== "success" || listQuery.data === undefined) return [];
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return listQuery.data
      .map((drawing) => ({ drawing, status: repository.drawingBusinessStatus(drawing) }))
      .filter(({ drawing, status }) => {
        const searched = normalized.length === 0 || drawing.drawingNumber.toLocaleLowerCase("zh-CN").includes(normalized) || drawing.name.toLocaleLowerCase("zh-CN").includes(normalized);
        return searched && matchesFilter(filter, status.key, drawing.currentApprovedModelId !== null);
      });
  }, [filter, listQuery.data, listQuery.status, query, repository]);

  function handleImported(result: ImportDrawingResult): void {
    invalidate();
    setImportOpen(false);
    void navigate(`/drawings/${result.drawing.id}/revisions/${result.revision.id}/overview`);
  }

  return (
    <div className="page-content" data-route-id="drawings">
      <section className="section section-tight" aria-labelledby="drawing-library-title">
        <div className="drawing-library-heading">
          <div><h1 id="drawing-library-title" className="page-header-title">图纸库</h1><p className="text-muted text-sm">管理全部工程图纸与版本</p></div>
          <Button variant="primary" onClick={() => setImportOpen(true)}><PlusIcon aria-hidden="true" />上传图纸</Button>
        </div>
        <div className="drawing-library-controls">
          <SearchInput value={query} onValueChange={setQuery} placeholder="搜索图号 / 名称" className="drawing-library-search" inputProps={{ "aria-label": "搜索图号或名称" }} />
          <FilterTabs options={FILTERS} value={filter} onChange={setFilter} label="图纸状态筛选" />
        </div>
      </section>

      {listQuery.status === "loading" && <QueryLoadingState label="正在加载图纸库…" />}

      {listQuery.status === "error" && (
        <QueryErrorState
          title="图纸库加载失败"
          error={listQuery.error}
          onRetry={() => listQuery.retry()}
        />
      )}

      {listQuery.status === "success" && listQuery.data !== undefined && listQuery.data.length === 0 && (
        <div className="data-sheet">
          <EmptyState
            title="图纸库还是空的"
            description="上传第一份工程图纸后，这里会显示图纸列表。"
            action={<Button variant="primary" onClick={() => setImportOpen(true)}><PlusIcon aria-hidden="true" />上传图纸</Button>}
          />
        </div>
      )}

      {listQuery.status === "success" && listQuery.data !== undefined && listQuery.data.length > 0 && rows.length === 0 ? (
        <div className="data-sheet"><EmptyState title="没有匹配的图纸" description="请调整搜索关键词或状态筛选。" /></div>
      ) : (
        listQuery.status === "success" && rows.length > 0 && (
          <div className="data-sheet">
            <table className="data-table drawing-library-table" aria-label="图纸列表">
              <thead><tr><th>图号</th><th>名称</th><th>当前版本</th><th>业务状态</th><th>最近更新</th><th><span className="sr-only">操作</span></th></tr></thead>
              <tbody>
                {rows.map(({ drawing, status }) => {
                  // No current Revision: never build `/revisions//overview`.
                  const href = drawing.currentRevisionId === null
                    ? "/drawings"
                    : `/drawings/${drawing.drawingId}/revisions/${drawing.currentRevisionId}/overview`;
                  return (
                    <tr key={drawing.drawingId}>
                      <td className="col-mono"><Link className="drawing-table-primary-link" to={href}>{drawing.drawingNumber}</Link></td>
                      <td>{drawing.name}</td>
                      <td className="col-mono col-version">{drawing.currentRevisionLabel ?? "—"}</td>
                      <td><DrawingStatusBadge status={status} /></td>
                      <td className="col-date">{formatRelativeTime(drawing.updatedAt, now)}</td>
                      <td className="col-actions"><Link to={href} className="btn btn-ghost-muted btn-sm" aria-label={`打开图纸 ${drawing.drawingNumber}`}>打开</Link>{repository.deleteObject && <Button variant="ghost" size="sm" onClick={() => setDeleting({ id: drawing.drawingId, label: `图纸 ${drawing.drawingNumber}` })}>删除</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {importOpen && (
        <ImportDrawingDialog
          repository={repository}
          onCancel={() => setImportOpen(false)}
          onImported={handleImported}
        />
      )}
      {deleting && <BusinessDeletionDialog repository={repository} id={deleting.id} label={deleting.label} onCancel={() => setDeleting(null)} onDeleted={warnings => {
        setDeleting(null); invalidate(); notifications?.addNotification({ title: "图纸已删除", tone: warnings.length ? "warning" : "success", ...(warnings.length ? { message: warnings.join(" ") } : {}) });
      }} />}
    </div>
  );
}

export default DrawingsPage;
