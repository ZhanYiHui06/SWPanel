import { describe, expect, it } from "vitest";

import { MOCK_SCENARIOS } from "../fixtures/scenarios.js";
import {
  auditAllScenarios,
  collectViolations
} from "./validate-timeline.js";

/**
 * Reusable fixture audit command (handoff batch B).
 *
 * `npm run check:fixtures` runs this spec: it builds every canonical scenario
 * world from the fixture source of truth and prints a deterministic audit
 * report. The spec fails (exit code != 0) when any timeline causality rule is
 * violated, so the command doubles as a repeatable validator gate.
 */
function runAudit(): { violations: ReturnType<typeof collectViolations> } {
  const audits = auditAllScenarios(MOCK_SCENARIOS);
  const violations = collectViolations(audits);

  const lines: string[] = [];
  lines.push("fixture timeline causality audit");
  lines.push("=================================");
  for (const audit of audits) {
    const count = audit.violations.length;
    lines.push(`  ${audit.scenario.padEnd(24)} ${count === 0 ? "OK" : `${count} violation(s)`}`);
    for (const violation of audit.violations) {
      lines.push(`      [${violation.rule}] ${violation.message}`);
    }
  }
  lines.push(`total violations: ${violations.length}`);
  lines.push(
    violations.length === 0 ? "RESULT: PASS" : "RESULT: FAIL"
  );
  console.log(lines.join("\n"));

  return { violations };
}

describe("fixture timeline audit report", () => {
  it("audits every canonical scenario and fails on any violation", () => {
    const { violations } = runAudit();
    expect(violations).toEqual([]);
  });
});
