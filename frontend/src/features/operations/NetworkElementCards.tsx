/*
 * Network-element card wall.
 *
 * The scannable presentation of the same projection the table renders: one card
 * per Inventory resource, grouped by canonical domain, with the monitoring state,
 * the three layer-coverage marks and the resident memory. It answers "what do I
 * run, and what is wrong" at a glance; the table remains the audit view.
 *
 * Integrity rules:
 *   - an unresolved association is never rendered as unmonitored;
 *   - a layer that was not measured is rendered as not configured, never as
 *     healthy;
 *   - memory is rendered only when the server returned a sample.
 */
import { Link } from 'react-router-dom';
import { ArrowUpRight, Boxes } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState } from '../../components/ui/OperationFeedback';
import {
  formatBytes,
  memoryView,
  OPERATIONAL_DOMAINS,
  operationalStateToken,
  type DomainKey,
  type OperationalResource,
} from './operational-model';
import type { RuntimeComponent } from '../runtime/runtime-types';
import styles from '../../styles/modules/network-cards.module.css';

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
    case 'unresolved':
      return styles.toneMuted;
    default:
      return styles.toneUnknown;
  }
}

function stateLabel(state: string, t: (key: string) => string): string {
  const known = [
    'healthy', 'degraded', 'unhealthy', 'unknown', 'stale',
    'not_configured', 'not_monitored', 'fresh', 'unresolved',
  ];
  if (!state) return t('ops_state_unknown');
  return known.includes(state) ? t(`ops_state_${state}`) : state;
}

const GROUP_ORDER: DomainKey[] = [...OPERATIONAL_DOMAINS, 'unknown'];

export function NetworkElementCards({ items }: { items: OperationalResource[] }) {
  const { t } = useI18n();

  const groups = GROUP_ORDER
    .map((domain) => ({ domain, items: items.filter((item) => item.domain === domain) }))
    .filter((group) => group.items.length > 0);

  if (groups.length === 0) {
    return (
      <EmptyState icon={<Boxes size={40} />} title={t('ops_empty_title')} description={t('ops_empty_body')} />
    );
  }

  return (
    <div className={styles.groups}>
      {groups.map((group) => {
        const monitored = group.items.filter((item) => item.association === 'confirmed').length;
        return (
          <section key={group.domain} className={styles.group} aria-label={t(`ops_domain_${group.domain}`)}>
            <header className={styles.groupHead}>
              <h3 className={styles.groupTitle}>{t(`ops_domain_${group.domain}`)}</h3>
              <span className={styles.groupMeta}>
                {t('ops_domain_group_meta', { monitored, registered: group.items.length })}
              </span>
            </header>
            <ul className={styles.grid}>
              {group.items.map((item) => {
                const state = operationalStateToken(item);
                const memory = memoryView(item.monitoring);
                const coverage = item.monitoring?.coverage ?? null;
                return (
                  <li key={item.resourceId} className={styles.card}>
                    <div className={styles.cardHead}>
                      <Link className={styles.cardName} to={`/inventory/${encodeURIComponent(item.resourceId)}`}>
                        {item.name}
                      </Link>
                      <span className={`${styles.stateBadge} ${stateTone(state)}`}>{stateLabel(state, t)}</span>
                    </div>
                    <p className={styles.cardMeta}>
                      <span className={styles.cardType}>{item.typeLabel}</span>
                      {item.lifecycleState ? <span className={styles.cardLifecycle}>{item.lifecycleState}</span> : null}
                    </p>
                    <div className={styles.layerRow}>
                      <span className={coverage?.l1Measured ? styles.layerOn : styles.layerOff}>
                        {t('ops_layer_l1')} {coverage?.l1Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')}
                      </span>
                      <span className={coverage?.l2Measured ? styles.layerOn : styles.layerOff}>
                        {t('ops_layer_l2')} {coverage?.l2Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')}
                      </span>
                      <span className={coverage?.l3Measured ? styles.layerOn : styles.layerOff}>
                        {t('ops_layer_l3')} {coverage?.l3Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')}
                      </span>
                    </div>
                    <div className={styles.cardFoot}>
                      <span className={styles.cardMetric}>
                        {t('ops_memory')}{' '}
                        {memory ? `${formatBytes(memory.value)}${memory.fresh ? '' : ` (${t('ops_historical')})`}` : t('ops_metric_unavailable')}
                      </span>
                      {item.monitoring ? (
                        <Link className={styles.cardLink} to={`/nf-health/${encodeURIComponent(item.monitoring.targetId)}`}>
                          {t('ops_open_monitoring')}
                        </Link>
                      ) : (
                        <span className={styles.cardMuted}>{t('ops_card_no_monitoring')}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Observed processes with no Inventory resource.
 *
 * A verified running process that is not associated with a resource is real
 * operational evidence and must be visible, but it is neither monitored nor a
 * fault. Managing it happens through the runtime view's governed bootstrap.
 */
export function UnmanagedProcesses({ components }: { components: RuntimeComponent[] }) {
  const { t } = useI18n();
  const unmanaged = components.filter(
    (component) => component.verified
      && component.runtimeStatus === 'running'
      && component.inventoryAssociation.state === 'absent',
  );

  if (unmanaged.length === 0) return null;

  return (
    <section className={styles.unmanaged} aria-label={t('ops_unmanaged_title')}>
      <header className={styles.unmanagedHead}>
        <h3 className={styles.unmanagedTitle}>{t('ops_unmanaged_title')}</h3>
        <span className={styles.unmanagedCount}>{unmanaged.length}</span>
        <Link className={styles.cardLink} to="/inventory?view=runtime">
          {t('ops_unmanaged_open')}
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      </header>
      <p className={styles.unmanagedNote}>{t('ops_unmanaged_note')}</p>
      <ul className={styles.unmanagedList}>
        {unmanaged.map((component) => (
          <li key={component.componentId} className={styles.unmanagedItem}>
            <span className={styles.unmanagedName}>{component.displayName}</span>
            <code className={styles.unmanagedProcess}>{component.processName}</code>
            <span className={styles.unmanagedMeta}>
              {t('ops_unmanaged_pid')} {component.primaryPid || '-'}
            </span>
            <span className={styles.unmanagedMeta}>
              {component.memoryRssBytes != null ? formatBytes(component.memoryRssBytes) : t('ops_metric_unavailable')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default NetworkElementCards;
