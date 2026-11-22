import { useEffect, useMemo, useState } from 'react';
import { ChartDataTable } from '../../components/ui/ChartDataTable';
import { ErrorState } from '../../components/ui/StatePanel';
import { LoadingRows } from '../../components/ui/OperationFeedback';
import { useI18n } from '../../providers/I18nProvider';
import { fetchNfMetricAnalysis } from './nf-health-api';
import { metricAnalysisCounts, metricAnalysisWindow, type MetricAnalysisItem, type MetricAnalysisView } from './metric-analysis';
import styles from '../../styles/modules/nf-health.module.css';

export function MetricAnalysisPanel({ targetId, refresh }: { targetId: string; refresh: number }) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const window = useMemo(() => metricAnalysisWindow(168), [refresh]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: MetricAnalysisView; error?: string }>();
  const key = `${targetId}:${window.from}:${window.to}:${cursor ?? ''}:${reload}:${refresh}`;
  useEffect(() => {
    const controller = new AbortController();
    fetchNfMetricAnalysis(targetId, { ...window, cursor }, controller.signal)
      .then(data => { if (!controller.signal.aborted) setResult({ key, data }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, error: 'nf_metric_analysis_failed' }); });
    return () => controller.abort();
  }, [key, targetId, window, cursor]);
  const current = result?.key === key ? result : undefined;
  const data = current?.data;
  const restart = () => { setCursor(undefined); setReload(value => value + 1); };
  const counts = metricAnalysisCounts(data?.items ?? []);
  const value = (item: MetricAnalysisItem, field: 'value' | 'median' | 'mad' | 'absoluteChange') => {
    const raw = item[field];
    return raw === undefined || raw === null ? '-' : formatNumber(raw, { maximumFractionDigits: 0 });
  };
  return <section className="dash-card" aria-label={t('nf_metric_analysis_title')}>
    <div className={styles.sectionHead}><h2>{t('nf_metric_analysis_title')}</h2></div>
    <p className={styles.semanticNote}>{t('nf_metric_analysis_note')}</p>
    {!current ? <LoadingRows columns={4} rows={2} /> : current.error ? <ErrorState title={t('error')} message={t(current.error)} retryLabel={t('nf_metric_analysis_restart')} onRetry={restart} /> : data ? <>
      <p className={styles.semanticNote}>{t('nf_metric_analysis_policy', {
        hours: data.baselineHours,
        score: data.scoreThreshold,
        floor: formatNumber(data.minAbsoluteChange, { maximumFractionDigits: 0 }),
      })}</p>
      <p>{t('nf_metric_analysis_summary', {
        anomaly: counts.anomaly,
        ok: counts.ok,
        insufficient: counts.insufficient_data,
        unavailable: counts.unavailable,
      })}</p>
      {data.items.length ? <ChartDataTable label={t('nf_metric_analysis_table')} caption={t('nf_metric_analysis_title')} note={`${data.algorithmVersion} · ${data.policyVersion}`} columns={[
        { key: 'bucket', label: t('nf_metric_analysis_hour') },
        { key: 'state', label: t('nf_metric_analysis_state') },
        { key: 'value', label: t('nf_metric_analysis_value'), numeric: true },
        { key: 'median', label: t('nf_metric_analysis_median'), numeric: true },
        { key: 'mad', label: t('nf_metric_analysis_mad'), numeric: true },
        { key: 'score', label: t('nf_metric_analysis_score'), numeric: true },
        { key: 'change', label: t('nf_metric_analysis_change'), numeric: true },
        { key: 'coverage', label: t('nf_metric_analysis_coverage'), numeric: true },
        { key: 'reason', label: t('nf_metric_analysis_reason') },
      ]} rows={data.items.map(item => ({
        key: `${item.bucketStart}:${item.revision}`,
        cells: [
          formatDateTime(item.bucketStart),
          `${t(`nf_metric_analysis_state_${item.state}`)}${item.evidenceExpired ? ` / ${t('nf_metric_analysis_evidence_expired')}` : ''}`,
          value(item, 'value'),
          value(item, 'median'),
          value(item, 'mad'),
          item.score === undefined || item.score === null ? t('nf_metric_analysis_absolute_floor') : formatNumber(item.score, { maximumFractionDigits: 2 }),
          value(item, 'absoluteChange'),
          `${item.baselineEligible} / ${item.baselineExpected}`,
          item.reason ? t(`nf_metric_analysis_reason_${item.reason}`) : (item.direction ? t(`nf_metric_analysis_direction_${item.direction}`) : '-'),
        ],
      }))} /> : <p>{t('nf_metric_analysis_empty')}</p>}
      <div className={styles.trendControls}><button type="button" className="btn btn-secondary" onClick={restart}>{t('nf_metric_analysis_restart')}</button>
        <button type="button" className="btn btn-secondary" disabled={!data.page.hasMore} onClick={() => setCursor(data.page.nextCursor ?? undefined)}>{t('nf_metric_analysis_next')}</button></div>
    </> : null}
  </section>;
}
