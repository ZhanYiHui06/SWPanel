import { describe, expect, it } from "vitest";

import { repositoryModeLabel, resolveRepositoryMode, resolveRepositoryModeFrom } from "./repository-mode.js";

const base = { hasBridge: false, isDevelopment: false, search: "", buildMode: "production" };

describe("resolveRepositoryModeFrom", () => {
  it("prefers the Electron bridge over everything", () => {
    expect(resolveRepositoryModeFrom({ ...base, hasBridge: true, search: "?mode=http", buildMode: "web" })).toBe("bridge");
  });

  it("uses http for ?mode=http and for the web build mode", () => {
    expect(resolveRepositoryModeFrom({ ...base, search: "?mode=http" })).toBe("http");
    expect(resolveRepositoryModeFrom({ ...base, isDevelopment: true, search: "?mode=http" })).toBe("http");
    expect(resolveRepositoryModeFrom({ ...base, buildMode: "web" })).toBe("http");
  });

  it("uses mock only in development and unavailable in other production builds", () => {
    expect(resolveRepositoryModeFrom({ ...base, isDevelopment: true, buildMode: "development" })).toBe("mock");
    expect(resolveRepositoryModeFrom(base)).toBe("unavailable");
  });

  it("resolves from the current environment (vitest = development, no bridge)", () => {
    window.history.replaceState(null, "", "/");
    expect(resolveRepositoryMode()).toBe("mock");
  });
});

describe("repositoryModeLabel", () => {
  it("returns the Chinese top bar labels", () => {
    expect(repositoryModeLabel("bridge")).toBe("");
    expect(repositoryModeLabel("http")).toBe("已连接服务");
    expect(repositoryModeLabel("mock")).toBe("演示数据");
    expect(repositoryModeLabel("unavailable")).toBe("服务不可用");
  });
});
