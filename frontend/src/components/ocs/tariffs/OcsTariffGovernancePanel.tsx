"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import Link from "next/link";
import {
  Copy,
  Eye,
  Power,
  PowerOff,
  Trash2,
  FileText,
  CheckCircle,
  XCircle,
  Plus,
  Pencil,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import OcsPageShell from "../OcsPageShell";
import OcsStatusBadge from "../common/OcsStatusBadge";
import GovernanceBadge from "../common/GovernanceBadge";
import ConfirmDialog from "../common/ConfirmDialog";
import TariffPlanModal from "./TariffPlanModal";
import type { TariffPlan } from "@/lib/api/ocs";

interface ActionFeedback {
  type: "success" | "error";
  message: string;
  approvalId?: string;
}

export default function OcsTariffGovernancePanel() {
  const { t } = useI18n();
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ action: string; planId: string } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPlanForEdit, setSelectedPlanForEdit] = useState<TariffPlan | null>(null);

  const { data, isLoading: loading, mutate: refresh } = useSWR(
    "/api/tariff-plans",
    fetcher,
    { keepPreviousData: true },
  );

  const plans: TariffPlan[] = data?.plans || [];

  const activePlans = plans.filter((p) => p.status === "active").length;
  const disabledPlans = plans.filter((p) => p.status === "disabled").length;
  const totalSubscribers = plans.reduce((sum, p) => sum + p.subscriberCount, 0);

  const handleAction = async (action: string, planId: string) => {
    const actionKey = `${action}:${planId}`;
    setPendingAction(actionKey);
    setActionFeedback(null);
    setConfirmAction(null);

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
        const isApproval = body.outcome === "approval_required";
        const msg = isApproval
          ? t("ocs_tariff_approval_created")
          : t("ocs_tariff_action_success");
        setActionFeedback({
          type: "success",
          message: msg,
          approvalId: body.approval_id || body.approvalId,
        });
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

  const requestDelete = (planId: string) => {
    setConfirmAction({ action: "delete", planId });
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
    <>
      <OcsPageShell
        eyebrow={t("nav_ocs")}
        title={t("ocs_tariffs_title")}
        readonly={false}
        description={t("ocs_tariffs_desc")}
        loading={loading}
        onRefresh={() => refresh()}
        kpiGrid={kpiGrid}
        controls={
          <div className="ocs-controls-bar" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="ocs-btn ocs-btn-primary"
              onClick={() => {
                setSelectedPlanForEdit(null);
                setModalOpen(true);
              }}
            >
              <Plus size={16} />
              <span>{t("ocs_tariff_create")}</span>
            </button>
          </div>
        }
        tableContent={
          <>
            {actionFeedback && (
              <div className={actionFeedback.type === "success" ? "ocs-feedback-success" : "ocs-feedback-error"}>
                <span>{actionFeedback.message}</span>
                {actionFeedback.approvalId && (
                  <Link href={`/approvals?id=${encodeURIComponent(actionFeedback.approvalId)}`} className="ocs-feedback-link">
                    {t("nav_approvals")} ({actionFeedback.approvalId}) →
                  </Link>
                )}
              </div>
            )}
            <div className="ocs-table-wrap">
              <table className="ocs-table">
                <caption className="sr-only">{t("ocs_tariffs_title")}</caption>
                <thead>
                  <tr>
                    <th data-column-priority="essential">{t("ocs_tariff_col_plan_id")}</th>
                    <th data-column-priority="essential">{t("ocs_tariff_col_name")}</th>
                    <th data-column-priority="essential">{t("ocs_tariff_col_status")}</th>
                    <th data-column-priority="supplementary">{t("ocs_tariff_governance_col_version")}</th>
                    <th data-column-priority="important">{t("ocs_tariff_col_subscribers")}</th>
                    <th data-column-priority="supplementary">{t("ocs_tariff_governance_col_updated_by")}</th>
                    <th data-column-priority="supplementary">{t("ocs_tariff_col_updated")}</th>
                    <th data-column-priority="essential">{t("ocs_tariff_governance_col_governance")}</th>
                    <th data-column-priority="essential">{t("ocs_tariff_col_actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.length === 0 && !loading && (
                    <tr><td colSpan={9} className="ocs-empty">{t("no_data")}</td></tr>
                  )}
                  {plans.map((plan) => (
                    <tr key={plan.plan_id}>
                      <td data-label={t("ocs_tariff_col_plan_id")} data-column-priority="essential" className="ocs-mono">{plan.plan_id}</td>
                      <td data-label={t("ocs_tariff_col_name")} data-column-priority="essential">{plan.name}</td>
                      <td data-label={t("ocs_tariff_col_status")} data-column-priority="essential"><OcsStatusBadge status={plan.status} /></td>
                      <td data-label={t("ocs_tariff_governance_col_version")} data-column-priority="supplementary" className="ocs-mono">v{plan.version || 1}</td>
                      <td data-label={t("ocs_tariff_col_subscribers")} data-column-priority="important">{plan.subscriberCount}</td>
                      <td data-label={t("ocs_tariff_governance_col_updated_by")} data-column-priority="supplementary">{plan.updated_by || "—"}</td>
                      <td data-label={t("ocs_tariff_col_updated")} data-column-priority="supplementary">{plan.updated_at ? new Date(plan.updated_at).toLocaleDateString() : "—"}</td>
                      <td data-label={t("ocs_tariff_governance_col_governance")} data-column-priority="essential"><GovernanceBadge compact /></td>
                      <td data-label={t("ocs_tariff_col_actions")} data-column-priority="essential">
                        <div className="ocs-action-group">
                          <Link
                            className="ocs-action-btn"
                            title={t("ocs_tariff_view_detail")}
                            href={`/ocs/tariffs/${plan.plan_id}`}
                          >
                            <Eye size={14} />
                          </Link>
                          <button
                            type="button"
                            className="ocs-action-btn"
                            title={t("ocs_tariff_edit")}
                            onClick={() => {
                              setSelectedPlanForEdit(plan);
                              setModalOpen(true);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
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
                              onClick={() => requestDelete(plan.plan_id)}
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
      {modalOpen && (
        <TariffPlanModal
          isOpen={modalOpen}
          plan={selectedPlanForEdit}
          onClose={() => {
            setModalOpen(false);
            setSelectedPlanForEdit(null);
          }}
          onSuccess={(result) => {
            setActionFeedback({
              type: "success",
              message: result.message,
              approvalId: result.approvalId,
            });
            refresh();
          }}
        />
      )}
      {confirmAction && (
        <ConfirmDialog
          title={t("ocs_confirm_danger_title")}
          message={t("ocs_confirm_danger_message").replace("{action}", confirmAction.action)}
          danger
          loading={!!pendingAction}
          onConfirm={() => handleAction(confirmAction.action, confirmAction.planId)}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
}
