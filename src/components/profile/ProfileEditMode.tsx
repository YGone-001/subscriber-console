import { Pencil, Shield, Signal, Lock, ChevronDown, ChevronUp, Gauge, Server, Plus } from "lucide-react";
import ProfileSliceEditor from "./ProfileSliceEditor";
import { BYTE_INPUT_UNITS, composeByteInput, splitByteInput } from "@/lib/unitParser";
import { AMBR_UNITS } from "../subscriber/utils";

export default function ProfileEditMode({ t, profileName, state, actions }: any) {
  const {
    inputName, profileTitle, authData, usimType, ueAmbr, isAccessRestrictionsExpanded, accessRestriction,
    ocsDefaults, ratingList, slices, newlyAddedSliceIndex
  } = state;

  const {
    setInputName, setProfileTitle, setAuthData, setUsimType, setUeAmbr, setIsAccessRestrictionsExpanded, setAccessRestriction,
    setOcsDefaults, addSlice, handleSliceChange, removeSlice
  } = actions;
  const totalTrafficInput = splitByteInput(ocsDefaults.trafficTotal);
  const balanceTrafficInput = splitByteInput(ocsDefaults.trafficBalance, totalTrafficInput.unit);

  return (
    <div style={{ paddingBottom: '2rem' }}>
      {/* Profile Title */}
      <div className="dash-card animate-fade-in" id="psec-info">
        <div className="dash-card-header">
          <Pencil size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("prof_sec_info")}</h3>
        </div>
        <div className="dash-card-body">
          <div className="quick-grid">
            {!profileName && (
              <div>
                <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("prof_key")}</label>
                <input type="text" className="form-input" value={inputName} onChange={e => setInputName(e.target.value)} placeholder={t("prof_key_ph")} autoFocus />
              </div>
            )}
            <div>
              <label className="form-label">{t("prof_title")}</label>
              <input type="text" className="form-input" value={profileTitle} onChange={(e) => setProfileTitle(e.target.value)} placeholder={t("prof_title_ph")} />
            </div>
          </div>
        </div>
      </div>

      {/* Security Template */}
      <div className="dash-card animate-fade-in" id="psec-security">
        <div className="dash-card-header">
          <Shield size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_security_auth")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_key_k")}</label>
            <input type="text" className="form-input" style={{ fontFamily: "monospace", fontSize: "1.05rem" }} value={authData.k} onChange={(e) => setAuthData({...authData, k: e.target.value})} placeholder={t("sub_ph_hex")} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_key_op")} ({usimType === "op" ? "OP" : "OPc"})</label>
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <select className="form-input" style={{ width: "120px", flexShrink: 0 }} value={usimType} onChange={(e) => setUsimType(e.target.value as "opc" | "op")}>
                <option value="opc">OPc</option>
                <option value="op">OP</option>
              </select>
              <input type="text" className="form-input" style={{ fontFamily: "monospace", fontSize: "1.05rem", flex: 1 }} value={authData.opValue} onChange={(e) => setAuthData({...authData, opValue: e.target.value})} placeholder={t("sub_ph_hex")} />
            </div>
          </div>
          <div>
            <label className="form-label"><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_key_amf")}</label>
            <input type="text" className="form-input" value={authData.amf} onChange={(e) => setAuthData({...authData, amf: e.target.value})} placeholder={t("sub_ph_amf")} />
          </div>
        </div>
      </div>

      {/* Edit Mode: Billing Predefined Settings */}
      <div className="dash-card animate-fade-in" id="psec-ocs-edit" style={{ marginTop: "1rem" }}>
        <div className="dash-card-header">
          <Gauge size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_billing_config")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
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
            <label className="form-label">SMS Quota Template</label>
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
            <label className="form-label">SMS Balance Template</label>
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
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="form-label">Tariff Plan Rules</label>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {ratingList.length > 0 ? ratingList.map((rule: any) => (
                <div key={rule.rule_id || `${rule.apn}-${rule.rating_group_id}`} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: "1rem", padding: "0.75rem 1rem", border: "1px solid var(--surface-border)", borderRadius: "6px", background: "var(--surface-hover)", fontFamily: "monospace", fontSize: "0.9rem" }}>
                  <span>{rule.apn}</span>
                  <span>RG {rule.rating_group_id}</span>
                  <span>SI {rule.service_identifier}</span>
                  <span>{rule.charging_type}</span>
                  <span>{rule.unit}</span>
                </div>
              )) : <span style={{ color: "var(--text-muted)" }}>No tariff rules</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Global Network Limit */}
      <div className="dash-card animate-fade-in" id="psec-network">
        <div className="dash-card-header">
          <Signal size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_global_network")}</h3>
        </div>
        <div className="dash-card-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem" }}>
            <div>
              <label className="form-label" style={{ color: "var(--text-secondary)" }}><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_lbl_ambr_dl")}</label>
              <div className="input-composite">
                <input type="number" value={ueAmbr.downlink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => setUeAmbr({...ueAmbr, downlink: { ...ueAmbr.downlink, value: e.target.value === "" ? 0 : Number(e.target.value) }})} />
                <select value={ueAmbr.downlink?.unit || 1} onChange={(e) => setUeAmbr({...ueAmbr, downlink: { ...ueAmbr.downlink, unit: Number(e.target.value) }})}>
                  {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="form-label" style={{ color: "var(--text-secondary)" }}><span style={{ color: "var(--danger)", marginRight: "0.25rem" }}>*</span>{t("sub_lbl_ambr_ul")}</label>
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
      <div className="dash-card animate-fade-in" id="psec-access-restrictions" style={{ marginTop: "1.5rem" }}>
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
        {isAccessRestrictionsExpanded && (
          <div className="dash-card-body">
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
          </div>
        )}
      </div>

      {/* Level 1: Slices */}
      <div id="psec-slices" style={{ paddingTop: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
          <h3 style={{ fontSize: "1.25rem", margin: 0, color: "var(--text-main)", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}><Server size={22}/> {t("sub_slices_core")}</h3>
          <button className="btn btn-primary" onClick={addSlice} style={{ padding: '0.5rem 1rem', display: "flex", alignItems: "center", gap: "0.4rem", borderRadius: "24px" }}>
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
          <div style={{ textAlign: "center", padding: "4rem", color: "var(--text-muted)", backgroundColor: "var(--surface-hover)", border: "1px dashed var(--surface-border)", borderRadius: "8px" }}>
            {t("prof_no_slices_start")} <strong>{t("sub_add_slice")}</strong> {t("sub_to_start")}
          </div>
        )}
      </div>
    </div>
  );
}
