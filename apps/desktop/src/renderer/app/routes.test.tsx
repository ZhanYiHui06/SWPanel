import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { DEVELOPMENT_ROUTE, PRODUCT_ROUTES } from "./routes.js";
import { RoutePlaceholder } from "../routes/RoutePlaceholder.js";

describe("product route registry", () => {
  it("contains exactly the 14 approved product pages", () => {
    expect(PRODUCT_ROUTES).toHaveLength(14);
    expect(new Set(PRODUCT_ROUTES.map((route) => route.id)).size).toBe(14);
    const productPaths: readonly string[] = PRODUCT_ROUTES.map((route) => route.path);
    expect(productPaths).not.toContain(DEVELOPMENT_ROUTE.path);
  });

  it("parameterizes drawing, revision, model, run, and report identifiers", () => {
    const patterns = PRODUCT_ROUTES.map((route) => route.path);

    expect(patterns).toContain("/drawings/:drawingId/revisions/:revisionId/overview");
    expect(patterns).toContain("/drawings/:drawingId/revisions/:revisionId/models/:modelId");
    expect(patterns).toContain("/drawings/:drawingId/revisions/:revisionId/costs/:reportId");
    expect(patterns).toContain("/runs/:runId");
  });

  it.each(PRODUCT_ROUTES)("renders $id from its sample URL", async (route) => {
    const router = createMemoryRouter(
      [{ path: route.path, element: <RoutePlaceholder route={route} /> }],
      { initialEntries: [route.samplePath] }
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: route.title })).toBeInTheDocument();
    expect(document.querySelector(`[data-route-id="${route.id}"]`)).not.toBeNull();
  });
});
