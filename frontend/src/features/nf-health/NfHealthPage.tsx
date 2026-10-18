/*
 * NF Health monitoring dashboard.
 *
 * Surfaces configured monitoring targets with layered collection coverage.
 * Layer state is never collapsed into a single global health percentage, and
 * unsupported layers stay visibly distinct from measured healthy layers.
 * Registry observation, process state and metrics coverage remain separate.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  Boxes,
  Link2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  X,
} from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import PageHeader from '../../components/ui/PageHeader';
import { OperationsNav } from '../operations/OperationsNav';
import { SkeletonKpiStrip } from '../../components/ui/LoadingSkeleton';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { useRead } from '../../lib/api/use-read';
import { MutationApiError } from '../../lib/api/mutation-client';
import { fetchDiscoveryCandidates } from '../discovery/discovery-api';
import type { NfObservation } from '../discovery/discovery-types';
import type { RuntimeComponent, RuntimeObservations } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import {
  collectNfHealthTarget,
  fetchNfHealthMeta,
  fetchNfHealthTargets,
} from './nf-health-api';
import type {
  HealthTargetSummary,
  LayerState,
  NfHealthMeta,
} from './nf-health-types';
import { NfHealthTargetDialog } from './NfHealthTargetDialog';
import { NfHealthTargetDrawer } from './NfHealthTargetDrawer';
import styles from '../../styles/modules/nf-health.module.css';

const PAGE_LIMIT = 20;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

export function NfHealthPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();

  const canRead = hasPermission(user, 'core.read');
  const canConfigure = hasPermission(user, 'core.configure');

  const [meta, setMeta] = useState<NfHealthMeta | null>(null);
  const [targets, setTargets] = useState<HealthTargetSummary[]>([]);
  const [candidates, setCandidates] = useState<NfObservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [enabledFilter, setEnabledFilter] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<HealthTargetSummary | null>(null);

  const runtimeRead = useRead<RuntimeObservations>('/api/runtime/observations');
  const runtimeStream = useRuntimeStream();
  const runtimeData = resolveRuntimeObservations(runtimeStream, runtimeRead.data);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metaRes, targetsRes, candidatesRes] = await Promise.all([
        fetchNfHealthMeta().catch(() => null),
        fetchNfHealthTargets({
          q: searchQuery || undefined,
          enabled: enabledFilter || undefined,
          limit: PAGE_LIMIT,
        }),
        fetchDiscoveryCandidates({ limit: PAGE_LIMIT }).catch(() => ({ candidates: [] as NfObservation[], page: { limit: PAGE_LIMIT, nextCursor: null, hasMore: false } })),
      ]);
      setMeta(metaRes);
      setTargets(targetsRes.targets ?? []);
      setCandidates(candidatesRes.candidates ?? []);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('nf_health_err_load'));
      setTargets([]);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, enabledFilter, t]);

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setError(t('nf_health_err_forbidden'));
      return;
    }
    void loadAll();
  }, [canRead, loadAll]);

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = searchInput.trim();
    if (next === searchQuery) {
      void loadAll();
      return;
    }
    setSearchQuery(next);
  };

  const handleCollect = async (target: HealthTargetSummary) => {
    setCollectingId(target.targetId);
    setFeedback(null);
    try {
      const result = await collectNfHealthTarget(target.targetId);
      const run = result.run;
      if (run.status === 'success') {
        setFeedback({ tone: 'success', message: t('nf_health_feedback_collect_ok') });
      } else if (run.status === 'partial') {
        setFeedback({ tone: 'warning', message: t('nf_health_feedback_collect_partial') });
      } else {
        setFeedback({
          tone: 'danger',
          message: run.errorSummary || t('nf_health_feedback_collect_failed'),
        });
      }
      await loadAll();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setCollectingId(null);
    }
  };

  const candidateIndex = useMemo(() => {
    const map = new Map<string, NfObservation>();
    for (const candidate of candidates) {
      map.set(candidate.candidateId, candidate);
    }
    return map;
  }, [candidates]);

  // Runtime components supply process evidence (CPU sample deltas, RSS) for
  // bound targets. Unavailable measurements stay unavailable and are never
  // rendered as zeros.
  const runtimeByRole = useMemo(() => {
    const map = new Map<string, RuntimeComponent>();
    for (const component of runtimeData?.snapshot?.components ?? []) {
      if (component.role) map.set(component.role, component);
    }
    return map;
  }, [runtimeData]);

  const runtimeByNfType = useMemo(() => {
    const map = new Map<string, RuntimeComponent>();
    for (const component of runtimeData?.snapshot?.components ?? []) {
      if (component.nfType) map.set(component.nfType, component);
    }
    return map;
  }, [runtimeData]);

  const resolveRuntimeComponent = useCallback(
    (target: HealthTargetSummary, candidate?: NfObservation): RuntimeComponent | undefined => {
      const role = target.resourceId
        ? undefined
        : candidate?.nfType;
      if (role) {
        const byRole = runtimeByRole.get(role);
        if (byRole) return byRole;
      }
      const nfType = target.nfType ?? candidate?.nfType;
      return nfType ? runtimeByNfType.get(nfType) : undefined;
    },
    [runtimeByRole, runtimeByNfType],
  );

  const domainGroups = useMemo(() => {
    const groups = new Map<string, HealthTargetSummary[]>();
    for (const target of targets) {
      // Domain is a server-derived projection over the authoritative
      // Inventory identity. It is never inferred from candidate data here.
      const key = target.domain ?? 'unknown';
      const list = groups.get(key) ?? [];
      list.push(target);
      groups.set(key, list);
    }
    return Array.from(groups.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([domain, list]) => ({
        domain,
        label: domain === 'unknown' ? t('nf_health_domain_unknown') : domain.toUpperCase(),
        targets: list,
      }));
  }, [targets, t]);

  const kpis = useMemo(() => {
    let fresh = 0;
    let degraded = 0;
    let staleUnknown = 0;
    for (const target of targets) {
      // Freshness is server-derived so the overview agrees with the detail
      // projection: stale measurements never count as current evidence, and a
      // recent failed run remains visible as degraded.
      const freshness = target.freshness?.state;
      const isDegraded = Boolean(target.lastError);
      if (isDegraded) degraded += 1;
      else if (freshness === 'fresh') fresh += 1;
      else staleUnknown += 1;
    }
    return { configured: targets.length, fresh, degraded, staleUnknown };
  }, [targets]);

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('eyebrow_nf_health')}
        icon={<Activity size={23} />}
        title={t('nf_health_title')}
        description={t('nf_health_description')}
        actions={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => void loadAll()} disabled={loading}>
              <RefreshCw size={16} className={loading ? styles.spin : undefined} />
              {t('refresh')}
            </button>
            {canConfigure ? (
              <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
                <Plus size={16} />
                {t('nf_health_add_target')}
              </button>
            ) : null}
          </>
        )}
      />

      {feedback ? (
        <OperationFeedback
          tone={feedback.tone}
          title={t('nf_health_operation_result')}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}

      <OperationsNav />

      {loading && targets.length === 0 ? (
        <SkeletonKpiStrip count={4} />
      ) : (
        <section className={styles.kpiStrip} aria-label={t('nf_health_kpi_label')}>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_health_kpi_configured')}</span>
            <strong className={styles.kpiValue}>{kpis.configured}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_health_kpi_fresh')}</span>
            <strong className={styles.kpiValue}>{kpis.fresh}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_health_kpi_degraded')}</span>
            <strong className={styles.kpiValue}>{kpis.degraded}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_health_kpi_stale')}</span>
            <strong className={styles.kpiValue}>{kpis.staleUnknown}</strong>
          </article>
        </section>
      )}

      <section className="dash-card">
        <div className={styles.toolbar}>
          <form className={styles.search} onSubmit={handleSearchSubmit} role="search">
            <Search size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('nf_health_search_placeholder')}
              aria-label={t('nf_health_search_placeholder')}
            />
            <button type="submit" className="btn btn-secondary">
              {t('search')}
            </button>
          </form>
          <div className={styles.filterGroup}>
            <select
              className="form-input"
              aria-label={t('nf_health_filter_enabled')}
              value={enabledFilter}
              onChange={(event) => setEnabledFilter(event.target.value)}
            >
              <option value="">{t('nf_health_filter_all_states')}</option>
              <option value="true">{t('nf_health_enabled')}</option>
              <option value="false">{t('nf_health_disabled')}</option>
            </select>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSearchInput('');
                setSearchQuery('');
                setEnabledFilter('');
              }}
              disabled={loading}
            >
              <X size={14} aria-hidden="true" />
              {t('nf_health_clear_filters')}
            </button>
          </div>
        </div>

        <div className={styles.sectionHead}>
          <h2>
            <Server size={16} aria-hidden="true" />
            {t('nf_health_targets_section')}
          </h2>
          <span className={styles.sectionNote}>{t('nf_health_targets_note')}</span>
        </div>
        <p className={styles.semanticNote}>{t('nf_health_semantic_separation')}</p>

        {error ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={error} retryLabel={t('nf_health_retry')} onRetry={() => void loadAll()} />
          </div>
        ) : loading && targets.length === 0 ? (
          <LoadingRows columns={9} rows={4} />
        ) : targets.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Activity size={44} />}
              title={t('nf_health_empty_targets_title')}
              description={t('nf_health_empty_targets_body')}
              action={
                canConfigure ? (
                  <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
                    <Plus size={16} />
                    {t('nf_health_add_target')}
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('nf_health_targets_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('nf_health_col_name')}</th>
                  <th scope="col">{t('nf_health_col_nf_type')}</th>
                  <th scope="col">{t('nf_health_col_mode')}</th>
                  <th scope="col">{t('nf_health_col_l1')}</th>
                  <th scope="col">{t('nf_health_col_l2')}</th>
                  <th scope="col">{t('nf_health_col_l3')}</th>
                  <th scope="col">{t('nf_health_col_last_measured')}</th>
                  <th scope="col">{t('nf_health_evidence_freshness')}</th>
                  <th scope="col">{t('nf_health_col_collection_status')}</th>
                  <th scope="col">{t('nf_health_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((target) => {
                  const candidate = candidateIndex.get(target.candidateId ?? '');
                  const legacyIdentity =
                    !target.resourceId ||
                    target.identityState === 'legacy_unbound' ||
                    target.identityState === 'legacy_unresolved';
                  return (
                    <tr key={target.targetId}>
                      <td>
                        <Link
                          to={`/nf-health/${encodeURIComponent(target.targetId)}`}
                          className={styles.rowLink}
                        >
                          {target.name}
                        </Link>
                        <div className={styles.stack}>
                          <code className={styles.uuid}>{target.targetId}</code>
                        </div>
                      </td>
                      <td>
                        <div className={styles.stack}>
                          <strong>{target.nfType ?? candidate?.nfType ?? target.name}</strong>
                          {target.domain ? (
                            <span className={styles.chip}>{target.domain}</span>
                          ) : null}
                          {target.resourceId ? (
                            <Link
                              to={`/inventory/${encodeURIComponent(target.resourceId)}`}
                              className={styles.rowLink}
                              title={t('nf_health_link_resource')}
                            >
                              <Link2 size={12} aria-hidden="true" />
                              {t('nf_health_link_resource')}
                            </Link>
                          ) : null}
                          {candidate ? (
                            <Link to="/discovery" className={styles.rowLink} title={t('nf_health_link_candidate')}>
                              <Boxes size={12} aria-hidden="true" />
                              {t('nf_health_link_candidate')}
                            </Link>
                          ) : null}
                          {candidate?.linkedResourceId ? (
                            <Link
                              to={`/inventory/${encodeURIComponent(candidate.linkedResourceId)}`}
                              className={styles.rowLink}
                              title={t('nf_health_link_inventory')}
                            >
                              <Link2 size={12} aria-hidden="true" />
                              {t('nf_health_link_inventory')}
                            </Link>
                          ) : null}
                          {legacyIdentity ? (
                            <span className={styles.badgeUnknown} title={t('nf_health_identity_legacy_hint')}>
                              {t('nf_health_identity_legacy')}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <code className={styles.chip}>
                          {target.collectionMode === 'manual'
                            ? t('nf_health_mode_manual')
                            : t('nf_health_mode_scheduled')}
                        </code>
                      </td>
                      <td>
                        {layerBadge(target.coverage.l1Measured ? 'healthy' : 'unknown', t, styles, target.coverage.l1Measured)}
                      </td>
                      <td>
                        {layerBadge(target.coverage.l2Measured ? 'healthy' : 'unknown', t, styles, target.coverage.l2Measured)}
                      </td>
                      <td>
                        {layerBadge(
                          target.coverage.l3Available
                            ? target.coverage.l3Measured
                              ? 'healthy'
                              : 'unknown'
                            : 'not_configured',
                          t,
                          styles,
                          target.coverage.l3Measured,
                        )}
                      </td>
                      <td>{formatTimestamp(target.lastMeasuredAt)}</td>
                      <td>
                        {(() => {
                          const freshness = target.freshness?.state;
                          if (freshness === 'fresh') {
                            return <span className={styles.badgeHealthy}>{t('nf_health_state_healthy')}</span>;
                          }
                          if (freshness === 'stale') {
                            return <span className={styles.badgeStale}>{t('nf_health_state_stale')}</span>;
                          }
                          if (freshness === 'not_monitored') {
                            return <span className={styles.badgeNotConfigured}>{t('nf_health_state_not_configured')}</span>;
                          }
                          return <span className={styles.badgeUnknown}>{t('nf_health_state_unknown')}</span>;
                        })()}
                      </td>
                      <td>
                        {target.lastError ? (
                          <span className={styles.badgeUnhealthy}>{t('nf_health_status_failed')}</span>
                        ) : target.lastSuccessAt ? (
                          <span className={styles.badgeHealthy}>{t('nf_health_status_success')}</span>
                        ) : (
                          <span className={styles.badgeUnknown}>{t('nf_health_status_never')}</span>
                        )}
                      </td>
                      <td>
                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handleCollect(target)}
                            disabled={!canConfigure || collectingId === target.targetId}
                            title={t('nf_health_collect_action')}
                          >
                            <Play size={14} />
                            {collectingId === target.targetId ? t('nf_health_collecting') : t('nf_health_collect_action')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => navigate(`/nf-health/${encodeURIComponent(target.targetId)}`)}
                          >
                            {t('nf_health_open_detail')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dash-card" aria-label={t('nf_health_card_wall_section')}>
        <div className={styles.sectionHead}>
          <h2>
            <Server size={16} aria-hidden="true" />
            {t('nf_health_card_wall_section')}
          </h2>
          <span className={styles.sectionNote}>{t('nf_health_card_wall_note')}</span>
        </div>
        {error ? (
          <p className={styles.semanticNote}>{t('ops_metric_unavailable')}</p>
        ) : domainGroups.length === 0 ? (
          <p className={styles.semanticNote}>{t('nf_health_empty_targets_body')}</p>
        ) : (
          <div className={styles.cardWall}>
            {domainGroups.map((group) => (
              <div key={group.domain} className={styles.cardGroup}>
                <h3 className={styles.cardGroupTitle}>{group.label}</h3>
                <div className={styles.cardGrid}>
                  {group.targets.map((target) => {
                    const candidate = candidateIndex.get(target.candidateId ?? '');
                    const runtimeComponent = resolveRuntimeComponent(target, candidate);
                    return (
                      <article
                        key={target.targetId}
                        className={styles.targetCard}
                        onClick={() => setDrawerTarget(target)}
                      >
                        <header className={styles.targetCardHead}>
                          <strong className={styles.targetCardName}>{target.name}</strong>
                          <span className={styles.targetCardType}>
                            {target.nfType ?? candidate?.nfType ?? '-'}
                          </span>
                        </header>
                        <div className={styles.targetCardBadges}>
                          {layerBadge(
                            target.coverage.l1Measured ? 'healthy' : 'unknown',
                            t,
                            styles,
                            target.coverage.l1Measured,
                            'L1',
                          )}
                          {layerBadge(
                            target.coverage.l2Measured ? 'healthy' : 'unknown',
                            t,
                            styles,
                            target.coverage.l2Measured,
                            'L2',
                          )}
                          {layerBadge(
                            target.coverage.l3Available
                              ? target.coverage.l3Measured
                                ? 'healthy'
                                : 'unknown'
                              : 'not_configured',
                            t,
                            styles,
                            target.coverage.l3Measured,
                            'L3',
                          )}
                        </div>
                        <UtilizationBar
                          label={t('nf_health_card_memory')}
                          available={Boolean(runtimeComponent?.memoryAvailable)}
                          percent={runtimeComponent?.memoryPercent ?? null}
                        />
                        <UtilizationBar
                          label={t('nf_health_card_cpu')}
                          available={Boolean(runtimeComponent?.cpuAvailable)}
                          percent={runtimeComponent?.cpuPercent ?? null}
                        />
                        <footer className={styles.targetCardFoot}>
                          <span className={styles.targetCardMeta}>
                            {formatTimestamp(target.lastMeasuredAt)}
                          </span>
                          <Link
                            to={`/nf-health/${encodeURIComponent(target.targetId)}`}
                            className={styles.rowLink}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {t('nf_health_open_detail')}
                          </Link>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <NfHealthTargetDrawer
        target={drawerTarget}
        onClose={() => setDrawerTarget(null)}
        onCollected={() => void loadAll()}
      />

      <NfHealthTargetDialog
        open={dialogOpen}
        mode="create"
        meta={meta}
        onClose={() => setDialogOpen(false)}
        onSaved={(message) => {
          setFeedback({ tone: 'success', message });
          void loadAll();
        }}
        onFormError={(message) => setFeedback({ tone: 'danger', message })}
      />
    </div>
  );
}

function layerBadge(
  state: LayerState,
  t: (key: string) => string,
  stylesRecord: Record<string, string>,
  measured: boolean,
  labelPrefix?: string,
): React.ReactElement {
  const className =
    state === 'healthy'
      ? stylesRecord.badgeHealthy
      : state === 'degraded'
        ? stylesRecord.badgeDegraded
        : state === 'unhealthy'
          ? stylesRecord.badgeUnhealthy
          : state === 'not_configured'
            ? stylesRecord.badgeNotConfigured
            : state === 'stale'
              ? stylesRecord.badgeStale
              : stylesRecord.badgeUnknown;

  const labelKey = measured
    ? state === 'healthy'
      ? 'nf_health_layer_measured'
      : `nf_health_state_${state}`
    : state === 'not_configured'
      ? 'nf_health_state_not_configured'
      : 'nf_health_state_unknown';

  return <span className={className}>{labelPrefix ? `${labelPrefix} · ${t(labelKey)}` : t(labelKey)}</span>;
}

function UtilizationBar({
  label,
  available,
  percent,
}: {
  label: string;
  available: boolean;
  percent: number | null;
}): React.ReactElement {
  const { t } = useI18n();
  if (!available || percent == null || !Number.isFinite(percent)) {
    return (
      <div className={styles.utilRow}>
        <span className={styles.utilLabel}>{label}</span>
        <span className={styles.utilValue}>{t('ops_metric_unavailable')}</span>
      </div>
    );
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = clamped >= 90 ? styles.utilBarDanger : clamped >= 75 ? styles.utilBarWarn : styles.utilBarOk;
  return (
    <div className={styles.utilRow}>
      <span className={styles.utilLabel}>{label}</span>
      <div
        className={styles.utilTrack}
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span className={`${styles.utilBar} ${tone}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className={styles.utilValue}>{`${Math.round(clamped)}%`}</span>
    </div>
  );
}

function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function describeMutationError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'NF_HEALTH_DESTINATION_NOT_ALLOWED':
        return t('nf_health_err_destination_not_allowed');
      case 'NF_HEALTH_SERVICE_UNIT_NOT_ALLOWED':
        return t('nf_health_err_service_unit_not_allowed');
      case 'NF_HEALTH_PROCESS_BINDING_MISSING':
        return t('nf_health_err_process_binding_missing');
      case 'NF_HEALTH_PROCESS_BINDING_MISMATCH':
        return t('nf_health_err_process_binding_mismatch');
      case 'NF_HEALTH_RESOURCE_NOT_FOUND':
        return t('nf_health_err_resource_not_found');
      case 'NF_HEALTH_RESOURCE_KIND_UNSUPPORTED':
        return t('nf_health_err_resource_kind_unsupported');
      case 'NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED':
        return t('nf_health_err_resource_domain_unsupported');
      case 'NF_HEALTH_RESOURCE_RETIRED':
        return t('nf_health_err_resource_retired');
      case 'NF_HEALTH_NF_TYPE_UNRESOLVED':
        return t('nf_health_err_nf_type_unresolved');
      case 'NF_HEALTH_CANDIDATE_RESOURCE_MISMATCH':
        return t('nf_health_err_candidate_resource_mismatch');
      case 'NF_HEALTH_CANDIDATE_TYPE_MISMATCH':
        return t('nf_health_err_candidate_type_mismatch');
      case 'NF_HEALTH_TARGET_IDENTITY_MISMATCH':
        return t('nf_health_err_target_identity_mismatch');
      case 'NF_HEALTH_PROCESS_NF_TYPE_INCOMPATIBLE':
        return t('nf_health_err_process_nf_type_incompatible');
      case 'NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE':
        return t('nf_health_err_process_domain_incompatible');
      case 'NF_HEALTH_REVISION_CONFLICT':
        return t('nf_health_err_revision_conflict');
      case 'NF_HEALTH_TARGET_NOT_FOUND':
        return t('nf_health_err_target_missing');
      case 'NF_HEALTH_TARGET_DISABLED':
        return t('nf_health_err_target_disabled');
      case 'NF_HEALTH_COLLECTION_IN_PROGRESS':
        return t('nf_health_err_collection_in_progress');
      case 'NF_HEALTH_COLLECTION_RATE_LIMITED':
        return t('nf_health_err_collection_rate_limited');
      case 'NF_HEALTH_TARGET_CONFLICT':
        return t('nf_health_err_target_conflict');
      default:
        return err.message || t('nf_health_err_mutation');
    }
  }
  return err instanceof Error && err.message ? err.message : t('nf_health_err_mutation');
}
