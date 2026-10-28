/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/profile/ProfileViewMode.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { Users, Shield, Signal, Gauge, Server, Lock, ChevronDown, ChevronUp } from "lucide-react";
import { getAmbrString, typeLabel } from '../../subscribers/components/subscriber/utils';
import { ambrSideView, mbrSideText, ratingTypeLabel, ratingUnitLabel } from '../profile-format';
import { isWithheldPlaceholder } from '../../../types/credential';

export default function ProfileViewMode({ t, authData, credentialState, rawAuth, usimType, ocsDefaults, tariffPlanList, ratingList, ratingStatus, ueAmbr, isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded, accessRestriction, slices, backendStats, statsUnavailable }: any) {
  const planId = String(ocsDefaults.planId || ocsDefaults.plan_id || '');
  const selectedPlan = Array.isArray(tariffPlanList)
    ? tariffPlanList.find((plan: any) => plan.plan_id === planId)
    : null;
  const notConfigured = t("prof_diff_not_configured");
  /* The server states the condition of material this reader may not see:
   * withheld is not the same as absent, and neither is rendered as a value. */
  const credentialDisplay = (value: string, field: 'k' | 'op' | 'opc') => {
    /* The draft drops a retired placeholder before display, so the stored block
     * is what still says "this key exists, you just may not see it". */
    if (isWithheldPlaceholder(rawAuth?.[field])) return t("credential_withheld");
    if (credentialState?.visibility !== 'masked') return value || notConfigured;
    return credentialState[field] === 'configured' ? t("credential_withheld") : notConfigured;
  };
  const ambrSide = (side: any) => ambrSideView(side, notConfigured);
  const downlinkAmbr = ambrSide(ueAmbr?.downlink);
  const uplinkAmbr = ambrSide(ueAmbr?.uplink);
  const mbrSide = (side: any) => mbrSideText(side, t("prof_pcc_not_set"));

  return (
    <div className="animate-fade-in profile-container">
      {(backendStats || statsUnavailable) && (
        <div className="dash-card dash-card-spaced" id="psec-stats">
          <div className="dash-card-header">
            <Users size={20} color="var(--primary)" />
            <h3 className="card-title">{t("prof_change_impacted")}{backendStats ? ` (${backendStats.totalSubscribers})` : ""}</h3>
          </div>
          {!backendStats ? (
            /* The attribution failed: report it as unavailable rather than
             * showing nothing, or worse, a screenful of zeroes. */
            <div className="dash-card-body">
              <span className="warning-text">{t("prof_stats_unavailable")}</span>
            </div>
          ) : (
            <>
          <div className="dash-card-body grid-3-col">
            <div>
              <div className="label-muted">{t("prof_change_impacted")}</div>
              <div className="value-mono value-mono-primary">{backendStats.totalSubscribers}</div>
            </div>
            <div>
              <div className="label-muted">{t("prof_stat_active")}</div>
              <div className="value-mono value-mono-success">{backendStats.activeSubscribers}</div>
            </div>
            <div>
              <div className="label-muted">{t("prof_stat_suspended")}</div>
              <div className="value-mono" style={{ color: backendStats.suspendedSubscribers > 0 ? "var(--danger)" : "var(--text-muted)" }}>{backendStats.suspendedSubscribers}</div>
            </div>
          </div>
          {Array.isArray(backendStats.sampleImsis) && backendStats.sampleImsis.length > 0 && (
            <div className="profile-sample-strip">
              <span className="label-muted label-muted-inline">{t("prof_stat_samples")}:</span>
              <span className="value-mono value-mono-dim">{backendStats.sampleImsis.join(", ")}</span>
            </div>
          )}
            </>
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
            <div className="value-mono">{credentialDisplay(authData.k, 'k')}</div>
          </div>
          <div>
            <div className="label-muted">{usimType === "op" ? "OP" : "OPc"}</div>
            <div className="value-mono">{credentialDisplay(authData.opValue, usimType === "op" ? 'op' : 'opc')}</div>
          </div>
          <div>
            <div className="label-muted">AMF</div>
            <div className="value-mono">{authData.amf || notConfigured}</div>
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
               {planId
                 ? (selectedPlan?.name && selectedPlan.name !== planId ? `${selectedPlan.name} (${planId})` : planId)
                 : notConfigured}
             </div>
           </div>
           <div><div className="label-muted">{t("prof_lbl_quota")}</div><div className="value-mono">{ocsDefaults.trafficTotal || notConfigured}</div></div>
           <div><div className="label-muted">{t("prof_lbl_balance")}</div><div className="value-mono">{ocsDefaults.trafficBalance || notConfigured}</div></div>
           <div><div className="label-muted">{t("prof_sms_quota")}</div><div className="value-mono">{ocsDefaults.smsTotal || notConfigured}</div></div>
           <div><div className="label-muted">{t("prof_sms_balance")}</div><div className="value-mono">{ocsDefaults.smsBalance || notConfigured}</div></div>
           <div className="col-span-all">
             <div className="label-muted mb-3">{t("prof_tariff_rules")}</div>
             <div className="grid-gap-small">
               {ratingStatus === 'unavailable' ? (
                 <span className="warning-text">{t("prof_rules_unavailable")}</span>
               ) : !planId ? (
                 <span className="text-muted-label">{t("prof_rules_no_plan")}</span>
               ) : ratingList.length > 0 ? ratingList.map((rule: any) => (
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
            <div className="profile-ambr-label">{t("sub_dl")}</div>
            <div className={downlinkAmbr.unit ? "ambr-value" : "ambr-value text-muted-label"}>
              {downlinkAmbr.text} {downlinkAmbr.unit && <span className="ambr-unit">{downlinkAmbr.unit}</span>}
            </div>
          </div>
          <div className="ambr-card">
            <div className="profile-ambr-label">{t("sub_ul")}</div>
            <div className={uplinkAmbr.unit ? "ambr-value" : "ambr-value text-muted-label"}>
              {uplinkAmbr.text} {uplinkAmbr.unit && <span className="ambr-unit">{uplinkAmbr.unit}</span>}
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
            <div className="value-mono">
              {typeof accessRestriction !== "number"
                ? notConfigured
                : accessRestriction === 0
                  ? t("prof_diff_access_none")
                  : accessRestriction === 255
                    ? t("prof_diff_access_suspended")
                    : accessRestriction}
            </div>
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
            <div className="profile-view-pad">
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
                                    <div><span className="text-muted-label">5QI:</span> {rule.qos?.index ?? t("prof_pcc_not_set")}</div>
                                    <div><span className="text-muted-label">ARP:</span> {rule.qos?.arp?.priority_level ?? t("prof_pcc_not_set")}</div>
                                    <div className="col-span-2">
                                      <span className="text-muted-label">MBR:</span> {mbrSide(rule.qos?.mbr?.downlink)} (DL) / {mbrSide(rule.qos?.mbr?.uplink)} (UL)
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
