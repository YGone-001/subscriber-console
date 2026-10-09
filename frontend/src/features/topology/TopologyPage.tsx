/*
 * Topology relationship explorer (/topology).
 *
 * The operator-facing relationship management workspace. It renders inside the
 * shared AppShell, uses the shared PageHeader / dialog / state primitives, and
 * reads only from the seven Topology APIs plus the Inventory read authority for
 * resource selection. No totals or KPI values are fabricated: the panel reports
 * exactly what the server returned.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, Plus, RefreshCw, Search, X } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { MutationApiError } from '../../lib/api/mutation-client';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { Dialog } from '../../components/ui/Dialog';
import PageHeader from '../../components/ui/PageHeader';
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
import type { Resource } from '../inventory/inventory-types';
import styles from '../../styles/modules/topology.module.css';

const PAGE_LIMIT = 20;

export function TopologyPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [meta, setMeta] = useState<TopologyMetaResponse | null>(null);
  const [edges, setEdges] = useState<TopologyEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fromFilter, setFromFilter] = useState<Resource | null>(null);
  const [toFilter, setToFilter] = useState<Resource | null>(null);
  const [relationshipType, setRelationshipType] = useState('');
  const [lifecycleState, setLifecycleState] = useState('active');

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

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
          fromResourceId: fromFilter?.resourceId,
          toResourceId: toFilter?.resourceId,
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
    [fromFilter, toFilter, relationshipType, lifecycleState, t],
  );

  useEffect(() => {
    setCursor(undefined);
    setCursorHistory([]);
    void loadEdges(undefined);
  }, [loadEdges]);

  const endpointIds = useMemo(
    () => edges.flatMap((edge) => [edge.fromResourceId, edge.toResourceId]),
    [edges],
  );
  const directory = useResourceDirectory(endpointIds);

  const relationshipLabel = useCallback(
    (value: string) => {
      const presentation = RELATIONSHIP_PRESENTATION[value];
      return presentation ? t(presentation.labelKey) : value;
    },
    [t],
  );

  const clearFilters = () => {
    setFromFilter(null);
    setToFilter(null);
    setRelationshipType('');
    setLifecycleState('active');
    setCursor(undefined);
    setCursorHistory([]);
  };

  const activeFilters = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];
    if (fromFilter) {
      chips.push({
        key: 'from',
        label: `${t('topology_from_resource')}: ${fromFilter.displayName || fromFilter.name}`,
        clear: () => setFromFilter(null),
      });
    }
    if (toFilter) {
      chips.push({
        key: 'to',
        label: `${t('topology_to_resource')}: ${toFilter.displayName || toFilter.name}`,
        clear: () => setToFilter(null),
      });
    }
    if (relationshipType) {
      chips.push({
        key: 'rel',
        label: `${t('topology_relationship')}: ${relationshipLabel(relationshipType)}`,
        clear: () => setRelationshipType(''),
      });
    }
    return chips;
  }, [fromFilter, toFilter, relationshipType, relationshipLabel, t]);

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, cursor ?? '']);
    setCursor(nextCursor);
    void loadEdges(nextCursor);
  };

  const handlePrevPage = () => {
    if (cursorHistory.length === 0) return;
    const history = [...cursorHistory];
    const previous = history.pop() ?? '';
    setCursorHistory(history);
    setCursor(previous || undefined);
    void loadEdges(previous || undefined);
  };

  const handleCreate = async (req: CreateEdgeRequest) => {
    setSubmitting(true);
    setFormError(null);
    setConflictNotice(null);
    try {
      const created = await createTopologyEdge(req);
      setCreateOpen(false);
      await loadEdges(cursor);
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
      await loadEdges(cursor);
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
      await loadEdges(cursor);
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

  const hasFilters = Boolean(fromFilter || toFilter || relationshipType);
  const pageIndex = cursorHistory.length + 1;

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('eyebrow_topology')}
        icon={<GitBranch size={23} />}
        title={t('topology_title')}
        description={t('topology_description')}
        actions={(
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => loadEdges(cursor)}
              disabled={loading}
            >
              <RefreshCw size={16} className={loading ? styles.spin : undefined} />
              {t('refresh')}
            </button>
            {canConfigure ? (
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
            ) : null}
          </>
        )}
      />

      {conflictNotice ? (
        <div className={styles.conflictBanner} role="alert">
          <span>{conflictNotice}</span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setConflictNotice(null);
              void loadEdges(cursor);
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
              onChange={(event) => setRelationshipType(event.target.value)}
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
              onChange={(event) => setLifecycleState(event.target.value)}
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
            value={fromFilter?.resourceId ?? ''}
            onChange={setFromFilter}
            excludeResourceId={toFilter?.resourceId}
          />
          <TopologyResourcePicker
            id="topology-filter-to"
            label={t('topology_filter_to')}
            value={toFilter?.resourceId ?? ''}
            onChange={setToFilter}
            excludeResourceId={fromFilter?.resourceId}
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
              onRetry={() => loadEdges(cursor)}
            />
          </div>
        ) : loading && edges.length === 0 ? (
          <LoadingRows columns={8} rows={5} />
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
            onSelectEdge={(edgeId) => {
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
        overlayClassName="modal-overlay"
        className="modal-content animate-fade-in"
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
        overlayClassName="modal-overlay"
        className="modal-content animate-fade-in"
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
        overlayClassName="modal-overlay"
        className="modal-content animate-fade-in"
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
    </div>
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
