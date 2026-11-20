import { useI18n } from '../../providers/I18nProvider';
import type { BusinessRuleObservation } from './nf-health-types';
import styles from '../../styles/modules/nf-health.module.css';

export function BusinessRulePanel({ rules }: { rules: BusinessRuleObservation[] }) {
  const { t, formatNumber } = useI18n();
  const number = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '-' : formatNumber(value, { maximumFractionDigits: 2 });
  const label = (group: string, code: string) => {
    const key = `nf_health_rule_${group}_${code}`;
    const value = t(key);
    return value === key ? t('nf_health_rule_unknown') : value;
  };
  if (rules.length === 0) return null;

  return (
    <div className={styles.ruleList}>
      {rules.map((rule) => (
        <article className={styles.ruleObservation} aria-label={label('title', rule.ruleId)} key={`${rule.ruleId}:${rule.scope}`}>
          <div className={styles.ruleHeading}>
            <h3>{label('title', rule.ruleId)}</h3>
            <span className={styles.chip}>{label('status', rule.status)}</span>
          </div>
          <p>{label('semantics', rule.semantics)}</p>
          <p className={styles.ruleExplanation}>{label('reason', rule.reason)}</p>
          <dl className={styles.ruleFacts}>
            {rule.kind === 'request_completion' ? <>
              <div><dt>{t('nf_health_rule_requests')}</dt><dd>{number(rule.requestDelta)}</dd></div>
              <div><dt>{t('nf_health_rule_completions')}</dt><dd>{number(rule.completionDelta)}</dd></div>
              <div><dt>{t('nf_health_rule_difference')}</dt><dd>{number(rule.difference)}</dd></div>
              <div><dt>{t('nf_health_window_pair')}</dt><dd>{rule.completionRatioPercent == null ? '-' : `${number(rule.completionRatioPercent)}%`}</dd></div>
            </> : null}
            <div><dt>{t('nf_health_window_coverage')}</dt><dd>{number(rule.coveragePercent)}%</dd></div>
            <div><dt>{t('nf_health_window_samples', { points: rule.validPoints, intervals: rule.validIntervals })}</dt><dd>{label('quality', rule.quality)}</dd></div>
          </dl>
          {rule.minimumRequests ? <p className={styles.sectionNote}>{t('nf_health_rule_volume_policy', { count: rule.minimumRequests })}</p> : null}
          {rule.missingMetrics.length ? <div className={styles.ruleMissing}>
            <strong>{t('nf_health_rule_missing_metrics')}</strong>
            <ul>{rule.missingMetrics.map((metric) => <li key={metric}><code>{metric}</code></li>)}</ul>
          </div> : null}
          <p className={styles.semanticNote}>{t('nf_health_rule_next')}: {label('next', rule.ruleId)}</p>
          <details>
            <summary>{t('nf_health_rule_details')}</summary>
            <p className={styles.sectionNote}>{t('nf_health_rule_no_health_effect')}</p>
            <p>{label('source', rule.sourceReview)} · {t('nf_health_rule_binary_unattested')}</p>
            <p className={styles.sectionNote}>{t('nf_health_rule_scope')}: <code>{rule.scope === 'null' || rule.scope === '{}' ? t('nf_health_window_global') : rule.scope}</code></p>
            <p className={styles.sectionNote}>{t('nf_health_rule_version')}: <code>{rule.ruleId} / {rule.version}</code></p>
            {rule.observed.length ? <div className={styles.windowTableWrap} role="region" aria-label={t('nf_health_rule_inputs')} tabIndex={0}>
              <table className="data-table"><caption>{t('nf_health_rule_inputs')}</caption><thead><tr>
                <th scope="col">{t('nf_health_window_metric')}</th><th scope="col">{t('nf_health_window_latest')}</th><th scope="col">{t('nf_health_window_delta')}</th><th scope="col">{t('nf_health_window_quality')}</th>
              </tr></thead><tbody>{rule.observed.map((metric) => <tr key={metric.metric}>
                <th scope="row" className={styles.windowMetric}><code>{metric.metric}</code></th>
                <td>{number(metric.latestValue)}</td><td>{number(metric.delta)}</td><td>{label('quality', metric.quality)}</td>
              </tr>)}</tbody></table>
            </div> : null}
            <strong>{t('nf_health_rule_missing_signals')}</strong>
            <ul>{rule.missingSignals.map((signal) => <li key={signal}>{label('signal', signal)}</li>)}</ul>
            {rule.references.length ? <><strong>{t('nf_health_rule_source_references')}</strong><ul>
              {rule.references.map((reference) => <li key={`${reference.path}:${reference.line}`}><code>{reference.path}:{reference.line}</code></li>)}
            </ul></> : null}
          </details>
        </article>
      ))}
    </div>
  );
}
