/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/TrafficAdjustmentModal.tsx
 *
 * Adaptations: the historical surface posted to a routed placeholder. The
 * subscription balance is now adjusted through the governed OCS endpoint, so
 * every outcome is a real write or an explicit error.
 */
import { BatteryCharging, ExternalLink, Save, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { BYTE_INPUT_UNITS, composeByteInput, formatBytes, parseBytes, splitByteInput } from '../lib/unitParser';
import { MutationApiError, postJson } from '../lib/api/mutation-client';
import { useRead } from '../lib/api/use-read';
import { useAppRouter } from '../lib/ui-compat/router';
import { OperationNotice } from './ui/OperationFeedback';
import { Dialog } from './ui/Dialog';
import { toBalanceViewModel } from '../features/ocs/ocs-view-models';

type TrafficAdjustmentMode = "credit" | "debit";

type TrafficAdjustmentModalProps = {
  imsi: string;
  defaultMode?: TrafficAdjustmentMode;
  onClose: () => void;
  onSuccess: (response: any) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

const MODE_OPTIONS: Array<{ mode: TrafficAdjustmentMode; icon: typeof BatteryCharging; labelKey: string }> = [
  { mode: "credit", icon: BatteryCharging, labelKey: "traffic_recharge" },
  { mode: "debit", icon: BatteryCharging, labelKey: "traffic_debit" },
];

const CAS_CODES = ['BALANCE_PRECONDITION_CHANGED', 'PRECONDITION_FAILED'];

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
  defaultMode = "credit",
  onClose,
  onSuccess,
  t,
}: TrafficAdjustmentModalProps) {
  const router = useAppRouter();
  const { data: balancePayload, error: balanceError, isLoading: balanceLoading, mutate: refreshBalance } = useRead<unknown>(
    imsi ? `/api/ocs/balances/${encodeURIComponent(imsi)}` : null,
  );
  const balance = toBalanceViewModel(balancePayload);
  const total = balance?.data.total ?? null;
  const used = balance?.data.used ?? null;
  const available = balance?.data.available ?? null;
  const version = balance?.version ?? null;
  const [mode, setMode] = useState<TrafficAdjustmentMode>(defaultMode);
  const [amountStr, setAmountStr] = useState("1 GB");
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const formatMetric = (value: number | null) => value === null ? "—" : formatBytes(value);

  const preview = useMemo(() => {
    const amount = parseBytes(amountStr);
    const delta = mode === "credit" ? amount : -amount;
    return {
      total: total === null ? null : Math.max(0, total + delta),
      balance: available === null ? null : Math.max(0, available + delta),
      used,
    };
  }, [amountStr, available, mode, total, used]);

  const handleModeChange = (nextMode: TrafficAdjustmentMode) => {
    setMode(nextMode);
    setError(null);
  };

  const handleSubmit = async () => {
    if (balanceLoading || balanceError) return;
    if (!balance) {
      setError(t("ocs_detail_load_failed"));
      return;
    }
    if (version === null) {
      setError(t("ocs_balance_version_missing"));
      return;
    }
    const amount = parseBytes(amountStr);
    if (amount <= 0) {
      setError(t("traffic_amount_invalid"));
      return;
    }
    if (mode === "debit" && available !== null && amount > available) {
      setError(t("ocs_balance_insufficient"));
      return;
    }
    if (!reason.trim()) {
      setError(t("traffic_reason_required"));
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await postJson<{ outcome?: string }>(
        `/api/ocs/balances/${encodeURIComponent(imsi)}/adjust`,
        {
          operation: mode,
          bucket: "data",
          amount,
          reason: reason.trim(),
          version,
        },
      );

      onSuccess(response);
      onClose();
    } catch (err) {
      const code = err instanceof MutationApiError ? err.code : undefined;
      if (code && CAS_CODES.includes(code)) {
        setError(t("ocs_balance_precondition_changed"));
        void refreshBalance();
      } else if (code === "GO_BACKEND_UNREACHABLE") {
        setError(t("ocs_balance_backend_unreachable"));
      } else {
        setError(err instanceof Error ? err.message : t("traffic_err_save"));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const openBalanceManagement = () => {
    onClose();
    router.push(`/ocs/balances/${encodeURIComponent(imsi)}`);
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
              { label: t("traffic_total"), value: total },
              { label: t("traffic_used"), value: used },
              { label: t("traffic_balance"), value: available },
            ].map(({ label, value }) => (
              <div key={label} className="ta-stat-card">
                <div className="ta-stat-label">{label}</div>
                <div className="ta-stat-value">{formatMetric(value)}</div>
              </div>
            ))}
          </div>

          {balanceLoading && <p className="text-muted" role="status">{t("loading")}</p>}
          {balanceError && <p className="warning-text" role="alert">{t("ocs_detail_load_failed")}</p>}
          {!balanceLoading && !balanceError && version === null && (
            <p className="warning-text" role="alert">{t("ocs_balance_version_missing")}</p>
          )}

          <ByteInput label={t("traffic_amount")} value={amountStr} onChange={setAmountStr} />

          <div>
            <label className="form-label"><span className="form-asterisk">*</span>{t("traffic_reason")}</label>
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
              <span>{t("traffic_total")}: {formatMetric(preview.total)}</span>
              <span>{t("traffic_used")}: {formatMetric(preview.used)}</span>
              <span>{t("traffic_balance")}: {formatMetric(preview.balance)}</span>
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
          <button type="button" className="btn btn-outline" onClick={openBalanceManagement} disabled={isSaving}>
            <ExternalLink size={15} /> {t("sub_balance_management")}
          </button>
          <div className="workflow-footer-actions">
            <button ref={cancelButtonRef} className="btn btn-outline" onClick={onClose} disabled={isSaving}>{t("cancel")}</button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={isSaving || balanceLoading || Boolean(balanceError) || !balance || version === null}>
              <Save size={16} /> {isSaving ? t("traffic_saving") : t("traffic_submit")}
            </button>
          </div>
        </div>
    </Dialog>
  );
}
