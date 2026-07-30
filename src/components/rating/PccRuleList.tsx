"use client";
import React from "react";
import { Plus, Search, Hash, DollarSign, CheckCircle2, Pencil, Trash2, Tag } from "lucide-react";
import { EmptyState, LoadingRows } from "@/components/OperationFeedback";
import * as T from "./types";
import { SERVICE_FILTERS, Field, formatGrant } from "./types";

export function PccRuleList(props: any) {
  const {
    t, plans, selectedPlanId, setSelectedPlanId, filter, setFilter, query, setQuery,
    counts, visibleRatings, isAdding, setIsAdding, newForm, setNewForm, editingId,
    setEditingId, editForm, setEditForm, canEditTemplates, isLoading, savingKey,
    pendingDeleteId, startEdit, handleDelete, renderFormCells, serviceMeta, rateTypes, ratings
  } = props;

  return (
    <>
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
                {plans.map((plan: any) => (
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
              ) : visibleRatings.map((rating: any) => {
                const meta = serviceMeta(rating.serviceKey);
                const rateType = rateTypes.find((type: any) => type.val === rating.rates_type)?.label || rating.rates_type;
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
    </>
  );
}
