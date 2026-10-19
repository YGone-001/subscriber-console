/*
 * Resource detail drawer.
 *
 * The in-place detail surface for one Inventory resource. It renders the server
 * projection only: identity, monitoring association, layered coverage, freshness,
 * runtime binding and the resource-category metrics.
 *
 * Integrity rules:
 *   - an unresolved association is stated as unresolved, never as unmonitored;
 *   - a layer that was not measured is stated as not configured, never healthy;
 *   - an unavailable measurement renders as "-", never as zero;
 *   - no restart, no log path and no command line is offered here.
 */
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { useDialogFocus } from '../../components/ui/useDialogFocus';
import { useI18n } from '../../providers/I18nProvider';
import {
  cpuView,
  formatBytes,
  memoryView,
  type OperationalResource,
} from './operational-model';
import styles from '../../styles/modules/operations.module.css';

const KNOWN_STATES = [
  'healthy', 'degraded', 'unhealthy', 'unknown', 'stale',
  'not_configured', 'not_monitored', 'fresh', 'unresolved',
];

function stateLabel(state: string, t: (key: string) => string): string {
  if (!state) return t('ops_state_unknown');
  return KNOWN_STATES.includes(state) ? t(`ops_state_${state}`) : state;
}

function valueOrDash(value: string | undefined, t: (key: string) => string): string {
  return value && value.trim() ? value : `- ${t('ops_metric_unavailable')}`;
}

export function ResourceDetailDrawer({
  resource,
  onClose,
}: {
  resource: OperationalResource | null;
  onClose: () => void;
}) {
  const { t, formatDateTime } = useI18n();
  const dialogRef = useDialogFocus({ open: Boolean(resource), onClose });

  if (!resource) return null;

  const monitoring = resource.monitoring;
  const coverage = monitoring?.coverage ?? null;
  const binding = resource.runtimeBinding;
  const cpu = cpuView(monitoring);
  const memory = memoryView(monitoring);
  const overall = monitoring?.overallState ?? '';

  const layerRows: Array<{ label: string; measured: boolean; available: boolean }> = [
    { label: t('ops_layer_l1'), measured: Boolean(coverage?.l1Measured), available: true },
    { label: t('ops_layer_l2'), measured: Boolean(coverage?.l2Measured), available: true },
    { label: t('ops_layer_l3'), measured: Boolean(coverage?.l3Measured), available: Boolean(coverage?.l3Available) },
  ];

  return (
    <div className={styles.drawerLayer}>
      <div
        className={styles.drawer}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-drawer-title"
        tabIndex={-1}
      >
        <header className={styles.drawerHead}>
          <div className={styles.drawerHeadCopy}>
            <h2 id="resource-drawer-title" className={styles.drawerTitle}>{resource.name}</h2>
            <code className={styles.uuid}>{resource.resourceId}</code>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label={t('close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.drawerBody}>
          <section className={styles.detailSection} aria-label={t('ops_detail_identity')}>
            <h3 className={styles.detailTitle}>{t('ops_detail_identity')}</h3>
            <dl className={styles.detailGrid}>
              <div>
                <dt>{t('ops_col_kind')}</dt>
                <dd><code className={styles.chip}>{resource.kind || '-'}</code></dd>
              </div>
              <div>
                <dt>{t('ops_col_domain')}</dt>
                <dd>{t(`ops_domain_${resource.domain}`)}</dd>
              </div>
              <div>
                <dt>{t('ops_col_type')}</dt>
                <dd>{resource.typeLabel}</dd>
              </div>
              <div>
                <dt>{t('ops_col_lifecycle')}</dt>
                <dd>{resource.lifecycleState || '-'}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.detailSection} aria-label={t('ops_detail_monitoring')}>
            <h3 className={styles.detailTitle}>{t('ops_detail_monitoring')}</h3>
            <dl className={styles.detailGrid}>
              <div>
                <dt>{t('ops_association')}</dt>
                <dd>
                  <span className={`${styles.stateBadge} ${associationTone(resource.association)}`}>
                    {t(`ops_association_${resource.association}`)}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t('ops_col_status')}</dt>
                <dd>
                  {monitoring
                    ? <span className={`${styles.stateBadge} ${stateTone(overall)}`}>{stateLabel(overall, t)}</span>
                    : `- ${t('ops_state_not_monitored')}`}
                </dd>
              </div>
              <div>
                <dt>{t('ops_detail_freshness')}</dt>
                <dd>
                  {monitoring
                    ? stateLabel(monitoring.freshnessState, t)
                    : `- ${t('ops_metric_unavailable')}`}
                  {monitoring?.freshnessAgeSeconds != null
                    ? ` · ${monitoring.freshnessAgeSeconds}s / ${monitoring.freshnessPolicySeconds ?? '-'}s`
                    : ''}
                </dd>
              </div>
              <div>
                <dt>{t('ops_detail_target')}</dt>
                <dd>
                  {monitoring?.targetId ? (
                    <Link to={`/nf-health/${encodeURIComponent(monitoring.targetId)}`} className={styles.rowLink}>
                      {t('ops_open_monitoring')}
                    </Link>
                  ) : resource.association === 'unresolved'
                    ? `- ${t('ops_association_unresolved')}`
                    : `- ${t('ops_association_absent')}`}
                </dd>
              </div>
              <div>
                <dt>{t('ops_detail_last_run')}</dt>
                <dd>
                  {monitoring?.lastRunStatus
                    ? `${monitoring.lastRunStatus} · ${valueOrDash(monitoring.lastRunAt, t)}`
                    : `- ${t('ops_metric_unavailable')}`}
                </dd>
              </div>
              <div>
                <dt>{t('ops_detail_latest_sample')}</dt>
                <dd>{monitoring?.latestSampleAt ? formatDateTime(monitoring.latestSampleAt) : `- ${t('ops_metric_unavailable')}`}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.detailSection} aria-label={t('ops_detail_layers')}>
            <h3 className={styles.detailTitle}>{t('ops_detail_layers')}</h3>
            <ul className={styles.layerList}>
              {layerRows.map((row) => (
                <li key={row.label} className={styles.layerItem}>
                  <span className={styles.layerName}>{row.label}</span>
                  <span className={row.measured ? styles.layerMeasured : styles.layerMissing}>
                    {row.measured
                      ? t('ops_layer_measured')
                      : row.available
                        ? t('ops_layer_not_configured')
                        : t('ops_state_not_configured')}
                  </span>
                </li>
              ))}
            </ul>
            <p className={styles.detailNote}>{t('ops_footnote_layers')}</p>
          </section>

          <section className={styles.detailSection} aria-label={t('ops_detail_runtime')}>
            <h3 className={styles.detailTitle}>{t('ops_detail_runtime')}</h3>
            <dl className={styles.detailGrid}>
              <div>
                <dt>{t('ops_detail_runtime')}</dt>
                <dd>
                  <span className={styles.chip}>
                    {binding ? t(`ops_binding_${binding.state}`) : t('ops_binding_unknown')}
                  </span>
                  {binding?.unit ? <code className={styles.uuid}>{binding.unit}</code> : null}
                </dd>
              </div>
            </dl>
            <p className={styles.detailNote}>{t('ops_binding_hint')}</p>
          </section>

          <section className={styles.detailSection} aria-label={t('ops_detail_metrics')}>
            <h3 className={styles.detailTitle}>{t('ops_detail_metrics')}</h3>
            <dl className={styles.detailGrid}>
              <div>
                <dt>{t('ops_col_cpu')}</dt>
                <dd>
                  {cpu
                    ? `${cpu.value} ${cpu.unit}${cpu.fresh ? '' : ` (${t('ops_historical')})`}`
                    : `- ${t('ops_metric_unavailable')}`}
                </dd>
              </div>
              <div>
                <dt>{t('ops_col_memory')}</dt>
                <dd>
                  {memory
                    ? `${formatBytes(memory.value)}${memory.fresh ? '' : ` (${t('ops_historical')})`}`
                    : `- ${t('ops_metric_unavailable')}`}
                </dd>
              </div>
            </dl>
            <p className={styles.detailNote}>{t('ops_ne_footnote')}</p>
          </section>

          <div className={styles.drawerActions}>
            <Link className="btn btn-secondary" to={`/inventory/${encodeURIComponent(resource.resourceId)}`}>
              {t('ops_open_resource')}
            </Link>
            {monitoring?.targetId ? (
              <Link className="btn btn-secondary" to={`/nf-health/${encodeURIComponent(monitoring.targetId)}`}>
                {t('ops_open_monitoring')}
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function stateTone(state: string): string {
  switch (state) {
    case 'healthy':
      return styles.toneHealthy;
    case 'degraded':
      return styles.toneWarning;
    case 'unhealthy':
      return styles.toneDanger;
    case 'stale':
      return styles.toneStale;
    default:
      return styles.toneUnknown;
  }
}

function associationTone(association: OperationalResource['association']): string {
  if (association === 'confirmed') return styles.toneHealthy;
  if (association === 'absent') return styles.toneMuted;
  return styles.toneWarning;
}

export default ResourceDetailDrawer;
