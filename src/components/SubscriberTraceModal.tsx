"use client";

import { Activity, AlertTriangle, Clock3, DatabaseZap, History, RefreshCw, Route, ShieldCheck, Signal, X } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Dialog } from "@/components/ui/Dialog";
import { useRef } from "react";
import "./subscriber-trace-modal.css";

type SubscriberTraceModalProps = {
  imsi: string;
  onClose: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

type AuditLog = {
  id: string;
  timestamp: string;
  level: "info" | "warning";
  action: string;
  targetId: string;
  operatorIp: string;
  oldData?: unknown;
  newData?: unknown;
};

type TraceStep = {
  key: string;
  label: string;
  value: string;
  state: "ok" | "warn";
};

type TimelineEvent = {
  id: string;
  time: string;
  kind: "subscription" | "rating" | "balance" | "session" | "audit";
  tone: "ok" | "warn";
  title: string;
  detail: string;
  meta: string;
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function formatBytes(value: unknown): string {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / Math.pow(1024, index)).toFixed(2))} ${units[index]}`;
}

function formatSeconds(value: unknown): string {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatDate(value: unknown): string {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function actionLabel(action: string, t: SubscriberTraceModalProps["t"]) {
  if (action.includes("POLICY")) return t("trace_timeline_policy_action");
  if (action.includes("TRAFFIC") || action.includes("BALANCE")) return t("trace_timeline_balance_action");
  if (action.includes("UPDATE")) return t("trace_timeline_update_action");
  if (action.includes("CREATE")) return t("trace_timeline_create_action");
  if (action.includes("DELETE")) return t("trace_timeline_delete_action");
  return action;
}

export default function SubscriberTraceModal({ imsi, onClose, t }: SubscriberTraceModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const detailUrl = imsi ? `/api/subscribers/${imsi}` : null;
  const auditUrl = imsi ? `/api/audit?target=${encodeURIComponent(imsi)}&limit=12` : null;
  const { data: detail, error: detailError, isLoading: detailLoading, mutate: mutateDetail } = useSWR(detailUrl, fetcher);
  const { data: auditData, isLoading: auditLoading, mutate: mutateAudit } = useSWR(auditUrl, fetcher);

  const sub4G = asRecord(detail?.sub4G);
  const ocsImsi = asRecord(detail?.ocsImsi);
  const ocsTraffic = asRecord(detail?.ocsTraffic);
  const tariffPlan = asRecord(detail?.ocsTariffPlan);
  const planId = String(ocsImsi.plan_id || tariffPlan.plan_id || "");
  const planName = String(tariffPlan.name || planId || "");
  const planLabel = planName && planId && planName !== planId ? `${planName} (${planId})` : (planId || t("no_policy"));
  const slices = Array.isArray(sub4G.sliceList) ? sub4G.sliceList : [];
  const sessions = slices.flatMap((slice: any) => Array.isArray(slice.session_list) ? slice.session_list : []);
  const pccRuleCount = sessions.reduce((total: number, session: any) => total + (Array.isArray(session.pcc_rule) ? session.pcc_rule.length : 0), 0);
  const rules = Array.isArray(tariffPlan.rules) ? tariffPlan.rules : [];
  const dataRules = rules.filter((rule: any) => rule.charging_type === "data_volume").length;
  const voiceRules = rules.filter((rule: any) => rule.charging_type === "voice_time").length;
  const smsRules = rules.filter((rule: any) => rule.charging_type === "sms_event" || rule.unit === "events").length;
  const auditLogs: AuditLog[] = auditData?.logs || [];
  const trafficTotal = Number(ocsTraffic.traffic_total || 0);
  const trafficBalance = Number(ocsTraffic.traffic_balance || 0);
  const voiceTotal = Number(ocsTraffic.voice_total || 0);
  const voiceBalance = Number(ocsTraffic.voice_balance || 0);
  const smsTotal = Number(ocsTraffic.sms_total || 0);
  const smsBalance = Number(ocsTraffic.sms_balance || 0);
  const trafficRemaining = trafficTotal > 0 ? (trafficBalance / trafficTotal) * 100 : 0;
  const voiceRemaining = voiceTotal > 0 ? (voiceBalance / voiceTotal) * 100 : 0;
  const smsRemaining = smsTotal > 0 ? (smsBalance / smsTotal) * 100 : 0;
  const hasRatingGap = dataRules === 0 || voiceRules === 0 || smsRules === 0;
  const hasBalanceRisk = (trafficTotal > 0 && trafficRemaining < 20) || (voiceTotal > 0 && voiceRemaining < 20) || (smsTotal > 0 && smsRemaining < 20);
  const currentEvents: TimelineEvent[] = [
    {
      id: "current-subscription",
      time: t("trace_timeline_now"),
      kind: "subscription",
      tone: sub4G.access_restriction_data === 255 ? "warn" : "ok",
      title: t("trace_timeline_subscription_title"),
      detail: sub4G.access_restriction_data === 255 ? t("trace_timeline_subscription_suspended") : t("trace_timeline_subscription_active"),
      meta: imsi,
    },
    {
      id: "current-rating",
      time: t("trace_timeline_now"),
      kind: "rating",
      tone: hasRatingGap || !ocsImsi.plan_id ? "warn" : "ok",
      title: t("trace_timeline_rating_title"),
      detail: t("trace_timeline_rating_detail", { plan: planLabel, data: dataRules, voice: voiceRules, sms: smsRules }),
      meta: t("trace_timeline_rating_meta", { rules: rules.length }),
    },
    {
      id: "current-balance",
      time: t("trace_timeline_now"),
      kind: "balance",
      tone: hasBalanceRisk ? "warn" : "ok",
      title: t("trace_timeline_balance_title"),
      detail: t("trace_timeline_balance_detail", { data: formatPercent(trafficRemaining), voice: formatPercent(voiceRemaining), sms: formatPercent(smsRemaining) }),
      meta: `${formatBytes(trafficBalance)} / ${formatSeconds(voiceBalance)} / ${smsBalance} SMS`,
    },
    {
      id: "current-session",
      time: t("trace_timeline_now"),
      kind: "session",
      tone: sessions.length > 0 && pccRuleCount > 0 ? "ok" : "warn",
      title: t("trace_timeline_session_title"),
      detail: t("trace_timeline_session_detail", { slices: slices.length, sessions: sessions.length, pcc: pccRuleCount }),
      meta: t("trace_timeline_session_meta"),
    },
  ];
  const auditEvents: TimelineEvent[] = auditLogs.slice(0, 8).map((log) => ({
    id: log.id,
    time: formatDate(log.timestamp),
    kind: "audit",
    tone: log.level === "warning" ? "warn" : "ok",
    title: actionLabel(log.action, t),
    detail: t("trace_timeline_audit_detail", { action: log.action, target: log.targetId }),
    meta: log.operatorIp || "-",
  }));
  const timelineEvents = [...currentEvents, ...auditEvents];

  const traceSteps: TraceStep[] = [
    {
      key: "sub4g",
      label: t("trace_step_subscriber"),
      value: sub4G.access_restriction_data === 255 ? t("status_suspended") : t("status_active"),
      state: sub4G.access_restriction_data === 255 ? "warn" : "ok",
    },
    {
      key: "ocs",
      label: t("trace_step_ocs"),
      value: planLabel,
      state: ocsImsi.plan_id ? "ok" : "warn",
    },
    {
      key: "slice",
      label: t("trace_step_slice"),
      value: t("trace_slice_summary", { slices: slices.length, sessions: sessions.length }),
      state: sessions.length > 0 ? "ok" : "warn",
    },
    {
      key: "rating",
      label: t("trace_step_rating"),
      value: t("trace_rating_summary", { data: dataRules, voice: voiceRules, sms: smsRules }),
      state: dataRules > 0 && voiceRules > 0 && smsRules > 0 ? "ok" : "warn",
    },
  ];

  const refresh = () => {
    mutateDetail();
    mutateAudit();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      overlayClassName="modal-overlay"
      className="modal-content animate-modal-enter trace-modal-container"
      labelledBy="subscriber-trace-modal-title"
      initialFocusRef={closeButtonRef}
    >
        <div className="workflow-header trace-modal-header">
          <div>
            <h2 id="subscriber-trace-modal-title" className="trace-modal-title">
              <Signal size={18} /> {t("trace_title")}
            </h2>
            <p className="trace-modal-subtitle">{imsi}</p>
          </div>
          <div className="trace-modal-actions">
            <button className="btn btn-outline trace-btn-refresh" onClick={refresh} disabled={detailLoading || auditLoading}>
              <RefreshCw size={15} /> {t("trace_refresh")}
            </button>
            <button ref={closeButtonRef} className="btn-icon" onClick={onClose} title={t("close")} aria-label={t("close")}><X size={22} /></button>
          </div>
        </div>

        <div className="trace-modal-body">
          {detailError && (
            <div className="trace-error">
              {detailError.message || t("trace_err_load")}
            </div>
          )}

          <div className="trace-steps-grid">
            {traceSteps.map((step) => (
              <div key={step.key} className="trace-step-card">
                <div className="trace-step-header">
                  <span>{step.label}</span>
                  {step.state === "ok" ? <ShieldCheck size={15} color="var(--success)" /> : <AlertTriangle size={15} color="var(--warning)" />}
                </div>
                <div className="trace-step-value">
                  {detailLoading ? t("loading") : step.value}
                </div>
              </div>
            ))}
          </div>

          <div className="trace-middle-grid">
            <section className="trace-section-card">
              <div className="trace-section-header">
                <DatabaseZap size={16} color="var(--primary)" /> {t("trace_balance_title")}
              </div>
              <div className="trace-balance-grid">
                {[
                  [t("traffic_total"), formatBytes(ocsTraffic.traffic_total)],
                  [t("traffic_balance"), formatBytes(ocsTraffic.traffic_balance)],
                  [t("trace_voice_total"), formatSeconds(ocsTraffic.voice_total)],
                  [t("trace_voice_balance"), formatSeconds(ocsTraffic.voice_balance)],
                  [t("trace_sms_total"), `${Number(ocsTraffic.sms_total || 0)} SMS`],
                  [t("trace_sms_balance"), `${Number(ocsTraffic.sms_balance || 0)} SMS`],
                ].map(([label, value]) => (
                  <div key={label} className="trace-balance-item">
                    <div className="trace-balance-label">{label}</div>
                    <div className="trace-balance-value">{detailLoading ? t("loading") : value}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="trace-section-card">
              <div className="trace-section-header">
                <Route size={16} color="var(--primary)" /> {t("trace_session_title")}
              </div>
              <div className="trace-session-body">
                {(detailLoading ? [] : sessions.slice(0, 4)).map((session: any, index: number) => (
                  <div key={`${session.name || "session"}-${index}`} className="trace-session-item">
                    <strong>{session.name || "-"}</strong>
                    <span className="trace-session-5qi">5QI {asRecord(session.qos)._5qi || asRecord(session.qos).index || "-"}</span>
                    <span className="trace-session-pcc">{Array.isArray(session.pcc_rule) ? session.pcc_rule.length : 0} PCC</span>
                  </div>
                ))}
                {!detailLoading && sessions.length === 0 && <div className="trace-text-muted">{t("trace_no_sessions")}</div>}
                {!detailLoading && sessions.length > 4 && <div className="trace-text-muted trace-text-sm">+{sessions.length - 4}</div>}
                {!detailLoading && sessions.length > 0 && (
                  <div className="trace-text-muted trace-text-sm trace-mt-sm">
                    {t("trace_pcc_summary", { count: pccRuleCount })}
                  </div>
                )}
              </div>
            </section>
          </div>

          <section className="trace-section-card">
            <div className="trace-section-header trace-section-header-flex">
              <span className="trace-section-header-left">
                <History size={16} color="var(--primary)" /> {t("trace_timeline_title")}
              </span>
              <span className="trace-section-subtitle">{t("trace_timeline_subtitle")}</span>
            </div>
            <div className="trace-timeline-body">
              {detailLoading ? (
                <div className="trace-timeline-loading">{t("loading")}</div>
              ) : (
                timelineEvents.map((event, index) => (
                  <div key={event.id} className="trace-timeline-item">
                    <div className="trace-timeline-icon-col">
                      <span className={`trace-timeline-icon ${event.tone}`}>
                        {event.tone === "ok" ? <ShieldCheck size={13} color="var(--success)" /> : <AlertTriangle size={13} color="var(--warning)" />}
                      </span>
                      {index < timelineEvents.length - 1 ? <span className="trace-timeline-line" /> : null}
                    </div>
                    <div className={`trace-timeline-content ${event.kind === "audit" ? "audit" : "normal"}`}>
                      <div className="trace-timeline-header">
                        <strong className="trace-timeline-title">{event.title}</strong>
                        <span className="trace-timeline-time">{event.time}</span>
                      </div>
                      <div className="trace-timeline-detail">{event.detail}</div>
                      <div className="trace-timeline-meta">{event.meta}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="trace-section-card">
            <div className="trace-section-header">
              <Clock3 size={16} color="var(--primary)" /> {t("trace_audit_title")}
            </div>
            <div className="trace-audit-body">
              {auditLoading ? (
                <div className="trace-timeline-loading">{t("loading")}</div>
              ) : auditLogs.length === 0 ? (
                <div className="trace-timeline-loading">{t("trace_no_audit")}</div>
              ) : (
                auditLogs.map((log) => (
                  <div key={log.id} className="trace-audit-item">
                    <span className="trace-audit-time">{formatDate(log.timestamp)}</span>
                    <span className={`trace-audit-action ${log.level === "warning" ? "danger" : "primary"}`}>{log.action}</span>
                    <span className="trace-audit-target">
                      <Activity size={13} className="trace-audit-target-icon" />{log.targetId} · {log.operatorIp}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
    </Dialog>
  );
}
