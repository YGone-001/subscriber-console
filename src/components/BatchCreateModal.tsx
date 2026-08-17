import React, { useEffect, useMemo, useRef, useState } from "react";
import { Layers, X, Download } from "lucide-react";
import useSWR from "swr";
import { useI18n } from "./I18nProvider";
import { OperationNotice } from "./OperationFeedback";
import { fetcher } from "@/lib/fetcher";
import { Dialog } from "@/components/ui/Dialog";
import "./modals.css";

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
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const abortButtonRef = useRef<HTMLButtonElement>(null);

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
          : data.error === "Tariff plan is disabled"
          ? t("tariff_plan_err_disabled")
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
      <Dialog
        open={isOpen}
        onClose={() => { if (!batchLoading) onClose(); }}
        overlayClassName="modal-overlay"
        className="modal-content animate-fade-in bc-modal-content"
        labelledBy="batch-create-modal-title"
        initialFocusRef={cancelButtonRef}
        closeOnOverlay={!batchLoading}
      >
          <div className="bc-header">
            <h2 id="batch-create-modal-title" className="bc-header-title">{t("batch_create")}</h2>
            <button className="btn-icon" onClick={onClose} aria-label={t("close")} disabled={batchLoading}><X size={24} color="var(--text-muted)" /></button>
          </div>

          {batchLoading && (
            <div className="progress-bar-container">
              <div className="progress-bar-value" />
            </div>
          )}

          <div className="bc-body">
            <div>
              <label className="form-label">{t("batch_start_imsi")}*</label>
              <input
                type="text"
                className={`form-input ${batchForm.startImsi && !/^\d{15}$/.test(batchForm.startImsi) ? 'border-danger error-shake bc-input-error' : ''}`}
                placeholder="e.g. 460020000000001"
                value={batchForm.startImsi}
                onChange={e => setBatchForm({...batchForm, startImsi: e.target.value.replace(/\D/g, '')})}
                maxLength={15}
              />
              {batchForm.startImsi && !/^\d{15}$/.test(batchForm.startImsi) && (
                <div className="bc-error-text">{t("err_imsi_length")}</div>
              )}
            </div>
            <div>
              <label className="form-label">{t("batch_count")} (1-1000)*</label>
              <input type="number" className="form-input" min="1" max="1000" value={batchForm.count} onChange={e => setBatchForm({...batchForm, count: e.target.value})} />
            </div>
            <div>
              <label className="form-label bc-label-icon"><Download size={14} /> {t("profile_template")}</label>
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

          <div className="bc-preview-container">
            {getPreviewText() && <p className="bc-preview-text">{getPreviewText()}</p>}
          </div>

          {/* Result / Error Display */}
          {batchResult && (
            <div className="bc-result-container">
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

          <div className="bc-footer">
            <button ref={cancelButtonRef} className="btn btn-outline bc-btn" onClick={onClose} disabled={batchLoading}>{t("cancel")}</button>
            <button className="btn btn-primary bc-btn-primary" onClick={handleBatchCreate} disabled={batchLoading || !batchForm.startImsi || !/^\d{15}$/.test(batchForm.startImsi)}>
              {batchLoading ? <span className="bc-processing">{t("batch_processing")}</span> : <><Layers size={16} /> {t("batch_create_btn")}</>}
            </button>
          </div>
      </Dialog>

      {/* Pre-check Conflict Modal */}
      {isPrecheckModalOpen && precheckResult && (
        <Dialog
          open
          onClose={() => { setIsPrecheckModalOpen(false); setBatchLoading(false); setBatchResult({ error: t("batch_aborted") }); }}
          overlayClassName="modal-overlay bc-conflict-overlay"
          className="modal-content animate-fade-in bc-conflict-content"
          labelledBy="batch-conflict-modal-title"
          initialFocusRef={abortButtonRef}
          role="alertdialog"
        >
            <div className="bc-conflict-header">
              <h2 id="batch-conflict-modal-title" className="bc-conflict-title">{t("conflict_title")}</h2>
            </div>
            <div className="bc-conflict-body">
              <div className="bc-conflict-alert">
                {t("conflict_msg", { count: precheckResult.conflictCount })}
              </div>
              <p className="bc-conflict-desc">
                {t("conflict_description")}
              </p>

              <div className="bc-conflict-actions">
                <button
                  className="btn btn-primary bc-conflict-btn"
                  onClick={() => executeBatchStrategy('skip')}
                >
                  <span className="bc-conflict-btn-label">{t("conflict_skip")}</span>
                  <span className="bc-conflict-btn-desc">{t("conflict_skip_desc")}</span>
                </button>
                <button
                  className="btn bc-conflict-btn-overwrite"
                  onClick={() => executeBatchStrategy('overwrite')}
                >
                  <span className="bc-conflict-btn-label">{t("conflict_overwrite")}</span>
                  <span className="bc-conflict-btn-desc">{t("conflict_overwrite_desc")}</span>
                </button>
                <button
                  ref={abortButtonRef}
                  className="btn btn-outline bc-conflict-btn-abort"
                  onClick={() => { setIsPrecheckModalOpen(false); setBatchLoading(false); setBatchResult({error: t("batch_aborted")}); }}
                >
                  <span className="bc-conflict-btn-abort-label">{t("conflict_abort")}</span>
                </button>
              </div>
            </div>
        </Dialog>
      )}
    </>
  );
}
