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
  /* `source` states when the evidence was produced; `read` states when this
   * surface last read it. A ledger read has no server timestamp of its own, and
   * the two must not be presented as the same fact. */
  mode?: 'source' | 'read';
};

export function TopologyFreshnessChip({
  sourceTime,
  now,
  policySeconds = TOPOLOGY_FRESHNESS_POLICY_SECONDS,
  mode = 'source',
}: TopologyFreshnessChipProps) {
  const { t } = useI18n();
  const label = sourceTimeLabel(sourceTime);
  const age = sourceAgeSeconds(sourceTime, now);
  const state = freshnessState(age, policySeconds);
  const timeKey = mode === 'read' ? 'topology_fresh_read_time' : 'topology_fresh_source_time';

  if (state === 'unknown') {
    return (
      <span className={styles.liveChip} data-freshness="unknown" data-freshness-mode={mode}>
        {t('topology_fresh_unknown')}
      </span>
    );
  }

  return (
    <span
      className={styles.liveChip}
      data-freshness={state}
      data-freshness-mode={mode}
      data-source-time={label}
    >
      <span>{t(timeKey, { time: label })}</span>
      <span aria-hidden="true">{' · '}</span>
      <span>{t(freshnessLabelKey(state), { age: age as number })}</span>
    </span>
  );
}