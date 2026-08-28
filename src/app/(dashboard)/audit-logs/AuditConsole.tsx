"use client";

import { useEffect, useId, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import {
  AlertTriangle, CheckCircle2, Clipboard, Download, Eye,
  FileWarning, Filter, History, RefreshCw, RotateCcw, Search, ShieldAlert,
  X,
} from 'lucide-react';
import { useI18n } from '@/components/I18nProvider';
import { useNotification } from '@/components/NotificationProvider';
import { ChangeDiff } from '@/components/governance/ChangeDiff';
import { AuditResultBadge, RiskBadge } from '@/components/governance/GovernanceBadges';
import { EmptyState, LoadingRows } from '@/components/OperationFeedback';
import { DataTablePagination } from '@/components/ui/DataTablePagination';
import { Dialog } from '@/components/ui/Dialog';
import MetricStrip from '@/components/ui/MetricStrip';
import PageHeader from '@/components/ui/PageHeader';
import { usePermissions } from '@/hooks/usePermissions';
import { fetcher } from '@/lib/fetcher';
import type { AuditListResponse, AuditLogRecord } from '@/types/audit';
import styles from './AuditConsole.module.css';

const LIST_QUERY_KEYS = [
  'page', 'pageSize', 'q', 'action', 'module', 'result', 'risk', 'actor',
  'resourceType', 'resourceId', 'requestId', 'correlationId', 'approvalId',
  'sourceIp', 'level', 'from', 'to',
] as const;

const ACTIONS = [
  'user.create', 'user.update', 'user.role.change', 'user.disable', 'user.enable',
  'user.password.reset', 'user.lock', 'user.unlock', 'authorization.denied',
  'audit.export', 'CREATE', 'UPDATE', 'DELETE', 'CSV_IMPORT', 'BATCH_CREATE', 'BATCH_DELETE',
] as const;

type QueryChanges = Record<string, string | number | null>;

function sourceIp(log: Pick<AuditLogRecord, 'source' | 'operatorIp'>) {
  return log.source?.ip || log.operatorIp || '—';
}

function actorName(log: AuditLogRecord) {
  return log.actorContext?.displayName || log.actorContext?.username || log.actor || '—';
}

function actorUsername(log: AuditLogRecord) {
  return log.actorContext?.username || log.actor || '—';
}

function resourceId(log: AuditLogRecord) {
  return log.resource?.id || log.resource?.name || log.targetId || '—';
}

function localDate(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function displayTimestamp(formatDateTime: ReturnType<typeof useI18n>['formatDateTime'], value: string) {
  return formatDateTime(value, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).replaceAll('/', '-');
}

export function AuditConsole() {
  const { t, formatDateTime } = useI18n();
  const { can } = usePermissions();
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get('event');

  const navigate = (changes: QueryChanges, replace = false) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '' || value === 'all') next.delete(key);
      else next.set(key, String(value));
    }
    const url = next.size ? `/audit-logs?${next}` : '/audit-logs';
    router[replace ? 'replace' : 'push'](url, { scroll: false });
  };

  const apiParams = new URLSearchParams();
  for (const key of LIST_QUERY_KEYS) {
    const value = params.get(key);
    if (value) apiParams.set(key, value);
  }
  if (!apiParams.has('page')) apiParams.set('page', '1');
  if (!apiParams.has('pageSize')) apiParams.set('pageSize', '20');
  const { data, error, isLoading, mutate } = useSWR<AuditListResponse>(`/api/audit?${apiParams}`, fetcher);
  const page = Number(params.get('page') || 1);
  const pageSize = Number(params.get('pageSize') || 20);

  useEffect(() => {
    if (data && data.pagination.page !== page) navigate({ page: data.pagination.page }, true);
    // URL navigation is intentionally the only pagination state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.pagination.page, page]);

  const setFilter = (key: string, value: string, replace = false) => navigate({ [key]: value, page: 1, event: null }, replace);
  const reset = () => {
    const cleared: QueryChanges = { event: null, range: null };
    for (const key of LIST_QUERY_KEYS) cleared[key] = null;
    navigate(cleared);
  };
  const setRange = (range: string) => {
    const now = new Date();
    if (range === 'all') return navigate({ range: null, from: null, to: null, page: 1 });
    if (range === 'today') return navigate({ range, from: localDate(now), to: localDate(now), page: 1 });
    const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
    const from = new Date(now.getTime() - days * 86_400_000);
    return navigate({ range, from: range === '24h' ? from.toISOString() : localDate(from), to: range === '24h' ? now.toISOString() : localDate(now), page: 1 });
  };
  const exportLogs = (format: 'csv' | 'json') => {
    const query = new URLSearchParams(apiParams);
    query.delete('page'); query.delete('pageSize'); query.set('format', format);
    window.location.assign(`/api/audit/export?${query}`);
  };

  const summary = data?.summary ?? { matched: 0, failed: 0, denied: 0, highRisk: 0 };
  const logs = data?.logs ?? [];
  const selectedAction = params.get('action') || '';
  const canExport = can('audit.export');
  const canViewFullSourceIp = can('audit.source-ip.read-full');

  return (
    <div className={`container animate-fade-in ${styles.console}`}>
      <PageHeader
        eyebrow="AUDIT / INVESTIGATION"
        icon={<History size={23} />}
        title={t('audit_console_title')}
        description={t('audit_console_subtitle')}
        status={<><ShieldAlert size={15} />{t('audit_tracking')}</>}
        actions={<div className={styles.headerActions}>
          <button type="button" className="btn btn-outline" onClick={() => void mutate()}><RefreshCw size={15} />{t('refresh')}</button>
          {canExport ? <div className={styles.exportGroup}>
            <button type="button" className="btn btn-outline" onClick={() => exportLogs('csv')} disabled={!summary.matched}><Download size={15} />CSV</button>
            <button type="button" className="btn btn-outline" onClick={() => exportLogs('json')} disabled={!summary.matched}>JSON</button>
          </div> : null}
        </div>}
      />

      <MetricStrip ariaLabel={t('audit_metrics_label')} items={[
        { key: 'matched', icon: <History size={17} />, label: t('audit_metric_matched'), value: summary.matched },
        { key: 'failed', icon: <FileWarning size={17} />, label: t('audit_metric_failed'), value: summary.failed, tone: 'danger' },
        { key: 'denied', icon: <AlertTriangle size={17} />, label: t('audit_metric_denied'), value: summary.denied, tone: 'warning' },
        { key: 'risk', icon: <ShieldAlert size={17} />, label: t('audit_metric_high_risk'), value: summary.highRisk, tone: 'danger' },
      ]} />

      <section className={`glass-card ${styles.filters}`} aria-label={t('audit_filters_label')}>
        <div className={styles.primaryFilters}>
          <label className={styles.search}>
            <Search size={17} />
            <span className="sr-only">{t('audit_search_identifiers')}</span>
            <input value={params.get('q') || ''} onChange={(event) => setFilter('q', event.target.value, true)} placeholder={t('audit_search_identifiers')} />
          </label>
          <select aria-label={t('audit_filter_result')} value={params.get('result') || ''} onChange={(event) => setFilter('result', event.target.value)}>
            <option value="">{t('audit_filter_all_results')}</option><option value="success">SUCCESS</option><option value="failed">FAILED</option><option value="denied">DENIED</option>
          </select>
          <select aria-label={t('audit_filter_module')} value={params.get('module') || ''} onChange={(event) => setFilter('module', event.target.value)}>
            <option value="">{t('audit_filter_all_modules')}</option>
            {['audit', 'users', 'subscribers', 'profiles', 'approvals', 'ocs', 'rating', 'system', 'security', 'legacy'].map((module) => <option key={module} value={module}>{module}</option>)}
          </select>
          <select aria-label={t('audit_filter_risk')} value={params.get('risk') || ''} onChange={(event) => setFilter('risk', event.target.value)}>
            <option value="">{t('audit_filter_all_risks')}</option><option value="low">LOW</option><option value="medium">MEDIUM</option><option value="high">HIGH</option><option value="critical">CRITICAL</option>
          </select>
          <select aria-label={t('audit_filter_action')} value={selectedAction} onChange={(event) => setFilter('action', event.target.value)}>
            <option value="">{t('audit_action_all')}</option>
            {selectedAction && !ACTIONS.includes(selectedAction as (typeof ACTIONS)[number]) ? <option value={selectedAction}>{selectedAction}</option> : null}
            {ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
          </select>
          <select aria-label={t('audit_filter_time')} value={params.get('range') || (params.get('from') || params.get('to') ? 'custom' : 'all')} onChange={(event) => setRange(event.target.value)}>
            <option value="all">{t('audit_time_all')}</option><option value="today">{t('audit_time_today')}</option><option value="24h">{t('audit_time_24h')}</option><option value="7d">{t('audit_time_7d')}</option><option value="30d">{t('audit_time_30d')}</option><option value="custom">{t('audit_time_custom')}</option>
          </select>
        </div>
        <div className={styles.filterActions}>
          <details className={styles.moreFilters}>
            <summary><Filter size={15} />{t('audit_more_filters')}</summary>
            <div className={styles.advancedGrid}>
              <label>{t('audit_filter_actor')}<input value={params.get('actor') || ''} onChange={(e) => setFilter('actor', e.target.value, true)} /></label>
              <label>{t('audit_filter_resource_type')}<input value={params.get('resourceType') || ''} onChange={(e) => setFilter('resourceType', e.target.value, true)} /></label>
              <label>{t('audit_filter_resource_id')}<input value={params.get('resourceId') || ''} onChange={(e) => setFilter('resourceId', e.target.value, true)} /></label>
              <label>{t('audit_filter_request_id')}<input value={params.get('requestId') || ''} onChange={(e) => setFilter('requestId', e.target.value, true)} /></label>
              <label>{t('audit_filter_correlation_id')}<input value={params.get('correlationId') || ''} onChange={(e) => setFilter('correlationId', e.target.value, true)} /></label>
              <label>{t('audit_filter_approval_id')}<input value={params.get('approvalId') || ''} onChange={(e) => setFilter('approvalId', e.target.value, true)} /></label>
              {canViewFullSourceIp ? <label>{t('audit_filter_source_ip')}<input value={params.get('sourceIp') || ''} onChange={(e) => setFilter('sourceIp', e.target.value, true)} /></label> : null}
              <label>{t('audit_filter_level')}<select value={params.get('level') || ''} onChange={(e) => setFilter('level', e.target.value)}><option value="">{t('audit_level_all')}</option><option value="info">INFO</option><option value="warning">WARNING</option></select></label>
              <label>{t('audit_filter_from')}<input type="date" value={(params.get('from') || '').slice(0, 10)} onChange={(e) => navigate({ range: 'custom', from: e.target.value, page: 1 }, true)} /></label>
              <label>{t('audit_filter_to')}<input type="date" value={(params.get('to') || '').slice(0, 10)} onChange={(e) => navigate({ range: 'custom', to: e.target.value, page: 1 }, true)} /></label>
            </div>
          </details>
          <button type="button" className="btn btn-outline" onClick={reset}><RotateCcw size={15} />{t('audit_reset_filters')}</button>
        </div>
      </section>

      <section className={`glass-card ${styles.tableCard}`} aria-label={t('audit_table_label')}>
        {isLoading ? <LoadingRows columns={7} rows={8} /> : error ? <EmptyState icon={<AlertTriangle size={42} />} title={t('audit_load_failed')} description={error.message} action={<button type="button" className="btn btn-outline" onClick={() => void mutate()}><RefreshCw size={15} />{t('refresh')}</button>} /> : logs.length === 0 ? <EmptyState icon={<CheckCircle2 size={42} />} title={t('audit_no_data')} description={t('audit_no_data_hint')} /> : (
          <div className={styles.tableScroll}>
            <table className={`data-table ${styles.table}`}>
              <caption className="sr-only">{t('audit_table_label')}</caption>
              <thead><tr><th data-column-priority="essential">{t('audit_col_time')}</th><th data-column-priority="essential">{t('audit_col_operator')}</th><th data-column-priority="essential">{t('audit_col_module_action')}</th><th data-column-priority="important">{t('audit_col_target')}</th><th data-column-priority="supplementary">{t('audit_col_risk')}</th><th data-column-priority="important">{t('audit_col_result')}</th><th data-column-priority="supplementary">{t('audit_col_source')}</th><th data-column-priority="supplementary">{t('actions')}</th></tr></thead>
              <tbody>{logs.map((log) => (
                <tr key={log.id} tabIndex={0} onClick={() => navigate({ event: log.id })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate({ event: log.id }); } }}>
                  <td data-label={t('audit_col_time')} data-column-priority="essential"><time dateTime={log.timestamp} title={log.timestamp}>{displayTimestamp(formatDateTime, log.timestamp)}</time></td>
                  <td data-label={t('audit_col_operator')} data-column-priority="essential"><strong>{actorName(log as AuditLogRecord)}</strong><small>{log.actorContext?.role || '—'}</small></td>
                  <td data-label={t('audit_col_module_action')} data-column-priority="essential"><span>{log.module || t('audit_uncategorized')}</span><strong>{log.action}</strong></td>
                  <td data-label={t('audit_col_target')} data-column-priority="important"><code>{resourceId(log as AuditLogRecord)}</code></td>
                  <td data-label={t('audit_col_risk')} data-column-priority="supplementary"><RiskBadge risk={log.riskLevel} /></td>
                  <td data-label={t('audit_col_result')} data-column-priority="important"><AuditResultBadge result={log.result} /></td>
                  <td data-label={t('audit_col_source')} data-column-priority="supplementary"><code>{sourceIp(log as AuditLogRecord)}</code></td>
                  <td data-label={t('actions')} data-column-priority="supplementary"><button type="button" className="btn btn-outline" onClick={(event) => { event.stopPropagation(); navigate({ event: log.id }); }}><Eye size={14} />{t('view')}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <DataTablePagination
          page={data?.pagination.page || 1} pageSize={data?.pagination.pageSize || pageSize} total={data?.pagination.total || 0}
          visibleCount={logs.length} totalPages={data?.pagination.totalPages || 1} pageSizes={[20, 50, 100]}
          labels={{ showing: t('pagination_showing'), to: t('pagination_to'), of: t('pagination_of'), entries: t('pagination_entries'), previous: t('pagination_previous'), next: t('pagination_next'), perPage: t('pagination_per_page') }}
          onPageChange={(nextPage) => navigate({ page: nextPage, event: null })}
          onPageSizeChange={(nextSize) => navigate({ pageSize: nextSize, page: 1, event: null })}
        />
      </section>

      <AuditDetailDrawer id={selectedId} onClose={() => navigate({ event: null }, true)} />
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value?: string }) {
  const { showToast } = useNotification();
  if (!value) return <span>—</span>;
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    showToast({ type: 'success', message: `${label} copied`, duration: 2200 });
  };
  return <span className={styles.copyValue}><code>{value}</code><button type="button" onClick={() => void copy()} aria-label={`${label}: ${value}`} title="Copy"><Clipboard size={13} /></button></span>;
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.detailSection}><h3>{title}</h3>{children}</section>;
}

function AuditDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const { data, error, isLoading, mutate } = useSWR<{ log: AuditLogRecord }>(id ? `/api/audit/${encodeURIComponent(id)}` : null, fetcher);
  const log = data?.log;
  const eventId = log?.eventId || log?.id;
  const requestId = log?.request?.requestId;
  const correlationId = log?.request?.correlationId || log?.correlationId;

  return <Dialog open={Boolean(id)} onClose={onClose} overlayClassName={styles.drawerLayer} className={styles.drawer} labelledBy={titleId} initialFocusRef={closeRef}>
    <header className={styles.drawerHeader}><div><span>AUDIT EVENT</span><h2 id={titleId}>{eventId || id}</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label={t('close')}><X size={18} /></button></header>
    <div className={styles.drawerBody}>
      {isLoading ? <LoadingRows columns={2} rows={8} /> : error ? <EmptyState icon={<AlertTriangle size={42} />} title={t('audit_detail_failed')} description={error.message} action={<button type="button" className="btn btn-outline" onClick={() => void mutate()}><RefreshCw size={15} />{t('refresh')}</button>} /> : log ? <>
        <DetailSection title={t('audit_detail_event')}>
          <div className={styles.eventLead}><CopyValue label="Event ID" value={eventId} /><div><AuditResultBadge result={log.result} /><RiskBadge risk={log.riskLevel} /></div><strong>{log.action}</strong><time dateTime={log.timestamp}>{log.timestamp}</time></div>
        </DetailSection>
        <DetailSection title={t('audit_detail_actor')}><dl className={styles.detailGrid}>
          <div><dt>{t('audit_actor_type')}</dt><dd>{log.actorContext?.type || '—'}</dd></div>
          <div><dt>{t('audit_user')}</dt><dd><CopyValue label="Username" value={actorUsername(log) === '—' ? undefined : actorUsername(log)} /></dd></div>
          <div><dt>{t('audit_role')}</dt><dd>{log.actorContext?.role || '—'}</dd></div>
          <div><dt>{t('audit_user_id')}</dt><dd><CopyValue label="User ID" value={log.actorContext?.userId} /></dd></div>
          <div><dt>{t('audit_source_ip')}</dt><dd><CopyValue label="Source IP" value={sourceIp(log) === '—' ? undefined : sourceIp(log)} /></dd></div>
          <div><dt>{t('audit_user_agent')}</dt><dd>{log.source?.userAgent || '—'}</dd></div>
        </dl></DetailSection>
        <DetailSection title={t('audit_detail_target')}><dl className={styles.detailGrid}>
          <div><dt>{t('audit_resource_type')}</dt><dd>{log.resource?.type || '—'}</dd></div>
          <div><dt>{t('audit_resource_id')}</dt><dd><CopyValue label="Resource ID" value={resourceId(log) === '—' ? undefined : resourceId(log)} /></dd></div>
          <div><dt>{t('audit_resource_name')}</dt><dd>{log.resource?.name || '—'}</dd></div>
        </dl></DetailSection>
        <DetailSection title={t('audit_detail_request')}><dl className={styles.detailGrid}>
          <div><dt>HTTP Method</dt><dd>{log.request?.method || '—'}</dd></div><div><dt>Path</dt><dd><code>{log.request?.path || '—'}</code></dd></div>
          <div><dt>Request ID</dt><dd><CopyValue label="Request ID" value={requestId} /></dd></div><div><dt>Correlation ID</dt><dd><CopyValue label="Correlation ID" value={correlationId} /></dd></div>
          <div><dt>{t('audit_source_ip')}</dt><dd><CopyValue label="Source IP" value={sourceIp(log) === '—' ? undefined : sourceIp(log)} /></dd></div>
        </dl></DetailSection>
        <DetailSection title={t('audit_detail_change')}><ChangeDiff before={log.oldData} after={log.newData} compact /></DetailSection>
        {log.approvalId ? <DetailSection title={t('audit_detail_approval')}><div className={styles.approvalLink}><CopyValue label="Approval ID" value={log.approvalId} /><Link href={`/approvals?approvalId=${encodeURIComponent(log.approvalId)}`}>{t('audit_view_approval')}</Link></div></DetailSection> : null}
        {log.result === 'failed' && log.error ? <DetailSection title={t('audit_detail_error')}><dl className={styles.detailGrid}><div><dt>{t('audit_error_code')}</dt><dd>{log.error.code || '—'}</dd></div><div><dt>{t('audit_error_message')}</dt><dd>{log.error.message || '—'}</dd></div></dl></DetailSection> : null}
        {log.metadata ? <DetailSection title={t('audit_detail_metadata')}><details className={styles.jsonDetails}><summary>{t('audit_show_metadata')}</summary><pre>{JSON.stringify(log.metadata, null, 2)}</pre></details></DetailSection> : null}
      </> : null}
    </div>
  </Dialog>;
}
