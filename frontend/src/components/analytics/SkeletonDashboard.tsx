/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/analytics/SkeletonDashboard.tsx
 * Adaptations: "use client" and the local analytics.css import dropped (the layer
 * is imported from app.css); Next.js Link replaced by react-router Link; @/ path
 * aliases rewritten to relative paths.
 */
import { useI18n } from '../../providers/I18nProvider';
import MetricStrip from '../ui/MetricStrip';

export default function SkeletonDashboard() {
  const { t } = useI18n();
  return (
    <div className="analytics-root">
      <MetricStrip
        variant="strip"
        ariaLabel={t('dash_biz_kpi_aria')}
        items={Array.from({ length: 6 }).map((_, index) => ({
          key: `kpi-skeleton-${index}`,
          label: <span className="skeleton-loader skeleton-line-60-10" />,
          value: <span className="skeleton-loader skeleton-line-70-20-mt4" />,
          detail: <span className="skeleton-loader skeleton-line-90-8-mt2" />,
          icon: <span className="skeleton-loader skeleton-icon-22" />,
        }))}
      />

      <section className="analytics-panel analytics-risk-panel">
        <div className="skeleton-loader analytics-skeleton-panel-title" />
        <div className="analytics-skeleton-stack">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="skeleton-loader skeleton-block-52" />
          ))}
        </div>
      </section>

      <div className="analytics-chart-grid">
        <div className="analytics-panel">
          <div className="skeleton-loader analytics-skeleton-panel-title" />
          <div className="skeleton-loader analytics-skeleton-panel-body" />
        </div>
        <div className="analytics-panel">
          <div className="skeleton-loader analytics-skeleton-panel-title" />
          <div className="skeleton-loader analytics-skeleton-panel-body" />
        </div>
      </div>

      <section className="analytics-panel analytics-ocs-health">
        <div className="skeleton-loader analytics-skeleton-panel-title" />
        <div className="analytics-ocs-pools">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="analytics-ocs-pool">
              <div className="skeleton-loader skeleton-line-55-10" />
              <div className="skeleton-loader skeleton-line-70-20-mt4" />
              <div className="skeleton-loader skeleton-line-100-4-mt4" />
              <div className="skeleton-loader skeleton-line-75-8-mt2" />
            </div>
          ))}
        </div>
      </section>

      <section className="analytics-panel">
        <div className="skeleton-loader analytics-skeleton-panel-title" />
        <div className="skeleton-loader analytics-skeleton-panel-body" />
      </section>
    </div>
  );
}