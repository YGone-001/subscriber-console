/*
 * Real 24-hour OCS usage trend.
 *
 * The chart consumes hourly buckets aggregated from accepted usage records.
 * Empty hours are intentionally rendered as zero-valued buckets inside a window
 * that has records; a window with no records shows an explicit empty state and
 * the latest known record time instead of a fabricated trend.
 */
import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import EmptyChartState from './EmptyChartState';
import { ChartDataTable } from '../ui/ChartDataTable';
import {
  CHART_GRID_COLOR,
  CHART_TICK_COLOR,
  CHART_TOOLTIP_STYLE,
  ChartSummary,
} from '../ui/chartPrimitives';
import { BYTES_IN_GB } from './utils';
import type { UsageTrendPoint } from './types';

type ChartPoint = {
  label: string;
  hour: string;
  gb: number;
};

function UsageTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartPoint }>;
  label?: string;
}) {
  const { t, formatNumber } = useI18n();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div style={{ ...CHART_TOOLTIP_STYLE, padding: '0.65rem 0.8rem', minWidth: 150 }}>
      <div className="analytics-chart-tooltip-title">{label}</div>
      <div className="analytics-chart-tooltip-row">
        <span>{t('dash_biz_usage_series')}</span>
        <strong>{formatNumber(point.gb, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB</strong>
      </div>
    </div>
  );
}

export default function UsageTrendChart({
  points,
  totalOctets,
  records,
  latestUsageAt,
  emptyTitle,
  emptyDescription,
}: {
  points: UsageTrendPoint[];
  totalOctets: number;
  records: number;
  latestUsageAt: string;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const { t, formatNumber, formatDateTime } = useI18n();
  const titleId = React.useId();
  const summaryId = React.useId();
  const totalGb = totalOctets / BYTES_IN_GB;
  const latestText = latestUsageAt
    ? formatDateTime(latestUsageAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  const chartData = useMemo<ChartPoint[]>(() => points.map((point) => ({
    label: formatDateTime(point.hour, { hour: '2-digit', minute: '2-digit' }),
    hour: point.hour,
    gb: point.octets / BYTES_IN_GB,
  })), [points, formatDateTime]);

  const summary = t('dash_biz_usage_summary', {
    total: formatNumber(totalGb, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    records: formatNumber(records),
  });

  return (
    <section className="analytics-panel" aria-labelledby={titleId}>
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <Activity size={18} color="var(--chart-1)" />
          <h2 id={titleId}>{t('dash_biz_usage_title')}</h2>
        </div>
        <span className="analytics-panel-badge">{t('dash_biz_usage_window')}</span>
      </div>

      <div className="analytics-panel-body analytics-chart-body">
        {records === 0 ? (
          <EmptyChartState
            icon={<Activity size={42} />}
            title={emptyTitle ?? t('dash_biz_usage_empty_title')}
            description={emptyDescription
              ?? (latestText
                ? t('dash_biz_usage_empty_latest', { time: latestText })
                : t('dash_biz_usage_empty_none'))}
            action={(
              <Link to="/ocs/balances" className="btn btn-outline analytics-empty-button">
                {t('nav_ocs_balances')}
              </Link>
            )}
          />
        ) : (
          <>
            <ChartSummary id={summaryId}>{summary}</ChartSummary>
            <p className="analytics-chart-note">{t('dash_biz_usage_note')}</p>
            <div
              className="analytics-chart-canvas"
              role="img"
              aria-labelledby={titleId}
              aria-describedby={summaryId}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="biz-usage-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" vertical={false} stroke={CHART_GRID_COLOR} />
                  <XAxis
                    dataKey="label"
                    stroke={CHART_TICK_COLOR}
                    tick={{ fill: CHART_TICK_COLOR, fontSize: 'var(--ref-font-size-caption)' }}
                    minTickGap={24}
                  />
                  <YAxis
                    stroke={CHART_TICK_COLOR}
                    tick={{ fill: CHART_TICK_COLOR, fontSize: 'var(--ref-font-size-caption)' }}
                    tickFormatter={(value: number) => formatNumber(value, { maximumFractionDigits: 1 })}
                    width={48}
                  />
                  <Tooltip content={<UsageTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="gb"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    fill="url(#biz-usage-fill)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="analytics-chart-footnote">
              {t('dash_biz_usage_summary', {
                total: formatNumber(totalGb, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                records: formatNumber(records),
              })}
              {latestText ? ` · ${t('dash_biz_usage_empty_latest', { time: latestText })}` : ''}
            </p>
          </>
        )}
      </div>

      {records > 0 ? (
        <ChartDataTable
          label={t('chart_data_table')}
          caption={t('dash_biz_usage_title')}
          columns={[
            { key: 'hour', label: t('dash_biz_usage_window') },
            { key: 'usage', label: t('dash_biz_usage_series'), numeric: true },
          ]}
          rows={chartData.map((point) => ({
            key: point.hour,
            cells: [
              formatDateTime(point.hour, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
              `${formatNumber(point.gb, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`,
            ],
          }))}
        />
      ) : null}
    </section>
  );
}
