/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/subscriber/SubscriberViewMode.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { AlertTriangle, BadgeCheck, CheckCircle2, Gauge, KeyRound, ListChecks, MessageSquare, Network, PhoneCall, Route, Server, ShieldCheck, Signal, Wifi, ChevronDown, ChevronUp } from "lucide-react";
import RatingRuleLinkPanel from './RatingRuleLinkPanel';
import { Pill, MaskedValue, AMBR_UNITS, getAmbrString, typeLabel } from './utils';
import type { Ambr, Auth4GData, Slice } from '../../../../types/subscriber';
import { parseBytes, parseSeconds, parseEvents, formatBytes } from '../../../../lib/unitParser';

interface SubscriberViewModeProps {
  t: any;
  auth4GData: Auth4GData;
  usimType: "opc" | "op";
  ueAmbr: Ambr;
  imsi: string;
  msisdn: string;
  accessRestriction: number;
  ocsTrafficTotalStr: string;
  ocsTrafficBalanceStr: string;
  ocsVoiceTotalStr: string;
  ocsVoiceBalanceStr: string;
  ocsSmsTotalStr: string;
  ocsSmsBalanceStr: string;
  ocsPlmn: string;
  ocsPlanId: string;
  ocsPlanStatus: string;
  ocsContractStatus: string;
  hasOcsContract: boolean;
  hasOcsBalance: boolean;
  ocsVolumeThreshold: number;
  ocsDataReservedStr: string;
  ocsRules: any[];
  ratingList?: any[];
  slices: Slice[];
  expandedSlices: number[];
  setExpandedSlices: React.Dispatch<React.SetStateAction<number[]>>;
  canRevealCredentials: boolean;
}

function SummaryMetric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="summary-metric-container">
      <div className="summary-metric-label">
        {label}
      </div>
      <div className={`summary-metric-value ${accent ? "accent" : "normal"}`}>
        {value}
      </div>
    </div>
  );
}

function ServicePill({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return (
    <span className={`service-pill-base ${enabled ? "service-pill-enabled" : "service-pill-disabled"}`}>
      <BadgeCheck size={14} />
      {children}
    </span>
  );
}

function DetailPanel({ id, icon, title, children, defaultOpen = false }: { id: string; icon: React.ReactNode; title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details id={id} open={defaultOpen} className="detail-panel">
      <summary className={`detail-panel-summary ${defaultOpen ? "detail-panel-summary-open" : ""}`}>
        {icon}
        <span>{title}</span>
      </summary>
      <div className="detail-panel-content">{children}</div>
    </details>
  );
}

function ConfigCheck({ state, label, detail }: { state: "ok" | "missing" | "warning"; label: string; detail?: string }) {
  return (
    <div className={`config-check-row config-check-${state}`}>
      {state === "ok" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      <span className="config-check-label">{label}</span>
      {detail ? <span className="config-check-detail">{detail}</span> : null}
    </div>
  );
}

function AuthValueCard({
  label,
  value,
  copyable = false,
  singleLine = false,
  canReveal = true,
  t,
  credentialState,
  field,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  singleLine?: boolean;
  canReveal?: boolean;
  t: (key: string) => string;
  credentialState?: Auth4GData['credentialState'];
  field?: 'k' | 'op' | 'opc';
}) {
  /* Withheld material arrives with no value at all. Say which of the two
   * empty-looking cases this is, instead of rendering a bare placeholder. */
  if (!value && credentialState?.visibility === 'masked' && field) {
    return (
      <div className="auth-value-card">
        <div className="auth-value-label">{label}</div>
        <div className="auth-value-text">
          {credentialState[field] === 'configured' ? t("credential_withheld") : t("sub_not_configured")}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-value-card">
      <div className="auth-value-label">
        {label}
      </div>
      {copyable ? (
        <MaskedValue label={label} value={value} singleLine={singleLine} canReveal={canReveal} />
      ) : (
        <div className="auth-value-text">
          {value || "N/A"}
        </div>
      )}
    </div>
  );
}

function contractStatusLabel(t: any, value?: string) {
  if (!value) return t("sub_not_configured");
  if (value === "active") return t("status_active");
  if (value === "suspended") return t("status_suspended");
  if (value === "terminated") return t("ocs_contract_status_terminated");
  return value;
}

function planStatusLabel(t: any, value?: string) {
  if (!value) return t("sub_not_configured");
  if (value === "active") return t("status_active");
  if (value === "disabled") return t("users_disabled");
  return value;
}

function ratingTypeLabel(t: any, value?: string) {
  if (value === "data_volume") return t("rating_service_data");
  if (value === "voice_time") return t("rating_service_voice");
  if (value === "sms_event" || value === "event") return t("rating_service_sms");
  if (value === "free") return t("rating_service_ims");
  return value || "-";
}

function ratingUnitLabel(t: any, value?: string) {
  if (value === "bytes" || value === "octets") return t("rating_unit_bytes");
  if (value === "seconds") return t("rating_unit_seconds");
  if (value === "events") return t("rating_unit_events");
  return value || "-";
}

export default function SubscriberViewMode({
  t,
  auth4GData,
  usimType,
  ueAmbr,
  imsi,
  msisdn,
  accessRestriction,
  ocsTrafficTotalStr,
  ocsTrafficBalanceStr,
  ocsVoiceTotalStr,
  ocsVoiceBalanceStr,
  ocsSmsTotalStr,
  ocsSmsBalanceStr,
  ocsPlmn,
  ocsPlanId,
  ocsPlanStatus,
  ocsContractStatus,
  hasOcsContract,
  hasOcsBalance,
  ocsVolumeThreshold,
  ocsDataReservedStr,
  ocsRules,
  ratingList,
  slices,
  expandedSlices,
  setExpandedSlices,
  canRevealCredentials,
}: SubscriberViewModeProps) {
  const hasDataRule = ocsRules.some((rule: any) => rule?.charging_type === "data_volume");
  const hasVoiceRule = ocsRules.some((rule: any) => rule?.charging_type === "voice_time");
  const hasSmsRule = ocsRules.some((rule: any) => rule?.charging_type === "sms_event" || rule?.unit === "events");
  const hasImsRule = ocsRules.some((rule: any) => rule?.apn === "ims" && (rule?.charging_type === "free" || rule?.charging_type === "voice_time" || rule?.charging_type === "sms_event"));
  const sliceCount = Array.isArray(slices) ? slices.length : 0;
  const sessionCount = Array.isArray(slices)
    ? slices.reduce((total, slice) => total + (Array.isArray(slice.session_list) ? slice.session_list.length : 0), 0)
    : 0;
  const pccRuleCount = Array.isArray(slices)
    ? slices.reduce((total, slice) => total + (Array.isArray(slice.session_list)
      ? slice.session_list.reduce((sum, session: any) => sum + (Array.isArray(session.pcc_rule) ? session.pcc_rule.length : 0), 0)
      : 0), 0)
    : 0;
  const trafficTotal = parseBytes(ocsTrafficTotalStr);
  const trafficBalance = parseBytes(ocsTrafficBalanceStr);
  const voiceTotal = parseSeconds(ocsVoiceTotalStr);
  const voiceBalance = parseSeconds(ocsVoiceBalanceStr);
  const smsTotal = parseEvents(ocsSmsTotalStr);
  const smsBalance = parseEvents(ocsSmsBalanceStr);
  const trafficPercent = trafficTotal > 0 ? Math.max(0, Math.min(100, (trafficBalance / trafficTotal) * 100)) : 0;
  const voicePercent = voiceTotal > 0 ? Math.max(0, Math.min(100, (voiceBalance / voiceTotal) * 100)) : 0;
  const smsPercent = smsTotal > 0 ? Math.max(0, Math.min(100, (smsBalance / smsTotal) * 100)) : 0;
  const hasPlan = Boolean(ocsPlanId);
  const isContractSuspended = ocsContractStatus === "suspended" || ocsContractStatus === "terminated";
  const hasRestriction = Number(accessRestriction || 0) !== 0 && Number(accessRestriction || 0) !== 32;
  const hasRules = ocsRules.length > 0;
  const balanceState: "missing" | "exhausted" | "low" | "normal" = !hasOcsBalance
    ? "missing"
    : trafficBalance <= 0
      ? "exhausted"
      : ocsVolumeThreshold > 0 && trafficBalance <= ocsVolumeThreshold
        ? "low"
        : "normal";
  const balanceStateLabel = balanceState === "exhausted"
    ? t("sub_balance_exhausted")
    : balanceState === "low"
      ? t("sub_balance_low")
      : balanceState === "normal"
        ? t("sub_balance_normal")
        : t("sub_not_configured");
  const balanceCheckState: "ok" | "missing" | "warning" = balanceState === "missing" || balanceState === "exhausted"
    ? "missing"
    : balanceState === "low"
      ? "warning"
      : "ok";

  const configChecks: Array<{ key: string; state: "ok" | "missing" | "warning"; label: string; detail?: string }> = [
    {
      key: "contract",
      state: hasOcsContract ? (isContractSuspended ? "warning" : "ok") : "missing",
      label: t("sub_check_contract"),
      detail: hasOcsContract ? contractStatusLabel(t, ocsContractStatus) : undefined,
    },
    {
      key: "plan",
      state: hasPlan ? "ok" : "missing",
      label: t("sub_check_plan"),
      detail: hasPlan ? ocsPlanId : undefined,
    },
    {
      key: "balance",
      state: balanceCheckState,
      label: t("sub_check_balance"),
      detail: hasOcsBalance ? `${balanceStateLabel} · ${ocsTrafficBalanceStr || "0 B"} / ${ocsTrafficTotalStr || "0 B"}` : undefined,
    },
    {
      key: "rules",
      state: hasRules ? "ok" : "missing",
      label: t("sub_check_rules"),
      detail: hasRules ? String(ocsRules.length) : undefined,
    },
    {
      key: "slices",
      state: sliceCount > 0 ? "ok" : "missing",
      label: t("sub_check_slices"),
      detail: sliceCount > 0 ? String(sliceCount) : undefined,
    },
    {
      key: "access",
      state: hasRestriction ? "warning" : "ok",
      label: t("sub_check_access"),
      detail: hasRestriction ? String(accessRestriction) : t("sub_360_access_open"),
    },
  ];

  const focusItems = [
    !hasOcsContract ? t("sub_360_focus_contract") : "",
    hasOcsContract && !hasPlan ? t("sub_360_focus_plan") : "",
    !hasOcsBalance ? t("sub_360_focus_balance") : "",
    hasPlan && !hasDataRule ? t("sub_360_focus_data_rule") : "",
    sliceCount === 0 ? t("sub_360_focus_slice") : "",
    balanceState === "exhausted" ? t("sub_360_focus_exhausted") : "",
    balanceState === "low" ? t("sub_360_focus_low_balance") : "",
    balanceState === "normal" && trafficTotal > 0 && trafficPercent < 30 ? t("sub_360_focus_traffic") : "",
    isContractSuspended ? t("sub_360_focus_contract_status") : "",
    hasRestriction ? t("sub_360_focus_access") : "",
  ].filter(Boolean).slice(0, 4);

  const remainingLabel = (total: number, balance: number, configured: boolean) => {
    if (!configured) return t("sub_not_configured");
    if (total <= 0) return "0%";
    return `${Math.max(0, Math.min(100, (balance / total) * 100)).toFixed(0)}%`;
  };

  return (
    <div className="animate-fade-in view-mode-container">

      <section className="dash-card" id="sec-subscription-overview">
        <div className="dash-card-header">
          <BadgeCheck size={20} color="var(--primary)" />
          <h3 className="section-header-title">{t("sub_360_title")}</h3>
        </div>
        <div className="dash-card-body dash-card-body-grid">
          <div className="overview-grid">
            <div className="overview-box gap-sm">
              <div className="config-check-title">{t("sub_config_check")}</div>
              <div className="config-check-list">
                {configChecks.map((check) => (
                  <ConfigCheck key={check.key} state={check.state} label={check.label} detail={check.detail} />
                ))}
              </div>
              <div className="identity-info-grid">
                <div className="identity-info-row"><span>IMSI</span><strong className="identity-info-val">{imsi || "N/A"}</strong></div>
                <div className="identity-info-row"><span>MSISDN</span><strong className="identity-info-val">{msisdn || "N/A"}</strong></div>
                <div className="identity-info-row"><span>{t("sub_360_access")}</span><strong className={`identity-info-access ${hasRestriction ? "restricted" : "open"}`}>{hasRestriction ? accessRestriction : t("sub_360_access_open")}</strong></div>
              </div>
            </div>

            <div className="overview-box gap-md">
              <div className="next-actions-title">
                <ListChecks size={18} color="var(--primary)" />
                {t("sub_360_next_actions")}
              </div>
              {focusItems.length === 0 ? (
                <div className="next-actions-none">
                  <ShieldCheck size={18} /> {t("sub_360_no_action")}
                </div>
              ) : (
                <div className="next-actions-list">
                  {focusItems.map((item, index) => (
                    <div key={item} className="next-action-item">
                      <span className="next-action-index">{index + 1}</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="overview-metrics-grid">
                <SummaryMetric label={t("sub_360_data_remaining")} value={remainingLabel(trafficTotal, trafficBalance, hasOcsBalance)} accent={hasOcsBalance && trafficPercent >= 30} />
                <SummaryMetric label={t("sub_360_voice_remaining")} value={remainingLabel(voiceTotal, voiceBalance, hasOcsBalance)} accent={hasOcsBalance && voicePercent >= 30} />
                <SummaryMetric label={t("sub_360_sms_remaining")} value={remainingLabel(smsTotal, smsBalance, hasOcsBalance)} accent={hasOcsBalance && smsPercent >= 30} />
                <SummaryMetric label={t("sub_360_rule_coverage")} value={`${[hasDataRule, hasVoiceRule, hasSmsRule, hasImsRule].filter(Boolean).length}/4`} accent={hasDataRule && hasVoiceRule && hasSmsRule && hasImsRule} />
              </div>
            </div>
          </div>

          <div className="details-grid">
            <div className="details-box">
              <div className="details-box-title">
                <Gauge size={18} color="var(--primary)" />
                {t("sub_360_package")}
              </div>
              <div className="details-box-content">
                <SummaryMetric label={t("sub_360_tariff_plan")} value={ocsPlanId || t("sub_not_configured")} accent />
                <SummaryMetric label={t("sub_360_plan_status")} value={planStatusLabel(t, ocsPlanStatus)} />
                <SummaryMetric label={t("sub_contract_status")} value={contractStatusLabel(t, ocsContractStatus)} />
                <SummaryMetric label="PLMN" value={ocsPlmn || t("sub_not_configured")} />
              </div>
            </div>

            <div className="details-box">
              <div className="details-box-title">
                <Network size={18} color="var(--primary)" />
                {t("sub_360_data_balance")}
              </div>
              <div className="details-box-content">
                <SummaryMetric label={t("sub_360_total_quota")} value={hasOcsBalance ? (ocsTrafficTotalStr || "0 B") : t("sub_not_configured")} />
                <SummaryMetric label={t("sub_360_available")} value={hasOcsBalance ? (ocsTrafficBalanceStr || "0 B") : t("sub_not_configured")} accent={hasOcsBalance} />
                <SummaryMetric label={t("sub_360_reserved")} value={hasOcsBalance ? (ocsDataReservedStr || "0 B") : t("sub_not_configured")} />
                <SummaryMetric label={t("sub_360_balance_threshold")} value={ocsVolumeThreshold > 0 ? formatBytes(ocsVolumeThreshold) : t("sub_not_configured")} />
              </div>
            </div>

            <div className="details-box">
              <div className="details-box-title">
                <PhoneCall size={18} color="var(--primary)" />
                {t("sub_360_ims_voice")}
              </div>
              <div className="details-box-content">
                <SummaryMetric label={t("sub_360_total_duration")} value={hasOcsBalance ? (ocsVoiceTotalStr || "0s") : t("sub_not_configured")} />
                <SummaryMetric label={t("sub_360_available")} value={hasOcsBalance ? (ocsVoiceBalanceStr || "0s") : t("sub_not_configured")} accent={hasOcsBalance} />
              </div>
            </div>

            <div className="details-box">
              <div className="details-box-title">
                <MessageSquare size={18} color="var(--primary)" />
                {t("sub_360_ims_sms")}
              </div>
              <div className="details-box-content">
                <SummaryMetric label={t("sub_360_sms_quota")} value={hasOcsBalance ? (ocsSmsTotalStr || "0") : t("sub_not_configured")} />
                <SummaryMetric label={t("sub_360_available")} value={hasOcsBalance ? (ocsSmsBalanceStr || "0") : t("sub_not_configured")} accent={hasOcsBalance} />
              </div>
            </div>

            <div className="details-box">
              <div className="details-box-title">
                <Signal size={18} color="var(--primary)" />
                {t("sub_360_network_entitlement")}
              </div>
              <div className="details-box-content">
                <SummaryMetric label={t("sub_360_slices_sessions")} value={`${sliceCount} / ${sessionCount}`} />
                <SummaryMetric label={t("sub_360_pcc_rules")} value={String(pccRuleCount)} />
              </div>
            </div>
          </div>

          <div className="services-pills-container">
            <ServicePill enabled={hasDataRule}>{t("sub_360_packet_data")}</ServicePill>
            <ServicePill enabled={hasImsRule}>{t("sub_360_ims_service")}</ServicePill>
            <ServicePill enabled={hasVoiceRule}>{t("sub_360_voice_time")}</ServicePill>
            <ServicePill enabled={hasSmsRule}>{t("sub_360_sms_event")}</ServicePill>
            <ServicePill enabled={sliceCount > 0}>{t("sub_360_slice_profile")}</ServicePill>
          </div>
        </div>
      </section>

      <section id="sec-technical-details" className="tech-details-section">
        <div className="tech-details-title">
          <Server size={20} />
          {t("sub_technical_title")}
        </div>

        <DetailPanel id="sec-security" title={t("sec_security_auth")} icon={<KeyRound size={18} color="var(--primary)" />}>
          <div className="auth-grid">
            <AuthValueCard label={t("sub_key_k")} value={auth4GData.k} copyable singleLine canReveal={canRevealCredentials} t={t} credentialState={auth4GData.credentialState} field="k" />
            <AuthValueCard label={`${t("sub_key_op")} (${usimType.toUpperCase()})`} value={auth4GData.opValue} copyable singleLine canReveal={canRevealCredentials} t={t} credentialState={auth4GData.credentialState} field={usimType === "op" ? "op" : "opc"} />
            <AuthValueCard label="AMF" value={auth4GData.amf || "N/A"} t={t} />
            <AuthValueCard label="SQN" value={String(auth4GData.sqn || 0)} t={t} />
          </div>
        </DetailPanel>

        <DetailPanel id="sec-network" title={t("sub_network_config")} icon={<Signal size={18} color="var(--primary)" />}>
          <div className="network-grid">
            <div className="ambr-box">
              <Wifi size={28} color="var(--primary)" />
              <div>
                <div className="ambr-label">{t("sub_lbl_ambr_dl")}</div>
                <div className="ambr-value">
                  {ueAmbr.downlink?.value || 0} <span className="ambr-unit">{AMBR_UNITS.find(u => u.val === (ueAmbr.downlink?.unit || 1))?.label || ''}</span>
                </div>
              </div>
            </div>
            <div className="ambr-box">
              <Wifi size={28} color="var(--primary)" className="ambr-icon-ul" />
              <div>
                <div className="ambr-label">{t("sub_lbl_ambr_ul")}</div>
                <div className="ambr-value">
                  {ueAmbr.uplink?.value || 0} <span className="ambr-unit">{AMBR_UNITS.find(u => u.val === (ueAmbr.uplink?.unit || 1))?.label || ''}</span>
                </div>
              </div>
            </div>
          </div>
        </DetailPanel>

        <DetailPanel id="sec-ocs-view" title={t("sec_billing_config")} icon={<Gauge size={18} color="var(--primary)" />}>
          <div className="billing-grid">
            <SummaryMetric label={t("sub_traffic_quota")} value={ocsTrafficTotalStr} />
            <SummaryMetric label={t("sub_traffic_balance")} value={ocsTrafficBalanceStr} accent />
            <SummaryMetric label={t("sub_360_voice_quota")} value={ocsVoiceTotalStr} />
            <SummaryMetric label={t("sub_360_voice_balance")} value={ocsVoiceBalanceStr} accent />
            <SummaryMetric label={t("sub_360_sms_quota")} value={ocsSmsTotalStr} />
            <SummaryMetric label={t("sub_360_sms_balance")} value={ocsSmsBalanceStr} accent />
            <SummaryMetric label="PLMN" value={ocsPlmn || t("sub_not_configured")} />
            <SummaryMetric label={t("sub_360_tariff_plan")} value={ocsPlanId || t("sub_not_configured")} accent />
            <SummaryMetric label={t("sub_360_plan_status")} value={planStatusLabel(t, ocsPlanStatus)} />
            <SummaryMetric label={t("sub_contract_status")} value={contractStatusLabel(t, ocsContractStatus)} />
          </div>
          <div className="apn-rules-title">{t("sub_360_apn_rules")}</div>
          <RatingRuleLinkPanel
            planId={ocsPlanId}
            planStatus={ocsPlanStatus}
            ocsRules={ocsRules}
            ratingList={ratingList}
            t={t}
            compact
          />
          <div className="raw-mapping-title">{t("sub_360_raw_mapping")}</div>
          <div className="rules-list">
            {ocsRules.length > 0 ? ocsRules.map((rule: any) => (
              <div key={rule.rule_id || `${rule.apn}-${rule.rating_group_id}`} className="rule-item">
                <span>{rule.apn}</span>
                <span>RG {rule.rating_group_id}</span>
                <span>SI {rule.service_identifier}</span>
                <span>{ratingTypeLabel(t, rule.charging_type)}</span>
                <span>{ratingUnitLabel(t, rule.unit)}</span>
              </div>
            )) : <span className="no-rules">{t("sub_360_no_tariff_rules")}</span>}
          </div>
        </DetailPanel>

        <DetailPanel id="sec-slices" title={t("sub_slices_arch")} icon={<Route size={18} color="var(--primary)" />}>
          {Array.isArray(slices) && slices.length > 0 ? slices.map((slice, sIdx) => {
            return (
              <div key={sIdx} className={`slice-strip-card ${sIdx !== 0 ? "slice-card-top-margin" : ""}`} id={`slice-card-${sIdx}`}>
                <div
                  className={`slice-card-header slice-card-header-styled ${expandedSlices.includes(sIdx) ? "slice-card-header-expanded" : ""}`}
                  onClick={() => setExpandedSlices(prev => prev.includes(sIdx) ? prev.filter(i => i !== sIdx) : [...prev, sIdx])}
                >
                  <div className="slice-header-content">
                    <span className="slice-idx">{t("slice_idx", { idx: sIdx + 1 })}</span>
                    <div className="slice-sst-sd">
                      <span className="slice-sst">SST: {slice.sst}</span>
                      {slice.sd && slice.sd !== "000000" && <span className="slice-sd">SD: {slice.sd}</span>}
                    </div>
                    {slice.default_indicator && <Pill enabled={true}>{t("sub_default_nssai")}</Pill>}
                  </div>
                  <div>
                    {expandedSlices.includes(sIdx) ? <ChevronUp size={20} color="var(--text-muted)" /> : <ChevronDown size={20} color="var(--text-muted)" />}
                  </div>
                </div>

                <div className={`accordion-content ${expandedSlices.includes(sIdx) ? 'expanded' : 'collapsed'}`}>
                  <div className="slice-table-container">
                    <table className="slice-table">
                      <caption className="sr-only">{t("sub_slices_arch")} · {t("slice_idx", { idx: sIdx + 1 })}</caption>
                      <thead>
                        <tr>
                          <th className="table-header-cap slice-table-th">{t("slice_col_dnn")}</th>
                          <th className="table-header-cap slice-table-th">{t("slice_col_type")}</th>
                          <th className="table-header-cap slice-table-th">{t("slice_col_qci")}</th>
                          <th className="table-header-cap slice-table-th">{t("slice_col_arp")}</th>
                          <th className="table-header-cap slice-table-th">{t("slice_col_ambr")}</th>
                          <th className="table-header-cap slice-table-th">{t("slice_col_pcc")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slice.session_list && slice.session_list.length > 0 ? slice.session_list.map((sess: any, sessIdx: number) => (
                          <tr key={sessIdx} className="hover-session">
                            <td className="slice-table-td slice-table-td-main">{sess.name || "internet"}</td>
                            <td className="slice-table-td slice-table-td-sec">{typeLabel(sess.type)}</td>
                            <td className="slice-table-td slice-table-td-sec">{sess.qos?._5qi || "-"}</td>
                            <td className="slice-table-td slice-table-td-sec">{sess.qos?.arp?.priorityLevel || "-"}</td>
                            <td className="slice-table-td slice-table-td-ambr">{getAmbrString(sess.ambr)}</td>
                            <td className="slice-table-td slice-table-td-sec">
                              {sess.pcc_rule && sess.pcc_rule.length > 0 ? (
                                <div className="pcc-rules-list">
                                  {sess.pcc_rule.map((rule: any, pccIdx: number) => (
                                    <div key={pccIdx} className="pcc-rule-item">
                                      <div className="pcc-rule-idx">{t("slice_rule_idx", { idx: pccIdx + 1 })}</div>
                                      <div className="pcc-rule-grid">
                                        <div><span className="text-muted">5QI:</span> {rule.qos?._5qi || 1}</div>
                                        <div><span className="text-muted">ARP:</span> {rule.qos?.arp?.priorityLevel || 2}</div>
                                        <div className="pcc-rule-mbr">
                                          <span className="text-muted">MBR:</span> {rule.qos?.mbr?.downlink?.value || 0} {AMBR_UNITS.find(u => u.val === (rule.qos?.mbr?.downlink?.unit || 1))?.label} (DL) / {rule.qos?.mbr?.uplink?.value || 0} {AMBR_UNITS.find(u => u.val === (rule.qos?.mbr?.uplink?.unit || 1))?.label} (UL)
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-muted">{t("none")}</span>
                              )}
                            </td>
                          </tr>
                        )) : (
                          <tr><td colSpan={6} className="no-sessions">{t("sub_no_sessions")}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          }) : (
            <div className="no-slices">{t("sub_no_slices")}</div>
          )}
        </DetailPanel>
      </section>
    </div>
  );
}
