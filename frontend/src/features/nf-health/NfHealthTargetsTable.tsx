/*
 * NF Health audit table.
 *
 * A different in-page view of the same authoritative target list, never a
 * second read: it renders the exact array the card wall renders, in the exact
 * server order, and keeps the same cursor page.
 *
 * Visibility is not authorization. The collection action is rendered only for
 * an operator who holds the configure permission, and even then the backend
 * re-checks it; a rendered row never grants a mutation.
 */
import { Link } from 'react-router-dom';
import { Boxes, Link2, Play } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import type { HealthTargetSummary } from './nf-health-types';
import {
  coverageBadge,
  layerAvailable,
  formatTimestamp,
  freshnessBadge,
} from './nf-health-badges';
import styles from '../../styles/modules/nf-health.module.css';

export type NfHealthTargetsTableProps = {
  /** The authoritative target list, in server order. */
  targets: HealthTargetSummary[];
  /** True when the signed-in principal holds core.configure. */
  canConfigure: boolean;
  /** Target currently collecting, so a second click cannot double-fire. */
  collectingId: string | null;
  /** Governed manual collection for one target. */
  onCollect: (target: HealthTargetSummary) => void;
  /** Plain detail link used by the target name. */
  targetHref: (targetId: string) => string;
  /** Detail navigation that carries the return-to context. */
  onOpenDetail: (targetId: string) => void;
};

export function NfHealthTargetsTable({
  targets,
  canConfigure,
  collectingId,
  onCollect,
  targetHref,
  onOpenDetail,
}: NfHealthTargetsTableProps) {
  const { t } = useI18n();
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className="sr-only">{t('nf_health_targets_caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('nf_health_col_name')}</th>
            <th scope="col">{t('nf_health_col_nf_type')}</th>
            <th scope="col">{t('nf_health_col_mode')}</th>
            <th scope="col">{t('nf_health_col_l1')}</th>
            <th scope="col">{t('nf_health_col_l2')}</th>
            <th scope="col">{t('nf_health_col_l3')}</th>
            <th scope="col">{t('nf_health_col_last_measured')}</th>
            <th scope="col">{t('nf_health_evidence_freshness')}</th>
            <th scope="col">{t('nf_health_col_collection_status')}</th>
            <th scope="col">{t('nf_health_col_actions')}</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((target) => {
            const legacyIdentity =
              !target.resourceId ||
              target.identityState === 'legacy_unbound' ||
              target.identityState === 'legacy_unresolved';
            return (
              <tr key={target.targetId}>
                <td>
                  <Link to={targetHref(target.targetId)} className={styles.rowLink}>
                    {target.name}
                  </Link>
                  <div className={styles.stack}>
                    <code className={styles.uuid}>{target.targetId}</code>
                  </div>
                </td>
                <td>
                  <div className={styles.stack}>
                    <strong>{target.nfType ?? target.name}</strong>
                    {target.domain ? <span className={styles.chip}>{target.domain}</span> : null}
                    {target.resourceId ? (
                      <Link
                        to={`/inventory/${encodeURIComponent(target.resourceId)}`}
                        className={styles.rowLink}
                        title={t('nf_health_link_resource')}
                      >
                        <Link2 size={12} aria-hidden="true" />
                        {t('nf_health_link_resource')}
                      </Link>
                    ) : null}
                    {target.candidateId ? (
                      <Link to="/discovery" className={styles.rowLink} title={t('nf_health_link_candidate')}>
                        <Boxes size={12} aria-hidden="true" />
                        {t('nf_health_link_candidate')}
                      </Link>
                    ) : null}
                    {legacyIdentity ? (
                      <span className={styles.badgeUnknown} title={t('nf_health_identity_legacy_hint')}>
                        {t('nf_health_identity_legacy')}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <code className={styles.chip}>
                    {target.collectionMode === 'manual'
                      ? t('nf_health_mode_manual')
                      : t('nf_health_mode_scheduled')}
                  </code>
                </td>
                <td>{coverageBadge(layerAvailable(target.layers?.process?.state), target.coverage.l1Measured, t)}</td>
                <td>{coverageBadge(layerAvailable(target.layers?.interface?.state), target.coverage.l2Measured, t)}</td>
                <td>{coverageBadge(target.coverage.l3Available, target.coverage.l3Measured, t)}</td>
                <td>{formatTimestamp(target.lastMeasuredAt)}</td>
                <td>{freshnessBadge(target, t)}</td>
                <td>
                  {target.lastError ? (
                    <span className={styles.badgeUnhealthy}>{t('nf_health_status_failed')}</span>
                  ) : target.lastSuccessAt ? (
                    <span className={styles.badgeHealthy}>{t('nf_health_status_success')}</span>
                  ) : (
                    <span className={styles.badgeUnknown}>{t('nf_health_status_never')}</span>
                  )}
                </td>
                <td>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => onCollect(target)}
                      disabled={!canConfigure || collectingId === target.targetId}
                      title={t('nf_health_collect_action')}
                    >
                      <Play size={14} />
                      {collectingId === target.targetId ? t('nf_health_collecting') : t('nf_health_collect_action')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => onOpenDetail(target.targetId)}
                    >
                      {t('nf_health_open_detail')}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
