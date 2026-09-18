"use client";
import React, { useState, useEffect, useMemo } from "react";
import {
  ArrowRightLeft,
  CheckCircle2,
  Database,
  History,
  Plus,
  Save,
  ShieldCheck,
  Tag,
  Trash2,
  X,
  Copy,
  Upload,
  Download,
  Layers,
  Sliders,
  AlertTriangle,
  Pencil,
  Power,
  RefreshCw,
  Search,
} from "lucide-react";
import { StatusBadge, formatDateTime } from "./RatingManagementShared";
import * as T from "./types";
import { DEFAULT_OCS_PLAN_ID, formatGrant } from "./types";
import { TariffPlanCloneModal } from "./TariffPlanCloneModal";
import { TariffPlanImportModal } from "./TariffPlanImportModal";
import { TariffRuleModal } from "./TariffRuleModal";
import { DataTableStateRow } from "@/components/ui/DataTableState";
import { Field } from "@/components/ui/Field";
import { ErrorNotice } from "@/components/ui/InlineNotice";
import { detectRuleConflicts } from "@/lib/tariffPlanOperations";
import "./rating.css";

export function TariffPlanList(props: any) {
  const {
    t,
    plans,
    selectedPlanId,
    setSelectedPlanId,
    isCreatingPlan,
    setIsCreatingPlan,
    planForm,
    setPlanForm,
    planOperationSummary,
    planOperationHistory,
    selectedPlanSubscriberTotal,
    selectedPlanSubscribers,
    canEditTemplates,
    savingKey,
    migrationTargetOptions,
    migrationTargetPlanId,
    setMigrationTargetPlanId,
    migrationResetBalances,
    setMigrationResetBalances,
    handleCreatePlan,
    handleUpdatePlan,
    handleDeletePlan,
    handleMigratePlanSubscribers,
    beginCreatePlan,
    formatPlanOperationAction,
    selectedPlan,
    isDisablingPlanWithSubscribers,
    planSubscribersData,
    setEditingId,
    setIsAdding,
    setQuery,
    ratings,
    mutatePlans,
    mutatePlanOperations,
  } = props;

  // Active tab inside selected plan
  const [activeTab, setActiveTab] = useState<"overview" | "rules" | "migration" | "history">("overview");

  // Modals state
  const [isCloneOpen, setIsCloneOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<T.RatingPolicy | null>(null);

  // Search filter for rules matrix
  const [ruleSearchQuery, setRuleSearchQuery] = useState("");

  // Dry-run migration preview state
  const [dryRunPreview, setDryRunPreview] = useState<{
    subscribersCount: number;
    activeCount: number;
    suspendedCount: number;
    sourcePlan: { plan_id: string; name: string };
    targetPlan: { plan_id: string; name: string; status: string };
    isTargetActive: boolean;
  } | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  // Trigger dry-run migration preview when target changes
  useEffect(() => {
    if (activeTab !== "migration" || !selectedPlanId || !migrationTargetPlanId) {
      setDryRunPreview(null);
      setDryRunError(null);
      return;
    }

    let isMounted = true;
    const fetchDryRun = async () => {
      setDryRunLoading(true);
      setDryRunError(null);
      try {
        const res = await fetch(
          `/api/tariff-plans/${encodeURIComponent(selectedPlanId)}/migrate?targetPlanId=${encodeURIComponent(migrationTargetPlanId)}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Failed to preview migration");
        }
        if (isMounted) {
          setDryRunPreview(data.preview);
        }
      } catch (err: any) {
        if (isMounted) {
          setDryRunError(err.message || "Failed to load migration preview");
          setDryRunPreview(null);
        }
      } finally {
        if (isMounted) {
          setDryRunLoading(false);
        }
      }
    };

    fetchDryRun();
    return () => {
      isMounted = false;
    };
  }, [activeTab, selectedPlanId, migrationTargetPlanId]);

  // Combined rules from plan and ratings
  const currentPlanRules: T.RatingPolicy[] = useMemo(() => {
    if (selectedPlan?.rules && selectedPlan.rules.length > 0) {
      return selectedPlan.rules;
    }
    return ratings || [];
  }, [selectedPlan, ratings]);

  // Conflict detection
  const conflicts = useMemo(() => {
    return detectRuleConflicts(currentPlanRules);
  }, [currentPlanRules]);

  const conflictingRuleIds = useMemo(() => {
    const ids = new Set<string>();
    conflicts.forEach((c) => {
      c.rule_ids.forEach((id) => ids.add(id));
    });
    return ids;
  }, [conflicts]);

  // Filtered and sorted rules for matrix view (sorted by priority descending)
  const visiblePlanRules = useMemo(() => {
    const query = ruleSearchQuery.trim().toLowerCase();
    const sorted = [...currentPlanRules].sort((a, b) => (Number(b.priority ?? 0) - Number(a.priority ?? 0)));
    if (!query) return sorted;
    return sorted.filter((r) => {
      return (
        (r.rule_id || "").toLowerCase().includes(query) ||
        (r.apn || "").toLowerCase().includes(query) ||
        String(r.rating_group_id ?? "").includes(query) ||
        String(r.service_identifier ?? "").includes(query) ||
        (r.charging_type || "").toLowerCase().includes(query)
      );
    });
  }, [currentPlanRules, ruleSearchQuery]);

  // Export handler
  const handleExportPlan = () => {
    if (!selectedPlanId) return;
    window.open(`/api/tariff-plans/${encodeURIComponent(selectedPlanId)}/export`, "_blank");
  };

  // Rule action handlers
  const handleOpenAddRule = () => {
    setEditingRule(null);
    setIsRuleModalOpen(true);
  };

  const handleOpenEditRule = (rule: T.RatingPolicy) => {
    setEditingRule(rule);
    setIsRuleModalOpen(true);
  };

  const handleToggleRuleStatus = async (rule: T.RatingPolicy) => {
    const ruleKey = rule.rule_id || String(rule.rating_group_id);
    try {
      const res = await fetch(
        `/api/tariff-plans/${encodeURIComponent(selectedPlanId)}/rules/${encodeURIComponent(ruleKey)}`,
        { method: "PATCH" }
      );
      if (res.ok) {
        await mutatePlans();
      }
    } catch (e) {
      console.error("Toggle rule status failed", e);
    }
  };

  const handleDeleteRule = async (rule: T.RatingPolicy) => {
    const ruleKey = rule.rule_id || String(rule.rating_group_id);
    if (!window.confirm(`Delete rule ${ruleKey}?`)) return;
    try {
      const res = await fetch(
        `/api/tariff-plans/${encodeURIComponent(selectedPlanId)}/rules/${encodeURIComponent(ruleKey)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        await mutatePlans();
      }
    } catch (e) {
      console.error("Delete rule failed", e);
    }
  };

  return (
    <>
      <div className="grid-gap-1-25">
        {/* Top Summary Stats */}
        <section className="stats-grid">
          {[
            {
              icon: <Tag size={18} color="var(--primary)" />,
              label: t("tariff_plan_ops_total_plans"),
              value: planOperationSummary?.totalPlans ?? plans.length,
            },
            {
              icon: <CheckCircle2 size={18} color="var(--success)" />,
              label: t("tariff_plan_ops_active_plans"),
              value:
                planOperationSummary?.activePlans ??
                plans.filter((plan: any) => (plan.status || "active") === "active").length,
            },
            {
              icon: <ShieldCheck size={18} color="var(--warning)" />,
              label: t("tariff_plan_ops_disabled_plans"),
              value:
                planOperationSummary?.disabledPlans ??
                plans.filter((plan: any) => plan.status === "disabled").length,
            },
            {
              icon: <Database size={18} color="var(--primary)" />,
              label: t("tariff_plan_ops_linked_total"),
              value:
                planOperationSummary?.totalLinkedSubscribers ??
                plans.reduce((sum: any, plan: any) => sum + (plan.subscriberCount || 0), 0),
            },
          ].map((item: any) => (
            <div key={item.label} className="dash-card stat-card">
              <div className="stat-card-header">
                {item.icon} {item.label}
              </div>
              <div className="stat-card-value">{item.value}</div>
            </div>
          ))}
        </section>

        {/* Plan Catalog Grid & Action Toolbar */}
        <section className="dash-card card-overflow-hidden">
          <div className="dash-card-header card-header-flex-wrap">
            <div>
              <h3 className="card-title-lg">{t("tariff_plan_catalog")}</h3>
              <p className="card-desc">{t("tariff_plan_catalog_desc")}</p>
            </div>
            {canEditTemplates && (
              <div className="tariff-toolbar">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={beginCreatePlan}
                  disabled={savingKey !== null}
                  title={t("tariff_plan_new")}
                >
                  <Plus size={15} color="var(--primary)" /> {t("tariff_plan_new")}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsCloneOpen(true)}
                  disabled={!selectedPlan || savingKey !== null}
                  title={t("tariff_plan_clone")}
                >
                  <Copy size={15} color="var(--primary)" /> {t("tariff_plan_clone")}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsImportOpen(true)}
                  title={t("tariff_plan_import")}
                >
                  <Upload size={15} /> {t("tariff_plan_import")}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={handleExportPlan}
                  disabled={!selectedPlan}
                  title={t("tariff_plan_export")}
                >
                  <Download size={15} /> {t("tariff_plan_export")}
                </button>
              </div>
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
                    <span>
                      {t("tariff_plan_rules")}: <strong className="plan-stat-val">{plan.rulesCount}</strong>
                    </span>
                    <span>
                      {t("tariff_plan_subscribers")}:{" "}
                      <strong className="plan-stat-val">{plan.subscriberCount}</strong>
                    </span>
                    {plan.isDefault && <StatusBadge tone="warning">{DEFAULT_OCS_PLAN_ID}</StatusBadge>}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Selected Plan Multi-Tab Container */}
        <section className="dash-card card-overflow-hidden">
          <div className="dash-card-header card-header-flex-wrap">
            <div className="grid-gap-0-35">
              <div className="flex-center-gap-0-65">
                <h3 className="card-title-xl">
                  {isCreatingPlan ? t("tariff_plan_new") : selectedPlan?.name || selectedPlan?.plan_id}
                </h3>
                {selectedPlan && !isCreatingPlan && (
                  <>
                    <StatusBadge tone={(selectedPlan.status || "active") === "active" ? "success" : "muted"}>
                      {(selectedPlan.status || "active") === "active"
                        ? t("policy_status_active")
                        : t("users_disabled")}
                    </StatusBadge>
                    {selectedPlan.isDefault && <StatusBadge tone="warning">{DEFAULT_OCS_PLAN_ID}</StatusBadge>}
                  </>
                )}
              </div>
              <p className="card-desc-mt">{t("tariff_plan_current_desc")}</p>
            </div>

            {canEditTemplates && !isCreatingPlan && (
              <div className="flex-end-gap-0-55">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleUpdatePlan}
                  disabled={!selectedPlan || savingKey !== null || isDisablingPlanWithSubscribers}
                >
                  <Save size={15} /> {t("tariff_plan_save")}
                </button>
                {selectedPlan && !selectedPlan.isDefault && (
                  <button
                    type="button"
                    className="btn btn-outline btn-danger-outline"
                    onClick={handleDeletePlan}
                    disabled={savingKey !== null || selectedPlanSubscriberTotal > 0}
                  >
                    <Trash2 size={15} /> {t("tariff_plan_delete")}
                  </button>
                )}
              </div>
            )}

            {isCreatingPlan && (
              <div className="flex-end-gap-0-55">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleCreatePlan}
                  disabled={savingKey !== null}
                >
                  <Save size={15} /> {t("tariff_plan_create_from_current")}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsCreatingPlan(false)}
                  disabled={savingKey !== null}
                >
                  <X size={15} /> {t("cancel")}
                </button>
              </div>
            )}
          </div>

          {/* Tab Navigation */}
          {!isCreatingPlan && (
            <div className="tariff-tabs">
              <button
                type="button"
                className={`tariff-tab-btn ${activeTab === "overview" ? "active" : ""}`}
                onClick={() => setActiveTab("overview")}
              >
                <Sliders size={15} /> {t("tariff_plan_tab_overview")}
              </button>
              <button
                type="button"
                className={`tariff-tab-btn ${activeTab === "rules" ? "active" : ""}`}
                onClick={() => setActiveTab("rules")}
              >
                <Layers size={15} /> {t("tariff_plan_tab_rules")}
                <span className="tariff-tab-count">{currentPlanRules.length}</span>
                {conflicts.length > 0 && <AlertTriangle size={14} color="var(--danger)" />}
              </button>
              <button
                type="button"
                className={`tariff-tab-btn ${activeTab === "migration" ? "active" : ""}`}
                onClick={() => setActiveTab("migration")}
              >
                <ArrowRightLeft size={15} /> {t("tariff_plan_tab_migration")}
                <span className="tariff-tab-count">{selectedPlanSubscriberTotal}</span>
              </button>
              <button
                type="button"
                className={`tariff-tab-btn ${activeTab === "history" ? "active" : ""}`}
                onClick={() => setActiveTab("history")}
              >
                <History size={15} /> {t("tariff_plan_tab_history")}
              </button>
            </div>
          )}

          {/* TAB 1: OVERVIEW & LIMITS */}
          {(activeTab === "overview" || isCreatingPlan) && (
            <div className="dash-card-body grid-gap-1-25">
              <div className="grid-gap-0-85">
                <h4 className="section-subtitle">{t("tariff_plan_basic_info")}</h4>
                <div className="fields-grid">
                  <Field label={t("tariff_plan_id")}>
                    {isCreatingPlan ? (
                      <input
                        className="form-input"
                        value={planForm.plan_id}
                        onChange={(event) =>
                          setPlanForm((current: any) => ({ ...current, plan_id: event.target.value }))
                        }
                      />
                    ) : (
                      <input className="form-input input-readonly" value={selectedPlan?.plan_id || selectedPlanId} readOnly />
                    )}
                  </Field>
                  <Field label={t("tariff_plan_name")}>
                    <input
                      className="form-input"
                      value={planForm.name}
                      onChange={(event) =>
                        setPlanForm((current: any) => ({ ...current, name: event.target.value }))
                      }
                      disabled={!canEditTemplates}
                    />
                  </Field>
                  <Field label={t("tariff_plan_status")}>
                    <select
                      className="form-input"
                      value={planForm.status}
                      onChange={(event) =>
                        setPlanForm((current: any) => ({ ...current, status: event.target.value }))
                      }
                      disabled={!canEditTemplates}
                    >
                      <option value="active">{t("policy_status_active")}</option>
                      <option value="disabled">{t("users_disabled")}</option>
                    </select>
                  </Field>
                  <div className="col-span-all">
                    <Field label={t("tariff_plan_desc")}>
                      <input
                        className="form-input"
                        value={planForm.description}
                        onChange={(event) =>
                          setPlanForm((current: any) => ({ ...current, description: event.target.value }))
                        }
                        disabled={!canEditTemplates}
                      />
                    </Field>
                  </div>
                </div>
              </div>

              {/* Default Grant & Quota Limits */}
              <div className="grid-gap-0-85">
                <h4 className="section-subtitle">{t("tariff_plan_grant_limits")}</h4>
                <div className="fields-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                  <Field label={t("tariff_plan_quota_grant")}>
                    <input
                      type="number"
                      className="form-input"
                      value={planForm.quota_per_grant ?? "10485760"}
                      onChange={(e) =>
                        setPlanForm((current: any) => ({ ...current, quota_per_grant: e.target.value }))
                      }
                      disabled={!canEditTemplates}
                    />
                  </Field>
                  <Field label={t("tariff_plan_validity_time")}>
                    <input
                      type="number"
                      className="form-input"
                      value={planForm.validity_time ?? "300"}
                      onChange={(e) =>
                        setPlanForm((current: any) => ({ ...current, validity_time: e.target.value }))
                      }
                      disabled={!canEditTemplates}
                    />
                  </Field>
                  <Field label={t("tariff_plan_vol_threshold")}>
                    <input
                      type="number"
                      className="form-input"
                      value={planForm.volume_threshold ?? "8388608"}
                      onChange={(e) =>
                        setPlanForm((current: any) => ({ ...current, volume_threshold: e.target.value }))
                      }
                      disabled={!canEditTemplates}
                    />
                  </Field>
                </div>
              </div>

              <div className="usage-overview">
                <h4 className="section-subtitle">{t("tariff_plan_usage_overview")}</h4>
                <div className="usage-grid">
                  {[
                    { label: t("tariff_plan_rules"), value: selectedPlan?.rulesCount ?? ratings.length },
                    { label: t("tariff_plan_subscribers"), value: selectedPlanSubscriberTotal },
                    {
                      label: t("tariff_plan_ops_selected_share"),
                      value: `${planOperationSummary?.selectedSharePct ?? 0}%`,
                    },
                    {
                      label: t("tariff_plan_ops_last_change"),
                      value: formatDateTime(planOperationSummary?.lastChangedAt),
                    },
                  ].map((item: any) => (
                    <div key={item.label} className="usage-card">
                      <div className="usage-label">{item.label}</div>
                      <div className="usage-val">{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {isDisablingPlanWithSubscribers && (
                <div className="disable-warning">{t("tariff_plan_disable_in_use")}</div>
              )}
            </div>
          )}

          {/* TAB 2: RULES MATRIX & PRIORITY ENGINE */}
          {!isCreatingPlan && activeTab === "rules" && (
            <div className="dash-card-body grid-gap-1">
              {/* Conflict Alert Banner */}
              {conflicts.length > 0 && (
                <ErrorNotice icon={<AlertTriangle size={18} />}>
                  <strong>{t("tariff_rule_conflict_warning")} ({conflicts.length})</strong>
                  <p style={{ margin: "0 0 0.5rem 0", fontSize: "var(--ref-font-size-body-compact)", opacity: 0.9 }}>
                    {t("tariff_rule_conflict_desc")}
                  </p>
                  <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "var(--ref-font-size-data-relaxed)" }}>
                    {conflicts.map((c, i) => (
                      <li key={i}>
                        APN: <code>{c.signature.apn}</code>, RG: <code>{c.signature.rating_group_id}</code>, SI: <code>{c.signature.service_identifier}</code> — Overlapping Rules: <strong>{c.rule_ids.join(", ")}</strong>
                      </li>
                    ))}
                  </ul>
                </ErrorNotice>
              )}

              {/* Rules Toolbar */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                <div className="search-wrapper" style={{ flex: 1, maxWidth: 360 }}>
                  <Search size={16} className="search-icon" />
                  <input
                    type="text"
                    className="form-input search-input"
                    placeholder="Filter rules by ID, APN, RG, SI..."
                    value={ruleSearchQuery}
                    onChange={(e) => setRuleSearchQuery(e.target.value)}
                  />
                </div>

                {canEditTemplates && (
                  <button type="button" className="btn btn-primary" onClick={handleOpenAddRule}>
                    <Plus size={15} /> {t("tariff_rule_add")}
                  </button>
                )}
              </div>

              {/* Rules Matrix Table */}
              <div className="table-container" style={{ border: "1px solid var(--surface-border)", borderRadius: "var(--ref-radius-control)", overflow: "hidden" }}>
                <table className="rules-matrix-table">
                  <caption className="sr-only">{selectedPlan?.name || selectedPlanId} · {t("tariff_plan_rules")}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: 60 }} data-column-priority="important">Priority</th>
                      <th data-column-priority="essential">Rule ID</th>
                      <th data-column-priority="essential">Scenario</th>
                      <th data-column-priority="important">APN / DNN</th>
                      <th data-column-priority="supplementary">RG / SI</th>
                      <th data-column-priority="essential">Rate</th>
                      <th data-column-priority="important">Grant Quota</th>
                      <th data-column-priority="supplementary">Validity</th>
                      <th data-column-priority="essential">Status</th>
                      {canEditTemplates && <th style={{ textAlign: "right", width: 120 }} data-column-priority="essential">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePlanRules.length === 0 ? (
                      <DataTableStateRow colSpan={canEditTemplates ? 10 : 9} state="empty">
                        No rating rules found for this plan.
                      </DataTableStateRow>
                    ) : (
                      visiblePlanRules.map((rule) => {
                        const ruleKey = rule.rule_id || `rg_${rule.rating_group_id}`;
                        const isConflicted = conflictingRuleIds.has(rule.rule_id || "");
                        const isRuleActive = (rule.status || "active") === "active";

                        return (
                          <tr key={ruleKey} className={isConflicted ? "rule-conflict-row" : ""}>
                            <td data-label="Priority" data-column-priority="important">
                              <span className="rule-priority-badge">{rule.priority ?? 0}</span>
                            </td>
                            <td data-label="Rule ID" data-column-priority="essential">
                              <div style={{ fontWeight: 700, color: "var(--text-main)", fontFamily: "monospace" }}>
                                {rule.rule_id || `Rule #${rule.rating_group_id}`}
                              </div>
                              {isConflicted && (
                                <span className="rule-conflict-badge" style={{ marginTop: "0.2rem" }}>
                                  <AlertTriangle size={11} /> Overlap
                                </span>
                              )}
                            </td>
                            <td data-label="Scenario" data-column-priority="essential">
                              <span style={{ textTransform: "capitalize", fontWeight: 600, fontSize: "var(--ref-font-size-data-relaxed)" }}>
                                {(rule.charging_type || "data_volume").replace("_", " ")}
                              </span>
                            </td>
                            <td data-label="APN / DNN" data-column-priority="important">
                              <code style={{ fontSize: "var(--ref-font-size-body-compact)", color: "var(--primary)" }}>{rule.apn || "internet"}</code>
                            </td>
                            <td data-label="RG / SI" data-column-priority="supplementary">
                              <span style={{ fontFamily: "monospace", fontSize: "var(--ref-font-size-body-compact)" }}>
                                RG:{rule.rating_group_id} / SI:{rule.service_identifier ?? 1}
                              </span>
                            </td>
                            <td data-label="Rate" data-column-priority="essential">
                              <span style={{ fontWeight: 700, fontFamily: "monospace" }}>
                                {rule.rates || "0"} {rule.currency || "USD"}
                              </span>
                            </td>
                            <td style={{ fontSize: "var(--ref-font-size-data-relaxed)" }} data-label="Grant Quota" data-column-priority="important">
                              {formatGrant(t, rule.quota_per_grant, rule.unit, rule.charging_type)}
                            </td>
                            <td style={{ fontSize: "var(--ref-font-size-data-relaxed)" }} data-label="Validity" data-column-priority="supplementary">
                              {rule.validity_time ? `${rule.validity_time}s` : "Default"}
                            </td>
                            <td data-label="Status" data-column-priority="essential">
                              <StatusBadge tone={isRuleActive ? "success" : "muted"}>
                                {isRuleActive ? t("policy_status_active") : t("users_disabled")}
                              </StatusBadge>
                            </td>
                            {canEditTemplates && (
                              <td style={{ textAlign: "right" }} data-label="Actions" data-column-priority="essential">
                                <div style={{ display: "inline-flex", gap: "0.35rem" }}>
                                  <button
                                    type="button"
                                    className="btn-icon"
                                    title={t("tariff_rule_toggle")}
                                    onClick={() => handleToggleRuleStatus(rule)}
                                  >
                                    <Power size={14} color={isRuleActive ? "var(--success)" : "var(--text-muted)"} />
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-icon"
                                    title={t("tariff_rule_edit")}
                                    onClick={() => handleOpenEditRule(rule)}
                                  >
                                    <Pencil size={14} color="var(--primary)" />
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-icon"
                                    title={t("tariff_rule_delete")}
                                    onClick={() => handleDeleteRule(rule)}
                                  >
                                    <Trash2 size={14} color="var(--danger)" />
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: SUBSCRIBER MIGRATION */}
          {!isCreatingPlan && activeTab === "migration" && (
            <div className="dash-card-body grid-gap-1-25">
              <div>
                <h4 className="section-subtitle flex-center-gap-0-55">
                  <ArrowRightLeft size={17} color="var(--primary)" /> {t("tariff_plan_migrate_title")}
                </h4>
                <p className="card-desc-mt desc-line-1-5">
                  {selectedPlanSubscriberTotal > 0
                    ? t("tariff_plan_migrate_desc", { count: selectedPlanSubscriberTotal })
                    : t("tariff_plan_migrate_empty")}
                </p>
              </div>

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

              {/* Dry-Run Analysis Panel */}
              {dryRunLoading && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-muted)", fontSize: "var(--ref-font-size-body-compact)" }}>
                  <RefreshCw size={15} className="animate-spin" /> Calculating migration impact...
                </div>
              )}

              {dryRunPreview && !dryRunLoading && (
                <div className="dryrun-panel">
                  <div>
                    <div className="dryrun-stat-label">{t("tariff_plan_dryrun_active")}</div>
                    <div className="dryrun-stat-value" style={{ color: "var(--success)" }}>
                      {dryRunPreview.activeCount}
                    </div>
                  </div>
                  <div>
                    <div className="dryrun-stat-label">{t("tariff_plan_dryrun_suspended")}</div>
                    <div className="dryrun-stat-value" style={{ color: "var(--warning)" }}>
                      {dryRunPreview.suspendedCount}
                    </div>
                  </div>
                  <div>
                    <div className="dryrun-stat-label">Target Plan Status</div>
                    <div className="dryrun-stat-value" style={{ fontSize: "var(--ref-font-size-body)" }}>
                      <StatusBadge tone={dryRunPreview.isTargetActive ? "success" : "muted"}>
                        {dryRunPreview.targetPlan.status}
                      </StatusBadge>
                    </div>
                  </div>
                </div>
              )}

              {dryRunError && (
                <ErrorNotice icon={<AlertTriangle size={16} />}>{dryRunError}</ErrorNotice>
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
                      ) : (
                        migrationTargetOptions.map((plan: any) => (
                          <option key={plan.plan_id} value={plan.plan_id}>
                            {plan.name && plan.name !== plan.plan_id
                              ? `${plan.name} (${plan.plan_id})`
                              : plan.plan_id}
                          </option>
                        ))
                      )}
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
                    disabled={
                      savingKey !== null ||
                      !migrationTargetPlanId ||
                      selectedPlanSubscriberTotal === 0 ||
                      (dryRunPreview ? !dryRunPreview.isTargetActive : false)
                    }
                  >
                    <ArrowRightLeft size={15} />{" "}
                    {savingKey === "plan:migrate"
                      ? t("policy_change_applying")
                      : t("tariff_plan_migrate_apply")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: AUDIT & OPERATIONS HISTORY */}
          {!isCreatingPlan && activeTab === "history" && (
            <div className="dash-card-body grid-gap-1">
              <div className="card-header-flex">
                <div>
                  <h4 className="section-subtitle flex-center-gap-0-55">
                    <History size={17} color="var(--primary)" /> {t("tariff_plan_ops_history")}
                  </h4>
                  <p className="card-desc-mt">{t("tariff_plan_ops_desc")}</p>
                </div>
                <span className="history-count">
                  {t("tariff_plan_ops_recent_count", {
                    count:
                      planOperationSummary?.recentActivityCount ?? planOperationHistory.length,
                  })}
                </span>
              </div>

              {planOperationHistory.length === 0 ? (
                <div className="history-empty">{t("tariff_plan_ops_no_history")}</div>
              ) : (
                <div className="history-list">
                  {planOperationHistory.map((item: any) => (
                    <div
                      key={item.id}
                      className={`history-item ${
                        item.level === "warning" ? "history-item-warning" : "history-item-primary"
                      }`}
                    >
                      <div className="history-item-header">
                        <span
                          className={
                            item.level === "warning" ? "history-action-warning" : "history-action-primary"
                          }
                        >
                          {formatPlanOperationAction(item.action)}
                        </span>
                        <span className="history-time">{formatDateTime(item.timestamp)}</span>
                      </div>
                      <div className="history-details">
                        <span>
                          {t("tariff_plan_ops_target")}:{" "}
                          <span className="history-target">{item.targetId}</span>
                        </span>
                        <span>
                          {t("tariff_plan_ops_operator")}: {item.operatorIp}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Modals */}
      <TariffPlanCloneModal
        isOpen={isCloneOpen}
        onClose={() => setIsCloneOpen(false)}
        sourcePlan={selectedPlan || null}
        onSuccess={async (newPlanId) => {
          await mutatePlans();
          await mutatePlanOperations();
          setSelectedPlanId(newPlanId);
        }}
      />

      <TariffPlanImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onSuccess={async (importedPlanId) => {
          await mutatePlans();
          await mutatePlanOperations();
          setSelectedPlanId(importedPlanId);
        }}
      />

      <TariffRuleModal
        isOpen={isRuleModalOpen}
        onClose={() => setIsRuleModalOpen(false)}
        planId={selectedPlanId}
        existingRules={currentPlanRules}
        initialRule={editingRule}
        onSuccess={async () => {
          await mutatePlans();
        }}
      />
    </>
  );
}
