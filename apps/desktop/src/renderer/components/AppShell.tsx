import type { ComponentType } from "react";
import {
  BellIcon,
  CostIcon,
  FileIcon,
  GridIcon,
  HomeIcon,
  IconButton,
  SettingsIcon,
  ToastContainer,
  type IconProps
} from "@swpanel/ui";
import { NavLink, Outlet, matchPath, useLocation } from "react-router-dom";

import { PRODUCT_ROUTES } from "../app/routes.js";
import { useNotifications } from "../features/notifications/notification-context.js";
import { NotificationDrawer } from "./NotificationDrawer.js";

interface NavigationItem {
  readonly label: string;
  readonly to: string;
  readonly icon: ComponentType<IconProps>;
  readonly activePattern: string;
}

const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { label: "工作台", to: "/", icon: HomeIcon, activePattern: "/" },
  { label: "图纸库", to: "/drawings", icon: FileIcon, activePattern: "/drawings/*" },
  { label: "建模任务", to: "/runs", icon: GridIcon, activePattern: "/runs/*" },
  { label: "成本数据", to: "/cost-data", icon: CostIcon, activePattern: "/cost-data" }
];

function isNavigationItemActive(pathname: string, item: NavigationItem): boolean {
  if (item.to === "/") {
    return pathname === "/";
  }

  return matchPath({ path: item.activePattern, end: false }, pathname) !== null;
}

function AppSidebar(): React.JSX.Element {
  const { pathname } = useLocation();

  return (
    <aside className="app-sidebar" aria-label="主导航">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark" aria-hidden="true">SW</div>
        <div>
          <div className="sidebar-brand-name">SWPanel</div>
          <div className="sidebar-brand-sub">江海冶金</div>
        </div>
      </div>
      <nav className="sidebar-nav">
        <div className="sidebar-section-label">工作空间</div>
        {PRIMARY_NAVIGATION.map((item) => {
          const Icon = item.icon;
          const active = isNavigationItemActive(pathname, item);
          return (
            <NavLink
              className={`sidebar-item${active ? " active" : ""}`}
              key={item.to}
              to={item.to}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="sidebar-item-icon" aria-hidden="true" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <NavLink
          className={`sidebar-item${pathname === "/settings" ? " active" : ""}`}
          to="/settings"
          aria-current={pathname === "/settings" ? "page" : undefined}
        >
          <SettingsIcon className="sidebar-item-icon" aria-hidden="true" />
          <span>设置</span>
        </NavLink>
      </div>
    </aside>
  );
}

function AppTopbar(): React.JSX.Element {
  const { pathname } = useLocation();
  const { unreadCount, toggleDrawer } = useNotifications();
  const currentRoute = PRODUCT_ROUTES.find(
    (route) => matchPath({ path: route.path, end: true }, pathname) !== null
  );

  return (
    <header className="app-topbar">
      <div className="topbar-left">
        <div className="breadcrumb" aria-label="面包屑">
          <span className="breadcrumb-item">SWPanel</span>
          <span className="breadcrumb-sep" aria-hidden="true">/</span>
          <span className="breadcrumb-item current">{currentRoute?.title ?? "未找到页面"}</span>
        </div>
      </div>
      <div className="topbar-right">
        <span className="runtime-label">
          {window.swpanel === undefined ? "浏览器预览" : `Electron ${window.swpanel.metadata.versions.electron}`}
        </span>
        <IconButton
          label="通知"
          onClick={toggleDrawer}
          buttonProps={{ "aria-haspopup": "dialog" }}
        >
          <span className="icon-button-badge-wrap">
            <BellIcon aria-hidden="true" />
            {unreadCount > 0 && (
              <span className="icon-button-badge" aria-label={`${unreadCount} 条未读通知`}>
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </span>
        </IconButton>
      </div>
    </header>
  );
}

/** Mounts the shared toast stack rendered by the notification provider. */
function AppToastHost(): React.JSX.Element {
  const { toasts, dismissToast } = useNotifications();
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

export function AppShell(): React.JSX.Element {
  return (
    <div className="app-shell">
      <AppSidebar />
      <main className="app-main">
        <AppTopbar />
        <Outlet />
      </main>
      <NotificationDrawer />
      <AppToastHost />
    </div>
  );
}
