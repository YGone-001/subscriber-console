"use client";

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { AlertTriangle, Bell, CheckSquare, Play, Settings2, ShieldCheck } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

interface AlertItem {
  id: string;
  level: string;
  timestamp: string;
  imsi?: string;
  reason: string;
  is_acknowledged?: boolean;
}

interface AlertResponse {
  activeCriticalCount?: number;
  activeWarningCount?: number;
  alerts?: AlertItem[];
}

const ALARM_WAV_BASE64 =
  "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YTgGAAAAAAAAAAAAAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//";

export default function NocSentinel() {
  const { t } = useI18n();
  const { data, mutate } = useSWR<AlertResponse>("/api/alerts", fetcher, { refreshInterval: 2000 });
  const [, forceMonitorRefresh] = useState(0);
  const monitorActive = useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return localStorage.getItem("xcloud_sentinel_monitor") === "true";
      } catch {
        return false;
      }
    },
    () => false
  );
  const [expanded, setExpanded] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const activeCriticalCount = data?.activeCriticalCount || 0;
  const activeWarningCount = data?.activeWarningCount || 0;
  const activeAlerts = (data?.alerts || []).filter((alert) => !alert.is_acknowledged);
  const activeCount = activeCriticalCount + activeWarningCount;
  const hasCritical = activeCriticalCount > 0;
  const hasWarning = activeWarningCount > 0;
  const needsActivation = !monitorActive || audioBlocked;

  useEffect(() => {
    document.body.classList.toggle("global-emergency-flash", hasCritical);
    return () => {
      document.body.classList.remove("global-emergency-flash");
    };
  }, [hasCritical]);

  useEffect(() => {
    if (monitorActive && audioRef.current) {
      if (hasCritical) {
        audioRef.current
          .play()
          .then(() => setAudioBlocked(false))
          .catch(() => setAudioBlocked(true));
      } else {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
    }
  }, [hasCritical, monitorActive]);

  const toggleMonitor = (val: boolean) => {
    localStorage.setItem("xcloud_sentinel_monitor", String(val));
    forceMonitorRefresh((value) => value + 1);
    if (!val) setAudioBlocked(false);
  };

  const handleAcknowledge = async (id: string) => {
    await fetch("/api/alerts/acknowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    mutate();
  };

  const handleAcknowledgeAll = async () => {
    if (activeAlerts.length === 0) return;
    await fetch("/api/alerts/acknowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: activeAlerts.map((alert) => alert.id) }),
    });
    mutate();
  };

  const statusClass = hasCritical ? "critical" : hasWarning ? "warning" : needsActivation ? "muted" : "healthy";
  const statusLabel = hasCritical ? "Critical" : hasWarning ? "Warning" : needsActivation ? "NOC setup" : "NOC online";

  return (
    <div className="noc-sentinel">
      <audio ref={audioRef} src={ALARM_WAV_BASE64} loop />

      {hasCritical && (
        <div className="noc-critical-ticker">
          <AlertTriangle size={18} />
          <div>
            {t("noc_fault_detected")}{" "}
            {activeAlerts
              .filter((alert) => alert.level === "CRITICAL")
              .map((alert) => `${alert.imsi || "SYS"}: ${alert.reason}`)
              .join(" | ")}
          </div>
        </div>
      )}

      <button
        type="button"
        className={`noc-header-button ${statusClass}`}
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        title="NOC Sentinel Alerts"
      >
        <span className="noc-button-icon">
          {hasCritical || hasWarning ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
        </span>
        <span className="noc-button-label">NOC</span>
        {activeCount > 0 ? <span className="noc-count">{activeCount}</span> : null}
      </button>

      {expanded && (
        <>
          <div className="noc-panel-backdrop" onClick={() => setExpanded(false)} />
          <section className="noc-panel">
            <div className="noc-panel-header">
              <div>
                <h3>
                  <Bell size={18} />
                  {t("noc_panel_title")}
                </h3>
                <span>{statusLabel}</span>
              </div>
              {activeAlerts.length > 0 ? (
                <button type="button" className="noc-ghost-button" onClick={handleAcknowledgeAll}>
                  {t("noc_ack_all")}
                </button>
              ) : null}
            </div>

            {needsActivation && (
              <div className="noc-activation-card">
                <div className="noc-activation-title">
                  <Settings2 size={16} />
                  {audioBlocked ? t("noc_browser_blocked") : t("noc_hardware_blocked")}
                </div>
                <p>{audioBlocked ? t("noc_browser_blocked_desc") : t("noc_autoplay_blocked_desc")}</p>
                <button type="button" className="btn btn-primary noc-activate-button" onClick={() => toggleMonitor(true)}>
                  <Play size={15} />
                  {audioBlocked ? t("noc_btn_reauthorize") : t("noc_btn_activate")}
                </button>
              </div>
            )}

            <div className="noc-monitor-row">
              <label>
                <input type="checkbox" checked={monitorActive} onChange={(event) => toggleMonitor(event.target.checked)} />
                {t("noc_keep_active")}
              </label>
            </div>

            <div className="noc-alert-list">
              {activeAlerts.length === 0 ? (
                <div className="noc-empty">
                  <ShieldCheck size={42} />
                  <strong>{t("noc_systems_operational")}</strong>
                  <span>{t("noc_no_alerts")}</span>
                </div>
              ) : (
                activeAlerts.map((alert) => (
                  <article className={alert.level === "CRITICAL" ? "noc-alert critical" : "noc-alert"} key={alert.id}>
                    <AlertTriangle size={19} />
                    <div className="noc-alert-content">
                      <div className="noc-alert-meta">
                        {new Date(alert.timestamp).toLocaleTimeString()} | IMSI: <span>{alert.imsi || "N/A"}</span>
                      </div>
                      <div className="noc-alert-reason">{alert.reason}</div>
                      <button type="button" className="btn btn-outline noc-ack-button" onClick={() => handleAcknowledge(alert.id)}>
                        <CheckSquare size={14} />
                        {t("noc_btn_ack")}
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        </>
      )}

      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </div>
  );
}

const styles = `
  .noc-sentinel {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .noc-header-button {
    min-width: 74px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    background: var(--surface-hover);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 800;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease, transform 0.2s ease;
  }

  .noc-header-button:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--primary) 38%, var(--surface-border));
    color: var(--text-main);
  }

  .noc-header-button.healthy {
    color: var(--success);
    background: color-mix(in srgb, var(--success) 10%, var(--surface));
  }

  .noc-header-button.warning {
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.12);
    border-color: rgba(245, 158, 11, 0.28);
  }

  .noc-header-button.critical {
    color: #fff;
    background: var(--danger);
    border-color: var(--danger);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 18%, transparent);
  }

  .noc-header-button.muted {
    color: var(--text-muted);
  }

  .noc-button-icon {
    display: inline-flex;
    align-items: center;
  }

  .noc-count {
    min-width: 19px;
    height: 19px;
    padding: 0 0.35rem;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    color: var(--danger);
    font-size: 0.68rem;
    font-weight: 900;
  }

  .noc-panel-backdrop {
    position: fixed;
    inset: 0;
    z-index: 59;
  }

  .noc-panel {
    position: absolute;
    top: calc(100% + 0.75rem);
    right: 0;
    z-index: 60;
    width: min(420px, calc(100vw - 1.5rem));
    max-height: min(640px, calc(100vh - 96px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    box-shadow: 0 20px 54px -26px rgba(0, 0, 0, 0.55);
    animation: nocPanelIn 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .noc-panel-header {
    min-height: 66px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem;
    background: var(--header-bg);
    border-bottom: 1px solid var(--surface-border);
  }

  .noc-panel-header h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-main);
    font-size: 0.98rem;
    font-weight: 800;
  }

  .noc-panel-header span {
    display: block;
    margin-top: 0.25rem;
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .noc-ghost-button {
    border: none;
    background: transparent;
    color: var(--primary);
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 800;
  }

  .noc-activation-card {
    margin: 0.85rem;
    padding: 0.9rem;
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    background: var(--header-bg);
  }

  .noc-activation-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-main);
    font-size: 0.84rem;
    font-weight: 800;
  }

  .noc-activation-card p {
    margin: 0.65rem 0 0.85rem;
    color: var(--text-secondary);
    font-size: 0.76rem;
    line-height: 1.45;
  }

  .noc-activate-button {
    width: 100%;
    min-height: 34px;
    padding: 0.45rem 0.65rem;
    border-radius: 6px;
    font-size: 0.78rem;
  }

  .noc-monitor-row {
    padding: 0.65rem 1rem;
    border-bottom: 1px solid var(--surface-border);
  }

  .noc-monitor-row label {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .noc-monitor-row input {
    width: 13px;
    height: 13px;
    cursor: pointer;
    accent-color: var(--primary);
  }

  .noc-alert-list {
    overflow-y: auto;
    min-height: 180px;
  }

  .noc-empty {
    min-height: 210px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem;
    color: var(--text-muted);
    text-align: center;
  }

  .noc-empty svg {
    opacity: 0.32;
  }

  .noc-empty strong {
    color: var(--text-main);
    font-size: 0.92rem;
  }

  .noc-empty span {
    font-size: 0.78rem;
  }

  .noc-alert {
    display: flex;
    gap: 0.8rem;
    padding: 0.95rem 1rem;
    border-bottom: 1px solid var(--surface-border);
    color: #f59e0b;
    background: var(--surface);
  }

  .noc-alert.critical {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 9%, var(--surface));
  }

  .noc-alert-content {
    flex: 1;
    min-width: 0;
  }

  .noc-alert-meta {
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 700;
    margin-bottom: 0.25rem;
  }

  .noc-alert-meta span {
    font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace;
  }

  .noc-alert-reason {
    color: var(--text-main);
    font-size: 0.86rem;
    font-weight: 650;
    line-height: 1.42;
  }

  .noc-ack-button {
    min-height: 30px;
    margin-top: 0.7rem;
    padding: 0.3rem 0.55rem;
    border-radius: 6px;
    font-size: 0.74rem;
  }

  .noc-critical-ticker {
    position: fixed;
    top: 72px;
    left: 0;
    right: 0;
    z-index: 80;
    min-height: 34px;
    display: flex;
    align-items: center;
    gap: 1rem;
    overflow: hidden;
    padding: 0.4rem 1rem;
    background: #dc2626;
    color: #fff;
    font-size: 0.84rem;
    font-weight: 800;
  }

  .noc-critical-ticker > div {
    white-space: nowrap;
    animation: ticker 15s linear infinite;
  }

  @keyframes nocPanelIn {
    0% { opacity: 0; transform: translateY(-8px) scale(0.98); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }

  @media (max-width: 760px) {
    .noc-button-label {
      display: none;
    }

    .noc-header-button {
      min-width: 38px;
      width: 38px;
      padding: 0;
    }

    .noc-panel {
      position: fixed;
      top: 76px;
      right: 0.75rem;
    }
  }
`;
