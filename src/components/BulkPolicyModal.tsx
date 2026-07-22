"use client";

import { CheckCircle2, type LucideIcon, RotateCcw, Save, Settings2, ShieldOff, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { OperationNotice } from "./OperationFeedback";
import { fetcher } from "@/lib/fetcher";

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
        throw new Error(data.error || t("policy_change_err_save"));
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
      <div className="modal-content animate-modal-enter" style={{ maxWidth: "680px", padding: 0 }} onClick={(event) => event.stopPropagation()}>
        <div className="workflow-header" style={{ padding: "1.25rem 1.5rem", borderBottom: "1px solid var(--surface-border)" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.2rem", color: "var(--text-main)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Settings2 size={18} /> {t("policy_change_title")}
            </h2>
            <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontSize: "0.9rem" }}>
              {t("policy_selected_count", { count: selectedImsis.length })}
            </p>
          </div>
          <button className="btn-icon" onClick={onClose} title={t("close")}><X size={22} /></button>
        </div>

        <div style={{ padding: "1.5rem", display: "grid", gap: "1.25rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.25fr) minmax(220px, 0.75fr)", gap: "1rem" }}>
            <div>
              <label className="form-label">{t("policy_change_plan")}</label>
              <select className="form-input" value={planId} onChange={(event) => setPlanId(event.target.value)}>
                {planOptions.length === 0 ? (
                  <option value="plan_default_10gb">plan_default_10gb</option>
                ) : planOptions.map((plan) => (
                  <option key={plan.plan_id} value={plan.plan_id}>{plan.name || plan.plan_id}</option>
                ))}
              </select>
              <div style={{ marginTop: "0.5rem", color: "var(--text-muted)", fontSize: "0.82rem", lineHeight: 1.5 }}>
                {selectedPlan?.description || t("policy_change_default_plan_desc")}
              </div>
            </div>

            <div>
              <label className="form-label">{t("policy_change_status")}</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                {statusOptions.map((option) => {
                  const Icon = option.icon;
                  const active = status === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={active ? "btn btn-primary" : "btn btn-outline"}
                      style={{ justifyContent: "center", minHeight: 40 }}
                      onClick={() => setStatus(option.value)}
                    >
                      <Icon size={15} /> {t(option.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <label
            style={{
              border: "1px solid var(--surface-border)",
              borderRadius: 8,
              padding: "0.9rem",
              background: resetBalances ? "rgba(59, 130, 246, 0.08)" : "var(--surface-hover)",
              display: "grid",
              gridTemplateColumns: "24px minmax(0, 1fr)",
              gap: "0.75rem",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              className="checkbox-custom"
              checked={resetBalances}
              onChange={(event) => setResetBalances(event.target.checked)}
            />
            <span>
              <span style={{ display: "flex", alignItems: "center", gap: "0.45rem", color: "var(--text-main)", fontWeight: 700 }}>
                <RotateCcw size={15} /> {t("policy_change_reset_balances")}
              </span>
              <span style={{ display: "block", marginTop: "0.25rem", color: "var(--text-muted)", fontSize: "0.82rem", lineHeight: 1.5 }}>
                {t("policy_change_reset_desc")}
              </span>
            </span>
          </label>

          <div style={{ border: "1px solid var(--surface-border)", borderRadius: 8, padding: "0.9rem", background: "rgba(16, 185, 129, 0.08)" }}>
            <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.5rem" }}>{t("policy_change_preview")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.75rem" }}>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>IMSI</div>
                <div style={{ color: "var(--text-main)", fontFamily: "monospace", fontWeight: 700, whiteSpace: "normal", wordBreak: "break-all" }}>
                  {selectedPreview.join(", ")}{selectedImsis.length > selectedPreview.length ? ` +${selectedImsis.length - selectedPreview.length}` : ""}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>{t("policy_change_plan")}</div>
                <div style={{ color: "var(--text-main)", fontWeight: 700 }}>{planId}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>{t("policy_change_status")}</div>
                <div style={{ color: "var(--text-main)", fontWeight: 700 }}>{status === "active" ? t("policy_status_active") : t("policy_status_suspended")}</div>
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

        <div className="workflow-footer" style={{ padding: "1rem 1.5rem", borderTop: "1px solid var(--surface-border)" }}>
          <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t("policy_change_subtitle")}</span>
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
