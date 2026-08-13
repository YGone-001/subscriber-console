"use client";
import React from "react";
import { Plus, Search, Hash, DollarSign, CheckCircle2, Pencil, Trash2, Tag } from "lucide-react";
import { EmptyState, LoadingRows } from "@/components/OperationFeedback";
import { SERVICE_FILTERS, Field, formatGrant } from "./types";
import "./rating.css";

export function PccRuleList(props: any) {
  const {
    t, plans, selectedPlanId, setSelectedPlanId, filter, setFilter, query, setQuery,
    counts, visibleRatings, isAdding, setIsAdding, newForm, setNewForm, editingId,
    setEditingId, editForm, setEditForm, canEditTemplates, isLoading, savingKey,
    pendingDeleteId, startEdit, handleDelete, renderFormCells, serviceMeta, rateTypes
  } = props;

  return (
    <>
      <div className="dash-card card-overflow-hidden">
        <div className="dash-card-header card-header-grid">
          <div className="grid-gap-0-35">
            <h3 className="card-title-lg">{t("rating_rule_catalog_title")}</h3>
            <p className="card-desc-mt">{t("rating_rule_catalog_desc")}</p>
          </div>
          {canEditTemplates && (
            <button className="btn btn-primary btn-new-rate" onClick={() => setIsAdding(true)} disabled={savingKey !== null || isAdding}>
              <Plus size={16} /> {t("rating_new_rate")}
            </button>
          )}
          <div className="filters-grid">
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
                {plans.map((plan: any) => (
                  <option key={plan.plan_id} value={plan.plan_id}>{plan.name && plan.name !== plan.plan_id ? `${plan.name} (${plan.plan_id})` : plan.plan_id}</option>
                ))}
              </select>
            </Field>
            <div className="filters-flex">
              {SERVICE_FILTERS.map((key) => {
                const meta = serviceMeta(key);
                const active = filter === key;
                return (
                  <button
                    key={key}
                    className={`${active ? "btn btn-primary" : "btn btn-outline"} filter-btn`}
                    onClick={() => setFilter(key)}
                  >
                    {meta.icon}{meta.label} <span className="filter-count">{counts[key]}</span>
                  </button>
                );
              })}
            </div>
            <label className="search-wrapper">
              <Search size={16} className="search-icon" />
              <input className="form-input search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("rating_search_ph")} />
            </label>
          </div>
        </div>

        <div className="table-container">
          <table className="rule-table">
            <thead>
              <tr className="rule-table-thead">
                <th className="table-header-cap rule-th rule-th-id"><span className="flex-center-gap-0-55"><Hash size={16} /> {t("rating_col_id")}</span></th>
                <th className="table-header-cap rule-th">{t("rating_charging_scenario")}</th>
                <th className="table-header-cap rule-th"><span className="flex-center-gap-0-55"><DollarSign size={16} /> {t("rating_commercial_rate")}</span></th>
                <th className="table-header-cap rule-th">{t("rating_grant_policy")}</th>
                <th className="table-header-cap rule-th">{t("status")}</th>
                {canEditTemplates && <th className="table-header-cap rule-th rule-th-actions">{t("rating_col_actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {isAdding && (
                <tr className="rule-tr-adding">
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
              ) : visibleRatings.map((rating: any) => {
                const meta = serviceMeta(rating.serviceKey);
                const rateType = rateTypes.find((type: any) => type.val === rating.rates_type)?.label || rating.rates_type;
                return (
                  <tr key={rating.rating_group_id} className="rule-tr">
                    {editingId === rating.rating_group_id ? renderFormCells(editForm, setEditForm, false, rating.rating_group_id) : (
                      <>
                        <td className="rule-td" data-label={t("rating_col_id")}>
                          <div className="rule-id">#{rating.rating_group_id}</div>
                          <div className="rule-subid">{rating.rule_id || "-"}</div>
                        </td>
                        <td className="rule-td" data-label={t("rating_charging_scenario")}>
                          <div className="rule-scenario" style={{ color: meta.color }}>
                            {meta.icon}{meta.label}
                          </div>
                          <div className="rule-scenario-desc">
                            APN <span className="rule-font-mono-main">{rating.apn || "internet"}</span>
                            <span className="rule-dot">·</span>
                            SI <span className="rule-font-mono-main">{rating.service_identifier ?? 1}</span>
                            <span className="rule-dot">·</span>
                            <span className="rule-font-mono-main">{rating.charging_type || "data_volume"}</span>
                          </div>
                        </td>
                        <td className="rule-td" data-label={t("rating_commercial_rate")}>
                          <div className="rule-rate">{rating.rates || "0"} {rating.currency || "USD"}</div>
                          <div className="rule-rate-type">{rateType}</div>
                        </td>
                        <td className="rule-td" data-label={t("rating_grant_policy")}>
                          <div className="rule-grant">
                            <CheckCircle2 size={15} color="var(--success)" />
                            {formatGrant(t, rating.quota_per_grant, rating.unit, rating.charging_type)}
                          </div>
                          <div className="rule-grant-desc">
                            {t("rating_validity")}: {rating.validity_time ?? 0}s
                            <span className="rule-dot">·</span>
                            {t("rating_threshold")}: {formatGrant(t, rating.volume_threshold, rating.unit, rating.charging_type)}
                          </div>
                        </td>
                        <td className="rule-td" data-label={t("status")}>
                          <span className="rule-status">
                            {rating.status || "active"}
                          </span>
                        </td>
                        {canEditTemplates && (
                          <td className="rule-actions" data-label={t("rating_col_actions")}>
                            <div className="rule-actions-flex">
                              <button type="button" className="btn-icon" onClick={() => startEdit(rating)} title={t("edit")} aria-label={`${t("edit")}: ${rating.rating_group_id}`}><Pencil size={16} color="var(--primary)" /></button>
                              <button type="button" className="btn-icon" onClick={() => handleDelete(rating.rating_group_id)} title={t("delete")} aria-label={`${t("delete")}: ${rating.rating_group_id}`} disabled={savingKey === `delete:${rating.rating_group_id}` || pendingDeleteId != null}><Trash2 size={16} color="var(--danger)" /></button>
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
    </>
  );
}
