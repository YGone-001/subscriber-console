"use client";
import React from "react";
import { Gauge, GitBranch, Save, X } from "lucide-react";
import { TariffPlanList } from "./rating/TariffPlanList";
import { PccRuleList } from "./rating/PccRuleList";
import { RatingModals } from "./rating/RatingModals";
import { formatDateTime } from "./rating/RatingManagementShared";
import * as T from "./rating/types";
import { applyChargingType, CURRENCIES } from "./rating/types";
import { useRatingManagement } from "./rating/hooks/useRatingManagement";
import { Field } from "@/components/ui/Field";
import PageHeader from "@/components/ui/PageHeader";

export default function RatingManagementPage({ view }: { view: T.RatingManagementView }) {
  const state = useRatingManagement();
  const {
    t, canEditTemplates, plans, selectedPlanId, setSelectedPlanId, selectedPlan, isCreatingPlan, setIsCreatingPlan,
    planForm, setPlanForm, beginCreatePlan, handleCreatePlan, handleUpdatePlan,
    handleDeletePlan, handleMigratePlanSubscribers, formatPlanOperationAction,
    migrationTargetPlanId, setMigrationTargetPlanId, migrationTargetOptions,
    migrationResetBalances, setMigrationResetBalances, selectedPlanSubscribers, selectedPlanSubscriberTotal,
    planOperationSummary, planOperationHistory, isDisablingPlanWithSubscribers,
    ratings, visibleRatings, counts, filter, setFilter, query, setQuery,
    notice, setNotice, savingKey, pendingDeleteId, setPendingDeleteId, editingId, setEditingId,
    editForm, setEditForm, isAdding, setIsAdding, newForm, setNewForm,
    validateRatingForm, handleCreate, handleUpdate, handleDelete, executeDelete,
    formatCurrency, startEdit, serviceMeta, rateTypes,
    plansData, mutatePlans, planSubscribersData, mutatePlanSubscribers,
    planOperationsData, mutatePlanOperations, isLoading
  } = state;

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
              {rateTypes.map((type: any) => <option key={type.val} value={type.val}>{type.label}</option>)}
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
      <PageHeader
        eyebrow={view === "plans" ? "TARIFF / CATALOG" : "PCC / RULES"}
        icon={view === "plans" ? <Gauge size={23} /> : <GitBranch size={23} />}
        title={view === "plans" ? t("tariff_plan_current") : t("rating_rule_catalog_title")}
        description={view === "plans" ? t("tariff_plan_current_desc") : t("rating_rule_catalog_desc")}
      />

      <RatingModals {...propsObj} />

      {view === "plans" && <TariffPlanList {...propsObj} />}

      {view === "rules" && <PccRuleList {...propsObj} />}
    </div>
  );
}
