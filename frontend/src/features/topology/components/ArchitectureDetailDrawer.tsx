/*
 * Architecture node detail drawer.
 *
 * The overlay detail surface for one reference role. It replaces the permanent
 * side panel so the canvas keeps the full workspace width, and it is the one
 * place where every follow-up entry for a role lives:
 *
 *   resource    -> the bound Inventory resource
 *   monitoring  -> the bound NF Health target
 *   alerts      -> the alert console
 *   logs        -> reserved for the log center (not implemented yet)
 *
 * There is deliberately no restart, no command and no log path: this console
 * observes, it does not operate the network function.
 */
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { useDialogFocus } from '../../../components/ui/useDialogFocus';
import { useI18n } from '../../../providers/I18nProvider';
import { formatBytes } from '../../operations/operational-model';
import {
  bindingLabelKey,
  domainLabelKey,
  stateLabelKey,
  type ArchitectureNodeView,
} from '../architecture-model';
import styles from '../../../styles/modules/architecture.module.css';

function toneClass(tone: string): string {
  const map: Record<string, string> = {
    healthy: styles.toneHealthy,
    degraded: styles.toneDegraded,
    unhealthy: styles.toneUnhealthy,
    stale: styles.toneStale,
    unknown: styles.toneUnknown,
    unmonitored: styles.toneUnmonitored,
    unresolved: styles.toneUnresolved,
    observed: styles.toneObserved,
    unregistered: styles.toneUnregistered,
    ambiguous: styles.toneAmbiguous,
  };
  return map[tone] ?? styles.toneUnknown;
}

function domainClass(domain: string): string {
  const map: Record<string, string> = {
    cp: styles.domainCp,
    sp: styles.domainSp,
    up: styles.domainUp,
    dm: styles.domainDm,
    legacy: styles.domainLegacy,
  };
  return map[domain] ?? styles.domainLegacy;
}

function metricText(metric: { value: number; unit: string; fresh: boolean } | null, historical: string): string {
  if (!metric) return '';
  return `${metric.value} ${metric.unit}${metric.fresh ? '' : ` (${historical})`}`;
}

/**
 * An entry that exists but cannot be used yet.
 *
 * Native `disabled` controls are skipped by the keyboard, so their explanation is
 * unreachable. This renders a focusable button that announces itself as disabled
 * and points at a visible note through `aria-describedby`.
 */
function UnavailableEntry({ label, describedBy }: { label: string; describedBy: string }) {
  return (
    <button
      type="button"
      className={`btn btn-secondary ${styles.entryDisabled}`}
      aria-disabled="true"
      aria-describedby={describedBy}
      onClick={(event) => event.preventDefault()}
    >
      {label}
    </button>
  );
}

export function ArchitectureDetailDrawer({
  node,
  onClose,
}: {
  node: ArchitectureNodeView | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useDialogFocus({ open: Boolean(node), onClose });

  if (!node) return null;

  const memory = node.memory ? formatBytes(node.memory.value) : '';
  const cpu = metricText(node.cpu, t('ops_historical'));
  const stateText = t(stateLabelKey(node.tone));

  return (
    <div className={styles.drawerLayer}>
      <div
        className={styles.drawer}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="architecture-detail-title"
        tabIndex={-1}
      >
        <header className={styles.drawerHead}>
          <span className={`${styles.domainBar} ${domainClass(node.domain)}`} aria-hidden="true" />
          <div>
            <h3 id="architecture-detail-title" className={styles.detailTitle}>{node.label}</h3>
            <p className={styles.detailSub}>{t(domainLabelKey(node.domain))}</p>
          </div>
          <button type="button" className={styles.detailClose} onClick={onClose} aria-label={t('close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.drawerBody}>
          <section className={styles.drawerSection} aria-label={t('arch_detail_binding')}>
            <h4 className={styles.drawerSectionTitle}>{t('arch_detail_binding')}</h4>
            <dl className={styles.detailList}>
              <div>
                <dt>{t('status')}</dt>
                <dd><span className={`${styles.stateBadge} ${toneClass(node.tone)}`}>{stateText}</span></dd>
              </div>
              <div>
                <dt>{t('arch_detail_binding')}</dt>
                <dd>{t(bindingLabelKey(node.binding))}</dd>
              </div>
              {node.resourceId ? (
                <>
                  <div>
                    <dt>{t('arch_detail_resource')}</dt>
                    <dd>
                      <Link to={`/inventory/${encodeURIComponent(node.resourceId)}`}>{node.resourceName}</Link>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('arch_detail_lifecycle')}</dt>
                    <dd>{node.lifecycleState || '-'}</dd>
                  </div>
                </>
              ) : null}
            </dl>
          </section>

          {node.binding === 'ambiguous' ? (
            <section className={styles.drawerSection} aria-label={t('arch_candidates_title')}>
              <h4 className={styles.drawerSectionTitle}>{t('arch_candidates_title')}</h4>
              <p className={styles.viewNote}>{t('arch_candidates_note')}</p>
              <ul className={styles.candidateList}>
                {node.candidates.map((candidate) => (
                  <li key={candidate.resourceId} className={styles.candidateItem}>
                    <Link to={`/inventory/${encodeURIComponent(candidate.resourceId)}`}>{candidate.name}</Link>
                    <span className={`${styles.stateBadge} ${toneClass(candidate.tone)}`}>
                      {t(stateLabelKey(candidate.tone))}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={styles.detailMuted}>
                {t('arch_detail_ambiguous_body', { count: node.candidateCount })}
              </p>
            </section>
          ) : null}

          {node.suggestions.length > 0 ? (
            <section className={styles.drawerSection} aria-label={t('arch_suggestions_title')}>
              <h4 className={styles.drawerSectionTitle}>{t('arch_suggestions_title')}</h4>
              <p className={styles.viewNote}>{t('arch_suggestions_note')}</p>
              <ul className={styles.candidateList}>
                {node.suggestions.map((suggestion) => (
                  <li key={suggestion.resourceId} className={styles.candidateItem}>
                    <Link to={`/inventory/${encodeURIComponent(suggestion.resourceId)}`}>
                      {suggestion.name}
                    </Link>
                    <span className={styles.detailMuted}>
                      {t(suggestion.reason === 'name'
                        ? 'arch_suggestion_reason_name'
                        : 'arch_suggestion_reason_name_prefix')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {node.resourceId ? (
            <section className={styles.drawerSection} aria-label={t('arch_detail_monitoring')}>
              <h4 className={styles.drawerSectionTitle}>{t('arch_detail_monitoring')}</h4>
              <dl className={styles.detailList}>
                <div>
                  <dt>{t('arch_detail_coverage')}</dt>
                  <dd className={styles.layerRow}>
                    {node.coverage ? (
                      <>
                        <span className={node.coverage.l1 ? styles.layerOn : styles.layerOff}>L1</span>
                        <span className={node.coverage.l2 ? styles.layerOn : styles.layerOff}>L2</span>
                        <span className={node.coverage.l3 ? styles.layerOn : styles.layerOff}>L3</span>
                      </>
                    ) : t('ops_metric_unavailable')}
                  </dd>
                </div>
                <div>
                  <dt>{t('arch_detail_freshness')}</dt>
                  <dd>{node.freshness ? t(`ops_state_${node.freshness}`) : t('ops_state_unknown')}</dd>
                </div>
                <div>
                  <dt>{t('arch_detail_memory')}</dt>
                  <dd>{memory || t('ops_metric_unavailable')}</dd>
                </div>
                <div>
                  <dt>{t('arch_detail_cpu')}</dt>
                  <dd>{cpu || t('ops_metric_unavailable')}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          <section className={styles.drawerSection} aria-label={t('arch_entry_resource')}>
            <h4 className={styles.drawerSectionTitle}>{t('arch_detail_title')}</h4>
            <div className={styles.entryList}>
              {node.resourceId ? (
                <Link className="btn btn-secondary" to={`/inventory/${encodeURIComponent(node.resourceId)}`}>
                  {t('arch_entry_resource')}
                </Link>
              ) : (
                <UnavailableEntry label={t('arch_entry_resource')} describedBy="arch-entry-resource-reason" />
              )}
              {node.targetId ? (
                <Link className="btn btn-secondary" to={`/nf-health/${encodeURIComponent(node.targetId)}`}>
                  {t('arch_entry_monitoring')}
                </Link>
              ) : (
                <UnavailableEntry
                  label={t('arch_entry_monitoring')}
                  describedBy={node.resourceId ? 'arch-entry-monitoring-reason' : 'arch-entry-resource-reason'}
                />
              )}
              <Link className="btn btn-secondary" to="/nf-alerts">{t('arch_entry_alerts')}</Link>
              <UnavailableEntry label={t('arch_entry_logs')} describedBy="arch-entry-logs-reason" />
            </div>
            {!node.resourceId ? (
              <p id="arch-entry-resource-reason" className={styles.viewNote}>{t('arch_entry_unavailable')}</p>
            ) : null}
            {node.resourceId && !node.targetId ? (
              <p id="arch-entry-monitoring-reason" className={styles.viewNote}>{t('arch_detail_no_monitoring')}</p>
            ) : null}
            <p className={styles.viewNote}>{t('arch_entry_alerts_note')}</p>
            <p id="arch-entry-logs-reason" className={styles.viewNote}>{t('arch_entry_logs_unavailable')}</p>
          </section>

          {node.observed ? (
            <div className={styles.detailNote}>
              <p>
                <strong>{t('arch_detail_observed_process')}:</strong>{' '}
                <code>{node.observed.processName}</code>
              </p>
              <p>{t('arch_detail_observed_body')}</p>
              <Link className={styles.detailAction} to="/inventory?view=runtime">
                {t('arch_detail_manage')}
              </Link>
            </div>
          ) : null}

          {!node.resourceId && !node.observed && node.binding !== 'ambiguous' ? (
            <div className={styles.detailNote}>
              <p>{t('arch_detail_unbound_body')}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ArchitectureDetailDrawer;
