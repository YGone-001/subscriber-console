"use client";

import { useState, useRef } from "react";
import { Activity, ShieldAlert, HeartPulse, HardDrive, Database, Check } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "@/components/I18nProvider";

export default function SystemHealthPage() {
  const { t } = useI18n();
  const { data: profileData } = useSWR("/api/profiles", fetcher);
  const profileList = profileData?.profiles || [];

  const { data: statusData, mutate: mutateStatus } = useSWR("/api/system/audit/status", fetcher, { refreshInterval: 60000 });
  const lastSaveTime = statusData?.lastSaveTime || null;

  // Scan states
  const [isAuditing, setIsAuditing] = useState(false);
  const [scannedTotal, setScannedTotal] = useState(0);
  const [anomalies, setAnomalies] = useState<any[]>([]);
  const [auditPhase, setAuditPhase] = useState<'IDLE' | 'INIT' | 'SCAN_SUB' | 'SCAN_OCS' | 'COMPLETE' | 'ABORTED'>('IDLE');

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
    }
  };

  const handleOpenHealModal = (anomaly: any) => {
    setTargetAnomaly(anomaly);
    setIsHealConfirmed(false);
    setHealProfile("");
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
        // optimistic remove from list
        const updatedList = anomalies.filter(a => a.imsi !== targetAnomaly.imsi || a.type !== targetAnomaly.type);
        setAnomalies(updatedList);
        mutateStatus();
        scanMetrics.current.anomaliesList = updatedList;
        setHealModalOpen(false);
      } else {
        alert(t("health_err_heal_backend"));
      }
    } catch {
      alert(t("health_err_heal_net"));
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
      <div className="container animate-fade-in" style={{ padding: "3rem", paddingBottom: "100px" }}>

      {/* KPI Board */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1.5rem", marginBottom: "2.5rem" }}>

        <div className="dash-card shadow" style={{ padding: "1.5rem 2rem", borderRadius: "12px", borderLeft: currentHealth < 99 ? "4px solid var(--danger)" : "4px solid var(--success)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase" }}>{t("health_data_score")}</div>
              <div style={{ fontSize: "2rem", fontWeight: 700, color: currentHealth < 99 ? "var(--danger)" : "var(--text-main)", marginTop: "0.5rem" }}>
                {auditPhase === 'IDLE' ? '--' : `${currentHealth}%`}
              </div>
            </div>
            <HeartPulse size={32} color="#dddfeb" />
          </div>
        </div>

        <div className="dash-card shadow" style={{ padding: "1.5rem 2rem", borderRadius: "12px", borderLeft: "4px solid var(--primary)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase" }}>{t("health_active_anomalies")}</div>
              <div style={{ fontSize: "2rem", fontWeight: 700, color: "var(--text-main)", marginTop: "0.5rem" }}>{anomalies.length}</div>
            </div>
            <ShieldAlert size={32} color="#dddfeb" />
          </div>
        </div>

        <div className="dash-card shadow" style={{ padding: "1.5rem 2rem", borderRadius: "12px", borderLeft: "4px solid #f6c23e" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase" }}>{t("health_last_bgsave")}</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--text-main)", marginTop: "0.8rem", whiteSpace: "nowrap" }}>
                {lastSaveTime ? new Date(lastSaveTime * 1000).toLocaleString() : t("health_loading")}
              </div>
            </div>
            <HardDrive size={32} color="#dddfeb" />
          </div>
        </div>

      </div>

      {/* Control Strip */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem", background: "var(--surface)", backdropFilter: "blur(12px)", padding: "1rem 2rem", borderRadius: "12px", border: "1px solid var(--surface-border)", boxShadow: "0 4px 20px rgba(0,0,0,0.2)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <Activity size={20} color="var(--primary)" />
            <span style={{ fontWeight: 500, color: isAuditing ? "var(--primary)" : "var(--text-secondary)" }}>
              {auditPhase === 'IDLE' && t("health_idle_msg")}
              {auditPhase === 'INIT' && t("health_scan_init")}
              {(auditPhase === 'SCAN_SUB' || auditPhase === 'SCAN_OCS') && t("health_scan_progress").replace("{phase}", auditPhase === 'SCAN_SUB' ? 'SUB' : 'OCS').replace("{total}", scannedTotal.toString()).replace("{anomalies}", anomalies.length.toString())}
              {auditPhase === 'COMPLETE' && t("health_scan_complete").replace("{total}", scannedTotal.toString()).replace("{anomalies}", anomalies.length.toString())}
              {auditPhase === 'ABORTED' && t("health_scan_abort")}
            </span>
          </div>
          {isAuditing && (
            <div className="progress-bar-container" style={{ marginTop: "1rem", borderRadius: "4px" }}>
              <div className="progress-bar-value" />
            </div>
          )}
        </div>
        <div style={{ marginLeft: "2rem" }}>
          <button
            className="btn btn-primary"
            onClick={runFullAudit}
            disabled={isAuditing}
            style={{ padding: "0.6rem 1.5rem", borderRadius: "20px", display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            {isAuditing ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }}/> : <Database size={16}/>}
            {isAuditing ? t("health_btn_scanning") : t("health_btn_run")}
          </button>
        </div>
      </div>

      {/* Anomalies Table */}
      <div style={{ background: "var(--surface)", backdropFilter: "blur(12px)", borderRadius: "12px", border: "1px solid var(--surface-border)", boxShadow: "0 4px 20px rgba(0,0,0,0.2)", overflow: "hidden" }}>
        <div style={{ padding: "1.5rem 2rem", borderBottom: "1px solid var(--surface-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600, color: "var(--text-main)" }}>{t("health_anomalies_detected")}</h2>
        </div>

        {anomalies.length === 0 ? (
          <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-muted)" }}>
            {t("health_no_anomalies")}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ background: "var(--background)", borderBottom: "2px solid var(--surface-border)" }}>
                <tr>
                  <th style={{ padding: "1rem 2rem", textAlign: "left", fontSize: "0.85rem", color: "var(--text-secondary)" }}>{t("health_col_imsi")}</th>
                  <th style={{ padding: "1rem 2rem", textAlign: "left", fontSize: "0.85rem", color: "var(--text-secondary)" }}>{t("health_col_type")}</th>
                  <th style={{ padding: "1rem 2rem", textAlign: "left", fontSize: "0.85rem", color: "var(--text-secondary)" }}>{t("health_col_details")}</th>
                  <th style={{ padding: "1rem 2rem", textAlign: "right", fontSize: "0.85rem", color: "var(--text-secondary)" }}>{t("health_col_action")}</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((a, idx) => (
                  <tr key={`${a.imsi}-${idx}`} style={{ borderBottom: "1px solid var(--surface-border)" }} className="hover-glass">
                    <td style={{ padding: "1rem 2rem", fontWeight: 600 }}>{a.imsi}</td>
                    <td style={{ padding: "1rem 2rem" }}>
                      <span className="badge-secondary" style={{ color: "var(--danger)", border: "1px solid rgba(239, 68, 68, 0.3)", background: "rgba(239, 68, 68, 0.1)" }}>
                        {a.type}
                      </span>
                    </td>
                    <td style={{ padding: "1rem 2rem", color: "var(--text-secondary)", fontSize: "0.9rem" }}>{renderDetails(a.details)}</td>
                    <td style={{ padding: "1rem 2rem", textAlign: "right" }}>
                      <button
                        className="btn btn-outline"
                        onClick={() => handleOpenHealModal(a)}
                        style={{ padding: "0.4rem 1rem", fontSize: "0.85rem", borderRadius: "20px" }}
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
        <div className="modal-overlay" style={{ zIndex: 9999 }}>
          <div className="modal-content animate-fade-in" style={{ width: "500px", maxWidth: "95%", borderRadius: "12px", overflow: "hidden" }}>
            <div style={{ padding: "1.5rem 2rem", borderBottom: "1px solid var(--surface-border)", background: "var(--surface-hover)" }}>
              <h2 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 600, color: "var(--text-main)" }}>{t("health_modal_title")}</h2>
            </div>

            <div style={{ padding: "2rem" }}>
              <div style={{ marginBottom: "1.5rem" }}>
                <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>{t("health_modal_target")}</div>
                <div style={{ fontWeight: 600, fontSize: "1.1rem" }}>{targetAnomaly.imsi}</div>
              </div>

              <div style={{ marginBottom: "2rem" }}>
                <label className="form-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>{t("health_modal_restore")}</label>
                <select className="form-input" value={healProfile} onChange={e => setHealProfile(e.target.value)}>
                  <option value="">{t("health_modal_default")}</option>
                  {profileList.map((p: any) => <option key={p.name} value={p.name}>{p.title || p.name}</option>)}
                </select>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
                  {t("health_modal_desc")}
                </div>
              </div>

              <div style={{ background: "var(--surface-hover)", padding: "1rem", borderRadius: "8px", border: "1px solid var(--surface-border)" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem", cursor: "pointer", margin: 0 }}>
                  <input
                    type="checkbox"
                    className="checkbox-custom"
                    checked={isHealConfirmed}
                    onChange={e => setIsHealConfirmed(e.target.checked)}
                    style={{ marginTop: "0.15rem" }}
                  />
                  <span style={{ fontSize: "0.9rem", color: "var(--text-main)", lineHeight: 1.5, fontWeight: 500 }}>
                    {t("health_modal_confirm").replace("{time}", lastSaveTime ? new Date(lastSaveTime * 1000).toLocaleString() : t("health_unknown"))}
                  </span>
                </label>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "2rem" }}>
                <button
                  className="btn btn-outline"
                  onClick={() => setHealModalOpen(false)}
                  disabled={isHealing}
                >
                  {t("cancel")}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={executeHeal}
                  disabled={!isHealConfirmed || isHealing}
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                >
                  {isHealing ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }}/> : <Check size={16} />}
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
