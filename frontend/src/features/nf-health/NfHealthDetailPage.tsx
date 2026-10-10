/*
 * NF Health target detail route.
 *
 * Shows one monitoring target with layered measurement panels, metric trends,
 * collection history and evidence. Layer panels keep measured evidence visually
 * distinct from unsupported or not-configured layers. Metric charts plot only
 * collected points and never interpolate across collection gaps.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  Boxes,
  Link2,
  Play,
  RefreshCw,
  Server,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import PageHeader from '../../components/ui/PageHeader';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { MutationApiError } from '../../lib/api/mutation-client';
import { fetchDiscoveryCandidate } from '../discovery/discovery-api';
import type { NfObservation } from '../discovery/discovery-types';
import {
  collectNfHealthTarget,
  fetchNfHealthMeta,
  fetchNfHealthRuns,
  fetchNfHealthTarget,
  fetchNfHealthTargetHistory,
} from './nf-health-api';
import {
  TREND_WINDOWS,
  windowStartIso,
  type TrendWindowKey,
} from './nf-health-builders';
import type {
  GetTargetResponse,
  HealthRun,
  HealthSample,
  LayerEvidence,
  LayerState,
  MetricSample,
  NfHealthMeta,
} from './nf-health-types';
import { NfHealthTargetDialog } from './NfHealthTargetDialog';
import styles from '../../styles/modules/nf-health.module.css';

const PAGE_LIMIT = 20;
const HISTORY_LIMIT = 100;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

type TrendPoint = {
  t: number;
  label: string;
  value: number | null;
};

export function NfHealthDetailPage() {
  const { targetId = '' } = useParams<{ targetId: string }>();
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();

  const canConfigure = hasPermission(user, 'core.configure');

  const [detail, setDetail] = useState<GetTargetResponse | null>(null);
  const [runs, setRuns] = useState<HealthRun[]>([]);
  const [samples, setSamples] = useState<HealthSample[]>([]);
  const [candidate, setCandidate] = useState<NfObservation | null>(null);
  const [meta, setMeta] = useState<NfHealthMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [trendWindow, setTrendWindow] = useState<TrendWindowKey>('1h');

  const loadAll = useCallback(async () => {
    if (!targetId) return;
    setLoading(true);
    setError(null);
    try {
      const [detailRes, runsRes, historyRes, metaRes] = await Promise.all([
        fetchNfHealthTarget(targetId),
        fetchNfHealthRuns({ targetId, limit: PAGE_LIMIT }),
        fetchNfHealthTargetHistory(targetId, { limit: HISTORY_LIMIT }),
        fetchNfHealthMeta().catch(() => null),
      ]);
      setDetail(detailRes);
      setRuns(runsRes.runs ?? []);
      setSamples(historyRes.samples ?? []);
      setMeta(metaRes);
      if (detailRes.target.candidateId) {
        try {
          const candidateRes = await fetchDiscoveryCandidate(detailRes.target.candidateId);
          setCandidate(candidateRes);
        } catch {
          setCandidate(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('nf_health_err_load'));
    } finally {
      setLoading(false);
    }
  }, [targetId, t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleCollect = async () => {
    if (!detail) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await collectNfHealthTarget(detail.target.targetId);
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
      setBusy(false);
    }
  };

  const trendSeries = useMemo(() => {
    const from = Date.parse(windowStartIso(trendWindow));
    const buckets = new Map<string, TrendPoint[]>();
    const units = new Map<string, string>();
    const ordered = [...samples].sort(
      (left, right) => Date.parse(left.collectedAt) - Date.parse(right.collectedAt),
    );
    for (const sample of ordered) {
      const collectedAt = Date.parse(sample.collectedAt);
      if (!Number.isFinite(collectedAt) || collectedAt < from) continue;
      for (const metric of sample.metrics ?? []) {
        const points = buckets.get(metric.key) ?? [];
        points.push({
          t: collectedAt,
          label: new Date(collectedAt).toLocaleTimeString(),
          value: metric.value,
        });
        buckets.set(metric.key, points);
        units.set(metric.key, metric.unit);
      }
    }
    return Array.from(buckets.entries()).map(([key, points]) => ({
      key,
      unit: units.get(key) ?? '',
      points,
    }));
  }, [samples, trendWindow]);

  const target = detail?.target;
  const latestSample = detail?.latestSample;

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('eyebrow_nf_health')}
        icon={<Activity size={23} />}
        title={target?.name ?? t('nf_health_detail_title')}
        description={t('nf_health_detail_description')}
        actions={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/nf-health')}>
              <ArrowLeft size={16} />
              {t('nf_health_back')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void loadAll()} disabled={loading}>
              <RefreshCw size={16} className={loading ? styles.spin : undefined} />
              {t('refresh')}
            </button>
            {canConfigure ? (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => setEditOpen(true)} disabled={!target}>
                  {t('nf_health_edit_target')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleCollect()}
                  disabled={busy || !target}
                >
                  <Play size={16} />
                  {busy ? t('nf_health_collecting') : t('nf_health_collect_action')}
                </button>
              </>
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

      <p className={styles.semanticNote}>{t('nf_health_collect_safety')}</p>

      {error ? (
        <div className={styles.errorWrap}>
          <ErrorState title={t('error')} message={error} retryLabel={t('nf_health_retry')} onRetry={() => void loadAll()} />
        </div>
      ) : loading && !target ? (
        <LoadingRows columns={4} rows={3} />
      ) : target ? (
        <>
          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>
                <Server size={16} aria-hidden="true" />
                {t('nf_health_identity_section')}
              </h2>
              <span className={styles.sectionNote}>{t('nf_health_semantic_separation')}</span>
            </div>
            <dl className={styles.identityGrid}>
              <div>
                <dt>{t('nf_health_col_name')}</dt>
                <dd>{target.name}</dd>
              </div>
              <div>
                <dt>{t('nf_health_field_target_id')}</dt>
                <dd><code className={styles.uuid}>{target.targetId}</code></dd>
              </div>
              <div>
                <dt>{t('nf_health_field_candidate')}</dt>
                <dd>
                  <div className={styles.stack}>
                    <code className={styles.uuid}>{target.candidateId}</code>
                    <Link to="/discovery" className={styles.rowLink}>
                      <Boxes size={12} aria-hidden="true" />
                      {t('nf_health_link_candidate')}
                    </Link>
                    {candidate?.linkedResourceId ? (
                      <Link
                        to={`/inventory/${encodeURIComponent(candidate.linkedResourceId)}`}
                        className={styles.rowLink}
                      >
                        <Link2 size={12} aria-hidden="true" />
                        {t('nf_health_link_inventory')}
                      </Link>
                    ) : null}
                  </div>
                </dd>
              </div>
              <div>
                <dt>{t('nf_health_field_profile')}</dt>
                <dd><code className={styles.chip}>{target.collectorProfile}</code></dd>
              </div>
              <div>
                <dt>{t('nf_health_field_endpoint')}</dt>
                <dd><code className={styles.uuid}>{target.metricsEndpoint ?? '-'}</code></dd>
              </div>
              <div>
                <dt>{t('nf_health_field_service_unit')}</dt>
                <dd><code className={styles.chip}>{target.serviceUnit ?? '-'}</code></dd>
              </div>
              <div>
                <dt>{t('nf_health_field_mode')}</dt>
                <dd>
                  <code className={styles.chip}>
                    {target.collectionMode === 'manual'
                      ? t('nf_health_mode_manual')
                      : t('nf_health_mode_scheduled')}
                  </code>
                </dd>
              </div>
              <div>
                <dt>{t('nf_health_field_interval')}</dt>
                <dd>{target.intervalSeconds}s</dd>
              </div>
              <div>
                <dt>{t('nf_health_field_enabled')}</dt>
                <dd>
                  <span className={target.enabled ? styles.badgeHealthy : styles.badgeMuted}>
                    {target.enabled ? t('nf_health_enabled') : t('nf_health_disabled')}
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>{t('nf_health_layers_section')}</h2>
              <span className={styles.sectionNote}>{t('nf_health_layers_note')}</span>
            </div>
            <div className={styles.layerGrid}>
              <LayerPanel
                title={t('nf_health_layer_l1')}
                evidence={latestSample?.layers.process}
                measured={target.coverage.l1Measured}
                notes={[
                  {
                    label: t('nf_health_evidence_kind'),
                    value: latestSample?.layers.process.evidenceKind ?? '-',
                  },
                  {
                    label: t('nf_health_process_outcome'),
                    value: latestSample?.layers.process.processOutcome ?? '-',
                  },
                  {
                    label: t('nf_health_main_pid'),
                    value:
                      latestSample?.layers.process.mainPid != null
                        ? String(latestSample.layers.process.mainPid)
                        : '-',
                  },
                ]}
                unsupportedNote={t('nf_health_layer_l1_unsupported')}
              />
              <LayerPanel
                title={t('nf_health_layer_l2')}
                evidence={latestSample?.layers.interface}
                measured={target.coverage.l2Measured}
                notes={[
                  {
                    label: t('nf_health_evidence_kind'),
                    value: latestSample?.layers.interface.evidenceKind ?? '-',
                  },
                  {
                    label: t('nf_health_http_status'),
                    value:
                      latestSample?.layers.interface.httpStatus != null
                        ? String(latestSample.layers.interface.httpStatus)
                        : '-',
                  },
                  {
                    label: t('nf_health_response_ms'),
                    value:
                      latestSample?.layers.interface.responseMs != null
                        ? `${latestSample.layers.interface.responseMs} ms`
                        : '-',
                  },
                ]}
                unsupportedNote={t('nf_health_layer_l2_unsupported')}
              />
              <LayerPanel
                title={t('nf_health_layer_l3')}
                evidence={latestSample?.layers.service}
                measured={target.coverage.l3Measured}
                available={target.coverage.l3Available}
                notes={[
                  {
                    label: t('nf_health_evidence_kind'),
                    value: latestSample?.layers.service.evidenceKind ?? '-',
                  },
                  {
                    label: t('nf_health_metric_count'),
                    value: String(latestSample?.metrics?.length ?? 0),
                  },
                ]}
                unsupportedNote={t('nf_health_layer_l3_unsupported')}
              />
            </div>
          </section>

          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>{t('nf_health_trends_section')}</h2>
              <span className={styles.sectionNote}>{t('nf_health_trends_note')}</span>
            </div>
            <div className={styles.trendControls} role="group" aria-label={t('nf_health_trend_window')}>
              {TREND_WINDOWS.map((windowKey) => (
                <button
                  key={windowKey}
                  type="button"
                  className={styles.trendWindowBtn}
                  aria-pressed={trendWindow === windowKey}
                  onClick={() => setTrendWindow(windowKey)}
                >
                  {windowKey}
                </button>
              ))}
            </div>
            {loading && samples.length === 0 ? (
              <LoadingRows columns={2} rows={2} />
            ) : trendSeries.length === 0 ? (
              <div className={styles.stateWrap}>
                <EmptyState
                  icon={<Activity size={44} />}
                  title={t('nf_health_empty_trends_title')}
                  description={t('nf_health_empty_trends_body')}
                />
              </div>
            ) : (
              <div className={styles.trendGrid}>
                {trendSeries.map((series) => {
                  const latestPoint = series.points[series.points.length - 1];
                  return (
                    <article key={series.key} className={styles.trendCard}>
                      <div className={styles.trendCardHead}>
                        <h3 className={styles.trendCardTitle}>{series.key}</h3>
                        <span className={styles.trendCardMeta}>
                          {t('nf_health_trend_unit', { unit: series.unit })}
                          {' | '}
                          {t('nf_health_trend_freshness', {
                            time: latestPoint ? formatDateTime(latestPoint.t) : '-',
                          })}
                        </span>
                      </div>
                      <div className={styles.trendChart}>
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={series.points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-border)" />
                            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
                            <YAxis tick={{ fontSize: 11 }} width={48} />
                            <Tooltip />
                            <Line
                              type="linear"
                              dataKey="value"
                              stroke="var(--primary)"
                              strokeWidth={2}
                              dot={{ r: 2 }}
                              connectNulls={false}
                              isAnimationActive={false}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>{t('nf_health_metrics_section')}</h2>
              <span className={styles.sectionNote}>{t('nf_health_metrics_note')}</span>
            </div>
            {!latestSample?.metrics?.length ? (
              <div className={styles.stateWrap}>
                <EmptyState
                  icon={<Activity size={44} />}
                  title={t('nf_health_empty_metrics_title')}
                  description={t('nf_health_empty_metrics_body')}
                />
              </div>
            ) : (
              <div className={styles.metricTableWrap}>
                <table className={styles.table}>
                  <caption className="sr-only">{t('nf_health_metrics_caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('nf_health_col_metric')}</th>
                      <th scope="col">{t('nf_health_col_value')}</th>
                      <th scope="col">{t('nf_health_col_unit')}</th>
                      <th scope="col">{t('nf_health_col_type')}</th>
                      <th scope="col">{t('nf_health_col_source')}</th>
                      <th scope="col">{t('nf_health_col_collected')}</th>
                      <th scope="col">{t('nf_health_col_interpretation')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(latestSample?.metrics ?? []).map((metric) => (
                      <MetricRow key={metric.key} metric={metric} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>{t('nf_health_runs_section')}</h2>
              <span className={styles.sectionNote}>{t('nf_health_runs_note')}</span>
            </div>
            {runs.length === 0 ? (
              <div className={styles.stateWrap}>
                <EmptyState
                  icon={<Activity size={44} />}
                  title={t('nf_health_empty_runs_title')}
                  description={t('nf_health_empty_runs_body')}
                />
              </div>
            ) : (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <caption className="sr-only">{t('nf_health_runs_caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('nf_health_col_started')}</th>
                      <th scope="col">{t('nf_health_col_run_status')}</th>
                      <th scope="col">{t('nf_health_col_layers_measured')}</th>
                      <th scope="col">{t('nf_health_col_error_code')}</th>
                      <th scope="col">{t('nf_health_col_initiated_by')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.runId}>
                        <td>{formatTimestamp(run.startedAt)}</td>
                        <td>
                          <span
                            className={
                              run.status === 'success'
                                ? styles.badgeHealthy
                                : run.status === 'failed'
                                  ? styles.badgeUnhealthy
                                  : styles.badgeDegraded
                            }
                          >
                            {runStatusLabel(run.status, t)}
                          </span>
                        </td>
                        <td>{run.layersMeasured}</td>
                        <td>
                          <div className={styles.stack}>
                            <code className={styles.chip}>{run.errorCode ?? '-'}</code>
                            {run.errorSummary ? <small>{run.errorSummary}</small> : null}
                          </div>
                        </td>
                        <td>{run.initiatedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="dash-card">
            <div className={styles.sectionHead}>
              <h2>{t('nf_health_evidence_section')}</h2>
              <span className={styles.sectionNote}>{t('nf_health_evidence_note')}</span>
            </div>
            <dl className={styles.identityGrid}>
              <div>
                <dt>{t('nf_health_evidence_source')}</dt>
                <dd>{latestSample?.metrics?.[0]?.source ?? latestSample?.layers.process.evidenceKind ?? '-'}</dd>
              </div>
              <div>
                <dt>{t('nf_health_evidence_collected_at')}</dt>
                <dd>{latestSample?.collectedAt ? formatTimestamp(latestSample.collectedAt) : '-'}</dd>
              </div>
              <div>
                <dt>{t('nf_health_evidence_last_success')}</dt>
                <dd>{formatTimestamp(target.lastSuccessAt)}</dd>
              </div>
              <div>
                <dt>{t('nf_health_evidence_last_measured')}</dt>
                <dd>{formatTimestamp(target.lastMeasuredAt)}</dd>
              </div>
              <div>
                <dt>{t('nf_health_evidence_freshness')}</dt>
                <dd>
                  {target.lastError ? (
                    <span className={styles.badgeUnhealthy}>{t('nf_health_status_failed')}</span>
                  ) : target.lastMeasuredAt ? (
                    <span className={styles.badgeHealthy}>{t('nf_health_layer_measured')}</span>
                  ) : (
                    <span className={styles.badgeUnknown}>{t('nf_health_state_unknown')}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('nf_health_evidence_provenance')}</dt>
                <dd>{t('nf_health_evidence_provenance_value')}</dd>
              </div>
              {target.lastError ? (
                <div>
                  <dt>{t('nf_health_last_error')}</dt>
                  <dd className={styles.formError}>{target.lastError}</dd>
                </div>
              ) : null}
              {detail?.lastRun?.errorCode ? (
                <div>
                  <dt>{t('nf_health_col_error_code')}</dt>
                  <dd>
                    <div className={styles.stack}>
                      <code className={styles.chip}>{detail.lastRun.errorCode}</code>
                      {detail.lastRun.errorSummary ? <small>{detail.lastRun.errorSummary}</small> : null}
                    </div>
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className={styles.semanticNote}>{t('nf_health_semantic_registry')}</p>
          </section>

          <NfHealthTargetDialog
            open={editOpen}
            mode="edit"
            existing={target}
            meta={meta}
            onClose={() => setEditOpen(false)}
            onSaved={(message) => {
              setFeedback({ tone: 'success', message });
              void loadAll();
            }}
            onFormError={(message) => setFeedback({ tone: 'danger', message })}
          />
        </>
      ) : null}
    </div>
  );
}

function LayerPanel({
  title,
  evidence,
  measured,
  available = true,
  notes,
  unsupportedNote,
}: {
  title: string;
  evidence?: LayerEvidence;
  measured: boolean;
  available?: boolean;
  notes: Array<{ label: string; value: string }>;
  unsupportedNote: string;
}) {
  const { t } = useI18n();
  const state: LayerState = evidence?.state ?? (measured ? 'unknown' : available ? 'unknown' : 'not_configured');
  const isMeasured = evidence?.measured ?? measured;

  return (
    <article className={styles.layerPanel} data-measured={isMeasured ? 'true' : 'false'}>
      <div className={styles.layerPanelHead}>
        <h3 className={styles.layerPanelTitle}>{title}</h3>
        {stateBadge(state, isMeasured, t)}
      </div>
      {isMeasured ? (
        <dl className={styles.layerMeta}>
          {notes.map((note) => (
            <div key={note.label}>
              <dt>{note.label}</dt>
              <dd>{note.value}</dd>
            </div>
          ))}
          {evidence?.reason ? (
            <div>
              <dt>{t('nf_health_reason')}</dt>
              <dd>{evidence.reason}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className={styles.layerUnsupported}>{unsupportedNote}</p>
      )}
    </article>
  );
}

function MetricRow({ metric }: { metric: MetricSample }) {
  return (
    <tr>
      <td><code className={styles.chip}>{metric.key}</code></td>
      <td>{metric.value}</td>
      <td>{metric.unit}</td>
      <td>{metric.type}</td>
      <td><code className={styles.chip}>{metric.source}</code></td>
      <td>{formatTimestamp(metric.collectedAt)}</td>
      <td>{metric.interpretation ?? '-'}</td>
    </tr>
  );
}

function stateBadge(state: LayerState, measured: boolean, t: (key: string) => string): React.ReactElement {
  const className =
    state === 'healthy'
      ? styles.badgeHealthy
      : state === 'degraded'
        ? styles.badgeDegraded
        : state === 'unhealthy'
          ? styles.badgeUnhealthy
          : state === 'not_configured'
            ? styles.badgeNotConfigured
            : state === 'stale'
              ? styles.badgeStale
              : styles.badgeUnknown;
  const label = measured
    ? state === 'healthy'
      ? t('nf_health_layer_measured')
      : t(`nf_health_state_${state}`)
    : state === 'not_configured'
      ? t('nf_health_state_not_configured')
      : t('nf_health_state_unknown');
  return <span className={className}>{label}</span>;
}

function runStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'success':
      return t('nf_health_run_success');
    case 'partial':
      return t('nf_health_run_partial');
    case 'failed':
      return t('nf_health_run_failed');
    default:
      return status;
  }
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
