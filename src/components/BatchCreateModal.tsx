import React, { useEffect, useMemo, useState } from "react";
import { Layers, X, Download } from "lucide-react";
import useSWR from "swr";
import { useI18n } from "./I18nProvider";
import { OperationNotice } from "./OperationFeedback";
import { fetcher } from "@/lib/fetcher";

interface BatchCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  profileList: any[];
}

type TariffPlan = {
  plan_id: string;
  name?: string;
  description?: string;
  status?: string;
};

export default function BatchCreateModal({ isOpen, onClose, onSuccess, profileList }: BatchCreateModalProps) {
  const { t } = useI18n();
  const { data: plansData } = useSWR(isOpen ? "/api/tariff-plans" : null, fetcher);
  const planOptions: TariffPlan[] = useMemo(
    () => (plansData?.plans || []).filter((plan: TariffPlan) => (plan.status || "active") === "active"),
    [plansData?.plans]
  );
  const [batchForm, setBatchForm] = useState({ startImsi: "", count: "10", profileName: "", planId: "plan_default_10gb" });
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);

  // Pre-flight check state
  const [precheckResult, setPrecheckResult] = useState<any>(null);
  const [isPrecheckModalOpen, setIsPrecheckModalOpen] = useState(false);

  useEffect(() => {
    if (!isOpen || planOptions.length === 0 || planOptions.some((plan) => plan.plan_id === batchForm.planId)) return;
    setBatchForm((current) => ({ ...current, planId: planOptions[0].plan_id }));
  }, [batchForm.planId, isOpen, planOptions]);

  if (!isOpen) return null;

  const getPreviewText = () => {
    if (!batchForm.startImsi || !batchForm.count) return null;
    const count = Number(batchForm.count);
    if (isNaN(count) || count < 1) return null;
    try {
      const startBn = BigInt(batchForm.startImsi);
      const endBn = startBn + BigInt(count) - BigInt(1);
      return t("batch_preview", { count, start: startBn.toString(), end: endBn.toString() });
    } catch {
      return t("invalid_imsi_format");
    }
  };

  const handleBatchCreate = async () => {
    if (!batchForm.startImsi || !batchForm.count) return;
    if (!/^\d{15}$/.test(batchForm.startImsi)) {
      setBatchResult({ error: t("err_imsi_length_full") });
      return;
    }
    setBatchLoading(true);
    setBatchResult(null);

    try {
      const pRes = await fetch("/api/subscribers/batch/precheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startImsi: batchForm.startImsi, count: Number(batchForm.count) })
      });
      const pData = await pRes.json();

      if (!pRes.ok) {
        setBatchResult({ error: pData.error || t("err_precheck_failed") });
        setBatchLoading(false);
        return;
      }

      if (pData.conflictCount > 0) {
        setPrecheckResult(pData);
        setIsPrecheckModalOpen(true);
        setBatchLoading(false);
        return;
      }

      await executeBatchStrategy('overwrite');

    } catch {
      setBatchResult({ error: t("err_network_precheck") });
      setBatchLoading(false);
    }
  };

  const executeBatchStrategy = async (strategy: 'skip' | 'overwrite') => {
    setIsPrecheckModalOpen(false);
    setBatchLoading(true);
    try {
      const res = await fetch("/api/subscribers/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startImsi: batchForm.startImsi,
          count: Number(batchForm.count),
          profileName: batchForm.profileName || undefined,
          planId: batchForm.planId,
          strategy: strategy
        })
      });
      const data = await res.json();
      if (res.ok) {
        setBatchResult(data);
        if (!data?.approval?.id) onSuccess();
      } else {
        const message = data.error === "Tariff plan not found"
          ? t("tariff_plan_err_not_found")
          : data.error === "Invalid plan_id format"
          ? t("tariff_plan_err_id")
          : data.error || t("err_batch_failed");
        setBatchResult({ error: message });
      }
    } catch {
      setBatchResult({ error: t("err_network_batch") });
    } finally {
      setBatchLoading(false);
    }
  };

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content animate-fade-in" onClick={e => e.stopPropagation()} style={{ width: "640px", maxWidth: "95%", borderRadius: "12px", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1.5rem 2rem", borderBottom: "1px solid var(--surface-border)" }}>
            <h2 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 600, color: "var(--text-main)" }}>{t("batch_create")}</h2>
            <button className="btn-icon" onClick={onClose}><X size={24} color="var(--text-muted)" /></button>
          </div>

          {batchLoading && (
            <div className="progress-bar-container">
              <div className="progress-bar-value" />
            </div>
          )}

          <div style={{ padding: "2rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
            <div>
              <label className="form-label">{t("batch_start_imsi")}*</label>
              <input
                type="text"
                className={`form-input ${batchForm.startImsi && !/^\d{15}$/.test(batchForm.startImsi) ? 'border-danger error-shake' : ''}`}
                style={{ border: batchForm.startImsi && !/^\d{15}$/.test(batchForm.startImsi) ? "1px solid var(--danger)" : undefined }}
                placeholder="e.g. 460020000000001"
                value={batchForm.startImsi}
                onChange={e => setBatchForm({...batchForm, startImsi: e.target.value.replace(/\D/g, '')})}
                maxLength={15}
              />
              {batchForm.startImsi && !/^\d{15}$/.test(batchForm.startImsi) && (
                <div style={{ color: "var(--danger)", fontSize: "0.8rem", marginTop: "0.25rem", fontWeight: 500 }}>{t("err_imsi_length")}</div>
              )}
            </div>
            <div>
              <label className="form-label">{t("batch_count")} (1-1000)*</label>
              <input type="number" className="form-input" min="1" max="1000" value={batchForm.count} onChange={e => setBatchForm({...batchForm, count: e.target.value})} />
            </div>
            <div>
              <label className="form-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}><Download size={14} /> {t("profile_template")}</label>
              <select className="form-input" value={batchForm.profileName} onChange={e => {
                const pName = e.target.value;
                setBatchForm({
                  ...batchForm,
                  profileName: pName,
                });
              }}>
                <option value="">{t("none_use_defaults")}</option>
                {profileList.map((p: any) => <option key={p.name} value={p.name}>{p.title || p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">{t("sub_360_tariff_plan")}</label>
              <select
                className="form-input"
                value={batchForm.planId}
                onChange={e => setBatchForm({ ...batchForm, planId: e.target.value })}
              >
                {planOptions.length === 0 ? (
                  <option value="plan_default_10gb">plan_default_10gb</option>
                ) : planOptions.map((plan) => (
                  <option key={plan.plan_id} value={plan.plan_id}>
                    {plan.name && plan.name !== plan.plan_id ? `${plan.name} (${plan.plan_id})` : plan.plan_id}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ padding: "0 2rem 1rem 2rem", marginTop: "-0.5rem", minHeight: "1.5rem" }}>
            {getPreviewText() && <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: 0 }}>{getPreviewText()}</p>}
          </div>

          {/* Result / Error Display */}
          {batchResult && (
            <div style={{ padding: "0 2rem 1rem 2rem" }}>
              {batchResult.error ? (
                <OperationNotice
                  presentation="modal"
                  tone="danger"
                  title={t("error")}
                  message={batchResult.error}
                  onClose={() => setBatchResult(null)}
                />
              ) : (
                <OperationNotice
                  presentation="modal"
                  tone={batchResult.failedCount > 0 ? "warning" : "success"}
                  title={batchResult.failedCount > 0 ? t("status") : t("success")}
                  message={`${batchResult.approval?.id
                    ? t("approval_msg_submitted", { id: batchResult.approval.id })
                    : t("created_subscribers", { count: batchResult.count, start: batchResult.range?.from, end: batchResult.range?.to })}${batchResult.failedCount > 0 ? ` Failed: ${batchResult.failedCount}` : ""}`}
                  onClose={() => setBatchResult(null)}
                />
              )}
            </div>
          )}

          <div style={{ padding: "1rem 2rem 2rem 2rem", display: "flex", justifyContent: "flex-end", gap: "1rem" }}>
            <button className="btn btn-outline" onClick={onClose} style={{ padding: "0.6rem 1.5rem", borderRadius: "8px" }} disabled={batchLoading}>{t("cancel")}</button>
            <button className="btn btn-primary" onClick={handleBatchCreate} disabled={batchLoading || !batchForm.startImsi || !/^\d{15}$/.test(batchForm.startImsi)} style={{ padding: "0.6rem 1.5rem", borderRadius: "8px", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {batchLoading ? <span style={{ padding: "0 1rem" }}>{t("batch_processing")}</span> : <><Layers size={16} /> {t("batch_create_btn")}</>}
            </button>
          </div>
        </div>
      </div>

      {/* Pre-check Conflict Modal */}
      {isPrecheckModalOpen && precheckResult && (
        <div className="modal-overlay" style={{ zIndex: 9999 }}>
          <div className="modal-content animate-fade-in" style={{ width: "500px", maxWidth: "95%", borderRadius: "12px", overflow: "hidden" }}>
            <div style={{ padding: "1.5rem 2rem", borderBottom: "1px solid var(--surface-border)", background: "rgba(239, 68, 68, 0.1)" }}>
              <h2 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 600, color: "var(--danger)" }}>{t("conflict_title")}</h2>
            </div>
            <div style={{ padding: "2rem" }}>
              <div style={{ background: "#fef2f2", color: "#b91c1c", padding: "1.25rem", borderRadius: "8px", fontWeight: 600, fontSize: "1.05rem", border: "1px solid #fecaca", marginBottom: "1.5rem", textAlign: "center" }}>
                {t("conflict_msg", { count: precheckResult.conflictCount })}
              </div>
              <p style={{ color: "var(--text-secondary)", marginBottom: "1.5rem", lineHeight: 1.6 }}>
                {t("conflict_description")}
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <button
                  className="btn btn-primary"
                  onClick={() => executeBatchStrategy('skip')}
                  style={{ width: "100%", padding: "0.8rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span style={{ fontWeight: 600 }}>{t("conflict_skip")}</span>
                  <span style={{ fontSize: "0.85rem", opacity: 0.8 }}>{t("conflict_skip_desc")}</span>
                </button>
                <button
                  className="btn"
                  onClick={() => executeBatchStrategy('overwrite')}
                  style={{ width: "100%", padding: "0.8rem", background: "#fef2f2", color: "var(--danger)", border: "1px solid var(--danger)", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span style={{ fontWeight: 600 }}>{t("conflict_overwrite")}</span>
                  <span style={{ fontSize: "0.85rem", opacity: 0.8 }}>{t("conflict_overwrite_desc")}</span>
                </button>
                <button
                  className="btn btn-outline"
                  onClick={() => { setIsPrecheckModalOpen(false); setBatchLoading(false); setBatchResult({error: t("batch_aborted")}); }}
                  style={{ width: "100%", padding: "0.8rem" }}
                >
                  <span style={{ fontWeight: 600, textAlign: "center", display: "block", color: "var(--text-secondary)" }}>{t("conflict_abort")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
