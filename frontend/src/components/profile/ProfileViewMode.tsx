import { Users, Shield, Signal, Gauge, Server, Lock, ChevronDown, ChevronUp } from "lucide-react";
import { AMBR_UNITS, getAmbrString, typeLabel } from "../subscriber/utils";
import "./profile.css";

function ratingTypeLabel(t: (key: string) => string, value?: string) {
  if (value === "data_volume") return t("rating_service_data");
  if (value === "voice_time") return t("rating_service_voice");
  if (value === "sms_event" || value === "event") return t("rating_service_sms");
  if (value === "free") return t("rating_service_ims");
  return value || "-";
}

function ratingUnitLabel(t: (key: string) => string, value?: string) {
  if (value === "bytes" || value === "octets") return t("rating_unit_bytes");
  if (value === "seconds") return t("rating_unit_seconds");
  if (value === "events") return t("rating_unit_events");
  return value || "-";
}

export default function ProfileViewMode({ t, authData, usimType, ocsDefaults, tariffPlanList, ratingList, ueAmbr, isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded, accessRestriction, slices, backendStats }: any) {
  const planId = ocsDefaults.planId || ocsDefaults.plan_id || "plan_default_10gb";
  const selectedPlan = Array.isArray(tariffPlanList)
    ? tariffPlanList.find((plan: any) => plan.plan_id === planId)
    : null;

  return (
    <div className="animate-fade-in profile-container">
      {backendStats && (
        <div className="dash-card" id="psec-stats" style={{ marginBottom: "1.5rem" }}>
          <div className="dash-card-header">
            <Users size={20} color="var(--primary)" />
            <h3 className="card-title">{t("prof_change_impacted")} ({backendStats.totalSubscribers})</h3>
          </div>
          <div className="dash-card-body grid-3-col">
            <div>
              <div className="label-muted">{t("prof_change_impacted")}</div>
              <div className="value-mono" style={{ fontWeight: 600, color: "var(--primary)" }}>{backendStats.totalSubscribers}</div>
            </div>
            <div>
              <div className="label-muted">{t("prof_stat_active")}</div>
              <div className="value-mono" style={{ color: "var(--success)" }}>{backendStats.activeSubscribers}</div>
            </div>
            <div>
              <div className="label-muted">{t("prof_stat_suspended")}</div>
              <div className="value-mono" style={{ color: backendStats.suspendedSubscribers > 0 ? "var(--danger)" : "var(--text-muted)" }}>{backendStats.suspendedSubscribers}</div>
            </div>
          </div>
          {Array.isArray(backendStats.sampleImsis) && backendStats.sampleImsis.length > 0 && (
            <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid var(--border-color)", fontSize: "var(--ref-font-size-data-relaxed)" }}>
              <span className="label-muted" style={{ marginRight: "0.5rem" }}>{t("prof_stat_samples")}:</span>
              <span className="value-mono" style={{ opacity: 0.85 }}>{backendStats.sampleImsis.join(", ")}</span>
            </div>
          )}
        </div>
      )}

      {/* Security Template Card */}
      <div className="dash-card" id="psec-security">
        <div className="dash-card-header">
          <Shield size={20} color="var(--primary)" />
          <h3 className="card-title">{t("sec_security_auth")}</h3>
        </div>
        <div className="dash-card-body grid-3-col">
          <div>
            <div className="label-muted">K</div>
            <div className="value-mono">{authData.k || "N/A"}</div>
          </div>
          <div>
            <div className="label-muted">{usimType === "op" ? "OP" : "OPc"}</div>
            <div className="value-mono">{authData.opValue || "N/A"}</div>
          </div>
          <div>
            <div className="label-muted">AMF</div>
            <div className="value-mono">{authData.amf || "N/A"}</div>
          </div>
        </div>
      </div>

      {/* View Mode: Billing Predefined Settings */}
      <div className="dash-card card-margin" id="psec-ocs-view">
        <div className="dash-card-header">
          <Gauge size={20} color="var(--primary)" />
          <h3 className="card-title">{t("sec_billing_config")}</h3>
        </div>
        <div className="dash-card-body grid-2-col">
           <div className="col-span-all">
             <div className="label-muted">{t("sub_360_tariff_plan")}</div>
             <div className="value-mono">
               {selectedPlan?.name && selectedPlan.name !== planId ? `${selectedPlan.name} (${planId})` : planId}
             </div>
           </div>
           <div><div className="label-muted">{t("prof_lbl_quota")}</div><div className="value-mono">{ocsDefaults.trafficTotal}</div></div>
           <div><div className="label-muted">{t("prof_lbl_balance")}</div><div className="value-mono">{ocsDefaults.trafficBalance}</div></div>
           <div><div className="label-muted">{t("prof_sms_quota")}</div><div className="value-mono">{ocsDefaults.smsTotal || "0"}</div></div>
           <div><div className="label-muted">{t("prof_sms_balance")}</div><div className="value-mono">{ocsDefaults.smsBalance || "0"}</div></div>
           <div className="col-span-all">
             <div className="label-muted mb-3">{t("prof_tariff_rules")}</div>
             <div className="grid-gap-small">
               {ratingList.length > 0 ? ratingList.map((rule: any) => (
                 <div key={rule.rule_id || `${rule.apn}-${rule.rating_group_id}`} className="tariff-rule-row">
                   <span>{rule.apn}</span>
                   <span>RG {rule.rating_group_id}</span>
                   <span>SI {rule.service_identifier}</span>
                   <span>{ratingTypeLabel(t, rule.charging_type)}</span>
                   <span>{ratingUnitLabel(t, rule.unit)}</span>
                 </div>
               )) : <span className="text-muted-label">{t("prof_no_tariff_rules")}</span>}
             </div>
           </div>
        </div>
      </div>

      {/* Network AMBR Card */}
      <div className="dash-card" id="psec-network">
        <div className="dash-card-header">
          <Signal size={20} color="var(--primary)" />
          <h3 className="card-title">{t("sec_global_network")}</h3>
        </div>
        <div className="dash-card-body flex-gap-large">
          <div className="ambr-card">
            <div className="ambr-label">{t("sub_dl")}</div>
            <div className="ambr-value">
              {ueAmbr.downlink?.value || 0} <span className="ambr-unit">{AMBR_UNITS.find(u => u.val === (ueAmbr.downlink?.unit || 1))?.label || ''}</span>
            </div>
          </div>
          <div className="ambr-card">
            <div className="ambr-label">{t("sub_ul")}</div>
            <div className="ambr-value">
              {ueAmbr.uplink?.value || 0} <span className="ambr-unit">{AMBR_UNITS.find(u => u.val === (ueAmbr.uplink?.unit || 1))?.label || ''}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Access Restrictions */}
      <div className="dash-card card-margin-top" id="psec-access-restrictions">
        <div className="dash-card-header flex-between-center">
          <div className="flex-center-gap">
            <Lock size={20} color="var(--primary)" />
            <h3 className="card-title">{t("sec_access_restrict")}</h3>
          </div>
          <button
            type="button"
            className="btn-icon btn-transparent"
            onClick={() => setIsAccessRestrictionsExpanded((prev: boolean) => !prev)}
            title={isAccessRestrictionsExpanded ? t("collapse") : t("expand")}
          >
            {isAccessRestrictionsExpanded ? <ChevronUp size={18} color="var(--text-muted)" /> : <ChevronDown size={18} color="var(--text-muted)" />}
          </button>
        </div>
        {isAccessRestrictionsExpanded && (
          <div className="dash-card-body">
            <div className="value-mono">{accessRestriction}</div>
          </div>
        )}
      </div>

      {/* Slices Overview */}
      <div id="psec-slices" className="pt-1">
        <h3 className="section-title"><Server size={22}/> {t("sub_slices_core")}</h3>
        {Array.isArray(slices) && slices.length > 0 ? slices.map((slice: any, sIdx: number) => (
          <div key={sIdx} className="slice-strip-card">
            <div className="slice-header">
              <span className="slice-idx">{t("slice_idx", { idx: sIdx + 1 })}</span>
              <div className="slice-tags">
                <span className="slice-tag-sst">SST: {slice.sst}</span>
                {slice.sd && slice.sd !== "000000" && <span className="slice-tag-sd">SD: {slice.sd}</span>}
              </div>
              {slice.default_indicator && <span className="pill pill-enabled">{t("sub_default_nssai")}</span>}
            </div>
            <div className="p-1">
              <table className="table-default">
                <caption className="sr-only">{t("sub_slices_core")} · {t("slice_idx", { idx: sIdx + 1 })}</caption>
                <thead>
                  <tr className="table-header-row">
                    <th className="table-header-cap table-cell-pad">{t("slice_col_dnn")}</th>
                    <th className="table-header-cap table-cell-pad">{t("slice_col_type")}</th>
                    <th className="table-header-cap table-cell-pad">{t("slice_col_qci")}</th>
                    <th className="table-header-cap table-cell-pad">{t("slice_col_arp")}</th>
                    <th className="table-header-cap table-cell-pad">{t("slice_col_ambr")}</th>
                    <th className="table-header-cap table-cell-pad">{t("slice_col_pcc")}</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.session_list?.length > 0 ? slice.session_list.map((sess: any, sessIdx: number) => (
                    <tr key={sessIdx} className="table-row-border">
                      <td className="table-cell-main">{sess.name}</td>
                      <td className="table-cell-sec">{typeLabel(sess.type)}</td>
                      <td className="table-cell-sec">{sess.qos?._5qi || "-"}</td>
                      <td className="table-cell-sec">{sess.qos?.arp?.priorityLevel || "-"}</td>
                      <td className="table-cell-nowrap">{getAmbrString(sess.ambr)}</td>
                      <td className="table-cell-pad">
                        {sess.pcc_rule?.length > 0 ? (
                            <div className="flex-col-gap">
                              {sess.pcc_rule.map((rule: any, pccIdx: number) => (
                                <div key={pccIdx} className="pcc-rule-card">
                                  <div className="pcc-rule-title">{t("slice_rule_idx", { idx: pccIdx + 1 })}</div>
                                  <div className="pcc-rule-grid">
                                    <div><span className="text-muted-label">5QI:</span> {rule.qos?.index || 1}</div>
                                    <div><span className="text-muted-label">ARP:</span> {rule.qos?.arp?.priority_level || 2}</div>
                                    <div className="col-span-2">
                                      <span className="text-muted-label">MBR:</span> {rule.qos?.mbr?.downlink?.value || 0} {AMBR_UNITS.find(u => u.val === (rule.qos?.mbr?.downlink?.unit || 1))?.label} (DL) / {rule.qos?.mbr?.uplink?.value || 0} {AMBR_UNITS.find(u => u.val === (rule.qos?.mbr?.uplink?.unit || 1))?.label} (UL)
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                        ) : <span className="text-muted-label">{t("none")}</span>}
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan={6} className="empty-state-no-border">{t("prof_no_sessions")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )) : (
          <div className="empty-state">{t("prof_no_slices")}</div>
        )}
      </div>
    </div>
  );
}
