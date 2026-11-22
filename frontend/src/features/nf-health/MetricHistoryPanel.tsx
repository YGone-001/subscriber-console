import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CartesianGrid, Scatter, ScatterChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartDataTable } from '../../components/ui/ChartDataTable';
import { Field } from '../../components/ui/Field';
import { ErrorState } from '../../components/ui/StatePanel';
import { LoadingRows } from '../../components/ui/OperationFeedback';
import { useI18n } from '../../providers/I18nProvider';
import { fetchNfMetricHistory } from './nf-health-api';
import { METRIC_HISTORY_SPECS, metricHistoryPoints, metricHistoryScope, metricHistorySpec, metricHistoryWindow, type MetricBucket, type MetricHistory, type MetricHistoryRange, type MetricHourSegment, type MetricKey, type MetricResolution } from './metric-history';
import styles from '../../styles/modules/nf-health.module.css';

export function MetricHistoryPanel({ targetId, refresh }: { targetId: string; refresh: number }) {
  const { t, formatDateTime } = useI18n();
  const [params, setParams] = useSearchParams();
  const spec = metricHistorySpec(params.get('metric'));
  const counter = spec.metricType === 'counter';
  const scope = metricHistoryScope(params.get('metricRange'), params.get('metricResolution'), params.get('metricHours'), spec);
  const window = useMemo(() => metricHistoryWindow(scope.hours, Date.now(), scope.resolution), [scope.hours, scope.resolution, refresh]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: MetricHistory; error?: string }>();
  const key = `${targetId}:${spec.key}:${scope.resolution}:${window.from}:${window.to}:${cursor ?? ''}:${reload}:${refresh}`;
  useEffect(() => {
    const controller = new AbortController();
    fetchNfMetricHistory(targetId, { ...window, resolution: scope.resolution, metric: spec.metric, cursor }, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, error: 'nf_metric_history_failed' }); });
    return () => controller.abort();
  }, [key, targetId, window, cursor, scope.resolution, spec.metric]);
  const current = result?.key === key ? result : undefined;
  const data = current?.data;
  const points = metricHistoryPoints(data?.buckets ?? [], spec.metricType).filter(point => point.value !== null);
  const restart = () => { setCursor(undefined); setReload(value => value + 1); };
  const select = (nextRange: MetricHistoryRange, nextResolution: MetricResolution) => {
    const next = metricHistoryScope(nextRange, nextResolution, null, spec);
    const query = new URLSearchParams(params);
    query.set('metricRange', next.range);
    query.set('metricResolution', next.resolution);
    query.delete('metricHours');
    setCursor(undefined);
    setParams(query, { replace: true });
  };
  const changeMetric = (nextKey: MetricKey) => {
    const nextSpec = metricHistorySpec(nextKey);
    const next = metricHistoryScope(scope.range, scope.resolution, null, nextSpec);
    const query = new URLSearchParams(params);
    if (nextSpec.key === 'rss') query.delete('metric'); else query.set('metric', nextSpec.key);
    query.set('metricRange', next.range);
    query.set('metricResolution', next.resolution);
    query.delete('metricHours');
    setCursor(undefined);
    setParams(query, { replace: true });
  };
  const daily = scope.resolution === '1d';
  const coveragePercent = (seconds: number) => `${(seconds / (daily ? 864 : 36)).toFixed(1)}% (${Math.round(seconds)}s)`;
  const qualityCell = (bucket: MetricBucket) => `${t(`nf_metric_history_${bucket.quality}`)}${bucket.reason ? ` / ${t(`nf_metric_history_${bucket.reason}`)}` : ''}`;
  // A missing statistic is explained, never rendered as zero: the segment may
  // have exceeded the exact sort budget, a daily bucket never provides a
  // percentile, and a counter without two observations has no rate.
  const p95Cell = (bucket: MetricBucket, segment: MetricHourSegment) => segment.p95 === undefined || segment.p95 === null
    ? t(bucket.p95State === 'not_provided' ? 'nf_metric_history_p95_not_provided' : 'nf_metric_history_p95_unavailable')
    : segment.p95;
  const rateCell = (segment: MetricHourSegment) => segment.rate === undefined || segment.rate === null
    ? t('nf_metric_history_no_valid_intervals')
    : segment.rate;
  return <section className="dash-card" aria-label={t('nf_metric_history_title')}>
    <div className={styles.sectionHead}><h2>{t('nf_metric_history_title')}</h2></div>
    <p className={styles.semanticNote}>{t(counter ? 'nf_metric_history_counter_note' : 'nf_metric_history_note')}</p>
    <Field htmlFor="nf-metric-history-metric" label={t('nf_metric_history_metric')}>
      <select id="nf-metric-history-metric" className="form-input" value={spec.key} onChange={event => changeMetric(event.target.value as MetricKey)}>
        {METRIC_HISTORY_SPECS.map(item => <option key={item.key} value={item.key}>{t(item.labelKey)}</option>)}
      </select>
    </Field>
    <Field htmlFor="nf-metric-history-range" label={t('nf_metric_history_window')}>
      <select id="nf-metric-history-range" className="form-input" value={scope.range} onChange={event => select(event.target.value as MetricHistoryRange, scope.resolution)}>
        {spec.ranges.map(range => <option key={range} value={range}>{t(`nf_metric_history_${range}`)}</option>)}
      </select>
    </Field>
    <Field htmlFor="nf-metric-history-resolution" label={t('nf_metric_history_resolution')}>
      <select id="nf-metric-history-resolution" className="form-input" value={scope.resolution} onChange={event => select(scope.range, event.target.value as MetricResolution)}>
        {spec.resolutions.map(resolution => <option key={resolution} value={resolution}>{t(`nf_metric_history_resolution_${resolution === '1d' ? 'day' : 'hour'}`)}</option>)}
      </select>
    </Field>
    <p>{window.from} - {window.to}</p>
    {!current ? <LoadingRows columns={4} rows={2} /> : current.error ? <ErrorState title={t('error')} message={t(current.error)} retryLabel={t('nf_metric_history_restart')} onRetry={restart} /> : data ? <>
      <p className={styles.semanticNote}>{t('nf_metric_history_retention', { days: data.retentionDays })}</p>
      {data.missingBuckets ? <p role="status">{t('nf_metric_history_missing_buckets', { count: data.missingBuckets })}</p> : null}
      {data.incompleteBuckets ? <p role="status">{t('nf_metric_history_incomplete_buckets', { count: data.incompleteBuckets })}</p> : null}
      {data.expiredBuckets ? <p role="status">{t('nf_metric_history_expired_buckets', { count: data.expiredBuckets })}</p> : null}
      <p>{t('nf_metric_history_watermark')}: <code>{data.watermark.slice(0, 12)}</code> &middot; {data.algorithmVersion}</p>
      {points.length ? <div className={styles.trendChart} aria-label={t(counter ? 'nf_metric_history_plot_rate' : 'nf_metric_history_plot')}>
        <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-border)" />
          <XAxis type="number" dataKey="at" domain={['dataMin', 'dataMax']} tickFormatter={value => formatDateTime(value)} />
          <YAxis type="number" dataKey="value" unit={counter ? ' s/s' : ' bytes'} width={80} />
          <Tooltip labelFormatter={value => formatDateTime(Number(value))} /><Scatter data={points} fill="var(--primary)" isAnimationActive={false} />
        </ScatterChart></ResponsiveContainer>
      </div> : <p>{t('nf_metric_history_no_points')}</p>}
      <ChartDataTable label={t('nf_metric_history_table')} caption={t('nf_metric_history_title')} note={`${data.unit} · ${t(daily ? 'nf_metric_history_resolution_day' : 'nf_metric_history_resolution_hour')} · ${data.algorithmVersion}`} columns={counter ? [
        { key: 'bucket', label: t('nf_metric_history_hour') }, { key: 'epoch', label: t('nf_metric_history_epoch') },
        { key: 'rate', label: t('nf_metric_history_rate'), numeric: true }, { key: 'deltaSum', label: t('nf_metric_history_delta_sum'), numeric: true },
        { key: 'deltaCount', label: t('nf_metric_history_delta_count'), numeric: true }, { key: 'coverage', label: t('nf_metric_history_coverage'), numeric: true },
        { key: 'quality', label: t('nf_metric_history_quality') },
      ] : [
        { key: 'bucket', label: t(daily ? 'nf_metric_history_day' : 'nf_metric_history_hour') }, { key: 'epoch', label: t('nf_metric_history_epoch') },
        { key: 'mean', label: t('nf_metric_history_mean'), numeric: true }, { key: 'range', label: t('nf_metric_history_range') },
        { key: 'count', label: t('nf_metric_history_count'), numeric: true }, { key: 'coverage', label: t('nf_metric_history_coverage'), numeric: true },
        ...(daily ? [{ key: 'hours', label: t('nf_metric_history_hours'), numeric: true }] : []),
        { key: 'p95', label: t('nf_metric_history_p95'), numeric: true },
        { key: 'quality', label: t('nf_metric_history_quality') },
      ]} rows={data.buckets.flatMap(bucket => bucket.segments.length ? bucket.segments.map((segment, index) => ({ key: `${bucket.from}:${index}`, cells: counter ? [
        formatDateTime(bucket.from), `${segment.identityEpoch.slice(0, 8)} / ${index + 1}`, rateCell(segment), segment.deltaSum ?? 0, segment.deltaCount ?? 0,
        coveragePercent(segment.coveredSeconds), qualityCell(bucket),
      ] : [
        formatDateTime(bucket.from), `${segment.identityEpoch.slice(0, 8)} / ${index + 1}`, segment.mean, `${segment.min} / ${segment.max} bytes`, segment.count,
        coveragePercent(segment.coveredSeconds), ...(daily ? [`${bucket.hours ?? 0} / 24`] : []), p95Cell(bucket, segment), qualityCell(bucket),
      ] })) : [{ key: bucket.from, cells: counter ? [
        formatDateTime(bucket.from), '-', '-', '-', '-', bucket.sourceComplete ? coveragePercent(bucket.coveredSeconds) : '-', t(`nf_metric_history_${bucket.reason ?? bucket.quality}`),
      ] : [
        formatDateTime(bucket.from), '-', '-', '-', '-', bucket.sourceComplete ? coveragePercent(bucket.coveredSeconds) : '-', ...(daily ? [`${bucket.hours ?? 0} / 24`] : []), '-', t(`nf_metric_history_${bucket.reason ?? bucket.quality}`),
      ] }])} />
      <div className={styles.trendControls}><button type="button" className="btn btn-secondary" onClick={restart}>{t('nf_metric_history_restart')}</button>
        <button type="button" className="btn btn-secondary" disabled={!data.page.hasMore} onClick={() => setCursor(data.page.nextCursor ?? undefined)}>{t('nf_metric_history_next')}</button></div>
    </> : null}
  </section>;
}
