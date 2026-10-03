import { cleanup, render as renderDom, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog.js";

afterEach(cleanup);

function Sample({
  onClose = () => undefined,
  dismissible,
  closeOnOverlayClick
}: {
  onClose?: () => void;
  dismissible?: boolean;
  closeOnOverlayClick?: boolean;
}) {
  return (
    <Dialog
      labelledBy="sample-title"
      onClose={onClose}
      {...(dismissible === undefined ? {} : { dismissible })}
      {...(closeOnOverlayClick === undefined ? {} : { closeOnOverlayClick })}
    >
      <div className="dialog-header">
        <div id="sample-title" className="dialog-title">示例对话框</div>
      </div>
      <div className="dialog-body">
        <input aria-label="名称" />
      </div>
      <div className="dialog-footer">
        <button type="button">取消</button>
        <button type="button">确认</button>
      </div>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("keeps the existing dialog DOM contract", () => {
    renderDom(<Sample />);
    const dialog = screen.getByRole("dialog", { name: "示例对话框" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.classList.contains("dialog")).toBe(true);
    const overlay = dialog.parentElement as HTMLElement;
    expect(overlay.className).toBe("dialog-overlay");
    expect(overlay.getAttribute("role")).toBe("presentation");
  });

  it("focuses the first focusable element on open", () => {
    renderDom(<Sample />);
    expect(document.activeElement).toBe(screen.getByLabelText("名称"));
  });

  it("closes on Escape unless dismissible is false", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = renderDom(<Sample onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Sample onClose={onClose} dismissible={false} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab inside the dialog in both directions", async () => {
    const user = userEvent.setup();
    renderDom(<Sample />);
    const input = screen.getByLabelText("名称");
    const confirm = screen.getByRole("button", { name: "确认" });

    confirm.focus();
    await user.tab();
    expect(document.activeElement).toBe(input);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("only closes on backdrop click when closeOnOverlayClick is set", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = renderDom(<Sample onClose={onClose} />);
    const overlay = screen.getByRole("dialog").parentElement as HTMLElement;

    await user.click(overlay);
    expect(onClose).not.toHaveBeenCalled();

    rerender(<Sample onClose={onClose} closeOnOverlayClick />);
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger when it closes", async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>打开</button>
          {open && <Sample onClose={() => setOpen(false)} />}
        </>
      );
    }
    renderDom(<Host />);
    const trigger = screen.getByRole("button", { name: "打开" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("lets only the topmost of stacked dialogs handle Escape", async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const inner = vi.fn();
    renderDom(
      <>
        <Sample onClose={outer} />
        <Dialog labelledBy="inner-title" onClose={inner}>
          <div id="inner-title">内层</div>
          <button type="button">好</button>
        </Dialog>
      </>
    );
    await user.keyboard("{Escape}");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
