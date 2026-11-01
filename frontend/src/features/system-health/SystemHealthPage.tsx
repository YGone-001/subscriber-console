/*
 * System health workspace.
 *
 * Two sections, two authorities:
 *
 *   - Platform health: runtime probes owned by the Go process (API, schedulers,
 *     notification worker, knowledge storage, log sources) plus MongoDB. A
 *     missing probe is unavailable, never healthy.
 *   - Data consistency: read-only OCS/HSS/anomaly evaluation. The former
 *     auto-heal write path is retired from the console; findings link to the
 *     owning business surface instead.
 *
 * The page never fabricates a healthy default: a failed read renders an explicit
 * unavailable state, and a composite score is not presented as an operational
 * fact.
 */
import { useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Database,
  Download,
  HeartPulse,
  Info,
  Layers,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { Link } from "react-router-dom";
import useSWR from "swr";
import { fetcher } from "../../lib/fetcher";
import { useI18n } from "../../providers/I18nProvider";
import { useAuth } from "../../providers/AuthProvider";
import { hasPermission } from "../../lib/permissions";
import { requestAuditScanStep } from "./system-health-api";
import { EmptyState, LoadingRows, OperationNotice } from "../../components/ui/OperationFeedback";
import { ErrorState } from "../../components/ui/StatePanel";
import type {
  ComprehensiveSystemHealth,
  PlatformProbe,
  SubsystemStatus,
  SystemAnomaly,
  AnomalyCategory,
  AnomalySeverity,
} from "../../types/platformHealth";
import PageHeader, { type PageHeaderTone } from "../../components/ui/PageHeader";
import SectionHeader from "../../components/ui/SectionHeader";
import SubsystemCard from "../../components/health/SubsystemCard";
import MetricStrip from "../../components/ui/MetricStrip";

type HealthNotice = {
  type: "success" | "error" | "warning";
  text: string;
};

type ScanPhase = "IDLE" | "INIT" | "SCAN_SUB" | "SCAN_OCS" | "SCAN_TARIFF" | "SCAN_RESERVATIONS" | "COMPLETE" | "ABORTED";

const KNOWN_PROBES = [
  "api",
  "discovery_scheduler",
  "nf_health_scheduler",
  "notification_worker",
  "knowledge_storage",
  "log_sources",
] as const;

function worstStatus(statuses: Array<SubsystemStatus | undefined>): SubsystemStatus {
  if (statuses.some((status) => status === "critical" || status === "unavailable")) return "unavailable";
  if (statuses.some((status) => status === "degraded")) return "degraded";
  if (statuses.length > 0 && statuses.every((status) => status === "healthy")) return "healthy";
  return "unavailable";
}

function probeTone(status: SubsystemStatus | undefined): "success" | "warning" | "danger" | undefined {
  if (status === "healthy") return "success";
  if (status === "degraded") return "warning";
  if (status === "critical" || status === "unavailable") return "danger";
  return undefined;
}

export function SystemHealthPage() {
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const canScan = hasPermission(user, "core.configure");

  const {
    data: systemHealth,
    mutate: refreshSystemHealth,
    isLoading: isHealthLoading,
    error: healthError,
  } = useSWR<ComprehensiveSystemHealth>("/api/system/health", fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: false,
  });

  const [isAuditing, setIsAuditing] = useState(false);
  const [scannedTotal, setScannedTotal] = useState(0);
  const [anomalies, setAnomalies] = useState<SystemAnomaly[]>([]);
  const [auditPhase, setAuditPhase] = useState<ScanPhase>("IDLE");
  const [notice, setNotice] = useState<HealthNotice | null>(null);
  const [activeCategoryTab, setActiveCategoryTab] = useState<AnomalyCategory | "all">("all");
  const [selectedSeverity, setSelectedSeverity] = useState<AnomalySeverity | "all">("all");

  const scanMetrics = useRef({ total: 0, anomaliesList: [] as SystemAnomaly[] });

  const probes = systemHealth?.platform?.probes ?? [];
  const probeByKey = useMemo(() => {
    const map = new Map<string, PlatformProbe>();
    for (const probe of probes) map.set(probe.key, probe);
    return map;
  }, [probes]);
  const platformStatus = systemHealth?.platform?.status ?? "unavailable";
  const dataStatus = systemHealth?.dataConsistency?.status ?? systemHealth?.status ?? "unavailable";
  const overallStatus: SubsystemStatus = !systemHealth
    ? "unavailable"
    : worstStatus([platformStatus, dataStatus]);

  const runFullAudit = async () => {
    if (!canScan) return;
    setIsAuditing(true);
    setNotice(null);
    setAnomalies([]);
    setScannedTotal(0);
    setAuditPhase("INIT");
    scanMetrics.current = { total: 0, anomaliesList: [] };
    await recursiveScan("0", "sub");
  };

  const recursiveScan = async (cursor: string, phase: "sub" | "ocs" | "tariff" | "reservation") => {
    try {
      if (cursor === "0") {
        if (phase === "sub") setAuditPhase("SCAN_SUB");
        else if (phase === "ocs") setAuditPhase("SCAN_OCS");
        else if (phase === "tariff") setAuditPhase("SCAN_TARIFF");
        else setAuditPhase("SCAN_RESERVATIONS");
      }

      const data = await requestAuditScanStep(cursor, phase);
      scanMetrics.current.total += data.scannedCount;
      if (data.anomalies && data.anomalies.length > 0) {
        scanMetrics.current.anomaliesList = [...scanMetrics.current.anomaliesList, ...data.anomalies];
      }
      setScannedTotal(scanMetrics.current.total);
      setAnomalies([...scanMetrics.current.anomaliesList]);

      const newNext = String(data.nextCursor);
      if (newNext !== "0") {
        await recursiveScan(newNext, phase);
      } else if (phase === "sub") {
        await recursiveScan("0", "ocs");
      } else if (phase === "ocs") {
        await recursiveScan("0", "tariff");
      } else if (phase === "tariff") {
        await recursiveScan("0", "reservation");
      } else {
        setAuditPhase("COMPLETE");
        setIsAuditing(false);
        await refreshSystemHealth();
      }
    } catch {
      setIsAuditing(false);
      setAuditPhase("ABORTED");
      setNotice({ type: "error", text: t("health_scan_abort") });
    }
  };

  const filteredAnomalies = useMemo(() => anomalies.filter((anomaly) => {
    if (activeCategoryTab !== "all" && anomaly.category !== activeCategoryTab) return false;
    if (selectedSeverity !== "all" && anomaly.severity !== selectedSeverity) return false;
    return true;
  }), [anomalies, activeCategoryTab, selectedSeverity]);

  const exportDiagnosticReport = () => {
    const reportData = {
      timestamp: new Date().toISOString(),
      status: systemHealth?.status ?? "unavailable",
      checkedAt: systemHealth?.checkedAt,
      platform: systemHealth?.platform,
      dataConsistency: systemHealth?.dataConsistency,
      subsystems: systemHealth?.subsystems,
      recommendations: systemHealth?.summary?.recommendations || [],
      auditStats: {
        totalScanned: scannedTotal,
        anomaliesCount: anomalies.length,
        anomalies,
      },
    };
    const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `system-health-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const renderDetails = (details: string, type: string) => {
    if (type === "orphan_reservation") return t("health_err_orphan_reservation");
    if (type === "invalid_tariff") return t("health_err_invalid_tariff");
    if (type === "dangling_profile") return t("health_err_dangling_profile");
    if (details.startsWith("Missing ")) {
      const ratio = details.split(" ")[1];
      return t("health_err_missing_ocs").replace("{ratio}", ratio);
    }
    if (details === "Balance field is null or undefined") return t("health_err_balance_null");
    if (details === "Balance format evaluates to NaN") return t("health_err_balance_nan");
    if (details === "Critical: Invalid JSON payload in Account table") return t("health_err_invalid_json");
    if (details === "Found Active OCS but missing core SUB_4G definition") return t("health_err_orphan_ocs");
    return details;
  };

  const renderRecommendation = (recommendation: string) => {
    const patterns: Array<[RegExp, string]> = [
      [/^Run MongoDB index initialization .* to restore (\d+) missing indexes$/, "health_rec_mongo_indexes"],
      [/^Resolve (\d+) OCS balance invariant inconsistencies$/, "health_rec_ocs_invariants"],
      [/^Clean up (\d+) orphaned in-flight quota reservations$/, "health_rec_orphan_reservations"],
      [/^Fix (\d+) malformed HSS subscriber records$/, "health_rec_hss_malformed"],
      [/^Rebind (\d+) subscribers referencing missing profile templates$/, "health_rec_dangling_profiles"],
      [/^Acknowledge and triage (\d+) critical operational alerts in NOC$/, "health_rec_critical_alerts"],
    ];
    for (const [pattern, key] of patterns) {
      const matched = recommendation.match(pattern);
      if (matched) return t(key, { count: matched[1] });
    }
    return recommendation;
  };

  const getStatusBadge = (status: SubsystemStatus) => {
    if (status === "healthy") return <span className="subsystem-badge healthy"><Check size={12} /> {t("health_status_healthy")}</span>;
    if (status === "degraded") return <span className="subsystem-badge degraded"><AlertTriangle size={12} /> {t("health_status_degraded")}</span>;
    if (status === "unavailable") return <span className="subsystem-badge unavailable"><Server size={12} /> {t("health_status_unavailable")}</span>;
    return <span className="subsystem-badge critical"><ShieldAlert size={12} /> {t("health_status_critical")}</span>;
  };

  const probeLabel = (key: string) => {
    if ((KNOWN_PROBES as readonly string[]).includes(key)) return t(`platform_probe_${key}`);
    return key;
  };

  const probeMetric = (key: string) => {
    const probe = probeByKey.get(key);
    return {
      label: probeLabel(key),
      value: probe ? t(`health_status_${probe.status}`) : t("health_status_unavailable"),
      tone: probeTone(probe?.status),
    };
  };

  const platformHealthyCount = probes.filter((probe) => probe.status === "healthy").length;

  if (healthError && !systemHealth) {
    return (
      <div className="container animate-fade-in health-container">
        <PageHeader
          eyebrow={t("eyebrow_noc_diagnostics")}
          icon={<HeartPulse size={23} />}
          title={t("nav_system_health")}
          description={t("health_error_body")}
          tone="danger"
          status={getStatusBadge("unavailable")}
        />
        <div className="dash-card">
          <ErrorState
            title={t("health_error_title")}
            message={healthError instanceof Error ? healthError.message : t("health_error_body")}
            retryLabel={t("retry")}
            onRetry={() => { void refreshSystemHealth(); }}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="container animate-fade-in health-container">
        {notice && (
          <OperationNotice
            presentation="modal"
            tone={notice.type === "success" ? "success" : notice.type === "warning" ? "warning" : "danger"}
            title={notice.type === "success" ? t("success") : notice.type === "warning" ? t("status") : t("error")}
            message={notice.text}
            onClose={() => setNotice(null)}
          />
        )}

        <PageHeader
          eyebrow={t("eyebrow_noc_diagnostics")}
          icon={<HeartPulse size={23} />}
          title={t("nav_system_health")}
          description={t("health_subsystems_title")}
          tone={(overallStatus === "healthy" ? "healthy" : overallStatus === "degraded" ? "warning" : "danger") as PageHeaderTone}
          status={getStatusBadge(overallStatus)}
          actions={<button
            className="btn btn-outline health-mongo-refresh"
            onClick={() => void refreshSystemHealth()}
            disabled={isHealthLoading}
          >
            <RefreshCw size={14} className={isHealthLoading ? "spin" : ""} />
            {t("refresh")}
          </button>}
        />

        {healthError && systemHealth ? (
          <p className="warning-text" role="status">{t("health_refresh_stale")}</p>
        ) : null}

        <section className="health-subsystems-section" aria-labelledby="health-platform-title">
          <SectionHeader title={t("health_platform_title")} />
          <div className="health-subsystems-grid">
            <SubsystemCard
              status={worstStatus([
                probeByKey.get("api")?.status,
                platformStatus,
              ])}
              icon={<Server size={20} color="var(--primary)" />}
              name={t("health_platform_api")}
              description={systemHealth ? t("health_platform_probes", { healthy: platformHealthyCount, total: probes.length }) : t("health_status_unavailable")}
              statusBadge={getStatusBadge(worstStatus([probeByKey.get("api")?.status, platformStatus]))}
              metrics={[
                probeMetric("api"),
                {
                  label: t("health_last_check"),
                  value: systemHealth?.checkedAt ? formatDateTime(systemHealth.checkedAt) : "—",
                },
              ]}
            />

            <SubsystemCard
              status={systemHealth ? systemHealth.subsystems.database.status : "unavailable"}
              icon={<Database size={20} color="var(--primary)" />}
              name={t("health_subsystem_db")}
              description={`${systemHealth?.subsystems?.database?.xcloudDb || "xcloud"} / ${systemHealth?.subsystems?.database?.appDb || "app"}`}
              statusBadge={getStatusBadge(systemHealth?.subsystems?.database?.status ?? "unavailable")}
              metrics={[
                { label: t("health_db_latency"), value: systemHealth?.subsystems?.database?.latencyMs !== undefined ? `${systemHealth.subsystems.database.latencyMs} ms` : "—" },
                { label: t("health_db_collections"), value: systemHealth?.subsystems?.database ? `${systemHealth.subsystems.database.existingCollections} / ${systemHealth.subsystems.database.totalCollections}` : "—" },
                { label: t("health_db_indexes"), value: systemHealth?.subsystems?.database?.missingIndexesCount ?? "—", tone: (systemHealth?.subsystems?.database?.missingIndexesCount || 0) > 0 ? "danger" : "success" },
                { label: t("status"), value: systemHealth?.subsystems?.database?.ready ? t("health_status_ready") : t("health_status_attention"), tone: systemHealth?.subsystems?.database?.ready ? "success" : "danger" },
              ]}
            />

            <SubsystemCard
              status={worstStatus([
                probeByKey.get("discovery_scheduler")?.status,
                probeByKey.get("nf_health_scheduler")?.status,
                probeByKey.get("notification_worker")?.status,
              ])}
              icon={<Activity size={20} color="var(--primary)" />}
              name={t("health_platform_jobs")}
              description={t("health_platform_jobs_hint")}
              statusBadge={getStatusBadge(worstStatus([
                probeByKey.get("discovery_scheduler")?.status,
                probeByKey.get("nf_health_scheduler")?.status,
                probeByKey.get("notification_worker")?.status,
              ]))}
              metrics={[
                probeMetric("discovery_scheduler"),
                probeMetric("nf_health_scheduler"),
                probeMetric("notification_worker"),
              ]}
            />

            <SubsystemCard
              status={worstStatus([
                probeByKey.get("knowledge_storage")?.status,
                probeByKey.get("log_sources")?.status,
              ])}
              icon={<Layers size={20} color="var(--primary)" />}
              name={t("health_platform_storage")}
              description={t("health_platform_storage_hint")}
              statusBadge={getStatusBadge(worstStatus([
                probeByKey.get("knowledge_storage")?.status,
                probeByKey.get("log_sources")?.status,
              ]))}
              metrics={[
                probeMetric("knowledge_storage"),
                probeMetric("log_sources"),
              ]}
            />
          </div>
        </section>

        <section className="health-subsystems-section" aria-labelledby="health-data-title">
          <SectionHeader title={t("health_data_consistency_title")} />
          <div className="health-subsystems-grid">
            <SubsystemCard
              status={systemHealth?.subsystems.ocsEngine.status ?? "unavailable"}
              icon={<Zap size={20} color="var(--primary)" />}
              name={t("health_subsystem_ocs")}
              description={t("health_desc_ocs")}
              statusBadge={getStatusBadge(systemHealth?.subsystems.ocsEngine.status ?? "unavailable")}
              metrics={[
                { label: t("health_ocs_invariants"), value: systemHealth?.subsystems.ocsEngine.invariantsOk ? t("health_status_ok") : t("health_status_broken", { count: systemHealth?.subsystems.ocsEngine.brokenInvariantsCount || 0 }), tone: systemHealth?.subsystems.ocsEngine.invariantsOk ? "success" : "danger" },
                { label: t("health_ocs_sessions"), value: systemHealth?.subsystems.ocsEngine.activeSessions ?? "—" },
                { label: t("health_ocs_reservations"), value: systemHealth?.subsystems.ocsEngine.activeReservations ?? "—" },
                { label: t("health_ocs_tariff_plans"), value: systemHealth?.subsystems.ocsEngine.activeTariffPlans ?? "—" },
              ]}
            />

            <SubsystemCard
              status={systemHealth?.subsystems.hssCore.status ?? "unavailable"}
              icon={<Layers size={20} color="var(--primary)" />}
              name={t("health_subsystem_hss")}
              description={t("health_desc_hss")}
              statusBadge={getStatusBadge(systemHealth?.subsystems.hssCore.status ?? "unavailable")}
              metrics={[
                { label: t("health_hss_auth_credentials"), value: (systemHealth?.subsystems.hssCore.missingCredentialsCount || 0) > 0 ? t("health_status_invalid", { count: systemHealth?.subsystems.hssCore.missingCredentialsCount || 0 }) : t("health_status_ok"), tone: (systemHealth?.subsystems.hssCore.missingCredentialsCount || 0) > 0 ? "danger" : "success" },
                { label: t("health_hss_slice_routing"), value: (systemHealth?.subsystems.hssCore.missingSlicesCount || 0) > 0 ? t("health_status_missing", { count: systemHealth?.subsystems.hssCore.missingSlicesCount || 0 }) : t("health_status_optimal"), tone: (systemHealth?.subsystems.hssCore.missingSlicesCount || 0) > 0 ? "danger" : "success" },
                { label: t("health_hss_dangling_profiles"), value: systemHealth?.subsystems.hssCore.danglingProfilesCount ?? "—", tone: (systemHealth?.subsystems.hssCore.danglingProfilesCount || 0) > 0 ? "warning" : "success" },
                { label: t("profiles_title"), value: systemHealth?.subsystems.hssCore.activeProfilesCount ?? "—" },
              ]}
            />

            <SubsystemCard
              status={systemHealth?.subsystems.security.status ?? "unavailable"}
              icon={<ShieldCheck size={20} color="var(--primary)" />}
              name={t("health_subsystem_security")}
              description={t("health_desc_sec")}
              statusBadge={getStatusBadge(systemHealth?.subsystems.security.status ?? "unavailable")}
              metrics={[
                { label: t("health_sec_root"), value: systemHealth?.subsystems.security.rootUserConfigured ? t("health_status_active") : t("health_status_missing", { count: 1 }), tone: systemHealth?.subsystems.security.rootUserConfigured ? "success" : "danger" },
                { label: t("health_sec_alerts"), value: systemHealth?.subsystems.security.unacknowledgedAlertsCount ?? "—", tone: (systemHealth?.subsystems.security.criticalAlertsCount || 0) > 0 ? "danger" : "success" },
                { label: t("users_title"), value: systemHealth?.subsystems.security.activeUsersCount ?? "—" },
              ]}
            />
          </div>
        </section>

        {systemHealth?.summary?.recommendations && systemHealth.summary.recommendations.length > 0 && (
          <div className="health-recommendations-banner">
            <AlertTriangle className="health-rec-icon" size={22} />
            <div className="health-rec-content">
              <div className="health-rec-title">{t("health_recommendations_title")}</div>
              <ul className="health-rec-list">
                {systemHealth.summary.recommendations.map((recommendation, index) => (
                  <li key={index}>{renderRecommendation(recommendation)}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <MetricStrip
          variant="strip"
          ariaLabel={t("nav_system_health")}
          items={[
            {
              key: "probes",
              label: t("health_platform_probes"),
              value: systemHealth ? `${platformHealthyCount}/${probes.length}` : "—",
              tone: platformStatus === "healthy" ? "success" : platformStatus === "degraded" ? "warning" : "danger",
              icon: <Server size={20} />,
            },
            {
              key: "anomalies",
              label: t("health_active_anomalies"),
              value: systemHealth?.summary.totalAnomaliesDetected ?? "—",
              icon: <ShieldAlert size={20} />,
            },
            {
              key: "checked",
              label: t("health_last_check"),
              value: systemHealth?.checkedAt ? formatDateTime(systemHealth.checkedAt) : "—",
              tone: "muted",
              compactValue: true,
              icon: <Activity size={20} />,
            },
            {
              key: "heal",
              label: t("health_heal_state"),
              value: t("health_heal_disabled_value"),
              tone: "muted",
              icon: <ShieldCheck size={20} />,
            },
          ]}
        />

        <div className="health-control-strip">
          <div className="health-control-status">
            <div className="health-control-text">
              <Activity size={20} color="var(--primary)" />
              <span className={`health-control-msg ${isAuditing ? "health-control-msg-active" : "health-control-msg-idle"}`}>
                {auditPhase === "IDLE" && t("health_idle_msg")}
                {auditPhase === "INIT" && t("health_scan_init")}
                {auditPhase === "SCAN_SUB" && t("health_scan_progress", { phase: "HSS", total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === "SCAN_OCS" && t("health_scan_progress", { phase: "OCS", total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === "SCAN_TARIFF" && t("health_scan_progress", { phase: "TARIFF", total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === "SCAN_RESERVATIONS" && t("health_scan_progress", { phase: "RESERVATION", total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === "COMPLETE" && t("health_scan_complete", { total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === "ABORTED" && t("health_scan_abort")}
              </span>
            </div>
            {isAuditing && <div className="progress-bar-container health-progress-bar"><div className="progress-bar-value" /></div>}
          </div>
          <div className="health-control-actions">
            {canScan ? (
              <button className="btn btn-primary health-btn-run" onClick={() => void runFullAudit()} disabled={isAuditing}>
                {isAuditing ? <span className="spinner health-spinner" /> : <Database size={16} />}
                {isAuditing ? t("health_btn_scanning") : t("health_btn_run")}
              </button>
            ) : (
              <span className="health-control-msg health-control-msg-idle">{t("health_scan_readonly")}</span>
            )}
          </div>
        </div>

        <div className="dash-card">
          <div className="health-anomalies-header">
            <div className="health-anomalies-title-group">
              <h2 className="health-anomalies-title">{t("health_anomalies_detected")}</h2>
              <span className="health-anomalies-badge-count">{filteredAnomalies.length} / {anomalies.length}</span>
            </div>

            <div className="health-filter-tabs">
              {([
                ["all", "health_tab_all"],
                ["hss", "health_tab_hss"],
                ["ocs", "health_tab_ocs"],
                ["reservation", "health_tab_reservation"],
                ["tariff", "health_tab_tariff"],
                ["profile", "health_tab_profile"],
              ] as const).map(([value, key]) => (
                <button
                  key={value}
                  type="button"
                  className={`health-tab-btn ${activeCategoryTab === value ? "active" : ""}`}
                  onClick={() => setActiveCategoryTab(value)}
                >
                  {t(key)}
                </button>
              ))}
            </div>

            <div className="health-anomalies-toolbar">
              <select
                className="health-severity-select"
                aria-label={t("health_anomalies_detected")}
                value={selectedSeverity}
                onChange={(event) => setSelectedSeverity(event.target.value as AnomalySeverity | "all")}
              >
                <option value="all">{t("health_filter_all_severities")}</option>
                <option value="critical">{t("health_severity_critical")}</option>
                <option value="warning">{t("health_severity_warning")}</option>
                <option value="info">{t("health_severity_info")}</option>
              </select>

              <button
                type="button"
                className="btn btn-outline health-btn-export"
                onClick={exportDiagnosticReport}
                title={t("health_btn_export_report")}
              >
                <Download size={14} />
                {t("export")}
              </button>
            </div>
          </div>

          {isAuditing && anomalies.length === 0 ? (
            <LoadingRows columns={5} rows={4} />
          ) : filteredAnomalies.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert size={48} />}
              title={t("health_no_anomalies")}
              description={auditPhase === "IDLE" ? t("health_empty_idle_desc") : t("health_empty_complete_desc")}
              action={auditPhase === "IDLE" && canScan ? (
                <button type="button" className="btn btn-primary" onClick={() => void runFullAudit()}>
                  <Database size={16} /> {t("health_btn_run")}
                </button>
              ) : undefined}
            />
          ) : (
            <div className="health-table-wrap">
              <table className="health-table">
                <caption className="sr-only">{t("health_anomalies_detected")}</caption>
                <thead className="health-table-thead">
                  <tr>
                    <th className="health-table-th" data-column-priority="essential">{t("health_col_imsi")}</th>
                    <th className="health-table-th" data-column-priority="essential">{t("health_filter_severity")}</th>
                    <th className="health-table-th" data-column-priority="supplementary">{t("health_col_type")}</th>
                    <th className="health-table-th" data-column-priority="essential">{t("health_col_details")}</th>
                    <th className="health-table-th-right" data-column-priority="essential">{t("health_col_action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAnomalies.map((anomaly, index) => (
                    <tr key={`${anomaly.imsi}-${anomaly.type}-${index}`} className="health-table-tr">
                      <td className="health-table-td-imsi" data-label={t("health_col_imsi")} data-column-priority="essential">{anomaly.imsi}</td>
                      <td className="health-table-td" data-label={t("health_filter_severity")} data-column-priority="essential">
                        <span className={`health-severity-tag ${anomaly.severity || "warning"}`}>
                          {anomaly.severity === "critical" ? <ShieldAlert size={12} /> : anomaly.severity === "info" ? <Info size={12} /> : <AlertTriangle size={12} />}
                          {t(`health_severity_${anomaly.severity || "warning"}`)}
                        </span>
                      </td>
                      <td className="health-table-td" data-label={t("health_col_type")} data-column-priority="supplementary">
                        <span className="health-category-pill">{anomaly.type}</span>
                      </td>
                      <td className="health-table-td-details" data-label={t("health_col_details")} data-column-priority="essential">{renderDetails(anomaly.details, anomaly.type)}</td>
                      <td className="health-table-td-actions" data-label={t("health_col_action")} data-column-priority="essential">
                        <AnomalyLink anomaly={anomaly} t={t} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="footnote">{t("health_readonly_notice")}</p>
        </div>
      </div>
    </>
  );
}

function AnomalyLink({ anomaly, t }: { anomaly: SystemAnomaly; t: (key: string) => string }) {
  if (!/^\d{15}$/.test(anomaly.imsi)) {
    return <span className="chip-muted">{t("health_anomaly_no_link")}</span>;
  }
  if (anomaly.category === "hss" || anomaly.category === "profile") {
    return <Link className="btn btn-outline health-btn-view" to={`/subscribers/${encodeURIComponent(anomaly.imsi)}`}>{t("health_anomaly_view_subscriber")}</Link>;
  }
  if (anomaly.category === "ocs" || anomaly.category === "tariff" || anomaly.category === "reservation") {
    return <Link className="btn btn-outline health-btn-view" to={`/ocs/contracts/${encodeURIComponent(anomaly.imsi)}`}>{t("health_anomaly_view_contract")}</Link>;
  }
  return <span className="chip-muted">{t("health_anomaly_no_link")}</span>;
}

export default SystemHealthPage;
