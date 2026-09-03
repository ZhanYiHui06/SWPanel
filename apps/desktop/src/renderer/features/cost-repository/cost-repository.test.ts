import { describe, expect, it } from "vitest";

import { createFakeBridge } from "../../test/fake-bridge.js";
import { REPORT_IDS, REVISION_IDS } from "../../fixtures/index.js";
import { MockRepository } from "../mock-repository/mock-repository.js";
import { BridgeCostRepository } from "./bridge-cost-repository.js";
import { MockCostRepository } from "./mock-cost-repository.js";
import { UnavailableCostRepository } from "./unavailable-cost-repository.js";
import type { CostRepository } from "./cost-repository.js";

describe("CostRepository deleteCostReport", () => {
  it("mock adapter removes a report of its owning revision", async () => {
    const mock = MockRepository.create("cost-report-generated");
    const repository = new MockCostRepository(mock);

    await repository.deleteCostReport({
      costReportId: REPORT_IDS.q03,
      revisionId: REVISION_IDS.mainV3
    });

    expect(
      mock.listReports().some((report) => report.id === REPORT_IDS.q03)
    ).toBe(false);
    // Other reports survive.
    expect(mock.listReports().some((report) => report.id === REPORT_IDS.q02)).toBe(true);
  });

  it("mock adapter surfaces the structured failure for an unknown report", async () => {
    const mock = MockRepository.create("cost-report-generated");
    const repository = new MockCostRepository(mock);

    await expect(
      repository.deleteCostReport({ costReportId: "report-missing", revisionId: REVISION_IDS.mainV3 })
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: /unknown cost report/ });
  });

  it("bridge adapter maps to cost.deleteReport and unwraps structured errors", async () => {
    const fake = createFakeBridge();
    const repository = new BridgeCostRepository(fake.api);

    await expect(
      repository.deleteCostReport({ costReportId: "report-nope", revisionId: REVISION_IDS.mainV3 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      fake.calls.some((call) =>
        call.startsWith(
          `cost.deleteReport:${JSON.stringify({
            costReportId: "report-nope",
            revisionId: REVISION_IDS.mainV3
          })}`
        )
      )
    ).toBe(true);
  });

  it("unavailable adapter rejects with BRIDGE_UNAVAILABLE", async () => {
    const repository: CostRepository = new UnavailableCostRepository();
    await expect(
      repository.deleteCostReport({ costReportId: "x", revisionId: "r" })
    ).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
  });
});
