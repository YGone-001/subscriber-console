/*
 * Tariff plan adoption and subscriber distribution.
 *
 * Plan shares come from the OCS contract population. The tooltip and legend use
 * explicit labels rather than English plural suffixes so both locales read
 * correctly for any count.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Layers, ArrowUpRight, Tag } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import EmptyChartState from './EmptyChartState';
import { ChartDataTable } from '../ui/ChartDataTable';
import { CHART_TOOLTIP_STYLE, ChartSummary, PLAN_CHART_COLORS } from '../ui/chartPrimitives';
import type { TariffPlanDistItem } from './types';

type PlanPayload = {
  planId: string;
  name: string;
  value: number;
  percentage: number;
  status: string;
};

function TariffPlanTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: PlanPayload }>;
}) {
  const { t, formatNumber } = useI18n();
  const plan = payload?.[0]?.payload;
  if (!active || !plan) return null;
  return (
    <div style={{ ...CHART_TOOLTIP_STYLE, padding: '0.65rem 0.8rem', minWidth: 180 }}>
      <div className="analytics-chart-tooltip-title">{plan.name}</div>
      <div className="analytics-chart-tooltip-row">
        <span>{t('chart_col_subscribers')}</span>
        <strong>{formatNumber(plan.value)}</strong>
      </div>
      <div className="analytics-chart-tooltip-row">
        <span>{t('chart_col_share')}</span>
        <strong>{formatNumber(plan.percentage, { maximumFractionDigits: 1 })}%</strong>
      </div>
    </div>
  );
}

function planStatusLabel(status: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'active') return t('dash_biz_plan_status_active');
  if (normalized === 'disabled' || normalized === 'inactive') return t('dash_biz_plan_status_disabled');
  return t('dash_biz_plan_status_other', { status: status || '—' });
}

export default function TariffPlanDistributionChart({
  tariffPlanDist = [],
}: {
  tariffPlanDist?: TariffPlanDistItem[];
}) {
  const { t, formatNumber } = useI18n();
  const titleId = React.useId();
  const summaryId = React.useId();
  const chartData = tariffPlanDist.map((plan) => ({
    name: plan.name || plan.planId,
    value: plan.subscriberCount,
    planId: plan.planId,
    percentage: plan.percentage,
    status: plan.status,
  }));

  const hasData = chartData.some((item) => item.value > 0);
  const totalSubscribers = chartData.reduce((sum, item) => sum + item.value, 0);
  const largestPlan = chartData.reduce<(typeof chartData)[number] | undefined>(
    (largest, item) => (!largest || item.value > largest.value ? item : largest),
    undefined,
  );
  const chartSummary = largestPlan
    ? t('dash_chart_tariff_plan_summary', {
      count: formatNumber(chartData.length),
      subscribers: formatNumber(totalSubscribers),
      name: largestPlan.name,
      percentage: formatNumber(largestPlan.percentage, { maximumFractionDigits: 1 }),
    })
    : '';

  return (
    <section className="analytics-panel" aria-labelledby={titleId}>
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <Layers size={18} color="var(--status-info)" />
          <h2 id={titleId}>{t('dash_chart_tariff_plan_title')}</h2>
        </div>
        <div className="analytics-ocs-header-actions">
          <span className="analytics-panel-badge">
            {t('dash_biz_tariff_plans_badge', { count: formatNumber(tariffPlanDist.length) })}
          </span>
          <Link to="/ocs/tariffs" className="analytics-ocs-link-btn">
            <span>{t('dash_ocs_view_plans')}</span>
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>

      <div className="analytics-panel-body analytics-plan-body">
        {hasData ? (
          <div className="analytics-plan-grid">
            <div className="analytics-plan-chart-container" role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
              <ChartSummary id={summaryId}>{chartSummary}</ChartSummary>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                    stroke="none"
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`${entry.planId}-${index}`} fill={PLAN_CHART_COLORS[index % PLAN_CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<TariffPlanTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="analytics-plan-legend-list">
              {tariffPlanDist.map((plan, index) => {
                const color = PLAN_CHART_COLORS[index % PLAN_CHART_COLORS.length];
                const status = (plan.status || '').trim().toLowerCase() || 'unknown';
                return (
                  <div key={`${plan.planId}-${index}`} className="analytics-plan-legend-row">
                    <div className="legend-row-left">
                      <span className="plan-color-dot" style={{ backgroundColor: color }} />
                      <div className="plan-info">
                        <span className="plan-name">{plan.name}</span>
                        <code className="plan-id-code">{plan.planId}</code>
                      </div>
                    </div>
                    <div className="legend-row-right">
                      <strong className="plan-sub-count">{formatNumber(plan.subscriberCount)}</strong>
                      <span className="plan-pct-badge">{formatNumber(plan.percentage, { maximumFractionDigits: 1 })}%</span>
                      <span className={`plan-status-chip plan-status-${status}`}>
                        {planStatusLabel(plan.status || '', t)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <EmptyChartState
            icon={<Tag size={42} />}
            title={t('dash_chart_tariff_plan_empty')}
            action={(
              <Link to="/ocs/tariffs" className="btn btn-outline analytics-empty-button">
                {t('dash_ocs_create_plan_hint')}
              </Link>
            )}
          />
        )}
      </div>

      {hasData ? (
        <ChartDataTable
          label={t('chart_data_table')}
          caption={t('dash_chart_tariff_plan_title')}
          columns={[
            { key: 'plan', label: t('chart_col_plan') },
            { key: 'subscribers', label: t('chart_col_subscribers'), numeric: true },
            { key: 'share', label: t('chart_col_share'), numeric: true },
          ]}
          rows={chartData.map((plan) => ({
            key: plan.planId,
            cells: [
              plan.name,
              formatNumber(plan.value),
              `${formatNumber(plan.percentage, { maximumFractionDigits: 1 })}%`,
            ],
          }))}
        />
      ) : null}
    </section>
  );
}
