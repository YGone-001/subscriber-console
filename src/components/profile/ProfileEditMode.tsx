import { Pencil, Shield, Signal, Lock, ChevronDown, ChevronUp, Gauge, Server, Plus } from "lucide-react";
import ProfileSliceEditor from "./ProfileSliceEditor";
import { parseBytes, formatBytes, formatBytesAligned } from "@/lib/unitParser";
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
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.5rem" }}>
          {/* PLMN + Traffic Balance (OCS:TRAFFIC) */}
          <div>
            <label className="form-label">{t("prof_plmn_tpl")}</label>
            <input type="text" className="form-input" value={ocsDefaults.plmn} onChange={e => setOcsDefaults({...ocsDefaults, plmn: e.target.value})} placeholder="e.g. 45400" />
          </div>
          <div>
            <label className="form-label">{t("prof_quota_tpl")}</label>
            <input type="text" className="form-input" value={ocsDefaults.trafficTotal}
               onChange={e => setOcsDefaults({...ocsDefaults, trafficTotal: e.target.value})}
               onBlur={() => {
                 const [tStr, bStr] = formatBytesAligned(parseBytes(ocsDefaults.trafficTotal), parseBytes(ocsDefaults.trafficBalance));
                 setOcsDefaults({...ocsDefaults, trafficTotal: tStr, trafficBalance: bStr});
               }}
               placeholder="e.g. 10G" />
          </div>
          <div>
            <label className="form-label">{t("prof_balance_tpl")}</label>
            <input type="text" className="form-input" value={ocsDefaults.trafficBalance}
               onChange={e => setOcsDefaults({...ocsDefaults, trafficBalance: e.target.value})}
               onBlur={() => {
                 const [tStr, bStr] = formatBytesAligned(parseBytes(ocsDefaults.trafficTotal), parseBytes(ocsDefaults.trafficBalance));
                 setOcsDefaults({...ocsDefaults, trafficTotal: tStr, trafficBalance: bStr});
               }}
               placeholder="e.g. 10G" />
          </div>
          <div>
            <label className="form-label">{t("prof_currency_tpl")}</label>
            <select className="form-input" value={ocsDefaults.currency} onChange={e => setOcsDefaults({...ocsDefaults, currency: e.target.value})}>
              {["USD","EUR","GBP","CNY","HKD","JPY","KRW","SGD"].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {/* Withhold Params (OCS:IMSI) */}
          <div>
            <label className="form-label">{t("prof_withhold_limit")}</label>
            <input type="text" className="form-input" value={ocsDefaults.withhold} onChange={e => {
              const val = e.target.value;
              const bytes = parseBytes(val);
              setOcsDefaults({
                ...ocsDefaults,
                withhold: val,
                withholdingResidue: bytes > 0 ? formatBytes(Math.floor(bytes * 0.8)) : ocsDefaults.withholdingResidue
              });
            }} placeholder="e.g. 100MB" />
          </div>
          <div>
            <label className="form-label">{t("prof_withhold_residue")}</label>
            <input type="text" className="form-input" value={ocsDefaults.withholdingResidue} onChange={e => setOcsDefaults({...ocsDefaults, withholdingResidue: e.target.value})} placeholder="e.g. 80MB" />
          </div>
          <div>
            <label className="form-label">{t("prof_withhold_interval")}</label>
            <input type="text" className="form-input" value={ocsDefaults.withholdingTime} onChange={e => setOcsDefaults({...ocsDefaults, withholdingTime: e.target.value})} placeholder="e.g. 60m or 1h" />
          </div>
          {/* Account Balance (OCS:ACCOUNT) */}
          <div>
            <label className="form-label">{t("prof_starter_balance")}</label>
            <input type="text" className="form-input" value={ocsDefaults.balance} onChange={e => setOcsDefaults({...ocsDefaults, balance: e.target.value})} placeholder="e.g. 10000" />
          </div>
          {/* Rating Group Selector (OCS:IMSI_SET) */}
          <div style={{ gridColumn: "span 2" }}>
            <label className="form-label">{t("prof_rating_ref")}</label>
            <select className="form-input" value={ocsDefaults.ratingGroupId} onChange={e => setOcsDefaults({...ocsDefaults, ratingGroupId: e.target.value})}>
              <option value="">{t("prof_none_skip")}</option>
              {ratingList.map((r: any) => (
                <option key={r.rating_group_id} value={r.rating_group_id}>#{r.rating_group_id} - {r.currency} {r.rates} ({r.rates_type === 1 ? t("rating_type_time") : r.rates_type === 2 ? t("rating_type_vol") : r.rates_type === 3 ? t("rating_type_event") : t("rating_type_flat")})</option>
              ))}
            </select>
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
