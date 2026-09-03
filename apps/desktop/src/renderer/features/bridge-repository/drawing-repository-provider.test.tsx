import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockBridgeDrawingRepository } from "./mock-bridge-repository.js";
import {
  DrawingRepositoryProvider,
  resolveDrawingRepository,
  useDrawingInvalidate,
  useDrawingQuery
} from "./drawing-repository-provider.js";

afterEach(cleanup);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Probe that renders the query state for `key` plus retry/invalidate buttons. */
function Probe({
  queryKey,
  fetcher,
  enabled = true
}: {
  queryKey: string;
  fetcher: () => Promise<string>;
  enabled?: boolean;
}) {
  const query = useDrawingQuery(queryKey, fetcher, { enabled });
  const invalidate = useDrawingInvalidate();
  return (
    <div>
      <span data-testid="status">{query.status}</span>
      <span data-testid="data">{query.status === "success" ? query.data : ""}</span>
      <button type="button" onClick={() => query.retry()}>retry</button>
      <button type="button" onClick={() => invalidate()}>invalidate</button>
    </div>
  );
}

/** Harness that can switch the query key while the first fetch is in flight. */
function RaceHarness({ first, second }: { first: () => Promise<string>; second: () => Promise<string> }) {
  const [key, setKey] = useState("a");
  return (
    <div>
      <button type="button" onClick={() => setKey("b")}>switch</button>
      <Probe queryKey={key} fetcher={key === "a" ? first : second} />
    </div>
  );
}

function renderWithProvider(node: React.ReactNode) {
  return render(
    <DrawingRepositoryProvider repository={MockBridgeDrawingRepository.create("empty-drawing-library")}>
      {node}
    </DrawingRepositoryProvider>
  );
}

describe("useDrawingQuery state machine", () => {
  it("transitions loading -> success and caches the data", async () => {
    const gate = deferred<string>();
    renderWithProvider(<Probe queryKey="k" fetcher={() => gate.promise} />);
    expect(screen.getByTestId("status").textContent).toBe("loading");
    gate.resolve("hello");
    expect(await screen.findByTestId("status")).toHaveTextContent("success");
    expect(screen.getByTestId("data").textContent).toBe("hello");
  });

  it("transitions loading -> error and retry() recovers", async () => {
    let attempt = 0;
    const fetcher = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("runner unavailable"))
        : Promise.resolve("recovered");
    });
    renderWithProvider(<Probe queryKey="k" fetcher={fetcher} />);
    expect(await screen.findByTestId("status")).toHaveTextContent("error");
    fireEvent.click(screen.getByText("retry"));
    expect(await screen.findByTestId("status")).toHaveTextContent("success");
    expect(screen.getByTestId("data").textContent).toBe("recovered");
  });

  it("never lets a stale resolution overwrite a newer navigation", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    renderWithProvider(<RaceHarness first={() => first.promise} second={() => second.promise} />);
    expect(screen.getByTestId("status").textContent).toBe("loading");
    // Navigate to key "b" while "a" is still pending.
    fireEvent.click(screen.getByText("switch"));
    // Resolve the NEWER request first, then the stale one.
    second.resolve("new");
    first.resolve("old");
    expect(await screen.findByTestId("status")).toHaveTextContent("success");
    expect(screen.getByTestId("data").textContent).toBe("new");
  });

  it("refetches after invalidate() so mutations refresh mounted views", async () => {
    let attempt = 0;
    const fetcher = () => {
      attempt += 1;
      return Promise.resolve(`value-${attempt}`);
    };
    renderWithProvider(<Probe queryKey="k" fetcher={fetcher} />);
    expect(await screen.findByTestId("status")).toHaveTextContent("success");
    expect(screen.getByTestId("data").textContent).toBe("value-1");
    fireEvent.click(screen.getByText("invalidate"));
    expect(await screen.findByTestId("status")).toHaveTextContent("success");
    expect(screen.getByTestId("data").textContent).toBe("value-2");
  });

  it("stays idle and never fetches when disabled", () => {
    const fetcher = vi.fn(() => Promise.resolve("never"));
    render(<Probe queryKey="k" fetcher={fetcher} enabled={false} />);
    expect(screen.getByTestId("status").textContent).toBe("idle");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("resolveDrawingRepository runtime split", () => {
  it("prefers an explicit override", () => {
    const adapter = MockBridgeDrawingRepository.create("empty-drawing-library");
    const resolved = resolveDrawingRepository({
      override: adapter,
      hasBridge: false,
      isDevelopment: true,
      search: ""
    });
    expect(resolved).toBe(adapter);
  });

  it("uses the real bridge whenever window.swpanel exists (even in development)", () => {
    const resolved = resolveDrawingRepository({
      hasBridge: true,
      isDevelopment: true,
      search: "?scenario=empty-drawing-library"
    });
    expect(resolved.mode).toBe("bridge");
    expect(resolved.mock).toBeNull();
  });

  it("uses the explicit mock adapter in development without a bridge", () => {
    const resolved = resolveDrawingRepository({
      hasBridge: false,
      isDevelopment: true,
      search: "?scenario=empty-drawing-library"
    });
    expect(resolved.mode).toBe("mock");
    expect(resolved.mock).not.toBeNull();
    expect(resolved.mock?.listDrawings()).toHaveLength(0);
  });

  it("uses the unavailable adapter in production without a bridge (never fixtures)", () => {
    const resolved = resolveDrawingRepository({
      hasBridge: false,
      isDevelopment: false,
      search: ""
    });
    expect(resolved.mode).toBe("unavailable");
    expect(resolved.mock).toBeNull();
    return expect(resolved.listDrawings()).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE"
    });
  });
});
