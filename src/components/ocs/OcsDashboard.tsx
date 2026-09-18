"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CreditCard,
  Database,
  FileText,
  Gauge,
  Users,
  Wallet,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";
import RefreshButton from "@/components/ui/RefreshButton";
import { formatBytes } from "@/lib/unitParser";

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  detail?: string;
  color?: string;
}

function SummaryCard({ icon, label, value, detail, color }: SummaryCardProps) {
  return (
    <div className="ocs-dashboard-card">
      <div className="ocs-dashboard-card-icon" style={color ? { color } : undefined}>{icon}</div>
      <div className="ocs-dashboard-card-body">
        <span className="ocs-dashboard-card-label">{label}</span>
        <span className="ocs-dashboard-card-value">{value}</span>
        {detail ? <span className="ocs-dashboard-card-detail">{detail}</span> : null}
      </div>
    </div>
  );
}

export default function OcsDashboard() {
  const { t } = useI18n();

  const { data: balancesData, isLoading: balancesLoading, mutate: mutateBalances } = useSWR(
    "/api/ocs/balances?limit=1",
    fetcher,
  );

  const { data: plansData, isLoading: plansLoading, mutate: mutatePlans } = useSWR(
    "/api/tariff-plans",
    fetcher,
  );

  const { data: approvalsData, isLoading: approvalsLoading, mutate: mutateApprovals } = useSWR(
    "/api/approvals?status=pending&limit=1",
    fetcher,
  );

  const loading = balancesLoading || plansLoading || approvalsLoading;

  const refresh = () => {
    mutateBalances();
    mutatePlans();
    mutateApprovals();
  };

  const balanceSummary = balancesData?.summary || {};
  const activeSubscribers = balanceSummary.totalSubscribers || 0;
  const totalAllocated = balanceSummary.totalDataAllocated || 0;
  const totalUsed = balanceSummary.totalDataUsed || 0;
  const totalAvailable = balanceSummary.totalDataAvailable || 0;

  const plans = plansData?.plans || [];
  const activePlans = plans.filter((p: any) => p.status === "active").length;
  const totalPlans = plans.length;

  const pendingApprovals = approvalsData?.total || 0;

  const utilizationPct = totalAllocated > 0
    ? Math.round((totalUsed / totalAllocated) * 100)
    : 0;

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t("nav_ocs")}
        title={t("ocs_dashboard_title")}
        description={t("ocs_dashboard_desc")}
        actions={
          <RefreshButton loading={loading} onClick={refresh} label={t("refresh")} className="ocs-btn" />
        }
      />

      <div className="ocs-dashboard-grid">
        <SummaryCard
          icon={<Users size={24} />}
          label={t("ocs_dashboard_active_subscribers")}
          value={activeSubscribers}
          detail={t("ocs_dashboard_active_subscribers_detail")}
        />
        <SummaryCard
          icon={<FileText size={24} />}
          label={t("ocs_dashboard_active_tariffs")}
          value={`${activePlans} / ${totalPlans}`}
          detail={t("ocs_dashboard_active_tariffs_detail")}
        />
        <SummaryCard
          icon={<AlertCircle size={24} />}
          label={t("ocs_dashboard_pending_governance")}
          value={pendingApprovals}
          detail={t("ocs_dashboard_pending_governance_detail")}
          color={pendingApprovals > 0 ? "var(--color-amber)" : undefined}
        />
        <SummaryCard
          icon={<Wallet size={24} />}
          label={t("ocs_dashboard_balance_utilization")}
          value={`${utilizationPct}%`}
          detail={`${formatBytes(totalUsed)} / ${formatBytes(totalAllocated)}`}
        />
      </div>

      <div className="ocs-dashboard-section">
        <h3 className="ocs-dashboard-section-title">{t("ocs_dashboard_balance_pool_title")}</h3>
        <div className="ocs-dashboard-pool-grid">
          <div className="ocs-dashboard-pool-item">
            <span className="ocs-dashboard-pool-label">{t("dash_ocs_data_allocated")}</span>
            <span className="ocs-dashboard-pool-value">{formatBytes(totalAllocated)}</span>
          </div>
          <div className="ocs-dashboard-pool-item">
            <span className="ocs-dashboard-pool-label">{t("dash_ocs_data_used")}</span>
            <span className="ocs-dashboard-pool-value">{formatBytes(totalUsed)}</span>
          </div>
          <div className="ocs-dashboard-pool-item">
            <span className="ocs-dashboard-pool-label">{t("dash_ocs_data_available")}</span>
            <span className="ocs-dashboard-pool-value">{formatBytes(totalAvailable)}</span>
          </div>
          <div className="ocs-dashboard-pool-item">
            <span className="ocs-dashboard-pool-label">{t("dash_ocs_data_reserved")}</span>
            <span className="ocs-dashboard-pool-value">{formatBytes(balanceSummary.totalDataReserved || 0)}</span>
          </div>
        </div>
      </div>

      <div className="ocs-dashboard-section">
        <h3 className="ocs-dashboard-section-title">{t("ocs_dashboard_tariff_plans")}</h3>
        <div className="ocs-dashboard-plans-list">
          {plans.map((plan: any) => (
            <div key={plan.plan_id} className="ocs-dashboard-plan-item">
              <div className="ocs-dashboard-plan-name">
                <span className={`ocs-status-badge ocs-status-${plan.status}`}>{plan.status}</span>
                <strong>{plan.name || plan.plan_id}</strong>
                {plan.isDefault ? <span className="ocs-default-badge">Default</span> : null}
              </div>
              <div className="ocs-dashboard-plan-meta">
                <span>{plan.subscriberCount} {t("ocs_dashboard_subscribers")}</span>
                <span>{plan.rulesCount} {t("ocs_dashboard_rules")}</span>
              </div>
            </div>
          ))}
          {plans.length === 0 && !loading && (
            <div className="ocs-empty">{t("no_data")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
