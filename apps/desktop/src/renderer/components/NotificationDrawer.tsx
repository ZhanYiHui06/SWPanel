import { EmptyState } from "@swpanel/ui";
import type { NotificationItem } from "@swpanel/domain";
import { useNavigate } from "react-router-dom";

import { useNotifications } from "../features/notifications/notification-context.js";

/**
 * NotificationDrawer — top-right popout panel listing the persistent
 * notification feed. Rendered (or not) by the AppShell; clicking a notification
 * marks it read, closes the drawer and navigates to its action route when one is
 * present. Offers 全部已读 / 清空 controls and an empty state.
 */
export function NotificationDrawer(): React.JSX.Element | null {
  const {
    drawerOpen,
    closeDrawer,
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    clearNotifications
  } = useNotifications();
  const navigate = useNavigate();

  if (!drawerOpen) return null;

  function handleActivate(item: NotificationItem): void {
    if (!item.read) markAsRead(item.id);
    closeDrawer();
    if (item.actionRoute !== undefined && item.actionRoute !== "") {
      void navigate(item.actionRoute);
    }
  }

  return (
    <div className="notification-overlay" onClick={closeDrawer}>
      <aside
        className="notification-drawer"
        role="dialog"
        aria-label="通知中心"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="notification-drawer-header">
          <span className="notification-drawer-title">通知</span>
          <div className="notification-drawer-actions">
            {notifications.length > 0 && (
              <button type="button" className="notification-drawer-action" onClick={markAllAsRead}>
                全部已读
              </button>
            )}
            {notifications.length > 0 && (
              <button type="button" className="notification-drawer-action" onClick={clearNotifications}>
                清空
              </button>
            )}
          </div>
        </header>

        {notifications.length === 0 ? (
          <div className="notification-drawer-empty">
            <EmptyState title="暂无通知" description="新的系统消息和建模任务动态会显示在这里。" />
          </div>
        ) : (
          <>
            <ul className="notification-list">
              {notifications.map((item) => (
                <li
                  key={item.id}
                  className={`notification-item${item.read ? "" : " unread"}`}
                  data-tone={item.tone}
                >
                  <button
                    type="button"
                    className="notification-item-main"
                    onClick={() => handleActivate(item)}
                  >
                    <span className="notification-item-dot" aria-hidden="true" />
                    <span className="notification-item-body">
                      <span className="notification-item-title">{item.title}</span>
                      {item.message !== "" && (
                        <span className="notification-item-message">{item.message}</span>
                      )}
                    </span>
                    {!item.read && <span className="notification-item-unread-badge" aria-label="未读" />}
                  </button>
                </li>
              ))}
            </ul>
            <footer className="notification-drawer-footer">
              {unreadCount > 0 ? `共 ${unreadCount} 条未读通知` : "已全部阅读"}
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
