/*
 * NF Health card wall: the duty queue.
 *
 * Presentation only. The page owns the target read, the cursor, the URL filters
 * and the runtime-observation projection; this component renders exactly what
 * it is given, in exactly the order it is given.
 *
 * The server decides the risk order, so the card wall never re-sorts: grouping
 * partitions the received sequence into its server-derived domains and keeps
 * each domain's incoming order. Re-sorting here would silently replace the
 * "what needs attention now" answer with an alphabetical list.
 */
import { Link } from 'react-router-dom';
import { useI18n } from '../../providers/I18nProvider';
import type { RuntimeComponent } from '../runtime/runtime-types';
import type { HealthTargetSummary } from './nf-health-types';
import { UtilizationBar, coverageBadge, formatTimestamp, layerAvailable, overallBadge } from './nf-health-badges';
import styles from '../../styles/modules/nf-health.module.css';

/** One server-derived domain and the targets it owns, in server order. */
export type HealthDomainGroup = {
  domain: string;
  label: string;
  targets: HealthTargetSummary[];
};

export type NfHealthTargetCardsProps = {
  /** Server-ordered targets partitioned by domain. */
  groups: HealthDomainGroup[];
  /** Detail link for one target, already carrying the return-to context. */
  detailHref: (targetId: string) => string;
  /** Opens the evidence drawer for one target. */
  onOpenTarget: (target: HealthTargetSummary) => void;
  /**
   * Resolves the runtime observation the page projected for a target. The page
   * owns that projection; this component never derives process evidence itself.
   */
  resolveRuntimeComponent: (target: HealthTargetSummary) => RuntimeComponent | undefined;
};

export function NfHealthTargetCards({
  groups,
  detailHref,
  onOpenTarget,
  resolveRuntimeComponent,
}: NfHealthTargetCardsProps) {
  const { t } = useI18n();
  return (
    <div className={styles.cardWall}>
      {groups.map((group) => (
        <div key={group.domain} className={styles.cardGroup}>
          <h3 className={styles.cardGroupTitle}>{group.label}</h3>
          <div className={styles.cardGrid}>
            {group.targets.map((target) => {
              const runtimeComponent = resolveRuntimeComponent(target);
              return (
                <article key={target.targetId} className={styles.targetCard}>
                  <button
                    type="button"
                    className={styles.targetCardMain}
                    data-nf-health-card={target.targetId}
                    onClick={() => onOpenTarget(target)}
                    aria-label={t('nf_health_open_drawer', { name: target.name })}
                  >
                    <header className={styles.targetCardHead}>
                      <strong className={styles.targetCardName}>{target.name}</strong>
                      <span className={styles.targetCardType}>{target.nfType ?? '-'}</span>
                    </header>
                    <div className={styles.targetCardStatus}>{overallBadge(target, t)}</div>
                    <div className={styles.targetCardBadges}>
                      {coverageBadge(layerAvailable(target.layers?.process?.state), target.coverage.l1Measured, t, 'L1')}
                      {coverageBadge(layerAvailable(target.layers?.interface?.state), target.coverage.l2Measured, t, 'L2')}
                      {coverageBadge(target.coverage.l3Available, target.coverage.l3Measured, t, 'L3')}
                    </div>
                    <UtilizationBar
                      label={t('nf_health_card_memory')}
                      available={Boolean(runtimeComponent?.memoryAvailable)}
                      percent={runtimeComponent?.memoryPercent ?? null}
                    />
                    <UtilizationBar
                      label={t('nf_health_card_cpu')}
                      available={Boolean(runtimeComponent?.cpuAvailable)}
                      percent={runtimeComponent?.cpuPercent ?? null}
                    />
                  </button>
                  <footer className={styles.targetCardFoot}>
                    <span className={styles.targetCardMeta}>{formatTimestamp(target.lastMeasuredAt)}</span>
                    <Link to={detailHref(target.targetId)} className={styles.rowLink}>
                      {t('nf_health_open_detail')}
                    </Link>
                  </footer>
                </article>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
