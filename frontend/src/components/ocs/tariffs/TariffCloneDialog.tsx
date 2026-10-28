/*
 * Clone-target dialog.
 *
 * The list used to clone with a generated id (`{planId}_copy_{epoch}`) and no
 * confirmation, which produced plans nobody intended to keep and ids that leaked
 * a timestamp into the tariff namespace. Naming the target explicitly is the
 * whole point of a clone: the operator decides the identifier before the write.
 *
 * Validation mirrors the server rule (`^[a-zA-Z0-9_-]{3,80}$`) so the dialog
 * rejects locally rather than surfacing `INVALID_PLAN_ID` after a round trip.
 */
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { useI18n } from '../../../providers/I18nProvider';

const PLAN_ID_PATTERN = /^[a-zA-Z0-9_-]{3,80}$/;

interface TariffCloneDialogProps {
  open: boolean;
  sourcePlanId: string;
  onClose: () => void;
  onClone: (targetPlanId: string) => Promise<void>;
}

export default function TariffCloneDialog({ open, sourcePlanId, onClose, onClone }: TariffCloneDialogProps) {
  const { t } = useI18n();
  const [targetId, setTargetId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTargetId(`${sourcePlanId}_copy`.slice(0, 80));
    setError(null);
    setSubmitting(false);
  }, [open, sourcePlanId]);

  const trimmed = targetId.trim();
  const invalid = !PLAN_ID_PATTERN.test(trimmed) || trimmed === sourcePlanId;

  const submit = async () => {
    if (invalid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onClone(trimmed);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('ocs_tariff_action_failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="ocs-dialog"
      overlayClassName="ocs-dialog-overlay"
      labelledBy="ocs-clone-title"
      initialFocusRef={inputRef}
    >
      <div className="ocs-dialog-header">
        <h3 id="ocs-clone-title">{t('ocs_clone_title')}</h3>
      </div>
      <p className="ocs-dialog-copy">{t('ocs_clone_desc', { planId: sourcePlanId })}</p>
      <div className="ocs-form-group">
        <label htmlFor="ocs-clone-target" className="ocs-form-label">{t('ocs_clone_target_id')}</label>
        <input
          id="ocs-clone-target"
          ref={inputRef}
          type="text"
          className="ocs-form-input ocs-mono"
          value={targetId}
          maxLength={80}
          onChange={(event) => setTargetId(event.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'ocs-clone-hint' : undefined}
        />
        {invalid ? (
          <span id="ocs-clone-hint" className="ocs-form-hint ocs-form-hint-error">
            {t('ocs_clone_target_invalid')}
          </span>
        ) : null}
        {error ? <span className="ocs-form-hint ocs-form-hint-error" role="alert">{error}</span> : null}
      </div>
      <div className="ocs-dialog-actions">
        <button type="button" className="ocs-btn ocs-btn-secondary" onClick={onClose} disabled={submitting}>
          {t('cancel')}
        </button>
        <button type="button" className="ocs-btn ocs-btn-primary" onClick={() => void submit()} disabled={invalid || submitting}>
          {submitting ? t('saving') : t('ocs_tariff_clone')}
        </button>
      </div>
    </Dialog>
  );
}
