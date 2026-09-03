/**
 * Notification context (Step 4).
 *
 * Owns two closely related surfaces:
 *
 * - a transient TOAST stack rendered by `@swpanel/ui`'s `ToastContainer`
 *   (bottom-right, auto-dismiss after `durationMs`, default 4000ms);
 * - a persistent NOTIFICATION FEED (saved in renderer state/session) shown in
 *   the top-right NotificationDrawer, with unread counts, mark-as-read / clear
 *   all and optional action deep-links.
 *
 * On app launch the provider queries `window.swpanel?.system?.getRecoveryStatus?.()`
 * (optional-chained so browser dev/tests without the bridge no-op). When the
 * startup recovery scan reports any failed or resumed Modeling Runs, it emits a
 * system recovery toast AND records it in the feed.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import type { ToastData, ToastTone } from "@swpanel/ui";
import type {
  NotificationCategory,
  NotificationItem,
  NotificationTone,
  RecoveryStatusSummary
} from "@swpanel/domain";

/** Bounds the persisted feed so a busy session cannot grow it unboundedly. */
export const MAX_NOTIFICATIONS = 100;

/** One transient toast message (shape matches `@swpanel/ui` `ToastData`). */
export interface ToastInput {
  readonly title: string;
  readonly message?: string;
  readonly tone?: NotificationTone;
  readonly durationMs?: number;
}

/** A feed + toast notification (the toast auto-dismisses; the feed persists). */
export interface NotificationInput extends ToastInput {
  readonly actionRoute?: string;
  readonly category?: NotificationCategory;
  readonly timestamp?: string;
}

export interface NotificationContextValue {
  /** Active transient toasts (rendered by `ToastContainer`). */
  readonly toasts: readonly ToastData[];
  /** Persistent notification feed (newest first, bounded). */
  readonly notifications: readonly NotificationItem[];
  readonly unreadCount: number;
  /** Adds a transient toast only. Returns its id. */
  readonly addToast: (input: ToastInput) => string;
  /** Adds a toast AND a feed item (unread). Returns its id. */
  readonly addNotification: (input: NotificationInput) => string;
  readonly dismissToast: (id: string) => void;
  readonly markAsRead: (id: string) => void;
  readonly markAllAsRead: () => void;
  readonly clearNotifications: () => void;
  /** NotificationDrawer visibility (topbar bell). */
  readonly drawerOpen: boolean;
  readonly openDrawer: () => void;
  readonly closeDrawer: () => void;
  readonly toggleDrawer: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

function asToastTone(tone: NotificationTone): ToastTone {
  return tone;
}

/**
 * Builds the system recovery notification from the startup scan summary
 * (pure + exported for tests). Returns null when nothing should surface.
 */
export function buildRecoveryNotification(
  status: RecoveryStatusSummary
): NotificationInput | null {
  if (status.failedCount <= 0 && status.resumedCount <= 0) return null;
  const details: string[] = [];
  if (status.resumedCount > 0) details.push(`已恢复 ${status.resumedCount} 个中断的建模任务`);
  if (status.failedCount > 0) details.push(`${status.failedCount} 个任务未能自动恢复（已标记失败）`);
  if (status.unsupportedCount > 0) details.push(`${status.unsupportedCount} 个任务无支持的重启恢复路径`);
  return {
    title: "系统恢复扫描完成",
    message: `${details.join("；")}。`,
    tone: status.failedCount > 0 ? "warning" : "info",
    category: "system",
    actionRoute: "/runs",
    timestamp: status.scanTime
  };
}

export interface NotificationProviderProps {
  readonly children: ReactNode;
  /** Disables the launch-time recovery scan (tests that render the drawer). */
  readonly recoverOnMount?: boolean;
}

export function NotificationProvider({
  children,
  recoverOnMount = true
}: NotificationProviderProps): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly ToastData[]>([]);
  const [notifications, setNotifications] = useState<readonly NotificationItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const idRef = useRef(0);
  const recoveryCheckedRef = useRef(false);

  const nextId = useCallback((): string => {
    idRef.current += 1;
    return `notification-${idRef.current}`;
  }, []);

  const addToast = useCallback(
    (input: ToastInput): string => {
      const id = nextId();
      setToasts((current) => [
        ...current,
        {
          id,
          title: input.title,
          ...(input.message === undefined ? {} : { message: input.message }),
          tone: asToastTone(input.tone ?? "neutral"),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
        }
      ]);
      return id;
    },
    [nextId]
  );

  const addNotification = useCallback(
    (input: NotificationInput): string => {
      const id = nextId();
      const item: NotificationItem = {
        id,
        title: input.title,
        message: input.message ?? "",
        tone: input.tone ?? "neutral",
        timestamp: input.timestamp ?? new Date().toISOString(),
        read: false,
        ...(input.actionRoute === undefined ? {} : { actionRoute: input.actionRoute }),
        ...(input.category === undefined ? {} : { category: input.category })
      };
      setNotifications((current) => [item, ...current].slice(0, MAX_NOTIFICATIONS));
      setToasts((current) => [
        ...current,
        {
          id,
          title: input.title,
          ...(input.message === undefined ? {} : { message: input.message }),
          tone: asToastTone(item.tone),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
        }
      ]);
      return id;
    },
    [nextId]
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const markAsRead = useCallback((id: string) => {
    setNotifications((current) =>
      current.map((item) => (item.id === id && !item.read ? { ...item, read: true } : item))
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((current) =>
      current.some((item) => !item.read) ? current.map((item) => ({ ...item, read: true })) : current
    );
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const toggleDrawer = useCallback(() => setDrawerOpen((open) => !open), []);

  // App-launch recovery scan (Step 4): query the bridge once; emit a system
  // recovery toast + feed item when the scan found failed/resumed Runs.
  useEffect(() => {
    if (!recoverOnMount || recoveryCheckedRef.current) return;
    recoveryCheckedRef.current = true;
    try {
      const recovery = window.swpanel?.system?.getRecoveryStatus;
      if (typeof recovery !== "function") return;
      recovery()
        .then((result) => {
          if (!result.ok || result.data === null) return;
          const input = buildRecoveryNotification(result.data);
          if (input !== null) addNotification(input);
        })
        .catch(() => undefined);
    } catch {
      // Never let a bridge failure crash the shell render.
    }
  }, [addNotification, recoverOnMount]);

  const unreadCount = useMemo(
    () => notifications.reduce((count, item) => (item.read ? count : count + 1), 0),
    [notifications]
  );

  const value = useMemo<NotificationContextValue>(
    () => ({
      toasts,
      notifications,
      unreadCount,
      addToast,
      addNotification,
      dismissToast,
      markAsRead,
      markAllAsRead,
      clearNotifications,
      drawerOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer
    }),
    [
      toasts,
      notifications,
      unreadCount,
      addToast,
      addNotification,
      dismissToast,
      markAsRead,
      markAllAsRead,
      clearNotifications,
      drawerOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer
    ]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

/** Returns the notification context (toasts, feed, drawer). */
export function useNotifications(): NotificationContextValue {
  const context = useContext(NotificationContext);
  if (context === null) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return context;
}

/**
 * Optional variant for pages that may render standalone (tests, previews)
 * without a NotificationProvider. Returns null so consumers can call
 * `optional?.addToast?.(...)` safely.
 */
export function useOptionalNotifications(): NotificationContextValue | null {
  return useContext(NotificationContext);
}
