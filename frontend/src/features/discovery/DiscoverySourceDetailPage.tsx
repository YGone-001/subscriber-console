/*
 * Discovery source detail route.
 *
 * Shows one configured source, its bounded scan history, and the candidates
 * observed from it. Link and unlink write discovery metadata only; they never
 * create or mutate Inventory resources or Topology edges.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Link2,
  Link2Off,
  Radar,
  RefreshCw,
  Server,
} from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import PageHeader from '../../components/ui/PageHeader';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { MutationApiError } from '../../lib/api/mutation-client';
import {
  fetchDiscoveryCandidates,
  fetchDiscoveryRuns,
  fetchDiscoverySource,
  linkDiscoveryCandidate,
  scanDiscoverySource,
  unlinkDiscoveryCandidate,
  updateDiscoverySource,
} from './discovery-api';
import {
  buildLinkCandidateRequest,
  buildUnlinkCandidateRequest,
  formatObservedEndpoint,
} from './discovery-builders';
import { buildUpdateSourceRequest, validateResourceId } from './discovery-validation';
import type {
  DiscoveryRun,
  DiscoverySource,
  MutableSourceForm,
  NfObservation,
} from './discovery-types';
import styles from '../../styles/modules/discovery.module.css';

const PAGE_LIMIT = 20;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

export function DiscoverySourceDetailPage() {
  const { sourceId = '' } = useParams<{ sourceId: string }>();
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();

  const canConfigure = hasPermission(user, 'core.configure');

  const [source, setSource] = useState<DiscoverySource | null>(null);
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [candidates, setCandidates] = useState<NfObservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<MutableSourceForm>({
    name: '',
    baseUrl: '',
    transportMode: 'h2c',
    enabled: true,
  });
  const [formError, setFormError] = useState<string | null>(null);

  const [linkTarget, setLinkTarget] = useState<NfObservation | null>(null);
  const [linkResourceId, setLinkResourceId] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  const [unlinkTarget, setUnlinkTarget] = useState<NfObservation | null>(null);

  const loadAll = useCallback(async () => {
    if (!sourceId) return;
    setLoading(true);
    setError(null);
    try {
      const [sourceRes, runsRes, candidatesRes] = await Promise.all([
        fetchDiscoverySource(sourceId),
        fetchDiscoveryRuns({ sourceId, limit: PAGE_LIMIT }),
        fetchDiscoveryCandidates({ sourceId, limit: PAGE_LIMIT }),
      ]);
      setSource(sourceRes);
      setRuns(runsRes.runs ?? []);
      setCandidates(candidatesRes.candidates ?? []);
      setForm({
        name: sourceRes.name,
        baseUrl: sourceRes.baseUrl,
        transportMode: sourceRes.transportMode,
        enabled: sourceRes.enabled,
      });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('discovery_err_load'));
    } finally {
      setLoading(false);
    }
  }, [sourceId, t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleScan = async () => {
    if (!source) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await scanDiscoverySource(source.sourceId);
      const run = result.run;
      if (run.status === 'success') {
        setFeedback({ tone: 'success', message: t('discovery_feedback_scan_ok', { count: run.discoveredCount }) });
      } else if (run.status === 'partial') {
        setFeedback({ tone: 'warning', message: t('discovery_feedback_scan_partial') });
      } else {
        setFeedback({ tone: 'danger', message: run.errorSummary || t('discovery_feedback_scan_failed') });
      }
      await loadAll();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async () => {
    if (!source) return;
    setFormError(null);
    setBusy(true);
    try {
      const payload = buildUpdateSourceRequest(source.revision, form);
      await updateDiscoverySource(source.sourceId, payload);
      setEditOpen(false);
      setFeedback({ tone: 'success', message: t('discovery_feedback_updated') });
      await loadAll();
    } catch (err) {
      setFormError(describeMutationError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleLink = async () => {
    if (!linkTarget) return;
    setLinkError(null);
    setBusy(true);
    try {
      const validation = validateResourceId(linkResourceId);
      if (validation) throw new Error(validation);
      const payload = buildLinkCandidateRequest(linkTarget, linkResourceId);
      await linkDiscoveryCandidate(linkTarget.candidateId, payload);
      setLinkTarget(null);
      setLinkResourceId('');
      setFeedback({ tone: 'success', message: t('discovery_feedback_linked') });
      await loadAll();
    } catch (err) {
      setLinkError(describeMutationError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async () => {
    if (!unlinkTarget) return;
    setBusy(true);
    setFeedback(null);
    try {
      const payload = buildUnlinkCandidateRequest(unlinkTarget);
      await unlinkDiscoveryCandidate(unlinkTarget.candidateId, payload);
      setUnlinkTarget(null);
      setFeedback({ tone: 'success', message: t('discovery_feedback_unlinked') });
      await loadAll();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusy(false);
    }
  };

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

  const runStatusLabel = (status: string) => {
    switch (status) {
      case 'success':
        return t('discovery_run_success');
      case 'partial':
        return t('discovery_run_partial');
      case 'failed':
        return t('discovery_run_failed');
      case 'running':
        return t('discovery_run_running');
      default:
        return status;
    }
  };

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('eyebrow_discovery')}
        icon={<Server size={23} />}
        title={source?.name ?? t('discovery_source_detail_title')}
        description={t('discovery_source_detail_description')}
        actions={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/discovery')}>
              <ArrowLeft size={16} />
              {t('discovery_back')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void loadAll()} disabled={loading}>
              <RefreshCw size={16} className={loading ? styles.spin : undefined} />
              {t('refresh')}
            </button>
            {canConfigure ? (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => setEditOpen(true)} disabled={!source}>
                  {t('discovery_edit_source')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleScan()}
                  disabled={busy || !source || !source.enabled}
                >
                  <Radar size={16} />
                  {busy ? t('discovery_scanning') : t('discovery_scan_action')}
                </button>
              </>
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

      {error ? (
        <div className={styles.errorWrap}>
          <ErrorState title={t('error')} message={error} retryLabel={t('retry')} onRetry={() => void loadAll()} />
        </div>
      ) : loading && !source ? (
        <LoadingRows columns={4} rows={3} />
      ) : source ? (
        <>
          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>
                <Server size={16} aria-hidden="true" />
                {t('discovery_source_profile')}
              </h2>
              <span className={styles.sectionNote}>{t('discovery_observation_not_health')}</span>
            </div>
            <dl className={styles.identityGrid}>
              <div>
                <dt>{t('discovery_col_name')}</dt>
                <dd>{source.name}</dd>
              </div>
              <div>
                <dt>{t('discovery_col_adapter')}</dt>
                <dd><code className={styles.chip}>{source.adapterType}</code></dd>
              </div>
              <div>
                <dt>{t('discovery_col_base_url')}</dt>
                <dd><code className={styles.uuid}>{source.baseUrl}</code></dd>
              </div>
              <div>
                <dt>{t('discovery_field_transport')}</dt>
                <dd><code className={styles.chip}>{source.transportMode}</code></dd>
              </div>
              <div>
                <dt>{t('discovery_col_enabled')}</dt>
                <dd>
                  <span className={source.enabled ? styles.badgeOk : styles.badgeMuted}>
                    {source.enabled ? t('discovery_enabled') : t('discovery_disabled')}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t('discovery_revision')}</dt>
                <dd>r{source.revision}</dd>
              </div>
              <div>
                <dt>{t('discovery_col_last_scan')}</dt>
                <dd>{source.lastScanAt ? formatTimestamp(source.lastScanAt) : '-'}</dd>
              </div>
              <div>
                <dt>{t('discovery_last_success')}</dt>
                <dd>{source.lastSuccessAt ? formatTimestamp(source.lastSuccessAt) : '-'}</dd>
              </div>
              {source.lastError ? (
                <div>
                  <dt>{t('discovery_last_error')}</dt>
                  <dd className={styles.formError}>{source.lastError}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>{t('discovery_runs_section')}</h2>
              <span className={styles.sectionNote}>{t('discovery_runs_note')}</span>
            </div>
            {runs.length === 0 ? (
              <div className={styles.stateWrap}>
                <EmptyState icon={<Radar size={44} />} title={t('discovery_empty_runs_title')} description={t('discovery_empty_runs_body')} />
              </div>
            ) : (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <caption className="sr-only">{t('discovery_runs_caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('discovery_col_started')}</th>
                      <th scope="col">{t('discovery_col_run_status')}</th>
                      <th scope="col">{t('discovery_col_discovered')}</th>
                      <th scope="col">{t('discovery_col_created')}</th>
                      <th scope="col">{t('discovery_col_updated')}</th>
                      <th scope="col">{t('discovery_col_missing')}</th>
                      <th scope="col">{t('discovery_col_error')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.runId}>
                        <td>{formatTimestamp(run.startedAt)}</td>
                        <td>
                          <span className={run.status === 'success' ? styles.badgeOk : run.status === 'failed' ? styles.badgeDanger : styles.badgeWarn}>
                            {runStatusLabel(run.status)}
                          </span>
                        </td>
                        <td>{run.discoveredCount}</td>
                        <td>{run.createdCount}</td>
                        <td>{run.updatedCount}</td>
                        <td>{run.missingCount}</td>
                        <td>{run.errorSummary || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>{t('discovery_candidates_section')}</h2>
              <span className={styles.sectionNote}>{t('discovery_candidates_note')}</span>
            </div>
            {candidates.length === 0 ? (
              <div className={styles.stateWrap}>
                <EmptyState icon={<Server size={44} />} title={t('discovery_empty_candidates_title')} description={t('discovery_empty_candidates_body')} />
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
                      <th scope="col">{t('discovery_col_services')}</th>
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
                            {candidate.fqdn ? <small>{candidate.fqdn}</small> : null}
                            {candidate.ipv4Addresses?.length ? <small>{candidate.ipv4Addresses.join(', ')}</small> : null}
                          </div>
                        </td>
                        <td><code className={styles.chip}>{candidate.nfStatus}</code></td>
                        <td>
                          <span className={candidate.observationState === 'seen' ? styles.badgeOk : candidate.observationState === 'missing' ? styles.badgeDanger : styles.badgeWarn}>
                            {observationLabel(candidate.observationState)}
                          </span>
                        </td>
                        <td>
                          <ul className={styles.miniList}>
                            {(candidate.observedServices ?? []).slice(0, 4).map((service) => (
                              <li key={service.serviceName}>
                                <code className={styles.chip}>{service.serviceName}</code>
                              </li>
                            ))}
                            {(candidate.observedEndpoints ?? []).slice(0, 2).map((endpoint, index) => (
                              <li key={`${endpoint.address}-${index}`}>{formatObservedEndpoint(endpoint)}</li>
                            ))}
                          </ul>
                        </td>
                        <td>
                          {candidate.linkedResourceId ? (
                            <Link to={`/inventory/${encodeURIComponent(candidate.linkedResourceId)}`} className={styles.rowLink}>
                              <Link2 size={14} aria-hidden="true" />
                              {candidate.linkedResourceId}
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
                                onClick={() => setUnlinkTarget(candidate)}
                                disabled={!canConfigure || busy}
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
                                disabled={!canConfigure || busy}
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
        </>
      ) : null}

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="discovery-edit-title"
      >
        <div className={styles.modalHeader}>
          <h2 id="discovery-edit-title">{t('discovery_edit_source')}</h2>
        </div>
        <div className={styles.modalBody}>
          <Field htmlFor="discovery-edit-name" label={t('discovery_field_name')}>
            <input
              id="discovery-edit-name"
              className="form-input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              disabled={busy}
            />
          </Field>
          <Field htmlFor="discovery-edit-url" label={t('discovery_field_base_url')}>
            <input
              id="discovery-edit-url"
              className="form-input"
              value={form.baseUrl}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              disabled={busy}
            />
          </Field>
          <Field htmlFor="discovery-edit-transport" label={t('discovery_field_transport')}>
            <select
              id="discovery-edit-transport"
              className="form-input"
              value={form.transportMode}
              onChange={(event) => setForm({ ...form, transportMode: event.target.value as MutableSourceForm['transportMode'] })}
              disabled={busy}
            >
              <option value="h2c">h2c</option>
              <option value="h2_tls">h2_tls</option>
            </select>
          </Field>
          <Field htmlFor="discovery-edit-enabled" label={t('discovery_field_enabled')}>
            <input
              id="discovery-edit-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              disabled={busy}
            />
          </Field>
          {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
          <div className={styles.formActions}>
            <button type="button" className="btn btn-secondary" onClick={() => setEditOpen(false)} disabled={busy}>
              {t('cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleUpdate()} disabled={busy}>
              {busy ? t('discovery_submitting') : t('discovery_save')}
            </button>
          </div>
        </div>
      </Dialog>

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
              disabled={busy}
              placeholder="00000000-0000-4000-8000-000000000000"
            />
          </Field>
          <div className={styles.formActions}>
            <button type="button" className="btn btn-secondary" onClick={() => setLinkTarget(null)} disabled={busy}>
              {t('cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleLink()} disabled={busy}>
              {busy ? t('discovery_submitting') : t('discovery_link_confirm')}
            </button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={unlinkTarget !== null}
        onClose={() => setUnlinkTarget(null)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="discovery-unlink-title"
        role="alertdialog"
      >
        <div className={styles.modalHeader}>
          <h2 id="discovery-unlink-title">{t('discovery_unlink_title')}</h2>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.modalIntro}>{t('discovery_unlink_intro')}</p>
          <div className={styles.formActions}>
            <button type="button" className="btn btn-secondary" onClick={() => setUnlinkTarget(null)} disabled={busy}>
              {t('cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void handleUnlink()} disabled={busy}>
              {busy ? t('discovery_submitting') : t('discovery_unlink_confirm')}
            </button>
          </div>
        </div>
      </Dialog>
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
  if (err instanceof Error && err.message && err.message.startsWith('discovery_validation_')) {
    return t(err.message);
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
