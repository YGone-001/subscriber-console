"use client";

import { Activity, AlertTriangle, Clock3, DatabaseZap, RefreshCw, Route, ShieldCheck, Signal, X } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";

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
};

type TraceStep = {
  key: string;
  label: string;
  value: string;
  state: "ok" | "warn";
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

export default function SubscriberTraceModal({ imsi, onClose, t }: SubscriberTraceModalProps) {
  const detailUrl = imsi ? `/api/subscribers/${imsi}` : null;
  const auditUrl = imsi ? `/api/audit?target=${encodeURIComponent(imsi)}&limit=6` : null;
  const { data: detail, error: detailError, isLoading: detailLoading, mutate: mutateDetail } = useSWR(detailUrl, fetcher);
  const { data: auditData, isLoading: auditLoading, mutate: mutateAudit } = useSWR(auditUrl, fetcher);

  const sub4G = asRecord(detail?.sub4G);
  const ocsImsi = asRecord(detail?.ocsImsi);
  const ocsTraffic = asRecord(detail?.ocsTraffic);
  const tariffPlan = asRecord(detail?.ocsTariffPlan);
  const slices = Array.isArray(sub4G.sliceList) ? sub4G.sliceList : [];
  const sessions = slices.flatMap((slice: any) => Array.isArray(slice.session_list) ? slice.session_list : []);
  const pccRuleCount = sessions.reduce((total: number, session: any) => total + (Array.isArray(session.pcc_rule) ? session.pcc_rule.length : 0), 0);
  const rules = Array.isArray(tariffPlan.rules) ? tariffPlan.rules : [];
  const dataRules = rules.filter((rule: any) => rule.charging_type === "data_volume").length;
  const voiceRules = rules.filter((rule: any) => rule.charging_type === "voice_time").length;
  const auditLogs: AuditLog[] = auditData?.logs || [];

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
      value: ocsImsi.plan_id || t("no_policy"),
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
      value: t("trace_rating_summary", { data: dataRules, voice: voiceRules }),
      state: dataRules > 0 && voiceRules > 0 ? "ok" : "warn",
    },
  ];

  const refresh = () => {
    mutateDetail();
    mutateAudit();
  };

  return (
    <div className="modal-overlay" onClick={(event) => { event.stopPropagation(); onClose(); }}>
      <div className="modal-content animate-modal-enter" style={{ width: "980px", maxWidth: "96vw", padding: 0, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column" }} onClick={(event) => event.stopPropagation()}>
        <div className="workflow-header" style={{ padding: "1.25rem 1.5rem", borderBottom: "1px solid var(--surface-border)" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.2rem", color: "var(--text-main)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Signal size={18} /> {t("trace_title")}
            </h2>
            <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontFamily: "monospace", fontSize: "0.9rem" }}>{imsi}</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button className="btn btn-outline" onClick={refresh} disabled={detailLoading || auditLoading} style={{ padding: "0.45rem 0.75rem" }}>
              <RefreshCw size={15} /> {t("trace_refresh")}
            </button>
            <button className="btn-icon" onClick={onClose} title={t("close")}><X size={22} /></button>
          </div>
        </div>

        <div style={{ padding: "1.5rem", overflowY: "auto", display: "grid", gap: "1.25rem" }}>
          {detailError && (
            <div style={{ border: "1px solid rgba(239, 68, 68, 0.35)", borderRadius: 8, padding: "0.9rem", color: "var(--danger)", background: "rgba(239, 68, 68, 0.08)", fontWeight: 600 }}>
              {detailError.message || t("trace_err_load")}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "0.75rem" }}>
            {traceSteps.map((step) => (
              <div key={step.key} style={{ border: "1px solid var(--surface-border)", borderRadius: 8, padding: "0.9rem", background: "var(--surface-hover)", minHeight: 92 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "center", color: "var(--text-muted)", fontSize: "0.75rem" }}>
                  <span>{step.label}</span>
                  {step.state === "ok" ? <ShieldCheck size={15} color="var(--success)" /> : <AlertTriangle size={15} color="var(--warning)" />}
                </div>
                <div style={{ marginTop: "0.65rem", color: "var(--text-main)", fontWeight: 800, lineHeight: 1.35, wordBreak: "break-word" }}>
                  {detailLoading ? t("loading") : step.value}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "1rem" }}>
            <section style={{ border: "1px solid var(--surface-border)", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "0.85rem 1rem", borderBottom: "1px solid var(--surface-border)", display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-main)", fontWeight: 800 }}>
                <DatabaseZap size={16} color="var(--primary)" /> {t("trace_balance_title")}
              </div>
              <div style={{ padding: "1rem", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.75rem" }}>
                {[
                  [t("traffic_total"), formatBytes(ocsTraffic.traffic_total)],
                  [t("traffic_balance"), formatBytes(ocsTraffic.traffic_balance)],
                  [t("trace_voice_total"), formatSeconds(ocsTraffic.voice_total)],
                  [t("trace_voice_balance"), formatSeconds(ocsTraffic.voice_balance)],
                ].map(([label, value]) => (
                  <div key={label} style={{ background: "var(--surface-hover)", borderRadius: 8, padding: "0.75rem" }}>
                    <div style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>{label}</div>
                    <div style={{ marginTop: "0.3rem", color: "var(--text-main)", fontWeight: 800 }}>{detailLoading ? t("loading") : value}</div>
                  </div>
                ))}
              </div>
            </section>

            <section style={{ border: "1px solid var(--surface-border)", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "0.85rem 1rem", borderBottom: "1px solid var(--surface-border)", display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-main)", fontWeight: 800 }}>
                <Route size={16} color="var(--primary)" /> {t("trace_session_title")}
              </div>
              <div style={{ padding: "1rem", display: "grid", gap: "0.6rem" }}>
                {(detailLoading ? [] : sessions.slice(0, 4)).map((session: any, index: number) => (
                  <div key={`${session.name || "session"}-${index}`} style={{ display: "grid", gridTemplateColumns: "minmax(90px, 0.8fr) minmax(0, 1fr) 72px", gap: "0.75rem", alignItems: "center", color: "var(--text-main)", fontSize: "0.86rem" }}>
                    <strong>{session.name || "-"}</strong>
                    <span style={{ color: "var(--text-muted)" }}>5QI {asRecord(session.qos)._5qi || asRecord(session.qos).index || "-"}</span>
                    <span style={{ color: "var(--primary)", fontWeight: 700, textAlign: "right" }}>{Array.isArray(session.pcc_rule) ? session.pcc_rule.length : 0} PCC</span>
                  </div>
                ))}
                {!detailLoading && sessions.length === 0 && <div style={{ color: "var(--text-muted)" }}>{t("trace_no_sessions")}</div>}
                {!detailLoading && sessions.length > 4 && <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>+{sessions.length - 4}</div>}
                {!detailLoading && sessions.length > 0 && (
                  <div style={{ marginTop: "0.3rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {t("trace_pcc_summary", { count: pccRuleCount })}
                  </div>
                )}
              </div>
            </section>
          </div>

          <section style={{ border: "1px solid var(--surface-border)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "0.85rem 1rem", borderBottom: "1px solid var(--surface-border)", display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-main)", fontWeight: 800 }}>
              <Clock3 size={16} color="var(--primary)" /> {t("trace_audit_title")}
            </div>
            <div style={{ padding: "0.25rem 1rem 1rem" }}>
              {auditLoading ? (
                <div style={{ padding: "1rem 0", color: "var(--text-muted)" }}>{t("loading")}</div>
              ) : auditLogs.length === 0 ? (
                <div style={{ padding: "1rem 0", color: "var(--text-muted)" }}>{t("trace_no_audit")}</div>
              ) : (
                auditLogs.map((log) => (
                  <div key={log.id} style={{ display: "grid", gridTemplateColumns: "160px 140px minmax(0, 1fr)", gap: "1rem", padding: "0.75rem 0", borderBottom: "1px solid var(--surface-border)", alignItems: "center" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>{formatDate(log.timestamp)}</span>
                    <span style={{ color: log.level === "warning" ? "var(--danger)" : "var(--primary)", fontWeight: 800, fontSize: "0.82rem" }}>{log.action}</span>
                    <span style={{ color: "var(--text-main)", fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <Activity size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />{log.targetId} · {log.operatorIp}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
