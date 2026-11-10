import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { useSearchParams } from 'react-router-dom';
import { Download, FileBarChart, RefreshCw } from 'lucide-react';
import { PageHeader } from '../../components/ui/PageHeader';
import MetricStrip from '../../components/ui/MetricStrip';
import { CursorPagination } from '../../components/ui/CursorPagination';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/StatePanel';
import { ViewSwitch } from '../../components/ui/ViewSwitch';
import { getBlob, getJson } from '../../lib/api/read-client';
import { useI18n } from '../../providers/I18nProvider';
import { finiteMeasurement, record, reportQuery, reportSearch, type OperationsReport, type ReportPage, type ReportRequest, type ReportSection } from './reports-model';
import styles from '../../styles/modules/operations-evidence.module.css';

function localInput(value: string) { const date = new Date(value); if (!Number.isFinite(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }

export function ReportSectionCard({ name, section }: { name: string; section: ReportSection }) {
  const { t, formatNumber, formatDateTime } = useI18n();
  const data = section.data;
  const val = (value: unknown) => { const n = finiteMeasurement(value); return n === null ? t('evidence_unavailable') : formatNumber(n, { maximumFractionDigits: 2 }); };
  const rows: [string, unknown][] = name === 'alerts' ? [['report_new_alerts', data?.new], ['report_acknowledged', data?.acknowledged], ['report_closed', data?.closed], ['report_current_open', data?.currentOpen]] : name === 'metrics' ? [['report_samples', data?.samples], ['report_series', data?.series]] : name === 'config' ? [['report_config_changes', data?.changed], ['config_count_noBaseline', data?.currentNoBaseline]] : Object.entries(record(data?.states)).map(([key, value]) => [`evidence_${key}`, value]);
  return <section className={styles.panel}>
    <div className={styles.sectionHead}><h2>{t(`report_section_${name}`)}</h2><span className={styles.badge} data-state={section.completeness}>{t(`evidence_${section.completeness}`)}</span></div>
    <div className={styles.content}>
      {section.completeness === 'unavailable' ? <p className={styles.notice}>{t(`evidence_${section.reason}`)}</p> : <>
        <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{val(value)}</dd></div>)}</dl>
        {name === 'alerts' ? <p className={styles.hint}>{t('report_processing_duration', { seconds: val(record(data?.ackDuration).seconds), count: val(record(data?.ackDuration).count) })}<br />{t('report_current_queue_hint')}</p> : null}
        {name === 'alerts' && Array.isArray(data?.closeDurationsByReason) ? data.closeDurationsByReason.map((item, index) => { const group = record(item); return <p className={styles.hint} key={index}>{t('report_closure_duration', { reason: t(`evidence_${String(group._id || 'unknown')}`), seconds: val(group.seconds), count: val(group.count) })}</p>; }) : null}
        {finiteMeasurement(data?.invalidTimesInScope) ? <p className={styles.notice}>{t('report_excluded_times', { count: val(data?.invalidTimesInScope) })}</p> : null}
        {finiteMeasurement(data?.excludedMetricObservations) ? <p className={styles.notice}>{t('report_excluded_metrics', { count: val(data?.excludedMetricObservations) })}</p> : null}
        {name === 'metrics' ? <p className={styles.hint}>{t('report_sample_span')}: {typeof data?.first === 'string' ? formatDateTime(data.first) : t('evidence_unavailable')} - {typeof data?.last === 'string' ? formatDateTime(data.last) : t('evidence_unavailable')}<br />{t('report_coverage_hint')}</p> : null}
        {name === 'config' ? <p className={styles.hint}>{t('report_config_hint')}</p> : null}
        {name === 'agents' ? <p className={styles.hint}>{t('report_agent_hint')}</p> : null}
        {section.reason ? <p className={styles.hint}>{t(`evidence_${section.reason}`)}</p> : null}
      </>}
    </div>
  </section>;
}

export function OperationsReportsPage() {
  const { t, formatNumber, formatDateTime } = useI18n();
  const [params, setParams] = useSearchParams();
  const [defaultTo] = useState(() => new Date().toISOString());
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState('');
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => { exportController.current?.abort(); }, []);
  const query = useMemo(() => { try { return reportQuery(params, defaultTo); } catch { return null; } }, [params, defaultTo]);
  const search = query ? reportSearch(query) : '';
  const view = params.get('view') === 'metrics' ? 'metrics' : 'alerts';
  const cursor = params.get('cursor') || '';
  const report = useSWR<OperationsReport>(query ? `/api/ops-reports/summary?${search}` : null, getJson);
  const resolvedSearch = report.data ? reportSearch(report.data.query) : '';
  const rows = useSWR<ReportPage>(resolvedSearch ? `/api/ops-reports/${view}?${resolvedSearch}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` : null, getJson);
  const [period, setPeriod] = useState(() => params.has('from') || params.has('to') ? 'custom' : params.get('period') === '1h' ? '1' : params.get('period') === '7d' ? '168' : '24');
  useEffect(() => {
    const current = new URLSearchParams(search);
    setPeriod(current.has('from') || current.has('to') ? 'custom' : current.get('period') === '1h' ? '1' : current.get('period') === '7d' ? '168' : '24');
  }, [search]);
  const refresh = async () => { await Promise.allSettled([report.mutate(), rows.mutate()]); };
  const generate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      const next: ReportRequest = {};
      if (period === 'custom') { const to = new Date(String(form.get('to'))).toISOString(); const from = new Date(String(form.get('from'))).toISOString(); if (new Date(to).getTime() <= new Date(from).getTime() || new Date(to).getTime() - new Date(from).getTime() > 7 * 86400000) throw new Error('window'); next.from=from; next.to=to; }
      else { next.period = period === '1' ? '1h' : period === '168' ? '7d' : '24h'; }
      for (const key of ['resourceId', 'domain', 'severity'] as const) { const value = String(form.get(key) || '').trim(); if (value) next[key] = value; }
      setParams(new URLSearchParams(reportSearch(next)));
    } catch { setError(t('report_invalid_window')); }
  };
  const changeView = (value: string) => { const next = new URLSearchParams(params); next.set('view', value); next.delete('cursor'); setParams(next); };
  const page = (value: string) => { const next = new URLSearchParams(params); if (value) next.set('cursor', value); else next.delete('cursor'); setParams(next); };
  const download = async (section: string) => {
    const frozenSearch = resolvedSearch; setExporting(section); setError(''); const controller = new AbortController(); exportController.current = controller;
    try { const blob = await getBlob(`/api/ops-reports/export?${frozenSearch}&section=${section}`, controller.signal); if (controller.signal.aborted) return; const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `xcloud-${section}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch { if (!controller.signal.aborted) setError(t('report_export_failed')); }
    finally { setExporting(''); exportController.current = null; }
  };
  const format = (value: unknown) => { const n = finiteMeasurement(value); if (n !== null) return formatNumber(n, { maximumFractionDigits: 3 }); return typeof value === 'string' ? value : t('evidence_unavailable'); };

  return <div className={styles.page}>
    <PageHeader title={t('report_title')} subtitle={t('report_description')} icon={<FileBarChart size={22} />} actions={<button className="btn btn-secondary" onClick={() => { void refresh(); }}><RefreshCw size={16} />{t('refresh')}</button>} />
    <form key={search} className={`${styles.panel} ${styles.toolbar}`} onSubmit={generate}>
      <label>{t('report_period')}<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="1">{t('report_1h')}</option><option value="24">{t('report_24h')}</option><option value="168">{t('report_7d')}</option><option value="custom">{t('report_custom')}</option></select></label>
      {period === 'custom' ? <><label>{t('report_from')}<input type="datetime-local" name="from" required defaultValue={localInput(query?.from || report.data?.query.from || defaultTo)} /></label><label>{t('report_to')}<input type="datetime-local" name="to" required defaultValue={localInput(query?.to || report.data?.query.to || defaultTo)} /></label></> : null}
      <label>{t('config_resource')}<input name="resourceId" defaultValue={params.get('resourceId') || ''} placeholder={t('report_resource_placeholder')} /></label>
      <label>{t('report_domain')}<select name="domain" defaultValue={params.get('domain') || ''}><option value="">{t('evidence_all')}</option>{['epc', '5gc', 'ims', 'charging'].map((domain) => <option key={domain} value={domain}>{domain.toUpperCase()}</option>)}</select></label>
      <label>{t('report_severity')}<select name="severity" defaultValue={params.get('severity') || ''}><option value="">{t('evidence_all')}</option>{['critical', 'warning', 'info'].map((severity) => <option key={severity} value={severity}>{t(`report_severity_${severity}`)}</option>)}</select></label>
      <button className="btn btn-primary" type="submit">{t('report_generate')}</button>
    </form>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!query ? <ErrorState title={t('report_invalid_window')} message={t('report_invalid_window')} /> : report.isLoading ? <LoadingState label={t('loading')} /> : report.error || !report.data ? <ErrorState title={t('report_unavailable')} message={t('report_fetch_failed')} retryLabel={t('refresh')} onRetry={() => { void refresh(); }} /> : <>
      <div className={styles.reportStamp}><span>{t('report_generated')}: {formatDateTime(report.data.generatedAt)}</span><span>{formatDateTime(report.data.query.from)} - {formatDateTime(report.data.query.to)}</span></div>
      <MetricStrip ariaLabel={t('report_summary')} items={[
        { key: 'new', label: t('report_new_alerts'), value: format(report.data.alerts.data?.new), detail: t('report_window_scope'), tone: 'muted' },
        { key: 'closed', label: t('report_closed'), value: format(report.data.alerts.data?.closed), detail: t('report_window_scope'), tone: 'muted' },
        { key: 'current', label: t('report_current_open'), value: format(report.data.alerts.data?.currentOpen), detail: t('report_current_scope'), tone: 'warning' },
        { key: 'samples', label: t('report_samples'), value: format(report.data.metrics.data?.samples), detail: t('report_retained_scope'), tone: 'muted' },
      ]} />
      <div className={styles.reportGrid}>{(['alerts', 'metrics', 'config', 'agents'] as const).map((name) => <ReportSectionCard key={name} name={name} section={report.data![name]} />)}</div>
      <section className={styles.panel}>
        <div className={styles.toolbar}><ViewSwitch ariaLabel={t('report_detail_view')} value={view} options={['alerts', 'metrics'].map((value) => ({ value, label: t(`report_section_${value}`) }))} onChange={changeView} />
          <div className={styles.actions}>{(['alerts', 'metrics', 'config'] as const).map((section) => <button key={section} className="btn btn-secondary" disabled={Boolean(exporting) || report.data![section].completeness === 'unavailable'} onClick={() => { void download(section); }}><Download size={14} />{t(`report_export_${section}`)}</button>)}{exporting ? <button className="btn btn-secondary" onClick={() => exportController.current?.abort()}>{t('cancel')}</button> : null}</div>
        </div>
        {rows.isLoading ? <LoadingState label={t('loading')} /> : rows.error ? <ErrorState title={t('report_unavailable')} message={t('report_detail_failed')} /> : !rows.data?.items.length ? <EmptyState title={t('report_no_rows')} description={t('report_no_rows_hint')} /> : <div className={styles.tableWrap}><table className={styles.table}>
          <caption>{t('report_detail_scope')}</caption><thead>{view === 'alerts' ? <tr>{['report_rule', 'config_resource', 'report_severity', 'report_state', 'report_triggered', 'report_resolved'].map((key) => <th key={key}>{t(key)}</th>)}</tr> : <tr>{['config_resource', 'report_metric', 'report_type', 'report_samples', 'report_last', 'report_min', 'report_max', 'report_mean'].map((key) => <th key={key}>{t(key)}</th>)}</tr>}</thead>
          <tbody>{rows.data.items.map((row) => view === 'alerts' ? <tr key={String(row.rowId)}><td>{format(row.ruleName)}<small>{format(row.targetName)}</small></td><td className={styles.mono}>{format(row.resourceId)}</td><td>{t(`report_severity_${String(row.severity)}`)}</td><td>{t(`evidence_${String(row.state)}`)}</td><td>{typeof row.firstTriggeredAt === 'string' ? formatDateTime(row.firstTriggeredAt) : t('evidence_unavailable')}</td><td>{typeof row.resolvedAt === 'string' ? formatDateTime(row.resolvedAt) : t('evidence_unavailable')}<small>{typeof row.resolvedReason === 'string' ? t(`evidence_${row.resolvedReason}`) : ''}</small></td></tr> : <tr key={String(row.rowId)}><td className={styles.mono}>{format(row.resourceId)}<small>{format(row.targetId)}</small></td><td>{format(row.key)}<small>{format(row.unit)} / {format(row.label_instance)}</small></td><td>{format(row.type)}</td><td>{format(row.sampleCount)}</td><td>{format(row.last)}</td><td>{format(row.min)}</td><td>{format(row.max)}</td><td>{format(row.mean)}</td></tr>)}</tbody>
        </table></div>}
        <CursorPagination summary={t('report_detail_scope')} previousLabel={t('evidence_first_page')} nextLabel={t('next')} hasPrevious={Boolean(cursor)} hasNext={Boolean(rows.data?.hasMore)} onPrevious={() => page('')} onNext={() => page(rows.data?.nextCursor || '')} />
      </section>
      <p className={styles.hint}>{t('report_consistency_hint')}</p>
    </>}
  </div>;
}
