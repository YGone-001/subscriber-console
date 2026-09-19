"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  History,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";
import RefreshButton from "@/components/ui/RefreshButton";

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

export default function OcsGovernanceDashboard() {
  const { t } = useI18n();

  const { data: activeSubsData, isLoading: activeLoading, mutate: mutateActive } = useSWR(
    "/api/ocs/subscribers?status=active&limit=1",
    fetcher,
  );

  const { data: suspendedSubsData, isLoading: suspendedLoading, mutate: mutateSuspended } = useSWR(
    "/api/ocs/subscribers?status=suspended&limit=1",
    fetcher,
  );

  const { data: terminatedSubsData, isLoading: terminatedLoading, mutate: mutateTerminated } = useSWR(
    "/api/ocs/subscribers?status=terminated&limit=1",
    fetcher,
  );

  const { data: plansData, isLoading: plansLoading, mutate: mutatePlans } = useSWR(
    "/api/tariff-plans",
    fetcher,
  );

  const { data: approvalsData, isLoading: approvalsLoading, mutate: mutateApprovals } = useSWR(
    "/api/approvals?limit=10",
    fetcher,
  );

  const { data: auditData, isLoading: auditLoading, mutate: mutateAudit } = useSWR(
    "/api/audit?limit=10&module=ocs",
    fetcher,
  );

  const loading = activeLoading || suspendedLoading || terminatedLoading || plansLoading || approvalsLoading || auditLoading;

  const refresh = () => {
    mutateActive();
    mutateSuspended();
    mutateTerminated();
    mutatePlans();
    mutateApprovals();
    mutateAudit();
  };

  const activeContracts = activeSubsData?.total ?? 0;
  const suspendedContracts = suspendedSubsData?.total ?? 0;
  const terminatedContracts = terminatedSubsData?.total ?? 0;

  const plans: any[] = plansData?.plans || [];
  const activeTariffs = plans.filter((p: any) => p.status === "active").length;
  const disabledTariffs = plans.filter((p: any) => p.status === "disabled").length;

  const pendingApprovals = approvalsData?.summary?.awaiting ?? approvalsData?.pagination?.total ?? 0;
  const approvedToday = approvalsData?.summary?.todayApproved ?? 0;

  const auditLogs: any[] = auditData?.logs || [];
  const todayFailures = auditLogs.filter((l: any) => l.result === "failure").length;

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t("nav_ocs")}
        title={t("ocs_overview_title")}
        description={t("ocs_overview_desc")}
        actions={
          <RefreshButton loading={loading} onClick={refresh} label={t("refresh")} className="ocs-btn" />
        }
      />

      {/* Contract Summary */}
      <div className="ocs-dashboard-section">
        <h3 className="ocs-dashboard-section-title">
          <Users size={16} /> {t("ocs_overview_contract_summary")}
        </h3>
        <div className="ocs-dashboard-grid">
          <SummaryCard
            icon={<CheckCircle2 size={24} />}
            label={t("ocs_overview_active_contracts")}
            value={activeContracts}
          />
          <SummaryCard
            icon={<AlertCircle size={24} />}
            label={t("ocs_overview_suspended_contracts")}
            value={suspendedContracts}
            color={suspendedContracts > 0 ? "var(--color-amber)" : undefined}
          />
          <SummaryCard
            icon={<XCircle size={24} />}
            label={t("ocs_overview_terminated_contracts")}
            value={terminatedContracts}
          />
        </div>
      </div>

      {/* Tariff Summary */}
      <div className="ocs-dashboard-section">
        <h3 className="ocs-dashboard-section-title">
          <FileText size={16} /> {t("ocs_overview_tariff_summary")}
        </h3>
        <div className="ocs-dashboard-grid">
          <SummaryCard
            icon={<CheckCircle2 size={24} />}
            label={t("ocs_overview_active_tariffs")}
            value={activeTariffs}
          />
          <SummaryCard
            icon={<XCircle size={24} />}
            label={t("ocs_overview_disabled_tariffs")}
            value={disabledTariffs}
          />
          <SummaryCard
            icon={<FileText size={24} />}
            label={t("ocs_overview_total_tariffs")}
            value={plans.length}
          />
        </div>
      </div>

      {/* Governance Summary */}
      <div className="ocs-dashboard-section">
        <h3 className="ocs-dashboard-section-title">
          <ShieldCheck size={16} /> {t("ocs_overview_governance_summary")}
        </h3>
        <div className="ocs-dashboard-grid">
          <SummaryCard
            icon={<Clock size={24} />}
            label={t("ocs_overview_pending_approvals")}
            value={pendingApprovals}
            color={pendingApprovals > 0 ? "var(--color-amber)" : undefined}
          />
          <SummaryCard
            icon={<CheckCircle2 size={24} />}
            label={t("ocs_overview_approved_today")}
            value={approvedToday}
          />
          <SummaryCard
            icon={<AlertCircle size={24} />}
            label={t("ocs_overview_failed_operations")}
            value={todayFailures}
            color={todayFailures > 0 ? "var(--color-red)" : undefined}
          />
        </div>
      </div>

      {/* Recent Governance Activity */}
      <div className="ocs-dashboard-section">
        <h3 className="ocs-dashboard-section-title">
          <History size={16} /> {t("ocs_overview_recent_activities")}
        </h3>
        <div className="ocs-table-card">
          <div className="ocs-table-wrapper">
            <table className="ocs-table">
              <caption className="sr-only">{t("ocs_overview_recent_activities")}</caption>
              <thead>
                <tr>
                  <th>{t("ocs_audit_col_action")}</th>
                  <th>{t("ocs_audit_col_object")}</th>
                  <th>{t("ocs_audit_col_operator")}</th>
                  <th>{t("ocs_audit_col_timestamp")}</th>
                  <th>{t("ocs_audit_col_result")}</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.length === 0 && !loading ? (
                  <tr><td colSpan={5} className="ocs-empty">{t("no_data")}</td></tr>
                ) : (
                  auditLogs.slice(0, 8).map((log: any) => (
                    <tr key={log._id}>
                      <td>{log.action}</td>
                      <td>{log.resource?.id || log.targetId || "—"}</td>
                      <td>{log.actorContext?.displayName || log.actor || "—"}</td>
                      <td className="ocs-time-cell">{log.timestamp ? new Date(log.timestamp).toLocaleString() : "—"}</td>
                      <td>
                        <span className={`ocs-status-badge ocs-status-${log.result === "success" ? "active" : "disabled"}`}>
                          {log.result || "—"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
