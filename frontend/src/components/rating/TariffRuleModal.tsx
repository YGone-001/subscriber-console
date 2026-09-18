"use client";
import React, { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Pencil, Save, X, AlertTriangle, AlertCircle } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { Field } from "@/components/ui/Field";
import { ErrorNotice, InlineNotice } from "@/components/ui/InlineNotice";
import * as T from "./types";
import { CURRENCIES, defaultsFor } from "./types";
import { Dialog } from "@/components/ui/Dialog";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  planId: string;
  existingRules: T.RatingPolicy[];
  initialRule: T.RatingPolicy | null;
  onSuccess: () => void;
};

export function TariffRuleModal({
  isOpen,
  onClose,
  planId,
  existingRules,
  initialRule,
  onSuccess,
}: Props) {
  const { t } = useI18n();
  const isEdit = !!initialRule;

  const [ruleId, setRuleId] = useState("");
  const [apn, setApn] = useState("internet");
  const [ratingGroupId, setRatingGroupId] = useState("100");
  const [serviceIdentifier, setServiceIdentifier] = useState("1");
  const [chargingType, setChargingType] = useState<T.ChargingType>("data_volume");
  const [ratesType, setRatesType] = useState(2);
  const [rates, setRates] = useState("0");
  const [currency, setCurrency] = useState("USD");
  const [quotaPerGrant, setQuotaPerGrant] = useState("10485760");
  const [validityTime, setValidityTime] = useState("300");
  const [volumeThreshold, setVolumeThreshold] = useState("8388608");
  const [priority, setPriority] = useState(0);
  const [status, setStatus] = useState("active");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (initialRule) {
      setRuleId(initialRule.rule_id || `rule_${initialRule.rating_group_id}`);
      setApn(initialRule.apn || "internet");
      setRatingGroupId(String(initialRule.rating_group_id ?? "100"));
      setServiceIdentifier(String(initialRule.service_identifier ?? "1"));
      const cType = (initialRule.charging_type || "data_volume") as T.ChargingType;
      setChargingType(cType);
      setRatesType(Number(initialRule.rates_type) || 2);
      setRates(initialRule.rates || "0");
      setCurrency(initialRule.currency || "USD");
      setQuotaPerGrant(String(initialRule.quota_per_grant ?? "10485760"));
      setValidityTime(String(initialRule.validity_time ?? "300"));
      setVolumeThreshold(String(initialRule.volume_threshold ?? "8388608"));
      setPriority(Number(initialRule.priority ?? 0));
      setStatus(initialRule.status || "active");
      setError(null);
    } else {
      // New rule defaults
      const defaults = defaultsFor("data_volume");
      setRuleId(`rule_${Date.now().toString().slice(-4)}`);
      setApn(defaults.apn);
      setRatingGroupId("100");
      setServiceIdentifier(defaults.service_identifier);
      setChargingType("data_volume");
      setRatesType(defaults.rates_type);
      setRates("0");
      setCurrency("USD");
      setQuotaPerGrant(defaults.quota_per_grant);
      setValidityTime(defaults.validity_time);
      setVolumeThreshold(defaults.volume_threshold);
      setPriority(0);
      setStatus("active");
      setError(null);
    }
  }, [initialRule, isOpen]);

  const handleChargingTypeChange = (newType: T.ChargingType) => {
    setChargingType(newType);
    const defaults = defaultsFor(newType);
    setRatesType(defaults.rates_type);
    setApn(defaults.apn);
    setServiceIdentifier(defaults.service_identifier);
    setQuotaPerGrant(defaults.quota_per_grant);
    setValidityTime(defaults.validity_time);
    setVolumeThreshold(defaults.volume_threshold);
  };

  // Conflict detection
  const conflictWith = useMemo(() => {
    const targetApn = apn.trim().toLowerCase();
    const targetRg = Number(ratingGroupId);
    const targetSi = Number(serviceIdentifier);

    return existingRules.find((r) => {
      if (isEdit && r.rule_id === (initialRule?.rule_id || `rule_${initialRule?.rating_group_id}`)) {
        return false;
      }
      return (
        (r.apn || "internet").toLowerCase() === targetApn &&
        Number(r.rating_group_id) === targetRg &&
        Number(r.service_identifier ?? 1) === targetSi
      );
    });
  }, [apn, ratingGroupId, serviceIdentifier, existingRules, isEdit, initialRule]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleId.trim()) {
      setError("Rule ID is required");
      return;
    }
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(apn.trim())) {
      setError(t("rating_err_apn"));
      return;
    }

    setLoading(true);
    setError(null);

    const payload = {
      rule_id: ruleId.trim(),
      apn: apn.trim(),
      rating_group_id: Number(ratingGroupId),
      service_identifier: Number(serviceIdentifier),
      charging_type: chargingType,
      rates_type: ratesType,
      rates: rates.trim(),
      currency: currency.trim(),
      quota_per_grant: Number(quotaPerGrant),
      validity_time: Number(validityTime),
      volume_threshold: Number(volumeThreshold),
      priority: Number(priority),
      status,
    };

    try {
      const url = isEdit
        ? `/api/tariff-plans/${encodeURIComponent(planId)}/rules/${encodeURIComponent(initialRule?.rule_id || ruleId.trim())}`
        : `/api/tariff-plans/${encodeURIComponent(planId)}/rules`;
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to save rule");
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to save rule");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={() => { if (!loading) onClose(); }}
      overlayClassName="modal-overlay animate-fade-in"
      className="modal-content"
      overlayStyle={{ zIndex: 1050 }}
      style={{ maxWidth: 640 }}
      labelledBy="tariff-rule-modal-title"
      initialFocusRef={cancelButtonRef}
      closeOnOverlay={!loading}
    >
        <div className="modal-header">
          <div className="flex-center-gap-0-55">
            {isEdit ? <Pencil size={20} color="var(--primary)" /> : <Plus size={20} color="var(--primary)" />}
            <h2 id="tariff-rule-modal-title" className="modal-title">{isEdit ? t("tariff_rule_edit") : t("tariff_rule_add")}</h2>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} disabled={loading} aria-label={t("close")}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body grid-gap-1">
            {error && (
              <ErrorNotice icon={<AlertCircle size={16} />}>{error}</ErrorNotice>
            )}

            {conflictWith && (
              <InlineNotice tone="warning" icon={<AlertTriangle size={18} />}>
                <div>
                  <strong>{t("tariff_rule_conflict_warning")}</strong>: Matches existing rule (<code>{conflictWith.rule_id || `RG ${conflictWith.rating_group_id}`}</code>). xCloud OCS will evaluate based on rule priority.
                </div>
              </InlineNotice>
            )}

            <div className="fields-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Field label="Rule ID">
                <input
                  type="text"
                  className="form-input"
                  value={ruleId}
                  onChange={(e) => setRuleId(e.target.value)}
                  placeholder="e.g. rule_data_standard"
                  required
                  disabled={loading}
                />
              </Field>

              <Field label={t("rating_charging_scenario")}>
                <select
                  className="form-input"
                  value={chargingType}
                  onChange={(e) => handleChargingTypeChange(e.target.value as T.ChargingType)}
                  disabled={loading}
                >
                  <option value="data_volume">{t("rating_service_data")}</option>
                  <option value="voice_time">{t("rating_service_voice")}</option>
                  <option value="sms_event">{t("rating_service_sms")}</option>
                  <option value="free">{t("rating_service_ims")}</option>
                </select>
              </Field>

              <Field label="APN / DNN">
                <input
                  type="text"
                  className="form-input"
                  value={apn}
                  onChange={(e) => setApn(e.target.value)}
                  placeholder="internet / ims / *"
                  required
                  disabled={loading}
                />
              </Field>

              <Field label={t("rating_col_id")}>
                <input
                  type="number"
                  className="form-input"
                  value={ratingGroupId}
                  onChange={(e) => setRatingGroupId(e.target.value)}
                  placeholder="100"
                  required
                  disabled={loading}
                />
              </Field>

              <Field label="Service Identifier (SI)">
                <input
                  type="number"
                  className="form-input"
                  value={serviceIdentifier}
                  onChange={(e) => setServiceIdentifier(e.target.value)}
                  placeholder="1"
                  required
                  disabled={loading}
                />
              </Field>

              <Field label="Rule Priority (0-100)">
                <input
                  type="number"
                  className="form-input"
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  min={0}
                  max={100}
                  disabled={loading}
                />
              </Field>

              <Field label={t("rating_col_rates")}>
                <input
                  type="text"
                  className="form-input"
                  value={rates}
                  onChange={(e) => setRates(e.target.value)}
                  placeholder="0.00"
                  required
                  disabled={loading}
                />
              </Field>

              <Field label={t("rating_col_currency")}>
                <select
                  className="form-input"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  disabled={loading}
                >
                  {CURRENCIES.map((curr) => (
                    <option key={curr} value={curr}>
                      {curr}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t("tariff_plan_quota_grant")}>
                <input
                  type="number"
                  className="form-input"
                  value={quotaPerGrant}
                  onChange={(e) => setQuotaPerGrant(e.target.value)}
                  placeholder="10485760"
                  disabled={loading}
                />
              </Field>

              <Field label={t("tariff_plan_validity_time")}>
                <input
                  type="number"
                  className="form-input"
                  value={validityTime}
                  onChange={(e) => setValidityTime(e.target.value)}
                  placeholder="300"
                  disabled={loading}
                />
              </Field>

              <Field label={t("tariff_plan_vol_threshold")}>
                <input
                  type="number"
                  className="form-input"
                  value={volumeThreshold}
                  onChange={(e) => setVolumeThreshold(e.target.value)}
                  placeholder="8388608"
                  disabled={loading}
                />
              </Field>

              <Field label={t("tariff_plan_status")}>
                <select
                  className="form-input"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={loading}
                >
                  <option value="active">{t("policy_status_active")}</option>
                  <option value="disabled">{t("users_disabled")}</option>
                </select>
              </Field>
            </div>
          </div>

          <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", padding: "1rem 1.5rem" }}>
            <button ref={cancelButtonRef} type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>
              {t("cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Save size={15} /> {loading ? t("saving") : t("save")}
            </button>
          </div>
        </form>
    </Dialog>
  );
}
