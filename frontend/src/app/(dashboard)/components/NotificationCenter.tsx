"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CheckCheck,
  Trash2,
  Volume2,
  VolumeX,
  Radio,
  AlertTriangle,
  AlertOctagon,
  CheckCircle2,
  Info,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { useNotification, NotificationCategory, NotificationItem } from "@/components/NotificationProvider";

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"all" | NotificationCategory>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const router = useRouter();
  const { t } = useI18n();

  const {
    notifications,
    unreadCount,
    connectionStatus,
    soundEnabled,
    setSoundEnabled,
    soundVolume,
    setSoundVolume,
    desktopPermission,
    requestDesktopPermission,
    markAsRead,
    markAllAsRead,
    clearAllNotifications,
  } = useNotification();

  const filteredNotifications = notifications.filter((item) => {
    if (activeTab === "all") return true;
    return item.category === activeTab;
  });

  const handleItemClick = (item: NotificationItem) => {
    markAsRead(item.id);
    if (item.link) {
      setOpen(false);
      router.push(item.link);
    }
  };

  const getCategoryIcon = (item: NotificationItem) => {
    switch (item.type) {
      case "critical":
        return <AlertOctagon size={16} className="notif-type-icon critical" />;
      case "warning":
        return <AlertTriangle size={16} className="notif-type-icon warning" />;
      case "success":
        return <CheckCircle2 size={16} className="notif-type-icon success" />;
      case "info":
      default:
        return <Info size={16} className="notif-type-icon info" />;
    }
  };

  return (
    <div className="notif-center-menu">
      <button
        type="button"
        className={`icon-button notif-bell-button ${unreadCount > 0 ? "has-unread" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        title={t("notif_center_title")}
      >
        <Bell size={19} />
        {unreadCount > 0 && (
          <span className="notif-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
        )}
        <span
          className={`notif-status-dot ${connectionStatus}`}
          title={`${t("notif_live_stream")}: ${connectionStatus}`}
        />
      </button>

      {open && (
        <>
          <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="notif-dropdown-panel animate-pop-in">
            {/* Header */}
            <div className="notif-panel-header">
              <div className="notif-header-title">
                <strong>{t("notif_center_title")}</strong>
                <span className="notif-stream-badge">
                  <Radio size={12} className={connectionStatus === "connected" ? "stream-pulse" : ""} />
                  {connectionStatus === "connected" ? t("notif_stream_live") : t("notif_stream_reconnecting")}
                </span>
              </div>
              <div className="notif-header-actions">
                <button
                  type="button"
                  className="notif-tool-btn"
                  onClick={() => setSettingsOpen((prev) => !prev)}
                  title={t("notif_settings")}
                >
                  {soundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </button>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="notif-tool-btn"
                    onClick={markAllAsRead}
                    title={t("notif_mark_all_read")}
                  >
                    <CheckCheck size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* Sound & Preference quick settings */}
            {settingsOpen && (
              <div className="notif-settings-drawer">
                <div className="notif-setting-row">
                  <span>{t("notif_sound_alerts")}</span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={soundEnabled}
                      onChange={(e) => setSoundEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                {soundEnabled && (
                  <div className="notif-setting-row">
                    <span>{t("notif_volume")}: {Math.round(soundVolume * 100)}%</span>
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.05"
                      value={soundVolume}
                      onChange={(e) => setSoundVolume(parseFloat(e.target.value))}
                      className="notif-vol-slider"
                    />
                  </div>
                )}

                {desktopPermission !== "granted" && (
                  <div className="notif-setting-row">
                    <button
                      type="button"
                      className="btn btn-outline notif-desktop-btn"
                      onClick={requestDesktopPermission}
                    >
                      <ShieldAlert size={14} />
                      {t("notif_enable_desktop")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Category Tabs */}
            <div className="notif-tabs">
              <button
                type="button"
                className={`notif-tab ${activeTab === "all" ? "active" : ""}`}
                onClick={() => setActiveTab("all")}
              >
                {t("notif_tab_all")}
                <span className="notif-tab-count">{notifications.length}</span>
              </button>
              <button
                type="button"
                className={`notif-tab ${activeTab === "alert" ? "active" : ""}`}
                onClick={() => setActiveTab("alert")}
              >
                {t("notif_tab_alerts")}
              </button>
              <button
                type="button"
                className={`notif-tab ${activeTab === "approval" ? "active" : ""}`}
                onClick={() => setActiveTab("approval")}
              >
                {t("notif_tab_approvals")}
              </button>
              <button
                type="button"
                className={`notif-tab ${activeTab === "system" ? "active" : ""}`}
                onClick={() => setActiveTab("system")}
              >
                {t("notif_tab_system")}
              </button>
            </div>

            {/* Notification List */}
            <div className="notif-list">
              {filteredNotifications.length === 0 ? (
                <div className="notif-empty-state">
                  <Bell size={24} className="notif-empty-icon" />
                  <p>{t("notif_empty")}</p>
                </div>
              ) : (
                filteredNotifications.map((item) => (
                  <div
                    key={item.id}
                    className={`notif-card ${!item.read ? "unread" : ""}`}
                    onClick={() => handleItemClick(item)}
                  >
                    <div className="notif-card-icon">{getCategoryIcon(item)}</div>
                    <div className="notif-card-body">
                      <div className="notif-card-top">
                        <strong className="notif-card-title">{item.title}</strong>
                        <time className="notif-card-time">
                          {new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </time>
                      </div>
                      <p className="notif-card-msg">{item.message}</p>
                      {item.link && (
                        <div className="notif-card-link">
                          <span>{t("notif_view_details")}</span>
                          <ExternalLink size={12} />
                        </div>
                      )}
                    </div>
                    {!item.read && <span className="notif-unread-dot" />}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            {notifications.length > 0 && (
              <div className="notif-panel-footer">
                <button
                  type="button"
                  className="notif-clear-btn"
                  onClick={clearAllNotifications}
                >
                  <Trash2 size={13} />
                  {t("notif_clear_all")}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
