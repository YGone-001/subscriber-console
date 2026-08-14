"use client";
import React, { useState, useEffect } from "react";
import { Copy, X, AlertCircle } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { Field } from "@/components/ui/Field";
import { ErrorNotice } from "@/components/ui/InlineNotice";
import * as T from "./types";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  sourcePlan: T.TariffPlan | null;
  onSuccess: (newPlanId: string) => void;
};

export function TariffPlanCloneModal({ isOpen, onClose, sourcePlan, onSuccess }: Props) {
  const { t } = useI18n();
  const [targetPlanId, setTargetPlanId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sourcePlan) {
      setTargetPlanId(`${sourcePlan.plan_id}_copy`);
      setName(`${sourcePlan.name || sourcePlan.plan_id} (Copy)`);
      setDescription(sourcePlan.description || "");
      setError(null);
    }
  }, [sourcePlan, isOpen]);

  if (!isOpen || !sourcePlan) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(targetPlanId.trim())) {
      setError(t("tariff_plan_err_id"));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/tariff-plans/${encodeURIComponent(sourcePlan.plan_id)}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetPlanId: targetPlanId.trim(),
          name: name.trim(),
          description: description.trim(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || t("tariff_plan_err_create"));
      }

      onSuccess(targetPlanId.trim());
      onClose();
    } catch (err: any) {
      setError(err.message || t("tariff_plan_err_create"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay animate-fade-in" style={{ zIndex: 1050 }}>
      <div className="modal-content" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <div className="flex-center-gap-0-55">
            <Copy size={20} color="var(--primary)" />
            <h3 className="modal-title">{t("tariff_plan_clone_title")}</h3>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} disabled={loading}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body grid-gap-1">
            <p className="card-desc" style={{ margin: 0 }}>
              {t("tariff_plan_clone_desc")}
            </p>

            <div className="stat-card" style={{ padding: "0.75rem 1rem", background: "var(--bg-secondary)", borderRadius: "8px" }}>
              <span className="text-muted" style={{ fontSize: "0.85rem" }}>Source: </span>
              <strong>{sourcePlan.name || sourcePlan.plan_id}</strong>
              <span className="text-muted" style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}>({sourcePlan.plan_id})</span>
            </div>

            {error && (
              <ErrorNotice icon={<AlertCircle size={16} />}>{error}</ErrorNotice>
            )}

            <Field label={t("tariff_plan_clone_target_id")}>
              <input
                type="text"
                className="form-input"
                value={targetPlanId}
                onChange={(e) => setTargetPlanId(e.target.value)}
                placeholder="e.g. plan_premium_50gb"
                required
                disabled={loading}
              />
            </Field>

            <Field label={t("tariff_plan_clone_target_name")}>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Premium 50GB Tier"
                required
                disabled={loading}
              />
            </Field>

            <Field label={t("tariff_plan_desc")}>
              <textarea
                className="form-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Plan description and tier details..."
                rows={2}
                disabled={loading}
              />
            </Field>
          </div>

          <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", padding: "1rem 1.5rem" }}>
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>
              {t("cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading || !targetPlanId.trim()}>
              <Copy size={15} /> {loading ? t("saving") : t("tariff_plan_clone_btn")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
