import { cleanup, fireEvent, render as renderDom, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TOAST_DURATION_MS,
  ToastContainer,
  ToastMessage,
  type ToastData
} from "./Toast.js";

afterEach(cleanup);

function makeToast(overrides: Partial<ToastData> = {}): ToastData {
  return { id: "toast-1", title: "已保存", tone: "success", ...overrides };
}

describe("ToastMessage", () => {
  it("renders the tone class, icon, title and message", () => {
    const onDismiss = vi.fn();
    renderDom(
      <ToastMessage toast={makeToast({ message: "新的 API Key 已生效。" })} onDismiss={onDismiss} />
    );
    const toast = screen.getByRole("status");
    expect(toast.classList.contains("toast")).toBe(true);
    expect(toast.classList.contains("toast-success")).toBe(true);
    expect(toast.getAttribute("data-tone")).toBe("success");
    expect(screen.getByText("已保存")).not.toBeNull();
    expect(screen.getByText("新的 API Key 已生效。")).not.toBeNull();
    expect(screen.getByRole("button", { name: "关闭通知" })).not.toBeNull();
  });

  it("closes when the close button is clicked", () => {
    const onDismiss = vi.fn();
    renderDom(<ToastMessage toast={makeToast()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    expect(onDismiss).toHaveBeenCalledWith("toast-1");
  });

  it("auto-dismisses after the default 4000ms", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      renderDom(<ToastMessage toast={makeToast()} onDismiss={onDismiss} />);
      vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS - 1);
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledWith("toast-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an explicit duration and auto-dismisses at that time", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      renderDom(<ToastMessage toast={makeToast({ durationMs: 1500 })} onDismiss={onDismiss} />);
      vi.advanceTimersByTime(1500);
      expect(onDismiss).toHaveBeenCalledWith("toast-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-dismiss when the duration is non-positive", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      renderDom(<ToastMessage toast={makeToast({ durationMs: 0 })} onDismiss={onDismiss} />);
      vi.advanceTimersByTime(60_000);
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ToastContainer", () => {
  it("renders nothing when there are no toasts", () => {
    const { container } = renderDom(<ToastContainer toasts={[]} onDismiss={() => undefined} />);
    expect(container.childElementCount).toBe(0);
  });

  it("renders every toast with a dismiss handler", () => {
    const onDismiss = vi.fn();
    renderDom(
      <ToastContainer
        toasts={[
          makeToast({ id: "t1", title: "第一条", tone: "info" }),
          makeToast({ id: "t2", title: "第二条", tone: "error" })
        ]}
        onDismiss={onDismiss}
      />
    );
    expect(screen.getByText("第一条")).not.toBeNull();
    expect(screen.getByText("第二条")).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "关闭通知" })[1] as HTMLElement);
    expect(onDismiss).toHaveBeenCalledWith("t2");
  });
});
