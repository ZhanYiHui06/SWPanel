import { useEffect } from "react";

/** Minimum gap between two focus/visibility revalidations. */
export const REVALIDATE_MIN_INTERVAL_MS = 15_000;

/**
 * Calls `revalidate` when the tab becomes visible again or the window regains
 * focus, throttled to one call per `REVALIDATE_MIN_INTERVAL_MS`. Pass
 * `enabled = false` for modes whose data cannot change behind the UI's back
 * (mock fixtures), which also keeps tests free of extra requests.
 */
export function useRevalidateOnFocus(revalidate: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") return;
    let last = Date.now();
    const trigger = (): void => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < REVALIDATE_MIN_INTERVAL_MS) return;
      last = now;
      revalidate();
    };
    document.addEventListener("visibilitychange", trigger);
    window.addEventListener("focus", trigger);
    return () => {
      document.removeEventListener("visibilitychange", trigger);
      window.removeEventListener("focus", trigger);
    };
  }, [revalidate, enabled]);
}
