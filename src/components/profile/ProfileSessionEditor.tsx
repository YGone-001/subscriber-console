import React from "react";
import { useI18n } from "../I18nProvider";
import { Trash2, Network, Plus } from "lucide-react";
import ProfilePccRuleEditor from "./ProfilePccRuleEditor";
import { imsSessionPreset, isImsDnn, pccQosPreset, sessionQosPreset, STANDARD_QOS_INDEX_OPTIONS } from "@/lib/imsQosPresets";

const AMBR_UNITS = [
  { label: 'bps', val: 0 }, { label: 'Kbps', val: 1 }, { label: 'Mbps', val: 2 }, { label: 'Gbps', val: 3 }, { label: 'Tbps', val: 4 }
];

const SESSION_TYPES = [
  { label: 'IPv4', val: 1 }, { label: 'IPv6', val: 2 }, { label: 'IPv4v6', val: 3 }
];
const ARP_PRIORITY_OPTIONS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];

interface ProfileSessionEditorProps {
  session: SessionForm;
  onChange: (updatedSession: SessionForm) => void;
  onDelete: () => void;
}

type PccRuleForm = {
  qos?: {
    index?: number;
    _5qi?: number;
    arp?: { priorityLevel?: number; preemptCap?: string; preemptVuln?: string };
    mbr?: { downlink?: { value?: number; unit?: number }; uplink?: { value?: number; unit?: number } };
    gbr?: { downlink?: { value?: number; unit?: number }; uplink?: { value?: number; unit?: number } };
  };
};

type SessionForm = {
  name?: string;
  type?: number;
  pgwIpv4?: string;
  pgwIpv6?: string;
  qos?: {
    _5qi?: number;
    arp?: { priorityLevel?: number; preemptCap?: string; preemptVuln?: string };
  };
  ambr?: {
    downlink?: { value?: number; unit?: number };
    uplink?: { value?: number; unit?: number };
  };
  pcc_rule?: PccRuleForm[];
};

export default function ProfileSessionEditor({ session, onChange, onDelete }: ProfileSessionEditorProps) {
  const { t } = useI18n();
  const isValidIpv4 = (value: string) => {
    const parts = value.split(".");
    if (parts.length !== 4) return false;
    return parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const num = Number(part);
      return num >= 0 && num <= 255;
    });
  };

  // Updates nested fields in a cloned session object.
  const updateField = (path: string[], value: unknown) => {
    const newSession = JSON.parse(JSON.stringify(session));
    let current = newSession;
    for (let i = 0; i < path.length - 1; i++) {
      if (!current[path[i]]) current[path[i]] = {};
      current = current[path[i]];
    }
    current[path[path.length - 1]] = value;
    onChange(newSession);
  };

  const handleNameChange = (value: string) => {
    if (isImsDnn(value)) {
      onChange(imsSessionPreset(session));
      return;
    }
    updateField(["name"], value);
  };

  // Applies standardized priority mapping plus recommended rate presets.
  const applyQosPreset = (rawValue: string) => {
    const newSession = JSON.parse(JSON.stringify(session));
    if (!newSession.qos) newSession.qos = {};
    if (!newSession.qos.arp) newSession.qos.arp = {};

    if (rawValue === "") {
      newSession.qos._5qi = undefined;
      onChange(newSession);
      return;
    }

    const qci = Number(rawValue);
    newSession.qos._5qi = Number.isFinite(qci) ? qci : undefined;
    const preset = sessionQosPreset(qci);
    if (preset) {
      newSession.qos.arp.priorityLevel = preset.arpPriorityLevel;
      newSession.ambr = preset.sessionAmbr;
    }
    onChange(newSession);
  };

  const handleAddPccRule = () => {
    const newSession = JSON.parse(JSON.stringify(session));
    if (!newSession.pcc_rule) newSession.pcc_rule = [];
    const preset = pccQosPreset(1);
    newSession.pcc_rule.push({
      qos: {
        index: 1,
        _5qi: 1,
        arp: { priorityLevel: preset?.arpPriorityLevel ?? 2, preemptCap: "NOT_PREEMPT", preemptVuln: "NOT_PREEMPTABLE" },
        mbr: preset?.mbr ?? { downlink: { value: 0, unit: 1 }, uplink: { value: 0, unit: 1 } },
        gbr: preset?.gbr ?? { downlink: { value: 0, unit: 1 }, uplink: { value: 0, unit: 1 } }
      }
    });
    onChange(newSession);
  };

  const handleUpdatePccRule = (ruleIndex: number, updatedRule: PccRuleForm) => {
    const newSession = JSON.parse(JSON.stringify(session));
    newSession.pcc_rule[ruleIndex] = updatedRule;
    onChange(newSession);
  };

  const handleDeletePccRule = (ruleIndex: number) => {
    const newSession = JSON.parse(JSON.stringify(session));
    newSession.pcc_rule.splice(ruleIndex, 1);
    onChange(newSession);
  };

  return (
    <div style={{ marginTop: "1rem", padding: "1.5rem", border: "1px solid var(--surface-border)", borderRadius: "8px", background: "var(--surface)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "1.5rem" }}>
            <div>
              <label className="form-label" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("sess_name")}</label>
              <input type="text" className="form-input" value={session.name || ""} onChange={e => handleNameChange(e.target.value)} placeholder={t("sess_name_ph")} />
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("sess_type")}</label>
              <select className="form-input" value={session.type || 3} onChange={e => updateField(["type"], Number(e.target.value))}>
                {SESSION_TYPES.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("sess_qos")}</label>
              <select
                className="form-input"
                value={session.qos?._5qi ?? ""}
                onChange={e => applyQosPreset(e.target.value)}
              >
                <option value="">{t("sess_select_qos")}</option>
                {STANDARD_QOS_INDEX_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("sess_arp_level")}</label>
              <select
                className="form-input"
                value={session.qos?.arp?.priorityLevel ?? ""}
                onChange={e => updateField(["qos", "arp", "priorityLevel"], e.target.value === "" ? undefined : Number(e.target.value))}
              >
                <option value="">{t("sess_select_arp")}</option>
                {ARP_PRIORITY_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginTop: "1rem" }}>
            <div>
              <label className="form-label" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("sess_ambr_dl")}</label>
              <div className="input-composite">
                <input type="number" value={session.ambr?.downlink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={e => updateField(["ambr", "downlink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
                <select value={session.ambr?.downlink?.unit || 2} onChange={e => updateField(["ambr", "downlink", "unit"], Number(e.target.value))}>
                  {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("sess_ambr_ul")}</label>
              <div className="input-composite">
                <input type="number" value={session.ambr?.uplink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={e => updateField(["ambr", "uplink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
                <select value={session.ambr?.uplink?.unit || 2} onChange={e => updateField(["ambr", "uplink", "unit"], Number(e.target.value))}>
                  {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("sess_ipv4")}</label>
              <input
                type="text"
                className="form-input"
                value={session.pgwIpv4 ?? ""}
                onChange={e => updateField(["pgwIpv4"], e.target.value.trim())}
                onBlur={e => {
                  const value = e.target.value.trim();
                  if (!value) return;
                  if (!isValidIpv4(value)) {
                    updateField(["pgwIpv4"], "");
                  }
                }}
                placeholder={t("sess_opt_ipv4")}
              />
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.85rem", fontWeight: 600 }}>{t("sess_ipv6")}</label>
              <input
                type="text"
                className="form-input"
                value={session.pgwIpv6 ?? ""}
                onChange={e => updateField(["pgwIpv6"], e.target.value.trim())}
                placeholder={t("sess_opt_ipv6")}
              />
            </div>
          </div>
        </div>
        <button className="btn-icon text-danger" onClick={onDelete} style={{ padding: '0.4rem', background: "transparent", borderRadius: "8px", marginLeft: "1rem" }} title={t("sess_remove")}>
          <Trash2 size={20}/>
        </button>
      </div>

      {/* Level 3: PCC Rules */}
      <div style={{ marginTop: "1.5rem", borderTop: "1px solid var(--surface-border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "1rem" }}>
          <h5 style={{ fontSize: '0.9rem', color: "var(--text-main)", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Network size={16}/> {t("sess_pcc_rules")}
          </h5>
          <button className="btn-icon" onClick={handleAddPccRule} style={{ color: "var(--primary)", fontSize: "0.9rem", fontWeight: 600 }}>
            <Plus size={16}/> {t("sess_add_pcc")}
          </button>
        </div>

        {(session.pcc_rule?.length ?? 0) > 0 ? (
          <div style={{ paddingLeft: "1rem" }}>
            {session.pcc_rule?.map((rule: PccRuleForm, pccIdx: number) => (
              <ProfilePccRuleEditor
                key={pccIdx}
                rule={rule}
                ruleIndex={pccIdx}
                onChange={(updated) => handleUpdatePccRule(pccIdx, updated)}
                onDelete={() => handleDeletePccRule(pccIdx)}
              />
            ))}
          </div>
        ) : (
          <div style={{ padding: "1.5rem", border: "1px dashed var(--surface-border)", borderRadius: "6px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.9rem", marginTop: "1rem", background: "transparent" }}>
            {t("sess_no_pcc")}
          </div>
        )}
      </div>
    </div>
  );
}
