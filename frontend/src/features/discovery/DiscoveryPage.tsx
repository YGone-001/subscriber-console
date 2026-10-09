/*
 * NF Discovery list route.
 *
 * Surfaces the read-only observation plane: configured sources, bounded scan
 * history, and NF candidates. Observation state is rendered separately from
 * registry status and never collapsed into an operational health flag.
 * Link and unlink only write discovery metadata; Inventory stays authoritative.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Boxes,
  Link2,
  Link2Off,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Server,
  X,
} from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import PageHeader from '../../components/ui/PageHeader';
import { SkeletonKpiStrip } from '../../components/ui/LoadingSkeleton';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { MutationApiError } from '../../lib/api/mutation-client';
import {
  createDiscoverySource,
  fetchDiscoveryCandidates,
  fetchDiscoveryMeta,
  fetchDiscoverySources,
  linkDiscoveryCandidate,
  scanDiscoverySource,
  unlinkDiscoveryCandidate,
} from './discovery-api';
import { buildLinkCandidateRequest, buildUnlinkCandidateRequest } from './discovery-builders';
import {
  buildCreateSourceRequest,
  CANONICAL_ADAPTER_TYPES,
  CANONICAL_TRANSPORT_MODES,
} from './discovery-validation';
import type {
  DiscoveryAdapterType,
  DiscoveryMetaResponse,
  DiscoverySource,
  DiscoveryTransportMode,
  NfObservation,
} from './discovery-types';
import styles from '../../styles/modules/discovery.module.css';

const PAGE_LIMIT = 20;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

export function DiscoveryPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();

  const canRead = hasPermission(user, 'core.read');
  const canConfigure = hasPermission(user, 'core.configure');

  const [meta, setMeta] = useState<DiscoveryMetaResponse | null>(null);
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [candidates, setCandidates] = useState<NfObservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [scanningSourceId, setScanningSourceId] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [observationFilter, setObservationFilter] = useState('');
  const [nfTypeFilter, setNfTypeFilter] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formAdapter, setFormAdapter] = useState<DiscoveryAdapterType>('nrf');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formTransport, setFormTransport] = useState<DiscoveryTransportMode>('h2c');
  const [formEnabled, setFormEnabled] = useState(true);

  const [linkTarget, setLinkTarget] = useState<NfObservation | null>(null);
  const [linkResourceId, setLinkResourceId] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metaRes, sourcesRes, candidatesRes] = await Promise.all([
        fetchDiscoveryMeta().catch(() => null),
        fetchDiscoverySources({ q: searchQuery || undefined, limit: PAGE_LIMIT }),
        fetchDiscoveryCandidates({
          nfType: nfTypeFilter || undefined,
          observationState: (observationFilter as NfObservation['observationState'] | '') || undefined,
          limit: PAGE_LIMIT,
        }),
      ]);
      setMeta(metaRes);
      setSources(sourcesRes.sources ?? []);
      setCandidates(candidatesRes.candidates ?? []);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('discovery_err_load'));
      setSources([]);
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, observationFilter, nfTypeFilter, t]);

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setError(t('discovery_err_forbidden'));
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
      });
      await createDiscoverySource(payload);
      setCreateOpen(false);
      setFormName('');
      setFormBaseUrl('');
      setFormEnabled(true);
      setFeedback({ tone: 'success', message: t('discovery_feedback_created') });
      await loadAll();
    } catch (err) {
      setFormError(describeMutationError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

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
      await loadAll();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setScanningSourceId(null);
    }
  };

  const handleLink = async () => {
    if (!linkTarget) return;
    setBusyCandidateId(linkTarget.candidateId);
    setLinkError(null);
    setFeedback(null);
    try {
      const payload = buildLinkCandidateRequest(linkTarget, linkResourceId);
      await linkDiscoveryCandidate(linkTarget.candidateId, payload);
      setLinkTarget(null);
      setLinkResourceId('');
      setFeedback({ tone: 'success', message: t('discovery_feedback_linked') });
      await loadAll();
    } catch (err) {
      setLinkError(describeMutationError(err, t));
    } finally {
      setBusyCandidateId(null);
    }
  };

  const handleUnlink = async (candidate: NfObservation) => {
    setBusyCandidateId(candidate.candidateId);
    setFeedback(null);
    try {
      const payload = buildUnlinkCandidateRequest(candidate);
      await unlinkDiscoveryCandidate(candidate.candidateId, payload);
      setFeedback({ tone: 'success', message: t('discovery_feedback_unlinked') });
      await loadAll();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusyCandidateId(null);
    }
  };

  const kpis = useMemo(() => {
    const seen = candidates.filter((item) => item.observationState === 'seen').length;
    const missing = candidates.filter((item) => item.observationState === 'missing').length;
    const linked = candidates.filter((item) => item.linkedResourceId).length;
    return { sources: sources.length, seen, missing, linked };
  }, [sources, candidates]);

  const observationLabel = (state: string) => {
    switch (state) {
      case 'seen':
        return t('discovery_state_seen');
      case 'missing':
        return t('discovery_state_missing');
      case 'stale':
        return t('discovery_state_stale');
      default:
        return state;
    }
  };

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('eyebrow_discovery')}
        icon={<Radar size={23} />}
        title={t('discovery_title')}
        description={t('discovery_description')}
        actions={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => void loadAll()} disabled={loading}>
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
                {t('discovery_create_source')}
              </button>
            ) : null}
          </>
        )}
      />

      {feedback ? (
        <OperationFeedback
          tone={feedback.tone}
          title={t('discovery_operation_result')}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}

      {loading && sources.length === 0 ? (
        <SkeletonKpiStrip count={4} />
      ) : (
        <section className={styles.kpiStrip} aria-label={t('discovery_kpi_label')}>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('discovery_kpi_sources')}</span>
            <strong className={styles.kpiValue}>{kpis.sources}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('discovery_kpi_seen')}</span>
            <strong className={styles.kpiValue}>{kpis.seen}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('discovery_kpi_missing')}</span>
            <strong className={styles.kpiValue}>{kpis.missing}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('discovery_kpi_linked')}</span>
            <strong className={styles.kpiValue}>{kpis.linked}</strong>
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
              placeholder={t('discovery_search_placeholder')}
              aria-label={t('discovery_search_placeholder')}
            />
            <button type="submit" className="btn btn-secondary">
              {t('search')}
            </button>
          </form>
          <div className={styles.filterGroup}>
            <select
              className="form-input"
              aria-label={t('discovery_filter_observation')}
              value={observationFilter}
              onChange={(event) => setObservationFilter(event.target.value)}
            >
              <option value="">{t('discovery_filter_all_states')}</option>
              {(meta?.observationStates ?? ['seen', 'missing', 'stale']).map((value) => (
                <option key={value} value={value}>
                  {observationLabel(value)}
                </option>
              ))}
            </select>
            <input
              className="form-input"
              type="text"
              aria-label={t('discovery_filter_nf_type')}
              placeholder={t('discovery_filter_nf_type')}
              value={nfTypeFilter}
              onChange={(event) => setNfTypeFilter(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSearchInput('');
                setSearchQuery('');
                setObservationFilter('');
                setNfTypeFilter('');
              }}
              disabled={loading}
            >
              <X size={14} aria-hidden="true" />
              {t('discovery_clear_filters')}
            </button>
          </div>
        </div>

        <div className={styles.sectionHead}>
          <h2>
            <Server size={16} aria-hidden="true" />
            {t('discovery_sources_section')}
          </h2>
          <span className={styles.sectionNote}>{t('discovery_sources_note')}</span>
        </div>

        {error ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={error} retryLabel={t('retry')} onRetry={() => void loadAll()} />
          </div>
        ) : loading && sources.length === 0 ? (
          <LoadingRows columns={6} rows={4} />
        ) : sources.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Server size={44} />}
              title={t('discovery_empty_sources_title')}
              description={t('discovery_empty_sources_body')}
              action={
                canConfigure ? (
                  <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                    <Plus size={16} />
                    {t('discovery_create_source')}
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('discovery_sources_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('discovery_col_name')}</th>
                  <th scope="col">{t('discovery_col_adapter')}</th>
                  <th scope="col">{t('discovery_col_base_url')}</th>
                  <th scope="col">{t('discovery_col_enabled')}</th>
                  <th scope="col">{t('discovery_col_last_scan')}</th>
                  <th scope="col">{t('discovery_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.sourceId}>
                    <td>
                      <Link to={`/discovery/sources/${encodeURIComponent(source.sourceId)}`} className={styles.rowLink}>
                        {source.name}
                      </Link>
                    </td>
                    <td><code className={styles.chip}>{source.adapterType}</code></td>
                    <td><code className={styles.uuid}>{source.baseUrl}</code></td>
                    <td>
                      <span className={source.enabled ? styles.badgeOk : styles.badgeMuted}>
                        {source.enabled ? t('discovery_enabled') : t('discovery_disabled')}
                      </span>
                    </td>
                    <td>{source.lastScanAt ? formatTimestamp(source.lastScanAt) : '-'}</td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => void handleScan(source)}
                          disabled={!canConfigure || !source.enabled || scanningSourceId === source.sourceId}
                          title={t('discovery_scan_action')}
                        >
                          <Radar size={14} />
                          {scanningSourceId === source.sourceId ? t('discovery_scanning') : t('discovery_scan_action')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => navigate(`/discovery/sources/${encodeURIComponent(source.sourceId)}`)}
                        >
                          {t('discovery_open_detail')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dash-card">
        <div className={styles.sectionHead}>
          <h2>
            <Boxes size={16} aria-hidden="true" />
            {t('discovery_candidates_section')}
          </h2>
          <span className={styles.sectionNote}>{t('discovery_candidates_note')}</span>
        </div>

        {loading && candidates.length === 0 ? (
          <LoadingRows columns={7} rows={4} />
        ) : candidates.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Boxes size={44} />}
              title={t('discovery_empty_candidates_title')}
              description={t('discovery_empty_candidates_body')}
            />
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('discovery_candidates_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('discovery_col_nf_type')}</th>
                  <th scope="col">{t('discovery_col_instance')}</th>
                  <th scope="col">{t('discovery_col_registry_status')}</th>
                  <th scope="col">{t('discovery_col_observation')}</th>
                  <th scope="col">{t('discovery_col_link')}</th>
                  <th scope="col">{t('discovery_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.candidateId}>
                    <td><strong>{candidate.nfType}</strong></td>
                    <td>
                      <div className={styles.stack}>
                        <code className={styles.uuid}>{candidate.externalNfInstanceId}</code>
                        {candidate.ipv4Addresses?.length ? (
                          <small>{candidate.ipv4Addresses.join(', ')}</small>
                        ) : null}
                      </div>
                    </td>
                    <td><code className={styles.chip}>{candidate.nfStatus}</code></td>
                    <td>
                      <span className={stateBadgeClass(candidate.observationState, styles)}>
                        {observationLabel(candidate.observationState)}
                      </span>
                    </td>
                    <td>
                      {candidate.linkedResourceId ? (
                        <Link
                          to={`/inventory/${encodeURIComponent(candidate.linkedResourceId)}`}
                          className={styles.rowLink}
                        >
                          <Link2 size={14} aria-hidden="true" />
                          {shortId(candidate.linkedResourceId)}
                        </Link>
                      ) : (
                        <span className={styles.badgeMuted}>{t('discovery_unlinked')}</span>
                      )}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        {candidate.linkedResourceId ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handleUnlink(candidate)}
                            disabled={!canConfigure || busyCandidateId === candidate.candidateId}
                          >
                            <Link2Off size={14} />
                            {t('discovery_unlink_action')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => {
                              setLinkError(null);
                              setLinkResourceId('');
                              setLinkTarget(candidate);
                            }}
                            disabled={!canConfigure || busyCandidateId === candidate.candidateId}
                          >
                            <Link2 size={14} />
                            {t('discovery_link_action')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={linkTarget !== null}
        onClose={() => setLinkTarget(null)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="discovery-link-title"
      >
        <div className={styles.modalHeader}>
          <h2 id="discovery-link-title">{t('discovery_link_title')}</h2>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.modalIntro}>{t('discovery_link_intro')}</p>
          {linkTarget ? (
            <dl className={styles.identityReadonly}>
              <div>
                <dt>{t('discovery_col_nf_type')}</dt>
                <dd>{linkTarget.nfType}</dd>
              </div>
              <div>
                <dt>{t('discovery_col_instance')}</dt>
                <dd><code className={styles.uuid}>{linkTarget.externalNfInstanceId}</code></dd>
              </div>
            </dl>
          ) : null}
          <Field
            htmlFor="discovery-link-resource"
            label={t('discovery_link_resource')}
            description={t('discovery_link_resource_hint')}
            error={linkError ?? undefined}
          >
            <input
              id="discovery-link-resource"
              className="form-input"
              value={linkResourceId}
              onChange={(event) => setLinkResourceId(event.target.value)}
              disabled={busyCandidateId !== null}
              placeholder="00000000-0000-4000-8000-000000000000"
            />
          </Field>
          <div className={styles.formActions}>
            <button type="button" className="btn btn-secondary" onClick={() => setLinkTarget(null)} disabled={busyCandidateId !== null}>
              {t('cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleLink()} disabled={busyCandidateId !== null}>
              {busyCandidateId !== null ? t('discovery_submitting') : t('discovery_link_confirm')}
            </button>
          </div>
        </div>
      </Dialog>

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
    </div>
  );
}

function stateBadgeClass(state: string, styles: Record<string, string>): string {
  if (state === 'seen') return styles.badgeOk;
  if (state === 'missing') return styles.badgeDanger;
  return styles.badgeWarn;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
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
  if (err instanceof Error && err.message && !err.message.startsWith('{')) {
    if (err.message.startsWith('discovery_validation_')) {
      return t(err.message);
    }
  }
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'DISCOVERY_TARGET_NOT_ALLOWED':
        return t('discovery_err_not_allowed');
      case 'DISCOVERY_SOURCE_DISABLED':
        return t('discovery_err_disabled');
      case 'DISCOVERY_SCAN_IN_PROGRESS':
        return t('discovery_err_scan_in_progress');
      case 'DISCOVERY_SCAN_RATE_LIMITED':
        return t('discovery_err_scan_rate_limited');
      case 'DISCOVERY_REVISION_CONFLICT':
        return t('discovery_err_revision_conflict');
      case 'DISCOVERY_INVENTORY_LINK_CONFLICT':
        return t('discovery_err_link_conflict');
      case 'DISCOVERY_SOURCE_NOT_FOUND':
        return t('discovery_err_source_missing');
      case 'DISCOVERY_CANDIDATE_NOT_FOUND':
        return t('discovery_err_candidate_missing');
      default:
        return err.message || t('discovery_err_mutation');
    }
  }
  return err instanceof Error && err.message ? err.message : t('discovery_err_mutation');
}
