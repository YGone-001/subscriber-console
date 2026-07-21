import { AlertTriangle, BadgeCheck, CheckCircle2, Gauge, KeyRound, ListChecks, MessageSquare, Network, PhoneCall, Route, Server, ShieldCheck, Signal, Wifi, ChevronDown, ChevronUp } from "lucide-react";
import RatingRuleLinkPanel from "./RatingRuleLinkPanel";
import { Pill, MaskedValue, AMBR_UNITS, getAmbrString, typeLabel } from "./utils";
import type { Ambr, Auth4GData, Slice } from "@/types/subscriber";
import { parseBytes, parseSeconds, parseEvents } from "@/lib/unitParser";

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
    <div style={{ minWidth: 0 }}>
      <div style={{ color: "var(--text-muted)", fontSize: "0.76rem", marginBottom: "0.35rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0 }}>
        {label}
      </div>
      <div style={{ color: accent ? "var(--primary)" : "var(--text-main)", fontSize: "1rem", fontWeight: 700, fontFamily: "monospace", overflowWrap: "anywhere" }}>
        {value}
      </div>
    </div>
  );
}

function ServicePill({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return (
    <span
      style={{
        minHeight: 30,
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.35rem 0.6rem",
        borderRadius: "999px",
        border: `1px solid ${enabled ? "color-mix(in srgb, var(--success) 38%, var(--surface-border))" : "var(--surface-border)"}`,
        background: enabled ? "color-mix(in srgb, var(--success) 10%, var(--surface))" : "var(--surface-hover)",
        color: enabled ? "var(--success)" : "var(--text-muted)",
        fontSize: "0.78rem",
        fontWeight: 800,
        whiteSpace: "nowrap",
      }}
    >
      <BadgeCheck size={14} />
      {children}
    </span>
  );
}

function DetailPanel({ id, icon, title, children, defaultOpen = false }: { id: string; icon: React.ReactNode; title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details
      id={id}
      open={defaultOpen}
      style={{
        border: "1px solid var(--surface-border)",
        borderRadius: "8px",
        background: "var(--surface)",
        overflow: "hidden",
      }}
    >
      <summary
        style={{
          minHeight: 58,
          padding: "0.9rem 1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.65rem",
          cursor: "pointer",
          color: "var(--text-main)",
          fontWeight: 800,
          borderBottom: defaultOpen ? "1px solid var(--surface-border)" : undefined,
        }}
      >
        {icon}
        <span>{title}</span>
      </summary>
      <div style={{ padding: "1rem" }}>{children}</div>
    </details>
  );
}

function HealthPill({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const color = tone === "ok" ? "var(--success)" : tone === "warn" ? "var(--warning)" : "var(--danger)";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "0.35rem",
      minHeight: 28,
      padding: "0.3rem 0.55rem",
      borderRadius: "999px",
      border: `1px solid color-mix(in srgb, ${color} 36%, var(--surface-border))`,
      background: `color-mix(in srgb, ${color} 9%, var(--surface))`,
      color,
      fontSize: "0.76rem",
      fontWeight: 800,
      whiteSpace: "nowrap",
    }}>
      {tone === "ok" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
      {children}
    </span>
  );
}

function AuthValueCard({ label, value, copyable = false, singleLine = false }: { label: string; value: string; copyable?: boolean; singleLine?: boolean }) {
  return (
    <div
      style={{
        minWidth: 0,
        display: "grid",
        gap: "0.45rem",
        padding: "0.85rem",
        border: "1px solid var(--surface-border)",
        borderRadius: "8px",
        background: "var(--surface-hover)",
      }}
    >
      <div style={{ color: "var(--text-muted)", fontSize: "0.76rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0 }}>
        {label}
      </div>
      {copyable ? (
        <MaskedValue label={label} value={value} singleLine={singleLine} />
      ) : (
        <div style={{ minWidth: 0, color: "var(--text-main)", fontSize: "1rem", fontWeight: 700, fontFamily: "monospace", lineHeight: 1.45, overflowWrap: "anywhere", wordBreak: "break-all" }}>
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
    <div className="animate-fade-in" style={{ paddingBottom: '2rem' }}>

      <section className="dash-card" id="sec-subscription-overview">
        <div className="dash-card-header">
          <BadgeCheck size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 700 }}>{t("sub_360_title")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gap: "1rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 0.7fr) minmax(280px, 1.3fr)", gap: "1rem" }}>
            <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "1rem", background: "var(--header-bg)", display: "grid", gap: "0.8rem" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.76rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0 }}>{t("sub_360_health")}</div>
                  <div style={{ color: "var(--text-main)", fontSize: "2rem", fontWeight: 900, lineHeight: 1 }}>{healthScore}</div>
                </div>
                <HealthPill tone={healthTone}>{t(`sub_360_health_${healthTone}`)}</HealthPill>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: "var(--surface-border)", overflow: "hidden" }}>
                <div style={{ width: `${healthScore}%`, height: "100%", background: healthTone === "ok" ? "var(--success)" : healthTone === "warn" ? "var(--warning)" : "var(--danger)" }} />
              </div>
              <div style={{ display: "grid", gap: "0.45rem", color: "var(--text-secondary)", fontSize: "0.82rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}><span>IMSI</span><strong style={{ color: "var(--text-main)", fontFamily: "monospace" }}>{imsi || "N/A"}</strong></div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}><span>MSISDN</span><strong style={{ color: "var(--text-main)", fontFamily: "monospace" }}>{msisdn || "N/A"}</strong></div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}><span>{t("sub_360_access")}</span><strong style={{ color: hasRestriction ? "var(--warning)" : "var(--success)" }}>{hasRestriction ? accessRestriction : t("sub_360_access_open")}</strong></div>
              </div>
            </div>

            <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "1rem", background: "var(--header-bg)", display: "grid", gap: "0.9rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", color: "var(--text-main)", fontWeight: 800 }}>
                <ListChecks size={18} color="var(--primary)" />
                {t("sub_360_next_actions")}
              </div>
              {focusItems.length === 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", color: "var(--success)", fontWeight: 800, minHeight: 72 }}>
                  <ShieldCheck size={18} /> {t("sub_360_no_action")}
                </div>
              ) : (
                <div style={{ display: "grid", gap: "0.55rem" }}>
                  {focusItems.map((item, index) => (
                    <div key={item} style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "0.55rem", alignItems: "center", color: "var(--text-secondary)", fontSize: "0.86rem" }}>
                      <span style={{ width: 24, height: 24, borderRadius: "999px", display: "grid", placeItems: "center", background: "var(--surface-hover)", color: "var(--primary)", fontWeight: 900, fontSize: "0.75rem" }}>{index + 1}</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "0.65rem", paddingTop: "0.65rem", borderTop: "1px solid var(--surface-border)" }}>
                <SummaryMetric label={t("sub_360_data_remaining")} value={`${trafficPercent.toFixed(0)}%`} accent={trafficPercent >= 30} />
                <SummaryMetric label={t("sub_360_voice_remaining")} value={`${voicePercent.toFixed(0)}%`} accent={voicePercent >= 30} />
                <SummaryMetric label={t("sub_360_sms_remaining")} value={`${smsPercent.toFixed(0)}%`} accent={smsPercent >= 30} />
                <SummaryMetric label={t("sub_360_rule_coverage")} value={`${[hasDataRule, hasVoiceRule, hasSmsRule, hasImsRule].filter(Boolean).length}/4`} accent={hasDataRule && hasVoiceRule && hasSmsRule && hasImsRule} />
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "1rem" }}>
            <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "1rem", background: "var(--header-bg)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", marginBottom: "0.9rem", color: "var(--text-main)", fontWeight: 800 }}>
                <Gauge size={18} color="var(--primary)" />
                {t("sub_360_package")}
              </div>
              <div style={{ display: "grid", gap: "0.85rem" }}>
                <SummaryMetric label={t("sub_360_tariff_plan")} value={ocsPlanId || t("none")} accent />
                <SummaryMetric label={t("sub_360_plan_status")} value={ocsPlanStatus || t("unknown")} />
                <SummaryMetric label="PLMN" value={ocsPlmn || "N/A"} />
              </div>
            </div>

            <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "1rem", background: "var(--header-bg)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", marginBottom: "0.9rem", color: "var(--text-main)", fontWeight: 800 }}>
                <Network size={18} color="var(--primary)" />
                {t("sub_360_data_balance")}
              </div>
              <div style={{ display: "grid", gap: "0.85rem" }}>
                <SummaryMetric label={t("sub_360_total_quota")} value={ocsTrafficTotalStr} />
                <SummaryMetric label={t("sub_360_available")} value={ocsTrafficBalanceStr} accent />
              </div>
            </div>

            <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "1rem", background: "var(--header-bg)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", marginBottom: "0.9rem", color: "var(--text-main)", fontWeight: 800 }}>
                <PhoneCall size={18} color="var(--primary)" />
                {t("sub_360_ims_voice")}
              </div>
              <div style={{ display: "grid", gap: "0.85rem" }}>
                <SummaryMetric label={t("sub_360_total_duration")} value={ocsVoiceTotalStr} />
                <SummaryMetric label={t("sub_360_available")} value={ocsVoiceBalanceStr} accent />
              </div>
            </div>

            <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "1rem", background: "var(--header-bg)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", marginBottom: "0.9rem", color: "var(--text-main)", fontWeight: 800 }}>
                <MessageSquare size={18} color="var(--primary)" />
                {t("sub_360_ims_sms")}
              </div>
              <div style={{ display: "grid", gap: "0.85rem" }}>
                <SummaryMetric label={t("sub_360_sms_quota")} value={ocsSmsTotalStr} />
                <SummaryMetric label={t("sub_360_available")} value={ocsSmsBalanceStr} accent />
              </div>
            </div>

            <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "1rem", background: "var(--header-bg)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", marginBottom: "0.9rem", color: "var(--text-main)", fontWeight: 800 }}>
                <Signal size={18} color="var(--primary)" />
                {t("sub_360_network_entitlement")}
              </div>
              <div style={{ display: "grid", gap: "0.85rem" }}>
                <SummaryMetric label={t("sub_360_slices_sessions")} value={`${sliceCount} / ${sessionCount}`} />
                <SummaryMetric label={t("sub_360_pcc_rules")} value={String(pccRuleCount)} />
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
            <ServicePill enabled={hasDataRule}>{t("sub_360_packet_data")}</ServicePill>
            <ServicePill enabled={hasImsRule}>{t("sub_360_ims_service")}</ServicePill>
            <ServicePill enabled={hasVoiceRule}>{t("sub_360_voice_time")}</ServicePill>
            <ServicePill enabled={hasSmsRule}>{t("sub_360_sms_event")}</ServicePill>
            <ServicePill enabled={sliceCount > 0}>{t("sub_360_slice_profile")}</ServicePill>
          </div>
        </div>
      </section>

      <section id="sec-technical-details" style={{ display: "grid", gap: "1rem", marginTop: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--text-main)", fontWeight: 800, fontSize: "1.15rem" }}>
          <Server size={20} />
          {t("sub_technical_title")}
        </div>

        <DetailPanel id="sec-security" title={t("sec_security_auth")} icon={<KeyRound size={18} color="var(--primary)" />} defaultOpen>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 390px), 1fr))", gap: "0.85rem" }}>
            <AuthValueCard label={t("sub_key_k")} value={auth4GData.k} copyable singleLine />
            <AuthValueCard label={`${t("sub_key_op")} (${usimType.toUpperCase()})`} value={auth4GData.opValue} copyable singleLine />
            <AuthValueCard label="AMF" value={auth4GData.amf || "N/A"} />
            <AuthValueCard label="SQN" value={String(auth4GData.sqn || 0)} />
          </div>
        </DetailPanel>

        <DetailPanel id="sec-network" title={t("sub_network_config")} icon={<Signal size={18} color="var(--primary)" />}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem" }}>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "1.25rem", borderRadius: "8px", border: "1px solid var(--surface-border)", background: "var(--surface-hover)" }}>
              <Wifi size={28} color="var(--primary)" />
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "0.25rem", fontWeight: 600, textTransform: 'uppercase' }}>{t("sub_lbl_ambr_dl")}</div>
                <div style={{ color: "var(--text-main)", fontSize: "1.5rem", fontWeight: 600 }}>
                  {ueAmbr.downlink?.value || 0} <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}>{AMBR_UNITS.find(u => u.val === (ueAmbr.downlink?.unit || 1))?.label || ''}</span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "1.25rem", borderRadius: "8px", border: "1px solid var(--surface-border)", background: "var(--surface-hover)" }}>
              <Wifi size={28} color="var(--primary)" style={{ transform: "rotate(180deg)" }} />
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "0.25rem", fontWeight: 600, textTransform: 'uppercase' }}>{t("sub_lbl_ambr_ul")}</div>
                <div style={{ color: "var(--text-main)", fontSize: "1.5rem", fontWeight: 600 }}>
                  {ueAmbr.uplink?.value || 0} <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}>{AMBR_UNITS.find(u => u.val === (ueAmbr.uplink?.unit || 1))?.label || ''}</span>
                </div>
              </div>
            </div>
          </div>
        </DetailPanel>

        <DetailPanel id="sec-ocs-view" title={t("sec_billing_config")} icon={<Gauge size={18} color="var(--primary)" />}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1.25rem", marginBottom: "1.25rem" }}>
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
          <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.75rem", fontWeight: 700 }}>{t("sub_360_apn_rules")}</div>
          <RatingRuleLinkPanel
            planId={ocsPlanId}
            planStatus={ocsPlanStatus}
            ocsRules={ocsRules}
            ratingList={ratingList}
            t={t}
            compact
          />
          <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", margin: "1rem 0 0.75rem", fontWeight: 700 }}>{t("sub_360_raw_mapping")}</div>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {ocsRules.length > 0 ? ocsRules.map((rule: any) => (
              <div key={rule.rule_id || `${rule.apn}-${rule.rating_group_id}`} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: "1rem", padding: "0.75rem 1rem", border: "1px solid var(--surface-border)", borderRadius: "6px", fontFamily: "monospace", fontSize: "0.9rem", overflowX: "auto" }}>
                <span>{rule.apn}</span>
                <span>RG {rule.rating_group_id}</span>
                <span>SI {rule.service_identifier}</span>
                <span>{ratingTypeLabel(t, rule.charging_type)}</span>
                <span>{ratingUnitLabel(t, rule.unit)}</span>
              </div>
            )) : <span style={{ color: "var(--text-muted)" }}>{t("sub_360_no_tariff_rules")}</span>}
          </div>
        </DetailPanel>

        <DetailPanel id="sec-slices" title={t("sub_slices_arch")} icon={<Route size={18} color="var(--primary)" />}>
          {Array.isArray(slices) && slices.length > 0 ? slices.map((slice, sIdx) => {
            return (
              <div key={sIdx} className="slice-strip-card" id={`slice-card-${sIdx}`} style={{ marginTop: sIdx === 0 ? 0 : "1rem" }}>
                <div
                  className="slice-card-header"
                  onClick={() => setExpandedSlices(prev => prev.includes(sIdx) ? prev.filter(i => i !== sIdx) : [...prev, sIdx])}
                  style={{ padding: "1.25rem 1.5rem", borderBottom: expandedSlices.includes(sIdx) ? "1px solid var(--surface-border)" : "none", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--primary)" }}>{t("slice_idx", { idx: sIdx + 1 })}</span>
                    <div style={{ display: "flex", gap: "1rem", background: "var(--surface-hover)", padding: "0.5rem 1rem", borderRadius: "6px" }}>
                      <span style={{ fontWeight: 600, color: "var(--text-main)" }}>SST: {slice.sst}</span>
                      {slice.sd && slice.sd !== "000000" && <span style={{ color: "var(--text-secondary)" }}>SD: {slice.sd}</span>}
                    </div>
                    {slice.default_indicator && <Pill enabled={true}>{t("sub_default_nssai")}</Pill>}
                  </div>
                  <div>
                    {expandedSlices.includes(sIdx) ? <ChevronUp size={20} color="var(--text-muted)" /> : <ChevronDown size={20} color="var(--text-muted)" />}
                  </div>
                </div>

                <div className={`accordion-content ${expandedSlices.includes(sIdx) ? 'expanded' : 'collapsed'}`}>
                  <div style={{ minHeight: "120px", padding: "1rem", overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.95rem" }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid var(--surface-border)" }}>
                          <th className="table-header-cap" style={{ padding: "1rem" }}>{t("slice_col_dnn")}</th>
                          <th className="table-header-cap" style={{ padding: "1rem" }}>{t("slice_col_type")}</th>
                          <th className="table-header-cap" style={{ padding: "1rem" }}>{t("slice_col_qci")}</th>
                          <th className="table-header-cap" style={{ padding: "1rem" }}>{t("slice_col_arp")}</th>
                          <th className="table-header-cap" style={{ padding: "1rem" }}>{t("slice_col_ambr")}</th>
                          <th className="table-header-cap" style={{ padding: "1rem" }}>{t("slice_col_pcc")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slice.session_list && slice.session_list.length > 0 ? slice.session_list.map((sess: any, sessIdx: number) => (
                          <tr key={sessIdx} className="hover-session" style={{ borderBottom: "1px solid transparent" }}>
                            <td style={{ padding: "1.25rem 1rem", color: "var(--text-main)", fontWeight: 600 }}>{sess.name || "internet"}</td>
                            <td style={{ padding: "1.25rem 1rem", color: "var(--text-secondary)" }}>{typeLabel(sess.type)}</td>
                            <td style={{ padding: "1.25rem 1rem", color: "var(--text-secondary)" }}>{sess.qos?._5qi || "-"}</td>
                            <td style={{ padding: "1.25rem 1rem", color: "var(--text-secondary)" }}>{sess.qos?.arp?.priorityLevel || "-"}</td>
                            <td style={{ padding: "1.25rem 1rem", color: "var(--text-secondary)", fontWeight: 500, whiteSpace: "nowrap" }}>{getAmbrString(sess.ambr)}</td>
                            <td style={{ padding: "1.25rem 1rem", color: "var(--text-secondary)" }}>
                              {sess.pcc_rule && sess.pcc_rule.length > 0 ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                                  {sess.pcc_rule.map((rule: any, pccIdx: number) => (
                                    <div key={pccIdx} style={{ background: 'var(--surface-hover)', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.85em', border: '1px solid var(--surface-border)' }}>
                                      <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: '0.2rem' }}>{t("slice_rule_idx", { idx: pccIdx + 1 })}</div>
                                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                                        <div><span style={{ color: 'var(--text-muted)' }}>5QI:</span> {rule.qos?._5qi || 1}</div>
                                        <div><span style={{ color: 'var(--text-muted)' }}>ARP:</span> {rule.qos?.arp?.priorityLevel || 2}</div>
                                        <div style={{ gridColumn: 'span 2' }}>
                                          <span style={{ color: 'var(--text-muted)' }}>MBR:</span> {rule.qos?.mbr?.downlink?.value || 0} {AMBR_UNITS.find(u => u.val === (rule.qos?.mbr?.downlink?.unit || 1))?.label} (DL) / {rule.qos?.mbr?.uplink?.value || 0} {AMBR_UNITS.find(u => u.val === (rule.qos?.mbr?.uplink?.unit || 1))?.label} (UL)
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <span style={{ color: 'var(--text-muted)' }}>{t("none")}</span>
                              )}
                            </td>
                          </tr>
                        )) : (
                          <tr><td colSpan={6} style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>{t("sub_no_sessions")}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          }) : (
            <div style={{ textAlign: "center", color: "var(--text-muted)", padding: "3rem", border: "1px dashed var(--surface-border)", borderRadius: "6px" }}>{t("sub_no_slices")}</div>
          )}
        </DetailPanel>
      </section>
    </div>
  );
}
