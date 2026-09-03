import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "./errors.js";
import {
  clarificationQuestionLabel,
  costReportLabel,
  formatSequenceLabel,
  modelLabel,
  runLabel
} from "./labeling.js";

describe("sequence labeling", () => {
  it("formats padded two-digit sequence labels", () => {
    expect(formatSequenceLabel("R", 5)).toBe("R05");
    expect(formatSequenceLabel("M", 3)).toBe("M03");
    expect(formatSequenceLabel("Q", 12)).toBe("Q12");
  });

  it("produces fixture-consistent business labels", () => {
    expect(runLabel(5)).toBe("R05");
    expect(runLabel(1)).toBe("R01");
    expect(modelLabel(2)).toBe("M02");
    expect(costReportLabel(3)).toBe("Q03");
    expect(clarificationQuestionLabel(1)).toBe("C01");
  });

  it("rejects non-positive sequences", () => {
    expect(() => runLabel(0)).toThrow(DomainInvariantError);
  });
});
