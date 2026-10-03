import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { NotificationProvider, useNotifications } from "../features/notifications/notification-context.js";
import { NotificationDrawer } from "./NotificationDrawer.js";

afterEach(cleanup);

/** Opens the drawer and seeds two feed items through the public context API. */
function SeedAndOpen(): React.JSX.Element {
  const { openDrawer, addNotification } = useNotifications();
  useEffect(() => {
    addNotification({ title: "任务已完成", message: "Run R01 执行结束", tone: "success" });
    addNotification({ title: "需要补充信息", tone: "warning", actionRoute: "/runs/r1" });
    openDrawer();
  }, [addNotification, openDrawer]);
  return <span data-testid="seeded" />;
}

function renderDrawer(seed = true) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <NotificationProvider recoverOnMount={false}>
        {seed && <SeedAndOpen />}
        <NotificationDrawer />
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route path="/runs/r1" element={<div>run page</div>} />
        </Routes>
      </NotificationProvider>
    </MemoryRouter>
  );
}

describe("NotificationDrawer", () => {
  it("renders nothing while closed", () => {
    renderDrawer(false);
    expect(screen.queryByRole("dialog", { name: "通知中心" })).toBeNull();
  });

  it("lists seeded notifications with unread badges", async () => {
    renderDrawer();
    expect(await screen.findByRole("dialog", { name: "通知中心" })).toBeInTheDocument();
    expect(screen.getByText("任务已完成")).toBeInTheDocument();
    expect(screen.getByText("Run R01 执行结束")).toBeInTheDocument();
    expect(screen.getByText("需要补充信息")).toBeInTheDocument();
    // Two unread items -> two unread badges.
    expect(screen.getAllByLabelText("未读")).toHaveLength(2);
    expect(screen.getByText("共 2 条未读通知")).toBeInTheDocument();
  });

  it("is a modal dialog that closes on Escape and keeps focus inside", async () => {
    renderDrawer();
    const dialog = await screen.findByRole("dialog", { name: "通知中心" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "通知中心" })).toBeNull();
  });

  it("shows the empty state when there are no notifications", async () => {
    render(
      <MemoryRouter>
        <NotificationProvider recoverOnMount={false}>
          <DrawerOpener />
          <NotificationDrawer />
        </NotificationProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText("暂无通知")).toBeInTheDocument();
  });

  it("marks all as read and clears the list", async () => {
    renderDrawer();
    expect(await screen.findByText("共 2 条未读通知")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部已读" }));
    expect(screen.queryByLabelText("未读")).toBeNull();
    expect(screen.getByText("已全部阅读")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByText("暂无通知")).toBeInTheDocument();
  });

  it("navigates to the action route when a notification is activated", async () => {
    renderDrawer();
    expect(await screen.findByText("需要补充信息")).toBeInTheDocument();

    fireEvent.click(screen.getByText("需要补充信息"));
    expect(await screen.findByText("run page")).toBeInTheDocument();
    // Activation marked that item read and closed the drawer.
    expect(screen.queryByRole("dialog", { name: "通知中心" })).toBeNull();
  });
});

/** Small helper component that opens a drawer from within the provider. */
function DrawerOpener(): React.JSX.Element {
  const { openDrawer } = useNotifications();
  useEffect(() => {
    openDrawer();
  }, [openDrawer]);
  return <span data-testid="opener" />;
}
