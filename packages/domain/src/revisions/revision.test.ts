import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "../errors.js";
import { nextRevisionSequence, revisionLabel } from "./revision.js";

describe("drawing revision", () => {
  it("formats the user-visible revision label from its sequence", () => {
    expect(revisionLabel(1)).toBe("V1");
    expect(revisionLabel(2)).toBe("V2");
    expect(revisionLabel(3)).toBe("V3");
  });

  it("rejects invalid revision sequences", () => {
    expect(() => revisionLabel(0)).toThrow(DomainInvariantError);
    expect(() => revisionLabel(1.5)).toThrow(DomainInvariantError);
  });

  it("derives the next revision sequence from existing revisions", () => {
    expect(nextRevisionSequence([])).toBe(1);
    expect(nextRevisionSequence([{ sequence: 1 }, { sequence: 2 }])).toBe(3);
    expect(nextRevisionSequence([{ sequence: 2 }, { sequence: 1 }])).toBe(3);
  });
});
