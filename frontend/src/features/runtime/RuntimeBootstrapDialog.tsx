/*
 * Governed bootstrap dialog.
 *
 * The dialog only ever sends the template and an optional component selection.
 * Every identity (host, process, resource, binding, target) is derived and
 * authorized by the backend; the client cannot name a process, path or
 * provenance. Applying requires the plan identifier that the preview returned,
 * so a stale preview is rejected instead of being applied against a changed
 * runtime.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { useI18n } from '../../providers/I18nProvider';
import { applyBootstrap, previewBootstrap } from './runtime-api';
import type { BootstrapApplyResult, BootstrapPlan, BootstrapPlanEntry } from './runtime-types';
import styles from '../../styles/modules/runtime.module.css';

type Props = {
  template: string;
  /**
   * Optional bounded component selection. When provided the preview and the
   * apply are both restricted to this server-recognized component set, which
   * lets discovery surfaces scope the governed flow to the components that
   * match a single observed NF candidate. Omitted by default so the whole
   * template remains the scope (existing callers are unaffected).
   */
  componentIds?: string[];
  onClose: () => void;
  onApplied: () => void;
};

function actionTone(entry: BootstrapPlanEntry): string {
  if (entry.conflicts.length > 0) return styles.toneDanger;
  switch (entry.action) {
    case 'create_resource':
      return styles.toneHealthy;
    case 'reuse_resource':
      return styles.toneStale;
    default:
      return styles.toneMuted;
  }
}

export function RuntimeBootstrapDialog({ template, componentIds, onClose, onApplied }: Props) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<BootstrapPlan | null>(null);
  const [result, setResult] = useState<BootstrapApplyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setPlan(await previewBootstrap(template, componentIds));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : t('runtime_bootstrap_preview_failed'));
    } finally {
      setLoading(false);
    }
  }, [template, componentIds, t]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const eligible = useMemo(
    () => (plan?.entries ?? []).filter((entry) => entry.action === 'create_resource' || entry.action === 'reuse_resource'),
    [plan],
  );
  const conflicts = useMemo(
    () => (plan?.entries ?? []).filter((entry) => entry.conflicts.length > 0),
    [plan],
  );

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      const applied = await applyBootstrap(plan.planId, template, componentIds);
      setResult(applied);
      onApplied();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : t('runtime_bootstrap_apply_failed'));
    } finally {
      setApplying(false);
    }
  };

  const footer = (
    <div className={styles.dialogFooter}>
      <button type="button" className={styles.button} onClick={onClose}>
        {t('runtime_bootstrap_close')}
      </button>
      <button
        type="button"
        className={styles.button}
        onClick={loadPreview}
        disabled={loading || applying}
      >
        {t('runtime_bootstrap_repreview')}
      </button>
      <button
        type="button"
        className={styles.primaryButton}
        onClick={apply}
        disabled={!plan || loading || applying || eligible.length === 0}
      >
        <ShieldCheck size={15} /> {applying ? t('runtime_bootstrap_applying') : t('runtime_bootstrap_apply')}
      </button>
    </div>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('runtime_bootstrap_title')}
      maxWidth="960px"
      footer={footer}
    >
      <p className={styles.dialogNote}>{t('runtime_bootstrap_note')}</p>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {loading ? (
        <p className={styles.dialogLoading}>{t('runtime_bootstrap_loading')}</p>
      ) : !plan ? (
        <p className={styles.error}>{t('runtime_bootstrap_unavailable')}</p>
      ) : (
        <>
          <dl className={styles.dialogSummary}>
            <div><dt>{t('runtime_bootstrap_host')}</dt><dd><code>{plan.hostId}</code></dd></div>
            <div><dt>{t('runtime_bootstrap_template')}</dt><dd>{t(`runtime_template_${plan.template}`)}</dd></div>
            <div><dt>{t('runtime_bootstrap_plan')}</dt><dd><code>{plan.planId}</code></dd></div>
            <div><dt>{t('runtime_bootstrap_create')}</dt><dd>{plan.counts.create}</dd></div>
            <div><dt>{t('runtime_bootstrap_reuse')}</dt><dd>{plan.counts.reuse}</dd></div>
            <div><dt>{t('runtime_bootstrap_skipped')}</dt><dd>{plan.counts.skipped}</dd></div>
          </dl>

          {conflicts.length > 0 ? (
            <div className={styles.dialogConflicts} role="alert">
              <p><AlertTriangle size={15} aria-hidden="true" /> {t('runtime_bootstrap_conflicts', { count: conflicts.length })}</p>
              <ul>
                {conflicts.map((entry) => (
                  <li key={entry.componentId}>
                    <strong>{entry.displayName}</strong>: {entry.conflicts.join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className={styles.caption}>{t('runtime_bootstrap_plan_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('runtime_col_component')}</th>
                  <th scope="col">{t('runtime_col_status')}</th>
                  <th scope="col">{t('runtime_bootstrap_col_action')}</th>
                  <th scope="col">{t('runtime_bootstrap_col_resource')}</th>
                  <th scope="col">{t('runtime_bootstrap_col_target')}</th>
                  <th scope="col">{t('runtime_bootstrap_col_binding')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.entries.map((entry) => (
                  <tr key={entry.componentId}>
                    <th scope="row" className={styles.nameCell}>
                      <span className={styles.componentName}>{entry.displayName}</span>
                      <code className={styles.processName}>{entry.processName}</code>
                    </th>
                    <td><span className={`${styles.badge} ${styles.toneMuted}`}>{t(`runtime_status_${entry.runtimeStatus}`)}</span></td>
                    <td>
                      <span className={`${styles.badge} ${actionTone(entry)}`}>
                        {t(`runtime_action_${entry.action}`)}
                      </span>
                      <span className={styles.actionReason}>{entry.reason}</span>
                    </td>
                    <td className={styles.mono}>
                      {entry.proposedResource
                        ? `${entry.proposedResource.name} (${t('runtime_bootstrap_new')})`
                        : entry.resourceName ?? '-'}
                    </td>
                    <td className={styles.mono}>
                      {entry.proposedTarget
                        ? `${entry.proposedTarget.collectorProfile} / ${entry.proposedTarget.collectionMode} / ${entry.proposedTarget.intervalSeconds}s`
                        : entry.targetId ?? '-'}
                    </td>
                    <td className={styles.mono}>{entry.binding ? entry.binding.processName : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result ? (
            <div className={styles.dialogResult} role="status">
              <p>{t('runtime_bootstrap_applied', { created: result.counts.create, reused: result.counts.reuse, skipped: result.counts.skipped })}</p>
              <ul>
                {result.entries.map((entry) => (
                  <li key={entry.componentId}>
                    <strong>{entry.componentId}</strong>: {t(`runtime_apply_${entry.action}`)}
                    {entry.resourceId ? ` - ${entry.resourceId}` : ''}
                    {entry.targetId ? ` / ${entry.targetId}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}
