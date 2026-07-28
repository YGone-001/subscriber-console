import React from "react";
import { useI18n } from "../I18nProvider";
import { Plus, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import ProfileSessionEditor from "./ProfileSessionEditor";
import { sessionQosPreset } from "@/lib/imsQosPresets";

interface ProfileSliceEditorProps {
  slice: SliceForm;
  sliceIndex: number;
  newlyAdded: boolean;
  onChange: (updatedSlice: SliceForm) => void;
  onDelete: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

type SessionForm = {
  name?: string;
  type?: number;
  pgwIpv4?: string;
  pgwIpv6?: string;
  qos?: {
    _5qi?: number;
    index?: number;
    arp?: { priorityLevel?: number; preemptCap?: string; preemptVuln?: string };
  };
  ambr?: {
    downlink?: { value?: number; unit?: number };
    uplink?: { value?: number; unit?: number };
  };
  pcc_rule?: Array<{ qos?: Record<string, unknown> }>;
};

type SliceForm = {
  sst?: number;
  sd?: string;
  default_indicator?: boolean;
  session_list?: SessionForm[];
};

export default function ProfileSliceEditor({
  slice,
  sliceIndex,
  newlyAdded,
  onChange,
  onDelete,
  isExpanded = true,
  onToggleExpand
}: ProfileSliceEditorProps) {
  const { t } = useI18n();

  const updateSlice = (field: string, value: unknown) => {
    onChange({ ...slice, [field]: value });
  };

  const handleAddSession = () => {
    const newSlice = JSON.parse(JSON.stringify(slice));
    if (!newSlice.session_list) newSlice.session_list = [];
    const preset = sessionQosPreset(9);
    newSlice.session_list.push({
      name: "internet",
      type: 1,
      pgwIpv4: "",
      pgwIpv6: "",
      qos: { _5qi: 9, index: 0, arp: { priorityLevel: preset?.arpPriorityLevel ?? 9, preemptCap: "NOT_PREEMPT", preemptVuln: "NOT_PREEMPTABLE" } },
      ambr: preset?.sessionAmbr ?? { downlink: { value: 1, unit: 3 }, uplink: { value: 1, unit: 3 } },
      pcc_rule: []
    });
    onChange(newSlice);
  };

  const handleUpdateSession = (sessIdx: number, updatedSession: SessionForm) => {
    const newSlice = JSON.parse(JSON.stringify(slice));
    newSlice.session_list[sessIdx] = updatedSession;
    onChange(newSlice);
  };

  const handleDeleteSession = (sessIdx: number) => {
    const newSlice = JSON.parse(JSON.stringify(slice));
    newSlice.session_list.splice(sessIdx, 1);
    onChange(newSlice);
  };

  const handleHeaderClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName !== 'DIV' && (e.target as HTMLElement).tagName !== 'SPAN' && (e.target as HTMLElement).tagName !== 'svg') return;
    if (onToggleExpand) onToggleExpand();
  };

  return (
    <div className={`slice-strip-card ${newlyAdded ? 'flash-animate' : ''}`}>
      {/* Slice Header: SST, SD, Default */}
      <div
        className={onToggleExpand ? "slice-card-header" : ""}
        onClick={handleHeaderClick}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          padding: "1.5rem 2rem",
          borderBottom: isExpanded ? '1px solid var(--surface-border)' : 'none',
          cursor: onToggleExpand ? "pointer" : "default"
        }}
      >
        <div style={{ display: "flex", gap: "2.5rem", flex: 1, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--primary)" }}>{t("slice_idx", { idx: sliceIndex + 1 })}</div>
          <div style={{ display: "flex", gap: "1.5rem", background: "var(--surface-hover)", padding: "0.5rem 1rem", borderRadius: "6px" }}>
            {[1,2,3,4].map(val => (
              <label key={val} style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
                <input type="radio" name={`psst-${sliceIndex}`} checked={slice.sst === val} onChange={() => updateSlice('sst', val)} />
                <span style={{ fontSize: "1rem", fontWeight: 500, color: "var(--text-main)" }}>SST {val}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className="form-label" style={{ margin: 0 }}>SD:</span>
            <input type="text" className="form-input" style={{ width: "120px", padding: "0.4rem 0.6rem" }} value={slice.sd || ""} onChange={(e) => updateSlice('sd', e.target.value)} placeholder="000000" />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input type="checkbox" checked={!!slice.default_indicator} onChange={(e) => updateSlice('default_indicator', e.target.checked)} style={{ width: '1.2rem', height: '1.2rem' }} />
            <span style={{ fontWeight: 500, fontSize: "0.95rem", color: "var(--text-main)" }}>{t("sub_default_nssai")}</span>
          </label>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button className="btn-icon text-danger" onClick={(e) => { e.stopPropagation(); onDelete(); }} title={t("slice_delete")}>
            <Trash2 size={20}/>
          </button>
          {onToggleExpand && (
            <>
              <div style={{ width: "1px", height: "20px", background: "var(--surface-border)", margin: "0 0.5rem" }} />
              {isExpanded ? <ChevronUp size={20} color="var(--text-muted)" /> : <ChevronDown size={20} color="var(--text-muted)" />}
            </>
          )}
        </div>
      </div>

      {/* Level 2: Sessions inside Slice */}
      <div className={onToggleExpand ? `accordion-content ${isExpanded ? 'expanded' : 'collapsed'}` : ""}>
        <div style={{ padding: "1.5rem 2rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", padding: "0 0.5rem" }}>
            <h4 style={{ fontSize: '1rem', fontWeight: 600, color: "var(--text-secondary)", margin: 0 }}>{t("slice_sessions_in", { idx: sliceIndex + 1 })}</h4>
            <button className="btn btn-outline" onClick={handleAddSession} style={{ padding: "0.4rem 0.8rem", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.3rem" }}>
              <Plus size={16}/> {t("slice_add_session")}
            </button>
          </div>

          {(slice.session_list?.length ?? 0) > 0 ? (
            <div>
              {slice.session_list?.map((session: SessionForm, sessIdx: number) => (
                <ProfileSessionEditor
                  key={sessIdx}
                  session={session}
                  onChange={(updated) => handleUpdateSession(sessIdx, updated)}
                  onDelete={() => handleDeleteSession(sessIdx)}
                />
              ))}
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)", border: '1px dashed var(--surface-border)', borderRadius: '6px' }}>
              {t("slice_no_sessions_hint")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
