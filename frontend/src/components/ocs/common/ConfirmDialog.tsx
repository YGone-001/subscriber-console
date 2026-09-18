"use client";

import { useI18n } from "@/components/I18nProvider";
import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();

  return (
    <div className="ocs-dialog-overlay" onClick={onCancel}>
      <div
        className="ocs-dialog"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ocs-dialog-header">
          {danger && <AlertTriangle size={20} className="ocs-dialog-danger-icon" />}
          <h3>{title}</h3>
        </div>
        <p className="ocs-dialog-body">{message}</p>
        <div className="ocs-dialog-actions">
          <button
            type="button"
            className="ocs-btn ocs-btn-secondary"
            onClick={onCancel}
            disabled={loading}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className={`ocs-btn ${danger ? "ocs-btn-danger" : "ocs-btn-primary"}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {confirmLabel || t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
