import { Shield, Signal, Wifi, Gauge, Server, ChevronDown, ChevronUp } from "lucide-react";
import { Pill, MaskedValue, AMBR_UNITS, getAmbrString, typeLabel } from "./utils";
import type { Ambr, Auth4GData, Rating, Slice } from "@/types/subscriber";

interface SubscriberViewModeProps {
  t: any;
  auth4GData: Auth4GData;
  usimType: "opc" | "op";
  ueAmbr: Ambr;
  ocsTrafficTotalStr: string;
  ocsTrafficBalanceStr: string;
  ocsPlmn: string;
  ocsCurrency: string;
  ocsBalance: string;
  ocsWithholdStr: string;
  ocsWithholdingResidueStr: string;
  ocsWithholdingTimeStr: string;
  selectedRatingGroupId: string;
  ratingList: Rating[];
  slices: Slice[];
  expandedSlices: number[];
  setExpandedSlices: React.Dispatch<React.SetStateAction<number[]>>;
}

export default function SubscriberViewMode({
  t,
  auth4GData,
  usimType,
  ueAmbr,
  ocsTrafficTotalStr,
  ocsTrafficBalanceStr,
  ocsPlmn,
  ocsCurrency,
  ocsBalance,
  ocsWithholdStr,
  ocsWithholdingResidueStr,
  ocsWithholdingTimeStr,
  selectedRatingGroupId,
  ratingList,
  slices,
  expandedSlices,
  setExpandedSlices
}: SubscriberViewModeProps) {
  return (
    <div className="animate-fade-in" style={{ paddingBottom: '2rem' }}>

      {/* Security & Authentication Card */}
      <div className="dash-card" id="sec-security">
        <div className="dash-card-header">
          <Shield size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_security_auth")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ color: "var(--text-muted)", fontSize: "0.9rem", minWidth: "40px" }}>K</span>
            <MaskedValue label={t("sub_key_k")} value={auth4GData.k} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ color: "var(--text-muted)", fontSize: "0.9rem", minWidth: "40px" }}>{usimType === "op" ? "OP" : "OPc"}</span>
            <MaskedValue label={`${t("sub_key_op")} (${usimType.toUpperCase()})`} value={auth4GData.opValue} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ color: "var(--text-muted)", fontSize: "0.9rem", minWidth: "40px" }}>AMF</span>
            <span style={{ color: "var(--text-main)", fontSize: "1.05rem", fontFamily: "monospace" }}>{auth4GData.amf || "N/A"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span style={{ color: "var(--text-muted)", fontSize: "0.9rem", minWidth: "40px" }}>SQN</span>
            <span style={{ color: "var(--text-main)", fontSize: "1.05rem", fontFamily: "monospace" }}>{auth4GData.sqn || 0}</span>
          </div>
        </div>
      </div>

      {/* Network Configuration Card */}
      <div className="dash-card" id="sec-network">
        <div className="dash-card-header">
          <Signal size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sub_network_config")}</h3>
        </div>
        <div className="dash-card-body">
          <div style={{ display: "flex", gap: "3rem" }}>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "1.5rem", borderRadius: "8px", flex: 1, border: "1px solid var(--surface-border)" }}>
              <Wifi size={28} color="var(--primary)" />
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "0.25rem", fontWeight: 600, textTransform: 'uppercase' }}>{t("sub_lbl_ambr_dl")}</div>
                <div style={{ color: "var(--text-main)", fontSize: "1.5rem", fontWeight: 600 }}>
                  {ueAmbr.downlink?.value || 0} <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}>{AMBR_UNITS.find(u => u.val === (ueAmbr.downlink?.unit || 1))?.label || ''}</span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "1rem", alignItems: "center", padding: "1.5rem", borderRadius: "8px", flex: 1, border: "1px solid var(--surface-border)" }}>
              <Wifi size={28} color="var(--primary)" style={{ transform: "rotate(180deg)" }} />
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "0.25rem", fontWeight: 600, textTransform: 'uppercase' }}>{t("sub_lbl_ambr_ul")}</div>
                <div style={{ color: "var(--text-main)", fontSize: "1.5rem", fontWeight: 600 }}>
                  {ueAmbr.uplink?.value || 0} <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}>{AMBR_UNITS.find(u => u.val === (ueAmbr.uplink?.unit || 1))?.label || ''}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Billing Configuration View */}
      <div className="dash-card" id="sec-ocs-view" style={{ marginTop: "1.5rem" }}>
        <div className="dash-card-header">
          <Gauge size={20} color="var(--primary)" />
          <h3 style={{ fontSize: "1.1rem", margin: 0, color: "var(--text-main)", fontWeight: 600 }}>{t("sec_billing_config")}</h3>
        </div>
        <div className="dash-card-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "2rem" }}>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{t("sub_traffic_quota")}</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsTrafficTotalStr}</div></div>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{t("sub_traffic_balance")}</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsTrafficBalanceStr}</div></div>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>PLMN</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsPlmn}</div></div>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{t("sub_currency_balance")}</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsCurrency} {ocsBalance}</div></div>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{t("sub_withhold_time_label")}</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsWithholdStr} (every {ocsWithholdingTimeStr})</div></div>
           <div><div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{t("sub_withhold_residue")}</div><div style={{ fontFamily: "monospace", color: "var(--text-main)", fontSize: "1rem" }}>{ocsWithholdingResidueStr}</div></div>
           {(() => {
              const r = ratingList.find(x => String(x.rating_group_id) === String(selectedRatingGroupId));
              return (
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{t("sub_rating_group_policy")}</div>
                  <div style={{ fontFamily: "monospace", fontSize: "1rem", color: selectedRatingGroupId ? "var(--primary)" : "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {selectedRatingGroupId && r
                      ? `#${r.rating_group_id} - ${r.currency} ${r.rates} (${r.rates_type === 1 ? 'Time' : r.rates_type === 2 ? 'Vol' : r.rates_type === 3 ? 'Event' : 'Flat'})`
                      : (selectedRatingGroupId ? `#${selectedRatingGroupId}` : 'None Assigned')}
                  </div>
                </div>
              );
           })()}
        </div>
      </div>

      {/* Level 1: Slices Configuration */}
      <div id="sec-slices" style={{ paddingTop: "1rem" }}>
        <h3 style={{ fontSize: "1.25rem", marginBottom: "1.5rem", color: "var(--text-main)", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}><Server size={22}/> Slices Architecture</h3>
        {Array.isArray(slices) && slices.length > 0 ? slices.map((slice, sIdx) => {
          return (
            <div key={sIdx} className="slice-strip-card" id={`slice-card-${sIdx}`}>
              <div
                className="slice-card-header"
                onClick={() => setExpandedSlices(prev => prev.includes(sIdx) ? prev.filter(i => i !== sIdx) : [...prev, sIdx])}
                style={{ padding: "1.5rem 2rem", borderBottom: expandedSlices.includes(sIdx) ? "1px solid var(--surface-border)" : "none", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "1.5rem" }}>
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
                {/* Level 2: Session List */}
                <div style={{ minHeight: "120px", padding: "1rem" }}>
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
                            <span style={{ color: 'var(--text-muted)' }}>None</span>
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
          <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: "1rem", padding: "3rem", border: "1px dashed var(--surface-border)", borderRadius: "6px" }}>{t("sub_no_slices")}</div>
        )}
      </div>
    </div>
  );
}
