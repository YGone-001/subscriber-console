/*
 * Source-time chip for a topology read.
 *
 * The chip states when the evidence was produced and whether that time is still
 * inside the freshness policy. It is deliberately explicit about age: an
 * operator reading a canvas a few minutes later must be able to see that the
 * picture predates the moment they are looking at it.
 */
import { useI18n } from '../../../providers/I18nProvider';
import {
  TOPOLOGY_FRESHNESS_POLICY_SECONDS,
  freshnessLabelKey,
  freshnessState,
  sourceAgeSeconds,
  sourceTimeLabel,
} from '../topology-freshness';
import styles from '../../../styles/modules/architecture.module.css';

export type TopologyFreshnessChipProps = {
  /* Server supplied source time (ISO 8601). Absent means no evidence of time. */
  sourceTime?: string;
  /* Injected clock so the chip stays deterministic in tests. */
  now?: number;
  policySeconds?: number;
};

export function TopologyFreshnessChip({
  sourceTime,
  now,
  policySeconds = TOPOLOGY_FRESHNESS_POLICY_SECONDS,
}: TopologyFreshnessChipProps) {
  const { t } = useI18n();
  const label = sourceTimeLabel(sourceTime);
  const age = sourceAgeSeconds(sourceTime, now);
  const state = freshnessState(age, policySeconds);

  if (state === 'unknown') {
    return (
      <span className={styles.liveChip} data-freshness="unknown">
        {t('topology_fresh_unknown')}
      </span>
    );
  }

  return (
    <span className={styles.liveChip} data-freshness={state} data-source-time={label}>
      <span>{t('topology_fresh_source_time', { time: label })}</span>
      <span aria-hidden="true">{' · '}</span>
      <span>{t(freshnessLabelKey(state), { age: age as number })}</span>
    </span>
  );
}