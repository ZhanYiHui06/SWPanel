import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DrawingRepositoryProvider, useDrawingQuery } from "./bridge-repository/drawing-repository-provider.js";
import { MockBridgeDrawingRepository } from "./bridge-repository/mock-bridge-repository.js";
import { CostRepositoryProvider, useCostInvalidate, useCostQuery } from "./cost-repository/cost-repository-provider.js";
import { MockCostRepository } from "./cost-repository/mock-cost-repository.js";
import { ModelRepositoryProvider, useModelInvalidate } from "./model-repository/model-repository-provider.js";
import { MockModelRepository } from "./model-repository/mock-model-repository.js";
import { MockRepository } from "./mock-repository/mock-repository.js";
import { PRODUCTION_DEFAULT_SCENARIO } from "../fixtures/index.js";

afterEach(cleanup);

function DrawingProbe({ fetcher }: { fetcher: () => Promise<string> }) {
  const query = useDrawingQuery("revision:detail:x", fetcher);
  return <span data-testid="drawing">{query.status === "success" ? query.data : query.status}</span>;
}

function ModelInvalidateButton() {
  const invalidate = useModelInvalidate();
  return <button type="button" onClick={() => invalidate()}>model-invalidate</button>;
}

describe("cross-provider cache invalidation", () => {
  it("refetches Drawing queries after the Model provider is invalidated (review approve/reject)", async () => {
    const fetcher = vi.fn(() => Promise.resolve("v" + String(fetcher.mock.calls.length)));
    render(
      <DrawingRepositoryProvider repository={MockBridgeDrawingRepository.create(PRODUCTION_DEFAULT_SCENARIO)}>
        <ModelRepositoryProvider repository={new MockModelRepository(MockRepository.create(PRODUCTION_DEFAULT_SCENARIO))}>
          <DrawingProbe fetcher={fetcher} />
          <ModelInvalidateButton />
        </ModelRepositoryProvider>
      </DrawingRepositoryProvider>
    );
    await waitFor(() => expect(screen.getByTestId("drawing").textContent).toBe("v1"));
    fireEvent.click(screen.getByRole("button", { name: "model-invalidate" }));
    await waitFor(() => expect(screen.getByTestId("drawing").textContent).toBe("v2"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

function CostProbe({ keyName, fetcher }: { keyName: string; fetcher: () => Promise<string> }) {
  const query = useCostQuery(keyName, fetcher);
  const invalidate = useCostInvalidate();
  return (
    <div>
      <span data-testid={`cost-${keyName}`}>{query.loading ? "loading" : String(query.data)}</span>
      <button type="button" onClick={() => invalidate()}>cost-invalidate</button>
    </div>
  );
}

describe("useCostQuery key switching", () => {
  it("does not leave the first key stuck in loading when the key changes mid-flight", async () => {
    let resolveA!: (value: string) => void;
    const fetchA = () => new Promise<string>((resolve) => { resolveA = resolve; });
    const fetchB = () => Promise.resolve("B");
    function Switcher() {
      const keyState = useKeyState();
      return <CostProbe keyName={keyState.key} fetcher={keyState.key === "a" ? fetchA : fetchB} />;
    }
    let setKeyOuter: (key: string) => void = () => undefined;
    function useKeyState() {
      const [key, setKey] = React.useState("a");
      setKeyOuter = setKey;
      return { key };
    }
    render(
      <CostRepositoryProvider repository={new MockCostRepository(MockRepository.create(PRODUCTION_DEFAULT_SCENARIO))}>
        <Switcher />
      </CostRepositoryProvider>
    );
    expect(screen.getByTestId("cost-a").textContent).toBe("loading");
    act(() => setKeyOuter("b"));
    await waitFor(() => expect(screen.getByTestId("cost-b").textContent).toBe("B"));
    resolveA("A");
    act(() => setKeyOuter("a"));
    await waitFor(() => expect(screen.getByTestId("cost-a").textContent).toBe("A"));
  });
});
