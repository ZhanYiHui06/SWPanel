/**
 * Single source of truth for which data source the renderer talks to.
 *
 * Rules (first match wins):
 * 1. `window.swpanel` exists (legacy Electron preload)  -> "bridge"
 * 2. URL carries `?mode=http`                           -> "http"
 * 3. `import.meta.env.MODE === "web"` (`vite build --mode web`) -> "http"
 * 4. any other development build                        -> "mock" (fixtures)
 * 5. any other production build                         -> "unavailable"
 *
 * The four repository providers (Drawing / Run / Model / Cost) all go through
 * this module so they can never disagree about the mode.
 */

export type RepositoryMode = "bridge" | "http" | "mock" | "unavailable";

export interface RepositoryModeInput {
  readonly hasBridge: boolean;
  readonly isDevelopment: boolean;
  /** `window.location.search`. */
  readonly search: string;
  /** `import.meta.env.MODE`; defaults to the current build mode. */
  readonly buildMode?: string;
}

/** Pure resolver (testable without touching globals). */
export function resolveRepositoryModeFrom(input: RepositoryModeInput): RepositoryMode {
  if (input.hasBridge) return "bridge";
  if (new URLSearchParams(input.search).get("mode") === "http") return "http";
  if ((input.buildMode ?? import.meta.env.MODE) === "web") return "http";
  if (input.isDevelopment) return "mock";
  return "unavailable";
}

/** Resolves the mode from the current window / build environment. */
export function resolveRepositoryMode(): RepositoryMode {
  return resolveRepositoryModeFrom({
    hasBridge: typeof window !== "undefined" && window.swpanel !== undefined,
    isDevelopment: import.meta.env.DEV,
    search: typeof window !== "undefined" ? window.location.search : ""
  });
}

/** Chinese label for the top bar; empty string means "show nothing". */
export function repositoryModeLabel(mode: RepositoryMode): string {
  switch (mode) {
    case "http":
      return "已连接服务";
    case "mock":
      return "演示数据";
    case "unavailable":
      return "服务不可用";
    case "bridge":
      return "";
  }
}
