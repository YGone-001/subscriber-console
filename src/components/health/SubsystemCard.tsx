"use client";

import React from "react";

export interface SubsystemMetric {
  label: string;
  value: React.ReactNode;
  tone?: "success" | "warning" | "danger";
}

export interface SubsystemCardProps {
  status: string;
  icon: React.ReactNode;
  name: string;
  description: string;
  statusBadge: React.ReactNode;
  metrics: SubsystemMetric[];
}

export default function SubsystemCard({
  status,
  icon,
  name,
  description,
  statusBadge,
  metrics,
}: SubsystemCardProps) {
  return (
    <div className={`subsystem-card ${status}`}>
      <div>
        <div className="subsystem-header">
          <div className="subsystem-title-box">
            <div className="subsystem-icon-wrap">
              {icon}
            </div>
            <div>
              <h3 className="subsystem-name">{name}</h3>
              <div className="subsystem-desc">{description}</div>
            </div>
          </div>
          {statusBadge}
        </div>

        <div className="subsystem-metrics-grid">
          {metrics.map((metric, i) => (
            <div key={i} className="subsystem-metric-item">
              <div className="subsystem-metric-label">{metric.label}</div>
              <div className={`subsystem-metric-val${metric.tone ? ` ${metric.tone}` : ""}`}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
