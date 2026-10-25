/*
 * Topology relationship explorer (/topology).
 *
 * The operator-facing relationship management workspace. It renders inside the
 * shared operations page frame (one title, one refresh entry), uses the shared
 * dialog / state primitives, and reads only from the seven Topology APIs plus the
 * Inventory read authority for resource selection. No totals or KPI values are
 * fabricated: the panel reports exactly what the server returned.
 *
 * UX-1: `state`, `relationship`, `from`, `to` and `cursor` live in the URL, so a
 * filtered relationship ledger survives reload, back/forward and a copied link.
 * A filter change drops the cursor through the shared URL contract, which means
 * page N of a discarded filter set can never be requested.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, Plus, Search, X } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { MutationApiError } from '../../lib/api/mutation-client';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import {
  createTopologyEdge,
  fetchTopologyEdges,
  fetchTopologyMeta,
  retireTopologyEdge,
  updateTopologyEdge,
} from './topology-api';
import type {
  CreateEdgeRequest,
  TopologyEdge,
  TopologyMetaResponse,
  UpdateEdgeRequest,
} from './topology-types';
import { RELATIONSHIP_PRESENTATION } from './topology-types';
import { useResourceDirectory } from './use-resource-directory';
import { TopologyEdgeTable } from './components/TopologyEdgeTable';
import { TopologyEdgeForm } from './components/TopologyEdgeForm';
import { TopologyResourcePicker } from './components/TopologyResourcePicker';
import styles from '../../styles/modules/topology.module.css';
import { RuntimeHierarchy } from '../runtime/RuntimeHierarchy';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import { ArchitectureView } from './ArchitectureView';
import { ActualTopologyView } from './ActualTopologyView';
import { LiveTopologyView } from './LiveTopologyView';
import {
  TOPOLOGY_GRAPH_SOURCES,
  TOPOLOGY_PRIMARY_VIEWS,
  TOPOLOGY_RUNTIME_SCOPES,
  useTopologyViewState,
  type TopologyGraphSource,
  type TopologyPrimaryView,
  type TopologyRuntimeScope,
} from './topology-view-state';

const PAGE_LIMIT = 20;

/* Two primary views share one canonical `/topology` route. The graph keeps the
 * legacy `actual` URL value; the ledger adds `ledger`. */
const PRIMARY_LABEL_KEY: Record<TopologyPrimaryView, string> = {
  actual: 'topology_primary_graph',
  ledger: 'topology_primary_ledger',
};

const SOURCE_LABEL_KEY: Record<TopologyGraphSource, string> = {
  declared: 'topology_source_declared',
  runtime: 'topology_source_runtime',
  reference: 'topology_source_reference',
};

const SOURCE_EVIDENCE_KEY: Record<TopologyGraphSource, string> = {
  declared: 'topology_source_evidence_declared',
  runtime: 'topology_source_evidence_runtime',
  reference: 'topology_source_evidence_reference',
};

const SOURCE_NOTE_KEY: Record<TopologyGraphSource, string> = {
  declared: 'topology_source_note_declared',
  runtime: 'topology_source_note_runtime',
  reference: 'topology_source_note_reference',
};

const RUNTIME_SCOPE_LABEL_KEY: Record<TopologyRuntimeScope, string> = {
  config: 'topology_runtime_scope_config',
  hierarchy: 'topology_runtime_scope_hierarchy',
};

export function TopologyPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [meta, setMeta] = useState<TopologyMetaResponse | null>(null);
  const [edges, setEdges] = useState<TopologyEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const topology = useTopologyViewState(['state', 'relationship', 'from', 'to']);
  const primary = topology.primary;
  const source = topology.source;
  const runtimeScope = topology.runtimeScope;

  /* `source` and `scope` are registered here so the ledger filter normalization
   * never strips the graph's evidence context; `clearKeys` keeps the ledger's
   * "clear filters" action scoped to its own parameters. */
  const url = useOperationsUrlState({
    keys: ['state', 'relationship', 'from', 'to', 'source', 'scope'],
    clearKeys: ['state', 'relationship', 'from', 'to'],
  });

  /* `active` stays the effective default without being written into the URL, so
   * an untouched page keeps a clean, shareable address. */
  const lifecycleState = url.filters.state || 'active';
  const relationshipType = url.filters.relationship || '';
  const fromResourceId = url.filters.from || '';
  const toResourceId = url.filters.to || '';

  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const queryKeyRef = useRef('');

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TopologyEdge | null>(null);
  const [retireTarget, setRetireTarget] = useState<TopologyEdge | null>(null);
  const [retireReason, setRetireReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const canConfigure = hasPermission(user, 'core.configure');

  useEffect(() => {
    fetchTopologyMeta()
      .then(setMeta)
      .catch(() => {
        /* The relationship vocabulary falls back to the raw identifiers. */
      });
  }, []);

  const loadEdges = useCallback(
    async (activeCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchTopologyEdges({
          fromResourceId: fromResourceId || undefined,
          toResourceId: toResourceId || undefined,
          relationshipType: relationshipType || undefined,
          lifecycleState: lifecycleState || undefined,
          cursor: activeCursor,
          limit: PAGE_LIMIT,
        });
        setEdges(res.edges || []);
        setNextCursor(res.page?.nextCursor ?? null);
        setHasMore(Boolean(res.page?.hasMore));
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : t('topology_err_load'));
        setEdges([]);
      } finally {
        setLoading(false);
      }
    },
    [fromResourceId, toResourceId, relationshipType, lifecycleState, t],
  );

  /* The relationship ledger is only read on its own view: the graph sources
   * must not pay for a query they do not show. */
  useEffect(() => {
    if (primary !== 'ledger') return;
    const queryKey = `${lifecycleState}|${relationshipType}|${fromResourceId}|${toResourceId}`;
    if (queryKeyRef.current !== queryKey) {
      queryKeyRef.current = queryKey;
      setCursorHistory([]);
    }
    void loadEdges(url.cursor);
  }, [primary, loadEdges, url.cursor, lifecycleState, relationshipType, fromResourceId, toResourceId]);

  const endpointIds = useMemo(
    () => [
      ...edges.flatMap((edge) => [edge.fromResourceId, edge.toResourceId]),
      fromResourceId,
      toResourceId,
    ].filter(Boolean),
    [edges, fromResourceId, toResourceId],
  );
  const directory = useResourceDirectory(endpointIds);

  /* Filter endpoints are resolved through the Inventory directory. An
   * unresolved endpoint shows its identifier rather than a guessed name. */
  const endpointLabel = useCallback(
    (resourceId: string) => {
      const resolved = directory[resourceId];
      return resolved?.displayName || resolved?.name || resourceId;
    },
    [directory],
  );

  const relationshipLabel = useCallback(
    (value: string) => {
      const presentation = RELATIONSHIP_PRESENTATION[value];
      return presentation ? t(presentation.labelKey) : value;
    },
    [t],
  );

  const clearFilters = () => {
    url.clearFilters();
    setCursorHistory([]);
  };

  const activeFilters = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];
    if (fromResourceId) {
      chips.push({
        key: 'from',
        label: `${t('topology_from_resource')}: ${endpointLabel(fromResourceId)}`,
        clear: () => url.setFilter('from', ''),
      });
    }
    if (toResourceId) {
      chips.push({
        key: 'to',
        label: `${t('topology_to_resource')}: ${endpointLabel(toResourceId)}`,
        clear: () => url.setFilter('to', ''),
      });
    }
    if (relationshipType) {
      chips.push({
        key: 'rel',
        label: `${t('topology_relationship')}: ${relationshipLabel(relationshipType)}`,
        clear: () => url.setFilter('relationship', ''),
      });
    }
    return chips;
  }, [fromResourceId, toResourceId, relationshipType, relationshipLabel, endpointLabel, t, url]);

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, url.cursor ?? '']);
    url.setCursor(nextCursor);
  };

  const handlePrevPage = () => {
    if (cursorHistory.length === 0) return;
    const history = [...cursorHistory];
    const previous = history.pop() ?? '';
    setCursorHistory(history);
    url.setCursor(previous || undefined);
  };

  const handleCreate = async (req: CreateEdgeRequest) => {
    setSubmitting(true);
    setFormError(null);
    setConflictNotice(null);
    try {
      const created = await createTopologyEdge(req);
      setCreateOpen(false);
      await loadEdges(url.cursor);
      navigate(`/topology/${encodeURIComponent(created.fromResourceId)}`);
    } catch (err) {
      setFormError(describeMutationError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (req: UpdateEdgeRequest) => {
    if (!editTarget) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await updateTopologyEdge(editTarget.edgeId, req);
      setEditTarget(null);
      await loadEdges(url.cursor);
    } catch (err) {
      if (err instanceof MutationApiError && err.status === 409) {
        setFormError(t('topology_stale_revision_body'));
        setConflictNotice(t('topology_stale_revision_body'));
      } else {
        setFormError(describeMutationError(err, t));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetire = async () => {
    if (!retireTarget) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await retireTopologyEdge(retireTarget.edgeId, {
        expectedRevision: retireTarget.revision,
        reason: retireReason,
      });
      setRetireTarget(null);
      setRetireReason('');
      await loadEdges(url.cursor);
    } catch (err) {
      if (err instanceof MutationApiError && err.status === 409) {
        setFormError(t('topology_stale_revision_body'));
      } else {
        setFormError(describeMutationError(err, t));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const hasFilters = Boolean(fromResourceId || toResourceId || relationshipType);
  const pageIndex = cursorHistory.length + 1;

  return (
    <OperationsPageFrame
      title={t('topology_title')}
      description={t('topology_description')}
      icon={<GitBranch size={23} />}
      workspaceMode="canvas"
      viewSwitch={(
        <div className={styles.viewToggle} role="group" aria-label={t('topology_primary_view_label')}>
          {TOPOLOGY_PRIMARY_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              data-topology-view={view}
              className={primary === view ? styles.viewToggleActive : undefined}
              aria-pressed={primary === view}
              onClick={() => topology.setPrimaryView(view)}
            >
              {t(PRIMARY_LABEL_KEY[view])}
            </button>
          ))}
        </div>
      )}
      onRefresh={primary === 'ledger' ? () => loadEdges(url.cursor) : undefined}
      actions={
        canConfigure && primary === 'ledger' ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setFormError(null);
              setCreateOpen(true);
            }}
          >
            <Plus size={16} />
            {t('topology_create_relationship')}
          </button>
        ) : undefined
      }
    >
      {primary === 'actual' ? (
        <>
          <section
            className={styles.graphBar}
            aria-label={t('topology_source_label')}
            data-topology-source-bar={source}
          >
            <div className={styles.sourceToggle} role="group" aria-label={t('topology_source_label')}>
              {TOPOLOGY_GRAPH_SOURCES.map((value) => (
                <button
                  key={value}
                  type="button"
                  data-topology-source={value}
                  className={source === value ? styles.viewToggleActive : undefined}
                  aria-pressed={source === value}
                  onClick={() => topology.setSource(value)}
                >
                  {t(SOURCE_LABEL_KEY[value])}
                </button>
              ))}
            </div>
            {source === 'runtime' ? (
              <div className={styles.sourceToggle} role="group" aria-label={t('topology_runtime_scope_label')}>
                {TOPOLOGY_RUNTIME_SCOPES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    data-runtime-scope={value}
                    className={runtimeScope === value ? styles.viewToggleActive : undefined}
                    aria-pressed={runtimeScope === value}
                    onClick={() => topology.setRuntimeScope(value)}
                  >
                    {t(RUNTIME_SCOPE_LABEL_KEY[value])}
                  </button>
                ))}
              </div>
            ) : null}
            <span className={styles.evidenceBadge} data-evidence-badge={source}>
              {t(SOURCE_EVIDENCE_KEY[source])}
            </span>
            <details className={styles.sourceNotes} data-source-notes={source}>
              <summary>{t('topology_source_notes')}</summary>
              <div className={styles.sourceNotesBody}>
                <p>{t(SOURCE_NOTE_KEY[source])}</p>
                <p>{t('topology_description')}</p>
              </div>
            </details>
          </section>

          {source === 'declared' ? (
            <ActualTopologyView onShowRuntime={() => topology.setSource('runtime')} />
          ) : null}

          {source === 'runtime' ? (
            runtimeScope === 'hierarchy' ? (
              <section
                className="dash-card"
                aria-label={t('topology_runtime_scope_hierarchy')}
                data-runtime-scope-view="hierarchy"
              >
                <p className={styles.viewNote}>{t('topology_runtime_note')}</p>
                <RuntimeHierarchy />
              </section>
            ) : (
              <LiveTopologyView />
            )
          ) : null}

          {source === 'reference' ? <ArchitectureView /> : null}
        </>
      ) : null}

      {primary === 'ledger' ? (
        <>
      {conflictNotice ? (
        <div className={styles.conflictBanner} role="alert">
          <span>{conflictNotice}</span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setConflictNotice(null);
              void loadEdges(url.cursor);
            }}
          >
            {t('topology_reload')}
          </button>
        </div>
      ) : null}

      <section className="dash-card">
        <div className={styles.toolbar}>
          <div className={styles.filterGroup}>
            <select
              className="form-input"
              aria-label={t('topology_relationship')}
              value={relationshipType}
              onChange={(event) => url.setFilter('relationship', event.target.value)}
            >
              <option value="">{t('topology_all_relationships')}</option>
              {(meta?.relationshipTypes ?? []).map((value) => (
                <option key={value} value={value}>
                  {relationshipLabel(value)}
                </option>
              ))}
            </select>
            <select
              className="form-input"
              aria-label={t('topology_lifecycle')}
              value={lifecycleState}
              onChange={(event) => url.setFilter('state', event.target.value === 'active' ? '' : event.target.value)}
            >
              {(meta?.lifecycleStates ?? ['active', 'retired']).map((value) => (
                <option key={value} value={value}>
                  {value === 'retired' ? t('topology_state_retired') : t('topology_state_active')}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost" onClick={clearFilters} disabled={loading}>
              <X size={14} aria-hidden="true" />
              {t('topology_clear_filters')}
            </button>
          </div>
        </div>

        <div className={styles.resourceFilters}>
          <TopologyResourcePicker
            id="topology-filter-from"
            label={t('topology_filter_from')}
            value={fromResourceId}
            onChange={(resource) => url.setFilter('from', resource?.resourceId ?? '')}
            excludeResourceId={toResourceId || undefined}
          />
          <TopologyResourcePicker
            id="topology-filter-to"
            label={t('topology_filter_to')}
            value={toResourceId}
            onChange={(resource) => url.setFilter('to', resource?.resourceId ?? '')}
            excludeResourceId={fromResourceId || undefined}
          />
        </div>

        {activeFilters.length > 0 ? (
          <div className={styles.filterTags}>
            <span className={styles.filterTagsLabel}>{t('topology_filter_active')}</span>
            {activeFilters.map((chip) => (
              <button key={chip.key} type="button" onClick={chip.clear}>
                {chip.label}
                <X size={12} aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}

        {error ? (
          <div className={styles.errorWrap}>
            <ErrorState
              title={t('error')}
              message={error}
              retryLabel={t('retry')}
              onRetry={() => void loadEdges(url.cursor)}
            />
          </div>
        ) : loading && edges.length === 0 ? (
          <LoadingRows columns={9} rows={5} />
        ) : edges.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Search size={44} />}
              title={hasFilters ? t('topology_empty_search_title') : t('topology_empty_title')}
              description={hasFilters ? t('topology_empty_search_body') : t('topology_empty_body')}
              action={
                canConfigure && !hasFilters ? (
                  <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                    <Plus size={16} />
                    {t('topology_create_relationship')}
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <TopologyEdgeTable
            edges={edges}
            directory={directory}
            caption={t('topology_table_caption')}
            canConfigure={canConfigure}
            onActivateRow={(edgeId) => {
              const edge = edges.find((item) => item.edgeId === edgeId);
              if (edge) navigate(`/topology/${encodeURIComponent(edge.fromResourceId)}`);
            }}
            onEdit={(edge) => {
              setFormError(null);
              setEditTarget(edge);
            }}
            onRetire={(edge) => {
              setFormError(null);
              setRetireReason('');
              setRetireTarget(edge);
            }}
            onViewResource={(resourceId) => navigate(`/topology/${encodeURIComponent(resourceId)}`)}
          />
        )}

        {!error && edges.length > 0 ? (
          <nav className={styles.pager} aria-label={t('topology_title')}>
            <div className={styles.pagerSummary} aria-live="polite">
              {t('topology_showing_edges', { count: edges.length })}
            </div>
            <div className={styles.pagerControls}>
              <button type="button" onClick={handlePrevPage} disabled={pageIndex === 1 || loading}>
                {t('topology_prev_page')}
              </button>
              <span className={styles.pageNumber}>{t('topology_page_indicator', { page: pageIndex })}</span>
              <button
                type="button"
                onClick={handleNextPage}
                disabled={!hasMore || !nextCursor || loading}
              >
                {t('next')}
              </button>
            </div>
          </nav>
        ) : null}
      </section>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="topology-create-title"
      >
        <div className={styles.modalHeader}>
          <h2 id="topology-create-title">{t('topology_create_relationship')}</h2>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.modalIntro}>{t('topology_create_intro')}</p>
          <TopologyEdgeForm
            mode="create"
            relationshipTypes={meta?.relationshipTypes ?? []}
            interfaceCatalog={meta?.interfaceCatalog ?? []}
            submitting={submitting}
            serverError={formError}
            onCancel={() => setCreateOpen(false)}
            onCreate={handleCreate}
          />
        </div>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="topology-edit-title"
      >
        <div className={styles.modalHeader}>
          <h2 id="topology-edit-title">{t('topology_edit_relationship')}</h2>
        </div>
        <div className={styles.modalBody}>
          {editTarget ? (
            <TopologyEdgeForm
              mode="edit"
              relationshipTypes={meta?.relationshipTypes ?? []}
              interfaceCatalog={meta?.interfaceCatalog ?? []}
              initialEdge={editTarget}
              submitting={submitting}
              serverError={formError}
              onCancel={() => setEditTarget(null)}
              onUpdate={handleUpdate}
            />
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={retireTarget !== null}
        onClose={() => setRetireTarget(null)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="topology-retire-title"
      >
        <div className={styles.modalHeader}>
          <h2 id="topology-retire-title">{t('topology_retire_title')}</h2>
        </div>
        <div className={styles.modalBody}>
          {retireTarget ? (
            <>
              <dl className={styles.identityReadonly}>
                <div>
                  <dt>{t('topology_from_resource')}</dt>
                  <dd><code className={styles.uuid}>{retireTarget.fromResourceId}</code></dd>
                </div>
                <div>
                  <dt>{t('topology_relationship')}</dt>
                  <dd>{relationshipLabel(retireTarget.relationshipType)}</dd>
                </div>
                <div>
                  <dt>{t('topology_to_resource')}</dt>
                  <dd><code className={styles.uuid}>{retireTarget.toResourceId}</code></dd>
                </div>
                <div>
                  <dt>{t('topology_revision')}</dt>
                  <dd>r{retireTarget.revision}</dd>
                </div>
              </dl>
              <p className={styles.retireWarning}>{t('topology_retire_warning')}</p>
              <Field htmlFor="topology-retire-reason" label={t('topology_retire_reason')}>
                <textarea
                  id="topology-retire-reason"
                  className="form-input"
                  rows={2}
                  value={retireReason}
                  onChange={(event) => setRetireReason(event.target.value)}
                  disabled={submitting}
                  aria-invalid={!retireReason.trim() && formError ? true : undefined}
                />
              </Field>
              {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
              <div className={styles.formActions}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRetireTarget(null)}
                  disabled={submitting}
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleRetire}
                  disabled={submitting || !retireReason.trim()}
                >
                  {submitting ? t('topology_submitting') : t('topology_retire_confirm')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </Dialog>
        </>
      ) : null}
    </OperationsPageFrame>
  );
}

function describeMutationError(err: unknown, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'TOPOLOGY_DUPLICATE_ACTIVE_EDGE':
        return t('topology_duplicate_edge');
      case 'TOPOLOGY_SELF_EDGE':
        return t('topology_self_edge');
      case 'TOPOLOGY_ENDPOINT_RETIRED':
        return t('topology_endpoint_retired');
      case 'TOPOLOGY_ENDPOINT_NOT_FOUND':
        return t('topology_endpoint_not_found');
      case 'TOPOLOGY_REVISION_CONFLICT':
        return t('topology_stale_revision_body');
      case 'TOPOLOGY_EDGE_RETIRED':
        return t('topology_edge_retired');
      default:
        break;
    }
    if (err.status === 403) return t('topology_permission_denied');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export default TopologyPage;
