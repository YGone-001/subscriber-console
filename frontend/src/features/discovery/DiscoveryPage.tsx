/*
 * NF Discovery route (/discovery).
 *
 * The observation plane is organized into three exclusive in-page views:
 *
 *   view=candidates (default) the daily queue: observed -> linked -> monitored
 *   view=sources               low-frequency endpoint configuration
 *   view=runs                  low-frequency bounded scan history
 *
 * The source list is no longer a second full table above the queue; it is a
 * bounded selector on the candidates view. No SPA route is added. The page owns
 * the shared page frame, the full-collection KPI strip, the operator feedback
 * channel and the governed mutation entry points; every view owns exactly one
 * bounded list with its own loading and error state, so a failing source or
 * runs read never blanks the candidate queue.
 *
 * Link and unlink write discovery metadata only. Inventory stays authoritative.
 * Observation state, registry status and the monitoring association are three
 * independent facts and are never collapsed into an operational health flag.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Radar } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { OperationFeedback } from '../../components/ui/OperationFeedback';
import MetricStrip, { type MetricStripItem } from '../../components/ui/MetricStrip';
import { ViewSwitch, type ViewSwitchOption } from '../../components/ui/ViewSwitch';
import { SkeletonKpiStrip } from '../../components/ui/LoadingSkeleton';
import { scopeKpiDetail } from '../operations/kpi-detail';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import {
  discoveryKpisFromSummary,
  fetchOperationsSummary,
  type DiscoverySummarySection,
} from '../operations/operations-summary';
import {
  createDiscoverySource,
  linkDiscoveryCandidate,
  scanDiscoverySource,
  unlinkDiscoveryCandidate,
} from './discovery-api';
import { buildLinkCandidateRequest, buildUnlinkCandidateRequest } from './discovery-builders';
import {
  buildCreateSourceRequest,
  CANONICAL_ADAPTER_TYPES,
  CANONICAL_TRANSPORT_MODES,
  DEFAULT_SCAN_INTERVAL_SECONDS,
  MAX_SCAN_INTERVAL_SECONDS,
} from './discovery-validation';
import { describeMutationError } from './discovery-view-model';
import type {
  DiscoveryAdapterType,
  DiscoverySource,
  DiscoveryTransportMode,
  NfObservation,
} from './discovery-types';
import { RuntimeBootstrapDialog } from '../runtime/RuntimeBootstrapDialog';
import { fetchRuntimeObservations } from '../runtime/runtime-api';
import type { RuntimeComponent } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import { CandidateDetailDrawer } from './CandidateDetailDrawer';
import { DiscoveryCandidatesView } from './DiscoveryCandidatesView';
import { DiscoveryRunsView } from './DiscoveryRunsView';
import { DiscoverySourcesView } from './DiscoverySourcesView';
import styles from '../../styles/modules/discovery.module.css';

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

/* Three exclusive in-page views. No SPA route is added: the workbench
 * keeps the canonical /discovery route and one tab. */
const DISCOVERY_VIEWS = ['candidates', 'sources', 'runs'] as const;
type DiscoveryView = (typeof DISCOVERY_VIEWS)[number];

const DISCOVERY_VIEW_LABEL: Record<DiscoveryView, string> = {
  candidates: 'discovery_view_candidates',
  sources: 'discovery_view_sources',
  runs: 'discovery_view_runs',
};

export function DiscoveryPage() {
  const { t } = useI18n();
  const { user } = useAuth();

  const canRead = hasPermission(user, 'core.read');
  const canConfigure = hasPermission(user, 'core.configure');

  /* The view, shared source selector, candidate filters, source-name query,
   * source-name query, the run status filter and the cursor all live in the
   * URL. A filter change drops the cursor through the shared contract, so page
   * N of a discarded filter set can never be requested. */
  const url = useOperationsUrlState({
    keys: ['q', 'sourceId', 'state', 'nfType', 'runStatus'],
    views: DISCOVERY_VIEWS,
    defaultView: 'candidates',
  });
  const discoveryView = url.view as DiscoveryView;

  const sourceIdFilter = url.filters.sourceId ?? '';
  const observationFilter = url.filters.state ?? '';
  const nfTypeFilter = url.filters.nfType ?? '';
  const runStatusFilter = url.filters.runStatus ?? '';
  const sourceQuery = url.filters.q ?? '';

  /* A session that is known to lack core.read keeps a visible notice; the views
   * still render so their own bounded reads report their own failures. */
  const readDenied = user !== null && !canRead;

  const [summary, setSummary] = useState<DiscoverySummarySection | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await fetchOperationsSummary(['discovery']);
      setSummary(res.discovery ?? null);
    } catch {
      // A failed summary only degrades the KPI strip to explicit unavailable
      // labels; the views below load their own bounded lists.
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canRead) {
      setSummaryLoading(false);
      return;
    }
    void loadSummary();
  }, [canRead, loadSummary]);

  /* Runtime onboarding context. The runtime plane is auxiliary: candidates
   * remain readable when it is unavailable, and its failure only disables the
   * onboarding section inside the detail drawer. */
  const [runtimeComponents, setRuntimeComponents] = useState<RuntimeComponent[]>([]);
  const [runtimePollFailed, setRuntimePollFailed] = useState(false);
  const runtimeStream = useRuntimeStream();

  const loadRuntime = useCallback(async () => {
    try {
      const observations = await fetchRuntimeObservations();
      setRuntimeComponents(observations.snapshot.components ?? []);
      setRuntimePollFailed(false);
    } catch {
      setRuntimeComponents([]);
      setRuntimePollFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    void loadRuntime();
  }, [canRead, loadRuntime]);

  const runtimeObservations = resolveRuntimeObservations(runtimeStream, undefined);
  const effectiveRuntimeComponents = runtimeObservations?.snapshot.components ?? runtimeComponents;
  const runtimeStreamConnected = runtimeStream.status === 'connected' && Boolean(runtimeStream.data);
  const runtimeUnavailable = !runtimeStreamConnected && runtimePollFailed;

  /* Shared mutation state: the drawer is the only place candidates mutate. */
  const [detailCandidate, setDetailCandidate] = useState<NfObservation | null>(null);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  /* One token revalidates every mounted view after a governed mutation. */
  const [reloadToken, setReloadToken] = useState(0);
  const bumpReload = useCallback(() => setReloadToken((token) => token + 1), []);

  const handleLink = async (resourceId: string) => {
    if (!detailCandidate) return;
    setBusyCandidateId(detailCandidate.candidateId);
    setLinkError(null);
    setFeedback(null);
    try {
      const payload = buildLinkCandidateRequest(detailCandidate, resourceId);
      const updated = await linkDiscoveryCandidate(detailCandidate.candidateId, payload);
      setDetailCandidate(updated);
      setFeedback({ tone: 'success', message: t('discovery_feedback_linked') });
      bumpReload();
    } catch (err) {
      setLinkError(describeMutationError(err, t));
    } finally {
      setBusyCandidateId(null);
    }
  };

  const handleUnlink = async () => {
    if (!detailCandidate) return;
    setBusyCandidateId(detailCandidate.candidateId);
    setLinkError(null);
    setFeedback(null);
    try {
      const payload = buildUnlinkCandidateRequest(detailCandidate);
      const updated = await unlinkDiscoveryCandidate(detailCandidate.candidateId, payload);
      setDetailCandidate(updated);
      setFeedback({ tone: 'success', message: t('discovery_feedback_unlinked') });
      bumpReload();
    } catch (err) {
      setLinkError(describeMutationError(err, t));
    } finally {
      setBusyCandidateId(null);
    }
  };

  const [scanningSourceId, setScanningSourceId] = useState<string | null>(null);
  const handleScan = async (source: DiscoverySource) => {
    setScanningSourceId(source.sourceId);
    setFeedback(null);
    try {
      const result = await scanDiscoverySource(source.sourceId);
      const run = result.run;
      if (run.status === 'success') {
        setFeedback({ tone: 'success', message: t('discovery_feedback_scan_ok', { count: run.discoveredCount }) });
      } else if (run.status === 'partial') {
        setFeedback({ tone: 'warning', message: t('discovery_feedback_scan_partial') });
      } else {
        setFeedback({
          tone: 'danger',
          message: run.errorSummary || t('discovery_feedback_scan_failed'),
        });
      }
      bumpReload();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setScanningSourceId(null);
    }
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formAdapter, setFormAdapter] = useState<DiscoveryAdapterType>('nrf');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formTransport, setFormTransport] = useState<DiscoveryTransportMode>('h2c');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formScanInterval, setFormScanInterval] = useState(DEFAULT_SCAN_INTERVAL_SECONDS);

  const openCreateDialog = () => {
    setFormError(null);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const payload = buildCreateSourceRequest({
        name: formName,
        adapterType: formAdapter,
        baseUrl: formBaseUrl,
        transportMode: formTransport,
        enabled: formEnabled,
        scanIntervalSeconds: formScanInterval,
      });
      await createDiscoverySource(payload);
      setCreateOpen(false);
      setFormName('');
      setFormBaseUrl('');
      setFormEnabled(true);
      setFormScanInterval(DEFAULT_SCAN_INTERVAL_SECONDS);
      setFeedback({ tone: 'success', message: t('discovery_feedback_created') });
      bumpReload();
    } catch (err) {
      setFormError(describeMutationError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  /* Governed runtime onboarding: the drawer collects an explicit component
   * selection and this dialog is the only write path (preview -> apply). */
  const [bootstrapComponentIds, setBootstrapComponentIds] = useState<string[] | null>(null);

  // KPIs come from the full-collection summary section, never from the current
  // page arrays. A page-scoped count must never be presented as a platform
  // total (full-collection scope/completeness contract).
  const kpis = useMemo(() => discoveryKpisFromSummary(summary ?? undefined), [summary]);

  const viewOptions = useMemo<ViewSwitchOption<DiscoveryView>[]>(
    () => DISCOVERY_VIEWS.map((value) => ({
      value,
      label: t(DISCOVERY_VIEW_LABEL[value]),
      data: { 'data-discovery-view': value },
    })),
    [t],
  );

  const kpiItems = useMemo<MetricStripItem[]>(() => [
    {
      key: 'sources',
      label: t('discovery_kpi_sources'),
      value: kpis.sources ?? '-',
      detail: scopeKpiDetail(kpis.sources, t),
      tone: kpis.sources === null ? 'muted' : 'primary',
    },
    {
      key: 'seen',
      label: t('discovery_kpi_seen'),
      value: kpis.seen ?? '-',
      detail: scopeKpiDetail(kpis.seen, t),
      tone: kpis.seen === null ? 'muted' : 'primary',
    },
    {
      key: 'missing',
      label: t('discovery_kpi_missing'),
      value: kpis.missing ?? '-',
      detail: scopeKpiDetail(kpis.missing, t),
      tone: kpis.missing === null ? 'muted' : 'primary',
    },
    {
      key: 'linked',
      label: t('discovery_kpi_linked'),
      value: kpis.linked ?? '-',
      detail: scopeKpiDetail(kpis.linked, t),
      tone: kpis.linked === null ? 'muted' : 'primary',
    },
  ], [kpis, t]);

  const candidatesFilters = useMemo(
    () => ({ sourceId: sourceIdFilter, state: observationFilter, nfType: nfTypeFilter }),
    [sourceIdFilter, observationFilter, nfTypeFilter],
  );

  return (
    <OperationsPageFrame
      title={t('discovery_title')}
      description={t('discovery_description')}
      icon={<Radar size={23} />}
      viewSwitch={(
        <ViewSwitch
          options={viewOptions}
          value={discoveryView}
          onChange={(value) => url.setView(value)}
          ariaLabel={t('discovery_view_label')}
        />
      )}
      onRefresh={async () => {
        // Mounted views register their own loaders with the frame. Keep the
        // page loader to page-owned context so one click issues one request per
        // data section instead of re-triggering view effects through the token.
        await Promise.allSettled([loadSummary(), loadRuntime()]);
      }}
      actions={
        discoveryView === 'sources' && canConfigure ? (
          <button type="button" className="btn btn-primary" onClick={openCreateDialog}>
            <Plus size={16} />
            {t('discovery_create_source')}
          </button>
        ) : undefined
      }
    >
      {feedback ? (
        <OperationFeedback
          tone={feedback.tone}
          title={t('discovery_operation_result')}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}

      {summaryLoading && kpis.sources === null ? (
        <SkeletonKpiStrip count={4} />
      ) : (
        <MetricStrip
          variant="cards"
          columns={4}
          ariaLabel={t('discovery_kpi_label')}
          items={kpiItems}
        />
      )}

      {readDenied ? (
        <p className={styles.forbiddenNote} role="alert">
          {t('discovery_err_forbidden')}
        </p>
      ) : null}

      {discoveryView === 'candidates' ? (
        <DiscoveryCandidatesView
          filters={candidatesFilters}
          onFilterChange={(key, value) => url.setFilter(key, value)}
          onClearFilters={() => url.setFilters({ sourceId: null, state: null, nfType: null })}
          hasFilters={Boolean(sourceIdFilter || observationFilter || nfTypeFilter)}
          cursor={url.cursor}
          onCursorChange={url.setCursor}
          onOpenCandidate={(candidate) => {
            setLinkError(null);
            setDetailCandidate(candidate);
          }}
          reloadToken={reloadToken}
        />
      ) : discoveryView === 'sources' ? (
        <DiscoverySourcesView
          query={sourceQuery}
          onQuerySubmit={(value) => url.setFilter('q', value)}
          cursor={url.cursor}
          onCursorChange={url.setCursor}
          canConfigure={canConfigure}
          onCreateSource={openCreateDialog}
          onScan={(source) => void handleScan(source)}
          scanningSourceId={scanningSourceId}
          reloadToken={reloadToken}
        />
      ) : (
        <DiscoveryRunsView
          sourceId={sourceIdFilter}
          onSourceIdChange={(value) => url.setFilter('sourceId', value)}
          status={runStatusFilter}
          onStatusChange={(value) => url.setFilter('runStatus', value)}
          onClearFilters={() => url.setFilters({ sourceId: null, runStatus: null })}
          hasFilters={Boolean(sourceIdFilter || runStatusFilter)}
          cursor={url.cursor}
          onCursorChange={url.setCursor}
          reloadToken={reloadToken}
        />
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="discovery-create-title"
      >
        <div className={styles.modalHeader}>
          <h2 id="discovery-create-title">{t('discovery_create_source')}</h2>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.modalIntro}>{t('discovery_create_intro')}</p>
          <Field htmlFor="discovery-name" label={t('discovery_field_name')}>
            <input
              id="discovery-name"
              className="form-input"
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              disabled={submitting}
            />
          </Field>
          <Field htmlFor="discovery-adapter" label={t('discovery_field_adapter')}>
            <select
              id="discovery-adapter"
              className="form-input"
              value={formAdapter}
              onChange={(event) => setFormAdapter(event.target.value as DiscoveryAdapterType)}
              disabled={submitting}
            >
              {CANONICAL_ADAPTER_TYPES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field htmlFor="discovery-base-url" label={t('discovery_field_base_url')} description={t('discovery_field_base_url_hint')}>
            <input
              id="discovery-base-url"
              className="form-input"
              value={formBaseUrl}
              onChange={(event) => setFormBaseUrl(event.target.value)}
              disabled={submitting}
              placeholder="http://127.0.0.10:7777"
            />
          </Field>
          <Field htmlFor="discovery-transport" label={t('discovery_field_transport')}>
            <select
              id="discovery-transport"
              className="form-input"
              value={formTransport}
              onChange={(event) => setFormTransport(event.target.value as DiscoveryTransportMode)}
              disabled={submitting}
            >
              {CANONICAL_TRANSPORT_MODES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field htmlFor="discovery-enabled" label={t('discovery_field_enabled')}>
            <input
              id="discovery-enabled"
              type="checkbox"
              checked={formEnabled}
              onChange={(event) => setFormEnabled(event.target.checked)}
              disabled={submitting}
            />
          </Field>
          <Field
            htmlFor="discovery-interval"
            label={t('discovery_field_interval')}
            description={t('discovery_field_interval_hint')}
          >
            <input
              id="discovery-interval"
              className="form-input"
              type="number"
              min={0}
              max={MAX_SCAN_INTERVAL_SECONDS}
              step={1}
              value={formScanInterval}
              onChange={(event) => setFormScanInterval(Number(event.target.value))}
              disabled={submitting}
            />
          </Field>
          {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
          <div className={styles.formActions}>
            <button type="button" className="btn btn-secondary" onClick={() => setCreateOpen(false)} disabled={submitting}>
              {t('cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleCreate()} disabled={submitting}>
              {submitting ? t('discovery_submitting') : t('discovery_create_confirm')}
            </button>
          </div>
        </div>
      </Dialog>

      {detailCandidate ? (
        <CandidateDetailDrawer
          key={detailCandidate.candidateId}
          candidate={detailCandidate}
          runtimeComponents={effectiveRuntimeComponents}
          runtimeUnavailable={runtimeUnavailable}
          canConfigure={canConfigure}
          busy={busyCandidateId !== null}
          linkError={linkError}
          onClose={() => setDetailCandidate(null)}
          onLink={(resourceId) => void handleLink(resourceId)}
          onUnlink={() => void handleUnlink()}
          onBootstrap={(componentIds) => setBootstrapComponentIds(componentIds)}
        />
      ) : null}

      {bootstrapComponentIds ? (
        <RuntimeBootstrapDialog
          template="auto"
          componentIds={bootstrapComponentIds}
          onClose={() => setBootstrapComponentIds(null)}
          onApplied={() => {
            setFeedback({ tone: 'success', message: t('discovery_bootstrap_applied') });
            // Refresh the queue so newly onboarded resources can be linked.
            bumpReload();
          }}
        />
      ) : null}
    </OperationsPageFrame>
  );
}

export default DiscoveryPage;
