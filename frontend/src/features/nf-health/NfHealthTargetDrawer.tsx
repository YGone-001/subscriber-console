/*
 * NF Health target snapshot drawer.
 *
 * Opens from the target card wall and the summary table to surface layered
 * state semantics, the latest sample, a bounded one-hour metric trend and the
 * most recent collection runs without leaving the page. Layer badges are
 * never merged into a single health percentage, cumulative counters are never
 * rendered as percentages, and missing evidence stays explicitly unavailable.
 * NF-scoped alert rules are not part of the platform yet, so no alert section
 * is fabricated here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  Activity,
  Boxes,
  Link2,
  Play,
  RefreshCw,
  X,
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
import { EmptyState } from '../../components/ui/OperationFeedback';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import {
  collectNfHealthTarget,
  fetchNfHealthRuns,
  fetchNfHealthTarget,
  fetchNfHealthTargetHistory,
} from './nf-health-api';
import { buildMetricTrendSeries, type MetricTrendSeries } from './nf-health-builders';
import type {
  GetTargetResponse,
  HealthRun,
  HealthSample,
  HealthTargetSummary,
  LayerEvidence,
  LayerState,
} from './nf-health-types';
import styles from '../../styles/modules/nf-health.module.css';

const HISTORY_LIMIT = 40;
const RUNS_LIMIT = 5;
const TREND_WINDOW_MS = 60 * 60 * 1000;
const MAX_TREND_CHARTS = 4;
const PREFERRED_TREND_KEYS = [
  'process_resident_memory_bytes',
  'process_cpu_seconds_total',
];

type Props = {
  target: HealthTargetSummary | null;
  onClose: () => void;
  onCollected?: () => void;
};

type RunStatusTone = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

function runStatusTone(status: HealthRun['status']): RunStatusTone {
  if (status === 'success') return 'healthy';
  if (status === 'partial') return 'degraded';
  if (status === 'failed') return 'unhealthy';
  return 'unknown';
}

function layerBadgeClass(state: LayerState): string {
  switch (state) {
    case 'healthy':
      return styles.badgeHealthy;
    case 'degraded':
      return styles.badgeDegraded;
    case 'unhealthy':
      return styles.badgeUnhealthy;
    case 'not_configured':
      return styles.badgeNotConfigured;
    case 'stale':
      return styles.badgeStale;
    default:
      return styles.badgeUnknown;
  }
}

function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function NfHealthTargetDrawer({ target, onClose, onCollected }: Props) {
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const canConfigure = hasPermission(user, 'core.configure');

  const [detail, setDetail] = useState<GetTargetResponse | null>(null);
  const [samples, setSamples] = useState<HealthSample[]>([]);
  const [runs, setRuns] = useState<HealthRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);

  const targetId = target?.targetId ?? '';

  const loadAll = useCallback(async () => {
    if (!targetId) return;
    setLoading(true);
    setError(null);
    try {
      const [detailRes, historyRes, runsRes] = await Promise.all([
        fetchNfHealthTarget(targetId),
        fetchNfHealthTargetHistory(targetId, { limit: HISTORY_LIMIT }).catch(() => ({ samples: [] as HealthSample[] })),
        fetchNfHealthRuns({ targetId, limit: RUNS_LIMIT }).catch(() => ({ runs: [] as HealthRun[] })),
      ]);
      setDetail(detailRes);
      setSamples(historyRes.samples ?? []);
      setRuns(runsRes.runs ?? []);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('nf_health_err_load'));
    } finally {
      setLoading(false);
    }
  }, [targetId, t]);

  useEffect(() => {
    setDetail(null);
    setSamples([]);
    setRuns([]);
    void loadAll();
  }, [loadAll]);

  const handleCollect = async () => {
    if (!target) return;
    setCollecting(true);
    try {
      await collectNfHealthTarget(target.targetId);
      await loadAll();
      onCollected?.();
    } catch {
      // Collection failures are surfaced by the refreshed run list; the
      // drawer never fabricates a health claim from a failed run.
    } finally {
      setCollecting(false);
    }
  };

  const trendSeries = useMemo<MetricTrendSeries[]>(
    () => buildMetricTrendSeries(samples, Date.now() - TREND_WINDOW_MS),
    [samples],
  );

  const chartedSeries = useMemo(() => {
    const preferred = PREFERRED_TREND_KEYS
      .map((key) => trendSeries.find((series) => series.key === key))
      .filter((series): series is MetricTrendSeries => Boolean(series));
    const rest = trendSeries.filter((series) => !PREFERRED_TREND_KEYS.includes(series.key));
    return [...preferred, ...rest].slice(0, MAX_TREND_CHARTS);
  }, [trendSeries]);

  if (!target) return null;

  const latestSample = detail?.latestSample;
  const overallState = detail?.overallState;

  const content = (
    <div className={styles.drawerLayer} role="dialog" aria-modal="true" aria-label={t('nf_health_drawer_title')}>
      <div className={styles.drawer}>
        <header className={styles.drawerHead}>
          <div>
            <h2 className={styles.drawerTitle}>{target.name}</h2>
            <p className={styles.drawerSub}>
              <code className={styles.uuid}>{target.targetId}</code>
            </p>
          </div>
          <div className={styles.drawerHeadActions}>
            <button type="button" className="btn btn-secondary" onClick={() => void loadAll()} disabled={loading}>
              <RefreshCw size={15} className={loading ? styles.spin : undefined} />
              {t('refresh')}
            </button>
            {canConfigure ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleCollect()}
                disabled={collecting || loading}
              >
                <Play size={15} />
                {collecting ? t('nf_health_collecting') : t('nf_health_collect_action')}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={onClose} aria-label={t('close')}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className={styles.drawerBody}>
          {error ? (
            <div className={styles.errorWrap}>
              <EmptyState
                icon={<Activity size={40} />}
                title={t('error')}
                description={error}
                action={(
                  <button type="button" className="btn btn-secondary" onClick={() => void loadAll()}>
                    {t('nf_health_retry')}
                  </button>
                )}
              />
            </div>
          ) : loading && !detail ? (
            <p className={styles.drawerLoading}>{t('nf_health_drawer_loading')}</p>
          ) : (
            <>
              <section className={styles.drawerSection} aria-label={t('nf_health_drawer_semantics')}>
                <div className={styles.sectionHead}>
                  <h3>{t('nf_health_drawer_semantics')}</h3>
                  <span className={styles.sectionNote}>{t('nf_health_semantic_separation')}</span>
                </div>
                {overallState ? (
                  <p className={styles.drawerOverall}>
                    <span className={layerBadgeClass(overallState)}>{t(`nf_health_state_${overallState}`)}</span>
                    {target.lastError ? (
                      <span className={styles.drawerOverallNote}>{target.lastError}</span>
                    ) : null}
                  </p>
                ) : null}
                <ul className={styles.semanticList}>
                  <SemanticRow
                    label={t('nf_health_layer_l1')}
                    evidence={latestSample?.layers.process}
                    fallbackMeasured={target.coverage.l1Measured}
                    unsupportedKey="nf_health_layer_l1_unsupported"
                  />
                  <SemanticRow
                    label={t('nf_health_layer_l2')}
                    evidence={latestSample?.layers.interface}
                    fallbackMeasured={target.coverage.l2Measured}
                    unsupportedKey="nf_health_layer_l2_unsupported"
                  />
                  <SemanticRow
                    label={t('nf_health_layer_l3')}
                    evidence={latestSample?.layers.service}
                    fallbackMeasured={target.coverage.l3Measured}
                    unsupportedKey="nf_health_layer_l3_unsupported"
                    available={target.coverage.l3Available}
                  />
                </ul>
              </section>

              <section className={styles.drawerSection} aria-label={t('nf_health_drawer_latest_sample')}>
                <div className={styles.sectionHead}>
                  <h3>{t('nf_health_drawer_latest_sample')}</h3>
                  <span className={styles.sectionNote}>
                    {latestSample ? formatDateTime(latestSample.collectedAt) : t('nf_health_status_never')}
                  </span>
                </div>
                {!latestSample?.metrics?.length ? (
                  <p className={styles.drawerMuted}>{t('nf_health_drawer_no_sample')}</p>
                ) : (
                  <div className={styles.tableScroll}>
                    <table className={styles.table}>
                      <caption className="sr-only">{t('nf_health_metrics_caption')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('nf_health_evidence_col_metric')}</th>
                          <th scope="col">{t('nf_health_evidence_col_value')}</th>
                          <th scope="col">{t('nf_health_evidence_col_interpretation')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {latestSample.metrics.map((metric) => (
                          <tr key={metric.key}>
                            <td><code className={styles.uuid}>{metric.key}</code></td>
                            <td>{`${metric.value} ${metric.unit}`}</td>
                            <td>{metric.interpretation ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className={styles.drawerSection} aria-label={t('nf_health_drawer_trends')}>
                <div className={styles.sectionHead}>
                  <h3>{t('nf_health_drawer_trends')}</h3>
                  <span className={styles.sectionNote}>{t('nf_health_trends_note')}</span>
                </div>
                {chartedSeries.length === 0 ? (
                  <p className={styles.drawerMuted}>{t('nf_health_empty_trends_body')}</p>
                ) : (
                  <div className={styles.trendGrid}>
                    {chartedSeries.map((series) => {
                      const latestPoint = series.points[series.points.length - 1];
                      return (
                        <article key={series.key} className={styles.trendCard}>
                          <div className={styles.trendCardHead}>
                            <h4 className={styles.trendCardTitle}>{series.key}</h4>
                            <span className={styles.trendCardMeta}>
                              {t('nf_health_trend_unit', { unit: series.unit })}
                              {' | '}
                              {t('nf_health_trend_freshness', {
                                time: latestPoint ? formatDateTime(new Date(latestPoint.t).toISOString()) : '-',
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

              <section className={styles.drawerSection} aria-label={t('nf_health_drawer_runs')}>
                <div className={styles.sectionHead}>
                  <h3>{t('nf_health_drawer_runs')}</h3>
                  <span className={styles.sectionNote}>{t('nf_health_runs_note')}</span>
                </div>
                {runs.length === 0 ? (
                  <p className={styles.drawerMuted}>{t('nf_health_empty_runs_body')}</p>
                ) : (
                  <div className={styles.tableScroll}>
                    <table className={styles.table}>
                      <caption className="sr-only">{t('nf_health_runs_caption')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('nf_health_col_last_measured')}</th>
                          <th scope="col">{t('nf_health_col_collection_status')}</th>
                          <th scope="col">{t('nf_health_evidence_kind')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((run) => (
                          <tr key={run.runId}>
                            <td>{formatTimestamp(run.startedAt)}</td>
                            <td>
                              <span
                                className={
                                  runStatusTone(run.status) === 'healthy'
                                    ? styles.badgeHealthy
                                    : runStatusTone(run.status) === 'degraded'
                                      ? styles.badgeDegraded
                                      : runStatusTone(run.status) === 'unhealthy'
                                        ? styles.badgeUnhealthy
                                        : styles.badgeUnknown
                                }
                              >
                                {t(`nf_health_run_${run.status}`)}
                              </span>
                            </td>
                            <td>{run.errorSummary ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className={styles.drawerSection} aria-label={t('nf_health_drawer_links')}>
                <div className={styles.drawerLinks}>
                  <Link className="btn btn-secondary" to={`/nf-health/${encodeURIComponent(target.targetId)}`}>
                    <Activity size={15} />
                    {t('nf_health_drawer_open_detail')}
                  </Link>
                  {target.resourceId ? (
                    <Link
                      className="btn btn-secondary"
                      to={`/inventory/${encodeURIComponent(target.resourceId)}`}
                    >
                      <Link2 size={15} />
                      {t('nf_health_link_resource')}
                    </Link>
                  ) : null}
                  {target.candidateId ? (
                    <Link className="btn btn-secondary" to="/discovery">
                      <Boxes size={15} />
                      {t('nf_health_link_candidate')}
                    </Link>
                  ) : null}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

function SemanticRow({
  label,
  evidence,
  fallbackMeasured,
  unsupportedKey,
  available = true,
}: {
  label: string;
  evidence?: LayerEvidence;
  fallbackMeasured: boolean;
  unsupportedKey: string;
  available?: boolean;
}) {
  const { t } = useI18n();
  const state = evidence?.state ?? 'unknown';
  const measured = Boolean(evidence?.measured ?? fallbackMeasured);
  let note: string;
  if (!available) {
    note = t(unsupportedKey);
  } else if (evidence?.reason) {
    note = evidence.reason;
  } else if (evidence?.processOutcome) {
    note = evidence.processOutcome;
  } else if (!measured) {
    note = t(unsupportedKey);
  } else {
    note = t('nf_health_layer_measured');
  }
  return (
    <li className={styles.semanticRow}>
      <span className={styles.semanticLabel}>{label}</span>
      <span className={layerBadgeClass(state)}>{t(`nf_health_state_${state}`)}</span>
      <span className={styles.semanticNoteText}>
        {note}
        {evidence?.mainPid != null ? ` · PID ${evidence.mainPid}` : ''}
      </span>
    </li>
  );
}
