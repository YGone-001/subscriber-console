/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/OcsDetailDrawer.tsx
 *
 * Adaptations: "use client" dropped; the `@/components/...` alias replaced with a
 * relative import. The two section headings were hard-coded English in the
 * reference, which would render untranslated on the Chinese surface, so they now
 * resolve through the dictionary (`ocs_drawer_structured_attributes`,
 * `ocs_drawer_raw_json`). DOM structure and class vocabulary are unchanged.
 */
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { useI18n } from '../../providers/I18nProvider';

interface OcsDetailDrawerProps {
  title: string;
  data: Record<string, unknown> | null;
  onClose: () => void;
  fields?: Array<{ label: string; value: ReactNode }>;
}

export default function OcsDetailDrawer({
  title,
  data,
  onClose,
  fields,
}: OcsDetailDrawerProps) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  if (!data) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Clipboard access can be denied; the affordance simply stays idle. */
    }
  };

  return (
    <Dialog
      open={Boolean(data)}
      onClose={onClose}
      overlayClassName="ocs-drawer-backdrop"
      className="ocs-drawer-content"
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocusRef={closeButtonRef}
    >
      <div className="ocs-drawer-header">
        <div className="ocs-drawer-title-group">
          <h2 id={titleId} className="ocs-drawer-title">{title}</h2>
          <span id={descriptionId} className="ocs-drawer-subtitle">
            {t('ocs_modal_detail_title')}
          </span>
        </div>
        <div className="ocs-drawer-header-actions">
          <button
            ref={closeButtonRef}
            type="button"
            className="ocs-btn"
            onClick={handleCopy}
            title={t('ocs_modal_copy_json')}
          >
            {copied ? <Check size={14} color="var(--status-success)" /> : <Copy size={14} />}
            <span>{copied ? t('ocs_modal_copied') : t('ocs_modal_copy_json')}</span>
          </button>
          <button
            type="button"
            className="ocs-btn"
            onClick={onClose}
            aria-label={t('close')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="ocs-drawer-body">
        {fields && fields.length > 0 ? (
          <div className="ocs-drawer-section">
            <span className="ocs-drawer-section-title">{t('ocs_drawer_structured_attributes')}</span>
            <div className="ocs-detail-grid">
              {fields.map((field, index) => (
                <div key={index} className="ocs-detail-item">
                  <span className="ocs-detail-item-label">{field.label}</span>
                  <span className="ocs-detail-item-value ocs-mono">{field.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="ocs-drawer-section">
          <span className="ocs-drawer-section-title">{t('ocs_drawer_raw_json')}</span>
          <pre className="ocs-json-view">{JSON.stringify(data, null, 2)}</pre>
        </div>
      </div>
    </Dialog>
  );
}
