"use client";

import { CheckCircle2, type LucideIcon, RotateCcw, Save, Settings2, ShieldOff, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { OperationNotice } from "./OperationFeedback";
import { fetcher } from "@/lib/fetcher";
import "./modals.css";

type PolicyStatus = "active" | "suspended";

type BulkPolicyResult = {
  requested: number;
  subscriberModified: number;
  balanceModified: number;
  planId: string;
  status: PolicyStatus;
  resetBalances: boolean;
};

type ApprovalRequest = {
  id: string;
  status: string;
};

type BulkPolicySuccess = {
  result?: BulkPolicyResult;
  approval?: ApprovalRequest;
};

type BulkPolicyModalProps = {
  isOpen: boolean;
  selectedImsis: string[];
  onClose: () => void;
  onSuccess: (result: BulkPolicySuccess) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

type TariffPlan = {
  plan_id: string;
  name: string;
  description?: string;
  status: string;
};

export default function BulkPolicyModal({ isOpen, selectedImsis, onClose, onSuccess, t }: BulkPolicyModalProps) {
  const { data: plansData } = useSWR(isOpen ? "/api/tariff-plans" : null, fetcher);
  const planOptions: TariffPlan[] = useMemo(
    () => (plansData?.plans || []).filter((plan: TariffPlan) => (plan.status || "active") === "active"),
    [plansData?.plans]
  );
  const [planId, setPlanId] = useState("plan_default_10gb");
  const [status, setStatus] = useState<PolicyStatus>("active");
  const [resetBalances, setResetBalances] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPreview = useMemo(() => selectedImsis.slice(0, 3), [selectedImsis]);
  const selectedPlan = planOptions.find((plan) => plan.plan_id === planId);
  const statusOptions: Array<{ value: PolicyStatus; labelKey: string; icon: LucideIcon }> = [
    { value: "active", labelKey: "policy_status_active", icon: CheckCircle2 },
    { value: "suspended", labelKey: "policy_status_suspended", icon: ShieldOff },
  ];

  useEffect(() => {
    if (!isOpen || planOptions.length === 0 || planOptions.some((plan) => plan.plan_id === planId)) return;
    setPlanId(planOptions[0].plan_id);
  }, [isOpen, planId, planOptions]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/subscribers/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imsiList: selectedImsis,
          planId,
          status,
          resetBalances,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = data.error === "Tariff plan not found"
          ? t("tariff_plan_err_not_found")
          : data.error === "Invalid plan_id format"
          ? t("tariff_plan_err_id")
          : data.error === "Tariff plan is disabled"
          ? t("tariff_plan_err_disabled")
          : data.error || t("policy_change_err_save");
        throw new Error(message);
      }

      onSuccess(data);
      onClose();
    } catch (err: any) {
      setError(err.message || t("policy_change_err_save"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(event) => { event.stopPropagation(); onClose(); }}>
      <div className="modal-content animate-modal-enter bp-modal-content" onClick={(event) => event.stopPropagation()}>
        <div className="workflow-header bp-header">
          <div>
            <h2 className="bp-header-title">
              <Settings2 size={18} /> {t("policy_change_title")}
            </h2>
            <p className="bp-header-desc">
              {t("policy_selected_count", { count: selectedImsis.length })}
            </p>
          </div>
          <button className="btn-icon" onClick={onClose} title={t("close")}><X size={22} /></button>
        </div>

        <div className="bp-body">
          <div className="bp-grid-top">
            <div>
              <label className="form-label">{t("policy_change_plan")}</label>
              <select className="form-input" value={planId} onChange={(event) => setPlanId(event.target.value)}>
                {planOptions.length === 0 ? (
                  <option value="plan_default_10gb">plan_default_10gb</option>
                ) : planOptions.map((plan) => (
                  <option key={plan.plan_id} value={plan.plan_id}>{plan.name || plan.plan_id}</option>
                ))}
              </select>
              <div className="bp-plan-desc">
                {selectedPlan?.description || t("policy_change_default_plan_desc")}
              </div>
            </div>

            <div>
              <label className="form-label">{t("policy_change_status")}</label>
              <div className="bp-status-grid">
                {statusOptions.map((option) => {
                  const Icon = option.icon;
                  const active = status === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={active ? "btn btn-primary bp-status-btn" : "btn btn-outline bp-status-btn"}
                      onClick={() => setStatus(option.value)}
                    >
                      <Icon size={15} /> {t(option.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <label className={`bp-reset-label ${resetBalances ? 'checked' : 'unchecked'}`}>
            <input
              type="checkbox"
              className="checkbox-custom"
              checked={resetBalances}
              onChange={(event) => setResetBalances(event.target.checked)}
            />
            <span>
              <span className="bp-reset-title">
                <RotateCcw size={15} /> {t("policy_change_reset_balances")}
              </span>
              <span className="bp-reset-desc">
                {t("policy_change_reset_desc")}
              </span>
            </span>
          </label>

          <div className="bp-preview">
            <div className="bp-preview-title">{t("policy_change_preview")}</div>
            <div className="bp-preview-grid">
              <div>
                <div className="bp-preview-label">IMSI</div>
                <div className="bp-preview-value bp-preview-imsi">
                  {selectedPreview.join(", ")}{selectedImsis.length > selectedPreview.length ? ` +${selectedImsis.length - selectedPreview.length}` : ""}
                </div>
              </div>
              <div>
                <div className="bp-preview-label">{t("policy_change_plan")}</div>
                <div className="bp-preview-value">{planId}</div>
              </div>
              <div>
                <div className="bp-preview-label">{t("policy_change_status")}</div>
                <div className="bp-preview-value">{status === "active" ? t("policy_status_active") : t("policy_status_suspended")}</div>
              </div>
            </div>
          </div>

          {error && (
            <OperationNotice
              presentation="modal"
              tone="danger"
              title={t("error")}
              message={error}
              onClose={() => setError(null)}
            />
          )}
        </div>

        <div className="workflow-footer bp-footer">
          <span className="bp-footer-text">{t("policy_change_subtitle")}</span>
          <div className="workflow-footer-actions">
            <button className="btn btn-outline" onClick={onClose} disabled={isSaving}>{t("cancel")}</button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={isSaving || selectedImsis.length === 0}>
              <Save size={16} /> {isSaving ? t("policy_change_applying") : t("policy_change_apply")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
