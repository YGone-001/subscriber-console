import React from "react";

export default function SkeletonDashboard() {
  return (
    <div className="analytics-root">
      <div className="analytics-workbench">
        <div className="analytics-workbench-main">
          <div className="skeleton-loader" style={{ width: "40%", height: "24px", borderRadius: "6px" }} />
          <div className="analytics-workqueue">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="skeleton-loader" style={{ height: "64px", borderRadius: "8px" }} />
            ))}
          </div>
        </div>
        <div className="analytics-readiness">
          <div className="skeleton-loader" style={{ width: "70px", height: "70px", borderRadius: "50%", margin: "0 auto" }} />
          <div className="skeleton-loader" style={{ width: "80%", height: "18px", borderRadius: "4px", margin: "0.5rem auto" }} />
          <div className="skeleton-loader" style={{ width: "100%", height: "32px", borderRadius: "6px" }} />
        </div>
      </div>

      <div className="analytics-kpi-grid">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="analytics-kpi-card analytics-skeleton-card" key={index}>
            <div className="analytics-kpi-top">
              <div className="analytics-kpi-meta">
                <div className="skeleton-loader analytics-skeleton-icon" />
                <div className="skeleton-loader analytics-skeleton-label" />
              </div>
              <div className="skeleton-loader analytics-skeleton-spark" />
            </div>
            <div className="analytics-kpi-body">
              <div className="skeleton-loader analytics-skeleton-value" />
              <div className="skeleton-loader analytics-skeleton-line" />
            </div>
          </div>
        ))}
      </div>

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

      <div className="analytics-chart-grid">
        <div className="analytics-panel">
          <div className="skeleton-loader analytics-skeleton-panel-title" />
          <div className="skeleton-loader analytics-skeleton-panel-body" />
        </div>
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
