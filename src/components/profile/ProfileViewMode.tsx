import { Shield, Signal, Gauge, Server, Lock, ChevronDown, ChevronUp } from "lucide-react";
import { AMBR_UNITS, getAmbrString, typeLabel } from "../subscriber/utils";

export default function ProfileViewMode({ t, authData, usimType, ocsDefaults, ratingList, ueAmbr, isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded, accessRestriction, slices }: any) {
  return (
    <div className="animate-fade-in" style={{ paddingBottom: '2rem' }}>
      {/* Security Template Card */}
      <div className="dash-card" id="psec-security">
        <div className="dash-card-header">
          <Shield size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_security_auth")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "2rem" }}>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>K</div>
            <div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{authData.k || "N/A"}</div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{usimType === "op" ? "OP" : "OPc"}</div>
            <div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{authData.opValue || "N/A"}</div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>AMF</div>
            <div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{authData.amf || "N/A"}</div>
          </div>
        </div>
      </div>

      {/* View Mode: Billing Predefined Settings */}
      <div className="dash-card" id="psec-ocs-view" style={{ marginTop: "1.5rem", marginBottom: "1.5rem" }}>
        <div className="dash-card-header">
          <Gauge size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_billing_config")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem" }}>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{t("prof_lbl_quota")}</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsDefaults.trafficTotal}</div></div>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{t("prof_lbl_balance")}</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsDefaults.trafficBalance}</div></div>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>SMS Quota</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsDefaults.smsTotal || "0"}</div></div>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>SMS Balance</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsDefaults.smsBalance || "0"}</div></div>
           <div style={{ gridColumn: "1 / -1" }}>
             <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.75rem" }}>Tariff Plan Rules</div>
             <div style={{ display: "grid", gap: "0.5rem" }}>
               {ratingList.length > 0 ? ratingList.map((rule: any) => (
                 <div key={rule.rule_id || `${rule.apn}-${rule.rating_group_id}`} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: "1rem", padding: "0.75rem 1rem", border: "1px solid var(--surface-border)", borderRadius: "6px", fontFamily: "monospace", fontSize: "0.9rem" }}>
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

      {/* Network AMBR Card */}
      <div className="dash-card" id="psec-network">
        <div className="dash-card-header">
          <Signal size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_global_network")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "flex", gap: "3rem" }}>
          <div style={{ flex: 1, padding: "1rem", border: "1px solid var(--surface-border)", borderRadius: "8px" }}>
            <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", textTransform: 'uppercase', fontWeight: 600 }}>{t("sub_dl")}</div>
            <div style={{ color: "var(--text-main)", fontSize: "1.5rem", fontWeight: 600 }}>
              {ueAmbr.downlink?.value || 0} <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}>{AMBR_UNITS.find(u => u.val === (ueAmbr.downlink?.unit || 1))?.label || ''}</span>
            </div>
          </div>
          <div style={{ flex: 1, padding: "1rem", border: "1px solid var(--surface-border)", borderRadius: "8px" }}>
            <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", textTransform: 'uppercase', fontWeight: 600 }}>{t("sub_ul")}</div>
            <div style={{ color: "var(--text-main)", fontSize: "1.5rem", fontWeight: 600 }}>
              {ueAmbr.uplink?.value || 0} <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}>{AMBR_UNITS.find(u => u.val === (ueAmbr.uplink?.unit || 1))?.label || ''}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Access Restrictions */}
      <div className="dash-card" id="psec-access-restrictions" style={{ marginTop: "1.5rem" }}>
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
            <div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{accessRestriction}</div>
          </div>
        )}
      </div>

      {/* Slices Overview */}
      <div id="psec-slices" style={{ paddingTop: "1rem" }}>
        <h3 style={{ fontSize: "1.25rem", marginBottom: "1.5rem", color: "var(--text-main)", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}><Server size={22}/> {t("sub_slices_core")}</h3>
        {Array.isArray(slices) && slices.length > 0 ? slices.map((slice: any, sIdx: number) => (
          <div key={sIdx} className="slice-strip-card">
            <div style={{ padding: "1.5rem 2rem", borderBottom: "1px solid var(--surface-border)", display: "flex", alignItems: "center", gap: "1.5rem" }}>
              <span style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--primary)" }}>{t("slice_idx", { idx: sIdx + 1 })}</span>
              <div style={{ display: "flex", gap: "1rem", background: "var(--surface-hover)", padding: "0.5rem 1rem", borderRadius: "6px" }}>
                <span style={{ fontWeight: 600 }}>SST: {slice.sst}</span>
                {slice.sd && slice.sd !== "000000" && <span style={{ color: "var(--text-secondary)" }}>SD: {slice.sd}</span>}
              </div>
              {slice.default_indicator && <span className="pill pill-enabled">{t("sub_default_nssai")}</span>}
            </div>
            <div style={{ padding: "1rem" }}>
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
                  {slice.session_list?.length > 0 ? slice.session_list.map((sess: any, sessIdx: number) => (
                    <tr key={sessIdx} style={{ borderBottom: "1px solid transparent" }}>
                      <td style={{ padding: "1rem", fontWeight: 600, color: "var(--text-main)" }}>{sess.name}</td>
                      <td style={{ padding: "1rem", color: "var(--text-secondary)" }}>{typeLabel(sess.type)}</td>
                      <td style={{ padding: "1rem", color: "var(--text-secondary)" }}>{sess.qos?._5qi || "-"}</td>
                      <td style={{ padding: "1rem", color: "var(--text-secondary)" }}>{sess.qos?.arp?.priorityLevel || "-"}</td>
                      <td style={{ padding: "1rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{getAmbrString(sess.ambr)}</td>
                      <td style={{ padding: "1rem" }}>
                        {sess.pcc_rule?.length > 0 ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                              {sess.pcc_rule.map((rule: any, pccIdx: number) => (
                                <div key={pccIdx} style={{ background: 'var(--surface-hover)', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.85em', border: '1px solid var(--surface-border)' }}>
                                  <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: '0.2rem' }}>{t("slice_rule_idx", { idx: pccIdx + 1 })}</div>
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                                    <div><span style={{ color: 'var(--text-muted)' }}>5QI:</span> {rule.qos?.index || 1}</div>
                                    <div><span style={{ color: 'var(--text-muted)' }}>ARP:</span> {rule.qos?.arp?.priority_level || 2}</div>
                                    <div style={{ gridColumn: 'span 2' }}>
                                      <span style={{ color: 'var(--text-muted)' }}>MBR:</span> {rule.qos?.mbr?.downlink?.value || 0} {AMBR_UNITS.find(u => u.val === (rule.qos?.mbr?.downlink?.unit || 1))?.label} (DL) / {rule.qos?.mbr?.uplink?.value || 0} {AMBR_UNITS.find(u => u.val === (rule.qos?.mbr?.uplink?.unit || 1))?.label} (UL)
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                        ) : <span style={{ color: 'var(--text-muted)' }}>{t("none")}</span>}
                      </td>
                    </tr>
                  )) : (
                    <tr><td colSpan={6} style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t("prof_no_sessions")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )) : (
          <div style={{ textAlign: "center", color: "var(--text-muted)", padding: "3rem", border: "1px dashed var(--surface-border)", borderRadius: "6px" }}>{t("prof_no_slices")}</div>
        )}
      </div>
    </div>
  );
}
