import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastContainer } from "@swpanel/ui";

import { DRAWING_IDS, REVISION_IDS, RUN_IDS, REPORT_IDS } from "../../fixtures/index.js";
import { MockRepository } from "../mock-repository/mock-repository.js";
import { MockBridgeDrawingRepository } from "../bridge-repository/mock-bridge-repository.js";
import { MockRunRepository } from "../run-repository/mock-run-repository.js";
import { MockCostRepository } from "../cost-repository/mock-cost-repository.js";
import { NotificationProvider, useNotifications } from "../notifications/notification-context.js";
import {
  DeleteCostReportDialog,
  DeleteRevisionDialog,
  DeleteRunDialog,
  revisionDependencyMessage
} from "./DrawingDialogs.js";

afterEach(cleanup);

/** Mounts the toast stack so dialog success toasts are visible in tests. */
function ToastHost(): React.JSX.Element {
  const { toasts, dismissToast } = useNotifications();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

function dialogShell(children: React.ReactNode) {
  return render(<NotificationProvider recoverOnMount={false}>{children}<ToastHost /></NotificationProvider>);
}

describe("revisionDependencyMessage", () => {
  it("returns null with no dependencies", () => {
    expect(revisionDependencyMessage(0, 0, 0)).toBeNull();
  });

  it("builds the blocking message with models, runs and reports", () => {
    const message = revisionDependencyMessage(2, 1, 3);
    expect(message).toContain("2 个模型");
    expect(message).toContain("1 次建模记录");
    expect(message).toContain("3 份成本报告");
    expect(message).toContain("与");
    expect(message).toContain("不可直接删除");
  });

  it("matches the requested example wording for models and runs", () => {
    expect(revisionDependencyMessage(2, 1, 0)).toBe("该版本已包含 2 个模型与 1 次建模记录，不可直接删除。");
  });
});

describe("DeleteRevisionDialog dependency blocking", () => {
  const repository = () => {
    const mock = MockRepository.create("run-running");
    return new MockBridgeDrawingRepository(mock);
  };

  it("blocks deletion when the revision has Runs/Models and disables the confirm button", () => {
    render(
      <DeleteRevisionDialog
        repository={repository()}
        drawingId={DRAWING_IDS.main}
        revisionId={REVISION_IDS.mainV2}
        revisionLabel="V2"
        runCount={1}
        modelCount={2}
        costReportCount={0}
        onCancel={() => undefined}
        onDeleted={() => undefined}
      />
    );
    const dialog = screen.getByRole("dialog", { name: "删除版本" });
    expect(screen.getByText(/不可直接删除/)).toBeInTheDocument();
    expect(screen.getByText(/个模型与/)).toBeInTheDocument();
    expect(screen.getByText(/次建模记录/)).toBeInTheDocument();
    expect(withinButton(dialog, "确认删除版本")).toBeDisabled();
  });

  it("allows deletion when the revision has no dependencies", () => {
    render(
      <DeleteRevisionDialog
        repository={repository()}
        drawingId={DRAWING_IDS.main}
        revisionId={REVISION_IDS.mainV2}
        revisionLabel="V2"
        onCancel={() => undefined}
        onDeleted={() => undefined}
      />
    );
    expect(screen.queryByText(/不可直接删除/)).toBeNull();
    expect(screen.getByRole("button", { name: "确认删除版本" })).toBeEnabled();
  });
});

describe("DeleteRunDialog", () => {
  it("deletes a terminal Run and shows a success toast", async () => {
    const mock = MockRepository.create("run-cancelled");
    const repository = new MockRunRepository(mock);
    const onDeleted = vi.fn();

    dialogShell(
      <DeleteRunDialog
        repository={repository}
        run={{
          runId: RUN_IDS.mainR05,
          runLabel: "R05",
          drawingId: DRAWING_IDS.main,
          revisionId: REVISION_IDS.mainV3,
          status: "CANCELLED"
        }}
        onCancel={() => undefined}
        onDeleted={onDeleted}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认删除记录" }));

    expect(await screen.findByText("Run 已删除")).toBeInTheDocument();
    expect(mock.getRun(RUN_IDS.mainR05)).toBeUndefined();
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("surfaces a structured failure when deletion is refused", async () => {
    const mock = MockRepository.create("run-running");
    const repository = new MockRunRepository(mock);
    const onDeleted = vi.fn();

    dialogShell(
      <DeleteRunDialog
        repository={repository}
        run={{
          runId: RUN_IDS.mainR05,
          runLabel: "R05",
          drawingId: DRAWING_IDS.main,
          revisionId: REVISION_IDS.mainV3,
          status: "RUNNING"
        }}
        onCancel={() => undefined}
        onDeleted={onDeleted}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认删除记录" }));
    expect(await screen.findByText(/only terminal runs can be deleted/)).toBeInTheDocument();
    expect(mock.getRun(RUN_IDS.mainR05)).toBeDefined();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("DeleteCostReportDialog", () => {
  it("deletes a cost report and shows a success toast", async () => {
    const mock = MockRepository.create("cost-report-generated");
    const repository = new MockCostRepository(mock);
    const onDeleted = vi.fn();

    dialogShell(
      <DeleteCostReportDialog
        repository={repository}
        costReportId={REPORT_IDS.q03}
        revisionId={REVISION_IDS.mainV3}
        reportLabel="Q03"
        onCancel={() => undefined}
        onDeleted={onDeleted}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认删除报告" }));

    expect(await screen.findByText("报告已删除")).toBeInTheDocument();
    expect(
      mock.listReports().some((report) => report.id === REPORT_IDS.q03)
    ).toBe(false);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("reports the failure when the report does not exist", async () => {
    const mock = MockRepository.create("cost-report-generated");
    const repository = new MockCostRepository(mock);
    const onDeleted = vi.fn();

    dialogShell(
      <DeleteCostReportDialog
        repository={repository}
        costReportId="report-missing"
        revisionId={REVISION_IDS.mainV3}
        onCancel={() => undefined}
        onDeleted={onDeleted}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "确认删除报告" }));
    expect(await screen.findByText(/unknown cost report/)).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

/** Returns the button with `name` inside a dialog element. */
function withinButton(dialog: HTMLElement, name: string): HTMLButtonElement {
  const buttons = dialog.querySelectorAll("button");
  for (const button of buttons) {
    if (button.textContent?.includes(name)) return button;
  }
  throw new Error(`button ${name} not found`);
}
