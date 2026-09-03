import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

import type { RevisionListItemView } from "@swpanel/contracts";

export type DrawingWorkspaceTabKey = "overview" | "runs" | "models" | "costs" | "memory";

export interface DrawingWorkspaceTab {
  readonly key: DrawingWorkspaceTabKey;
  readonly label: string;
  readonly activePattern: string;
}

export const DRAWING_WORKSPACE_TABS: readonly DrawingWorkspaceTab[] = [
  { key: "overview", label: "概览", activePattern: "/overview" },
  { key: "runs", label: "建模记录", activePattern: "/runs" },
  { key: "models", label: "模型", activePattern: "/models" },
  { key: "costs", label: "成本测算", activePattern: "/costs" },
  { key: "memory", label: "版本记忆", activePattern: "/memory" }
];

export interface DrawingWorkspaceProps {
  readonly drawingId: string;
  readonly drawingNumber: string;
  readonly drawingName: string;
  readonly revisions: readonly RevisionListItemView[];
  readonly activeRevisionId: string;
  readonly activeTab: DrawingWorkspaceTabKey;
  /**
   * Maps a revision id to its display label (e.g. "V2"). Bridge-backed pages
   * derive this from the loaded detail view; Mock pages use the repository.
   */
  readonly revisionLabelById: (revisionId: string) => string;
  /** Drawing-level controls rendered in the canonical workspace header. */
  readonly headerActions?: ReactNode;
  /** Optional revision-creation control rendered below the revision list. */
  readonly revisionAction?: ReactNode;
  /** Read-only variant used by Model Detail (no revision switching). */
  readonly readonly?: boolean;
  readonly children: ReactNode;
}

function pathFor(
  drawingId: string,
  revisionId: string,
  tab: DrawingWorkspaceTabKey
): string {
  return `/drawings/${drawingId}/revisions/${revisionId}/${tab}`;
}

/**
 * The Drawing Workspace scaffold shared by every revision-scoped page: drawing
 * header, revision rail (`.revision-sidebar`) and the workspace tabs
 * (`.tabs`). The active tab stays controlled so the tab bar highlights the
 * current page even when the underlying route is more specific (Model Detail).
 * The scaffold is runtime-agnostic: callers pass a revision label lookup
 * instead of a MockRepository, so real Runner ids render identically.
 */
export function DrawingWorkspace({
  drawingId,
  drawingNumber,
  drawingName,
  revisions,
  activeRevisionId,
  activeTab,
  revisionLabelById,
  headerActions,
  revisionAction,
  readonly = false,
  children
}: DrawingWorkspaceProps): React.JSX.Element {
  const revisionsDescending = [...revisions].reverse();

  return (
    <>
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <h1 className="workspace-drawing-number">{drawingNumber}</h1>
            <div className="workspace-drawing-name">{drawingName}</div>
          </div>
          {headerActions !== undefined && (
            <div className="workspace-header-actions">{headerActions}</div>
          )}
        </div>
      </div>

      <div className="grid-sidebar-main">
        <aside className="revision-sidebar" aria-label="版本导航">
          <div className="revision-sidebar-label">版本</div>
              {!readonly ? (
            <>
              <div className="revision-list">
                {revisionsDescending.map((revision) => {
                  const active = revision.revisionId === activeRevisionId;
                  return (
                    <NavLink
                      key={revision.revisionId}
                      to={pathFor(drawingId, revision.revisionId, activeTab)}
                      className={`revision-item${active ? " active" : ""}`}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className="revision-item-label">
                        {revisionLabelById(revision.revisionId)}
                      </span>
                      {revision.isCurrent && <span className="status-badge current-rev">当前</span>}
                    </NavLink>
                  );
                })}
              </div>
              {revisionAction}
            </>
          ) : (
            <div className="revision-list">
              <div className="revision-item active">
                <span className="revision-item-label">
                  {revisionLabelById(activeRevisionId)}
                </span>
              </div>
            </div>
          )}
        </aside>

        <div>
          <div className="revision-workspace-header">
            <div className="revision-workspace-title">
              {drawingNumber} · {revisionLabelById(activeRevisionId)}
            </div>
          </div>

          <nav className="tabs" aria-label="图纸工作区">
            {DRAWING_WORKSPACE_TABS.map((tab) => (
              <NavLink
                key={tab.key}
                to={pathFor(drawingId, activeRevisionId, tab.key)}
                className={`tab-item${tab.key === activeTab ? " active" : ""}`}
                aria-current={tab.key === activeTab ? "page" : undefined}
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>

          {children}
        </div>
      </div>
    </>
  );
}
