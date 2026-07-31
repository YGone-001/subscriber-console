"use client";

import { useState, useRef } from "react";
import { Activity, ShieldAlert, HeartPulse, HardDrive, Database, Check, RefreshCw } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";
import "./system-health.css";

type HealthNotice = {
  type: "success" | "error" | "warning";
  text: string;
};

export default function SystemHealthPage() {
  const { t } = useI18n();
  const { data: profileData } = useSWR("/api/profiles", fetcher);
  const profileList = profileData?.profiles || [];

  const { data: statusData, mutate: mutateStatus } = useSWR("/api/system/audit/status", fetcher, { refreshInterval: 60000 });
  const lastSaveTime = statusData?.lastSaveTime || null;
  const { data: mongoHealth, error: mongoHealthError, mutate: refreshMongoHealth, isLoading: isMongoHealthLoading } = useSWR(
    "/api/system/mongo/health",
    fetcher,
    { refreshInterval: 60000 }
  );
  const mongoReady = Boolean(mongoHealth?.ok && !mongoHealthError);
  const missingMongoItems = (mongoHealth?.missingCollections?.length || 0) + (mongoHealth?.missingIndexes?.length || 0);

  // Scan states
  const [isAuditing, setIsAuditing] = useState(false);
  const [scannedTotal, setScannedTotal] = useState(0);
  const [anomalies, setAnomalies] = useState<any[]>([]);
  const [auditPhase, setAuditPhase] = useState<'IDLE' | 'INIT' | 'SCAN_SUB' | 'SCAN_OCS' | 'COMPLETE' | 'ABORTED'>('IDLE');
  const [notice, setNotice] = useState<HealthNotice | null>(null);

  // Heal Modal states
  const [healModalOpen, setHealModalOpen] = useState(false);
  const [targetAnomaly, setTargetAnomaly] = useState<any>(null);
  const [healProfile, setHealProfile] = useState("");
  const [isHealConfirmed, setIsHealConfirmed] = useState(false);
  const [isHealing, setIsHealing] = useState(false);

  // Use refs for aggressive recursion logic without stale states
  const scanMetrics = useRef({ total: 0, anomaliesList: [] as any[] });

  const runFullAudit = async () => {
    setIsAuditing(true);
    setNotice(null);
    setAnomalies([]);
    setScannedTotal(0);
    setAuditPhase('INIT');
    scanMetrics.current = { total: 0, anomaliesList: [] };

    // Start recursion pipeline
    await recursiveScan('0', 'sub');
  };

  const recursiveScan = async (cursor: string, phase: 'sub' | 'ocs') => {
    try {
      if (cursor === '0') setAuditPhase(phase === 'sub' ? 'SCAN_SUB' : 'SCAN_OCS');

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
        // Recursive continuation
        await recursiveScan(newNext, phase);
      } else {
        // Switch phase or complete
        if (phase === 'sub') {
          await recursiveScan('0', 'ocs');
        } else {
          setAuditPhase('COMPLETE');
          setIsAuditing(false);
        }
      }
    } catch {
      setIsAuditing(false);
      setAuditPhase('ABORTED');
      setNotice({ type: "error", text: t("health_scan_abort") });
    }
  };

  const handleOpenHealModal = (anomaly: any) => {
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
          profileName: healProfile || undefined
        })
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.approval?.id) {
          setNotice({ type: "success", text: t("approval_msg_submitted", { id: data.approval.id }) });
          setHealModalOpen(false);
          return;
        }

        // optimistic remove from list
        const updatedList = anomalies.filter(a => a.imsi !== targetAnomaly.imsi || a.type !== targetAnomaly.type);
        setAnomalies(updatedList);
        await mutateStatus();
        scanMetrics.current.anomaliesList = updatedList;
        setNotice({ type: "success", text: t("health_msg_heal_success", { imsi: targetAnomaly.imsi }) });
        setHealModalOpen(false);
      } else {
        const message = t("health_err_heal_backend");
        setNotice({ type: "error", text: message });
      }
    } catch {
      const message = t("health_err_heal_net");
      setNotice({ type: "error", text: message });
    } finally {
      setIsHealing(false);
    }
  };

  const calcHealthScore = () => {
    if (scannedTotal === 0) return 100;
    const h = (1 - (anomalies.length / scannedTotal)) * 100;
    return Math.max(0, parseFloat(h.toFixed(2)));
  };
  const currentHealth = calcHealthScore();

  const renderDetails = (details: string) => {
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

      <div className="health-mongo-card">
        <div className="health-mongo-header">
          <div className="health-mongo-title-group">
            <Database size={22} color={mongoReady ? "var(--success)" : "var(--danger)"} />
            <div>
              <h2 className="health-mongo-title">MongoDB Readiness</h2>
              <div className="health-mongo-subtitle">
                {isMongoHealthLoading ? "Checking database..." : mongoReady ? "Connection and required indexes are ready." : "Database check requires attention."}
              </div>
            </div>
          </div>
          <button
            className="btn btn-outline health-mongo-refresh"
            onClick={() => refreshMongoHealth()}
            disabled={isMongoHealthLoading}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>

        <div className="health-mongo-grid">
          <div className="health-mongo-stat">
            <div className="health-mongo-stat-label">Status</div>
            <div className={mongoReady ? "health-mongo-stat-success" : "health-mongo-stat-danger"}>
              {mongoReady ? "Ready" : "Attention"}
            </div>
          </div>
          <div className="health-mongo-stat">
            <div className="health-mongo-stat-label">Database</div>
            <div className="health-mongo-stat-value">
              {mongoHealth?.database || "--"}
            </div>
          </div>
          <div className="health-mongo-stat">
            <div className="health-mongo-stat-label">Collections</div>
            <div className="health-mongo-stat-value">
              {mongoHealth?.collections?.filter((item: any) => item.exists).length ?? "--"} / {mongoHealth?.collections?.length ?? "--"}
            </div>
          </div>
          <div className="health-mongo-stat">
            <div className="health-mongo-stat-label">Missing Items</div>
            <div className={missingMongoItems > 0 ? "health-mongo-stat-danger" : "health-mongo-stat-value"}>
              {mongoHealth ? missingMongoItems : "--"}
            </div>
          </div>
        </div>

        {!mongoReady && mongoHealth && (
          <div className="health-mongo-error">
            {mongoHealth.error ? (
              <span>{mongoHealth.error}</span>
            ) : (
              <span>
                Missing collections: {mongoHealth.missingCollections?.join(", ") || "none"}. Missing indexes: {mongoHealth.missingIndexes?.map((item: any) => `${item.collection}.${item.index}`).join(", ") || "none"}.
              </span>
            )}
          </div>
        )}
      </div>

      {/* KPI Board */}
      <div className="health-kpi-grid">

        <div className={`dash-card shadow health-kpi-card ${currentHealth < 99 ? 'health-kpi-card-danger' : 'health-kpi-card-success'}`}>
          <div className="health-kpi-inner">
            <div>
              <div className="health-kpi-label">{t("health_data_score")}</div>
              <div className={currentHealth < 99 ? "health-kpi-value-danger" : "health-kpi-value"}>
                {auditPhase === 'IDLE' ? '--' : `${currentHealth}%`}
              </div>
            </div>
            <HeartPulse size={32} color="#dddfeb" />
          </div>
        </div>

        <div className="dash-card shadow health-kpi-card health-kpi-card-primary">
          <div className="health-kpi-inner">
            <div>
              <div className="health-kpi-label">{t("health_active_anomalies")}</div>
              <div className="health-kpi-value">{anomalies.length}</div>
            </div>
            <ShieldAlert size={32} color="#dddfeb" />
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
            <HardDrive size={32} color="#dddfeb" />
          </div>
        </div>

      </div>

      {/* Control Strip */}
      <div className="health-control-strip">
        <div className="health-control-status">
          <div className="health-control-text">
            <Activity size={20} color="var(--primary)" />
            <span className={`health-control-msg ${isAuditing ? 'health-control-msg-active' : 'health-control-msg-idle'}`}>
              {auditPhase === 'IDLE' && t("health_idle_msg")}
              {auditPhase === 'INIT' && t("health_scan_init")}
              {(auditPhase === 'SCAN_SUB' || auditPhase === 'SCAN_OCS') && t("health_scan_progress").replace("{phase}", auditPhase === 'SCAN_SUB' ? 'SUB' : 'OCS').replace("{total}", scannedTotal.toString()).replace("{anomalies}", anomalies.length.toString())}
              {auditPhase === 'COMPLETE' && t("health_scan_complete").replace("{total}", scannedTotal.toString()).replace("{anomalies}", anomalies.length.toString())}
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

      {/* Anomalies Table */}
      <div className="health-anomalies-card">
        <div className="health-anomalies-header">
          <h2 className="health-anomalies-title">{t("health_anomalies_detected")}</h2>
        </div>

        {isAuditing && anomalies.length === 0 ? (
          <LoadingRows columns={4} rows={4} />
        ) : anomalies.length === 0 ? (
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
              <thead className="health-table-thead">
                <tr>
                  <th className="health-table-th">{t("health_col_imsi")}</th>
                  <th className="health-table-th">{t("health_col_type")}</th>
                  <th className="health-table-th">{t("health_col_details")}</th>
                  <th className="health-table-th-right">{t("health_col_action")}</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((a, idx) => (
                  <tr key={`${a.imsi}-${idx}`} className="health-table-tr hover-glass">
                    <td className="health-table-td-imsi">{a.imsi}</td>
                    <td className="health-table-td">
                      <span className="badge-secondary health-badge">
                        {a.type}
                      </span>
                    </td>
                    <td className="health-table-td-details">{renderDetails(a.details)}</td>
                    <td className="health-table-td-actions">
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

      {/* Heal Validation Modal */}
      {healModalOpen && targetAnomaly && (
        <div className="modal-overlay health-modal-overlay">
          <div className="modal-content animate-fade-in health-modal-content">
            <div className="health-modal-header">
              <h2 className="health-modal-title">{t("health_modal_title")}</h2>
            </div>

            <div className="health-modal-body">
              <div className="health-modal-group">
                <div className="health-modal-label">{t("health_modal_target")}</div>
                <div className="health-modal-target">{targetAnomaly.imsi}</div>
              </div>

              <div className="health-modal-group-lg">
                <label className="form-label health-modal-form-label">{t("health_modal_restore")}</label>
                <select className="form-input" value={healProfile} onChange={e => setHealProfile(e.target.value)}>
                  <option value="">{t("health_modal_default")}</option>
                  {profileList.map((p: any) => <option key={p.name} value={p.name}>{p.title || p.name}</option>)}
                </select>
                <div className="health-modal-desc">
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
                    {t("health_modal_confirm").replace("{time}", lastSaveTime ? new Date(lastSaveTime * 1000).toLocaleString() : t("health_unknown"))}
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
          </div>
        </div>
      )}
    </>
  );
}
