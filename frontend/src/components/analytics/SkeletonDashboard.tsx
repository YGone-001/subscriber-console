import React from "react";

export default function SkeletonDashboard() {
  return (
    <div className="analytics-root">
      {/* KPI Strip skeleton — 6 columns */}
      <div className="kpi-strip">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="kpi-strip-item" key={index}>
            <div className="kpi-strip-head">
              <div className="skeleton-loader" style={{ width: 22, height: 22, borderRadius: "var(--ref-radius-compact)" }} />
              <div className="skeleton-loader" style={{ width: "60%", height: 10, borderRadius: "var(--ref-radius-micro)" }} />
            </div>
            <div className="skeleton-loader" style={{ width: "70%", height: 20, borderRadius: "var(--ref-radius-micro)", marginTop: 4 }} />
            <div className="skeleton-loader" style={{ width: "90%", height: 8, borderRadius: "var(--ref-radius-micro)", marginTop: 2 }} />
          </div>
        ))}
      </div>

      {/* Alerts row skeleton */}
      <div className="analytics-alerts-row">
        <div className="analytics-alerts-list">
          <div className="skeleton-loader" style={{ width: "40%", height: "20px", borderRadius: "var(--ref-radius-compact)" }} />
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="skeleton-loader" style={{ height: "52px", borderRadius: "var(--ref-radius-control)" }} />
          ))}
        </div>
        <div className="analytics-alerts-score">
          <div className="skeleton-loader" style={{ width: "70px", height: "70px", borderRadius: "var(--ref-radius-circle)", margin: "0 auto" }} />
          <div className="skeleton-loader" style={{ width: "80%", height: "18px", borderRadius: "var(--ref-radius-micro)", margin: "0.5rem auto" }} />
        </div>
      </div>

      {/* OCS grid skeleton */}
      <div className="analytics-ocs-grid">
        <div className="analytics-panel">
          <div className="skeleton-loader analytics-skeleton-panel-title" />
          <div className="skeleton-loader analytics-skeleton-panel-body" />
        </div>
        <div className="analytics-panel">
          <div className="skeleton-loader analytics-skeleton-panel-title" />
          <div className="skeleton-loader analytics-skeleton-panel-body" />
        </div>
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
