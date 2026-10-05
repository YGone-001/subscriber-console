import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type NotificationCategory = 'alert' | 'system';
export type NotificationType = 'critical' | 'warning' | 'success' | 'info';
export type NotificationStreamStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export type NotificationItem = {
  id: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  message: string;
  timestamp: string;
  link?: string;
  read: boolean;
};

type AlertRecord = {
  id?: string;
  timestamp?: string;
  level?: string;
  imsi?: string;
  reason?: string;
  is_acknowledged?: boolean;
  workflow_status?: string;
};

type NotificationContextValue = {
  notifications: NotificationItem[];
  unreadCount: number;
  connectionStatus: NotificationStreamStatus;
  activeCount: number;
  criticalCount: number;
  warningCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearAllNotifications: () => void;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

const MAX_ITEMS = 40;

function levelToType(level: string | undefined): NotificationType {
  const normalized = (level ?? '').toLowerCase();
  if (normalized === 'critical' || normalized === 'error') return 'critical';
  if (normalized === 'warning' || normalized === 'warn') return 'warning';
  if (normalized === 'success' || normalized === 'info') return 'info';
  return 'info';
}

function alertToNotification(alert: AlertRecord, index: number): NotificationItem {
  const type = levelToType(alert.level);
  const imsi = alert.imsi ? String(alert.imsi) : '';
  return {
    id: `alert:${alert.id ?? `${alert.timestamp ?? 'unknown'}:${imsi}:${index}`}`,
    type,
    category: 'alert',
    title: alert.is_acknowledged ? 'Acknowledged alert' : `${(alert.level ?? 'alert').toUpperCase()} alert`,
    message: alert.reason ? String(alert.reason) : imsi ? `Subscriber ${imsi}` : 'Network alert',
    timestamp: alert.timestamp ? String(alert.timestamp) : new Date().toISOString(),
    link: imsi ? `/subscribers?imsi=${encodeURIComponent(imsi)}` : '/system-health',
    read: Boolean(alert.is_acknowledged),
  };
}

/**
 * Notification authority bridge.
 *
 * The presentation layer derives its state exclusively from the current
 * notification stream (GET /api/notifications/stream), which is itself a
 * read-only projection of the alert authority. No telemetry is invented.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<NotificationStreamStatus>('connecting');
  const [counts, setCounts] = useState({ activeCount: 0, criticalCount: 0, warningCount: 0 });
  const readIds = useRef<Set<string>>(new Set());

  const applyAlerts = useCallback((alerts: AlertRecord[]) => {
    setNotifications((current) => {
      const incoming = alerts.map((alert, index) => alertToNotification(alert, index));
      const merged = new Map<string, NotificationItem>();
      for (const item of incoming) merged.set(item.id, { ...item, read: item.read || readIds.current.has(item.id) });
      for (const item of current) if (!merged.has(item.id)) merged.set(item.id, item);
      return Array.from(merged.values()).slice(0, MAX_ITEMS);
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
      setConnectionStatus('disconnected');
      return undefined;
    }
    const source = new window.EventSource('/api/notifications/stream', { withCredentials: true });

    const onInit = (event: MessageEvent<string>) => {
      setConnectionStatus('connected');
      try {
        const payload = JSON.parse(event.data) as { alerts?: { activeCount?: number; activeCriticalCount?: number; activeWarningCount?: number; recent?: AlertRecord[] } };
        setCounts({
          activeCount: payload.alerts?.activeCount ?? 0,
          criticalCount: payload.alerts?.activeCriticalCount ?? 0,
          warningCount: payload.alerts?.activeWarningCount ?? 0,
        });
        applyAlerts(payload.alerts?.recent ?? []);
      } catch {
        setConnectionStatus('error');
      }
    };

    const onUpdate = (event: MessageEvent<string>) => {
      setConnectionStatus('connected');
      try {
        const payload = JSON.parse(event.data) as { activeCount?: number; activeCriticalCount?: number; activeWarningCount?: number; latestAlerts?: AlertRecord[] };
        setCounts({
          activeCount: payload.activeCount ?? 0,
          criticalCount: payload.activeCriticalCount ?? 0,
          warningCount: payload.activeWarningCount ?? 0,
        });
        applyAlerts(payload.latestAlerts ?? []);
      } catch {
        setConnectionStatus('error');
      }
    };

    const onSessionExpired = () => {
      window.dispatchEvent(new Event('xcloud-session-revalidate'));
    };

    const onError = () => setConnectionStatus('error');

    source.addEventListener('init', onInit as EventListener);
    source.addEventListener('alerts_update', onUpdate as EventListener);
    source.addEventListener('session_expired', onSessionExpired as EventListener);
    source.addEventListener('error', onError as EventListener);

    return () => {
      source.removeEventListener('init', onInit as EventListener);
      source.removeEventListener('alerts_update', onUpdate as EventListener);
      source.removeEventListener('session_expired', onSessionExpired as EventListener);
      source.removeEventListener('error', onError as EventListener);
      source.close();
      setConnectionStatus('disconnected');
    };
  }, [applyAlerts]);

  const markAsRead = useCallback((id: string) => {
    readIds.current.add(id);
    setNotifications((current) => current.map((item) => (item.id === id ? { ...item, read: true } : item)));
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((current) => {
      for (const item of current) readIds.current.add(item.id);
      return current.map((item) => ({ ...item, read: true }));
    });
  }, []);

  const clearAllNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = useMemo(() => notifications.filter((item) => !item.read).length, [notifications]);

  const value = useMemo<NotificationContextValue>(() => ({
    notifications,
    unreadCount,
    connectionStatus,
    activeCount: counts.activeCount,
    criticalCount: counts.criticalCount,
    warningCount: counts.warningCount,
    markAsRead,
    markAllAsRead,
    clearAllNotifications,
  }), [notifications, unreadCount, connectionStatus, counts, markAsRead, markAllAsRead, clearAllNotifications]);

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const value = useContext(NotificationContext);
  if (!value) throw new Error('useNotifications must be used within NotificationProvider');
  return value;
}
