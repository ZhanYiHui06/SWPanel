import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFakeBridge } from "../../test/fake-bridge.js";
import {
  buildRecoveryNotification,
  NotificationProvider,
  useNotifications
} from "./notification-context.js";

afterEach(cleanup);

function Harness(): React.JSX.Element {
  const {
    unreadCount,
    toasts,
    notifications,
    addToast,
    addNotification,
    dismissToast,
    markAllAsRead,
    markAsRead,
    clearNotifications
  } = useNotifications();
  const firstId = notifications[0]?.id ?? "";
  return (
    <div>
      <span data-testid="unread">{unreadCount}</span>
      <span data-testid="toasts">{toasts.length}</span>
      <span data-testid="feed">{notifications.length}</span>
      <button onClick={() => addToast({ title: "toast", message: "tm", tone: "info" })}>addToast</button>
      <button onClick={() => addNotification({ title: "feed", message: "fm", tone: "warning" })}>
        addNotification
      </button>
      <button onClick={() => markAsRead(firstId)}>markOne</button>
      <button onClick={markAllAsRead}>markAll</button>
      <button onClick={clearNotifications}>clear</button>
      <button onClick={() => dismissToast(firstId)}>dismiss</button>
      <ul>
        {notifications.map((item) => (
          <li key={item.id} data-testid="feed-item">{item.title}</li>
        ))}
      </ul>
    </div>
  );
}

function renderProvider(recoverOnMount = false) {
  return render(
    <NotificationProvider recoverOnMount={recoverOnMount}>
      <Harness />
    </NotificationProvider>
  );
}

describe("NotificationProvider", () => {
  it("adds transient toasts only", () => {
    renderProvider();
    expect(screen.getByTestId("toasts").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "addToast" }));
    expect(screen.getByTestId("toasts").textContent).toBe("1");
    // A toast is not part of the persistent feed.
    expect(screen.getByTestId("feed").textContent).toBe("0");
    expect(screen.getByTestId("unread").textContent).toBe("0");
  });

  it("addNotification adds a toast AND an unread feed item", () => {
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "addNotification" }));
    expect(screen.getByTestId("toasts").textContent).toBe("1");
    expect(screen.getByTestId("feed").textContent).toBe("1");
    expect(screen.getByTestId("unread").textContent).toBe("1");
  });

  it("tracks unread counts and mark-as-read actions", () => {
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "addNotification" }));
    fireEvent.click(screen.getByRole("button", { name: "addNotification" }));
    expect(screen.getByTestId("unread").textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "markOne" }));
    expect(screen.getByTestId("unread").textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "markAll" }));
    expect(screen.getByTestId("unread").textContent).toBe("0");
  });

  it("clearNotifications empties the feed", () => {
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "addNotification" }));
    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(screen.getByTestId("feed").textContent).toBe("0");
  });

  it("emits a system recovery toast + feed item when the startup scan found failed/resumed runs", async () => {
    const bridge = createFakeBridge({
      recoveryStatus: {
        scanTime: "2026-08-13T00:00:00.000Z",
        totalActiveChecked: 2,
        resumedCount: 1,
        failedCount: 1,
        unsupportedCount: 1,
        skippedCount: 0
      }
    });
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });
    try {
      render(<NotificationProvider><Harness /></NotificationProvider>);
      expect(await screen.findByText("系统恢复扫描完成")).not.toBeNull();
      expect(screen.getByTestId("feed").textContent).toBe("1");
      expect(screen.getByTestId("unread").textContent).toBe("1");
      expect(bridge.calls.some((call) => call.startsWith("system.getRecoveryStatus"))).toBe(true);
    } finally {
      Reflect.deleteProperty(window, "swpanel");
    }
  });

  it("does not emit a recovery item when the scan is clean", async () => {
    const bridge = createFakeBridge({
      recoveryStatus: {
        scanTime: "2026-08-13T00:00:00.000Z",
        totalActiveChecked: 2,
        resumedCount: 0,
        failedCount: 0,
        unsupportedCount: 0,
        skippedCount: 2
      }
    });
    Object.defineProperty(window, "swpanel", { value: bridge.api, configurable: true, writable: true });
    try {
      render(<NotificationProvider><Harness /></NotificationProvider>);
      // Give the async mount effect a chance to resolve before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByTestId("feed").textContent).toBe("0");
    } finally {
      Reflect.deleteProperty(window, "swpanel");
    }
  });
});

describe("buildRecoveryNotification", () => {
  it("returns null when nothing failed or resumed", () => {
    expect(
      buildRecoveryNotification({
        scanTime: "2026-08-13T00:00:00.000Z",
        totalActiveChecked: 1,
        resumedCount: 0,
        failedCount: 0,
        unsupportedCount: 1,
        skippedCount: 0
      })
    ).toBeNull();
  });

  it("builds a warning notification when runs failed to recover", () => {
    const input = buildRecoveryNotification({
      scanTime: "2026-08-13T00:00:00.000Z",
      totalActiveChecked: 3,
      resumedCount: 1,
      failedCount: 2,
      unsupportedCount: 0,
      skippedCount: 0
    });
    expect(input).not.toBeNull();
    expect(input?.tone).toBe("warning");
    expect(input?.category).toBe("system");
    expect(input?.actionRoute).toBe("/runs");
    expect(input?.message).toContain("已恢复 1 个中断的建模任务");
    expect(input?.message).toContain("2 个任务未能自动恢复");
  });
});
