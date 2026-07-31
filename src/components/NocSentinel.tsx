"use client";
import "./NocSentinel.css";

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
  const { data, mutate } = useSWR<AlertResponse>("/api/alerts", fetcher, { 
    refreshInterval: 15000,
    revalidateOnFocus: true,
    errorRetryInterval: 30000 
  });
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

      
    </div>
  );
}


