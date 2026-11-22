import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChartDataTable } from '../../components/ui/ChartDataTable';
import { ErrorState } from '../../components/ui/StatePanel';
import { LoadingRows } from '../../components/ui/OperationFeedback';
import { useI18n } from '../../providers/I18nProvider';
import { fetchNfMetricAnalysis } from './nf-health-api';
import { metricAnalysisCounts, metricAnalysisWindow, metricTrendCounts, type MetricAnalysisItem, type MetricAnalysisView } from './metric-analysis';
import styles from '../../styles/modules/nf-health.module.css';

type AnalysisKind = 'baseline' | 'trend';

export function MetricAnalysisPanel({ targetId, resourceId, refresh, kind = 'baseline' }: { targetId: string; resourceId?: string; refresh: number; kind?: AnalysisKind }) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const window = useMemo(() => metricAnalysisWindow(168), [refresh]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: MetricAnalysisView; error?: string }>();
  const key = `${targetId}:${kind}:${window.from}:${window.to}:${cursor ?? ''}:${reload}:${refresh}`;
  useEffect(() => {
    const controller = new AbortController();
    fetchNfMetricAnalysis(targetId, { ...window, kind, cursor }, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, error: 'nf_metric_analysis_failed' }); });
    return () => controller.abort();
  }, [key, targetId, window, cursor, kind]);
  const current = result?.key === key ? result : undefined;
  const data = current?.data;
  const restart = () => { setCursor(undefined); setReload(value => value + 1); };
  const trend = kind === 'trend';
  const number = (value: number | undefined) => value === undefined || value === null ? '-' : formatNumber(value, { maximumFractionDigits: 0 });
  const baselineCounts = metricAnalysisCounts(data?.items ?? []);
  const trendCounts = metricTrendCounts(data?.items ?? []);
  const stateLabel = (item: MetricAnalysisItem) => `${t(`nf_metric_analysis_state_${item.state}`)}${item.evidenceExpired ? ` / ${t('nf_metric_analysis_evidence_expired')}` : ''}`;
  const reasonLabel = (item: MetricAnalysisItem) => item.reason
    ? t(trend ? `nf_metric_trend_reason_${item.reason}` : `nf_metric_analysis_reason_${item.reason}`)
    : (item.direction ? t(`nf_metric_analysis_direction_${item.direction}`) : '-');
  const columns = trend ? [
    { key: 'bucket', label: t('nf_metric_trend_hour') },
    { key: 'state', label: t('nf_metric_analysis_state') },
    { key: 'slope', label: t('nf_metric_trend_slope'), numeric: true },
    { key: 'change', label: t('nf_metric_trend_change'), numeric: true },
    { key: 'fit', label: t('nf_metric_trend_fit'), numeric: true },
    { key: 'eligible', label: t('nf_metric_trend_eligible'), numeric: true },
    { key: 'confirmed', label: t('nf_metric_trend_confirmed') },
    { key: 'reason', label: t('nf_metric_analysis_reason') },
  ] : [
    { key: 'bucket', label: t('nf_metric_analysis_hour') },
    { key: 'state', label: t('nf_metric_analysis_state') },
    { key: 'value', label: t('nf_metric_analysis_value'), numeric: true },
    { key: 'median', label: t('nf_metric_analysis_median'), numeric: true },
    { key: 'mad', label: t('nf_metric_analysis_mad'), numeric: true },
    { key: 'score', label: t('nf_metric_analysis_score'), numeric: true },
    { key: 'change', label: t('nf_metric_analysis_change'), numeric: true },
    { key: 'coverage', label: t('nf_metric_analysis_coverage'), numeric: true },
    { key: 'reason', label: t('nf_metric_analysis_reason') },
  ];
  const cells = (item: MetricAnalysisItem) => trend ? [
    formatDateTime(item.bucketStart),
    stateLabel(item),
    number(item.slope),
    number(item.trendChange),
    item.fit === undefined || item.fit === null ? '-' : item.fit.toFixed(2),
    `${item.eligibleBuckets ?? 0} / ${item.windowHours ?? 0}`,
    t(item.confirmed ? 'nf_metric_trend_confirmed_yes' : 'nf_metric_trend_confirmed_no'),
    reasonLabel(item),
  ] : [
    formatDateTime(item.bucketStart),
    stateLabel(item),
    number(item.value),
    number(item.median),
    number(item.mad),
    item.score === undefined || item.score === null ? t('nf_metric_analysis_absolute_floor') : formatNumber(item.score, { maximumFractionDigits: 2 }),
    number(item.absoluteChange),
    `${item.baselineEligible} / ${item.baselineExpected}`,
    reasonLabel(item),
  ];
  return <section className="dash-card" aria-label={t(trend ? 'nf_metric_trend_title' : 'nf_metric_analysis_title')}>
    <div className={styles.sectionHead}><h2>{t(trend ? 'nf_metric_trend_title' : 'nf_metric_analysis_title')}</h2></div>
    <p className={styles.semanticNote}>{t(trend ? 'nf_metric_trend_note' : 'nf_metric_analysis_note')}</p>
    {!current ? <LoadingRows columns={4} rows={2} /> : current.error ? <ErrorState title={t('error')} message={t(current.error)} retryLabel={t('nf_metric_analysis_restart')} onRetry={restart} /> : data ? <>
      <p className={styles.semanticNote}>{trend
        ? t('nf_metric_trend_policy', {
          hours: data.windowHours ?? 0,
          change: formatNumber(data.minTrendChange ?? 0, { maximumFractionDigits: 0 }),
          fit: data.minFit ?? 0,
        })
        : t('nf_metric_analysis_policy', {
          hours: data.baselineHours ?? 0,
          score: data.scoreThreshold ?? 0,
          floor: formatNumber(data.minAbsoluteChange ?? 0, { maximumFractionDigits: 0 }),
        })}</p>
      <p>{trend
        ? t('nf_metric_trend_summary', { rising: trendCounts.rising, falling: trendCounts.falling, stable: trendCounts.stable, confirmed: trendCounts.confirmed, insufficient: trendCounts.insufficient_data })
        : t('nf_metric_analysis_summary', { anomaly: baselineCounts.anomaly, ok: baselineCounts.ok, insufficient: baselineCounts.insufficient_data, unavailable: baselineCounts.unavailable })}</p>
      {data.items.length ? <ChartDataTable label={t(trend ? 'nf_metric_trend_table' : 'nf_metric_analysis_table')} caption={t(trend ? 'nf_metric_trend_title' : 'nf_metric_analysis_title')} note={`${data.algorithmVersion} · ${data.policyVersion}`} columns={columns} rows={data.items.map(item => ({ key: `${item.bucketStart}:${item.revision}`, cells: cells(item) }))} /> : <p>{t(trend ? 'nf_metric_trend_empty' : 'nf_metric_analysis_empty')}</p>}
      <div className={styles.trendControls}><button type="button" className="btn btn-secondary" onClick={restart}>{t('nf_metric_analysis_restart')}</button>
        <button type="button" className="btn btn-secondary" disabled={!data.page.hasMore} onClick={() => setCursor(data.page.nextCursor ?? undefined)}>{t('nf_metric_analysis_next')}</button>
        {trend && resourceId ? <Link className="btn btn-secondary" to={`/investigations?resourceId=${encodeURIComponent(resourceId)}`}>{t('nf_metric_trend_investigate')}</Link> : null}</div>
    </> : null}
  </section>;
}
