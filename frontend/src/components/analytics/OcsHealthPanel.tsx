/*
 * OCS resource health panel.
 *
 * Pools, sessions, reservations and invariant checks are read directly from the
 * analytics response. A pool with no configured quota, an empty collection or a
 * failed invariant scan is shown as unavailable; it is never presented as 0%
 * used or 100% healthy.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Database, MessageSquare, Phone } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { BYTES_IN_GB } from './utils';
import type {
  OcsBalanceMetrics,
  OcsReservationMetrics,
  OcsSessionMetrics,
  OcsUsageMetrics,
} from './types';

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function toneColor(percent: number): string {
  if (percent >= 85) return 'var(--status-danger)';
  if (percent >= 65) return 'var(--status-warning)';
  return 'var(--status-success)';
}

function PoolCard({
  label,
  icon,
  percent,
  detail,
  note,
}: {
  label: string;
  icon: ReactNode;
  percent: number | null;
  detail: string;
  note?: string;
}) {
  return (
    <article className="analytics-ocs-pool">
      <div className="ocs-res-head">
        <span className={`ocs-res-icon ${percent === null ? 'ocs-res-icon-tone-muted' : 'ocs-res-icon-tone-1'}`}>
          {icon}
        </span>
        <span className="ocs-res-label">{label}</span>
      </div>
      <div className="ocs-res-value" style={{ color: percent === null ? 'var(--text-muted)' : toneColor(percent) }}>
        {percent === null ? '—' : `${percent.toFixed(1)}%`}
      </div>
      <div className="ocs-res-bar-track" aria-hidden="true">
        <div
          className="ocs-res-bar-fill"
          style={{
            width: `${percent === null ? 0 : clampPercent(percent)}%`,
            background: percent === null ? 'transparent' : toneColor(percent),
          }}
        />
      </div>
      <div className="ocs-res-sub">{detail}</div>
      {note ? <div className="ocs-res-sub analytics-ocs-note">{note}</div> : null}
    </article>
  );
}

export default function OcsHealthPanel({
  balances,
  sessions,
  reservations,
  usage,
}: {
  balances?: OcsBalanceMetrics;
  sessions?: OcsSessionMetrics;
  reservations?: OcsReservationMetrics;
  usage?: OcsUsageMetrics;
}) {
  const { t, formatNumber } = useI18n();

  const hasBalances = Boolean(balances && (balances.totalSubscribers > 0 || balances.totalDataAllocated > 0));
  const dataPercent = hasBalances && balances && balances.totalDataAllocated > 0
    ? (balances.totalDataUsed / balances.totalDataAllocated) * 100
    : null;
  const voicePercent = hasBalances && balances && balances.totalVoiceAllocated > 0
    ? (balances.totalVoiceUsed / balances.totalVoiceAllocated) * 100
    : null;
  const smsPercent = hasBalances && balances && balances.totalSmsAllocated > 0
    ? (balances.totalSmsUsed / balances.totalSmsAllocated) * 100
    : null;
  const hasSessions = Boolean(sessions && sessions.totalSessions > 0);
  const hasReservations = Boolean(reservations && reservations.totalReservations > 0);
  const invariantChecked = balances?.invariantChecked ?? 0;
  const invariantBroken = balances?.brokenInvariantCount ?? 0;
  const hasUsage = Boolean(usage && usage.totalRecords > 0);

  const dataDetail = dataPercent === null || !balances
    ? t('dash_biz_ocs_no_pool')
    : t('dash_biz_ocs_used_allocated', {
      used: `${formatNumber(balances.totalDataUsed / BYTES_IN_GB, { maximumFractionDigits: 1 })} GB`,
      total: `${formatNumber(balances.totalDataAllocated / BYTES_IN_GB, { maximumFractionDigits: 1 })} GB`,
    });
  const voiceDetail = voicePercent === null || !balances
    ? t('dash_biz_ocs_no_pool')
    : t('dash_biz_ocs_used_allocated', {
      used: `${formatNumber(Math.round(balances.totalVoiceUsed / 60))} ${t('unit_mins')}`,
      total: `${formatNumber(Math.round(balances.totalVoiceAllocated / 60))} ${t('unit_mins')}`,
    });
  const smsDetail = smsPercent === null || !balances
    ? t('dash_biz_ocs_no_pool')
    : t('dash_biz_ocs_used_allocated', {
      used: `${formatNumber(balances.totalSmsUsed)} ${t('unit_msgs')}`,
      total: `${formatNumber(balances.totalSmsAllocated)} ${t('unit_msgs')}`,
    });

  return (
    <section className="analytics-panel analytics-ocs-health" aria-labelledby="ocs-health-title">
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <Database size={18} color="var(--chart-2)" />
          <h2 id="ocs-health-title">{t('dash_biz_ocs_title')}</h2>
        </div>
        <div className="analytics-ocs-header-actions">
          <Link to="/ocs/balances" className="analytics-ocs-link-btn">
            <span>{t('nav_ocs_balances')}</span>
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>

      <div className="analytics-ocs-health-body">
        <p className="analytics-chart-note">{t('dash_biz_ocs_note')}</p>

        <div className="analytics-ocs-pools">
          <PoolCard
            label={t('dash_biz_ocs_data')}
            icon={<Database size={14} />}
            percent={dataPercent}
            detail={dataDetail}
          />
          <PoolCard
            label={t('dash_ocs_voice_pool')}
            icon={<Phone size={14} />}
            percent={voicePercent}
            detail={voiceDetail}
            note={balances && balances.voiceAllocationDefaulted > 0
              ? t('dash_biz_ocs_defaulted', { count: formatNumber(balances.voiceAllocationDefaulted) })
              : undefined}
          />
          <PoolCard
            label={t('dash_ocs_sms_pool')}
            icon={<MessageSquare size={14} />}
            percent={smsPercent}
            detail={smsDetail}
            note={balances && balances.smsAllocationDefaulted > 0
              ? t('dash_biz_ocs_defaulted', { count: formatNumber(balances.smsAllocationDefaulted) })
              : undefined}
          />
        </div>

        <div className="analytics-ocs-checks">
          <div className="analytics-ocs-check">
            <span>{t('dash_biz_ocs_sessions')}</span>
            <strong>{hasSessions && sessions
              ? t('dash_biz_ocs_sessions_detail', {
                active: formatNumber(sessions.activeSessions),
                closing: formatNumber(sessions.closingSessions),
                total: formatNumber(sessions.totalSessions),
              })
              : t('dash_biz_ocs_no_data')}</strong>
            {hasSessions && sessions ? (
              <small>{t('dash_biz_ocs_interfaces', {
                gy: formatNumber(sessions.interfaceGyCount),
                ro: formatNumber(sessions.interfaceRoCount),
              })}</small>
            ) : null}
          </div>

          <div className={`analytics-ocs-check ${hasReservations && reservations && reservations.orphanedReservations > 0 ? 'analytics-ocs-check-alert' : ''}`}>
            <span>{t('dash_biz_ocs_reservations')}</span>
            <strong>{hasReservations && reservations
              ? t('dash_biz_ocs_reservations_detail', {
                active: formatNumber(reservations.activeReservations),
                orphaned: formatNumber(reservations.orphanedReservations),
                total: formatNumber(reservations.totalReservations),
              })
              : t('dash_biz_ocs_no_data')}</strong>
          </div>

          <div className={`analytics-ocs-check ${invariantBroken > 0 ? 'analytics-ocs-check-alert' : ''}`}>
            <span>{t('dash_biz_ocs_invariants')}</span>
            <strong>{invariantChecked > 0 && balances
              ? t('dash_biz_ocs_invariants_detail', {
                checked: formatNumber(balances.invariantChecked),
                broken: formatNumber(balances.brokenInvariantCount),
                scope: t('dash_biz_ocs_scope_data'),
              })
              : t('dash_biz_ocs_invariants_empty')}</strong>
            {invariantChecked > 0 && balances ? (
              <small>{t('dash_biz_ocs_sample_limit', { limit: formatNumber(balances.invariantSampleLimit) })}</small>
            ) : null}
          </div>
        </div>

        {hasUsage && usage ? (
          <p className="analytics-chart-footnote">
            {t('dash_biz_ocs_usage_totals', {
              total: formatNumber(usage.totalRecords),
              charged: formatNumber(usage.chargedRecords),
            })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
