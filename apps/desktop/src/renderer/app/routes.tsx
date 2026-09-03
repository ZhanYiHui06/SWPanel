import { createHashRouter, Navigate, type RouteObject } from "react-router-dom";

import { AppShell } from "../components/AppShell.js";
import { RoutePlaceholder } from "../routes/RoutePlaceholder.js";
import { RepositoryProvider } from "../features/repository-provider.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { RunRepositoryProvider } from "../features/run-repository/run-repository-provider.js";
import { ModelRepositoryProvider } from "../features/model-repository/model-repository-provider.js";
import { CostRepositoryProvider } from "../features/cost-repository/cost-repository-provider.js";
import { NotificationProvider } from "../features/notifications/notification-context.js";
import { DEVELOPMENT_ROUTE, PRODUCT_ROUTES } from "./route-manifest.js";

export { DEVELOPMENT_ROUTE, PRODUCT_ROUTES } from "./route-manifest.js";
export type { ProductRoute } from "./route-manifest.js";

/** Lazily loads a Phase 1 product page module. */
function lazyProductPage(load: () => Promise<{ default: React.ComponentType<Record<string, never>> }>) {
  return {
    lazy: async () => {
      const module = await load();
      return { Component: module.default };
    }
  };
}

export function createAppRouter(isDevelopment: boolean = import.meta.env.DEV) {
  const children: RouteObject[] = [
    {
      id: "workbench",
      path: "/",
      ...lazyProductPage(async () => import("../routes/WorkbenchPage.js"))
    },
    {
      id: "drawings",
      path: "/drawings",
      ...lazyProductPage(async () => import("../routes/DrawingsPage.js"))
    },
    {
      id: "drawing-overview",
      path: "/drawings/:drawingId/revisions/:revisionId/overview",
      ...lazyProductPage(async () => import("../routes/DrawingOverviewPage.js"))
    },
    {
      id: "drawing-memory",
      path: "/drawings/:drawingId/revisions/:revisionId/memory",
      ...lazyProductPage(async () => import("../routes/DrawingMemoryPage.js"))
    },
    {
      id: "drawing-costs",
      path: "/drawings/:drawingId/revisions/:revisionId/costs",
      ...lazyProductPage(async () => import("../routes/DrawingCostsPage.js"))
    },
    {
      id: "cost-params",
      path: "/drawings/:drawingId/revisions/:revisionId/costs/new",
      ...lazyProductPage(async () => import("../routes/CostParamsPage.js"))
    },
    {
      id: "cost-report",
      path: "/drawings/:drawingId/revisions/:revisionId/costs/:reportId",
      ...lazyProductPage(async () => import("../routes/CostReportPage.js"))
    },
    {
      id: "cost-data",
      path: "/cost-data",
      ...lazyProductPage(async () => import("../routes/CostDataPage.js"))
    },
    {
      id: "settings",
      path: "/settings",
      ...lazyProductPage(async () => import("../routes/SettingsPage.js"))
    },
    // ── Modeling runs / models (owned pages) ─────────────────────
    {
      id: "drawing-runs",
      path: "/drawings/:drawingId/revisions/:revisionId/runs",
      ...lazyProductPage(async () => import("../routes/DrawingRunsPage.js"))
    },
    {
      id: "drawing-models",
      path: "/drawings/:drawingId/revisions/:revisionId/models",
      ...lazyProductPage(async () => import("../routes/DrawingModelsPage.js"))
    },
    {
      id: "model-detail",
      path: "/drawings/:drawingId/revisions/:revisionId/models/:modelId",
      ...lazyProductPage(async () => import("../routes/ModelDetailPage.js"))
    },
    {
      id: "runs",
      path: "/runs",
      ...lazyProductPage(async () => import("../routes/RunsPage.js"))
    },
    {
      id: "run-detail",
      path: "/runs/:runId",
      ...lazyProductPage(async () => import("../routes/RunDetailPage.js"))
    }
  ];

  for (const route of PRODUCT_ROUTES) {
    if (children.some((child) => child.id === route.id)) continue;
    children.push({
      id: route.id,
      path: route.path,
      element: <RoutePlaceholder route={route} />
    });
  }

  if (import.meta.env.DEV && isDevelopment) {
    children.push({
      id: DEVELOPMENT_ROUTE.id,
      path: DEVELOPMENT_ROUTE.path,
      lazy: async () => {
        const { ComponentSpecPage } = await import("../routes/ComponentSpecPage.js");
        return { Component: ComponentSpecPage };
      }
    });
  }

  children.push({
    id: "not-found",
    path: "*",
    element: <Navigate to="/" replace />
  });

  return createHashRouter([
    {
      id: "app-shell",
      element: (
        <DrawingRepositoryProvider>
          <RunRepositoryProvider>
            <ModelRepositoryProvider>
              <CostRepositoryProvider>
                <RepositoryProvider>
                  <NotificationProvider>
                    <AppShell />
                  </NotificationProvider>
                </RepositoryProvider>
              </CostRepositoryProvider>
            </ModelRepositoryProvider>
          </RunRepositoryProvider>
        </DrawingRepositoryProvider>
      ),
      children
    }
  ]);
}
