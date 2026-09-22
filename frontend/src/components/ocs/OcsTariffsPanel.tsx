"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  FileText,
  Copy,
  Power,
  PowerOff,
  Trash2,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import OcsPageShell from "./OcsPageShell";

interface TariffPlan {
  plan_id: string;
  name: string;
  description: string;
  status: string;
  rulesCount: number;
  subscriberCount: number;
  isDefault: boolean;
  quota_per_grant?: number;
  validity_time?: number;
  volume_threshold?: number;
  created_at?: string;
  updated_at?: string;
}

interface ActionFeedback {
  type: "success" | "error";
  message: string;
}

export default function OcsTariffsPanel() {
  const { t } = useI18n();
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const { data, isLoading: loading, mutate: refresh } = useSWR(
    "/api/tariff-plans",
    fetcher,
    { keepPreviousData: true }
  );

  const plans: TariffPlan[] = data?.plans || [];

  const activePlans = plans.filter((p) => p.status === "active").length;
  const disabledPlans = plans.filter((p) => p.status === "disabled").length;
  const totalSubscribers = plans.reduce((sum, p) => sum + p.subscriberCount, 0);

  const handleAction = async (action: string, planId: string) => {
    const actionKey = `${action}:${planId}`;
    setPendingAction(actionKey);
    setActionFeedback(null);

    try {
      let res: Response;
      if (action === "clone") {
        const targetPlanId = `${planId}_copy_${Date.now()}`;
        res = await fetch(`/api/tariff-plans/${planId}/clone`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_plan_id: targetPlanId }),
        });
      } else if (action === "enable") {
        res = await fetch(`/api/tariff-plans/${planId}/enable`, { method: "POST" });
      } else if (action === "disable") {
        res = await fetch(`/api/tariff-plans/${planId}/disable`, { method: "POST" });
      } else if (action === "delete") {
        res = await fetch(`/api/tariff-plans/${planId}`, { method: "DELETE" });
      } else {
        return;
      }

      const body = await res.json();
      if (res.ok || res.status === 202) {
        setActionFeedback({ type: "success", message: t("ocs_tariff_action_success") });
        refresh();
      } else {
        setActionFeedback({ type: "error", message: body.error || t("ocs_tariff_action_failed") });
      }
    } catch {
      setActionFeedback({ type: "error", message: t("ocs_tariff_action_failed") });
    } finally {
      setPendingAction(null);
    }
  };

  const kpiGrid = (
    <div className="ocs-dashboard-grid">
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><FileText size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{plans.length}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_tariff_total_plans")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><CheckCircle size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{activePlans}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_tariff_active_plans")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><XCircle size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{disabledPlans}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_tariff_disabled_plans")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><FileText size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{totalSubscribers}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_tariff_total_subscribers")}</span>
        </div>
      </div>
    </div>
  );

  return (
    <OcsPageShell
      eyebrow={t("nav_ocs")}
      title={t("ocs_tariffs_title")}
      description={t("ocs_tariffs_desc")}
      loading={loading}
      onRefresh={() => refresh()}
      kpiGrid={kpiGrid}
      controls={null}
      tableContent={
        <>
          {actionFeedback && (
            <div className={actionFeedback.type === "success" ? "ocs-feedback-success" : "ocs-feedback-error"}>
              {actionFeedback.message}
            </div>
          )}
          <div className="ocs-table-wrap">
            <table className="ocs-table">
              <caption className="sr-only">{t("ocs_tariffs_title")}</caption>
              <thead>
                <tr>
                  <th>{t("ocs_tariff_col_plan_id")}</th>
                  <th>{t("ocs_tariff_col_name")}</th>
                  <th>{t("ocs_tariff_col_status")}</th>
                  <th>{t("ocs_tariff_col_rules")}</th>
                  <th>{t("ocs_tariff_col_subscribers")}</th>
                  <th>{t("ocs_tariff_col_updated")}</th>
                  <th>{t("ocs_tariff_col_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {plans.length === 0 && !loading && (
                  <tr><td colSpan={7} className="ocs-empty">{t("no_data")}</td></tr>
                )}
                {plans.map((plan) => (
                  <tr key={plan.plan_id}>
                    <td className="ocs-mono">{plan.plan_id}</td>
                    <td>{plan.name}</td>
                    <td>
                      <span className={`ocs-status-badge ocs-status-${plan.status}`}>
                        {plan.status}
                      </span>
                    </td>
                    <td>{plan.rulesCount}</td>
                    <td>{plan.subscriberCount}</td>
                    <td>{plan.updated_at ? new Date(plan.updated_at).toLocaleDateString() : "—"}</td>
                    <td>
                      <div className="ocs-action-group">
                        {plan.status === "active" ? (
                          <button
                            className="ocs-action-btn"
                            title={t("ocs_tariff_disable")}
                            disabled={pendingAction === `disable:${plan.plan_id}`}
                            onClick={() => handleAction("disable", plan.plan_id)}
                          >
                            <PowerOff size={14} />
                          </button>
                        ) : (
                          <button
                            className="ocs-action-btn"
                            title={t("ocs_tariff_enable")}
                            disabled={pendingAction === `enable:${plan.plan_id}`}
                            onClick={() => handleAction("enable", plan.plan_id)}
                          >
                            <Power size={14} />
                          </button>
                        )}
                        <button
                          className="ocs-action-btn"
                          title={t("ocs_tariff_clone")}
                          disabled={pendingAction === `clone:${plan.plan_id}`}
                          onClick={() => handleAction("clone", plan.plan_id)}
                        >
                          <Copy size={14} />
                        </button>
                        {!plan.isDefault && (
                          <button
                            className="ocs-action-btn ocs-action-danger"
                            title={t("ocs_tariff_delete")}
                            disabled={pendingAction === `delete:${plan.plan_id}`}
                            onClick={() => handleAction("delete", plan.plan_id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      }
      pagination={null}
    />
  );
}
