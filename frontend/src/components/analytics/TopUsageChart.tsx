/*
 * Top data users for the trailing usage window.
 *
 * Ranking comes from the backend aggregation over accepted usage records, never
 * from remaining balances or an unsorted cursor page.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Users } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import EmptyChartState from './EmptyChartState';
import { ChartDataTable } from '../ui/ChartDataTable';
import {
  CHART_CURSOR_COLOR,
  CHART_GRID_COLOR,
  CHART_SERIES_COLORS,
  CHART_TICK_COLOR,
  CHART_TOOLTIP_STYLE,
  ChartSummary,
} from '../ui/chartPrimitives';
import { BYTES_IN_GB } from './utils';
import type { TopUsageEntry } from './types';

type ChartPoint = {
  imsi: string;
  gb: number;
  share: number;
};

function TopUsageTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartPoint }>;
}) {
  const { t, formatNumber } = useI18n();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div style={{ ...CHART_TOOLTIP_STYLE, padding: '0.65rem 0.8rem', minWidth: 190 }}>
      <div className="analytics-chart-tooltip-title">{point.imsi}</div>
      <div className="analytics-chart-tooltip-row">
        <span>{t('dash_biz_usage_series')}</span>
        <strong>{formatNumber(point.gb, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB</strong>
      </div>
      <div className="analytics-chart-tooltip-row">
        <span>{t('dash_biz_top_share')}</span>
        <strong>{formatNumber(point.share, { maximumFractionDigits: 1 })}%</strong>
      </div>
    </div>
  );
}

export default function TopUsageChart({
  entries,
  totalOctets,
  records,
  latestUsageAt,
}: {
  entries: TopUsageEntry[];
  totalOctets: number;
  records: number;
  latestUsageAt: string;
}) {
  const { t, formatNumber, formatDateTime } = useI18n();
  const titleId = React.useId();
  const summaryId = React.useId();
  const leading = entries[0];
  const topShare = entries.reduce((sum, entry) => sum + entry.share, 0);
  const latestText = latestUsageAt
    ? formatDateTime(latestUsageAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const chartData: ChartPoint[] = entries.map((entry) => ({
    imsi: entry.imsi,
    gb: entry.usedOctets / BYTES_IN_GB,
    share: entry.share,
  }));
  const hasData = records > 0 && entries.length > 0 && totalOctets > 0;
  const summary = leading
    ? t('dash_biz_top_summary', {
      share: formatNumber(topShare, { maximumFractionDigits: 1 }),
      imsi: leading.imsi,
      value: formatNumber(leading.usedOctets / BYTES_IN_GB, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    })
    : '';

  return (
    <section className="analytics-panel" aria-labelledby={titleId}>
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <Users size={18} color="var(--chart-3)" />
          <h2 id={titleId}>{t('dash_biz_top_title')}</h2>
        </div>
        <span className="analytics-panel-badge">{t('dash_biz_usage_window')}</span>
      </div>

      <div className="analytics-panel-body">
        {!hasData ? (
          <EmptyChartState
            icon={<Users size={42} />}
            title={t('dash_biz_usage_empty_title')}
            description={latestText
              ? t('dash_biz_usage_empty_latest', { time: latestText })
              : t('dash_biz_usage_empty_none')}
            action={(
              <Link to="/ocs/usage" className="btn btn-outline analytics-empty-button">
                {t('nav_ocs_usage')}
              </Link>
            )}
          />
        ) : (
          <>
            <ChartSummary id={summaryId}>{summary}</ChartSummary>
            <div
              className="analytics-chart-canvas"
              role="img"
              aria-labelledby={titleId}
              aria-describedby={summaryId}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="4 4" horizontal={false} stroke={CHART_GRID_COLOR} />
                  <XAxis
                    type="number"
                    stroke={CHART_TICK_COLOR}
                    tick={{ fill: CHART_TICK_COLOR, fontSize: 'var(--ref-font-size-caption)' }}
                    tickFormatter={(value: number) => formatNumber(value, { maximumFractionDigits: 1 })}
                  />
                  <YAxis
                    type="category"
                    dataKey="imsi"
                    width={132}
                    stroke={CHART_TICK_COLOR}
                    tick={{
                      fontSize: 'var(--ref-font-size-label)',
                      fill: CHART_TICK_COLOR,
                      fontFamily: 'monospace',
                      fontWeight: 600,
                    }}
                  />
                  <Tooltip cursor={{ fill: CHART_CURSOR_COLOR }} content={<TopUsageTooltip />} />
                  <Bar dataKey="gb" radius={[0, 6, 6, 0]} barSize={20}>
                    {chartData.map((entry, index) => (
                      <Cell key={`${entry.imsi}-${index}`} fill={CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="analytics-chart-footnote">{summary}</p>
          </>
        )}
      </div>

      {hasData ? (
        <ChartDataTable
          label={t('chart_data_table')}
          caption={t('dash_biz_top_title')}
          columns={[
            { key: 'imsi', label: t('chart_col_subscriber') },
            { key: 'usage', label: t('dash_biz_usage_series'), numeric: true },
            { key: 'share', label: t('dash_biz_top_share'), numeric: true },
          ]}
          rows={chartData.map((point) => ({
            key: point.imsi,
            cells: [
              <code key="imsi">{point.imsi}</code>,
              `${formatNumber(point.gb, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`,
              `${formatNumber(point.share, { maximumFractionDigits: 1 })}%`,
            ],
          }))}
        />
      ) : null}
    </section>
  );
}
