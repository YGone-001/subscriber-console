/*
 * OCS confirmation dialog.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903) and
 * kept as the OCS-domain confirmation surface, distinct from the generic
 * application dialog: it preserves the `ocs-dialog-*` markup so the ported
 * `ocs.css` rules apply.
 *
 * The only change is behavioural and invisible in the DOM: the dialog now mounts
 * through the shared `Dialog`, which traps focus, closes on Escape, restores the
 * previously focused element and marks the background inert. The previous markup
 * carried `role="alertdialog"` and `aria-modal` without any of that, so keyboard
 * users could tab into the page behind a blocking confirmation.
 */
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { Dialog } from '../../ui/Dialog';

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
    <Dialog
      open
      onClose={onCancel}
      className="ocs-dialog"
      overlayClassName="ocs-dialog-overlay"
      labelledBy="ocs-confirm-title"
      role="alertdialog"
      closeOnOverlay={!loading}
    >
      <div className="ocs-dialog-header">
        {danger && <AlertTriangle size={20} className="ocs-dialog-danger-icon" aria-hidden="true" />}
        <h3 id="ocs-confirm-title">{title}</h3>
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
    </Dialog>
  );
}
