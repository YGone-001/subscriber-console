"use client";
import React from "react";
import { ArrowRightLeft, CheckCircle2, Database, History, Plus, Save, ShieldCheck, Tag, Trash2, X } from "lucide-react";
import { StatusBadge } from "./RatingManagementShared";
import * as T from "./types";
import { DEFAULT_OCS_PLAN_ID, Field } from "./types";

export function TariffPlanList(props: any) {
  const {
    t, plans, selectedPlanId, setSelectedPlanId, isCreatingPlan, setIsCreatingPlan,
    planForm, setPlanForm, planOperationSummary, planOperationHistory,
    selectedPlanSubscriberTotal, selectedPlanSubscribers, canEditTemplates, savingKey,
    migrationTargetOptions, migrationTargetPlanId, setMigrationTargetPlanId,
    migrationResetBalances, setMigrationResetBalances, handleCreatePlan, handleUpdatePlan,
    handleDeletePlan, handleMigratePlanSubscribers, beginCreatePlan, formatDateTime,
    formatPlanOperationAction, selectedPlan, isDisablingPlanWithSubscribers, planSubscribersData, setEditingId, setIsAdding, setQuery, ratings
  } = props;

  return (
    <>
      <div style={{ display: "grid", gap: "1.25rem" }}>
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", gap: "0.9rem" }}>
            {[
              { icon: <Tag size={18} color="var(--primary)" />, label: t("tariff_plan_ops_total_plans"), value: planOperationSummary?.totalPlans ?? plans.length },
              { icon: <CheckCircle2 size={18} color="var(--success)" />, label: t("tariff_plan_ops_active_plans"), value: planOperationSummary?.activePlans ?? plans.filter((plan: any) => (plan.status || "active") === "active").length },
              { icon: <ShieldCheck size={18} color="var(--warning)" />, label: t("tariff_plan_ops_disabled_plans"), value: planOperationSummary?.disabledPlans ?? plans.filter((plan: any) => plan.status === "disabled").length },
              { icon: <Database size={18} color="var(--primary)" />, label: t("tariff_plan_ops_linked_total"), value: planOperationSummary?.totalLinkedSubscribers ?? plans.reduce((sum: any, plan: any) => sum + (plan.subscriberCount || 0), 0) },
            ].map((item: any) => (
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
                {plans.map((plan: any) => {
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
                    ].map((item: any) => (
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
                    {selectedPlanSubscribers.map((subscriber: any) => (
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
                        ) : migrationTargetOptions.map((plan: any) => (
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
                    {planOperationHistory.map((item: any) => (
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
    </>
  );
}
