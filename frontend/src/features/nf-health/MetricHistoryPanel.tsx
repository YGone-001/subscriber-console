import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CartesianGrid, Scatter, ScatterChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartDataTable } from '../../components/ui/ChartDataTable';
import { Field } from '../../components/ui/Field';
import { ErrorState } from '../../components/ui/StatePanel';
import { LoadingRows } from '../../components/ui/OperationFeedback';
import { useI18n } from '../../providers/I18nProvider';
import { fetchNfMetricHistory } from './nf-health-api';
import { metricHistoryPoints, metricHistoryWindow, type MetricHistory } from './metric-history';
import styles from '../../styles/modules/nf-health.module.css';

export function MetricHistoryPanel({ targetId, refresh }: { targetId: string; refresh: number }) {
  const { t, formatDateTime } = useI18n();
  const [params, setParams] = useSearchParams();
  const rawHours = Number(params.get('metricHours') ?? 24);
  const hours = [24, 168, 720].includes(rawHours) ? rawHours : 24;
  const window = useMemo(() => metricHistoryWindow(hours), [hours, refresh]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: MetricHistory; error?: string }>();
  const key = `${targetId}:${window.from}:${window.to}:${cursor ?? ''}:${reload}:${refresh}`;
  useEffect(() => {
    const controller = new AbortController();
    fetchNfMetricHistory(targetId, { ...window, cursor }, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, error: 'nf_metric_history_failed' }); });
    return () => controller.abort();
  }, [key, targetId, window, cursor]);
  const current = result?.key === key ? result : undefined;
  const data = current?.data;
  const points = metricHistoryPoints(data?.buckets ?? []).filter(point => point.value !== null);
  const restart = () => { setCursor(undefined); setReload(value => value + 1); };
  return <section className="dash-card" aria-label={t('nf_metric_history_title')}>
    <div className={styles.sectionHead}><h2>{t('nf_metric_history_title')}</h2></div>
    <p className={styles.semanticNote}>{t('nf_metric_history_note')}</p>
    <Field htmlFor="nf-metric-history-hours" label={t('nf_metric_history_window')}>
      <select id="nf-metric-history-hours" className="form-input" value={hours} onChange={event => {
        setCursor(undefined); const next = new URLSearchParams(params); next.set('metricHours', event.target.value); setParams(next, { replace: true });
      }}><option value={24}>{t('nf_metric_history_24h')}</option><option value={168}>{t('nf_metric_history_7d')}</option><option value={720}>{t('nf_metric_history_30d')}</option></select>
    </Field>
    <p>{window.from} - {window.to}</p>
    {!current ? <LoadingRows columns={4} rows={2} /> : current.error ? <ErrorState title={t('error')} message={t(current.error)} retryLabel={t('nf_metric_history_restart')} onRetry={restart} /> : data ? <>
      {!data.complete ? <p role="status">{t('nf_metric_history_incomplete', { count: data.missingHours })}</p> : null}
      <p>{t('nf_metric_history_watermark')}: <code>{data.watermark.slice(0, 12)}</code> &middot; {data.algorithmVersion}</p>
      {points.length ? <div className={styles.trendChart} aria-label={t('nf_metric_history_plot')}>
        <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-border)" />
          <XAxis type="number" dataKey="at" domain={['dataMin', 'dataMax']} tickFormatter={value => formatDateTime(value)} />
          <YAxis type="number" dataKey="value" unit=" bytes" width={80} />
          <Tooltip labelFormatter={value => formatDateTime(Number(value))} /><Scatter data={points} fill="var(--primary)" isAnimationActive={false} />
        </ScatterChart></ResponsiveContainer>
      </div> : <p>{t('nf_metric_history_no_points')}</p>}
      <ChartDataTable label={t('nf_metric_history_table')} caption={t('nf_metric_history_title')} columns={[
        { key: 'hour', label: t('nf_metric_history_hour') }, { key: 'epoch', label: t('nf_metric_history_epoch') },
        { key: 'mean', label: t('nf_metric_history_mean'), numeric: true }, { key: 'range', label: t('nf_metric_history_range') },
        { key: 'count', label: t('nf_metric_history_count'), numeric: true }, { key: 'coverage', label: t('nf_metric_history_coverage'), numeric: true },
        { key: 'quality', label: t('nf_metric_history_quality') },
      ]} rows={data.buckets.flatMap(bucket => bucket.segments.length ? bucket.segments.map((segment, index) => ({ key: `${bucket.from}:${index}`, cells: [
        formatDateTime(bucket.from), `${segment.identityEpoch.slice(0, 8)} / ${index + 1}`, segment.mean, `${segment.min} / ${segment.max} bytes`, segment.count,
        `${(segment.coveredSeconds / 36).toFixed(1)}% (${segment.coveredSeconds}s)`, `${t(`nf_metric_history_${bucket.quality}`)}${bucket.reason ? ` / ${t(`nf_metric_history_${bucket.reason}`)}` : ''}`,
      ] })) : [{ key: bucket.from, cells: [formatDateTime(bucket.from), '-', '-', '-', '-', bucket.sourceComplete ? `${(bucket.coveredSeconds / 36).toFixed(1)}% (${bucket.coveredSeconds}s)` : '-', t(`nf_metric_history_${bucket.reason ?? bucket.quality}`)] }])} />
      <div className={styles.trendControls}><button type="button" className="btn btn-secondary" onClick={restart}>{t('nf_metric_history_restart')}</button>
        <button type="button" className="btn btn-secondary" disabled={!data.page.hasMore} onClick={() => setCursor(data.page.nextCursor ?? undefined)}>{t('nf_metric_history_next')}</button></div>
    </> : null}
  </section>;
}
