import React from "react";

export default function SkeletonDashboard() {
  return (
    <div className="analytics-root">
      <div className="analytics-kpi-grid">
        {Array.from({ length: 4 }).map((_, index) => (
          <div className="analytics-kpi-card analytics-skeleton-card" key={index}>
            <div className="skeleton-loader analytics-skeleton-icon" />
            <div className="skeleton-loader analytics-skeleton-label" />
            <div className="skeleton-loader analytics-skeleton-value" />
            <div className="skeleton-loader analytics-skeleton-line" />
            <div className="skeleton-loader analytics-skeleton-chart" />
          </div>
        ))}
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
      </div>
    </div>
  );
}
