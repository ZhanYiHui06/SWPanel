import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./format.js";

describe("formatRelativeTime", () => {
  const now = new Date(2026, 7, 10, 12, 0);
  it("keeps today / yesterday / same-year wording", () => {
    expect(formatRelativeTime(new Date(2026, 7, 10, 8, 5).toISOString(), now)).toBe("今天 08:05");
    expect(formatRelativeTime(new Date(2026, 7, 9, 19, 6).toISOString(), now)).toBe("昨天 19:06");
    expect(formatRelativeTime(new Date(2026, 2, 1, 9, 0).toISOString(), now)).toBe("3月1日 09:00");
  });
  it("adds the year for other years", () => {
    expect(formatRelativeTime(new Date(2025, 11, 31, 23, 59).toISOString(), now)).toBe("2025年12月31日 23:59");
  });
});
