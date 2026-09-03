import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  RepositoryProvider,
  resolveRepositoryScenario,
  useRepository
} from "./repository-provider.js";
import { PRODUCTION_DEFAULT_SCENARIO } from "../fixtures/index.js";

describe("repository scenario resolution", () => {
  it("keeps canonical query selection in development", () => {
    expect(resolveRepositoryScenario(true, "?scenario=model-pending-review")).toBe(
      "model-pending-review"
    );
    expect(resolveRepositoryScenario(true, "?scenario=cost-report-generated")).toBe(
      "cost-report-generated"
    );
  });

  it("uses the production world when development has no valid override", () => {
    expect(resolveRepositoryScenario(true, "")).toBe(PRODUCTION_DEFAULT_SCENARIO);
    expect(resolveRepositoryScenario(true, "?scenario=production-default")).toBe(
      PRODUCTION_DEFAULT_SCENARIO
    );
  });

  it("ignores scenario queries in production", () => {
    expect(resolveRepositoryScenario(false, "")).toBe(PRODUCTION_DEFAULT_SCENARIO);
    expect(resolveRepositoryScenario(false, "?scenario=empty-drawing-library")).toBe(
      PRODUCTION_DEFAULT_SCENARIO
    );
  });

  it("mounts the production default without a scenario control in the DOM", () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useRepository(), {
      wrapper: ({ children }) => <RepositoryProvider>{children}</RepositoryProvider>
    });

    expect(result.current.scenario).toBe(PRODUCTION_DEFAULT_SCENARIO);
    expect(document.querySelector('[name="scenario"]')).toBeNull();
    expect(document.querySelector('[data-scenario-selector]')).toBeNull();
  });
});
