import React from "react";
import { useI18n } from "../I18nProvider";
import { X } from "lucide-react";

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

  // Helper to update deeply nested fields cleanly
  const updateField = (path: string[], value: number | undefined) => {
    // Deep clone the rule
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

    // 中文注释: 根据 QCI 自动填充建议速率，允许用户后续手工覆盖
    if (value === 1) {
      newRule.qos.mbr = {
        downlink: { value: 128, unit: 1 },
        uplink: { value: 128, unit: 1 },
      };
      newRule.qos.gbr = {
        downlink: { value: 128, unit: 1 },
        uplink: { value: 128, unit: 1 },
      };
    } else if (value === 2) {
      newRule.qos.mbr = {
        downlink: { value: 4, unit: 2 },
        uplink: { value: 4, unit: 2 },
      };
      newRule.qos.gbr = {
        downlink: { value: 2, unit: 2 },
        uplink: { value: 2, unit: 2 },
      };
    }

    onChange(newRule);
  };

  return (
    <div className="pcc-rule-box">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)", textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {t("slice_rule_idx", { idx: ruleIndex + 1 })}
        </span>
        <button className="btn-icon text-danger" onClick={onDelete} style={{ padding: "2px" }} title="Delete PCC Rule">
          <X size={16}/>
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem" }}>
        <div>
          <label className="form-label" style={{ fontSize: "0.8rem" }}>{t("pcc_qos_idx")}</label>
          <input type="number" className="form-input" value={rule.qos?._5qi ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => e.target.value === "" ? updateField(["qos", "_5qi"], undefined) : handleQciChange(Number(e.target.value))} />
        </div>
        <div>
          <label className="form-label" style={{ fontSize: "0.8rem" }}>{t("pcc_arp")}</label>
          <input type="number" className="form-input" value={rule.qos?.arp?.priorityLevel ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "arp", "priorityLevel"], e.target.value === "" ? undefined : Number(e.target.value))} />
        </div>
        <div/>

        <div>
          <label className="form-label" style={{ fontSize: "0.8rem" }}>{t("pcc_mbr_dl")}</label>
          <div className="input-composite">
            <input type="number" value={rule.qos?.mbr?.downlink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "mbr", "downlink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
            <select value={rule.qos?.mbr?.downlink?.unit || 1} onChange={(e) => updateField(["qos", "mbr", "downlink", "unit"], Number(e.target.value))}>
              {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="form-label" style={{ fontSize: "0.8rem" }}>{t("pcc_mbr_ul")}</label>
          <div className="input-composite">
            <input type="number" value={rule.qos?.mbr?.uplink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "mbr", "uplink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
            <select value={rule.qos?.mbr?.uplink?.unit || 1} onChange={(e) => updateField(["qos", "mbr", "uplink", "unit"], Number(e.target.value))}>
              {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
            </select>
          </div>
        </div>
        <div/>

        <div>
          <label className="form-label" style={{ fontSize: "0.8rem" }}>{t("pcc_gbr_dl")}</label>
          <div className="input-composite">
            <input type="number" value={rule.qos?.gbr?.downlink?.value ?? ""} onFocus={(e) => e.target.select()} onChange={(e) => updateField(["qos", "gbr", "downlink", "value"], e.target.value === "" ? undefined : Number(e.target.value))} />
            <select value={rule.qos?.gbr?.downlink?.unit || 1} onChange={(e) => updateField(["qos", "gbr", "downlink", "unit"], Number(e.target.value))}>
              {AMBR_UNITS.map(u => <option key={u.val} value={u.val}>{u.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="form-label" style={{ fontSize: "0.8rem" }}>{t("pcc_gbr_ul")}</label>
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
