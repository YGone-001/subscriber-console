"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { ArrowLeft, ShieldCheck, Users } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";
import RefreshButton from "@/components/ui/RefreshButton";
import OcsStatusBadge from "../common/OcsStatusBadge";

interface OcsContractDetailProps {
  imsi: string;
}

export default function OcsContractDetail({ imsi }: OcsContractDetailProps) {
  const { t } = useI18n();

  const { data, isLoading: loading, mutate: refresh } = useSWR(
    `/api/ocs/subscribers?imsi=${imsi}&limit=1`,
    fetcher,
  );

  const records = data?.records || [];
  const contract = records.find((r: any) => r.imsi === imsi) || records[0];

  if (loading) {
    return (
      <div className="ocs-container">
        <div className="ocs-loading">{t("loading")}</div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="ocs-container">
        <div className="ocs-empty">{t("ocs_contract_not_found")}</div>
      </div>
    );
  }

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t("nav_ocs_contracts")}
        title={contract.imsi}
        description={contract.msisdn || ""}
        actions={
          <div className="ocs-header-actions">
            <a href="/ocs/contracts" className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} /> {t("ocs_back_to_list")}
            </a>
            <RefreshButton loading={loading} onClick={() => refresh()} label={t("refresh")} className="ocs-btn" />
          </div>
        }
      />

      <div className="ocs-detail-grid">
        {/* Identity */}
        <div className="ocs-detail-section">
          <h3><Users size={16} /> {t("ocs_contract_detail_identity")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">IMSI</span>
              <span className="ocs-detail-value ocs-mono">{contract.imsi}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">MSISDN</span>
              <span className="ocs-detail-value">{contract.msisdn || "—"}</span>
            </div>
          </div>
        </div>

        {/* Billing Contract */}
        <div className="ocs-detail-section">
          <h3><Users size={16} /> {t("ocs_contract_detail_billing")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_contract_col_tariff")}</span>
              <span className="ocs-detail-value">
                <a href={`/ocs/tariffs/${contract.plan_id}`} className="ocs-link">{contract.plan_id}</a>
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_contract_col_billing_status")}</span>
              <span className="ocs-detail-value"><OcsStatusBadge status={contract.status} /></span>
            </div>
          </div>
        </div>

        {/* Governance */}
        <div className="ocs-detail-section">
          <h3><ShieldCheck size={16} /> {t("ocs_contract_detail_governance")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_contract_detail_last_operation")}</span>
              <span className="ocs-detail-value">—</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_contract_detail_operator")}</span>
              <span className="ocs-detail-value">—</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_contract_detail_approval_status")}</span>
              <span className="ocs-detail-value">—</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_contract_detail_audit_ref")}</span>
              <span className="ocs-detail-value">—</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_contract_col_created")}</span>
              <span className="ocs-detail-value">{contract.created_at ? new Date(contract.created_at).toLocaleString() : "—"}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_contract_col_updated")}</span>
              <span className="ocs-detail-value">{contract.updated_at ? new Date(contract.updated_at).toLocaleString() : "—"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
