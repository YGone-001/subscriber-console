"use client";

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { AlertTriangle, Bell, CheckCircle2, CheckSquare, Play, Settings2, ShieldCheck, UserRoundCheck, Wrench } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

interface AlertItem {
  id: string;
  level: string;
  timestamp: string;
  imsi?: string;
  reason: string;
  is_acknowledged?: boolean;
  workflow_status?: AlertWorkflowStatus;
  assigned_to?: string;
  handling_note?: string;
  workflow_updated_at?: string;
}

interface AlertResponse {
  activeCriticalCount?: number;
  activeWarningCount?: number;
  alerts?: AlertItem[];
}

const ALARM_WAV_BASE64 =
  "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YTgGAAAAAAAAAAAAAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//";

type AlertWorkflowStatus = "triage" | "acknowledged" | "assigned" | "recovering" | "resolved";

const ASSIGNEE_OPTIONS = ["NOC L1", "Packet Core L2", "Billing/OCS", "Security", "Platform SRE"];

const WORKFLOW_CLASS: Record<AlertWorkflowStatus, string> = {
  triage: "triage",
  acknowledged: "acknowledged",
  assigned: "assigned",
  recovering: "recovering",
  resolved: "resolved",
};

function getWorkflowStatus(alert: AlertItem): AlertWorkflowStatus {
  if (alert.workflow_status === "acknowledged" || alert.workflow_status === "assigned" || alert.workflow_status === "recovering" || alert.workflow_status === "resolved") {
    return alert.workflow_status;
  }

  return alert.is_acknowledged ? "resolved" : "triage";
}

function defaultAssignee(alert: AlertItem) {
  if (alert.assigned_to) return alert.assigned_to;
  if (alert.reason.toLowerCase().includes("ocs")) return "Billing/OCS";
  if (alert.imsi) return "Packet Core L2";
  return "Platform SRE";
}

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
  const [draftOwners, setDraftOwners] = useState<Record<string, string>>({});
  const [busyAlertId, setBusyAlertId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const activeCriticalCount = data?.activeCriticalCount || 0;
  const activeWarningCount = data?.activeWarningCount || 0;
  const activeAlerts = (data?.alerts || []).filter((alert) => !alert.is_acknowledged);
  const workflowSummary = useMemo(
    () =>
      activeAlerts.reduce(
        (summary, alert) => {
          summary[getWorkflowStatus(alert)] += 1;
          return summary;
        },
        { triage: 0, acknowledged: 0, assigned: 0, recovering: 0, resolved: 0 } as Record<AlertWorkflowStatus, number>
      ),
    [activeAlerts]
  );
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

  const persistAlertWorkflow = async (alert: AlertItem, status: Exclude<AlertWorkflowStatus, "triage">) => {
    const assignedTo = draftOwners[alert.id] || defaultAssignee(alert);
    await fetch("/api/alerts/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: alert.id,
        status,
        assignedTo,
        note: t(`noc_workflow_note_${status}`),
      }),
    });
  };

  const updateAlertWorkflow = async (alert: AlertItem, status: Exclude<AlertWorkflowStatus, "triage">) => {
    setBusyAlertId(alert.id);
    try {
      await persistAlertWorkflow(alert, status);
      mutate();
    } finally {
      setBusyAlertId(null);
    }
  };

  const handleAcknowledgeAll = async () => {
    if (activeAlerts.length === 0) return;
    setBusyAlertId("all");
    try {
      await Promise.all(activeAlerts.map((alert) => persistAlertWorkflow(alert, "acknowledged")));
      mutate();
    } finally {
      setBusyAlertId(null);
    }
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

            {activeAlerts.length > 0 ? (
              <div className="noc-workflow-summary">
                <span>{t("noc_workflow_triage")}: {workflowSummary.triage}</span>
                <span>{t("noc_workflow_acknowledged")}: {workflowSummary.acknowledged}</span>
                <span>{t("noc_workflow_assigned")}: {workflowSummary.assigned}</span>
                <span>{t("noc_workflow_recovering")}: {workflowSummary.recovering}</span>
              </div>
            ) : null}

            <div className="noc-alert-list">
              {activeAlerts.length === 0 ? (
                <div className="noc-empty">
                  <ShieldCheck size={42} />
                  <strong>{t("noc_systems_operational")}</strong>
                  <span>{t("noc_no_alerts")}</span>
                </div>
              ) : (
                activeAlerts.map((alert) => {
                  const workflowStatus = getWorkflowStatus(alert);
                  const owner = draftOwners[alert.id] || defaultAssignee(alert);
                  const isBusy = busyAlertId === alert.id || busyAlertId === "all";
                  const canRecover = workflowStatus === "assigned" || workflowStatus === "recovering";

                  return (
                    <article className={alert.level === "CRITICAL" ? "noc-alert critical" : "noc-alert"} key={alert.id}>
                      <AlertTriangle size={19} />
                      <div className="noc-alert-content">
                        <div className="noc-alert-meta">
                          {new Date(alert.timestamp).toLocaleTimeString()} | IMSI: <span>{alert.imsi || "N/A"}</span>
                        </div>
                        <div className="noc-alert-reason">{alert.reason}</div>
                        <div className="noc-workflow-row">
                          <span className={`noc-workflow-pill ${WORKFLOW_CLASS[workflowStatus]}`}>
                            {t(`noc_workflow_${workflowStatus}`)}
                          </span>
                          {alert.workflow_updated_at ? <span>{new Date(alert.workflow_updated_at).toLocaleTimeString()}</span> : null}
                        </div>
                        {alert.handling_note ? <div className="noc-alert-note">{alert.handling_note}</div> : null}
                        <div className="noc-assignee-row">
                          <label htmlFor={`noc-assignee-${alert.id}`}>{t("noc_assignee")}</label>
                          <select
                            id={`noc-assignee-${alert.id}`}
                            value={owner}
                            onChange={(event) => setDraftOwners((current) => ({ ...current, [alert.id]: event.target.value }))}
                            disabled={isBusy}
                          >
                            {ASSIGNEE_OPTIONS.map((item) => (
                              <option value={item} key={item}>
                                {item}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="noc-action-grid">
                          <button
                            type="button"
                            className="btn btn-outline noc-action-button"
                            onClick={() => updateAlertWorkflow(alert, "acknowledged")}
                            disabled={isBusy || workflowStatus !== "triage"}
                          >
                            <CheckSquare size={14} />
                            {t("noc_btn_ack")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline noc-action-button"
                            onClick={() => updateAlertWorkflow(alert, "assigned")}
                            disabled={isBusy || workflowStatus === "recovering"}
                          >
                            <UserRoundCheck size={14} />
                            {t("noc_btn_assign")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline noc-action-button"
                            onClick={() => updateAlertWorkflow(alert, "recovering")}
                            disabled={isBusy || !canRecover}
                          >
                            <Wrench size={14} />
                            {t("noc_btn_recovering")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline noc-action-button resolve"
                            onClick={() => updateAlertWorkflow(alert, "resolved")}
                            disabled={isBusy}
                          >
                            <CheckCircle2 size={14} />
                            {t("noc_btn_resolve")}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })
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

  .noc-workflow-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.45rem;
    padding: 0.65rem 1rem;
    border-bottom: 1px solid var(--surface-border);
    background: color-mix(in srgb, var(--primary) 5%, var(--surface));
  }

  .noc-workflow-summary span {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--surface-border);
    border-radius: 6px;
    color: var(--text-secondary);
    background: var(--surface);
    font-size: 0.68rem;
    font-weight: 800;
    white-space: nowrap;
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

  .noc-workflow-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.55rem;
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 750;
  }

  .noc-workflow-pill {
    min-height: 22px;
    display: inline-flex;
    align-items: center;
    padding: 0 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--surface-border);
    background: var(--surface-hover);
    color: var(--text-secondary);
    font-size: 0.68rem;
    font-weight: 900;
  }

  .noc-workflow-pill.acknowledged {
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 30%, var(--surface-border));
    background: color-mix(in srgb, var(--primary) 10%, var(--surface));
  }

  .noc-workflow-pill.assigned {
    color: #7c3aed;
    border-color: rgba(124, 58, 237, 0.3);
    background: rgba(124, 58, 237, 0.1);
  }

  .noc-workflow-pill.recovering {
    color: #0f766e;
    border-color: rgba(15, 118, 110, 0.3);
    background: rgba(15, 118, 110, 0.1);
  }

  .noc-alert-note {
    margin-top: 0.45rem;
    color: var(--text-secondary);
    font-size: 0.73rem;
    line-height: 1.4;
  }

  .noc-assignee-row {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.7rem;
  }

  .noc-assignee-row label {
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 800;
  }

  .noc-assignee-row select {
    width: 100%;
    min-height: 32px;
    border: 1px solid var(--surface-border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-main);
    padding: 0 0.45rem;
    font-size: 0.74rem;
    font-weight: 750;
  }

  .noc-action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.45rem;
    margin-top: 0.7rem;
  }

  .noc-action-button {
    min-height: 30px;
    padding: 0.3rem 0.55rem;
    border-radius: 6px;
    font-size: 0.74rem;
    justify-content: center;
  }

  .noc-action-button.resolve {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 38%, var(--surface-border));
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

    .noc-workflow-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
`;
