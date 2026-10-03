import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeletionImpact } from "@swpanel/contracts";
import { BusinessDeletionDialog } from "./BusinessDeletionDialog.js";

const impact: DeletionImpact = { kind: "model", id: "model-1", confirmationToken: "a".repeat(64), canDelete: true, blockingReason: null, counts: { revisions: 0, runs: 0, models: 1, reviews: 1, costReports: 2, artifacts: 5, sourceFiles: 0 }, clearsCurrentApproved: true };
afterEach(cleanup);
describe("explicit business deletion", () => {
  it("shows cascade and pointer effects and submits the reviewed token only after confirmation", async () => {
    const user = userEvent.setup();
    const repository = { getDeletionImpact: vi.fn().mockResolvedValue(impact), deleteObject: vi.fn().mockResolvedValue({ deletedId: "model-1", cleanupWarnings: [] }) };
    const onDeleted = vi.fn();
    render(<BusinessDeletionDialog repository={repository} id="model-1" label="模型 M01" onCancel={vi.fn()} onDeleted={onDeleted} />);
    await screen.findByText(/2 份成本报告/);
    expect(screen.getByText(/当前正式模型指针会清空/)).toBeInTheDocument();
    expect(repository.deleteObject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认永久删除" }));
    expect(repository.deleteObject).toHaveBeenCalledWith("model-1", impact.confirmationToken);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith([]));
  });
  it("blocks unfinished tasks and requires a new impact after an expired confirmation", async () => {
    const user = userEvent.setup();
    const repository = { getDeletionImpact: vi.fn().mockResolvedValueOnce({ ...impact, canDelete: false, blockingReason: "存在运行中的任务" }).mockResolvedValue(impact), deleteObject: vi.fn().mockRejectedValue(Object.assign(new Error("changed"), { code: "ENTITY_CONFLICT" })) };
    const onDeleted = vi.fn();
    render(<BusinessDeletionDialog repository={repository} id="model-1" label="模型 M01" onCancel={vi.fn()} onDeleted={onDeleted} />);
    await screen.findByText("存在运行中的任务");
    expect(screen.getByRole("button", { name: "确认永久删除" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重新核对" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认永久删除" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "确认永久删除" }));
    await screen.findByText(/关联数据已变化/);
    expect(screen.getByRole("button", { name: "确认永久删除" })).toBeDisabled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(repository.deleteObject).toHaveBeenCalledTimes(1);
  });
  it("is a labelled modal dialog, closes on Escape and uses the danger button", async () => {
    const user = userEvent.setup();
    const repository = { getDeletionImpact: vi.fn().mockResolvedValue(impact), deleteObject: vi.fn() };
    const onCancel = vi.fn();
    render(<BusinessDeletionDialog repository={repository} id="model-1" label="模型 M01" onCancel={onCancel} onDeleted={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "删除 模型 M01" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await screen.findByText(/2 份成本报告/);
    expect(screen.getByRole("button", { name: "确认永久删除" })).toHaveClass("btn-danger");
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(repository.deleteObject).not.toHaveBeenCalled();
  });
  it("ignores Escape while the deletion is in flight", async () => {
    const user = userEvent.setup();
    let finish!: (value: { deletedId: string; cleanupWarnings: string[] }) => void;
    const repository = {
      getDeletionImpact: vi.fn().mockResolvedValue(impact),
      deleteObject: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }))
    };
    const onCancel = vi.fn();
    render(<BusinessDeletionDialog repository={repository} id="model-1" label="模型 M01" onCancel={onCancel} onDeleted={vi.fn()} />);
    await screen.findByText(/2 份成本报告/);
    await user.click(screen.getByRole("button", { name: "确认永久删除" }));
    await screen.findByRole("button", { name: "正在删除…" });
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    finish({ deletedId: "model-1", cleanupWarnings: [] });
  });
});
