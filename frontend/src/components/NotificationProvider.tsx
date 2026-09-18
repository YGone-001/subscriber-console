"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { playNotificationSound, NotificationSoundType } from "@/lib/soundEffects";

export type NotificationCategory = "alert" | "approval" | "system" | "task";
export type NotificationType = "critical" | "warning" | "success" | "info";
export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  link?: string;
  meta?: Record<string, unknown>;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  type: NotificationType;
  title?: string;
  message: string;
  duration?: number; // ms, default 5000ms
  action?: ToastAction;
  createdAt: number;
}

interface NotificationContextValue {
  notifications: NotificationItem[];
  toasts: ToastItem[];
  unreadCount: number;
  connectionStatus: ConnectionStatus;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  soundVolume: number;
  setSoundVolume: (volume: number) => void;
  desktopPermission: NotificationPermission | "unsupported";
  requestDesktopPermission: () => Promise<void>;
  showToast: (toast: Omit<ToastItem, "id" | "createdAt"> & { sound?: boolean }) => string;
  removeToast: (id: string) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearAllNotifications: () => void;
  addNotification: (item: Omit<NotificationItem, "id" | "timestamp" | "read"> & { sound?: boolean; toast?: boolean }) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const STORAGE_KEYS = {
  NOTIFICATIONS: "xcloud_notifications_v1",
  SOUND_ENABLED: "xcloud_notify_sound_enabled",
  SOUND_VOLUME: "xcloud_notify_sound_vol",
};

const EMPTY_NOTIFICATIONS: NotificationItem[] = [];
let cachedRawNotifs: string | null = null;
let cachedNotifs: NotificationItem[] = EMPTY_NOTIFICATIONS;

function getStoredNotifsSnapshot(): NotificationItem[] {
  if (typeof window === "undefined") return EMPTY_NOTIFICATIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.NOTIFICATIONS);
    if (raw === cachedRawNotifs && cachedNotifs) return cachedNotifs;
    cachedRawNotifs = raw;
    if (raw) {
      cachedNotifs = JSON.parse(raw);
      return cachedNotifs;
    }
  } catch {}
  cachedNotifs = EMPTY_NOTIFICATIONS;
  return EMPTY_NOTIFICATIONS;
}

let cachedSoundEnabled = true;
function getSoundEnabledSnapshot(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SOUND_ENABLED);
    if (raw !== null) {
      cachedSoundEnabled = raw === "true";
      return cachedSoundEnabled;
    }
  } catch {}
  return true;
}

let cachedSoundVolume = 0.6;
function getSoundVolumeSnapshot(): number {
  if (typeof window === "undefined") return 0.6;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SOUND_VOLUME);
    if (raw !== null) {
      cachedSoundVolume = Number(raw);
      return cachedSoundVolume;
    }
  } catch {}
  return 0.6;
}

function getDesktopPermissionSnapshot(): NotificationPermission | "unsupported" {
  if (typeof window !== "undefined" && "Notification" in window) {
    return Notification.permission;
  }
  return "unsupported";
}

const notifyStoreListeners = new Set<() => void>();
function subscribeNotifyStore(onStoreChange: () => void) {
  notifyStoreListeners.add(onStoreChange);
  const handleStorage = (e: StorageEvent) => {
    if (
      e.key === STORAGE_KEYS.NOTIFICATIONS ||
      e.key === STORAGE_KEYS.SOUND_ENABLED ||
      e.key === STORAGE_KEYS.SOUND_VOLUME
    ) {
      onStoreChange();
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    notifyStoreListeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function emitNotifyStore() {
  for (const listener of notifyStoreListeners) {
    listener();
  }
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const notifications = useSyncExternalStore(
    subscribeNotifyStore,
    getStoredNotifsSnapshot,
    () => EMPTY_NOTIFICATIONS
  );
  const soundEnabled = useSyncExternalStore(
    subscribeNotifyStore,
    getSoundEnabledSnapshot,
    () => true
  );
  const soundVolume = useSyncExternalStore(
    subscribeNotifyStore,
    getSoundVolumeSnapshot,
    () => 0.6
  );
  const desktopPermission = useSyncExternalStore<NotificationPermission | "unsupported">(
    subscribeNotifyStore,
    getDesktopPermissionSnapshot,
    (): NotificationPermission | "unsupported" => "unsupported"
  );

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const visibleConnectionStatus: ConnectionStatus = pathname === "/login" ? "disconnected" : connectionStatus;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef<number>(0);

  // Sync notifications to localStorage (keep latest 60)
  const saveNotifications = useCallback((newNotifs: NotificationItem[]) => {
    const trimmed = newNotifs.slice(0, 60);
    cachedNotifs = trimmed;
    try {
      cachedRawNotifs = JSON.stringify(trimmed);
      localStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, cachedRawNotifs);
    } catch {}
    emitNotifyStore();
  }, []);

  const setSoundEnabled = useCallback((val: boolean) => {
    cachedSoundEnabled = val;
    try {
      localStorage.setItem(STORAGE_KEYS.SOUND_ENABLED, String(val));
    } catch {}
    emitNotifyStore();
  }, []);

  const setSoundVolume = useCallback((val: number) => {
    const clamped = Math.max(0, Math.min(1, val));
    cachedSoundVolume = clamped;
    try {
      localStorage.setItem(STORAGE_KEYS.SOUND_VOLUME, String(clamped));
    } catch {}
    emitNotifyStore();
  }, []);

  const requestDesktopPermission = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }
    try {
      await Notification.requestPermission();
      emitNotifyStore();
    } catch {}
  }, []);

  // Remove toast
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Show floating toast
  const showToast = useCallback(
    (opts: Omit<ToastItem, "id" | "createdAt"> & { sound?: boolean }) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newToast: ToastItem = {
        id,
        type: opts.type,
        title: opts.title,
        message: opts.message,
        duration: opts.duration ?? 5000,
        action: opts.action,
        createdAt: Date.now(),
      };

      setToasts((prev) => [newToast, ...prev].slice(0, 5));

      if (opts.sound !== false && soundEnabled) {
        playNotificationSound(opts.type as NotificationSoundType, soundVolume);
      }

      // Trigger desktop notification if allowed and tab not focused
      if (
        typeof document !== "undefined" &&
        document.hidden &&
        desktopPermission === "granted" &&
        typeof window !== "undefined" &&
        "Notification" in window
      ) {
        try {
          new Notification(opts.title || "xCloud Telecom Alert", {
            body: opts.message,
            icon: "/images/xCloud_picture.png",
          });
        } catch {}
      }

      return id;
    },
    [soundEnabled, soundVolume, desktopPermission]
  );

  // Add notification item
  const addNotification = useCallback(
    (item: Omit<NotificationItem, "id" | "timestamp" | "read"> & { sound?: boolean; toast?: boolean }) => {
      const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newNotif: NotificationItem = {
        id,
        category: item.category,
        type: item.type,
        title: item.title,
        message: item.message,
        timestamp: new Date().toISOString(),
        read: false,
        link: item.link,
        meta: item.meta,
      };

      const current = getStoredNotifsSnapshot();
      saveNotifications([newNotif, ...current]);

      if (item.toast !== false) {
        showToast({
          type: item.type,
          title: item.title,
          message: item.message,
          sound: item.sound,
        });
      } else if (item.sound !== false && soundEnabled) {
        playNotificationSound(item.type as NotificationSoundType, soundVolume);
      }
    },
    [saveNotifications, showToast, soundEnabled, soundVolume]
  );

  const markAsRead = useCallback(
    (id: string) => {
      const current = getStoredNotifsSnapshot();
      saveNotifications(current.map((n) => (n.id === id ? { ...n, read: true } : n)));
    },
    [saveNotifications]
  );

  const markAllAsRead = useCallback(() => {
    const current = getStoredNotifsSnapshot();
    saveNotifications(current.map((n) => ({ ...n, read: true })));
  }, [saveNotifications]);

  const clearAllNotifications = useCallback(() => {
    saveNotifications([]);
  }, [saveNotifications]);

  // Connect to SSE stream
  useEffect(() => {
    if (pathname === "/login") {
      eventSourceRef.current = null;
      return;
    }

    let unmounted = false;

    const connectSSE = () => {
      if (unmounted) return;
      setConnectionStatus("connecting");

      try {
        const sse = new EventSource("/api/notifications/stream");
        eventSourceRef.current = sse;

        sse.onopen = () => {
          if (unmounted) return;
          setConnectionStatus("connected");
          retryCountRef.current = 0;
        };

        sse.addEventListener("init", (e: MessageEvent) => {
          if (unmounted) return;
          try {
            const data = JSON.parse(e.data);
            if (data.alerts?.activeCriticalCount > 0) {
              // Highlight critical state
              showToast({
                type: "critical",
                title: "NOC Critical Faults Active",
                message: `${data.alerts.activeCriticalCount} critical alarm(s) require attention.`,
                sound: true,
              });
            }
          } catch {}
        });

        sse.addEventListener("alerts_update", (e: MessageEvent) => {
          if (unmounted) return;
          try {
            const data = JSON.parse(e.data);
            const isCritical = data.activeCriticalCount > 0;
            const level: NotificationType = isCritical ? "critical" : data.activeWarningCount > 0 ? "warning" : "info";

            addNotification({
              category: "alert",
              type: level,
              title: isCritical ? "Critical Telecom Fault" : "Alert Status Changed",
              message: `Active alarms: ${data.activeCount} (Critical: ${data.activeCriticalCount}, Warning: ${data.activeWarningCount})`,
              link: "/system-health",
              sound: true,
              toast: true,
            });
          } catch {}
        });

        sse.addEventListener("approvals_update", (e: MessageEvent) => {
          if (unmounted) return;
          try {
            const data = JSON.parse(e.data);
            addNotification({
              category: "approval",
              type: "warning",
              title: "Pending Approvals Updated",
              message: `${data.pendingCount} request(s) awaiting review.`,
              link: "/approvals",
              sound: true,
              toast: true,
            });
          } catch {}
        });

        sse.onerror = () => {
          if (unmounted) return;
          sse.close();
          setConnectionStatus("error");

          // Exponential backoff reconnect: 2s, 4s, 8s, max 30s
          const backoff = Math.min(30000, 2000 * Math.pow(1.8, retryCountRef.current));
          retryCountRef.current += 1;

          reconnectTimeoutRef.current = setTimeout(() => {
            if (!unmounted) connectSSE();
          }, backoff);
        };
      } catch {
        setConnectionStatus("disconnected");
      }
    };

    connectSSE();

    return () => {
      unmounted = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [pathname, addNotification, showToast]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  const value = useMemo(
    () => ({
      notifications,
      toasts,
      unreadCount,
      connectionStatus: visibleConnectionStatus,
      soundEnabled,
      setSoundEnabled,
      soundVolume,
      setSoundVolume,
      desktopPermission,
      requestDesktopPermission,
      showToast,
      removeToast,
      markAsRead,
      markAllAsRead,
      clearAllNotifications,
      addNotification,
    }),
    [
      notifications,
      toasts,
      unreadCount,
      visibleConnectionStatus,
      soundEnabled,
      setSoundEnabled,
      soundVolume,
      setSoundVolume,
      desktopPermission,
      requestDesktopPermission,
      showToast,
      removeToast,
      markAsRead,
      markAllAsRead,
      clearAllNotifications,
      addNotification,
    ]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotification(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotification must be used within a NotificationProvider");
  }
  return ctx;
}
