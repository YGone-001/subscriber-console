/*
 * NF Health list-surface presentation primitives.
 *
 * Every state badge on the list surface comes from here, so the card wall, the
 * audit table and the interface matrix cannot drift into three different
 * vocabularies. Nothing in this module decides health: each helper renders a
 * value the server already projected.
 *
 * Two distinctions are load-bearing and must survive any refactor:
 *   - coverage is a measurement fact, not a health verdict: a layer that was
 *     never measured is "unknown", a layer with no exporter is "not
 *     configured", and neither is ever rendered as healthy;
 *   - an interface cell keeps its evidence one hover away and a family that was
 *     never declared stays neutral instead of looking like a failure.
 */
import type { ReactElement } from 'react';
import { useI18n } from '../../providers/I18nProvider';
import type { HealthTargetSummary, InterfaceCell, LayerState } from './nf-health-types';
import styles from '../../styles/modules/nf-health.module.css';

/** The overall state of a target: the server projection, never a client guess. */
export function overallBadge(target: HealthTargetSummary, t: (key: string) => string): ReactElement {
  return stateBadge(target.overallState ?? 'unknown', t);
}

export function stateBadge(state: string, t: (key: string) => string): ReactElement {
  const className =
    state === 'healthy'
      ? styles.badgeHealthy
      : state === 'degraded'
        ? styles.badgeDegraded
        : state === 'unhealthy'
          ? styles.badgeUnhealthy
          : state === 'stale'
            ? styles.badgeStale
            : state === 'not_configured'
              ? styles.badgeNotConfigured
              : styles.badgeUnknown;
  const key = state === 'healthy' || state === 'degraded' || state === 'unhealthy' ||
    state === 'stale' || state === 'not_configured'
    ? `nf_health_state_${state}`
    : 'nf_health_state_unknown';
  return <span className={className}>{t(key)}</span>;
}

export function freshnessBadge(target: HealthTargetSummary, t: (key: string) => string): ReactElement {
  return freshnessStateBadge(target.freshness?.state ?? 'unknown', t);
}

/* Measurement freshness is the age of the accepted measurement against the
 * target's own policy window. It is independent of the collection outcome, so a
 * fresh target whose last attempt failed still reads as fresh. */
export function freshnessStateBadge(state: string, t: (key: string) => string): ReactElement {
  if (state === 'fresh') {
    return <span className={styles.badgeHealthy}>{t('nf_health_state_healthy')}</span>;
  }
  if (state === 'stale') {
    return <span className={styles.badgeStale}>{t('nf_health_state_stale')}</span>;
  }
  if (state === 'not_monitored') {
    return <span className={styles.badgeNotConfigured}>{t('nf_health_state_not_configured')}</span>;
  }
  return <span className={styles.badgeUnknown}>{t('nf_health_state_unknown')}</span>;
}

/* A matrix cell renders the measured state and keeps the evidence one hover
 * away. not_configured stays neutral: an interface that was never declared is
 * not a failure. */
export function matrixCell(cell: InterfaceCell, t: (key: string) => string): ReactElement {
  const detail = [
    cell.httpStatus ? `HTTP ${cell.httpStatus}` : null,
    cell.responseMs != null ? `${cell.responseMs} ms` : null,
    cell.reason ?? null,
    cell.measuredAt ? formatTimestamp(cell.measuredAt) : null,
  ]
    .filter(Boolean)
    .join(' - ');
  const badge = layerBadge(cell.state, t);
  return detail ? <span title={detail}>{badge}</span> : badge;
}

/* Availability is a server fact, not a client guess: a layer the server marked
 * not_configured has no exporter at all, while every other state means the layer
 * is configured and coverage is a separate measurement question. Summaries that
 * predate the layer projection fall back to the caller's assumption, so the list
 * surfaces never invent an availability the server did not report. */
export function layerAvailable(state: LayerState | undefined, fallback = true): boolean {
  return state === undefined ? fallback : state !== 'not_configured';
}

/* Coverage is a measurement fact, not a health verdict: an established
 * measurement keeps the neutral evidence tone, an attempted-but-absent
 * measurement says unknown, and a layer with no exporter says not configured. */
export function coverageBadge(
  available: boolean,
  measured: boolean,
  t: (key: string) => string,
  labelPrefix?: string,
): ReactElement {
  const state: LayerState | 'measured' = !available ? 'not_configured' : measured ? 'measured' : 'unknown';
  return layerBadge(state, t, labelPrefix);
}

export function layerBadge(
  state: LayerState | 'measured',
  t: (key: string) => string,
  labelPrefix?: string,
): ReactElement {
  const className =
    state === 'measured'
      ? styles.badgeMeasured
      : state === 'healthy'
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

  const labelKey =
    state === 'measured'
      ? 'nf_health_layer_measured'
      : state === 'healthy' || state === 'degraded' || state === 'unhealthy' ||
          state === 'stale' || state === 'not_configured'
        ? `nf_health_state_${state}`
        : 'nf_health_state_unknown';

  return <span className={className}>{labelPrefix ? `${labelPrefix} · ${t(labelKey)}` : t(labelKey)}</span>;
}

/* A missing utilization measurement stays unavailable: it is never rendered as
 * a zero-width bar or as 0%. */
export function UtilizationBar({
  label,
  available,
  percent,
}: {
  label: string;
  available: boolean;
  percent: number | null;
}): ReactElement {
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

export function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
