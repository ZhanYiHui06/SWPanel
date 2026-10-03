import { describe, expect, it, vi } from "vitest";

import { broadcastRepositoryInvalidation, subscribeRepositoryInvalidation } from "./repository-invalidation.js";

describe("cross-provider invalidation bus", () => {
  it("notifies dependents but never the origin", () => {
    const drawing = vi.fn();
    const model = vi.fn();
    const run = vi.fn();
    const cost = vi.fn();
    const off = [
      subscribeRepositoryInvalidation("drawing", drawing),
      subscribeRepositoryInvalidation("model", model),
      subscribeRepositoryInvalidation("run", run),
      subscribeRepositoryInvalidation("cost", cost)
    ];
    broadcastRepositoryInvalidation("model"); // review approve/reject
    expect(drawing).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(model).not.toHaveBeenCalled();
    broadcastRepositoryInvalidation("cost"); // report created / deleted
    expect(drawing).toHaveBeenCalledTimes(2);
    expect(cost).not.toHaveBeenCalled();
    broadcastRepositoryInvalidation("run"); // run created / terminal
    expect(drawing).toHaveBeenCalledTimes(3);
    expect(model).toHaveBeenCalledTimes(1);
    off.forEach((fn) => fn());
    broadcastRepositoryInvalidation("model");
    expect(drawing).toHaveBeenCalledTimes(3);
  });
});
