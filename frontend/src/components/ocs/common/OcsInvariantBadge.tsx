/*
 * Balance invariant badge.
 *
 * The OCS balance record carries three conservation checks
 * (`total == used + reserved + available`, and the sms variant without
 * `reserved`). A failed check blocks every adjustment, so the state has to be
 * visible in the list rather than discovered when an adjustment is rejected.
 *
 * `unknown` is a real third state: when the API omits a check the badge must not
 * claim the record is broken. That is why the adapter keeps `null` apart from
 * `false` and why this component renders them differently.
 */
import { useI18n } from '../../../providers/I18nProvider';

interface OcsInvariantBadgeProps {
  /** `true` = all checks pass, `false` = at least one mismatch, `null` = not reported. */
  value: boolean | null;
  className?: string;
}

export default function OcsInvariantBadge({ value, className }: OcsInvariantBadgeProps) {
  const { t } = useI18n();

  const state = value === true ? 'ok' : value === false ? 'broken' : 'unknown';
  const label = value === true
    ? t('ocs_invariant_ok')
    : value === false
      ? t('ocs_invariant_broken')
      : t('ocs_invariant_unknown');

  return (
    <span
      className={['ocs-invariant-badge', `ocs-invariant-${state}`, className ?? ''].filter(Boolean).join(' ')}
      data-state={state}
    >
      {label}
    </span>
  );
}
