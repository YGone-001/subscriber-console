"use client";

import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { ArrowRightLeft, CheckCircle2, Database, DollarSign, Hash, History, MessageSquare, Mic2, Pencil, Plus, Save, Search, ShieldCheck, Tag, Trash2, X } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import { ConfirmActionPanel, EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";


import { TariffPlanList } from "./rating/TariffPlanList";
import { PccRuleList } from "./rating/PccRuleList";
import { RatingModals } from "./rating/RatingModals";
import { StatusBadge, formatDateTime } from "./rating/RatingManagementShared";
import * as T from "./rating/types";
import { classifyPolicy, applyChargingType, formatGrant, makeDefaultForm, defaultsFor, CURRENCIES, DEFAULT_OCS_PLAN_ID, DATA_GRANT, DATA_THRESHOLD, VOICE_GRANT, SMS_GRANT, SERVICE_FILTERS, Field } from "./rating/types";



function isWholeNumber(value: string): boolean {
  return /^\d+$/.test(String(value || "").trim());
}

export default function RatingManagementPage({ view }: { view: T.RatingManagementView }) {
  const { t } = useI18n();
  const { data: plansData, mutate: mutatePlans } = useSWR("/api/tariff-plans", fetcher);
  const plans: T.TariffPlan[] = useMemo(() => plansData?.plans || [], [plansData?.plans]);
  const [selectedPlanId, setSelectedPlanId] = useState("plan_default_10gb");
  const ratingsUrl = `/api/ratings?planId=${encodeURIComponent(selectedPlanId)}`;
  const planSubscribersUrl = selectedPlanId ? `/api/tariff-plans/${encodeURIComponent(selectedPlanId)}/subscribers?limit=5` : null;
  const planOperationsUrl = selectedPlanId ? `/api/tariff-plans/${encodeURIComponent(selectedPlanId)}/operations?limit=8` : null;
  const { data, isLoading, mutate } = useSWR(ratingsUrl, fetcher);
  const { data: planSubscribersData, mutate: mutatePlanSubscribers } = useSWR<T.PlanSubscriberPreview>(planSubscribersUrl, fetcher);
  const { data: planOperationsData, mutate: mutatePlanOperations } = useSWR<T.PlanOperationsData>(planOperationsUrl, fetcher);
  const ratings: T.RatingPolicy[] = useMemo(() => data?.ratings || [], [data?.ratings]);
  const { canEditTemplates } = useAuth();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<T.RatingForm>(makeDefaultForm());
  const [isAdding, setIsAdding] = useState(false);
  const [newForm, setNewForm] = useState<T.RatingForm>(makeDefaultForm());
  const [filter, setFilter] = useState<T.ServiceKey>("all");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<T.Notice | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [isCreatingPlan, setIsCreatingPlan] = useState(false);
  const [planForm, setPlanForm] = useState<T.PlanForm>({ plan_id: "", name: "", description: "", status: "active" });
  const [migrationTargetPlanId, setMigrationTargetPlanId] = useState("");
  const [migrationResetBalances, setMigrationResetBalances] = useState(false);

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.plan_id === selectedPlanId),
    [plans, selectedPlanId]
  );
  const migrationTargetOptions = useMemo(
    () => plans.filter((plan) => plan.plan_id !== selectedPlanId && (plan.status || "active") === "active"),
    [plans, selectedPlanId]
  );
  const selectedPlanSubscribers = planSubscribersData?.subscribers || [];
  const selectedPlanSubscriberTotal = planSubscribersData?.total ?? selectedPlan?.subscriberCount ?? 0;
  const planOperationSummary = planOperationsData?.summary;
  const planOperationHistory = planOperationsData?.history || [];
  const isDisablingPlanWithSubscribers =
    !isCreatingPlan &&
    !!selectedPlan &&
    (selectedPlan.status || "active") !== "disabled" &&
    planForm.status === "disabled" &&
    selectedPlanSubscriberTotal > 0;

  useEffect(() => {
    if (plans.length > 0 && !plans.some((plan) => plan.plan_id === selectedPlanId)) {
      setSelectedPlanId(plans[0].plan_id);
    }
  }, [plans, selectedPlanId]);

  useEffect(() => {
    if (!selectedPlan || isCreatingPlan) return;
    setPlanForm({
      plan_id: selectedPlan.plan_id,
      name: selectedPlan.name || selectedPlan.plan_id,
      description: selectedPlan.description || "",
      status: selectedPlan.status || "active",
    });
  }, [isCreatingPlan, selectedPlan]);

  useEffect(() => {
    if (migrationTargetOptions.length === 0) {
      setMigrationTargetPlanId("");
      return;
    }
    setMigrationTargetPlanId((current: any) =>
      migrationTargetOptions.some((plan) => plan.plan_id === current)
        ? current
        : migrationTargetOptions[0].plan_id
    );
  }, [migrationTargetOptions]);

  const rateTypes = useMemo(() => [
    { label: t("rating_type_time"), val: 1 },
    { label: t("rating_type_vol"), val: 2 },
    { label: t("rating_type_event"), val: 3 },
    { label: t("rating_type_flat"), val: 4 },
  ], [t]);

  const formatCurrency = (currency: string) => {
    const translated = t(`currency_${currency}`);
    return translated && translated !== `currency_${currency}` ? `${currency} (${translated})` : currency;
  };

  const serviceMeta = (key: T.ServiceKey | Exclude<T.ServiceKey, "all">) => {
    if (key === "voice") return { label: t("rating_service_voice"), icon: <Mic2 size={16} />, color: "var(--warning, #f59e0b)" };
    if (key === "sms") return { label: t("rating_service_sms"), icon: <MessageSquare size={16} />, color: "#8b5cf6" };
    if (key === "ims") return { label: t("rating_service_ims"), icon: <ShieldCheck size={16} />, color: "var(--success)" };
    if (key === "data") return { label: t("rating_service_data"), icon: <Database size={16} />, color: "var(--primary)" };
    return { label: t("rating_service_all"), icon: <Tag size={16} />, color: "var(--text-main)" };
  };

  const enrichedRatings = useMemo(() => ratings.map((rating) => ({
    ...rating,
    serviceKey: classifyPolicy(rating),
  })), [ratings]);

  const visibleRatings = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return enrichedRatings.filter((rating) => {
      if (filter !== "all" && rating.serviceKey !== filter) return false;
      if (!needle) return true;
      return [
        rating.rating_group_id,
        rating.rule_id,
        rating.apn,
        rating.charging_type,
        rating.service_identifier,
      ].some((value) => String(value ?? "").toLowerCase().includes(needle));
    });
  }, [enrichedRatings, filter, query]);

  const counts = useMemo(() => ({
    all: enrichedRatings.length,
    data: enrichedRatings.filter((rating) => rating.serviceKey === "data").length,
    voice: enrichedRatings.filter((rating) => rating.serviceKey === "voice").length,
    sms: enrichedRatings.filter((rating) => rating.serviceKey === "sms").length,
    ims: enrichedRatings.filter((rating) => rating.serviceKey === "ims").length,
  }), [enrichedRatings]);

  const validateRatingForm = (form: T.RatingForm, isNew: boolean): string | null => {
    if (isNew && !isWholeNumber(form.rating_group_id)) return t("rating_err_id_required");
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(form.apn.trim())) return t("rating_err_apn");
    if (!isWholeNumber(form.service_identifier)) return t("rating_err_si");
    if (form.rates.trim() === "" || !Number.isFinite(Number(form.rates)) || Number(form.rates) < 0) return t("rating_err_rate");
    if (!isWholeNumber(form.quota_per_grant)) return t("rating_err_grant");
    if (!isWholeNumber(form.validity_time)) return t("rating_err_validity");
    if (!isWholeNumber(form.volume_threshold)) return t("rating_err_threshold");
    return null;
  };

  const noticeForRatingResponse = (data: any, fallback: string) => {
    if (data?.approval?.id) return t("approval_msg_submitted", { id: data.approval.id });
    return fallback;
  };

  const beginCreatePlan = () => {
    setIsCreatingPlan(true);
    setPlanForm({
      plan_id: `${selectedPlanId}_copy`,
      name: selectedPlan ? `${selectedPlan.name || selectedPlan.plan_id} Copy` : "",
      description: selectedPlan?.description || "",
      status: "active",
    });
  };

  const handleCreatePlan = async () => {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(planForm.plan_id.trim())) {
      setNotice({ type: "error", text: t("tariff_plan_err_id") });
      return;
    }
    setSavingKey("plan:create");
    setNotice(null);
    try {
      const res = await fetch("/api/tariff-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...planForm,
          plan_id: planForm.plan_id.trim(),
          cloneFromPlanId: selectedPlanId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t("tariff_plan_err_create"));
      await mutatePlans();
      await mutatePlanOperations();
      setSelectedPlanId(data.plan?.plan_id || planForm.plan_id.trim());
      setIsCreatingPlan(false);
      setNotice({ type: "success", text: t("tariff_plan_msg_created") });
    } catch (error: any) {
      setNotice({ type: "error", text: error.message || t("tariff_plan_err_create") });
    } finally {
      setSavingKey(null);
    }
  };

  const handleUpdatePlan = async () => {
    if (!selectedPlan) return;
    if (isDisablingPlanWithSubscribers) {
      setNotice({ type: "error", text: t("tariff_plan_disable_in_use") });
      return;
    }
    setSavingKey("plan:update");
    setNotice(null);
    try {
      const res = await fetch(`/api/tariff-plans/${encodeURIComponent(selectedPlan.plan_id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(messageForPlanResponse(data, t("tariff_plan_err_update")));
      await mutatePlans();
      await mutatePlanOperations();
      setNotice({ type: "success", text: t("tariff_plan_msg_updated") });
    } catch (error: any) {
      setNotice({ type: "error", text: error.message || t("tariff_plan_err_update") });
    } finally {
      setSavingKey(null);
    }
  };

  const handleDeletePlan = async () => {
    if (!selectedPlan || selectedPlan.isDefault) return;
    setSavingKey("plan:delete");
    setNotice(null);
    try {
      const res = await fetch(`/api/tariff-plans/${encodeURIComponent(selectedPlan.plan_id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t("tariff_plan_err_delete"));
      await mutatePlans();
      setSelectedPlanId("plan_default_10gb");
      setNotice({ type: "success", text: t("tariff_plan_msg_deleted") });
    } catch (error: any) {
      setNotice({ type: "error", text: error.message || t("tariff_plan_err_delete") });
    } finally {
      setSavingKey(null);
    }
  };

  const formatPlanOperationAction = (action: string) => {
    const key = `audit_action_${action}`;
    const label = t(key);
    return label === key ? action : label;
  };

  const messageForPlanResponse = (data: any, fallback: string) => {
    if (data?.error === "Tariff plan not found") return t("tariff_plan_err_not_found");
    if (data?.error === "Invalid plan_id format") return t("tariff_plan_err_id");
    if (data?.error === "Tariff plan is disabled") return t("tariff_plan_err_disabled");
    if (data?.error === "Cannot disable: tariff plan is currently used by subscribers") return t("tariff_plan_disable_in_use");
    if (data?.error === "Source and target tariff plan must be different") return t("tariff_plan_migrate_err_same");
    if (data?.approval?.id) return t("approval_msg_submitted", { id: data.approval.id });
    return data?.error || fallback;
  };

  const handleMigratePlanSubscribers = async () => {
    if (!selectedPlan || !migrationTargetPlanId) return;
    setSavingKey("plan:migrate");
    setNotice(null);
    try {
      const res = await fetch(`/api/tariff-plans/${encodeURIComponent(selectedPlan.plan_id)}/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetPlanId: migrationTargetPlanId,
          resetBalances: migrationResetBalances,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(messageForPlanResponse(data, t("tariff_plan_migrate_err")));
      await mutatePlans();
      await mutatePlanSubscribers();
      await mutatePlanOperations();
      setNotice({ type: "success", text: messageForPlanResponse(data, t("tariff_plan_migrate_msg")) });
    } catch (error: any) {
      setNotice({ type: "error", text: error.message || t("tariff_plan_migrate_err") });
    } finally {
      setSavingKey(null);
    }
  };

  const handleCreate = async () => {
    const validationError = validateRatingForm(newForm, true);
    if (validationError) {
      setNotice({ type: "error", text: validationError });
      return;
    }
    setSavingKey("new");
    setNotice(null);
    try {
      const res = await fetch("/api/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newForm, planId: selectedPlanId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setIsAdding(false);
          setNewForm(makeDefaultForm());
        if (!data?.approval?.id) mutate();
        setNotice({ type: "success", text: noticeForRatingResponse(data, t("rating_msg_created")) });
      } else {
        setNotice({ type: "error", text: data.error || t("rating_err_create") });
      }
    } catch (error) {
      console.error("Create failed", error);
      setNotice({ type: "error", text: t("rating_err_create") });
    } finally {
      setSavingKey(null);
    }
  };

  const handleUpdate = async (id: number) => {
    const validationError = validateRatingForm(editForm, false);
    if (validationError) {
      setNotice({ type: "error", text: validationError });
      return;
    }
    setSavingKey(String(id));
    setNotice(null);
    try {
      const res = await fetch(`/api/ratings/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...editForm, planId: selectedPlanId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setEditingId(null);
        if (!data?.approval?.id) mutate();
        setNotice({ type: "success", text: noticeForRatingResponse(data, t("rating_msg_updated")) });
      } else {
        setNotice({ type: "error", text: data.error || t("rating_err_update") });
      }
    } catch (error) {
      console.error("Update failed", error);
      setNotice({ type: "error", text: t("rating_err_update") });
    } finally {
      setSavingKey(null);
    }
  };

  const handleDelete = (id: number) => {
    setPendingDeleteId(id);
    setNotice(null);
  };

  const executeDelete = async () => {
    if (pendingDeleteId == null) return;
    const id = pendingDeleteId;
    setSavingKey(`delete:${id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/ratings/${id}?planId=${encodeURIComponent(selectedPlanId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPendingDeleteId(null);
        if (!data?.approval?.id) await mutate();
        setNotice({ type: "success", text: noticeForRatingResponse(data, t("rating_msg_deleted")) });
      } else {
        setNotice({ type: "error", text: data.error || t("rating_err_delete") });
      }
    } catch (error) {
      console.error("Delete failed", error);
      setNotice({ type: "error", text: t("rating_err_delete") });
    } finally {
      setSavingKey(null);
    }
  };

  const startEdit = (rating: T.RatingPolicy) => {
    setNotice(null);
    const chargingType = (rating.charging_type || "data_volume") as T.ChargingType;
    setEditingId(rating.rating_group_id);
    setEditForm({
      rating_group_id: String(rating.rating_group_id),
      currency: rating.currency || "USD",
      rates: rating.rates || "0",
      rates_type: Number(rating.rates_type) || defaultsFor(chargingType).rates_type,
      charging_type: chargingType,
      apn: rating.apn || defaultsFor(chargingType).apn,
      service_identifier: String(rating.service_identifier ?? defaultsFor(chargingType).service_identifier),
      quota_per_grant: String(rating.quota_per_grant ?? defaultsFor(chargingType).quota_per_grant),
      validity_time: String(rating.validity_time ?? defaultsFor(chargingType).validity_time),
      volume_threshold: String(rating.volume_threshold ?? defaultsFor(chargingType).volume_threshold),
    });
  };

  const renderFormCells = (form: T.RatingForm, setForm: React.Dispatch<React.SetStateAction<T.RatingForm>>, isNew: boolean, ratingGroupId?: number) => {
    const validationMessage = validateRatingForm(form, isNew);
    const formKey = isNew ? "new" : String(ratingGroupId || "");
    const isSaving = savingKey === formKey;

    return (
    <td colSpan={canEditTemplates ? 6 : 5} className="rating-form-cell">
      <div className="rating-form-grid">
        <div className={`rating-form-id-col ${isNew ? 'rating-form-id-col-new' : 'rating-form-id-col-edit'}`}>
          {isNew ? (
            <Field label={t("rating_col_id")}>
              <input type="number" className="form-input" placeholder={t("rating_ph_id")} value={form.rating_group_id} onChange={(event) => setForm((current: any) => ({ ...current, rating_group_id: event.target.value }))} autoFocus />
            </Field>
          ) : (
            <span className="rating-form-id-display">#{ratingGroupId}</span>
          )}
        </div>
        <div className="rating-form-type-col">
          <Field label={t("rating_charging_scenario")}>
            <select className="form-input" value={form.charging_type} onChange={(event) => setForm((current: any) => applyChargingType(current, event.target.value as T.ChargingType))}>
              <option value="data_volume">{t("rating_service_data")}</option>
              <option value="voice_time">{t("rating_service_voice")}</option>
              <option value="sms_event">{t("rating_service_sms")}</option>
              <option value="free">{t("rating_service_ims")}</option>
            </select>
          </Field>
          <Field label={t("rating_col_type")}>
            <select className="form-input" value={form.rates_type} onChange={(event) => setForm((current: any) => ({ ...current, rates_type: Number(event.target.value) }))}>
              {rateTypes.map((type) => <option key={type.val} value={type.val}>{type.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="rating-form-details-col">
          <Field label="APN">
            <input type="text" className="form-input" value={form.apn} onChange={(event) => setForm((current: any) => ({ ...current, apn: event.target.value }))} />
          </Field>
          <Field label="SI">
            <input type="number" className="form-input" value={form.service_identifier} onChange={(event) => setForm((current: any) => ({ ...current, service_identifier: event.target.value }))} />
          </Field>
          <Field label={t("rating_col_currency")}>
            <select className="form-input" value={form.currency} onChange={(event) => setForm((current: any) => ({ ...current, currency: event.target.value }))}>
              {CURRENCIES.map((currency) => <option key={currency} value={currency}>{formatCurrency(currency)}</option>)}
            </select>
          </Field>
        </div>
        <div className="rating-form-actions">
          <button className="btn-icon" onClick={isNew ? handleCreate : () => ratingGroupId && handleUpdate(ratingGroupId)} title={t("save")} disabled={isSaving}><Save size={18} color={validationMessage ? "var(--warning)" : "var(--success)"} /></button>
          <button className="btn-icon" onClick={() => isNew ? setIsAdding(false) : setEditingId(null)} title={t("cancel")} disabled={isSaving}><X size={18} color="var(--text-muted)" /></button>
        </div>
      </div>
      <div className="rating-form-limits-grid">
        <Field label={t("rating_col_rates")}>
          <input type="text" className="form-input" value={form.rates} onChange={(event) => setForm((current: any) => ({ ...current, rates: event.target.value }))} placeholder={t("rating_ph_rates")} />
        </Field>
        <Field label={t("rating_grant")}>
          <input type="number" className="form-input" value={form.quota_per_grant} onChange={(event) => setForm((current: any) => ({ ...current, quota_per_grant: event.target.value }))} />
        </Field>
        <Field label={t("rating_validity")}>
          <input type="number" className="form-input" value={form.validity_time} onChange={(event) => setForm((current: any) => ({ ...current, validity_time: event.target.value }))} />
        </Field>
        <Field label={t("rating_threshold")}>
          <input type="number" className="form-input" value={form.volume_threshold} onChange={(event) => setForm((current: any) => ({ ...current, volume_threshold: event.target.value }))} />
        </Field>
      </div>
      {validationMessage && (
        <div className="rating-form-validation">
          {validationMessage}
        </div>
      )}
    </td>
    );
  };

  const propsObj = {
  t, plans, selectedPlanId, setSelectedPlanId, isCreatingPlan, setIsCreatingPlan, 
  planForm, setPlanForm, planOperationSummary, planOperationHistory, 
  selectedPlanSubscriberTotal, selectedPlanSubscribers, canEditTemplates, savingKey, 
  migrationTargetOptions, migrationTargetPlanId, setMigrationTargetPlanId, 
  migrationResetBalances, setMigrationResetBalances, handleCreatePlan, handleUpdatePlan, 
  handleDeletePlan, handleMigratePlanSubscribers, beginCreatePlan, formatDateTime, 
  formatPlanOperationAction, selectedPlan, isDisablingPlanWithSubscribers, plansData, 
  mutatePlans, planSubscribersData, mutatePlanSubscribers, planOperationsData, mutatePlanOperations,
  filter, setFilter, query, setQuery, counts, visibleRatings, isAdding, setIsAdding, 
  newForm, setNewForm, editingId, setEditingId, editForm, setEditForm, isLoading, 
  pendingDeleteId, setPendingDeleteId, startEdit, handleDelete, renderFormCells, 
  serviceMeta, rateTypes, executeDelete, notice, setNotice, ratings
};
  return (
    <div className="container animate-fade-in rating-page-container">
      <div className="rating-page-header">
        <div>
          <h1 className="rating-page-title">
            {view === "plans" ? t("tariff_plan_current") : t("rating_rule_catalog_title")}
          </h1>
          <p className="rating-page-desc">
            {view === "plans" ? t("tariff_plan_current_desc") : t("rating_rule_catalog_desc")}
          </p>
        </div>
      </div>

      <RatingModals {...propsObj} />

      {view === "plans" && <TariffPlanList {...propsObj} />}

      {view === "rules" && <PccRuleList {...propsObj} />}
    </div>
  );
}
