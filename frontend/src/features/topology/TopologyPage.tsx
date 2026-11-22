/*
 * Topology workspace (/topology).
 *
 * The operator-facing workspace for the three topology questions:
 *
 *   graph         the environment topology (evidence layer: declared / runtime)
 *   ledger        the declared-relationship ledger
 *   architecture  the static 3GPP reference skeleton projected onto live
 *                 Inventory / Health / Topology / runtime authorities
 *
 * This module is the single orchestration owner of the route:
 *
 *   - the three-mode navigation contract and the graph evidence source, through
 *     `useTopologyViewState` and `useOperationsUrlState`;
 *   - the ledger query's URL state (lifecycle, relationship, endpoints, cursor);
 *   - the Inventory endpoint directory that names ledger endpoints;
 *   - the composition of the ledger toolbar, body and governed workflows.
 *
 * The ledger read lifecycle lives in `useTopologyLedger`, the mutation workflows
 * in `useTopologyEdgeWorkflows`, and the presentation in
 * `TopologyLedgerToolbar` / `TopologyLedgerPanel`. The three graph engines remain
 * their own modules and are not re-implemented here.
 *
 * Evidence boundaries this route must keep visible: a declared relationship is an
 * operator decision, runtime configuration is observed configuration evidence, and
 * the reference architecture is an illustration - never a measurement.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GitBranch, Plus } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { currentListLocation, withReturnTo } from '../../lib/return-to';
import { ViewSwitch, type ViewSwitchOption } from '../../components/ui/ViewSwitch';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import {
  createTopologyEdge,
  fetchTopologyMeta,
  retireTopologyEdge,
  updateTopologyEdge,
} from './topology-api';
import type { TopologyEdge, TopologyMetaResponse } from './topology-types';
import { RELATIONSHIP_PRESENTATION } from './topology-types';
import { useResourceDirectory } from './use-resource-directory';
import { useTopologyLedger, type TopologyLedgerQuery } from './use-topology-ledger';
import {
  useTopologyEdgeWorkflows,
  type TopologyEdgeExecutors,
} from './use-topology-edge-workflows';
import { TopologyLedgerToolbar, type TopologyActiveFilter } from './components/TopologyLedgerToolbar';
import { TopologyLedgerPanel } from './components/TopologyLedgerPanel';
import { TopologyEdgeWorkflowDialogs } from './components/TopologyEdgeWorkflowDialogs';
import styles from '../../styles/modules/topology.module.css';
import { RuntimeHierarchy } from '../runtime/RuntimeHierarchy';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import { ArchitectureView } from './ArchitectureView';
import { ActualTopologyView } from './ActualTopologyView';
import { LiveTopologyView } from './LiveTopologyView';
import {
  TOPOLOGY_GRAPH_SOURCES,
  TOPOLOGY_PAGE_URL_KEYS,
  TOPOLOGY_PRIMARY_VIEWS,
  TOPOLOGY_RUNTIME_SCOPES,
  useTopologyViewState,
  type TopologyGraphSource,
  type TopologyPrimaryView,
  type TopologyRuntimeScope,
} from './topology-view-state';

/* Three exclusive modes share one canonical `/topology` route. The graph keeps
 * the legacy `actual` URL alias; the ledger adds `ledger`; the static 3GPP
 * skeleton projected onto live authorities is its own `architecture` mode. */
const PRIMARY_LABEL_KEY: Record<TopologyPrimaryView, string> = {
  graph: 'topology_primary_graph',
  ledger: 'topology_primary_ledger',
  architecture: 'topology_primary_architecture',
};

const SOURCE_LABEL_KEY: Record<TopologyGraphSource, string> = {
  declared: 'topology_source_declared',
  runtime: 'topology_source_runtime',
};

const SOURCE_EVIDENCE_KEY: Record<TopologyGraphSource, string> = {
  declared: 'topology_source_evidence_declared',
  runtime: 'topology_source_evidence_runtime',
};

const SOURCE_NOTE_KEY: Record<TopologyGraphSource, string> = {
  declared: 'topology_source_note_declared',
  runtime: 'topology_source_note_runtime',
};

const RUNTIME_SCOPE_LABEL_KEY: Record<TopologyRuntimeScope, string> = {
  config: 'topology_runtime_scope_config',
  hierarchy: 'topology_runtime_scope_hierarchy',
};

export function TopologyPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const listLocation = currentListLocation('/topology', location.search);

  const [meta, setMeta] = useState<TopologyMetaResponse | null>(null);

  const topology = useTopologyViewState(['state', 'relationship', 'from', 'to']);
  const primary = topology.primary;
  const source = topology.source;
  const runtimeScope = topology.runtimeScope;

  /* The shared key list also covers the live canvas' `q`/`domain`/`focus`/`edge`,
   * so the page normalizer cannot erase a selection it did not write.
   * `clearKeys` keeps the ledger's "clear filters" action scoped to its own
   * parameters. */
  const url = useOperationsUrlState({
    keys: TOPOLOGY_PAGE_URL_KEYS,
    clearKeys: ['state', 'relationship', 'from', 'to'],
  });

  /* `active` stays the effective default without being written into the URL, so
   * an untouched page keeps a clean, shareable address. */
  const ledgerQuery = useMemo<TopologyLedgerQuery>(() => ({
    lifecycleState: url.filters.state || 'active',
    relationshipType: url.filters.relationship || '',
    fromResourceId: url.filters.from || '',
    toResourceId: url.filters.to || '',
  }), [url.filters.state, url.filters.relationship, url.filters.from, url.filters.to]);

  const ledger = useTopologyLedger({
    enabled: primary === 'ledger',
    query: ledgerQuery,
    cursor: url.cursor,
    onCursorChange: url.setCursor,
  });

  const canConfigure = hasPermission(user, 'core.configure');

  useEffect(() => {
    fetchTopologyMeta()
      .then(setMeta)
      .catch(() => {
        /* The relationship vocabulary falls back to the raw identifiers. */
      });
  }, []);

  const endpointIds = useMemo(
    () => [
      ...ledger.edges.flatMap((edge) => [edge.fromResourceId, edge.toResourceId]),
      ledgerQuery.fromResourceId,
      ledgerQuery.toResourceId,
    ].filter(Boolean),
    [ledger.edges, ledgerQuery.fromResourceId, ledgerQuery.toResourceId],
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

  const activeFilters = useMemo<TopologyActiveFilter[]>(() => {
    const chips: TopologyActiveFilter[] = [];
    if (ledgerQuery.fromResourceId) {
      chips.push({
        key: 'from',
        label: `${t('topology_from_resource')}: ${endpointLabel(ledgerQuery.fromResourceId)}`,
        clear: () => url.setFilter('from', ''),
      });
    }
    if (ledgerQuery.toResourceId) {
      chips.push({
        key: 'to',
        label: `${t('topology_to_resource')}: ${endpointLabel(ledgerQuery.toResourceId)}`,
        clear: () => url.setFilter('to', ''),
      });
    }
    if (ledgerQuery.relationshipType) {
      chips.push({
        key: 'rel',
        label: `${t('topology_relationship')}: ${relationshipLabel(ledgerQuery.relationshipType)}`,
        clear: () => url.setFilter('relationship', ''),
      });
    }
    return chips;
  }, [ledgerQuery, relationshipLabel, endpointLabel, t, url]);

  const clearFilters = () => {
    url.clearFilters();
    ledger.resetCursorHistory();
  };

  /* The governed request boundary stays named here; the workflow owner receives
   * it so the page remains the one module that wires the three operations. */
  const executors = useMemo<TopologyEdgeExecutors>(() => ({
    create: createTopologyEdge,
    update: updateTopologyEdge,
    retire: retireTopologyEdge,
  }), []);

  const handleCreated = useCallback(
    (edge: TopologyEdge) => {
      navigate(withReturnTo(`/topology/${encodeURIComponent(edge.fromResourceId)}`, listLocation));
    },
    [navigate, listLocation],
  );

  const workflows = useTopologyEdgeWorkflows({
    executors,
    reload: ledger.reload,
    cursor: url.cursor,
    onCreated: handleCreated,
  });

  const handleViewResource = useCallback(
    (resourceId: string) => navigate(withReturnTo(`/topology/${encodeURIComponent(resourceId)}`, listLocation)),
    [navigate, listLocation],
  );

  const handleActivateRow = useCallback(
    (edgeId: string) => {
      const edge = ledger.edges.find((item) => item.edgeId === edgeId);
      if (edge) handleViewResource(edge.fromResourceId);
    },
    [ledger.edges, handleViewResource],
  );

  const hasFilters = Boolean(
    ledgerQuery.fromResourceId || ledgerQuery.toResourceId || ledgerQuery.relationshipType,
  );

  return (
    <OperationsPageFrame
      title={t('topology_title')}
      description={t('topology_description')}
      icon={<GitBranch size={23} />}
      workspaceMode="canvas"
      viewSwitch={(
        <ViewSwitch
          options={TOPOLOGY_PRIMARY_VIEWS.map((view): ViewSwitchOption<TopologyPrimaryView> => ({
            value: view,
            label: t(PRIMARY_LABEL_KEY[view]),
            data: { 'data-topology-view': view },
          }))}
          value={primary}
          onChange={topology.setPrimaryView}
          ariaLabel={t('topology_primary_view_label')}
        />
      )}
      onRefresh={primary === 'ledger' ? () => void ledger.reload(url.cursor) : undefined}
      actions={
        primary === 'ledger' && canConfigure ? (
          <button type="button" className="btn btn-primary" onClick={workflows.beginCreate}>
            <Plus size={16} />
            {t('topology_create_relationship')}
          </button>
        ) : undefined
      }
    >
      {primary === 'graph' ? (
        <>
          <section
            className={styles.graphBar}
            aria-label={t('topology_source_label')}
            data-topology-source-bar={source}
          >
            <ViewSwitch
              options={TOPOLOGY_GRAPH_SOURCES.map((value): ViewSwitchOption<TopologyGraphSource> => ({
                value,
                label: t(SOURCE_LABEL_KEY[value]),
                data: { 'data-topology-source': value },
              }))}
              value={source}
              onChange={topology.setSource}
              ariaLabel={t('topology_source_label')}
            />
            {source === 'runtime' ? (
              <ViewSwitch
                options={TOPOLOGY_RUNTIME_SCOPES.map((value): ViewSwitchOption<TopologyRuntimeScope> => ({
                  value,
                  label: t(RUNTIME_SCOPE_LABEL_KEY[value]),
                  data: { 'data-runtime-scope': value },
                }))}
                value={runtimeScope}
                onChange={topology.setRuntimeScope}
                ariaLabel={t('topology_runtime_scope_label')}
              />
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
              <LiveTopologyView
                onRegisterRelationship={canConfigure ? workflows.registerFromEvidence : undefined}
              />
            )
          ) : null}
        </>
      ) : null}

      {primary === 'architecture' ? <ArchitectureView /> : null}

      {primary === 'ledger' ? (
        <>
          <TopologyEdgeWorkflowDialogs workflows={workflows} meta={meta} />

          <section className="dash-card">
            <TopologyLedgerToolbar
              meta={meta}
              relationshipType={ledgerQuery.relationshipType}
              lifecycleState={ledgerQuery.lifecycleState}
              fromResourceId={ledgerQuery.fromResourceId}
              toResourceId={ledgerQuery.toResourceId}
              readAt={ledger.readAt}
              loading={ledger.loading}
              activeFilters={activeFilters}
              onRelationshipChange={(value) => url.setFilter('relationship', value)}
              onLifecycleChange={(value) => url.setFilter('state', value)}
              onFromChange={(resourceId) => url.setFilter('from', resourceId)}
              onToChange={(resourceId) => url.setFilter('to', resourceId)}
              onClearFilters={clearFilters}
            />

            <TopologyLedgerPanel
              edges={ledger.edges}
              directory={directory}
              loading={ledger.loading}
              error={ledger.error}
              canPageForward={ledger.canPageForward}
              pageIndex={ledger.pageIndex}
              canConfigure={canConfigure}
              hasFilters={hasFilters}
              caption={t('topology_table_caption')}
              onRetry={() => void ledger.reload(url.cursor)}
              onNextPage={ledger.nextPage}
              onPrevPage={ledger.prevPage}
              onCreate={workflows.beginCreate}
              onActivateRow={handleActivateRow}
              onEdit={workflows.beginEdit}
              onRetire={workflows.beginRetire}
              onViewResource={handleViewResource}
            />
          </section>
        </>
      ) : null}
    </OperationsPageFrame>
  );
}

export default TopologyPage;
