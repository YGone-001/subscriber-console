"use client";

import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { ArrowLeft, FileText, Users, ShieldCheck, History } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";
import RefreshButton from "@/components/ui/RefreshButton";
import OcsStatusBadge from "../common/OcsStatusBadge";

interface OcsTariffDetailProps {
  planId: string;
}

export default function OcsTariffDetail({ planId }: OcsTariffDetailProps) {
  const { t } = useI18n();

  const { data, isLoading: loading, mutate: refresh } = useSWR(
    `/api/tariff-plans/${planId}`,
    fetcher,
  );

  const { data: rulesData } = useSWR(
    `/api/tariff-plans/${planId}/rules`,
    fetcher,
  );

  const { data: subsData } = useSWR(
    `/api/tariff-plans/${planId}/subscribers`,
    fetcher,
  );

  const plan = data?.plan;
  const rules = rulesData?.rules || [];
  const subscriberCount = subsData?.subscribers?.length ?? plan?.subscriberCount ?? 0;

  if (loading) {
    return (
      <div className="ocs-container">
        <div className="ocs-loading">{t("loading")}</div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="ocs-container">
        <div className="ocs-empty">{t("ocs_tariff_not_found")}</div>
      </div>
    );
  }

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t("nav_ocs_tariffs")}
        title={plan.name || plan.plan_id}
        description={plan.description || ""}
        actions={
          <div className="ocs-header-actions">
            <Link href="/ocs/tariffs" className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} /> {t("ocs_back_to_list")}
            </Link>
            <RefreshButton loading={loading} onClick={() => refresh()} label={t("refresh")} className="ocs-btn" />
          </div>
        }
      />

      <div className="ocs-detail-grid">
        {/* Basic Information */}
        <div className="ocs-detail-section">
          <h3><FileText size={16} /> {t("ocs_tariff_detail_basic")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_col_plan_id")}</span>
              <span className="ocs-detail-value ocs-mono">{plan.plan_id}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_col_name")}</span>
              <span className="ocs-detail-value">{plan.name}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_col_status")}</span>
              <span className="ocs-detail-value"><OcsStatusBadge status={plan.status} /></span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_governance_col_version")}</span>
              <span className="ocs-detail-value ocs-mono">v{plan.version || 1}</span>
            </div>
          </div>
        </div>

        {/* Quota Configuration */}
        <div className="ocs-detail-section">
          <h3><FileText size={16} /> {t("ocs_tariff_detail_quota")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_data_quota")}</span>
              <span className="ocs-detail-value ocs-mono">{plan.quota_per_grant ? `${plan.quota_per_grant} B` : "—"}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_voice_quota")}</span>
              <span className="ocs-detail-value">{t("ocs_tariff_detail_per_rules")}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_sms_quota")}</span>
              <span className="ocs-detail-value">{t("ocs_tariff_detail_per_rules")}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_rules_count")}</span>
              <span className="ocs-detail-value">{rules.length || plan.rulesCount || 0}</span>
            </div>
          </div>
        </div>

        {/* Subscriber Binding */}
        <div className="ocs-detail-section">
          <h3><Users size={16} /> {t("ocs_tariff_detail_subscriber_binding")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_bound_count")}</span>
              <span className="ocs-detail-value">{subscriberCount}</span>
            </div>
          </div>
        </div>

        {/* Governance */}
        <div className="ocs-detail-section">
          <h3><ShieldCheck size={16} /> {t("ocs_tariff_detail_governance")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_created_by")}</span>
              <span className="ocs-detail-value">{plan.created_by || "—"}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_updated_by")}</span>
              <span className="ocs-detail-value">{plan.updated_by || "—"}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_last_operation")}</span>
              <span className="ocs-detail-value">—</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_approval_status")}</span>
              <span className="ocs-detail-value">—</span>
            </div>
          </div>
        </div>

        {/* History */}
        <div className="ocs-detail-section">
          <h3><History size={16} /> {t("ocs_tariff_detail_history")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_detail_created")}</span>
              <span className="ocs-detail-value">{plan.created_at ? new Date(plan.created_at).toLocaleString() : "—"}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_col_updated")}</span>
              <span className="ocs-detail-value">{plan.updated_at ? new Date(plan.updated_at).toLocaleString() : "—"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
