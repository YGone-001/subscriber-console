"use client";

import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { ArrowRightLeft, CheckCircle2, Database, DollarSign, Hash, History, MessageSquare, Mic2, Pencil, Plus, Save, Search, ShieldCheck, Tag, Trash2, X } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import { ConfirmActionPanel, EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";

import * as T from "./rating/types";
import { classifyPolicy, applyChargingType, formatGrant, makeDefaultForm, defaultsFor, CURRENCIES, DEFAULT_OCS_PLAN_ID, DATA_GRANT, DATA_THRESHOLD, VOICE_GRANT, SMS_GRANT, SERVICE_FILTERS, Field } from "./rating/types";

function formatDateTime(value?: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
}

function StatusBadge({ tone, children }: { tone: "success" | "warning" | "muted"; children: React.ReactNode }) {
  const color = tone === "success" ? "var(--success)" : tone === "warning" ? "var(--warning)" : "var(--text-muted)";
  const background = tone === "success"
    ? "color-mix(in srgb, var(--success) 12%, var(--surface))"
    : tone === "warning"
      ? "rgba(245, 158, 11, 0.12)"
      : "var(--surface-hover)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 26, padding: "0 0.55rem", borderRadius: 6, background, color, fontSize: "0.74rem", fontWeight: 850 }}>
      {children}
    </span>
  );
}

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
    <td colSpan={canEditTemplates ? 6 : 5} style={{ padding: "1rem 1.5rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 0.7fr) minmax(220px, 1fr) minmax(260px, 1.25fr) auto", gap: "1rem", alignItems: "end" }}>
        <div style={{ display: "grid", gridTemplateColumns: isNew ? "1fr" : "auto", gap: "0.7rem" }}>
          {isNew ? (
            <Field label={t("rating_col_id")}>
              <input type="number" className="form-input" placeholder={t("rating_ph_id")} value={form.rating_group_id} onChange={(event) => setForm((current: any) => ({ ...current, rating_group_id: event.target.value }))} autoFocus />
            </Field>
          ) : (
            <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--primary)", fontSize: "1.1rem" }}>#{ratingGroupId}</span>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.7rem" }}>
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 0.75fr 1fr", gap: "0.7rem" }}>
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
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button className="btn-icon" onClick={isNew ? handleCreate : () => ratingGroupId && handleUpdate(ratingGroupId)} title={t("save")} disabled={isSaving}><Save size={18} color={validationMessage ? "var(--warning)" : "var(--success)"} /></button>
          <button className="btn-icon" onClick={() => isNew ? setIsAdding(false) : setEditingId(null)} title={t("cancel")} disabled={isSaving}><X size={18} color="var(--text-muted)" /></button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: "0.8rem", marginTop: "0.9rem" }}>
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
        <div style={{ marginTop: "0.8rem", color: "var(--danger)", fontSize: "0.82rem", fontWeight: 700 }}>
          {validationMessage}
        </div>
      )}
    </td>
    );
  };

  return (
    <div className="container animate-fade-in" style={{ padding: "3rem", paddingBottom: "100px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", marginBottom: "1.25rem" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, color: "var(--text-main)" }}>
            {view === "plans" ? t("tariff_plan_current") : t("rating_rule_catalog_title")}
          </h1>
          <p style={{ margin: "0.5rem 0 0 0", color: "var(--text-muted)", fontSize: "0.95rem" }}>
            {view === "plans" ? t("tariff_plan_current_desc") : t("rating_rule_catalog_desc")}
          </p>
        </div>
      </div>

      {notice && (
        <OperationNotice
          presentation="modal"
          tone={notice.type === "error" ? "danger" : "success"}
          title={notice.type === "error" ? t("error") : t("success")}
          message={notice.text}
          onClose={() => setNotice(null)}
        />
      )}

      {pendingDeleteId != null && (
        <ConfirmActionPanel
          presentation="modal"
          title={t("rating_del_confirm", { id: pendingDeleteId })}
          message={t("rating_del_desc")}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          isWorking={savingKey === `delete:${pendingDeleteId}`}
          onConfirm={executeDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {view === "plans" && (
        <div style={{ display: "grid", gap: "1.25rem" }}>
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: "0.9rem" }}>
            {[
              { icon: <Tag size={18} color="var(--primary)" />, label: t("tariff_plan_ops_total_plans"), value: planOperationSummary?.totalPlans ?? plans.length },
              { icon: <CheckCircle2 size={18} color="var(--success)" />, label: t("tariff_plan_ops_active_plans"), value: planOperationSummary?.activePlans ?? plans.filter((plan) => (plan.status || "active") === "active").length },
              { icon: <ShieldCheck size={18} color="var(--warning)" />, label: t("tariff_plan_ops_disabled_plans"), value: planOperationSummary?.disabledPlans ?? plans.filter((plan) => plan.status === "disabled").length },
              { icon: <Database size={18} color="var(--primary)" />, label: t("tariff_plan_ops_linked_total"), value: planOperationSummary?.totalLinkedSubscribers ?? plans.reduce((sum, plan) => sum + (plan.subscriberCount || 0), 0) },
            ].map((item) => (
              <div key={item.label} className="dash-card" style={{ minHeight: 104, padding: "1rem 1.1rem", display: "grid", alignContent: "space-between", gap: "0.8rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", color: "var(--text-muted)", fontSize: "0.76rem", fontWeight: 850, textTransform: "uppercase" }}>
                  {item.icon} {item.label}
                </div>
                <div style={{ color: "var(--text-main)", fontSize: "1.7rem", lineHeight: 1, fontWeight: 900 }}>{item.value}</div>
              </div>
            ))}
          </section>

          <section style={{ display: "grid", gap: "1.25rem" }}>
            <section className="dash-card" style={{ overflow: "hidden" }}>
              <div className="dash-card-header" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, color: "var(--text-main)", fontSize: "1rem", fontWeight: 850 }}>{t("tariff_plan_catalog")}</h3>
                  <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontSize: "0.8rem" }}>{t("tariff_plan_catalog_desc")}</p>
                </div>
                {canEditTemplates && (
                  <button type="button" className="btn-icon" onClick={beginCreatePlan} disabled={savingKey !== null} title={t("tariff_plan_new")}>
                    <Plus size={18} color="var(--primary)" />
                  </button>
                )}
              </div>
              <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: "0.75rem" }}>
                {plans.map((plan) => {
                  const active = !isCreatingPlan && plan.plan_id === selectedPlanId;
                  const planStatus = plan.status || "active";
                  return (
                    <button
                      key={plan.plan_id}
                      type="button"
                      onClick={() => {
                        setSelectedPlanId(plan.plan_id);
                        setEditingId(null);
                        setIsAdding(false);
                        setQuery("");
                        setIsCreatingPlan(false);
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        border: `1px solid ${active ? "var(--primary)" : "var(--surface-border)"}`,
                        borderRadius: 6,
                        background: active ? "color-mix(in srgb, var(--primary) 7%, var(--surface))" : "var(--surface)",
                        padding: "0.9rem",
                        cursor: "pointer",
                        display: "grid",
                        gap: "0.65rem",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: "var(--text-main)", fontWeight: 850, fontSize: "0.9rem", overflowWrap: "anywhere" }}>{plan.name || plan.plan_id}</div>
                          <div style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: "0.74rem", marginTop: "0.2rem", overflowWrap: "anywhere" }}>{plan.plan_id}</div>
                        </div>
                        <StatusBadge tone={planStatus === "active" ? "success" : "muted"}>
                          {planStatus === "active" ? t("policy_status_active") : t("users_disabled")}
                        </StatusBadge>
                      </div>
                      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", color: "var(--text-muted)", fontSize: "0.76rem", fontWeight: 750 }}>
                        <span>{t("tariff_plan_rules")}: <strong style={{ color: "var(--text-main)" }}>{plan.rulesCount}</strong></span>
                        <span>{t("tariff_plan_subscribers")}: <strong style={{ color: "var(--text-main)" }}>{plan.subscriberCount}</strong></span>
                        {plan.isDefault && <StatusBadge tone="warning">{DEFAULT_OCS_PLAN_ID}</StatusBadge>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="dash-card" style={{ overflow: "hidden" }}>
              <div className="dash-card-header" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ display: "grid", gap: "0.35rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", flexWrap: "wrap" }}>
                    <h3 style={{ margin: 0, color: "var(--text-main)", fontSize: "1.05rem", fontWeight: 850 }}>{isCreatingPlan ? t("tariff_plan_new") : t("tariff_plan_details")}</h3>
                    {selectedPlan && !isCreatingPlan && (
                      <>
                        <StatusBadge tone={(selectedPlan.status || "active") === "active" ? "success" : "muted"}>
                          {(selectedPlan.status || "active") === "active" ? t("policy_status_active") : t("users_disabled")}
                        </StatusBadge>
                        {selectedPlan.isDefault && <StatusBadge tone="warning">{DEFAULT_OCS_PLAN_ID}</StatusBadge>}
                      </>
                    )}
                  </div>
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.84rem" }}>{t("tariff_plan_current_desc")}</p>
                </div>
                {canEditTemplates && (
                  <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {isCreatingPlan ? (
                      <>
                        <button type="button" className="btn btn-primary" onClick={handleCreatePlan} disabled={savingKey !== null}>
                          <Save size={15} /> {t("tariff_plan_create_from_current")}
                        </button>
                        <button type="button" className="btn btn-outline" onClick={() => setIsCreatingPlan(false)} disabled={savingKey !== null}>
                          <X size={15} /> {t("cancel")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-primary" onClick={handleUpdatePlan} disabled={!selectedPlan || savingKey !== null || isDisablingPlanWithSubscribers}>
                          <Save size={15} /> {t("tariff_plan_save")}
                        </button>
                        {selectedPlan && !selectedPlan.isDefault && (
                          <button type="button" className="btn btn-outline" onClick={handleDeletePlan} disabled={savingKey !== null || selectedPlanSubscriberTotal > 0} style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>
                            <Trash2 size={15} /> {t("tariff_plan_delete")}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="dash-card-body" style={{ display: "grid", gap: "1.25rem" }}>
                <div style={{ display: "grid", gap: "0.85rem" }}>
                  <h4 style={{ margin: 0, color: "var(--text-main)", fontSize: "0.92rem", fontWeight: 850 }}>{t("tariff_plan_basic_info")}</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: "1rem", alignItems: "end" }}>
                    <Field label={t("tariff_plan_id")}>
                      {isCreatingPlan ? (
                        <input className="form-input" value={planForm.plan_id} onChange={(event) => setPlanForm((current: any) => ({ ...current, plan_id: event.target.value }))} />
                      ) : (
                        <input className="form-input" value={selectedPlan?.plan_id || selectedPlanId} readOnly style={{ fontFamily: "monospace", color: "var(--text-secondary)" }} />
                      )}
                    </Field>
                    <Field label={t("tariff_plan_name")}>
                      <input className="form-input" value={planForm.name} onChange={(event) => setPlanForm((current: any) => ({ ...current, name: event.target.value }))} disabled={!canEditTemplates} />
                    </Field>
                    <Field label={t("tariff_plan_status")}>
                      <select className="form-input" value={planForm.status} onChange={(event) => setPlanForm((current: any) => ({ ...current, status: event.target.value }))} disabled={!canEditTemplates}>
                        <option value="active">{t("policy_status_active")}</option>
                        <option value="disabled">{t("users_disabled")}</option>
                      </select>
                    </Field>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <Field label={t("tariff_plan_desc")}>
                        <input className="form-input" value={planForm.description} onChange={(event) => setPlanForm((current: any) => ({ ...current, description: event.target.value }))} disabled={!canEditTemplates} />
                      </Field>
                    </div>
                  </div>
                </div>

                <div style={{ borderTop: "1px solid var(--surface-border)", paddingTop: "1rem", display: "grid", gap: "0.85rem" }}>
                  <h4 style={{ margin: 0, color: "var(--text-main)", fontSize: "0.92rem", fontWeight: 850 }}>{t("tariff_plan_usage_overview")}</h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: "0.8rem" }}>
                    {[
                      { label: t("tariff_plan_rules"), value: selectedPlan?.rulesCount ?? ratings.length },
                      { label: t("tariff_plan_subscribers"), value: selectedPlanSubscriberTotal },
                      { label: t("tariff_plan_ops_selected_share"), value: `${planOperationSummary?.selectedSharePct ?? 0}%` },
                      { label: t("tariff_plan_ops_last_change"), value: formatDateTime(planOperationSummary?.lastChangedAt) },
                    ].map((item) => (
                      <div key={item.label} style={{ border: "1px solid var(--surface-border)", borderRadius: 6, padding: "0.85rem", minWidth: 0 }}>
                        <div style={{ color: "var(--text-muted)", fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase" }}>{item.label}</div>
                        <div style={{ color: "var(--text-main)", fontSize: "1rem", fontWeight: 850, marginTop: "0.35rem", overflowWrap: "anywhere" }}>{item.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {isDisablingPlanWithSubscribers && (
                  <div style={{ color: "var(--danger)", fontSize: "0.82rem", fontWeight: 800, border: "1px solid color-mix(in srgb, var(--danger) 36%, var(--surface-border))", borderRadius: 6, padding: "0.85rem", background: "color-mix(in srgb, var(--danger) 7%, var(--surface))" }}>
                    {t("tariff_plan_disable_in_use")}
                  </div>
                )}
              </div>
            </section>
          </section>

          <section style={{ display: "grid", gap: "1.25rem" }}>
            <section className="dash-card" style={{ overflow: "hidden" }}>
              <div className="dash-card-header">
                <h3 style={{ margin: 0, color: "var(--text-main)", fontSize: "1rem", fontWeight: 850, display: "flex", alignItems: "center", gap: "0.55rem" }}>
                  <ArrowRightLeft size={17} color="var(--primary)" /> {t("tariff_plan_migrate_title")}
                </h3>
                <p style={{ margin: "0.35rem 0 0", color: "var(--text-muted)", fontSize: "0.82rem", lineHeight: 1.5 }}>
                  {selectedPlanSubscriberTotal > 0 ? t("tariff_plan_migrate_desc", { count: selectedPlanSubscriberTotal }) : t("tariff_plan_migrate_empty")}
                </p>
              </div>
              <div className="dash-card-body" style={{ display: "grid", gap: "1rem" }}>
                {selectedPlanSubscribers.length > 0 && (
                  <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                    {selectedPlanSubscribers.map((subscriber) => (
                      <span key={subscriber.imsi} style={{ border: "1px solid var(--surface-border)", borderRadius: 6, padding: "0.28rem 0.5rem", fontFamily: "monospace", fontSize: "0.72rem", color: "var(--text-main)", background: "var(--surface-hover)" }}>
                        {subscriber.imsi}
                      </span>
                    ))}
                    {planSubscribersData?.hasMore && (
                      <span style={{ border: "1px solid var(--surface-border)", borderRadius: 6, padding: "0.28rem 0.5rem", fontSize: "0.72rem", color: "var(--text-muted)", background: "var(--surface-hover)" }}>
                        +{selectedPlanSubscriberTotal - selectedPlanSubscribers.length}
                      </span>
                    )}
                  </div>
                )}
                {canEditTemplates && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: "0.85rem", alignItems: "end" }}>
                    <Field label={t("tariff_plan_migrate_target")}>
                      <select
                        className="form-input"
                        value={migrationTargetPlanId}
                        onChange={(event) => setMigrationTargetPlanId(event.target.value)}
                        disabled={migrationTargetOptions.length === 0 || savingKey !== null}
                      >
                        {migrationTargetOptions.length === 0 ? (
                          <option value="">{t("tariff_plan_migrate_no_target")}</option>
                        ) : migrationTargetOptions.map((plan) => (
                          <option key={plan.plan_id} value={plan.plan_id}>
                            {plan.name && plan.name !== plan.plan_id ? `${plan.name} (${plan.plan_id})` : plan.plan_id}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.55rem", minHeight: 42, color: "var(--text-secondary)", fontSize: "0.8rem", fontWeight: 700 }}>
                      <input
                        type="checkbox"
                        className="checkbox-custom"
                        checked={migrationResetBalances}
                        onChange={(event) => setMigrationResetBalances(event.target.checked)}
                        disabled={savingKey !== null}
                      />
                      {t("tariff_plan_migrate_reset")}
                    </label>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleMigratePlanSubscribers}
                      disabled={savingKey !== null || !migrationTargetPlanId || selectedPlanSubscriberTotal === 0}
                      style={{ minHeight: 42, whiteSpace: "nowrap" }}
                    >
                      <ArrowRightLeft size={15} /> {savingKey === "plan:migrate" ? t("policy_change_applying") : t("tariff_plan_migrate_apply")}
                    </button>
                  </div>
                )}
              </div>
            </section>

            <section className="dash-card" style={{ overflow: "hidden" }}>
              <div className="dash-card-header" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, color: "var(--text-main)", fontSize: "1rem", fontWeight: 850, display: "flex", alignItems: "center", gap: "0.55rem" }}>
                    <History size={17} color="var(--primary)" /> {t("tariff_plan_ops_history")}
                  </h3>
                  <p style={{ margin: "0.35rem 0 0", color: "var(--text-muted)", fontSize: "0.82rem" }}>{t("tariff_plan_ops_desc")}</p>
                </div>
                <span style={{ color: "var(--text-muted)", fontSize: "0.76rem", fontWeight: 750, whiteSpace: "nowrap" }}>
                  {t("tariff_plan_ops_recent_count", { count: planOperationSummary?.recentActivityCount ?? planOperationHistory.length })}
                </span>
              </div>
              <div className="dash-card-body">
                {planOperationHistory.length === 0 ? (
                  <div style={{ border: "1px dashed var(--surface-border)", borderRadius: 6, padding: "1rem", color: "var(--text-muted)", fontSize: "0.83rem" }}>
                    {t("tariff_plan_ops_no_history")}
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: "0.7rem", maxHeight: 360, overflow: "auto", paddingRight: "0.2rem" }}>
                    {planOperationHistory.map((item) => (
                      <div key={item.id} style={{ borderLeft: `3px solid ${item.level === "warning" ? "var(--danger)" : "var(--primary)"}`, padding: "0.2rem 0 0.2rem 0.75rem", display: "grid", gap: "0.35rem" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ color: item.level === "warning" ? "var(--danger)" : "var(--text-main)", fontWeight: 850, fontSize: "0.84rem" }}>
                            {formatPlanOperationAction(item.action)}
                          </span>
                          <span style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>{formatDateTime(item.timestamp)}</span>
                        </div>
                        <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", color: "var(--text-muted)", fontSize: "0.74rem" }}>
                          <span>{t("tariff_plan_ops_target")}: <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>{item.targetId}</span></span>
                          <span>{t("tariff_plan_ops_operator")}: {item.operatorIp}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </section>
        </div>
      )}

      {view === "rules" && (
      <div className="dash-card" style={{ overflow: "hidden" }}>
        <div className="dash-card-header" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 1fr) auto", gap: "1rem", alignItems: "center" }}>
          <div style={{ display: "grid", gap: "0.3rem" }}>
            <h3 style={{ margin: 0, color: "var(--text-main)", fontSize: "1rem", fontWeight: 850 }}>{t("rating_rule_catalog_title")}</h3>
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "0.82rem" }}>{t("rating_rule_catalog_desc")}</p>
          </div>
          {canEditTemplates && (
            <button className="btn btn-primary" onClick={() => setIsAdding(true)} disabled={savingKey !== null || isAdding} style={{ minHeight: 38, whiteSpace: "nowrap" }}>
              <Plus size={16} /> {t("rating_new_rate")}
            </button>
          )}
          <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "minmax(220px, 0.85fr) minmax(300px, 1.25fr) minmax(260px, 0.9fr)", alignItems: "end", gap: "0.85rem", borderTop: "1px solid var(--surface-border)", paddingTop: "0.85rem" }}>
            <Field label={t("tariff_plan_id")}>
              <select
                className="form-input"
                value={selectedPlanId}
                onChange={(event) => {
                  setSelectedPlanId(event.target.value);
                  setEditingId(null);
                  setIsAdding(false);
                  setQuery("");
                }}
              >
                {plans.map((plan) => (
                  <option key={plan.plan_id} value={plan.plan_id}>{plan.name && plan.name !== plan.plan_id ? `${plan.name} (${plan.plan_id})` : plan.plan_id}</option>
                ))}
              </select>
            </Field>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              {SERVICE_FILTERS.map((key) => {
                const meta = serviceMeta(key);
                const active = filter === key;
                return (
                  <button
                    key={key}
                    className={active ? "btn btn-primary" : "btn btn-outline"}
                    onClick={() => setFilter(key)}
                    style={{ height: 34, padding: "0 0.75rem", display: "inline-flex", alignItems: "center", gap: "0.4rem", borderRadius: 6 }}
                  >
                    {meta.icon}{meta.label} <span style={{ opacity: 0.75 }}>{counts[key]}</span>
                  </button>
                );
              })}
            </div>
            <label style={{ position: "relative", minWidth: 0 }}>
              <Search size={16} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
              <input className="form-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("rating_search_ph")} style={{ paddingLeft: 36, height: 38 }} />
            </label>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.95rem", minWidth: "980px" }}>
            <thead>
              <tr style={{ background: "var(--surface-hover)", borderBottom: "2px solid var(--surface-border)" }}>
                <th className="table-header-cap" style={{ padding: "1rem 1.5rem", textAlign: "left", width: "190px" }}><span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Hash size={16} /> {t("rating_col_id")}</span></th>
                <th className="table-header-cap" style={{ padding: "1rem 1.5rem", textAlign: "left" }}>{t("rating_charging_scenario")}</th>
                <th className="table-header-cap" style={{ padding: "1rem 1.5rem", textAlign: "left" }}><span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><DollarSign size={16} /> {t("rating_commercial_rate")}</span></th>
                <th className="table-header-cap" style={{ padding: "1rem 1.5rem", textAlign: "left" }}>{t("rating_grant_policy")}</th>
                <th className="table-header-cap" style={{ padding: "1rem 1.5rem", textAlign: "left" }}>{t("status")}</th>
                {canEditTemplates && <th className="table-header-cap" style={{ padding: "1rem 1.5rem", textAlign: "right", width: "120px" }}>{t("rating_col_actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {isAdding && (
                <tr style={{ background: "rgba(59, 130, 246, 0.08)", borderBottom: "1px solid var(--surface-border)" }}>
                  {renderFormCells(newForm, setNewForm, true)}
                </tr>
              )}

              {isLoading ? (
                <tr>
                  <td colSpan={canEditTemplates ? 6 : 5}>
                    <LoadingRows columns={canEditTemplates ? 6 : 5} rows={4} />
                  </td>
                </tr>
              ) : visibleRatings.length === 0 ? (
                <tr>
                  <td colSpan={canEditTemplates ? 6 : 5}>
                    <EmptyState
                      icon={<Tag size={46} />}
                      title={query || filter !== "all" ? t("rating_empty_filtered_title") : t("rating_no_data")}
                      description={query || filter !== "all" ? t("rating_empty_filtered_desc") : t("rating_empty_desc")}
                      action={
                        canEditTemplates && !query && filter === "all" ? (
                          <button type="button" className="btn btn-primary" onClick={() => setIsAdding(true)}>
                            <Plus size={16} /> {t("rating_new_rate")}
                          </button>
                        ) : undefined
                      }
                    />
                  </td>
                </tr>
              ) : visibleRatings.map((rating) => {
                const meta = serviceMeta(rating.serviceKey);
                const rateType = rateTypes.find((type) => type.val === rating.rates_type)?.label || rating.rates_type;
                return (
                  <tr key={rating.rating_group_id} style={{ borderBottom: "1px solid var(--surface-border)" }}>
                    {editingId === rating.rating_group_id ? renderFormCells(editForm, setEditForm, false, rating.rating_group_id) : (
                      <>
                        <td style={{ padding: "1.15rem 1.5rem" }}>
                          <div style={{ fontFamily: "monospace", fontWeight: 800, color: "var(--primary)", fontSize: "1.05rem" }}>#{rating.rating_group_id}</div>
                          <div style={{ color: "var(--text-muted)", fontSize: "0.76rem", marginTop: "0.25rem", overflowWrap: "anywhere" }}>{rating.rule_id || "-"}</div>
                        </td>
                        <td style={{ padding: "1.15rem 1.5rem" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", color: meta.color, fontWeight: 800 }}>
                            {meta.icon}{meta.label}
                          </div>
                          <div style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "0.3rem" }}>
                            APN <span style={{ fontFamily: "monospace", color: "var(--text-main)" }}>{rating.apn || "internet"}</span>
                            <span style={{ margin: "0 0.45rem" }}>·</span>
                            SI <span style={{ fontFamily: "monospace", color: "var(--text-main)" }}>{rating.service_identifier ?? 1}</span>
                            <span style={{ margin: "0 0.45rem" }}>·</span>
                            <span style={{ fontFamily: "monospace", color: "var(--text-main)" }}>{rating.charging_type || "data_volume"}</span>
                          </div>
                        </td>
                        <td style={{ padding: "1.15rem 1.5rem" }}>
                          <div style={{ fontFamily: "monospace", fontWeight: 800, color: "var(--text-main)" }}>{rating.rates || "0"} {rating.currency || "USD"}</div>
                          <div style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "0.3rem" }}>{rateType}</div>
                        </td>
                        <td style={{ padding: "1.15rem 1.5rem" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 800 }}>
                            <CheckCircle2 size={15} color="var(--success)" />
                            {formatGrant(t, rating.quota_per_grant, rating.unit, rating.charging_type)}
                          </div>
                          <div style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "0.3rem" }}>
                            {t("rating_validity")}: {rating.validity_time ?? 0}s
                            <span style={{ margin: "0 0.45rem" }}>·</span>
                            {t("rating_threshold")}: {formatGrant(t, rating.volume_threshold, rating.unit, rating.charging_type)}
                          </div>
                        </td>
                        <td style={{ padding: "1.15rem 1.5rem" }}>
                          <span style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--success)", padding: "4px 10px", borderRadius: "999px", fontSize: "0.78rem", fontWeight: 800 }}>
                            {rating.status || "active"}
                          </span>
                        </td>
                        {canEditTemplates && (
                          <td style={{ padding: "1.15rem 1.5rem", textAlign: "right" }}>
                            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                              <button className="btn-icon" onClick={() => startEdit(rating)} title={t("edit")}><Pencil size={16} color="var(--primary)" /></button>
                              <button className="btn-icon" onClick={() => handleDelete(rating.rating_group_id)} title={t("delete")} disabled={savingKey === `delete:${rating.rating_group_id}` || pendingDeleteId != null}><Trash2 size={16} color="var(--danger)" /></button>
                            </div>
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}
