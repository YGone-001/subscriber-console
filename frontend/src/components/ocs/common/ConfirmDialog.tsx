/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/common/ConfirmDialog.tsx
 *
 * Adaptations: "use client" dropped; the `@/components/...` alias replaced with a
 * relative import. This is the OCS-domain confirmation surface, distinct from the
 * generic application dialog: it keeps the historical `ocs-dialog-*` markup so
 * the ported `ocs.css` rules apply.
 */
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';

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
        onClick={(event) => event.stopPropagation()}
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
            {t('cancel')}
          </button>
          <button
            type="button"
            className={`ocs-btn ${danger ? 'ocs-btn-danger' : 'ocs-btn-primary'}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {confirmLabel || t('confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
