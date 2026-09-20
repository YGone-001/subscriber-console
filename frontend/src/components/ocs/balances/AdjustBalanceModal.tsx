"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, RefreshCw, X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { formatBytes } from "@/lib/unitParser";

interface AdjustBalanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  imsi: string;
  dataAvailable: number;
  voiceAvailable: number;
  smsAvailable: number;
  onSuccess: (result: { outcome: string; message: string; approvalId?: string }) => void;
}

export default function AdjustBalanceModal({
  isOpen,
  onClose,
  imsi,
  dataAvailable,
  voiceAvailable,
  smsAvailable,
  onSuccess,
}: AdjustBalanceModalProps) {
  const { t } = useI18n();
  const router = useRouter();

  const [bucket, setBucket] = useState<"data" | "voice" | "sms">("data");
  const [operation, setOperation] = useState<"credit" | "debit">("credit");
  const [amountInput, setAmountInput] = useState<string>("1");
  const [dataUnit, setDataUnit] = useState<"GB" | "MB" | "Bytes">("GB");
  const [voiceUnit, setVoiceUnit] = useState<"Minutes" | "Seconds">("Minutes");
  const [reason, setReason] = useState<string>("");
  const [ticketId, setTicketId] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [casConflict, setCasConflict] = useState<boolean>(false);

  if (!isOpen) return null;

  const currentAvailable =
    bucket === "data" ? dataAvailable : bucket === "voice" ? voiceAvailable : smsAvailable;

  const calculateAmount = (): number => {
    const raw = parseFloat(amountInput);
    if (isNaN(raw) || raw <= 0) return 0;
    if (bucket === "data") {
      if (dataUnit === "GB") return Math.round(raw * 1024 * 1024 * 1024);
      if (dataUnit === "MB") return Math.round(raw * 1024 * 1024);
      return Math.round(raw);
    }
    if (bucket === "voice") {
      if (voiceUnit === "Minutes") return Math.round(raw * 60);
      return Math.round(raw);
    }
    return Math.round(raw);
  };

  const calculatedAmount = calculateAmount();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCasConflict(false);

    if (calculatedAmount <= 0) {
      setError(t("ocs_balance_amount_invalid") || "Amount must be greater than 0");
      return;
    }

    if (operation === "debit" && calculatedAmount > currentAvailable) {
      setError(
        t("ocs_balance_insufficient") ||
          `Debit amount (${calculatedAmount}) exceeds available balance (${currentAvailable})`
      );
      return;
    }

    if (!reason.trim()) {
      setError(t("ocs_balance_reason_required") || "Reason is required (max 200 characters)");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/ocs/balances/${encodeURIComponent(imsi)}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation,
          bucket,
          amount: calculatedAmount,
          reason: reason.trim(),
          ticketId: ticketId.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (
          data.code === "BALANCE_PRECONDITION_CHANGED" ||
          data.error === "BALANCE_PRECONDITION_CHANGED"
        ) {
          setCasConflict(true);
          setError(
            t("ocs_balance_precondition_changed") ||
              "Balance was modified concurrently; please refresh and retry"
          );
        } else {
          setError(data.message || data.error || `Adjustment failed (${res.status})`);
        }
        return;
      }

      const isApproval = data.outcome === "approval_required";
      const approvalId = data.approvalId || data.approval_id;
      const message = isApproval
        ? t("ocs_balance_approval_created")
        : t("ocs_balance_success_executed");

      onSuccess({
        outcome: data.outcome,
        message,
        approvalId,
      });

      onClose();

      if (isApproval && approvalId) {
        router.push(`/approvals?id=${encodeURIComponent(approvalId)}`);
      }
    } catch {
      setError(t("network_error") || "Network error occurred. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ocs-dialog-overlay" onClick={onClose}>
      <div
        className="ocs-dialog ocs-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="balance-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ocs-dialog-header" style={{ justifyContent: "space-between" }}>
          <h3 id="balance-modal-title">{t("ocs_balance_modal_title")}</h3>
          <button
            type="button"
            className="ocs-btn-icon"
            onClick={onClose}
            aria-label={t("close") || "Close"}
          >
            <X size={18} />
          </button>
        </div>

        <div className="ocs-balance-modal-imsi" style={{ marginBottom: "1rem" }}>
          <span style={{ fontSize: "var(--ref-font-size-data-relaxed)", color: "var(--text-secondary)" }}>
            IMSI: <strong className="ocs-mono">{imsi}</strong>
          </span>
          <div style={{ fontSize: "var(--ref-font-size-label)", color: "var(--text-secondary)", marginTop: "0.25rem" }}>
            {t("ocs_col_data_available")}: {formatBytes(dataAvailable)} |{" "}
            {t("ocs_col_voice_avail")}: {voiceAvailable}s |{" "}
            {t("ocs_col_sms_avail")}: {smsAvailable}
          </div>
        </div>

        {error && (
          <div
            className="ocs-feedback-error"
            style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}
          >
            <AlertCircle size={16} />
            <span>{error}</span>
            {casConflict && (
              <button
                type="button"
                className="ocs-btn ocs-btn-secondary"
                style={{ padding: "0.2rem 0.5rem", fontSize: "var(--ref-font-size-caption)", marginLeft: "auto" }}
                onClick={() => {
                  onClose();
                  window.location.reload();
                }}
              >
                <RefreshCw size={12} /> {t("refresh")}
              </button>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Bucket selection */}
          <div className="ocs-form-group">
            <label className="ocs-form-label">{t("ocs_balance_bucket")}</label>
            <select
              className="ocs-select"
              style={{ width: "100%" }}
              value={bucket}
              onChange={(e) => setBucket(e.target.value as "data" | "voice" | "sms")}
            >
              <option value="data">{t("ocs_balance_bucket_data")}</option>
              <option value="voice">{t("ocs_balance_bucket_voice")}</option>
              <option value="sms">{t("ocs_balance_bucket_sms")}</option>
            </select>
          </div>

          {/* Operation selection */}
          <div className="ocs-form-group">
            <label className="ocs-form-label">{t("ocs_balance_operation")}</label>
            <select
              className="ocs-select"
              style={{ width: "100%" }}
              value={operation}
              onChange={(e) => setOperation(e.target.value as "credit" | "debit")}
            >
              <option value="credit">{t("ocs_balance_op_credit")}</option>
              <option value="debit">{t("ocs_balance_op_debit")}</option>
            </select>
          </div>

          {/* Amount input + unit */}
          <div className="ocs-form-group">
            <label className="ocs-form-label">{t("ocs_balance_amount")}</label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="number"
                step="any"
                min="0"
                className="ocs-form-input"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="1"
                required
              />
              {bucket === "data" && (
                <select
                  className="ocs-select"
                  style={{ width: "110px" }}
                  value={dataUnit}
                  onChange={(e) => setDataUnit(e.target.value as "GB" | "MB" | "Bytes")}
                >
                  <option value="GB">GB</option>
                  <option value="MB">MB</option>
                  <option value="Bytes">Bytes</option>
                </select>
              )}
              {bucket === "voice" && (
                <select
                  className="ocs-select"
                  style={{ width: "110px" }}
                  value={voiceUnit}
                  onChange={(e) => setVoiceUnit(e.target.value as "Minutes" | "Seconds")}
                >
                  <option value="Minutes">{t("minutes") || "分"}</option>
                  <option value="Seconds">{t("seconds") || "秒"}</option>
                </select>
              )}
              {bucket === "sms" && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "0 0.75rem",
                    background: "var(--surface-field)",
                    border: "1px solid var(--surface-border)",
                    borderRadius: "var(--ref-radius-compact)",
                    fontSize: "var(--ref-font-size-data-relaxed)",
                  }}
                >
                  {t("sms_unit")}
                </span>
              )}
            </div>
            {calculatedAmount > 0 && bucket === "data" && dataUnit !== "Bytes" && (
              <span style={{ fontSize: "var(--ref-font-size-caption)", color: "var(--text-secondary)", marginTop: "0.25rem", display: "block" }}>
                = {calculatedAmount.toLocaleString()} Bytes ({formatBytes(calculatedAmount)})
              </span>
            )}
          </div>

          {/* Reason input */}
          <div className="ocs-form-group">
            <label className="ocs-form-label">{t("ocs_balance_reason")}</label>
            <textarea
              className="ocs-form-textarea"
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Customer quota compensation"
              required
            />
          </div>

          {/* Ticket ID input */}
          <div className="ocs-form-group">
            <label className="ocs-form-label">{t("ocs_balance_ticket_id")}</label>
            <input
              type="text"
              maxLength={100}
              className="ocs-form-input"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder="e.g. INC100234"
            />
          </div>

          {/* Actions */}
          <div className="ocs-dialog-actions" style={{ marginTop: "1.25rem" }}>
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              className="ocs-btn ocs-btn-primary"
              disabled={submitting}
            >
              {submitting ? (t("submitting") || "提交中...") : t("ocs_balance_adjust")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
