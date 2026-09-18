import { Pencil, Shield, Signal, Lock, ChevronDown, ChevronUp, Gauge, Server, Plus } from "lucide-react";
import ProfileSliceEditor from "./ProfileSliceEditor";
import { BYTE_INPUT_UNITS, composeByteInput, splitByteInput } from "@/lib/unitParser";
import { AMBR_UNITS } from "../subscriber/utils";
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

export default function ProfileEditMode({ t, profileName, state, actions }: any) {
  const {
    profileTitle, authData, usimType, ueAmbr, isAccessRestrictionsExpanded, accessRestriction,
    ocsDefaults, tariffPlanList, ratingList, slices, newlyAddedSliceIndex
  } = state;

  const {
    setInputName, setProfileTitle, setAuthData, setUsimType, setUeAmbr, setIsAccessRestrictionsExpanded, setAccessRestriction,
    setOcsDefaults, addSlice, handleSliceChange, removeSlice
  } = actions;
  const totalTrafficInput = splitByteInput(ocsDefaults.trafficTotal);
  const balanceTrafficInput = splitByteInput(ocsDefaults.trafficBalance, totalTrafficInput.unit);
  const tariffPlanOptions = Array.isArray(tariffPlanList) && tariffPlanList.length > 0
    ? tariffPlanList.filter((plan: any) => (plan.status || "active") === "active" || plan.plan_id === ocsDefaults.planId)
    : [{ plan_id: ocsDefaults.planId || "plan_default_10gb", name: ocsDefaults.planId || "plan_default_10gb", status: "active" }];
  const handleTitleChange = (value: string) => {
    setProfileTitle(value);
    if (!profileName) setInputName(value);
  };

  return (
    <div className="profile-container">
      {/* Profile Title */}
      <div className="dash-card animate-fade-in" id="psec-info">
        <div className="dash-card-header">
          <Pencil size={20} color="var(--primary)" />
          <h3 className="card-title">{t("prof_sec_info")}</h3>
        </div>
        <div className="dash-card-body">
          <div className="quick-grid">
            <div>
              <label className="form-label">{!profileName && <span className="form-asterisk">*</span>}{t("prof_title")}</label>
              <input type="text" className="form-input" value={profileTitle} onChange={(e) => handleTitleChange(e.target.value)} placeholder={t("prof_title_ph")} />
            </div>
          </div>
        </div>
      </div>

      {/* Security Template */}
      <div className="dash-card animate-fade-in" id="psec-security">
        <div className="dash-card-header">
          <Shield size={20} color="var(--primary)" />
          <h3 className="card-title">{t("sec_security_auth")}</h3>
        </div>
        <div className="dash-card-body grid-2-col">
          <div className="col-span-all">
            <label className="form-label"><span className="form-asterisk">*</span>{t("sub_key_k")}</label>
            <input type="text" className="form-input input-mono-large" value={authData.k} onChange={(e) => setAuthData({...authData, k: e.target.value})} placeholder={t("sub_ph_hex")} />
          </div>
          <div className="col-span-all">
            <label className="form-label"><span className="form-asterisk">*</span>{t("sub_key_op")} ({usimType === "op" ? "OP" : "OPc"})</label>
            <div className="op-type-container">
              <select className="form-input op-type-select" value={usimType} onChange={(e) => setUsimType(e.target.value as "opc" | "op")}>
                <option value="opc">OPc</option>
                <option value="op">OP</option>
              </select>
              <input type="text" className="form-input input-mono-large op-type-input" value={authData.opValue} onChange={(e) => setAuthData({...authData, opValue: e.target.value})} placeholder={t("sub_ph_hex")} />
            </div>
          </div>
          <div>
            <label className="form-label"><span className="form-asterisk">*</span>{t("sub_key_amf")}</label>
            <input type="text" className="form-input" value={authData.amf} onChange={(e) => setAuthData({...authData, amf: e.target.value})} placeholder={t("sub_ph_amf")} />
          </div>
        </div>
      </div>

      {/* Edit Mode: Billing Predefined Settings */}
      <div className="dash-card animate-fade-in card-margin-top-sm" id="psec-ocs-edit">
        <div className="dash-card-header">
          <Gauge size={20} color="var(--primary)" />
          <h3 className="card-title">{t("sec_billing_config")}</h3>
        </div>
        <div className="dash-card-body grid-2-col-sm">
          <div className="col-span-all">
            <label className="form-label">{t("sub_360_tariff_plan")}</label>
            <select
              className="form-input input-mono"
              value={ocsDefaults.planId || "plan_default_10gb"}
              onChange={(e) => setOcsDefaults({ ...ocsDefaults, planId: e.target.value })}
            >
              {tariffPlanOptions.map((plan: any) => (
                <option key={plan.plan_id} value={plan.plan_id}>
                  {plan.name && plan.name !== plan.plan_id ? `${plan.name} (${plan.plan_id})` : plan.plan_id}{plan.status === "disabled" ? ` - ${t("users_disabled")}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label">{t("prof_quota_tpl")}</label>
            <div className="input-composite">
              <input
                type="number"
                min="0"
                step="any"
                value={totalTrafficInput.value}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setOcsDefaults({ ...ocsDefaults, trafficTotal: composeByteInput(e.target.value, totalTrafficInput.unit) })}
              />
              <select
                value={totalTrafficInput.unit}
                onChange={(e) => setOcsDefaults({ ...ocsDefaults, trafficTotal: composeByteInput(totalTrafficInput.value, e.target.value) })}
              >
                {BYTE_INPUT_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">{t("prof_balance_tpl")}</label>
            <div className="input-composite">
              <input
                type="number"
                min="0"
                step="any"
                value={balanceTrafficInput.value}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setOcsDefaults({ ...ocsDefaults, trafficBalance: composeByteInput(e.target.value, balanceTrafficInput.unit) })}
              />
              <select
                value={balanceTrafficInput.unit}
                onChange={(e) => setOcsDefaults({ ...ocsDefaults, trafficBalance: composeByteInput(balanceTrafficInput.value, e.target.value) })}
              >
                {BYTE_INPUT_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">{t("prof_sms_quota_tpl")}</label>
            <input
              type="number"
              className="form-input"
              min="0"
              step="1"
              value={ocsDefaults.smsTotal || "0"}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setOcsDefaults({ ...ocsDefaults, smsTotal: e.target.value.replace(/\D/g, "") })}
            />
          </div>
          <div>
            <label className="form-label">{t("prof_sms_balance_tpl")}</label>
            <input
              type="number"
              className="form-input"
              min="0"
              step="1"
              value={ocsDefaults.smsBalance || "0"}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setOcsDefaults({ ...ocsDefaults, smsBalance: e.target.value.replace(/\D/g, "") })}
            />
          </div>
          <div className="col-span-all">
            <label className="form-label">{t("prof_tariff_rules")}</label>
            <div className="grid-gap-small">
              {ratingList.length > 0 ? ratingList.map((rule: any) => (
                <div key={rule.rule_id || `${rule.apn}-${rule.rating_group_id}`} className="tariff-rule-row bg-hover">
                  <span>{rule.apn}</span>
                  <span>RG {rule.rating_group_id}</span>
                  <span>SI {rule.service_identifier}</span>
                  <span>{ratingTypeLabel(t, rule.charging_type)}</span>
                  <span>{ratingUnitLabel(t, rule.unit)}</span>
                </div>
              )) : <span className="text-muted">{t("prof_no_tariff_rules")}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Global Network Limit */}
      <div className="dash-card animate-fade-in" id="psec-network">
        <div className="dash-card-header">
          <Signal size={20} color="var(--primary)" />
          <h3 className="card-title">{t("sec_global_network")}</h3>
        </div>
        <div className="dash-card-body">
          <div className="grid-2-col">
            <div>
              <label className="form-label label-secondary"><span className="form-asterisk">*</span>{t("sub_lbl_ambr_dl")}</label>
              <div className="input-composite">
                <input type="number" value={ueAmbr.downlink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => setUeAmbr({...ueAmbr, downlink: { ...ueAmbr.downlink, value: e.target.value === "" ? 0 : Number(e.target.value) }})} />
                <select value={ueAmbr.downlink?.unit || 1} onChange={(e) => setUeAmbr({...ueAmbr, downlink: { ...ueAmbr.downlink, unit: Number(e.target.value) }})}>
                  {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="form-label label-secondary"><span className="form-asterisk">*</span>{t("sub_lbl_ambr_ul")}</label>
              <div className="input-composite">
                <input type="number" value={ueAmbr.uplink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => setUeAmbr({...ueAmbr, uplink: { ...ueAmbr.uplink, value: e.target.value === "" ? 0 : Number(e.target.value) }})} />
                <select value={ueAmbr.uplink?.unit || 1} onChange={(e) => setUeAmbr({...ueAmbr, uplink: { ...ueAmbr.uplink, unit: Number(e.target.value) }})}>
                  {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Access Restrictions (3GPP TS 29.272 Bitmask) */}
      <div className="dash-card animate-fade-in card-margin-top" id="psec-access-restrictions">
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
            <div className="access-restriction-grid">
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
                  <label key={opt.val} className={`access-restriction-label ${isChecked ? "checked" : "unchecked"}`}>
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
                    <span className={`access-restriction-text ${isChecked ? "checked" : "unchecked"}`}>{opt.label}</span>
                  </label>
                );
              })}
            </div>
            <div className="access-restriction-actions">
              <button className="btn btn-outline btn-access-clear" onClick={() => setAccessRestriction(0)}>
                {t("sub_btn_clear_restrictions")}
              </button>
              <button className="btn btn-outline btn-access-suspend" onClick={() => setAccessRestriction(255)}>
                {t("sub_btn_suspend_restrictions")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Level 1: Slices */}
      <div id="psec-slices" className="pt-1">
        <div className="flex-between-center section-title-margin">
          <h3 className="section-title"><Server size={22}/> {t("sub_slices_core")}</h3>
          <button className="btn btn-primary btn-add-slice" onClick={addSlice}>
            <Plus size={18}/> {t("sub_add_slice")}
          </button>
        </div>

        {slices.length > 0 ? slices.map((slice: any, sIdx: number) => (
          <ProfileSliceEditor
            key={sIdx}
            slice={slice}
            sliceIndex={sIdx}
            newlyAdded={newlyAddedSliceIndex === sIdx}
            onChange={(updated: any) => handleSliceChange(sIdx, updated)}
            onDelete={() => removeSlice(sIdx)}
          />
        )) : (
          <div className="empty-slices-placeholder">
            {t("prof_no_slices_start")} <strong>{t("sub_add_slice")}</strong> {t("sub_to_start")}
          </div>
        )}
      </div>
    </div>
  );
}
