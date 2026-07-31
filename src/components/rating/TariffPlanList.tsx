"use client";
import React from "react";
import { ArrowRightLeft, CheckCircle2, Database, History, Plus, Save, ShieldCheck, Tag, Trash2, X } from "lucide-react";
import { StatusBadge } from "./RatingManagementShared";
import * as T from "./types";
import { DEFAULT_OCS_PLAN_ID, Field } from "./types";
import "./rating.css";

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
      <div className="grid-gap-1-25">
          <section className="stats-grid">
            {[
              { icon: <Tag size={18} color="var(--primary)" />, label: t("tariff_plan_ops_total_plans"), value: planOperationSummary?.totalPlans ?? plans.length },
              { icon: <CheckCircle2 size={18} color="var(--success)" />, label: t("tariff_plan_ops_active_plans"), value: planOperationSummary?.activePlans ?? plans.filter((plan: any) => (plan.status || "active") === "active").length },
              { icon: <ShieldCheck size={18} color="var(--warning)" />, label: t("tariff_plan_ops_disabled_plans"), value: planOperationSummary?.disabledPlans ?? plans.filter((plan: any) => plan.status === "disabled").length },
              { icon: <Database size={18} color="var(--primary)" />, label: t("tariff_plan_ops_linked_total"), value: planOperationSummary?.totalLinkedSubscribers ?? plans.reduce((sum: any, plan: any) => sum + (plan.subscriberCount || 0), 0) },
            ].map((item: any) => (
              <div key={item.label} className="dash-card stat-card">
                <div className="stat-card-header">
                  {item.icon} {item.label}
                </div>
                <div className="stat-card-value">{item.value}</div>
              </div>
            ))}
          </section>

          <section className="grid-gap-1-25">
            <section className="dash-card card-overflow-hidden">
              <div className="dash-card-header card-header-flex">
                <div>
                  <h3 className="card-title-lg">{t("tariff_plan_catalog")}</h3>
                  <p className="card-desc">{t("tariff_plan_catalog_desc")}</p>
                </div>
                {canEditTemplates && (
                  <button type="button" className="btn-icon" onClick={beginCreatePlan} disabled={savingKey !== null} title={t("tariff_plan_new")}>
                    <Plus size={18} color="var(--primary)" />
                  </button>
                )}
              </div>
              <div className="dash-card-body plans-grid">
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
                      className={`plan-button ${active ? "plan-button-active" : "plan-button-inactive"}`}
                    >
                      <div className="plan-header">
                        <div className="plan-title-wrapper">
                          <div className="plan-title">{plan.name || plan.plan_id}</div>
                          <div className="plan-id">{plan.plan_id}</div>
                        </div>
                        <StatusBadge tone={planStatus === "active" ? "success" : "muted"}>
                          {planStatus === "active" ? t("policy_status_active") : t("users_disabled")}
                        </StatusBadge>
                      </div>
                      <div className="plan-stats">
                        <span>{t("tariff_plan_rules")}: <strong className="plan-stat-val">{plan.rulesCount}</strong></span>
                        <span>{t("tariff_plan_subscribers")}: <strong className="plan-stat-val">{plan.subscriberCount}</strong></span>
                        {plan.isDefault && <StatusBadge tone="warning">{DEFAULT_OCS_PLAN_ID}</StatusBadge>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="dash-card card-overflow-hidden">
              <div className="dash-card-header card-header-flex-wrap">
                <div className="grid-gap-0-35">
                  <div className="flex-center-gap-0-65">
                    <h3 className="card-title-xl">{isCreatingPlan ? t("tariff_plan_new") : t("tariff_plan_details")}</h3>
                    {selectedPlan && !isCreatingPlan && (
                      <>
                        <StatusBadge tone={(selectedPlan.status || "active") === "active" ? "success" : "muted"}>
                          {(selectedPlan.status || "active") === "active" ? t("policy_status_active") : t("users_disabled")}
                        </StatusBadge>
                        {selectedPlan.isDefault && <StatusBadge tone="warning">{DEFAULT_OCS_PLAN_ID}</StatusBadge>}
                      </>
                    )}
                  </div>
                  <p className="card-desc-mt">{t("tariff_plan_current_desc")}</p>
                </div>
                {canEditTemplates && (
                  <div className="flex-end-gap-0-55">
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
                          <button type="button" className="btn btn-outline btn-danger-outline" onClick={handleDeletePlan} disabled={savingKey !== null || selectedPlanSubscriberTotal > 0}>
                            <Trash2 size={15} /> {t("tariff_plan_delete")}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="dash-card-body grid-gap-1-25">
                <div className="grid-gap-0-85">
                  <h4 className="section-subtitle">{t("tariff_plan_basic_info")}</h4>
                  <div className="fields-grid">
                    <Field label={t("tariff_plan_id")}>
                      {isCreatingPlan ? (
                        <input className="form-input" value={planForm.plan_id} onChange={(event) => setPlanForm((current: any) => ({ ...current, plan_id: event.target.value }))} />
                      ) : (
                        <input className="form-input input-readonly" value={selectedPlan?.plan_id || selectedPlanId} readOnly />
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
                    <div className="col-span-all">
                      <Field label={t("tariff_plan_desc")}>
                        <input className="form-input" value={planForm.description} onChange={(event) => setPlanForm((current: any) => ({ ...current, description: event.target.value }))} disabled={!canEditTemplates} />
                      </Field>
                    </div>
                  </div>
                </div>

                <div className="usage-overview">
                  <h4 className="section-subtitle">{t("tariff_plan_usage_overview")}</h4>
                  <div className="usage-grid">
                    {[
                      { label: t("tariff_plan_rules"), value: selectedPlan?.rulesCount ?? ratings.length },
                      { label: t("tariff_plan_subscribers"), value: selectedPlanSubscriberTotal },
                      { label: t("tariff_plan_ops_selected_share"), value: `${planOperationSummary?.selectedSharePct ?? 0}%` },
                      { label: t("tariff_plan_ops_last_change"), value: formatDateTime(planOperationSummary?.lastChangedAt) },
                    ].map((item: any) => (
                      <div key={item.label} className="usage-card">
                        <div className="usage-label">{item.label}</div>
                        <div className="usage-val">{item.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {isDisablingPlanWithSubscribers && (
                  <div className="disable-warning">
                    {t("tariff_plan_disable_in_use")}
                  </div>
                )}
              </div>
            </section>
          </section>

          <section className="grid-gap-1-25">
            <section className="dash-card card-overflow-hidden">
              <div className="dash-card-header">
                <h3 className="card-title-lg flex-center-gap-0-55">
                  <ArrowRightLeft size={17} color="var(--primary)" /> {t("tariff_plan_migrate_title")}
                </h3>
                <p className="card-desc-mt desc-line-1-5">
                  {selectedPlanSubscriberTotal > 0 ? t("tariff_plan_migrate_desc", { count: selectedPlanSubscriberTotal }) : t("tariff_plan_migrate_empty")}
                </p>
              </div>
              <div className="dash-card-body grid-gap-1">
                {selectedPlanSubscribers.length > 0 && (
                  <div className="subs-list">
                    {selectedPlanSubscribers.map((subscriber: any) => (
                      <span key={subscriber.imsi} className="sub-tag">
                        {subscriber.imsi}
                      </span>
                    ))}
                    {planSubscribersData?.hasMore && (
                      <span className="sub-tag-more">
                        +{selectedPlanSubscriberTotal - selectedPlanSubscribers.length}
                      </span>
                    )}
                  </div>
                )}
                {canEditTemplates && (
                  <div className="fields-grid">
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
                    <label className="migrate-checkbox-label">
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
                      className="btn btn-primary btn-min-height"
                      onClick={handleMigratePlanSubscribers}
                      disabled={savingKey !== null || !migrationTargetPlanId || selectedPlanSubscriberTotal === 0}
                    >
                      <ArrowRightLeft size={15} /> {savingKey === "plan:migrate" ? t("policy_change_applying") : t("tariff_plan_migrate_apply")}
                    </button>
                  </div>
                )}
              </div>
            </section>

            <section className="dash-card card-overflow-hidden">
              <div className="dash-card-header card-header-flex">
                <div>
                  <h3 className="card-title-lg flex-center-gap-0-55">
                    <History size={17} color="var(--primary)" /> {t("tariff_plan_ops_history")}
                  </h3>
                  <p className="card-desc-mt">{t("tariff_plan_ops_desc")}</p>
                </div>
                <span className="history-count">
                  {t("tariff_plan_ops_recent_count", { count: planOperationSummary?.recentActivityCount ?? planOperationHistory.length })}
                </span>
              </div>
              <div className="dash-card-body">
                {planOperationHistory.length === 0 ? (
                  <div className="history-empty">
                    {t("tariff_plan_ops_no_history")}
                  </div>
                ) : (
                  <div className="history-list">
                    {planOperationHistory.map((item: any) => (
                      <div key={item.id} className={`history-item ${item.level === "warning" ? "history-item-warning" : "history-item-primary"}`}>
                        <div className="history-item-header">
                          <span className={item.level === "warning" ? "history-action-warning" : "history-action-primary"}>
                            {formatPlanOperationAction(item.action)}
                          </span>
                          <span className="history-time">{formatDateTime(item.timestamp)}</span>
                        </div>
                        <div className="history-details">
                          <span>{t("tariff_plan_ops_target")}: <span className="history-target">{item.targetId}</span></span>
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
