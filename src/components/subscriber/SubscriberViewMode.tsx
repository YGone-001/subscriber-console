import { AlertTriangle, BadgeCheck, CheckCircle2, Gauge, KeyRound, ListChecks, MessageSquare, Network, PhoneCall, Route, Server, ShieldCheck, Signal, Wifi, ChevronDown, ChevronUp } from "lucide-react";
import RatingRuleLinkPanel from "./RatingRuleLinkPanel";
import { Pill, MaskedValue, AMBR_UNITS, getAmbrString, typeLabel } from "./utils";
import type { Ambr, Auth4GData, Slice } from "@/types/subscriber";
import { parseBytes, parseSeconds, parseEvents } from "@/lib/unitParser";
import "./subscriber.css";

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
  ocsRules: any[];
  ratingList?: any[];
  slices: Slice[];
  expandedSlices: number[];
  setExpandedSlices: React.Dispatch<React.SetStateAction<number[]>>;
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

function HealthPill({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const toneClass = tone === "ok" ? "health-pill-ok" : tone === "warn" ? "health-pill-warn" : "health-pill-danger";
  return (
    <span className={`health-pill-base ${toneClass}`}>
      {tone === "ok" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
      {children}
    </span>
  );
}

function AuthValueCard({ label, value, copyable = false, singleLine = false }: { label: string; value: string; copyable?: boolean; singleLine?: boolean }) {
  return (
    <div className="auth-value-card">
      <div className="auth-value-label">
        {label}
      </div>
      {copyable ? (
        <MaskedValue label={label} value={value} singleLine={singleLine} />
      ) : (
        <div className="auth-value-text">
          {value || "N/A"}
        </div>
      )}
    </div>
  );
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
  ocsRules,
  ratingList,
  slices,
  expandedSlices,
  setExpandedSlices
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
  const isSuspended = ocsPlanStatus && ocsPlanStatus !== "active";
  const hasRestriction = Number(accessRestriction || 0) !== 0 && Number(accessRestriction || 0) !== 32;
  const healthScore = Math.max(0, Math.min(100,
    100
    - (hasPlan ? 0 : 18)
    - (hasDataRule ? 0 : 14)
    - (hasVoiceRule ? 0 : 12)
    - (hasSmsRule ? 0 : 10)
    - (hasImsRule ? 0 : 10)
    - (sliceCount > 0 ? 0 : 12)
    - (trafficPercent < 15 ? 16 : trafficPercent < 30 ? 8 : 0)
    - (voicePercent < 15 ? 10 : voicePercent < 30 ? 5 : 0)
    - (smsPercent < 15 ? 8 : smsPercent < 30 ? 4 : 0)
    - (isSuspended ? 14 : 0)
    - (hasRestriction ? 8 : 0)
  ));
  const healthTone = healthScore >= 86 ? "ok" : healthScore >= 68 ? "warn" : "danger";
  const focusItems = [
    !hasPlan ? t("sub_360_focus_plan") : "",
    !hasDataRule ? t("sub_360_focus_data_rule") : "",
    !hasVoiceRule ? t("sub_360_focus_voice_rule") : "",
    !hasSmsRule ? t("sub_360_focus_sms_rule") : "",
    !hasImsRule ? t("sub_360_focus_ims_rule") : "",
    sliceCount === 0 ? t("sub_360_focus_slice") : "",
    trafficPercent < 30 ? t("sub_360_focus_traffic") : "",
    voicePercent < 30 ? t("sub_360_focus_voice") : "",
    smsPercent < 30 ? t("sub_360_focus_sms") : "",
    isSuspended ? t("sub_360_focus_status") : "",
    hasRestriction ? t("sub_360_focus_access") : "",
  ].filter(Boolean).slice(0, 4);

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
              <div className="health-score-container">
                <div>
                  <div className="health-score-label">{t("sub_360_health")}</div>
                  <div className="health-score-value">{healthScore}</div>
                </div>
                <HealthPill tone={healthTone}>{t(`sub_360_health_${healthTone}`)}</HealthPill>
              </div>
              <div className="health-bar-bg">
                <div className={`health-bar-fill ${healthTone}`} style={{ width: `${healthScore}%` }} />
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
                <SummaryMetric label={t("sub_360_data_remaining")} value={`${trafficPercent.toFixed(0)}%`} accent={trafficPercent >= 30} />
                <SummaryMetric label={t("sub_360_voice_remaining")} value={`${voicePercent.toFixed(0)}%`} accent={voicePercent >= 30} />
                <SummaryMetric label={t("sub_360_sms_remaining")} value={`${smsPercent.toFixed(0)}%`} accent={smsPercent >= 30} />
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
                <SummaryMetric label={t("sub_360_tariff_plan")} value={ocsPlanId || t("none")} accent />
                <SummaryMetric label={t("sub_360_plan_status")} value={ocsPlanStatus || t("unknown")} />
                <SummaryMetric label="PLMN" value={ocsPlmn || "N/A"} />
              </div>
            </div>

            <div className="details-box">
              <div className="details-box-title">
                <Network size={18} color="var(--primary)" />
                {t("sub_360_data_balance")}
              </div>
              <div className="details-box-content">
                <SummaryMetric label={t("sub_360_total_quota")} value={ocsTrafficTotalStr} />
                <SummaryMetric label={t("sub_360_available")} value={ocsTrafficBalanceStr} accent />
              </div>
            </div>

            <div className="details-box">
              <div className="details-box-title">
                <PhoneCall size={18} color="var(--primary)" />
                {t("sub_360_ims_voice")}
              </div>
              <div className="details-box-content">
                <SummaryMetric label={t("sub_360_total_duration")} value={ocsVoiceTotalStr} />
                <SummaryMetric label={t("sub_360_available")} value={ocsVoiceBalanceStr} accent />
              </div>
            </div>

            <div className="details-box">
              <div className="details-box-title">
                <MessageSquare size={18} color="var(--primary)" />
                {t("sub_360_ims_sms")}
              </div>
              <div className="details-box-content">
                <SummaryMetric label={t("sub_360_sms_quota")} value={ocsSmsTotalStr} />
                <SummaryMetric label={t("sub_360_available")} value={ocsSmsBalanceStr} accent />
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

        <DetailPanel id="sec-security" title={t("sec_security_auth")} icon={<KeyRound size={18} color="var(--primary)" />} defaultOpen>
          <div className="auth-grid">
            <AuthValueCard label={t("sub_key_k")} value={auth4GData.k} copyable singleLine />
            <AuthValueCard label={`${t("sub_key_op")} (${usimType.toUpperCase()})`} value={auth4GData.opValue} copyable singleLine />
            <AuthValueCard label="AMF" value={auth4GData.amf || "N/A"} />
            <AuthValueCard label="SQN" value={String(auth4GData.sqn || 0)} />
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
            <SummaryMetric label="PLMN" value={ocsPlmn} />
            <SummaryMetric label={t("sub_360_tariff_plan")} value={ocsPlanId || t("none")} accent />
            <SummaryMetric label={t("sub_360_plan_status")} value={ocsPlanStatus || t("unknown")} />
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
