"use client";

import { useMemo } from 'react';
import VisualDiffViewer from '@/components/VisualDiffViewer';
import { useI18n } from '@/components/I18nProvider';
import { sanitizeAuditPayload } from '@/lib/audit/sanitize';
import styles from './governance.module.css';

interface ChangeDiffProps {
  before?: unknown;
  after?: unknown;
  title?: string;
  compact?: boolean;
}

/** Reuse the existing telecom-aware field diff; never build a second diff engine. */
export function ChangeDiff({ before, after, title, compact }: ChangeDiffProps) {
  const { t } = useI18n();
  const sanitized = useMemo(() => ({
    before: sanitizeAuditPayload(before), after: sanitizeAuditPayload(after),
  }), [before, after]);
  const preview = JSON.stringify(sanitized, null, 2);
  const complete = before !== undefined && after !== undefined
    && !/\[TRUNCATED\]|\[UNSERIALIZABLE\]|\[CIRCULAR\]|"_truncated": true/.test(preview);
  return <div className={styles.diff}>
    {complete ? <VisualDiffViewer
      oldData={sanitized.before}
      newData={sanitized.after}
      title={title}
      defaultMode="semantic"
      compact={compact}
      showControls={false}
    /> : <p className={styles.muted}>{t('governance_snapshot_missing')}</p>}
    <details className={styles.raw}>
      <summary>{t('governance_raw_json')}</summary>
      <pre>{preview}</pre>
    </details>
  </div>;
}
