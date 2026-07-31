import React from "react";
import { useI18n } from "../I18nProvider";
import { X } from "lucide-react";
import { pccQosPreset } from "@/lib/imsQosPresets";
import "./profile.css";

const AMBR_UNITS = [
  { label: 'bps', val: 0 }, { label: 'Kbps', val: 1 }, { label: 'Mbps', val: 2 }, { label: 'Gbps', val: 3 }, { label: 'Tbps', val: 4 }
];

interface ProfilePccRuleEditorProps {
  rule: {
    qos?: {
      _5qi?: number;
      arp?: { priorityLevel?: number };
      mbr?: { downlink?: { value?: number; unit?: number }; uplink?: { value?: number; unit?: number } };
      gbr?: { downlink?: { value?: number; unit?: number }; uplink?: { value?: number; unit?: number } };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  ruleIndex: number;
  onChange: (updatedRule: ProfilePccRuleEditorProps["rule"]) => void;
  onDelete: () => void;
}

export default function ProfilePccRuleEditor({ rule, ruleIndex, onChange, onDelete }: ProfilePccRuleEditorProps) {
  const { t } = useI18n();

  // Updates nested fields in a cloned PCC rule object.
  const updateField = (path: string[], value: number | undefined) => {
    const newRule = JSON.parse(JSON.stringify(rule));
    let current = newRule;
    for (let i = 0; i < path.length - 1; i++) {
      if (!current[path[i]]) current[path[i]] = {};
      current = current[path[i]];
    }
    current[path[path.length - 1]] = value;
    onChange(newRule);
  };

  const handleQciChange = (value: number) => {
    const newRule = JSON.parse(JSON.stringify(rule));
    if (!newRule.qos) newRule.qos = {};
    newRule.qos._5qi = value;
    newRule.qos.index = value;

    const preset = pccQosPreset(value);
    if (preset) {
      if (!newRule.qos.arp) newRule.qos.arp = {};
      newRule.qos.arp.priorityLevel = preset.arpPriorityLevel;
      if (preset.mbr) newRule.qos.mbr = preset.mbr;
      if (preset.gbr) newRule.qos.gbr = preset.gbr;
    }

    onChange(newRule);
  };

  return (
    <div className="pcc-rule-box">
      <div className="pcc-rule-header">
        <span className="pcc-rule-idx-title">
          {t("slice_rule_idx", { idx: ruleIndex + 1 })}
        </span>
        <button className="btn-icon text-danger pcc-rule-delete-btn" onClick={onDelete} title={t("pcc_delete_rule")}>
          <X size={16}/>
        </button>
      </div>

      <div className="pcc-rule-form-grid">
        <div>
          <label className="form-label pcc-rule-label">{t("pcc_qos_idx")}</label>
          <input type="number" className="form-input" value={rule.qos?._5qi ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => e.target.value === "" ? updateField(["qos", "_5qi"], undefined) : handleQciChange(Number(e.target.value))} />
        </div>
        <div>
          <label className="form-label pcc-rule-label">{t("pcc_arp")}</label>
          <input type="number" className="form-input" value={rule.qos?.arp?.priorityLevel ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "arp", "priorityLevel"], e.target.value === "" ? undefined : Number(e.target.value))} />
        </div>
        <div/>

        <div>
          <label className="form-label pcc-rule-label">{t("pcc_mbr_dl")}</label>
          <div className="input-composite">
            <input type="number" value={rule.qos?.mbr?.downlink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "mbr", "downlink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
            <select value={rule.qos?.mbr?.downlink?.unit || 1} onChange={(e) => updateField(["qos", "mbr", "downlink", "unit"], Number(e.target.value))}>
              {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="form-label pcc-rule-label">{t("pcc_mbr_ul")}</label>
          <div className="input-composite">
            <input type="number" value={rule.qos?.mbr?.uplink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "mbr", "uplink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
            <select value={rule.qos?.mbr?.uplink?.unit || 1} onChange={(e) => updateField(["qos", "mbr", "uplink", "unit"], Number(e.target.value))}>
              {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
            </select>
          </div>
        </div>
        <div/>

        <div>
          <label className="form-label pcc-rule-label">{t("pcc_gbr_dl")}</label>
          <div className="input-composite">
            <input type="number" value={rule.qos?.gbr?.downlink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "gbr", "downlink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
            <select value={rule.qos?.gbr?.downlink?.unit || 1} onChange={(e) => updateField(["qos", "gbr", "downlink", "unit"], Number(e.target.value))}>
              {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="form-label pcc-rule-label">{t("pcc_gbr_ul")}</label>
          <div className="input-composite">
            <input type="number" value={rule.qos?.gbr?.uplink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "gbr", "uplink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
            <select value={rule.qos?.gbr?.uplink?.unit || 1} onChange={(e) => updateField(["qos", "gbr", "uplink", "unit"], Number(e.target.value))}>
              {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
