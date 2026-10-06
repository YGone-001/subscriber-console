/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/SubscriberBatchUpdateModal.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { AlertTriangle, ClipboardCheck, Save, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { OperationNotice } from './ui/OperationFeedback';
import { Dialog } from './ui/Dialog';
import { useI18n } from '../providers/I18nProvider';
import { postJson } from '../lib/api/mutation-client';

type BatchUpdateResponse = { outcome?: string; result?: { modified?: number } };
type Props = { isOpen: boolean; selectedImsis: string[]; onClose: () => void; onSuccess: (response: BatchUpdateResponse) => void };

export default function SubscriberBatchUpdateModal({ isOpen, selectedImsis, onClose, onSuccess }: Props) {
  const { t } = useI18n();
  const [accessRestrictionData, setAccessRestrictionData] = useState("");
  const [changeDownlink, setChangeDownlink] = useState(false);
  const [downlinkValue, setDownlinkValue] = useState("100");
  const [reason, setReason] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previewImsis = useMemo(() => selectedImsis.slice(0, 3), [selectedImsis]);
  const hasPatch = Boolean(accessRestrictionData) || changeDownlink;

  useEffect(() => { if (isOpen) setError(null); }, [isOpen]);
  if (!isOpen) return null;

  const submit = async () => {
    if (!hasPatch) { setError(t('sub_batch_validation_field')); return; }
    if (reason.trim().length < 3) { setError(t('sub_batch_validation_reason')); return; }
    const numericDownlink = Number(downlinkValue);
    if (changeDownlink && (!Number.isSafeInteger(numericDownlink) || numericDownlink < 1 || numericDownlink > 10_000_000)) { setError(t('sub_batch_validation_downlink')); return; }
    setIsSaving(true); setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (accessRestrictionData) patch.accessRestrictionData = Number(accessRestrictionData);
      if (changeDownlink) patch.ambr = { downlink: { value: numericDownlink, unit: 3 } };
      const body = await postJson<BatchUpdateResponse>('/api/subscribers/batch-update', {
        imsis: selectedImsis,
        patch,
        reason: reason.trim(),
        ticketId: ticketId.trim() || undefined,
      });
      onSuccess(body); onClose();
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : t('sub_batch_error_message')); }
    finally { setIsSaving(false); }
  };

  const changedFields = [
    accessRestrictionData ? t('sub_batch_access_restriction') : null,
    changeDownlink ? t('sub_batch_downlink') : null,
  ].filter(Boolean).join(', ') || t('sub_batch_none_selected');

  return (
    <Dialog open={isOpen} onClose={() => { if (!isSaving) onClose(); }} overlayClassName="modal-overlay" className="modal-content animate-modal-enter bu-modal-content" labelledBy="subscriber-batch-update-title" initialFocusRef={cancelRef} closeOnOverlay={!isSaving}>
      <div className="workflow-header bu-header">
        <div>
          <h2 id="subscriber-batch-update-title" className="bu-title"><Settings2 size={18} /> {t('sub_batch_update_title')}</h2>
          <p>{t('sub_batch_update_desc')}</p>
        </div>
        <button type="button" className="btn-icon" onClick={onClose} aria-label={t('close')} disabled={isSaving}><X size={22} /></button>
      </div>
      <div className="bu-body">
        <div className="bu-warning"><AlertTriangle size={17} /><span>{t('sub_batch_update_warning')}</span></div>
        <div className="bu-grid">
          <label className="form-label">
            {t('sub_batch_access_restriction')}
            <select className="form-input" value={accessRestrictionData} onChange={(event) => setAccessRestrictionData(event.target.value)}>
              <option value="">{t('sub_batch_no_change')}</option>
              <option value="32">{t('sub_batch_access_normal')}</option>
              <option value="255">{t('sub_batch_access_restricted')}</option>
            </select>
          </label>
          <label className="bu-check"><input type="checkbox" checked={changeDownlink} onChange={(event) => setChangeDownlink(event.target.checked)} /> {t('sub_batch_change_downlink')}</label>
          {changeDownlink ? (
            <label className="form-label">
              {t('sub_batch_downlink_value')}
              <input className="form-input" inputMode="numeric" value={downlinkValue} onChange={(event) => setDownlinkValue(event.target.value.replace(/\D/g, ''))} />
            </label>
          ) : null}
        </div>
        <label className="form-label">
          {t('sub_batch_reason')}
          <textarea className="form-input" rows={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('sub_batch_reason_placeholder')} />
        </label>
        <label className="form-label">
          {t('sub_batch_ticket')}
          <input className="form-input" maxLength={200} value={ticketId} onChange={(event) => setTicketId(event.target.value)} placeholder="CHG-20260828-001" />
        </label>
        <section className="bu-preview" aria-label={t('sub_batch_preview')}>
          <div><ClipboardCheck size={16} /> {t('sub_batch_preview')}</div>
          <dl>
            <div><dt>{t('sub_batch_target')}</dt><dd>{selectedImsis.length}</dd></div>
            <div><dt>{t('sub_batch_fields')}</dt><dd>{changedFields}</dd></div>
          </dl>
          <code>{previewImsis.join(', ')}{selectedImsis.length > previewImsis.length ? ` +${selectedImsis.length - previewImsis.length}` : ''}</code>
        </section>
        {error ? <OperationNotice presentation="modal" tone="danger" title={t('sub_batch_error_title')} message={error} onClose={() => setError(null)} /> : null}
      </div>
      <div className="workflow-footer bu-footer">
        <span>{t('sub_batch_server_revalidate')}</span>
        <div className="workflow-footer-actions">
          <button ref={cancelRef} type="button" className="btn btn-outline" onClick={onClose} disabled={isSaving}>{t('cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={isSaving || selectedImsis.length === 0}>
            <Save size={16} />{isSaving ? t('sub_batch_executing') : t('sub_batch_execute')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
