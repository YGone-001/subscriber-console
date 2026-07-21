"use client";

import { BatteryCharging, RotateCcw, Save, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import { BYTE_INPUT_UNITS, composeByteInput, formatBytes, parseBytes, splitByteInput } from "@/lib/unitParser";
import { OperationNotice } from "./OperationFeedback";

type TrafficAdjustmentMode = "recharge" | "set_available" | "set_total" | "reset";

type TrafficInfo = {
  total?: number;
  used?: number;
  balance?: number;
};

type TrafficAdjustmentModalProps = {
  imsi: string;
  currentTraffic: TrafficInfo;
  defaultMode?: TrafficAdjustmentMode;
  onClose: () => void;
  onSuccess: (response: any) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

const MODE_OPTIONS: Array<{ mode: TrafficAdjustmentMode; icon: typeof BatteryCharging; labelKey: string }> = [
  { mode: "recharge", icon: BatteryCharging, labelKey: "traffic_recharge" },
  { mode: "set_available", icon: SlidersHorizontal, labelKey: "traffic_set_available" },
  { mode: "set_total", icon: SlidersHorizontal, labelKey: "traffic_set_total" },
  { mode: "reset", icon: RotateCcw, labelKey: "traffic_reset" },
];

function ByteInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const input = splitByteInput(value);

  return (
    <div>
      <label className="form-label">{label}</label>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px", gap: "0.5rem" }}>
        <input
          className="form-input"
          inputMode="decimal"
          value={input.value}
          onChange={(event) => onChange(composeByteInput(event.target.value, input.unit))}
        />
        <select
          className="form-input"
          value={input.unit}
          onChange={(event) => onChange(composeByteInput(input.value, event.target.value))}
        >
          {BYTE_INPUT_UNITS.map((unit) => (
            <option key={unit.value} value={unit.value}>{unit.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default function TrafficAdjustmentModal({
  imsi,
  currentTraffic,
  defaultMode = "recharge",
  onClose,
  onSuccess,
  t,
}: TrafficAdjustmentModalProps) {
  const total = Math.max(0, Number(currentTraffic.total || 0));
  const used = Math.max(0, Number(currentTraffic.used || 0));
  const balance = Math.max(0, Number(currentTraffic.balance ?? Math.max(0, total - used)));
  const [mode, setMode] = useState<TrafficAdjustmentMode>(defaultMode);
  const [amountStr, setAmountStr] = useState("1 GB");
  const [valueStr, setValueStr] = useState(formatBytes(mode === "set_total" ? total : balance));
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    const amount = parseBytes(amountStr);
    const value = parseBytes(valueStr);
    if (mode === "recharge") return { total: total + amount, balance: balance + amount, used };
    if (mode === "set_available") return { total: Math.max(total, used + value), balance: value, used };
    if (mode === "set_total") return { total: value, balance: Math.min(balance, Math.max(0, value - used)), used };
    return { total, balance: total, used: 0 };
  }, [amountStr, balance, mode, total, used, valueStr]);

  const handleModeChange = (nextMode: TrafficAdjustmentMode) => {
    setMode(nextMode);
    setError(null);
    if (nextMode === "set_total") setValueStr(formatBytes(total));
    if (nextMode === "set_available") setValueStr(formatBytes(balance));
  };

  const handleSubmit = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const payload: any = {
        mode,
        reason: reason.trim() || undefined,
      };

      if (mode === "recharge") payload.amount = parseBytes(amountStr);
      if (mode === "set_available" || mode === "set_total") payload.value = parseBytes(valueStr);

      const response = await fetch(`/api/subscribers/${imsi}/traffic-adjustments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || t("traffic_err_save"));
      }

      onSuccess(data);
      onClose();
    } catch (err: any) {
      setError(err.message || t("traffic_err_save"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(event) => { event.stopPropagation(); onClose(); }}>
      <div className="modal-content animate-modal-enter" style={{ maxWidth: "620px", padding: 0 }} onClick={(event) => event.stopPropagation()}>
        <div className="workflow-header" style={{ padding: "1.25rem 1.5rem", borderBottom: "1px solid var(--surface-border)" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.2rem", color: "var(--text-main)" }}>{t("traffic_adjust_title")}</h2>
            <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontFamily: "monospace", fontSize: "0.9rem" }}>{imsi}</p>
          </div>
          <button className="btn-icon" onClick={onClose} title={t("close")}><X size={22} /></button>
        </div>

        <div style={{ padding: "1.5rem", display: "grid", gap: "1.25rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "0.5rem" }}>
            {MODE_OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = option.mode === mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => handleModeChange(option.mode)}
                  className={active ? "btn btn-primary" : "btn btn-outline"}
                  style={{ justifyContent: "center", padding: "0.65rem 0.5rem", minHeight: "42px" }}
                >
                  <Icon size={15} /> {t(option.labelKey)}
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.75rem" }}>
            {[
              [t("traffic_total"), total],
              [t("traffic_used"), used],
              [t("traffic_balance"), balance],
            ].map(([label, value]) => (
              <div key={String(label)} style={{ border: "1px solid var(--surface-border)", borderRadius: 8, padding: "0.8rem", background: "var(--surface-hover)" }}>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.25rem" }}>{label}</div>
                <div style={{ fontFamily: "monospace", color: "var(--text-main)", fontWeight: 700 }}>{formatBytes(Number(value))}</div>
              </div>
            ))}
          </div>

          {mode === "recharge" && <ByteInput label={t("traffic_amount")} value={amountStr} onChange={setAmountStr} />}
          {(mode === "set_available" || mode === "set_total") && <ByteInput label={t("traffic_value")} value={valueStr} onChange={setValueStr} />}

          <div>
            <label className="form-label">{t("traffic_reason")}</label>
            <input
              className="form-input"
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("traffic_reason_ph")}
            />
          </div>

          <div style={{ border: "1px solid var(--surface-border)", borderRadius: 8, padding: "0.9rem", background: "rgba(59, 130, 246, 0.08)" }}>
            <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: "0.4rem" }}>{t("traffic_preview")}</div>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", fontFamily: "monospace", color: "var(--text-main)", fontWeight: 700 }}>
              <span>{t("traffic_total")}: {formatBytes(preview.total)}</span>
              <span>{t("traffic_used")}: {formatBytes(preview.used)}</span>
              <span>{t("traffic_balance")}: {formatBytes(preview.balance)}</span>
            </div>
          </div>

          {error && (
            <OperationNotice
              presentation="modal"
              tone="danger"
              title={t("error")}
              message={error}
              onClose={() => setError(null)}
            />
          )}
        </div>

        <div className="workflow-footer" style={{ padding: "1rem 1.5rem", borderTop: "1px solid var(--surface-border)" }}>
          <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t("traffic_current")}: {formatBytes(balance)}</span>
          <div className="workflow-footer-actions">
            <button className="btn btn-outline" onClick={onClose}>{t("cancel")}</button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={isSaving}>
              <Save size={16} /> {isSaving ? t("traffic_saving") : t("traffic_submit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
