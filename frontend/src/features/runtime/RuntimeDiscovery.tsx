/*
 * Runtime discovery surface.
 *
 * Renders the bounded local process snapshot produced by the backend scanner.
 * The same component serves two placements:
 *   - `panel`: an additional section on the operational dashboard;
 *   - `full`: an additional view mode inside the Inventory route.
 *
 * The surface works with zero Inventory, Discovery, Topology or NF Health
 * records: recognition is independent of canonical registration. A component
 * that is merely recognized is rendered as such, and is visually distinct from a
 * verified running process.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cpu,
  HardDrive,
  RefreshCw,
  ScanLine,
  Search,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { hasPermission } from '../../lib/permissions';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { requestRuntimeScan } from './runtime-api';
import {
  RUNTIME_CATEGORIES,
  filterComponents,
  formatBytes,
  formatPercent,
  groupByCategory,
  reasonLabelKey,
  statusLabelKey,
  summarize,
  type StatusFilter,
} from './runtime-model';
import type { RuntimeComponent, RuntimeMeta, RuntimeObservations, RuntimeStatus } from './runtime-types';
import { RuntimeBootstrapDialog } from './RuntimeBootstrapDialog';
import { resolveRuntimeObservations, useRuntimeStream } from './use-runtime-stream';
import styles from '../../styles/modules/runtime.module.css';

const REFRESH_INTERVAL_MS = 15000;

function toneFor(status: RuntimeStatus): string {
  switch (status) {
    case 'running':
      return styles.toneHealthy;
    case 'stopped':
      return styles.toneDanger;
    case 'unverified':
    case 'permission_denied':
      return styles.toneWarning;
    case 'stale':
      return styles.toneStale;
    case 'not_detected':
    case 'not_configured':
    case 'not_applicable':
      return styles.toneMuted;
    default:
      return styles.toneUnknown;
  }
}

function StatusBadge({ status, reason }: { status: RuntimeStatus; reason: string }) {
  const { t } = useI18n();
  return (
    <span className={`${styles.badge} ${toneFor(status)}`} title={t(reasonLabelKey(reason))}>
      {t(statusLabelKey(status))}
    </span>
  );
}

function EvidenceChip({ component }: { component: RuntimeComponent }) {
  const { t } = useI18n();
  if (component.verified) {
    return <span className={`${styles.evidence} ${styles.evidenceVerified}`}>{t('runtime_evidence_verified')}</span>;
  }
  if (component.evidence === 'unverified') {
    return <span className={`${styles.evidence} ${styles.evidenceUnverified}`}>{t('runtime_evidence_unverified')}</span>;
  }
  return <span className={`${styles.evidence} ${styles.evidenceNone}`}>{t('runtime_evidence_none')}</span>;
}

function AssociationCell({ component }: { component: RuntimeComponent }) {
  const { t } = useI18n();
  const inventory = component.inventoryAssociation;
  const monitoring = component.nfHealthAssociation;

  if (inventory.state === 'unresolved') {
    return <span className={styles.assocUnresolved}>{t('runtime_assoc_unresolved')}</span>;
  }
  return (
    <span className={styles.assoc}>
      {inventory.state === 'associated' && inventory.id ? (
        <Link to={`/inventory/${inventory.id}`}>{t('runtime_assoc_resource')}</Link>
      ) : (
        <span className={styles.assocAbsent}>{t('runtime_assoc_none')}</span>
      )}
      {monitoring.state === 'associated' && monitoring.id ? (
        <Link to={`/nf-health/${monitoring.id}`}>{t('runtime_assoc_target')}</Link>
      ) : null}
    </span>
  );
}

function ComponentRow({ component }: { component: RuntimeComponent }) {
  const { t, formatDateTime } = useI18n();
  const cpu = formatPercent(component.cpuPercent);
  const rss = formatBytes(component.memoryRssBytes);
  const vms = formatBytes(component.memoryVmsBytes);

  return (
    <tr data-component-id={component.componentId} data-status={component.runtimeStatus}>
      <th scope="row" className={styles.nameCell}>
        <span className={styles.componentName}>{component.displayName}</span>
        <code className={styles.processName}>{component.processName}</code>
        {!component.cnmsCompatible ? <span className={styles.xcloudOnly}>{t('runtime_xcloud_only')}</span> : null}
      </th>
      <td>
        <StatusBadge status={component.runtimeStatus} reason={component.statusReason} />
      </td>
      <td><EvidenceChip component={component} /></td>
      <td className={styles.mono}>{component.primaryPid > 0 ? component.primaryPid : '-'}</td>
      <td className={styles.mono}>
        {component.workerCount}
        {component.workersTruncated ? <span className={styles.truncated}>{t('runtime_workers_truncated')}</span> : null}
      </td>
      <td className={styles.mono}>{cpu || t('runtime_unavailable')}</td>
      <td className={styles.mono}>{rss || t('runtime_unavailable')}</td>
      <td className={styles.mono}>{vms || t('runtime_unavailable')}</td>
      <td>
        {component.monitoring.state === 'supported' ? (
          <span className={styles.monitoringSupported}>{t('runtime_monitoring_supported')}</span>
        ) : (
          <span className={styles.monitoringUnsupported} title={component.monitoring.reason ?? ''}>
            {t('runtime_monitoring_not_supported')}
          </span>
        )}
      </td>
      <td><AssociationCell component={component} /></td>
      <td className={styles.mono}>{component.lastScannedAt ? formatDateTime(component.lastScannedAt) : '-'}</td>
    </tr>
  );
}

type SurfaceProps = { variant: 'panel' | 'full' };

function RuntimeSurface({ variant }: SurfaceProps) {
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const canConfigure = hasPermission(user, 'core.configure');

  const observations = useRead<RuntimeObservations>('/api/runtime/observations');
  const meta = useRead<RuntimeMeta>('/api/runtime/meta');
  const stream = useRuntimeStream();

  // The shared stream pushes the same freshness-projected snapshot the polled
  // endpoint serves; the polled read only covers the gap while the stream is
  // not connected.
  const observationsData = resolveRuntimeObservations(stream, observations.data);

  const [template, setTemplate] = useState('auto');
  const [status, setStatus] = useState<StatusFilter>('');
  const [category, setCategory] = useState<'' | (typeof RUNTIME_CATEGORIES)[number]>('');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [bootstrapOpen, setBootstrapOpen] = useState(false);

  const refresh = useCallback(() => {
    void observations.mutate();
    void meta.mutate();
  }, [observations, meta]);

  // Bounded auto-refresh of the cached snapshot. It never triggers a scan and
  // is only needed while the live stream is not connected.
  useEffect(() => {
    if (stream.status === 'connected') return undefined;
    const timer = window.setInterval(() => {
      if (!observations.isValidating) void observations.mutate();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [observations, stream.status]);

  const rescan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      await requestRuntimeScan();
      refresh();
    } catch (error) {
      setScanError(error instanceof Error ? error.message : t('runtime_scan_start_failed'));
    } finally {
      setScanning(false);
    }
  };

  const components = observationsData?.snapshot.components ?? [];
  const scan = observationsData?.snapshot.scan;
  const host = observationsData?.snapshot.host ?? meta.data?.host;
  const registry = observationsData?.snapshot.registry ?? meta.data?.registry;

  const filtered = useMemo(
    () => filterComponents(components, { template, status, query, category }),
    [components, template, status, query, category],
  );
  const summary = useMemo(() => summarize(filtered), [filtered]);
  const groups = useMemo(() => groupByCategory(filtered), [filtered]);

  const loading = observations.isLoading && components.length === 0;
  const failed = Boolean(observations.error);
  const scannerEnabled = meta.data?.scannerEnabled ?? true;
  const visibility = host?.visibility ?? 'host';

  const toggle = (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  return (
    <section
      className={variant === 'panel' ? styles.panel : styles.view}
      aria-labelledby={`runtime-title-${variant}`}
      data-testid="runtime-discovery"
    >
      <div className={styles.head}>
        <div>
          <h2 id={`runtime-title-${variant}`} className={styles.title}>
            <ScanLine size={18} /> {t('runtime_title')}
          </h2>
          <p className={styles.note}>{t('runtime_note')}</p>
          {host ? (
            <p className={styles.hostLine}>
              <Server size={14} aria-hidden="true" />
              <span>{host.hostName}</span>
              <code className={styles.hostId}>{host.hostId}</code>
              {visibility !== 'host' ? (
                <span className={styles.visibility}>
                  <AlertTriangle size={13} aria-hidden="true" />
                  {t(`runtime_visibility_${visibility}`)}
                </span>
              ) : null}
              {!scannerEnabled ? <span className={styles.disabled}>{t('runtime_scanner_disabled')}</span> : null}
            </p>
          ) : null}
        </div>
        <div className={styles.actions}>
          {registry ? (
            <span className={styles.registryChip}>
              {t('runtime_registry_summary', {
                cnms: registry.cnmsComponents,
                total: registry.effectiveEntries,
              })}
            </span>
          ) : null}
          {scan?.status && scan.status !== 'not_scanned' ? (
            <span className={styles.scanChip} data-scan-status={scan.status}>
              {t('runtime_scan_status', { status: t(`runtime_scan_state_${scan.status}`) })}
              {scan.completedAt ? <span className={styles.scanTime}>{formatDateTime(scan.completedAt)}</span> : null}
            </span>
          ) : null}
          <button type="button" className={styles.button} onClick={refresh} aria-label={t('runtime_refresh')}>
            <RefreshCw size={15} /> {t('runtime_refresh')}
          </button>
          {canConfigure ? (
            <button
              type="button"
              className={styles.button}
              onClick={rescan}
              disabled={scanning || !scannerEnabled}
              aria-label={t('runtime_rescan')}
            >
              <ScanLine size={15} /> {scanning ? t('runtime_scanning') : t('runtime_rescan')}
            </button>
          ) : null}
          {canConfigure && meta.data?.bootstrapEnabled ? (
            <button type="button" className={styles.primaryButton} onClick={() => setBootstrapOpen(true)}>
              <ShieldCheck size={15} /> {t('runtime_bootstrap_open')}
            </button>
          ) : null}
        </div>
      </div>

      {scanError ? <p className={styles.error} role="alert">{scanError}</p> : null}
      {stream.status === 'connected' ? (
        <p className={styles.liveNote} role="status">
          <Activity size={14} aria-hidden="true" /> {t('runtime_stream_live')}
        </p>
      ) : null}
      {scan && scan.status === 'incomplete' ? (
        <p className={styles.warning} role="status">
          {t('runtime_scan_incomplete_detail', { count: scan.entriesUnreadable })}
        </p>
      ) : null}
      {scan && scan.status === 'failed' ? (
        <p className={styles.error} role="alert">{t('runtime_scan_failed_detail', { reason: scan.errorSummary ?? '' })}</p>
      ) : null}
      {observationsData && !observationsData.associationsComplete ? (
        <p className={styles.warning} role="status">{t('runtime_assoc_incomplete')}</p>
      ) : null}

      {loading ? (
        <LoadingRows rows={3} />
      ) : failed ? (
        <EmptyState icon={<Server size={40} />} title={t('runtime_error_title')} description={t('runtime_error_body')} />
      ) : components.length === 0 ? (
        <EmptyState icon={<Server size={40} />} title={t('runtime_empty_title')} description={t('runtime_empty_body')} />
      ) : (
        <>
          <div className={styles.summary} role="list">
            {[
              { key: 'running', value: summary.running, tone: styles.toneHealthy },
              { key: 'stopped', value: summary.stopped, tone: styles.toneDanger },
              { key: 'attention', value: summary.attention, tone: styles.toneWarning },
              { key: 'not_detected', value: summary.notDetected, tone: styles.toneMuted },
              { key: 'expected', value: summary.expected, tone: styles.toneStale },
              { key: 'monitored', value: summary.monitored, tone: styles.toneHealthy },
            ].map((item) => (
              <div key={item.key} className={styles.summaryCard} role="listitem">
                <span className={styles.summaryValue}>{item.value}</span>
                <span className={`${styles.summaryLabel} ${item.tone}`}>{t(`runtime_summary_${item.key}`)}</span>
              </div>
            ))}
          </div>

          <div className={styles.toolbar}>
            <label className={styles.field}>
              <span>{t('runtime_filter_template')}</span>
              <select value={template} onChange={(event) => setTemplate(event.target.value)}>
                {(meta.data?.templates ?? ['auto', '5g', '4g', 'ims']).map((value) => (
                  <option key={value} value={value}>{t(`runtime_template_${value}`)}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('runtime_filter_status')}</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
                <option value="">{t('runtime_filter_all')}</option>
                <option value="running">{t('runtime_status_running')}</option>
                <option value="stopped">{t('runtime_status_stopped')}</option>
                <option value="attention">{t('runtime_summary_attention')}</option>
                <option value="not_detected">{t('runtime_summary_not_detected')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('runtime_filter_category')}</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as '' | (typeof RUNTIME_CATEGORIES)[number])}
              >
                <option value="">{t('runtime_filter_all')}</option>
                {RUNTIME_CATEGORIES.map((value) => (
                  <option key={value} value={value}>{t(`runtime_category_${value}`)}</option>
                ))}
              </select>
            </label>
            <label className={styles.search}>
              <span className="sr-only">{t('runtime_search')}</span>
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder={t('runtime_search')}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button type="button" aria-label={t('runtime_clear_search')} onClick={() => setQuery('')}>
                  <X size={14} />
                </button>
              ) : null}
            </label>
          </div>

          {filtered.length === 0 ? (
            <p className={styles.emptyFiltered}>{t('runtime_no_match')}</p>
          ) : (
            <div className={styles.groups}>
              {groups.map((group) => {
                const isOpen = collapsed[group.category] !== true;
                return (
                  <section key={group.category} className={styles.group}>
                    <button
                      type="button"
                      className={styles.groupToggle}
                      aria-expanded={isOpen}
                      onClick={() => toggle(group.category)}
                    >
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span className={styles.groupName}>{t(`runtime_category_${group.category}`)}</span>
                      <span className={styles.groupCount}>
                        {t('runtime_group_count', { running: group.running, total: group.total })}
                      </span>
                    </button>
                    {isOpen ? (
                      <div className={styles.tableScroll}>
                        <table className={styles.table}>
                          <caption className={styles.caption}>{t('runtime_table_caption')}</caption>
                          <thead>
                            <tr>
                              <th scope="col">{t('runtime_col_component')}</th>
                              <th scope="col">{t('runtime_col_status')}</th>
                              <th scope="col">{t('runtime_col_evidence')}</th>
                              <th scope="col">{t('runtime_col_pid')}</th>
                              <th scope="col">{t('runtime_col_workers')}</th>
                              <th scope="col">{t('runtime_col_cpu')}</th>
                              <th scope="col">{t('runtime_col_rss')}</th>
                              <th scope="col">{t('runtime_col_vms')}</th>
                              <th scope="col">{t('runtime_col_monitoring')}</th>
                              <th scope="col">{t('runtime_col_associations')}</th>
                              <th scope="col">{t('runtime_col_scanned')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.components.map((component) => (
                              <ComponentRow key={component.componentId} component={component} />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}

          <p className={styles.footnote}>
            <Activity size={14} aria-hidden="true" /> {t('runtime_footnote_evidence')}
            <Cpu size={14} aria-hidden="true" /> {t('runtime_footnote_cpu')}
            <HardDrive size={14} aria-hidden="true" /> {t('runtime_footnote_memory')}
          </p>
        </>
      )}

      {bootstrapOpen ? (
        <RuntimeBootstrapDialog
          template={template}
          onClose={() => setBootstrapOpen(false)}
          onApplied={refresh}
        />
      ) : null}
    </section>
  );
}

/** Dashboard placement: an additional section below the operational overview. */
export function RuntimeDiscoveryPanel() {
  return <RuntimeSurface variant="panel" />;
}

/** Inventory placement: an additional view mode over the same resource authority. */
export function RuntimeDiscoveryView() {
  return <RuntimeSurface variant="full" />;
}
