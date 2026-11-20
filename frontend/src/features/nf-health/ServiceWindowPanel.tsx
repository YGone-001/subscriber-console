import { useState } from 'react';
import { useI18n } from '../../providers/I18nProvider';
import type { ServiceWindowReport } from './nf-health-types';
import { BusinessRulePanel } from './BusinessRulePanel';
import styles from '../../styles/modules/nf-health.module.css';

const numeric = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? '-' : value.toLocaleString(undefined, { maximumFractionDigits: digits });

// Server-owned interval evidence is rendered directly. The browser never
// reconstructs rates, fills gaps, averages ratios or invents health states.
export function ServiceWindowPanel({ report }: { report?: ServiceWindowReport }) {
  const { t, formatDateTime } = useI18n();
  const [seconds, setSeconds] = useState(600);
  const window = report?.windows.find((item) => item.seconds === seconds);
  const reason = (code: string) => t(`nf_health_window_reason_${code}`);
  const date = (value: string) => formatDateTime(value);

  return (
    <section className="dash-card" aria-labelledby="service-window-title">
      <div className={styles.sectionHead}>
        <h2 id="service-window-title">{t('nf_health_window_title')}</h2>
        <span className={styles.sectionNote}>{t('nf_health_window_observation')}</span>
      </div>
      <p className={styles.semanticNote}>{t('nf_health_window_boundary')}</p>
      <div className={styles.trendControls} role="group" aria-label={t('nf_health_window_select')}>
        {[600, 1800].map((value) => (
          <button type="button" key={value} className={styles.trendWindowBtn}
            aria-pressed={seconds === value} onClick={() => setSeconds(value)}>
            {t('nf_health_window_minutes', { count: value / 60 })}
          </button>
        ))}
      </div>
      <BusinessRulePanel rules={window?.businessRules ?? []} />
      {report?.reason && window?.rows.length ? <p role="status" className={styles.semanticNote}>{reason(report.reason)}</p> : null}
      {!window || window.rows.length === 0 ? (
        <p className={styles.semanticNote}>{reason(report?.reason || 'warming_up')}</p>
      ) : (
        <>
          <p className={styles.semanticNote}>
            {date(window.from)} — {date(window.to)}
            {' · '}{t('nf_health_window_policy', { freshness: window.freshnessSeconds, gap: window.maxGapSeconds })}
          </p>
          <div className={styles.windowTableWrap} role="region" aria-label={t('nf_health_window_title')} tabIndex={0}>
            <table className="data-table">
              <caption className={styles.semanticNote}>{t('nf_health_window_table_note')}</caption>
              <thead><tr>
                <th scope="col">{t('nf_health_window_metric')}</th>
                <th scope="col">{t('nf_health_window_quality')}</th>
                <th scope="col">{t('nf_health_window_coverage')}</th>
                <th scope="col">{t('nf_health_window_latest')}</th>
                <th scope="col">{t('nf_health_window_delta')}</th>
                <th scope="col">{t('nf_health_window_rate')}</th>
                <th scope="col">{t('nf_health_window_pair')}</th>
              </tr></thead>
              <tbody>{window.rows.map((row) => (
                <tr key={`${row.metric}:${row.scope}`}>
                  <th scope="row" className={styles.windowMetric}>
                    <code>{row.metric}</code>
                    <div className={styles.sectionNote}>{row.scope === 'null' || row.scope === '{}' ? t('nf_health_window_global') : row.scope}</div>
                    <details>
                      <summary>{t('nf_health_window_evidence')}</summary>
                      {Object.entries(row.excluded).map(([code, count]) => <p key={code}>{reason(code)}: {count}</p>)}
                      <ol className={styles.windowEvidence}>
                        {row.evidence.map((interval, index) => <li key={`${interval.fromSampleId}:${interval.toSampleId}:${index}`}>
                          <div>{date(interval.from)} — {date(interval.to)} ({numeric(interval.seconds)} s)</div>
                          <div>{interval.reason ? reason(interval.reason) : t('nf_health_window_included')}
                            {' · '}{t('nf_health_window_delta')}: {numeric(interval.delta)}</div>
                          <small>{interval.fromSampleId} → {interval.toSampleId}</small>
                        </li>)}
                      </ol>
                    </details>
                  </th>
                  <td>{t(`nf_health_window_quality_${row.quality}`)}<div className={styles.sectionNote}>{reason(row.reason)}</div></td>
                  <td>{numeric(row.coveragePercent)}%<div className={styles.sectionNote}>
                    {t('nf_health_window_samples', { points: row.points, intervals: row.intervals })}
                  </div></td>
                  <td>{numeric(row.latestValue)}<div className={styles.sectionNote}>{row.unit}</div></td>
                  <td>{numeric(row.delta)}</td>
                  <td>{numeric(row.rate, 4)}{row.rate == null ? '' : '/s'}</td>
                  <td>{row.pairMetric ? <>
                    <div>{row.completionRatioPercent == null ? '-' : `${numeric(row.completionRatioPercent)}%`}</div>
                    <div className={styles.sectionNote}>{reason(row.pairReason || 'pair_missing')}</div>
                    <small>{t('nf_health_window_requests')}: {numeric(row.pairDelta)}</small>
                  </> : t('nf_health_window_no_rule')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
