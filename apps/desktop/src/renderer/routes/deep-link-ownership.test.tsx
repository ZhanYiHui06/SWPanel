import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { MockRepository } from "../features/mock-repository/mock-repository.js";
import { RepositoryProvider } from "../features/repository-provider.js";
import {
  resolveDrawingId,
  resolveModelId,
  resolveReportId,
  resolveRevisionId,
  resolveRunId
} from "../features/ids.js";

import { CostParamsPage } from "./CostParamsPage.js";
import { CostReportPage } from "./CostReportPage.js";
import { DrawingCostsPage } from "./DrawingCostsPage.js";
import { DrawingMemoryPage } from "./DrawingMemoryPage.js";
import { DrawingModelsPage } from "./DrawingModelsPage.js";
import { DrawingOverviewPage } from "./DrawingOverviewPage.js";
import { DrawingRunsPage } from "./DrawingRunsPage.js";
import { ModelDetailPage } from "./ModelDetailPage.js";

const NOW = new Date("2026-08-10T23:40:00.000Z");

const MAIN = "drawing-pdjf480-01-17c-4";
const DRAWING_A = "drawing-pdjf273-02-08";
const MAIN_V3 = "rev-main-v3";
const MAIN_V2 = "rev-main-v2";
const DRAWING_A_V2 = "rev-a-v2";

afterEach(cleanup);

// ── Unit-level resolver ownership contracts ─────────────────────────────────

describe("deep-link id resolvers enforce ownership", () => {
  it("scopes revisions to their owning drawing", () => {
    const repo = MockRepository.create("cost-report-generated");
    // Drawing A's V2 requested under the main drawing must not resolve.
    expect(resolveRevisionId(repo, MAIN, DRAWING_A_V2)).toBeNull();
    expect(resolveRevisionId(repo, DRAWING_A, DRAWING_A_V2)).toBe(DRAWING_A_V2);
    // Label-based lookups are scoped too.
    expect(resolveRevisionId(repo, MAIN, "revision-v2")).toBe(MAIN_V2);
    expect(resolveRevisionId(repo, DRAWING_A, "revision-v2")).toBe(DRAWING_A_V2);
  });

  it("scopes models to exactly their owning drawing and revision", () => {
    const repo = MockRepository.create("model-pending-review");
    // M01 belongs to main+V3.
    expect(resolveModelId(repo, MAIN, MAIN_V3, "model-main-m01")).toBe("model-main-m01");
    // Same model under another revision must not resolve.
    expect(resolveModelId(repo, MAIN, MAIN_V2, "model-main-m01")).toBeNull();
    // A model from drawing A under main+V3 must not resolve.
    expect(resolveModelId(repo, MAIN, MAIN_V3, "model-a-m01")).toBeNull();
    expect(resolveModelId(repo, DRAWING_A, DRAWING_A_V2, "model-a-m01")).toBe("model-a-m01");
  });

  it("scopes cost reports to exactly their owning drawing and revision", () => {
    const repo = MockRepository.create("cost-report-generated");
    expect(resolveReportId(repo, MAIN, MAIN_V3, "report-q03")).toBe("report-q03");
    // Same report under another revision of the same drawing must not resolve.
    expect(resolveReportId(repo, MAIN, MAIN_V2, "report-q03")).toBeNull();
    // Same report under another drawing must not resolve.
    expect(resolveReportId(repo, DRAWING_A, DRAWING_A_V2, "report-q03")).toBeNull();
  });

  it("resolves runs by id or label", () => {
    const repo = MockRepository.create("run-running");
    expect(resolveRunId(repo, "run-main-r05")).toBe("run-main-r05");
    expect(resolveRunId(repo, "run-r05")).toBe("run-main-r05");
    expect(resolveRunId(repo, "R05")).toBe("run-main-r05");
    expect(resolveRunId(repo, "nope")).toBeNull();
  });

  it("rejects unknown or empty drawing segments", () => {
    const repo = MockRepository.create("run-running");
    expect(resolveDrawingId(repo, undefined)).toBeNull();
    expect(resolveDrawingId(repo, "does-not-exist")).toBeNull();
    expect(resolveDrawingId(repo, MAIN)).toBe(MAIN);
  });
});

// ── Page-level deep-link ownership: mismatches must redirect ────────────────

interface PageCase {
  readonly name: string;
  readonly entry: string;
  readonly pattern: string;
  readonly page: React.ReactNode;
}

const REVISION_SCOPED_CASES: readonly PageCase[] = [
  { name: "drawing-overview", entry: `/drawings/${MAIN}/revisions/${DRAWING_A_V2}/overview`, pattern: "/drawings/:drawingId/revisions/:revisionId/overview", page: <DrawingOverviewPage now={NOW} /> },
  { name: "drawing-runs", entry: `/drawings/${MAIN}/revisions/${DRAWING_A_V2}/runs`, pattern: "/drawings/:drawingId/revisions/:revisionId/runs", page: <DrawingRunsPage now={NOW} /> },
  { name: "drawing-models", entry: `/drawings/${MAIN}/revisions/${DRAWING_A_V2}/models`, pattern: "/drawings/:drawingId/revisions/:revisionId/models", page: <DrawingModelsPage now={NOW} /> },
  { name: "drawing-costs", entry: `/drawings/${MAIN}/revisions/${DRAWING_A_V2}/costs`, pattern: "/drawings/:drawingId/revisions/:revisionId/costs", page: <DrawingCostsPage now={NOW} /> },
  { name: "cost-params", entry: `/drawings/${MAIN}/revisions/${DRAWING_A_V2}/costs/new`, pattern: "/drawings/:drawingId/revisions/:revisionId/costs/new", page: <CostParamsPage now={NOW} /> },
  { name: "drawing-memory", entry: `/drawings/${MAIN}/revisions/${DRAWING_A_V2}/memory`, pattern: "/drawings/:drawingId/revisions/:revisionId/memory", page: <DrawingMemoryPage now={NOW} /> }
];

import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { MockBridgeDrawingRepository } from "../features/bridge-repository/mock-bridge-repository.js";
import { CostRepositoryProvider } from "../features/cost-repository/cost-repository-provider.js";
import { MockCostRepository } from "../features/cost-repository/mock-cost-repository.js";

function renderRedirect(entry: string, pattern: string, page: React.ReactNode, repository: MockRepository) {
  return render(
    <DrawingRepositoryProvider repository={new MockBridgeDrawingRepository(repository)}>
      <CostRepositoryProvider repository={new MockCostRepository(repository)}>
        <RepositoryProvider repository={repository}>
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="/drawings" element={<div data-route-id="drawings-redirect" />} />
              <Route path={pattern} element={page} />
            </Routes>
          </MemoryRouter>
        </RepositoryProvider>
      </CostRepositoryProvider>
    </DrawingRepositoryProvider>
  );
}

describe("nested drawing/revision routes reject foreign revisions", () => {
  it.each(REVISION_SCOPED_CASES)(
    "$name redirects when the revision belongs to another drawing",
    ({ entry, pattern, page }) => {
      const repository = MockRepository.create("cost-report-generated");
      renderRedirect(entry, pattern, page, repository);
      expect(screen.queryByText("成本测算参数确认")).not.toBeInTheDocument();
      expect(document.querySelector('[data-route-id="drawings-redirect"]')).not.toBeNull();
    }
  );
});

describe("Model Detail deep-link ownership", () => {
  const MODEL_PATTERN = "/drawings/:drawingId/revisions/:revisionId/models/:modelId";

  it("renders a model that belongs exactly to drawing+revision", () => {
    const repository = MockRepository.create("model-pending-review");
    renderRedirect(
      `/drawings/${MAIN}/revisions/${MAIN_V3}/models/model-main-m03`,
      MODEL_PATTERN,
      <ModelDetailPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="model-detail"]')).not.toBeNull();
    expect(document.querySelector('[data-route-id="drawings-redirect"]')).toBeNull();
  });

  it("redirects when the model belongs to another drawing", () => {
    const repository = MockRepository.create("model-pending-review");
    renderRedirect(
      `/drawings/${MAIN}/revisions/${MAIN_V3}/models/model-a-m01`,
      MODEL_PATTERN,
      <ModelDetailPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="model-detail"]')).toBeNull();
    expect(document.querySelector('[data-route-id="drawings-redirect"]')).not.toBeNull();
  });

  it("redirects when the model belongs to another revision of the same drawing", () => {
    const repository = MockRepository.create("model-pending-review");
    renderRedirect(
      `/drawings/${MAIN}/revisions/${MAIN_V2}/models/model-main-m03`,
      MODEL_PATTERN,
      <ModelDetailPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="model-detail"]')).toBeNull();
  });

  it("redirects when the revision belongs to another drawing", () => {
    const repository = MockRepository.create("model-pending-review");
    renderRedirect(
      `/drawings/${MAIN}/revisions/${DRAWING_A_V2}/models/model-a-m01`,
      MODEL_PATTERN,
      <ModelDetailPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="model-detail"]')).toBeNull();
  });

  it("redirects for an unknown model id", () => {
    const repository = MockRepository.create("model-pending-review");
    renderRedirect(
      `/drawings/${MAIN}/revisions/${MAIN_V3}/models/model-does-not-exist`,
      MODEL_PATTERN,
      <ModelDetailPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="model-detail"]')).toBeNull();
  });
});

describe("Cost Report deep-link ownership", () => {
  const REPORT_PATTERN = "/drawings/:drawingId/revisions/:revisionId/costs/:reportId";

  it("renders a report that belongs exactly to drawing+revision", () => {
    const repository = MockRepository.create("cost-report-generated");
    renderRedirect(
      `/drawings/${MAIN}/revisions/${MAIN_V3}/costs/report-q03`,
      REPORT_PATTERN,
      <CostReportPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="cost-report"]')).not.toBeNull();
    expect(document.querySelector('[data-route-id="drawings-redirect"]')).toBeNull();
  });

  it("redirects when the report belongs to another drawing", () => {
    const repository = MockRepository.create("cost-report-generated");
    renderRedirect(
      `/drawings/${DRAWING_A}/revisions/${DRAWING_A_V2}/costs/report-q03`,
      REPORT_PATTERN,
      <CostReportPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="cost-report"]')).toBeNull();
    expect(document.querySelector('[data-route-id="drawings-redirect"]')).not.toBeNull();
  });

  it("redirects when the report belongs to another revision of the same drawing", () => {
    const repository = MockRepository.create("cost-report-generated");
    renderRedirect(
      `/drawings/${MAIN}/revisions/${MAIN_V2}/costs/report-q03`,
      REPORT_PATTERN,
      <CostReportPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="cost-report"]')).toBeNull();
  });

  it("redirects for an unknown report id", () => {
    const repository = MockRepository.create("cost-report-generated");
    renderRedirect(
      `/drawings/${MAIN}/revisions/${MAIN_V3}/costs/report-does-not-exist`,
      REPORT_PATTERN,
      <CostReportPage now={NOW} />,
      repository
    );
    expect(document.querySelector('[data-route-id="cost-report"]')).toBeNull();
  });
});
