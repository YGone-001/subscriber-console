import { Users, Shield, Signal, Lock, ChevronDown, ChevronUp, Gauge, Server, Plus } from "lucide-react";
import ProfileSliceEditor from "../profile/ProfileSliceEditor";
import RatingRuleLinkPanel from "./RatingRuleLinkPanel";
import { BYTE_INPUT_UNITS, TIME_INPUT_UNITS, composeByteInput, composeSecondsInput, splitByteInput, splitSecondsInput } from "@/lib/unitParser";
import { AMBR_UNITS } from "./utils";
import type { Ambr, Auth4GData, Rating, Slice } from "@/types/subscriber";
import { useI18n } from "../I18nProvider";

interface SubscriberEditModeProps {
  t: any;
  imsi: string | null;
  state: {
    inputImsi: string;
    msisdn: string;
    profileList: any[];
    ratingList: Rating[];
    tariffPlanList: Array<{ plan_id: string; name?: string; status?: string }>;
    auth4GData: Auth4GData;
    usimType: "opc" | "op";
    ueAmbr: Ambr;
    isAccessRestrictionsExpanded: boolean;
    accessRestriction: number;
    ocsPlmn: string;
    ocsTrafficTotalStr: string;
    ocsTrafficBalanceStr: string;
    ocsVoiceTotalStr: string;
    ocsVoiceBalanceStr: string;
    ocsSmsTotalStr: string;
    ocsSmsBalanceStr: string;
    ocsPlanId: string;
    ocsPlanStatus: string;
    ocsRules: any[];
    slices: Slice[];
    newlyAddedSliceIndex: number | null;
    expandedSlices: number[];
    inputImsiExists: boolean;
    isCheckingInputImsi: boolean;
  };
  actions: any;
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

export default function SubscriberEditMode({ t, imsi, state, actions }: SubscriberEditModeProps) {
  const { lang } = useI18n();
  const {
    inputImsi, msisdn, profileList,
    auth4GData, usimType, ueAmbr, isAccessRestrictionsExpanded, accessRestriction,
    ocsPlmn, ocsTrafficTotalStr, ocsTrafficBalanceStr, ocsVoiceTotalStr, ocsVoiceBalanceStr, ocsSmsTotalStr, ocsSmsBalanceStr, ocsPlanId, ocsPlanStatus, ocsRules, ratingList, tariffPlanList,
    slices, newlyAddedSliceIndex, expandedSlices, inputImsiExists, isCheckingInputImsi
  } = state;

  const {
    setInputImsi, setMsisdn, loadFromProfile,
    setAuth4GData, setUsimType, setUeAmbr, setIsAccessRestrictionsExpanded, setAccessRestriction,
    setOcsTrafficTotalStr, setOcsTrafficBalanceStr, setOcsVoiceTotalStr, setOcsVoiceBalanceStr, setOcsSmsTotalStr, setOcsSmsBalanceStr,
    setOcsPlanId, addSlice, handleSliceChange, removeSlice, setExpandedSlices
  } = actions;
  const totalTrafficInput = splitByteInput(ocsTrafficTotalStr);
  const balanceTrafficInput = splitByteInput(ocsTrafficBalanceStr, totalTrafficInput.unit);
  const totalVoiceInput = splitSecondsInput(ocsVoiceTotalStr);
  const balanceVoiceInput = splitSecondsInput(ocsVoiceBalanceStr, totalVoiceInput.unit);
  const duplicateImsiWarning = lang === "zh"
    ? "\u8be5 IMSI \u5df2\u5b58\u5728\u3002\u5df2\u963b\u6b62\u521b\u5efa\uff0c\u907f\u514d\u8986\u76d6\u5df2\u6709\u7b7e\u7ea6\u7528\u6237\u3002"
    : t("sub_imsi_exists_warning");
  const checkingImsiText = lang === "zh"
    ? "\u6b63\u5728\u68c0\u67e5\u8be5 IMSI \u662f\u5426\u5df2\u5b58\u5728..."
    : t("sub_imsi_checking");
  const imsiWarningStyle = {
    color: "var(--danger)",
    fontSize: "0.85rem",
    marginTop: "0.4rem",
    fontWeight: 650,
  };
  const tariffPlanOptions = tariffPlanList.length > 0
    ? tariffPlanList.filter((plan) => (plan.status || "active") === "active" || plan.plan_id === ocsPlanId)
    : (ocsPlanId ? [{ plan_id: ocsPlanId, name: ocsPlanId, status: ocsPlanStatus }] : []);

  return (
    <div style={{ paddingBottom: '2rem', display: "flex", flexDirection: "column" }}>
      <div className="dash-card animate-fade-in" id="sec-identity">
        <div className="dash-card-header">
          <Users size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sub_identity_tmpl")}</h3>
        </div>
        <div className="dash-card-body">
          <div className="quick-grid">
            <div>
              <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>IMSI</label>
              {imsi ? (
                <input type="text" className="form-input" value={imsi} readOnly style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--primary)", background: "var(--surface-hover)" }} />
              ) : (
                <>
                  <input
                    type="text"
                    className={`form-input hover-glass ${(inputImsi && !/^\d{15}$/.test(inputImsi)) || inputImsiExists ? 'border-danger error-shake' : ''}`}
                    style={{ fontFamily: "monospace", fontWeight: 650, borderColor: (inputImsi && !/^\d{15}$/.test(inputImsi)) || inputImsiExists ? "var(--danger)" : undefined }}
                    placeholder="460020000000001"
                    value={inputImsi}
                    onChange={e => setInputImsi(e.target.value.replace(/\D/g, ''))}
                    maxLength={15}
                    autoFocus
                  />
                  {inputImsi && !/^\d{15}$/.test(inputImsi) && (
                    <div style={imsiWarningStyle}>
                      {t("sub_err_imsi_15")}
                    </div>
                  )}
                  {inputImsiExists && (
                    <div style={imsiWarningStyle}>
                      {duplicateImsiWarning}
                    </div>
                  )}
                  {!inputImsiExists && isCheckingInputImsi && (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.82rem", marginTop: "0.4rem", fontWeight: 500 }}>
                      {checkingImsiText}
                    </div>
                  )}
                </>
              )}
            </div>
            <div>
            <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>MSISDN</label>
              <input
                type="text"
                className={`form-input ${msisdn && !/^\d+$/.test(msisdn) ? 'border-danger error-shake' : ''}`}
                value={msisdn}
                onChange={(e) => setMsisdn(e.target.value.replace(/\D/g, ""))}
                placeholder={t("sub_ph_msisdn")}
              />
            </div>
            <div>
              <label className="form-label">{t("profile_template")}</label>
              <select
                className="form-input"
                defaultValue=""
                onChange={(e) => { loadFromProfile(e.target.value); e.target.value = ''; }}
                disabled={profileList.length === 0}
              >
                <option value="" disabled>{profileList.length > 0 ? t("sub_load_profile") : t("sub_no_profiles")}</option>
                {profileList.map((p: any) => (
                  <option key={p.name} value={p.name}>{p.title || p.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="section-divider">{t("sub_advanced_config")}</div>

      {/* Security & Authentication Configure */}
      <div className="dash-card animate-fade-in" id="sec-security">
        <div className="dash-card-header">
          <Shield size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_security_auth")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_key_k")}</label>
            <input type="text" className="form-input" style={{ fontFamily: "monospace", fontSize: "1.05rem" }} value={auth4GData.k} onChange={(e) => setAuth4GData({...auth4GData, k: e.target.value})} placeholder={t("sub_ph_hex")} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_key_op")} ({usimType === "op" ? "OP" : "OPc"})</label>
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <select className="form-input" style={{ width: "120px", flexShrink: 0 }} value={usimType} onChange={(e) => setUsimType(e.target.value as "opc" | "op")}>
                <option value="opc">OPc</option>
                <option value="op">OP</option>
              </select>
              <input type="text" className="form-input" style={{ fontFamily: "monospace", fontSize: "1.05rem", flex: 1 }} value={auth4GData.opValue} onChange={(e) => setAuth4GData({...auth4GData, opValue: e.target.value})} placeholder={t("sub_ph_hex")} />
            </div>
          </div>
          <div>
            <label className="form-label">{t("sub_sqn")}</label>
            <input
              type="number"
              className="form-input"
              value={auth4GData.sqn ?? ""}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setAuth4GData({ ...auth4GData, sqn: e.target.value === "" ? 0 : parseInt(e.target.value, 10) })}
            />
          </div>
          <div>
            <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_amf")}</label>
            <input type="text" className="form-input" value={auth4GData.amf} onChange={(e) => setAuth4GData({...auth4GData, amf: e.target.value})} placeholder={t("sub_ph_amf")} />
          </div>
        </div>
      </div>

      {/* Global Network Configure */}
      <div className="dash-card animate-fade-in" id="sec-network" style={{ order: 4 }}>
        <div className="dash-card-header">
          <Signal size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_global_network")}</h3>
        </div>
        <div className="dash-card-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem" }}>
            <div>
              <label className="form-label" style={{ color: "var(--text-secondary)" }}><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_lbl_ambr_dl")}</label>
              <div className="input-composite">
                <input
                  type="number"
                  value={ueAmbr.downlink?.value ?? ""}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setUeAmbr({ ...ueAmbr, downlink: { ...ueAmbr.downlink, value: e.target.value === "" ? 0 : Number(e.target.value) } })}
                />
                <select value={ueAmbr.downlink?.unit || 1} onChange={(e) => setUeAmbr({...ueAmbr, downlink: { ...ueAmbr.downlink, unit: Number(e.target.value) }})}>
                  {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="form-label" style={{ color: "var(--text-secondary)" }}><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_lbl_ambr_ul")}</label>
              <div className="input-composite">
                <input
                  type="number"
                  value={ueAmbr.uplink?.value ?? ""}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setUeAmbr({ ...ueAmbr, uplink: { ...ueAmbr.uplink, value: e.target.value === "" ? 0 : Number(e.target.value) } })}
                />
                <select value={ueAmbr.uplink?.unit || 1} onChange={(e) => setUeAmbr({...ueAmbr, uplink: { ...ueAmbr.uplink, unit: Number(e.target.value) }})}>
                  {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Access Restrictions (3GPP TS 29.272 Bitmask) */}
      <div className="dash-card animate-fade-in" id="sec-access-restrictions" style={{ marginTop: "1.5rem", order: 5 }}>
        <div className="dash-card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Lock size={20} color="var(--primary)" />
            <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_access_restrict")}</h3>
          </div>
          <button
            type="button"
            className="btn-icon"
            onClick={() => setIsAccessRestrictionsExpanded((prev: boolean) => !prev)}
            title={isAccessRestrictionsExpanded ? t("collapse") : t("expand")}
            style={{ background: "transparent", border: "none", cursor: "pointer" }}
          >
            {isAccessRestrictionsExpanded ? <ChevronUp size={18} color="var(--text-muted)" /> : <ChevronDown size={18} color="var(--text-muted)" />}
          </button>
        </div>
        {isAccessRestrictionsExpanded && <div className="dash-card-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "1rem" }}>
            {[
              { val: 128, label: t("sub_acc_nr") },
              { val: 16, label: t("sub_acc_eutran") },
              { val: 1, label: t("sub_acc_utran") },
              { val: 2, label: t("sub_acc_geran") },
              { val: 32, label: t("sub_acc_non3gpp") },
              { val: 4, label: t("sub_acc_gan") },
              { val: 8, label: t("sub_acc_ihspa") },
              { val: 64, label: t("sub_acc_nbiot") }
            ].map(opt => {
               const isLegacySuspended = accessRestriction === 255;
               const isChecked = (accessRestriction & opt.val) !== 0 || isLegacySuspended;
               return (
                 <label key={opt.val} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem", border: "1px solid " + (isChecked ? "var(--primary)" : "var(--surface-border)"), borderRadius: "8px", background: isChecked ? "rgba(59, 130, 246, 0.05)" : "var(--surface)", cursor: "pointer", transition: "all 0.2s" }}>
                   <input
                     type="checkbox"
                     className="checkbox-custom"
                     checked={isChecked}
                     onChange={(e) => {
                       let next = accessRestriction;
                       if (e.target.checked) {
                         next = next | opt.val;
                       } else {
                         if (accessRestriction === 255) next = 255 ^ opt.val;
                         else next = next & ~opt.val;
                       }
                       setAccessRestriction(next);
                     }}
                   />
                   <span style={{ fontSize: "0.9rem", fontWeight: isChecked ? 600 : 500, color: isChecked ? "var(--primary)" : "var(--text-secondary)" }}>{opt.label}</span>
                 </label>
               );
            })}
          </div>

          <div style={{ marginTop: "1.5rem", display: "flex", gap: "1rem", borderTop: "1px solid var(--surface-border)", paddingTop: "1.5rem" }}>
             <button className="btn btn-outline" style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 1rem", fontSize: "0.85rem", color: "var(--success)", borderColor: "var(--success)", background: "transparent" }} onClick={() => setAccessRestriction(0)}>
               {t("sub_btn_clear_restrictions")}
             </button>
             <button className="btn btn-outline" style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 1rem", fontSize: "0.85rem", color: "var(--danger)", borderColor: "var(--danger)", background: "transparent" }} onClick={() => setAccessRestriction(255)}>
               {t("sub_btn_suspend_restrictions")}
             </button>
          </div>
        </div>}
      </div>

      {/* Billing Configuration (4-table) */}
      <div className="dash-card animate-fade-in" id="sec-rating" style={{ order: 3 }}>
        <div className="dash-card-header">
          <Gauge size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_billing_config")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.5rem" }}>
          <div>
            <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>PLMN</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--success)' }}>{t("sub_auto_linked")}</span>
            </label>
            <input type="text" className="form-input" value={ocsPlmn} readOnly style={{ background: "var(--surface-hover)", color: "var(--primary)", fontWeight: 600, border: '1px solid var(--surface-border)' }} placeholder="e.g. 45400" />
          </div>
          <div>
            <label className="form-label">{t("sub_traffic_total_quota")}</label>
            <div className="input-composite">
              <input
                type="number"
                min="0"
                step="any"
                value={totalTrafficInput.value}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setOcsTrafficTotalStr(composeByteInput(e.target.value, totalTrafficInput.unit))}
              />
              <select
                value={totalTrafficInput.unit}
                onChange={(e) => setOcsTrafficTotalStr(composeByteInput(totalTrafficInput.value, e.target.value))}
              >
                {BYTE_INPUT_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">{t("sub_traffic_balance")}</label>
            <div className="input-composite">
              <input
                type="number"
                min="0"
                step="any"
                value={balanceTrafficInput.value}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setOcsTrafficBalanceStr(composeByteInput(e.target.value, balanceTrafficInput.unit))}
              />
              <select
                value={balanceTrafficInput.unit}
                onChange={(e) => setOcsTrafficBalanceStr(composeByteInput(balanceTrafficInput.value, e.target.value))}
              >
                {BYTE_INPUT_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">{t("sub_360_tariff_plan")}</label>
            <select
              className="form-input"
              value={ocsPlanId}
              onChange={(e) => setOcsPlanId(e.target.value)}
              disabled={tariffPlanOptions.length === 0}
              style={{ fontFamily: "monospace" }}
            >
              {tariffPlanOptions.map((plan) => (
                <option key={plan.plan_id} value={plan.plan_id}>
                  {plan.name && plan.name !== plan.plan_id ? `${plan.name} (${plan.plan_id})` : plan.plan_id}{plan.status === "disabled" ? ` - ${t("users_disabled")}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label">{t("sub_360_plan_status")}</label>
            <input type="text" className="form-input" value={ocsPlanStatus} readOnly style={{ background: "var(--surface-hover)", fontFamily: "monospace" }} />
          </div>
          <RatingRuleLinkPanel
            planId={ocsPlanId}
            planStatus={ocsPlanStatus}
            ocsRules={ocsRules}
            ratingList={ratingList}
            t={t}
          />
          <div>
            <label className="form-label">{t("sub_360_voice_quota")}</label>
            <div className="input-composite">
              <input
                type="number"
                min="0"
                step="any"
                value={totalVoiceInput.value}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setOcsVoiceTotalStr(composeSecondsInput(e.target.value, totalVoiceInput.unit))}
              />
              <select
                value={totalVoiceInput.unit}
                onChange={(e) => setOcsVoiceTotalStr(composeSecondsInput(totalVoiceInput.value, e.target.value))}
              >
                {TIME_INPUT_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">{t("sub_360_voice_balance")}</label>
            <div className="input-composite">
              <input
                type="number"
                min="0"
                step="any"
                value={balanceVoiceInput.value}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setOcsVoiceBalanceStr(composeSecondsInput(e.target.value, balanceVoiceInput.unit))}
              />
              <select
                value={balanceVoiceInput.unit}
                onChange={(e) => setOcsVoiceBalanceStr(composeSecondsInput(balanceVoiceInput.value, e.target.value))}
              >
                {TIME_INPUT_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">{t("sub_360_sms_quota")}</label>
            <input
              type="number"
              className="form-input"
              min="0"
              step="1"
              value={ocsSmsTotalStr}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setOcsSmsTotalStr(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div>
            <label className="form-label">{t("sub_360_sms_balance")}</label>
            <input
              type="number"
              className="form-input"
              min="0"
              step="1"
              value={ocsSmsBalanceStr}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setOcsSmsBalanceStr(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="form-label">{t("sub_360_apn_rules")}</label>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {ocsRules.length > 0 ? ocsRules.map((rule: any) => (
                <div key={rule.rule_id || `${rule.apn}-${rule.rating_group_id}`} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: "1rem", padding: "0.75rem 1rem", border: "1px solid var(--surface-border)", borderRadius: "6px", background: "var(--surface-hover)", fontFamily: "monospace", fontSize: "0.9rem" }}>
                  <span>{rule.apn}</span>
                  <span>RG {rule.rating_group_id}</span>
                  <span>SI {rule.service_identifier}</span>
                  <span>{ratingTypeLabel(t, rule.charging_type)}</span>
                  <span>{ratingUnitLabel(t, rule.unit)}</span>
                </div>
              )) : <span style={{ color: "var(--text-muted)" }}>{t("sub_360_no_tariff_rules")}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Level 1: Slices Configure */}
      <div id="sec-slices" style={{ paddingTop: "1rem", order: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
          <h3 style={{ fontSize: "1.25rem", margin: 0, color: "var(--text-main)", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}><Server size={22}/> {t("sub_slices_core")}</h3>
          <button className="btn btn-primary" onClick={addSlice} style={{ padding: '0.5rem 1rem', display: "flex", alignItems: "center", gap: "0.4rem", borderRadius: "24px" }}>
            <Plus size={18}/> {t("sub_add_slice")}
          </button>
        </div>

        {Array.isArray(slices) && slices.length > 0 ? (
          slices.map((slice: any, sIdx: number) => (
            <ProfileSliceEditor
              key={sIdx}
              slice={slice}
              sliceIndex={sIdx}
              newlyAdded={newlyAddedSliceIndex === sIdx}
              onChange={(updated: any) => handleSliceChange(sIdx, updated)}
              onDelete={() => removeSlice(sIdx)}
              isExpanded={expandedSlices.includes(sIdx)}
              onToggleExpand={() => setExpandedSlices((prev: number[]) => prev.includes(sIdx) ? prev.filter(i => i !== sIdx) : [...prev, sIdx])}
            />
          ))
        ) : (
          <div style={{ textAlign: "center", padding: "4rem", color: "var(--text-muted)", backgroundColor: "var(--surface)", border: "1px dashed var(--surface-border)", borderRadius: "8px" }}>
            {t("sub_no_slices_start")} <strong>{t("sub_add_slice")}</strong> {t("sub_to_start")}
          </div>
        )}
      </div>
    </div>
  );
}
