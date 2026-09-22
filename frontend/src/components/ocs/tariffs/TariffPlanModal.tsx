"use client";

import { useState, useEffect } from "react";
import { AlertCircle, X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import type { TariffPlan } from "@/lib/api/ocs";

interface TariffPlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  plan?: TariffPlan | null;
  onSuccess: (result: { outcome: string; message: string }) => void;
}

export default function TariffPlanModal({
  isOpen,
  onClose,
  plan,
  onSuccess,
}: TariffPlanModalProps) {
  const { t } = useI18n();

  const isEdit = Boolean(plan);
  const [planId, setPlanId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [quotaPerGrant, setQuotaPerGrant] = useState("104857600");
  const [validityTime, setValidityTime] = useState("86400");
  const [volumeThreshold, setVolumeThreshold] = useState("10485760");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan) {
      setPlanId(plan.plan_id);
      setName(plan.name || "");
      setDescription(plan.description || "");
      setQuotaPerGrant(String(plan.quota_per_grant ?? 104857600));
      setValidityTime(String(plan.validity_time ?? 86400));
      setVolumeThreshold(String(plan.volume_threshold ?? 10485760));
    } else {
      setPlanId("");
      setName("");
      setDescription("");
      setQuotaPerGrant("104857600");
      setValidityTime("86400");
      setVolumeThreshold("10485760");
    }
    setError(null);
  }, [plan, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedPlanId = planId.trim();
    const trimmedName = name.trim();

    if (!isEdit && !trimmedPlanId) {
      setError(t("ocs_tariff_plan_id_required"));
      return;
    }

    if (!trimmedName) {
      setError(t("ocs_tariff_name_required"));
      return;
    }

    setSubmitting(true);
    try {
      const url = isEdit ? `/api/tariff-plans/${encodeURIComponent(trimmedPlanId)}` : "/api/tariff-plans";
      const method = isEdit ? "PUT" : "POST";

      const payload: Record<string, unknown> = {
        name: trimmedName,
        description: description.trim(),
        quota_per_grant: Number(quotaPerGrant) || 0,
        validity_time: Number(validityTime) || 0,
        volume_threshold: Number(volumeThreshold) || 0,
      };

      if (!isEdit) {
        payload.plan_id = trimmedPlanId;
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.message || t("ocs_tariff_action_failed"));
        return;
      }

      onSuccess({
        outcome: data.outcome || "success",
        message: t("ocs_tariff_action_success"),
      });
      onClose();
    } catch {
      setError(t("ocs_tariff_action_failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="ocs-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tariff-plan-modal-title"
      onClick={onClose}
    >
      <div className="ocs-modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="ocs-modal-header">
          <div>
            <h2 id="tariff-plan-modal-title" className="ocs-modal-title">
              {isEdit ? t("ocs_tariff_modal_edit_title") : t("ocs_tariff_modal_create_title")}
            </h2>
            <p className="ocs-modal-subtitle">{t("ocs_tariff_modal_desc")}</p>
          </div>
          <button
            type="button"
            className="ocs-modal-close"
            onClick={onClose}
            aria-label={t("close")}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="ocs-modal-body">
            {error && (
              <div className="ocs-feedback-error" style={{ marginBottom: "1rem" }}>
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}

            <div className="ocs-form-group">
              <label htmlFor="tariff-plan-id" className="ocs-form-label">
                {t("ocs_tariff_col_plan_id")} *
              </label>
              <input
                id="tariff-plan-id"
                type="text"
                className="ocs-form-input ocs-mono"
                value={planId}
                disabled={isEdit || submitting}
                onChange={(e) => setPlanId(e.target.value)}
                placeholder="e.g. plan_standard_5g"
                required
              />
            </div>

            <div className="ocs-form-group">
              <label htmlFor="tariff-plan-name" className="ocs-form-label">
                {t("ocs_tariff_col_name")} *
              </label>
              <input
                id="tariff-plan-name"
                type="text"
                className="ocs-form-input"
                value={name}
                disabled={submitting}
                onChange={(e) => setName(e.target.value)}
                placeholder="Standard 5G Unlimited"
                required
              />
            </div>

            <div className="ocs-form-group">
              <label htmlFor="tariff-plan-desc" className="ocs-form-label">
                {t("ocs_tariff_col_status")} / {t("ocs_balance_reason")}
              </label>
              <textarea
                id="tariff-plan-desc"
                className="ocs-form-textarea"
                rows={2}
                value={description}
                disabled={submitting}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description of plan and charging characteristics"
              />
            </div>

            <div className="ocs-form-group">
              <label htmlFor="tariff-quota-grant" className="ocs-form-label">
                {t("ocs_tariff_quota_per_grant")}
              </label>
              <input
                id="tariff-quota-grant"
                type="number"
                className="ocs-form-input ocs-mono"
                value={quotaPerGrant}
                disabled={submitting}
                onChange={(e) => setQuotaPerGrant(e.target.value)}
                min="0"
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="ocs-form-group">
                <label htmlFor="tariff-validity" className="ocs-form-label">
                  {t("ocs_tariff_validity_time")}
                </label>
                <input
                  id="tariff-validity"
                  type="number"
                  className="ocs-form-input ocs-mono"
                  value={validityTime}
                  disabled={submitting}
                  onChange={(e) => setValidityTime(e.target.value)}
                  min="0"
                />
              </div>

              <div className="ocs-form-group">
                <label htmlFor="tariff-threshold" className="ocs-form-label">
                  {t("ocs_tariff_volume_threshold")}
                </label>
                <input
                  id="tariff-threshold"
                  type="number"
                  className="ocs-form-input ocs-mono"
                  value={volumeThreshold}
                  disabled={submitting}
                  onChange={(e) => setVolumeThreshold(e.target.value)}
                  min="0"
                />
              </div>
            </div>
          </div>

          <div className="ocs-modal-footer">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              className="ocs-btn ocs-btn-primary"
              disabled={submitting}
            >
              {submitting ? t("saving") : t("confirm")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
