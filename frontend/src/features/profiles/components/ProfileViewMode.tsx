/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/profile/ProfileViewMode.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { Users, Shield, Signal, Gauge, Server, Lock, ChevronDown, ChevronUp } from "lucide-react";
import { getAmbrString, typeLabel } from '../../subscribers/components/subscriber/utils';
import { ambrSideView, mbrSideText, ratingTypeLabel, ratingUnitLabel } from '../profile-format';
import { DEFAULT_ACCESS_RESTRICTION_BITS, accessBitLabel, type AccessRestrictionBit } from '../profile-access';
import { isWithheldPlaceholder } from '../../../types/credential';
import type { ProfileViewState, Translate } from '../profile-types';
import styles from '../../../styles/modules/profile.module.css';

export default function ProfileViewMode({ t, authData, credentialState, rawAuth, usimType, ocsDefaults, tariffPlanList, ratingList, ratingStatus, ueAmbr, isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded, accessRestriction, accessBits, slices, backendStats, statsUnavailable }: {
  t: Translate;
} & ProfileViewState) {
  /* The stored value is a 3GPP bitmask. Reading it is a decode, not a number the
   * operator should have to do in their head, so the same vocabulary the editor
   * uses is what the view renders. Unknown bits are still reported: a mask this
   * build does not name is not an empty mask. */
  const restrictionValue: number | null = typeof accessRestriction === "number" ? accessRestriction : null;
  const bitOptions: AccessRestrictionBit[] = Array.isArray(accessBits) && accessBits.length > 0
    ? accessBits
    : DEFAULT_ACCESS_RESTRICTION_BITS;
  const activeBits = restrictionValue === null || restrictionValue === 0 || restrictionValue === 255
    ? []
    : bitOptions.filter((bit) => (restrictionValue & bit.value) !== 0);
  const knownMask = activeBits.reduce((mask, bit) => mask | bit.value, 0);
  const unknownMask = restrictionValue === null ? 0 : restrictionValue & ~knownMask;
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
    <div className={`animate-fade-in ${styles.profileContainer}`}>
      {(backendStats || statsUnavailable) && (
        <div className={`dash-card ${styles.dashCardSpaced}`} id="psec-stats">
          <div className="dash-card-header">
            <Users size={20} color="var(--primary)" />
            <h3 className={styles.cardTitle}>{t("prof_change_impacted")}{backendStats ? ` (${backendStats.totalSubscribers})` : ""}</h3>
          </div>
          {!backendStats ? (
            /* The attribution failed: report it as unavailable rather than
             * showing nothing, or worse, a screenful of zeroes. */
            <div className="dash-card-body">
              <span className="warning-text">{t("prof_stats_unavailable")}</span>
            </div>
          ) : (
            <>
          <div className={`dash-card-body ${styles.grid3Col}`}>
            <div>
              <div className={styles.labelMuted}>{t("prof_change_impacted")}</div>
              <div className={`${styles.valueMono} ${styles.valueMonoPrimary}`}>{backendStats.totalSubscribers}</div>
            </div>
            <div>
              <div className={styles.labelMuted}>{t("prof_stat_active")}</div>
              <div className={`${styles.valueMono} ${styles.valueMonoSuccess}`}>{backendStats.activeSubscribers}</div>
            </div>
            <div>
              <div className={styles.labelMuted}>{t("prof_stat_suspended")}</div>
              <div className={styles.valueMono} style={{ color: backendStats.suspendedSubscribers > 0 ? "var(--danger)" : "var(--text-muted)" }}>{backendStats.suspendedSubscribers}</div>
            </div>
          </div>
          {Array.isArray(backendStats.sampleImsis) && backendStats.sampleImsis.length > 0 && (
            <div className={styles.profileSampleStrip}>
              <span className={`${styles.labelMuted} ${styles.labelMutedInline}`}>{t("prof_stat_samples")}:</span>
              <span className={`${styles.valueMono} ${styles.valueMonoDim}`}>{backendStats.sampleImsis.join(", ")}</span>
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
          <h3 className={styles.cardTitle}>{t("sec_security_auth")}</h3>
        </div>
        <div className={`dash-card-body ${styles.grid3Col}`}>
          <div>
            <div className={styles.labelMuted}>K</div>
            <div className={styles.valueMono}>{credentialDisplay(authData.k, 'k')}</div>
          </div>
          <div>
            <div className={styles.labelMuted}>{usimType === "op" ? "OP" : "OPc"}</div>
            <div className={styles.valueMono}>{credentialDisplay(authData.opValue, usimType === "op" ? 'op' : 'opc')}</div>
          </div>
          <div>
            <div className={styles.labelMuted}>AMF</div>
            <div className={styles.valueMono}>{authData.amf || notConfigured}</div>
          </div>
        </div>
      </div>

      {/* View Mode: Billing Predefined Settings */}
      <div className={`dash-card ${styles.cardMargin}`} id="psec-ocs-view">
        <div className="dash-card-header">
          <Gauge size={20} color="var(--primary)" />
          <h3 className={styles.cardTitle}>{t("sec_billing_config")}</h3>
        </div>
        <div className={`dash-card-body ${styles.grid2Col}`}>
           <div className={styles.colSpanAll}>
             <div className={styles.labelMuted}>{t("sub_360_tariff_plan")}</div>
             <div className={styles.valueMono}>
               {planId
                 ? (selectedPlan?.name && selectedPlan.name !== planId ? `${selectedPlan.name} (${planId})` : planId)
                 : notConfigured}
             </div>
           </div>
           <div><div className={styles.labelMuted}>{t("prof_lbl_quota")}</div><div className={styles.valueMono}>{ocsDefaults.trafficTotal || notConfigured}</div></div>
           <div><div className={styles.labelMuted}>{t("prof_lbl_balance")}</div><div className={styles.valueMono}>{ocsDefaults.trafficBalance || notConfigured}</div></div>
           <div><div className={styles.labelMuted}>{t("prof_sms_quota")}</div><div className={styles.valueMono}>{ocsDefaults.smsTotal || notConfigured}</div></div>
           <div><div className={styles.labelMuted}>{t("prof_sms_balance")}</div><div className={styles.valueMono}>{ocsDefaults.smsBalance || notConfigured}</div></div>
           <div className={styles.colSpanAll}>
             <div className={`${styles.labelMuted} mb-3`}>{t("prof_tariff_rules")}</div>
             <div className={styles.gridGapSmall}>
               {ratingStatus === 'unavailable' ? (
                 <span className="warning-text">{t("prof_rules_unavailable")}</span>
               ) : !planId ? (
                 <span className={styles.textMutedLabel}>{t("prof_rules_no_plan")}</span>
               ) : ratingList.length > 0 ? ratingList.map((rule: any) => (
                 <div key={rule.rule_id || `${rule.apn}-${rule.rating_group_id}`} className={styles.tariffRuleRow}>
                   <span>{rule.apn}</span>
                   <span>RG {rule.rating_group_id}</span>
                   <span>SI {rule.service_identifier}</span>
                   <span>{ratingTypeLabel(t, rule.charging_type)}</span>
                   <span>{ratingUnitLabel(t, rule.unit)}</span>
                 </div>
               )) : <span className={styles.textMutedLabel}>{t("prof_no_tariff_rules")}</span>}
             </div>
           </div>
        </div>
      </div>

      {/* Network AMBR Card */}
      <div className="dash-card" id="psec-network">
        <div className="dash-card-header">
          <Signal size={20} color="var(--primary)" />
          <h3 className={styles.cardTitle}>{t("sec_global_network")}</h3>
        </div>
        <div className={`dash-card-body ${styles.flexGapLarge}`}>
          <div className={styles.ambrCard}>
            <div className={styles.profileAmbrLabel}>{t("sub_dl")}</div>
            <div className={downlinkAmbr.unit ? "ambr-value" : `ambr-value ${styles.textMutedLabel}`}>
              {downlinkAmbr.text} {downlinkAmbr.unit && <span className="ambr-unit">{downlinkAmbr.unit}</span>}
            </div>
          </div>
          <div className={styles.ambrCard}>
            <div className={styles.profileAmbrLabel}>{t("sub_ul")}</div>
            <div className={uplinkAmbr.unit ? "ambr-value" : `ambr-value ${styles.textMutedLabel}`}>
              {uplinkAmbr.text} {uplinkAmbr.unit && <span className="ambr-unit">{uplinkAmbr.unit}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Access Restrictions */}
      <div className={`dash-card ${styles.cardMarginTop}`} id="psec-access-restrictions">
        <div className={`dash-card-header ${styles.flexBetweenCenter}`}>
          <div className={styles.flexCenterGap}>
            <Lock size={20} color="var(--primary)" />
            <h3 className={styles.cardTitle}>{t("sec_access_restrict")}</h3>
          </div>
          <button
            type="button"
            className={`btn-icon ${styles.btnTransparent}`}
            onClick={() => setIsAccessRestrictionsExpanded((prev: boolean) => !prev)}
            title={isAccessRestrictionsExpanded ? t("collapse") : t("expand")}
          >
            {isAccessRestrictionsExpanded ? <ChevronUp size={18} color="var(--text-muted)" /> : <ChevronDown size={18} color="var(--text-muted)" />}
          </button>
        </div>
        {isAccessRestrictionsExpanded && (
          <div className="dash-card-body">
            {restrictionValue === null ? (
              <div className={styles.valueMono}>{notConfigured}</div>
            ) : restrictionValue === 0 ? (
              <div className={styles.valueMono}>{t("prof_diff_access_none")}</div>
            ) : restrictionValue === 255 ? (
              <div className={styles.valueMono}>{t("prof_diff_access_suspended")}</div>
            ) : (
              <div className={styles.profileContentTags}>
                {activeBits.map((bit: AccessRestrictionBit) => (
                  <span key={bit.value} className={`${styles.profileChip} ${styles.profileChipNeutral}`}>
                    {accessBitLabel(t, bit)}
                  </span>
                ))}
                {unknownMask !== 0 && (
                  <span className={`${styles.profileChip} ${styles.profileChipNeutral}`}>
                    {t("prof_access_other_bits", { mask: unknownMask })}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Slices Overview */}
      <div id="psec-slices" className={styles.pt1}>
        <h3 className={styles.sectionTitle}><Server size={22}/> {t("sub_slices_core")}</h3>
        {Array.isArray(slices) && slices.length > 0 ? slices.map((slice: any, sIdx: number) => (
          <div key={sIdx} className="slice-strip-card">
            <div className={styles.sliceHeader}>
              <span className="slice-idx">{t("slice_idx", { idx: sIdx + 1 })}</span>
              <div className={styles.sliceTags}>
                <span className={styles.sliceTagSst}>SST: {slice.sst}</span>
                {slice.sd && slice.sd !== "000000" && <span className={styles.sliceTagSd}>SD: {slice.sd}</span>}
              </div>
              {slice.default_indicator && <span className="pill pill-enabled">{t("sub_default_nssai")}</span>}
            </div>
            <div className={styles.profileViewPad}>
              <table className={styles.tableDefault}>
                <caption className="sr-only">{t("sub_slices_core")} · {t("slice_idx", { idx: sIdx + 1 })}</caption>
                <thead>
                  <tr className={styles.tableHeaderRow}>
                    <th className={`table-header-cap ${styles.tableCellPad}`}>{t("slice_col_dnn")}</th>
                    <th className={`table-header-cap ${styles.tableCellPad}`}>{t("slice_col_type")}</th>
                    <th className={`table-header-cap ${styles.tableCellPad}`}>{t("slice_col_qci")}</th>
                    <th className={`table-header-cap ${styles.tableCellPad}`}>{t("slice_col_arp")}</th>
                    <th className={`table-header-cap ${styles.tableCellPad}`}>{t("slice_col_ambr")}</th>
                    <th className={`table-header-cap ${styles.tableCellPad}`}>{t("slice_col_pcc")}</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.session_list?.length > 0 ? slice.session_list.map((sess: any, sessIdx: number) => (
                    <tr key={sessIdx} className={styles.tableRowBorder}>
                      <td className={styles.tableCellMain}>{sess.name}</td>
                      <td className={styles.tableCellSec}>{typeLabel(sess.type)}</td>
                      <td className={styles.tableCellSec}>{sess.qos?._5qi || "-"}</td>
                      <td className={styles.tableCellSec}>{sess.qos?.arp?.priorityLevel || "-"}</td>
                      <td className={styles.tableCellNowrap}>{getAmbrString(sess.ambr)}</td>
                      <td className={styles.tableCellPad}>
                        {sess.pcc_rule?.length > 0 ? (
                            <div className={styles.flexColGap}>
                              {sess.pcc_rule.map((rule: any, pccIdx: number) => (
                                <div key={pccIdx} className={styles.pccRuleCard}>
                                  <div className={styles.pccRuleTitle}>{t("slice_rule_idx", { idx: pccIdx + 1 })}</div>
                                  <div className="pcc-rule-grid">
                                    <div><span className={styles.textMutedLabel}>5QI:</span> {rule.qos?.index ?? t("prof_pcc_not_set")}</div>
                                    <div><span className={styles.textMutedLabel}>ARP:</span> {rule.qos?.arp?.priority_level ?? t("prof_pcc_not_set")}</div>
                                    <div className={styles.colSpan2}>
                                      <span className={styles.textMutedLabel}>MBR:</span> {mbrSide(rule.qos?.mbr?.downlink)} (DL) / {mbrSide(rule.qos?.mbr?.uplink)} (UL)
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                        ) : <span className={styles.textMutedLabel}>{t("none")}</span>}
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan={6} className={styles.emptyStateNoBorder}>{t("prof_no_sessions")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )) : (
          <div className={styles.emptyState}>{t("prof_no_slices")}</div>
        )}
      </div>
    </div>
  );
}
