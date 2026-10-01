import React from "react";

export default function SkeletonDashboard() {
  return (
    <div className="analytics-root">
      {/* KPI Strip skeleton — 6 columns */}
      <div className="kpi-strip">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="kpi-strip-item" key={index}>
            <div className="kpi-strip-head">
              <div className="skeleton-loader skeleton-icon-22" />
              <div className="skeleton-loader skeleton-line-60-10" />
            </div>
            <div className="skeleton-loader skeleton-line-70-20-mt4" />
            <div className="skeleton-loader skeleton-line-90-8-mt2" />
          </div>
        ))}
      </div>

      {/* Alerts row skeleton */}
      <div className="analytics-alerts-row">
        <div className="analytics-alerts-list">
          <div className="skeleton-loader skeleton-line-40-20" />
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="skeleton-loader skeleton-block-52" />
          ))}
        </div>
        <div className="analytics-alerts-score">
          <div className="skeleton-loader skeleton-circle-70" />
          <div className="skeleton-loader skeleton-line-80-18-mxa" />
        </div>
      </div>

      {/* OCS Resource Strip skeleton — 4 columns */}
      <div className="ocs-resource-strip">
        {Array.from({ length: 4 }).map((_, index) => (
          <div className="ocs-res-cell skeleton-static" key={index}>
            <div className="ocs-res-head">
              <div className="skeleton-loader skeleton-icon-22" />
              <div className="skeleton-loader skeleton-line-55-10" />
            </div>
            <div className="skeleton-loader skeleton-line-60-18-mt2" />
            <div className="skeleton-loader skeleton-line-100-4-mt4" />
            <div className="skeleton-loader skeleton-line-75-8-mt2" />
          </div>
        ))}
      </div>

      {/* Charts skeleton */}
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
    </div>
  );
}
