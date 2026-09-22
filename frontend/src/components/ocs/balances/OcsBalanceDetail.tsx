"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { ArrowLeft, ShieldCheck, SlidersHorizontal, Database, Phone, MessageSquare } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";
import RefreshButton from "@/components/ui/RefreshButton";
import OcsStatusBadge from "../common/OcsStatusBadge";
import AdjustBalanceModal from "./AdjustBalanceModal";
import { formatBytes } from "@/lib/unitParser";
import { useAuth } from "@/hooks/useAuth";
import { capabilityDecision } from "@/lib/permissions";

interface OcsBalanceDetailProps {
  imsi: string;
}

export default function OcsBalanceDetail({ imsi }: OcsBalanceDetailProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const canAdjust = user?.role ? capabilityDecision(user.role, "balance_adjust") !== "deny" : false;

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const { data, isLoading: loading, mutate: refresh } = useSWR(
    `/api/ocs/balances?imsi=${encodeURIComponent(imsi)}&limit=1`,
    fetcher,
  );

  const { data: auditData } = useSWR(
    `/api/audit?q=${encodeURIComponent(imsi)}&limit=1`,
    fetcher,
  );

  const balance = data?.balance || data?.records?.[0];
  const latestAudit = auditData?.logs?.[0];

  const formatTime = (iso?: string) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  if (loading) {
    return (
      <div className="ocs-container">
        <div className="ocs-loading">{t("loading")}</div>
      </div>
    );
  }

  if (!balance) {
    return (
      <div className="ocs-container">
        <div className="ocs-empty">{t("ocs_balance_not_found")}</div>
      </div>
    );
  }

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t("nav_ocs_balances")}
        title={balance.imsi}
        description={t("ocs_balance_detail_desc")}
        actions={
          <div className="ocs-header-actions">
            <Link href="/ocs/balances" className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} /> {t("ocs_back_to_list")}
            </Link>
            <RefreshButton loading={loading} onClick={() => refresh()} label={t("refresh")} className="ocs-btn" />
            {canAdjust && (
              <button
                type="button"
                className="ocs-btn ocs-btn-primary"
                onClick={() => setAdjustOpen(true)}
              >
                <SlidersHorizontal size={14} />
                <span>{t("ocs_balance_adjust")}</span>
              </button>
            )}
          </div>
        }
      />

      {feedback && (
        <div
          className={feedback.type === "success" ? "ocs-feedback-success" : "ocs-feedback-error"}
          style={{ marginBottom: "1rem" }}
        >
          <span>{feedback.message}</span>
        </div>
      )}

      <div className="ocs-detail-grid">
        {/* Data Bucket */}
        <div className="ocs-detail-section">
          <h3><Database size={16} /> {t("ocs_balance_data_bucket")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_detail_data_total")}</span>
              <span className="ocs-detail-value ocs-mono">{formatBytes(balance.data_total)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_detail_data_used")}</span>
              <span className="ocs-detail-value ocs-mono">{formatBytes(balance.data_used)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_detail_data_reserved")}</span>
              <span className="ocs-detail-value ocs-mono">{formatBytes(balance.data_reserved)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_detail_data_available")}</span>
              <span className="ocs-detail-value ocs-mono" style={{ fontWeight: 600 }}>
                {formatBytes(balance.data_available)}
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_detail_data_invariant")}</span>
              <span className="ocs-detail-value">
                {balance.data_invariant_ok ? t("ocs_detail_true") : t("ocs_detail_false_mismatch")}
              </span>
            </div>
          </div>
        </div>

        {/* Voice Bucket */}
        <div className="ocs-detail-section">
          <h3><Phone size={16} /> {t("ocs_balance_voice_bucket")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_col_voice_alloc")}</span>
              <span className="ocs-detail-value ocs-mono">{balance.voice_total}s</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_col_voice_used")}</span>
              <span className="ocs-detail-value ocs-mono">{balance.voice_used}s</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_col_voice_avail")}</span>
              <span className="ocs-detail-value ocs-mono" style={{ fontWeight: 600 }}>
                {balance.voice_available}s
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_detail_voice_invariant")}</span>
              <span className="ocs-detail-value">
                {balance.voice_invariant_ok ? t("ocs_detail_true") : t("ocs_detail_false_mismatch")}
              </span>
            </div>
          </div>
        </div>

        {/* SMS Bucket */}
        <div className="ocs-detail-section">
          <h3><MessageSquare size={16} /> {t("ocs_balance_sms_bucket")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_col_sms_alloc")}</span>
              <span className="ocs-detail-value ocs-mono">{balance.sms_total}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_col_sms_used")}</span>
              <span className="ocs-detail-value ocs-mono">{balance.sms_used}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_col_sms_avail")}</span>
              <span className="ocs-detail-value ocs-mono" style={{ fontWeight: 600 }}>
                {balance.sms_available}
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_detail_sms_invariant")}</span>
              <span className="ocs-detail-value">
                {balance.sms_invariant_ok ? t("ocs_detail_true") : t("ocs_detail_false_mismatch")}
              </span>
            </div>
          </div>
        </div>

        {/* Governance & Audit Metadata */}
        <div className="ocs-detail-section">
          <h3><ShieldCheck size={16} /> {t("ocs_balance_governance_info")}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_balance_account_status")}</span>
              <span className="ocs-detail-value"><OcsStatusBadge status={balance.status} /></span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_balance_version")}</span>
              <span className="ocs-detail-value ocs-mono">v{balance.version}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_tariff_col_updated")}</span>
              <span className="ocs-detail-value">{formatTime(balance.updated_at)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_balance_last_operation")}</span>
              <span className="ocs-detail-value">{latestAudit?.action || "—"}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_balance_operator")}</span>
              <span className="ocs-detail-value">{latestAudit?.actor || "—"}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t("ocs_balance_audit_ref")}</span>
              <span className="ocs-detail-value">
                {latestAudit?._id ? (
                  <Link href={`/audit-logs?q=${encodeURIComponent(balance.imsi)}`} className="ocs-link">
                    {latestAudit._id}
                  </Link>
                ) : (
                  "—"
                )}
              </span>
            </div>
          </div>
        </div>
      </div>

      {adjustOpen && (
        <AdjustBalanceModal
          isOpen={true}
          imsi={balance.imsi}
          dataAvailable={balance.data_available}
          voiceAvailable={balance.voice_available}
          smsAvailable={balance.sms_available}
          onClose={() => setAdjustOpen(false)}
          onSuccess={(result) => {
            setFeedback({
              type: result.outcome === "executed_audit_warning" ? "error" : "success",
              message: result.message,
            });
            refresh();
          }}
        />
      )}
    </div>
  );
}
