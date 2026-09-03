import { describe, expect, it } from "vitest";

import { DomainInvariantError } from "../errors.js";
import {
  MODEL_REVIEW_STATUSES,
  MODEL_REVIEW_STATUS_LABELS,
  transitionModelStatus
} from "./model.js";

describe("model review status", () => {
  it("defines the three canonical review statuses", () => {
    expect(MODEL_REVIEW_STATUSES).toEqual(["PENDING_REVIEW", "APPROVED", "REJECTED"]);
  });

  it("maps statuses to the canonical user-facing labels", () => {
    expect(MODEL_REVIEW_STATUS_LABELS).toEqual({
      PENDING_REVIEW: "等待审核",
      APPROVED: "审核通过",
      REJECTED: "已退回"
    });
  });

  it("only allows PENDING_REVIEW to move to APPROVED or REJECTED", () => {
    expect(transitionModelStatus("PENDING_REVIEW", "APPROVED")).toBe("APPROVED");
    expect(transitionModelStatus("PENDING_REVIEW", "REJECTED")).toBe("REJECTED");
  });

  it("never allows a rejected model to be resurrected", () => {
    expect(() => transitionModelStatus("REJECTED", "APPROVED")).toThrow(DomainInvariantError);
    expect(() => transitionModelStatus("APPROVED", "REJECTED")).toThrow(DomainInvariantError);
    expect(() => transitionModelStatus("APPROVED", "PENDING_REVIEW")).toThrow(
      DomainInvariantError
    );
    expect(() => transitionModelStatus("REJECTED", "PENDING_REVIEW")).toThrow(
      DomainInvariantError
    );
  });
});
