"use client";

import { BatteryCharging, Save, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { BYTE_INPUT_UNITS, composeByteInput, formatBytes, parseBytes, splitByteInput } from "@/lib/unitParser";
import { OperationNotice } from "./OperationFeedback";
import { Dialog } from "./ui/Dialog";
import "./modals.css";

type TrafficAdjustmentMode = "credit" | "debit";

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
  { mode: "credit", icon: BatteryCharging, labelKey: "traffic_recharge" },
  { mode: "debit", icon: BatteryCharging, labelKey: "traffic_debit" },
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
      <div className="ta-byte-input-grid">
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
  defaultMode = "credit",
  onClose,
  onSuccess,
  t,
}: TrafficAdjustmentModalProps) {
  const total = Math.max(0, Number(currentTraffic.total || 0));
  const used = Math.max(0, Number(currentTraffic.used || 0));
  const balance = Math.max(0, Number(currentTraffic.balance ?? Math.max(0, total - used)));
  const [mode, setMode] = useState<TrafficAdjustmentMode>(defaultMode);
  const [amountStr, setAmountStr] = useState("1 GB");
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const preview = useMemo(() => {
    const amount = parseBytes(amountStr);
    const delta = mode === "credit" ? amount : -amount;
    return { total: Math.max(0, total + delta), balance: Math.max(0, balance + delta), used };
  }, [amountStr, balance, mode, total, used]);

  const handleModeChange = (nextMode: TrafficAdjustmentMode) => {
    setMode(nextMode);
    setError(null);
  };

  const handleSubmit = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const payload: any = {
        bucket: "data",
        operation: mode,
        reason: reason.trim(),
      };
      payload.amount = parseBytes(amountStr);

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
    <Dialog
      open
      onClose={() => { if (!isSaving) onClose(); }}
      overlayClassName="modal-overlay"
      className="modal-content animate-modal-enter ta-modal-content"
      labelledBy="traffic-adjustment-modal-title"
      initialFocusRef={cancelButtonRef}
      closeOnOverlay={!isSaving}
    >
        <div className="workflow-header ta-header">
          <div>
            <h2 id="traffic-adjustment-modal-title" className="ta-header-title">{t("traffic_adjust_title")}</h2>
            <p className="ta-header-desc">{imsi}</p>
          </div>
          <button className="btn-icon" onClick={onClose} title={t("close")} aria-label={t("close")} disabled={isSaving}><X size={22} /></button>
        </div>

        <div className="ta-body">
          <div className="ta-mode-grid">
            {MODE_OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = option.mode === mode;
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => handleModeChange(option.mode)}
                  className={active ? "btn btn-primary ta-mode-btn" : "btn btn-outline ta-mode-btn"}
                >
                  <Icon size={15} /> {t(option.labelKey)}
                </button>
              );
            })}
          </div>

          <div className="ta-stats-grid">
            {[
              [t("traffic_total"), total],
              [t("traffic_used"), used],
              [t("traffic_balance"), balance],
            ].map(([label, value]) => (
              <div key={String(label)} className="ta-stat-card">
                <div className="ta-stat-label">{label}</div>
                <div className="ta-stat-value">{formatBytes(Number(value))}</div>
              </div>
            ))}
          </div>

          <ByteInput label={t("traffic_amount")} value={amountStr} onChange={setAmountStr} />

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

          <div className="ta-preview">
            <div className="ta-preview-title">{t("traffic_preview")}</div>
            <div className="ta-preview-values">
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

        <div className="workflow-footer ta-footer">
          <span className="ta-footer-text">{t("traffic_current")}: {formatBytes(balance)}</span>
          <div className="workflow-footer-actions">
            <button ref={cancelButtonRef} className="btn btn-outline" onClick={onClose} disabled={isSaving}>{t("cancel")}</button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={isSaving}>
              <Save size={16} /> {isSaving ? t("traffic_saving") : t("traffic_submit")}
            </button>
          </div>
        </div>
    </Dialog>
  );
}
