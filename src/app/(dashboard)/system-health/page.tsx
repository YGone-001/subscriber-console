"use client";

import { useState, useRef, useMemo } from "react";
import {
  Activity,
  ShieldAlert,
  HeartPulse,
  HardDrive,
  Database,
  Check,
  RefreshCw,
  Zap,
  Layers,
  ShieldCheck,
  Download,
  Wrench,
  AlertTriangle,
  Info,
} from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";
import type { ComprehensiveSystemHealth, SubsystemStatus } from "@/server/repositories/systemHealthRepository";
import type { SystemAnomaly, AnomalyCategory, AnomalySeverity } from "@/server/repositories/systemAuditRepository";
import "./system-health.css";
import PageHeader, { type PageHeaderTone } from "@/components/ui/PageHeader";
import SectionHeader from "@/components/ui/SectionHeader";
import { Dialog } from "@/components/ui/Dialog";

type HealthNotice = {
  type: "success" | "error" | "warning";
  text: string;
};

type ScanPhase = 'IDLE' | 'INIT' | 'SCAN_SUB' | 'SCAN_OCS' | 'SCAN_TARIFF' | 'SCAN_RESERVATIONS' | 'COMPLETE' | 'ABORTED';

export default function SystemHealthPage() {
  const { t } = useI18n();
  const { data: profileData } = useSWR("/api/profiles", fetcher);
  const profileList = profileData?.profiles || [];

  const { data: statusData, mutate: mutateStatus } = useSWR("/api/system/audit/status", fetcher, { refreshInterval: 60000 });
  const lastSaveTime = statusData?.lastSaveTime || null;

  // Comprehensive Multi-Subsystem Health
  const {
    data: systemHealth,
    mutate: refreshSystemHealth,
    isLoading: isHealthLoading,
  } = useSWR<ComprehensiveSystemHealth>("/api/system/health", fetcher, { refreshInterval: 30000 });

  // Scan states
  const [isAuditing, setIsAuditing] = useState(false);
  const [scannedTotal, setScannedTotal] = useState(0);
  const [anomalies, setAnomalies] = useState<SystemAnomaly[]>([]);
  const [auditPhase, setAuditPhase] = useState<ScanPhase>('IDLE');
  const [notice, setNotice] = useState<HealthNotice | null>(null);

  // Filtering states
  const [activeCategoryTab, setActiveCategoryTab] = useState<AnomalyCategory | 'all'>('all');
  const [selectedSeverity, setSelectedSeverity] = useState<AnomalySeverity | 'all'>('all');

  // Single Heal Modal states
  const [healModalOpen, setHealModalOpen] = useState(false);
  const [targetAnomaly, setTargetAnomaly] = useState<SystemAnomaly | null>(null);
  const [healProfile, setHealProfile] = useState("");
  const [isHealConfirmed, setIsHealConfirmed] = useState(false);
  const [isHealing, setIsHealing] = useState(false);

  // Batch Heal Modal states
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchHealProfile, setBatchHealProfile] = useState("");
  const [isBatchConfirmed, setIsBatchConfirmed] = useState(false);
  const [isBatchHealing, setIsBatchHealing] = useState(false);

  // Use refs for aggressive recursion logic without stale states
  const scanMetrics = useRef({ total: 0, anomaliesList: [] as SystemAnomaly[] });

  const runFullAudit = async () => {
    setIsAuditing(true);
    setNotice(null);
    setAnomalies([]);
    setScannedTotal(0);
    setAuditPhase('INIT');
    scanMetrics.current = { total: 0, anomaliesList: [] };

    // Start 4-phase recursion pipeline
    await recursiveScan('0', 'sub');
  };

  const recursiveScan = async (cursor: string, phase: 'sub' | 'ocs' | 'tariff' | 'reservation') => {
    try {
      if (cursor === '0') {
        if (phase === 'sub') setAuditPhase('SCAN_SUB');
        else if (phase === 'ocs') setAuditPhase('SCAN_OCS');
        else if (phase === 'tariff') setAuditPhase('SCAN_TARIFF');
        else if (phase === 'reservation') setAuditPhase('SCAN_RESERVATIONS');
      }

      const res = await fetch("/api/system/audit/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cursor, phase })
      });

      if (!res.ok) throw new Error("Scan API failure");
      const data = await res.json();

      scanMetrics.current.total += data.scannedCount;
      if (data.anomalies && data.anomalies.length > 0) {
        scanMetrics.current.anomaliesList = [...scanMetrics.current.anomaliesList, ...data.anomalies];
      }

      setScannedTotal(scanMetrics.current.total);
      setAnomalies([...scanMetrics.current.anomaliesList]);

      const newNext = String(data.nextCursor);

      if (newNext !== '0') {
        // Recursive continuation in same phase
        await recursiveScan(newNext, phase);
      } else {
        // Switch phase or complete
        if (phase === 'sub') {
          await recursiveScan('0', 'ocs');
        } else if (phase === 'ocs') {
          await recursiveScan('0', 'tariff');
        } else if (phase === 'tariff') {
          await recursiveScan('0', 'reservation');
        } else {
          setAuditPhase('COMPLETE');
          setIsAuditing(false);
          await refreshSystemHealth();
        }
      }
    } catch {
      setIsAuditing(false);
      setAuditPhase('ABORTED');
      setNotice({ type: "error", text: t("health_scan_abort") });
    }
  };

  // Filtered anomalies list
  const filteredAnomalies = useMemo(() => {
    return anomalies.filter((a) => {
      if (activeCategoryTab !== 'all' && a.category !== activeCategoryTab) return false;
      if (selectedSeverity !== 'all' && a.severity !== selectedSeverity) return false;
      return true;
    });
  }, [anomalies, activeCategoryTab, selectedSeverity]);

  // Single Item Heal handlers
  const handleOpenHealModal = (anomaly: SystemAnomaly) => {
    setTargetAnomaly(anomaly);
    setIsHealConfirmed(false);
    setHealProfile("");
    setNotice(null);
    setHealModalOpen(true);
  };

  const executeHeal = async () => {
    if (!targetAnomaly || !isHealConfirmed) return;
    setIsHealing(true);

    try {
      const res = await fetch("/api/system/audit/heal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imsi: targetAnomaly.imsi,
          type: targetAnomaly.type,
          profileName: healProfile || undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.approval?.id) {
          setNotice({ type: "success", text: t("approval_msg_submitted", { id: data.approval.id }) });
          setHealModalOpen(false);
          return;
        }

        const updatedList = anomalies.filter(
          (a) => a.imsi !== targetAnomaly.imsi || a.type !== targetAnomaly.type
        );
        setAnomalies(updatedList);
        await mutateStatus();
        await refreshSystemHealth();
        scanMetrics.current.anomaliesList = updatedList;
        setNotice({ type: "success", text: t("health_msg_heal_success", { imsi: targetAnomaly.imsi }) });
        setHealModalOpen(false);
      } else {
        setNotice({ type: "error", text: t("health_err_heal_backend") });
      }
    } catch {
      setNotice({ type: "error", text: t("health_err_heal_net") });
    } finally {
      setIsHealing(false);
    }
  };

  // Batch Heal handlers
  const handleOpenBatchModal = () => {
    setIsBatchConfirmed(false);
    setBatchHealProfile("");
    setNotice(null);
    setBatchModalOpen(true);
  };

  const executeBatchHeal = async () => {
    if (filteredAnomalies.length === 0 || !isBatchConfirmed) return;
    setIsBatchHealing(true);

    try {
      const res = await fetch("/api/system/audit/batch-heal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anomalies: filteredAnomalies.map((a) => ({ imsi: a.imsi, type: a.type })),
          profileName: batchHealProfile || undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.approval?.id) {
          setNotice({ type: "success", text: t("approval_msg_submitted", { id: data.approval.id }) });
          setBatchModalOpen(false);
          return;
        }

        const remainingAnomalies = anomalies.filter(
          (a) => !filteredAnomalies.some((fa) => fa.imsi === a.imsi && fa.type === a.type)
        );
        setAnomalies(remainingAnomalies);
        await mutateStatus();
        await refreshSystemHealth();
        scanMetrics.current.anomaliesList = remainingAnomalies;
        setNotice({
          type: "success",
          text: t("health_msg_batch_heal_success", { count: data.successCount || filteredAnomalies.length }),
        });
        setBatchModalOpen(false);
      } else {
        setNotice({ type: "error", text: t("health_err_heal_backend") });
      }
    } catch {
      setNotice({ type: "error", text: t("health_err_heal_net") });
    } finally {
      setIsBatchHealing(false);
    }
  };

  // Export diagnostic report snapshot
  const exportDiagnosticReport = () => {
    const reportData = {
      timestamp: new Date().toISOString(),
      score: systemHealth?.score ?? 100,
      status: systemHealth?.status ?? 'healthy',
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
    const a = document.createElement("a");
    a.href = url;
    a.download = `system-health-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Health Score Calculation
  const displayScore = useMemo(() => {
    if (systemHealth?.score !== undefined) {
      if (auditPhase === 'COMPLETE' && scannedTotal > 0) {
        const auditImpact = Math.max(0, (1 - anomalies.length / scannedTotal) * 100);
        return Math.min(systemHealth.score, parseFloat(auditImpact.toFixed(1)));
      }
      return systemHealth.score;
    }
    if (scannedTotal === 0) return 100;
    const h = (1 - (anomalies.length / scannedTotal)) * 100;
    return Math.max(0, parseFloat(h.toFixed(1)));
  }, [systemHealth, auditPhase, scannedTotal, anomalies.length]);

  const renderDetails = (details: string, type: string) => {
    if (type === 'orphan_reservation') return t("health_err_orphan_reservation");
    if (type === 'invalid_tariff') return t("health_err_invalid_tariff");
    if (type === 'dangling_profile') return t("health_err_dangling_profile");
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

  const getStatusBadge = (status: SubsystemStatus = 'healthy') => {
    if (status === 'healthy') return <span className="subsystem-badge healthy"><Check size={12} /> {t("health_status_healthy")}</span>;
    if (status === 'degraded') return <span className="subsystem-badge degraded"><AlertTriangle size={12} /> {t("health_status_degraded")}</span>;
    return <span className="subsystem-badge critical"><ShieldAlert size={12} /> {t("health_status_critical")}</span>;
  };

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
          eyebrow="NOC / DIAGNOSTICS"
          icon={<HeartPulse size={23} />}
          title={t("nav_system_health")}
          description={t("health_subsystems_title")}
          tone={(systemHealth?.status === "critical" ? "danger" : systemHealth?.status === "degraded" ? "warning" : "healthy") as PageHeaderTone}
          status={getStatusBadge(systemHealth?.status)}
          actions={<button
            className="btn btn-outline health-mongo-refresh"
            onClick={() => refreshSystemHealth()}
            disabled={isHealthLoading}
          >
            <RefreshCw size={14} className={isHealthLoading ? "spin" : ""} />
            {t("refresh")}
          </button>}
        />

        {/* Subsystems Matrix Section */}
        <section className="health-subsystems-section">
          <SectionHeader title={t("health_subsystems_title")} />

          <div className="health-subsystems-grid">
            {/* 1. Database Subsystem */}
            <div className={`subsystem-card ${systemHealth?.subsystems?.database?.status || 'healthy'}`}>
              <div>
                <div className="subsystem-header">
                  <div className="subsystem-title-box">
                    <div className="subsystem-icon-wrap">
                      <Database size={20} color="var(--primary)" />
                    </div>
                    <div>
                      <h3 className="subsystem-name">{t("health_subsystem_db")}</h3>
                      <div className="subsystem-desc">
                        {systemHealth?.subsystems?.database?.open5gsDb || 'open5gs'} / {systemHealth?.subsystems?.database?.appDb || 'app'}
                      </div>
                    </div>
                  </div>
                  {getStatusBadge(systemHealth?.subsystems?.database?.status)}
                </div>

                <div className="subsystem-metrics-grid">
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_db_latency")}</div>
                    <div className="subsystem-metric-val">
                      {systemHealth?.subsystems?.database?.latencyMs !== undefined ? `${systemHealth.subsystems.database.latencyMs} ms` : '--'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_db_collections")}</div>
                    <div className="subsystem-metric-val">
                      {systemHealth?.subsystems?.database ? `${systemHealth.subsystems.database.existingCollections} / ${systemHealth.subsystems.database.totalCollections}` : '--'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_db_indexes")}</div>
                    <div className={`subsystem-metric-val ${(systemHealth?.subsystems?.database?.missingIndexesCount || 0) > 0 ? 'danger' : 'success'}`}>
                      {systemHealth?.subsystems?.database?.missingIndexesCount ?? '--'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("status")}</div>
                    <div className={`subsystem-metric-val ${systemHealth?.subsystems?.database?.ready ? 'success' : 'danger'}`}>
                      {systemHealth?.subsystems?.database?.ready ? 'Ready' : 'Attention'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 2. OCS Engine Subsystem */}
            <div className={`subsystem-card ${systemHealth?.subsystems?.ocsEngine?.status || 'healthy'}`}>
              <div>
                <div className="subsystem-header">
                  <div className="subsystem-title-box">
                    <div className="subsystem-icon-wrap">
                      <Zap size={20} color="var(--chart-4)" />
                    </div>
                    <div>
                      <h3 className="subsystem-name">{t("health_subsystem_ocs")}</h3>
                      <div className="subsystem-desc">Online Charging & Balances</div>
                    </div>
                  </div>
                  {getStatusBadge(systemHealth?.subsystems?.ocsEngine?.status)}
                </div>

                <div className="subsystem-metrics-grid">
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_ocs_invariants")}</div>
                    <div className={`subsystem-metric-val ${systemHealth?.subsystems?.ocsEngine?.invariantsOk ? 'success' : 'danger'}`}>
                      {systemHealth?.subsystems?.ocsEngine?.invariantsOk ? '100% OK' : `${systemHealth?.subsystems?.ocsEngine?.brokenInvariantsCount || 0} Broken`}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_ocs_sessions")}</div>
                    <div className="subsystem-metric-val">
                      {systemHealth?.subsystems?.ocsEngine?.activeSessions ?? '--'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_ocs_reservations")}</div>
                    <div className="subsystem-metric-val">
                      {systemHealth?.subsystems?.ocsEngine?.activeReservations ?? '--'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_ocs_tariff_plans")}</div>
                    <div className="subsystem-metric-val">
                      {systemHealth?.subsystems?.ocsEngine?.activeTariffPlans ?? '--'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 3. HSS Core Subsystem */}
            <div className={`subsystem-card ${systemHealth?.subsystems?.hssCore?.status || 'healthy'}`}>
              <div>
                <div className="subsystem-header">
                  <div className="subsystem-title-box">
                    <div className="subsystem-icon-wrap">
                      <Layers size={20} color="var(--chart-3)" />
                    </div>
                    <div>
                      <h3 className="subsystem-name">{t("health_subsystem_hss")}</h3>
                      <div className="subsystem-desc">Subscriber Schemas & Slices</div>
                    </div>
                  </div>
                  {getStatusBadge(systemHealth?.subsystems?.hssCore?.status)}
                </div>

                <div className="subsystem-metrics-grid">
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_hss_auth_credentials")}</div>
                    <div className={`subsystem-metric-val ${(systemHealth?.subsystems?.hssCore?.missingCredentialsCount || 0) > 0 ? 'danger' : 'success'}`}>
                      {(systemHealth?.subsystems?.hssCore?.missingCredentialsCount || 0) > 0 ? `${systemHealth?.subsystems?.hssCore?.missingCredentialsCount} Invalid` : '100% OK'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_hss_slice_routing")}</div>
                    <div className={`subsystem-metric-val ${(systemHealth?.subsystems?.hssCore?.missingSlicesCount || 0) > 0 ? 'danger' : 'success'}`}>
                      {(systemHealth?.subsystems?.hssCore?.missingSlicesCount || 0) > 0 ? `${systemHealth?.subsystems?.hssCore?.missingSlicesCount} Missing` : 'Optimal'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_hss_dangling_profiles")}</div>
                    <div className={`subsystem-metric-val ${(systemHealth?.subsystems?.hssCore?.danglingProfilesCount || 0) > 0 ? 'warning' : 'success'}`}>
                      {systemHealth?.subsystems?.hssCore?.danglingProfilesCount ?? '--'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("profiles_title")}</div>
                    <div className="subsystem-metric-val">
                      {systemHealth?.subsystems?.hssCore?.activeProfilesCount ?? '--'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 4. Security Subsystem */}
            <div className={`subsystem-card ${systemHealth?.subsystems?.security?.status || 'healthy'}`}>
              <div>
                <div className="subsystem-header">
                  <div className="subsystem-title-box">
                    <div className="subsystem-icon-wrap">
                      <ShieldCheck size={20} color="var(--chart-5)" />
                    </div>
                    <div>
                      <h3 className="subsystem-name">{t("health_subsystem_security")}</h3>
                      <div className="subsystem-desc">RBAC & Operational Alarms</div>
                    </div>
                  </div>
                  {getStatusBadge(systemHealth?.subsystems?.security?.status)}
                </div>

                <div className="subsystem-metrics-grid">
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_sec_root")}</div>
                    <div className={`subsystem-metric-val ${systemHealth?.subsystems?.security?.rootUserConfigured ? 'success' : 'danger'}`}>
                      {systemHealth?.subsystems?.security?.rootUserConfigured ? 'Active' : 'Missing'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_sec_alerts")}</div>
                    <div className={`subsystem-metric-val ${(systemHealth?.subsystems?.security?.criticalAlertsCount || 0) > 0 ? 'danger' : 'success'}`}>
                      {systemHealth?.subsystems?.security?.unacknowledgedAlertsCount ?? '--'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("health_sec_approvals")}</div>
                    <div className="subsystem-metric-val">
                      {systemHealth?.subsystems?.security?.pendingApprovalsCount ?? '--'}
                    </div>
                  </div>
                  <div className="subsystem-metric-item">
                    <div className="subsystem-metric-label">{t("users_title")}</div>
                    <div className="subsystem-metric-val">
                      {systemHealth?.subsystems?.security?.activeUsersCount ?? '--'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Actionable Recommendations Banner */}
        {systemHealth?.summary?.recommendations && systemHealth.summary.recommendations.length > 0 && (
          <div className="health-recommendations-banner">
            <AlertTriangle className="health-rec-icon" size={22} />
            <div className="health-rec-content">
              <div className="health-rec-title">{t("health_recommendations_title")}</div>
              <ul className="health-rec-list">
                {systemHealth.summary.recommendations.map((rec, i) => (
                  <li key={i}>{rec}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Composite KPI Board */}
        <div className="health-kpi-grid">
          <div className={`dash-card shadow health-kpi-card ${displayScore < 90 ? 'health-kpi-card-danger' : 'health-kpi-card-success'}`}>
            <div className="health-kpi-inner">
              <div>
                <div className="health-kpi-label">{t("health_overall_score")}</div>
                <div className={displayScore < 90 ? "health-kpi-value-danger" : "health-kpi-value"}>
                  {auditPhase === 'INIT' ? '--' : `${displayScore}%`}
                </div>
              </div>
              <HeartPulse size={32} color="var(--icon-muted)" />
            </div>
          </div>

          <div className="dash-card shadow health-kpi-card health-kpi-card-primary">
            <div className="health-kpi-inner">
              <div>
                <div className="health-kpi-label">{t("health_active_anomalies")}</div>
                <div className="health-kpi-value">{anomalies.length}</div>
              </div>
              <ShieldAlert size={32} color="var(--icon-muted)" />
            </div>
          </div>

          <div className="dash-card shadow health-kpi-card health-kpi-card-warning">
            <div className="health-kpi-inner">
              <div>
                <div className="health-kpi-label">{t("health_last_bgsave")}</div>
                <div className="health-kpi-value-small">
                  {lastSaveTime ? new Date(lastSaveTime * 1000).toLocaleString() : t("health_loading")}
                </div>
              </div>
              <HardDrive size={32} color="var(--icon-muted)" />
            </div>
          </div>

          <div className="dash-card shadow health-kpi-card health-kpi-card-primary">
            <div className="health-kpi-inner">
              <div>
                <div className="health-kpi-label">{t("health_db_latency")}</div>
                <div className="health-kpi-value-small">
                  {systemHealth?.subsystems?.database?.latencyMs !== undefined ? `${systemHealth.subsystems.database.latencyMs} ms` : '--'}
                </div>
              </div>
              <Activity size={32} color="var(--icon-muted)" />
            </div>
          </div>
        </div>

        {/* Multi-Phase Control Strip */}
        <div className="health-control-strip">
          <div className="health-control-status">
            <div className="health-control-text">
              <Activity size={20} color="var(--primary)" />
              <span className={`health-control-msg ${isAuditing ? 'health-control-msg-active' : 'health-control-msg-idle'}`}>
                {auditPhase === 'IDLE' && t("health_idle_msg")}
                {auditPhase === 'INIT' && t("health_scan_init")}
                {auditPhase === 'SCAN_SUB' && t("health_scan_progress", { phase: 'HSS', total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === 'SCAN_OCS' && t("health_scan_progress", { phase: 'OCS', total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === 'SCAN_TARIFF' && t("health_scan_progress", { phase: 'TARIFF', total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === 'SCAN_RESERVATIONS' && t("health_scan_progress", { phase: 'RESERVATION', total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === 'COMPLETE' && t("health_scan_complete", { total: String(scannedTotal), anomalies: String(anomalies.length) })}
                {auditPhase === 'ABORTED' && t("health_scan_abort")}
              </span>
            </div>
            {isAuditing && (
              <div className="progress-bar-container health-progress-bar">
                <div className="progress-bar-value" />
              </div>
            )}
          </div>
          <div className="health-control-actions">
            <button
              className="btn btn-primary health-btn-run"
              onClick={runFullAudit}
              disabled={isAuditing}
            >
              {isAuditing ? <span className="spinner health-spinner" /> : <Database size={16}/>}
              {isAuditing ? t("health_btn_scanning") : t("health_btn_run")}
            </button>
          </div>
        </div>

        {/* Anomalies Table & Diagnostic Toolbar */}
        <div className="health-anomalies-card">
          <div className="health-anomalies-header">
            <div className="health-anomalies-title-group">
              <h2 className="health-anomalies-title">{t("health_anomalies_detected")}</h2>
              <span className="health-anomalies-badge-count">{filteredAnomalies.length} / {anomalies.length}</span>
            </div>

            {/* Category Filter Tabs */}
            <div className="health-filter-tabs">
              <button
                type="button"
                className={`health-tab-btn ${activeCategoryTab === 'all' ? 'active' : ''}`}
                onClick={() => setActiveCategoryTab('all')}
              >
                {t("health_tab_all")}
              </button>
              <button
                type="button"
                className={`health-tab-btn ${activeCategoryTab === 'hss' ? 'active' : ''}`}
                onClick={() => setActiveCategoryTab('hss')}
              >
                {t("health_tab_hss")}
              </button>
              <button
                type="button"
                className={`health-tab-btn ${activeCategoryTab === 'ocs' ? 'active' : ''}`}
                onClick={() => setActiveCategoryTab('ocs')}
              >
                {t("health_tab_ocs")}
              </button>
              <button
                type="button"
                className={`health-tab-btn ${activeCategoryTab === 'reservation' ? 'active' : ''}`}
                onClick={() => setActiveCategoryTab('reservation')}
              >
                {t("health_tab_reservation")}
              </button>
              <button
                type="button"
                className={`health-tab-btn ${activeCategoryTab === 'tariff' ? 'active' : ''}`}
                onClick={() => setActiveCategoryTab('tariff')}
              >
                {t("health_tab_tariff")}
              </button>
              <button
                type="button"
                className={`health-tab-btn ${activeCategoryTab === 'profile' ? 'active' : ''}`}
                onClick={() => setActiveCategoryTab('profile')}
              >
                {t("health_tab_profile")}
              </button>
            </div>

            {/* Severity and Actions Toolbar */}
            <div className="health-anomalies-toolbar">
              <select
                className="health-severity-select"
                value={selectedSeverity}
                onChange={(e) => setSelectedSeverity(e.target.value as any)}
              >
                <option value="all">{t("health_filter_all_severities")}</option>
                <option value="critical">{t("health_severity_critical")}</option>
                <option value="warning">{t("health_severity_warning")}</option>
                <option value="info">{t("health_severity_info")}</option>
              </select>

              {filteredAnomalies.length > 0 && (
                <button
                  type="button"
                  className="btn btn-primary health-btn-batch"
                  onClick={handleOpenBatchModal}
                  disabled={isAuditing}
                >
                  <Wrench size={14} />
                  {t("health_btn_batch_heal")}
                </button>
              )}

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
              action={
                auditPhase === "IDLE" ? (
                  <button type="button" className="btn btn-primary" onClick={runFullAudit}>
                    <Database size={16} /> {t("health_btn_run")}
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="health-table-wrap">
              <table className="health-table">
                <caption className="sr-only">{t("health_anomalies_detected")}</caption>
                <thead className="health-table-thead">
                  <tr>
                    <th className="health-table-th">{t("health_col_imsi")}</th>
                    <th className="health-table-th">{t("health_filter_severity")}</th>
                    <th className="health-table-th">{t("health_col_type")}</th>
                    <th className="health-table-th">{t("health_col_details")}</th>
                    <th className="health-table-th-right">{t("health_col_action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAnomalies.map((a, idx) => (
                    <tr key={`${a.imsi}-${a.type}-${idx}`} className="health-table-tr">
                      <td className="health-table-td-imsi" data-label={t("health_col_imsi")}>{a.imsi}</td>
                      <td className="health-table-td" data-label={t("health_filter_severity")}>
                        <span className={`health-severity-tag ${a.severity || 'warning'}`}>
                          {a.severity === 'critical' ? <ShieldAlert size={12} /> : a.severity === 'info' ? <Info size={12} /> : <AlertTriangle size={12} />}
                          {t(`health_severity_${a.severity || 'warning'}`)}
                        </span>
                      </td>
                      <td className="health-table-td" data-label={t("health_col_type")}>
                        <span className="health-category-pill">
                          {a.type}
                        </span>
                      </td>
                      <td className="health-table-td-details" data-label={t("health_col_details")}>{renderDetails(a.details, a.type)}</td>
                      <td className="health-table-td-actions" data-label={t("health_col_action")}>
                        <button
                          className="btn btn-outline health-btn-heal"
                          onClick={() => handleOpenHealModal(a)}
                        >
                          {t("health_btn_heal")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Single Item Heal Modal */}
      {targetAnomaly && (
        <Dialog open={healModalOpen} onClose={() => setHealModalOpen(false)} overlayClassName="modal-overlay health-modal-overlay" className="modal-content animate-fade-in health-modal-content" labelledBy="health-heal-modal-title" describedBy="health-heal-modal-description">
            <div className="health-modal-header">
              <h2 id="health-heal-modal-title" className="health-modal-title">{t("health_modal_title")}</h2>
            </div>

            <div className="health-modal-body">
              <div className="health-modal-group">
                <div className="health-modal-label">{t("health_modal_target")}</div>
                <div className="health-modal-target">{targetAnomaly.imsi} ({targetAnomaly.type})</div>
              </div>

              <div className="health-modal-group-lg">
                <label className="form-label health-modal-form-label" htmlFor="health-heal-profile">{t("health_modal_restore")}</label>
                <select id="health-heal-profile" className="form-input" value={healProfile} onChange={e => setHealProfile(e.target.value)}>
                  <option value="">{t("health_modal_default")}</option>
                  {profileList.map((p: any) => <option key={p.name} value={p.name}>{p.title || p.name}</option>)}
                </select>
                <div id="health-heal-modal-description" className="health-modal-desc">
                  {t("health_modal_desc")}
                </div>
              </div>

              <div className="health-modal-confirm-box">
                <label className="health-modal-checkbox-label">
                  <input
                    type="checkbox"
                    className="checkbox-custom health-modal-checkbox"
                    checked={isHealConfirmed}
                    onChange={e => setIsHealConfirmed(e.target.checked)}
                  />
                  <span className="health-modal-confirm-text">
                    {t("health_modal_confirm", { time: lastSaveTime ? new Date(lastSaveTime * 1000).toLocaleString() : t("health_unknown") })}
                  </span>
                </label>
              </div>

              <div className="health-modal-actions">
                <button
                  className="btn btn-outline"
                  onClick={() => setHealModalOpen(false)}
                  disabled={isHealing}
                >
                  {t("cancel")}
                </button>
                <button
                  className="btn btn-primary health-modal-btn"
                  onClick={executeHeal}
                  disabled={!isHealConfirmed || isHealing}
                >
                  {isHealing ? <span className="spinner health-spinner" /> : <Check size={16} />}
                  {t("health_btn_execute")}
                </button>
              </div>
            </div>
        </Dialog>
      )}

      {/* Batch Auto-Heal Modal */}
      <Dialog open={batchModalOpen} onClose={() => setBatchModalOpen(false)} overlayClassName="modal-overlay health-modal-overlay" className="modal-content animate-fade-in health-modal-content" labelledBy="health-batch-modal-title" describedBy="health-batch-modal-description">
            <div className="health-modal-header">
              <h2 id="health-batch-modal-title" className="health-modal-title">{t("health_batch_modal_title")}</h2>
            </div>

            <div className="health-modal-body">
              <div className="health-modal-group">
                <div className="health-modal-label">{t("health_anomalies_detected")}</div>
                <div className="health-modal-target">{t("health_items_to_remediate", { count: filteredAnomalies.length })}</div>
              </div>

              <p id="health-batch-modal-description" className="health-modal-desc">
                {t("health_batch_modal_desc", { count: String(filteredAnomalies.length) })}
              </p>

              <div className="health-modal-group-lg">
                <label className="form-label health-modal-form-label" htmlFor="health-batch-profile">{t("health_modal_restore")}</label>
                <select id="health-batch-profile" className="form-input" value={batchHealProfile} onChange={e => setBatchHealProfile(e.target.value)}>
                  <option value="">{t("health_modal_default")}</option>
                  {profileList.map((p: any) => <option key={p.name} value={p.name}>{p.title || p.name}</option>)}
                </select>
              </div>

              <div className="health-modal-confirm-box">
                <label className="health-modal-checkbox-label">
                  <input
                    type="checkbox"
                    className="checkbox-custom health-modal-checkbox"
                    checked={isBatchConfirmed}
                    onChange={e => setIsBatchConfirmed(e.target.checked)}
                  />
                  <span className="health-modal-confirm-text">
                    {t("health_batch_modal_confirm")}
                  </span>
                </label>
              </div>

              <div className="health-modal-actions">
                <button
                  className="btn btn-outline"
                  onClick={() => setBatchModalOpen(false)}
                  disabled={isBatchHealing}
                >
                  {t("cancel")}
                </button>
                <button
                  className="btn btn-primary health-modal-btn"
                  onClick={executeBatchHeal}
                  disabled={!isBatchConfirmed || isBatchHealing}
                >
                  {isBatchHealing ? <span className="spinner health-spinner" /> : <Wrench size={16} />}
                  {t("health_btn_batch_heal")}
                </button>
              </div>
            </div>
      </Dialog>
    </>
  );
}
