"use client";

import React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { WorkItem } from "./types";
import { normalizeRingValue } from "./utils";

function ScoreRing({ value, color }: { value: number; color: string }) {
  const safeValue = normalizeRingValue(value);

  return (
    <div
      className="analytics-ring"
      style={{
        background: `conic-gradient(${color} ${safeValue * 3.6}deg, var(--surface-border) 0deg)`,
      }}
      aria-hidden="true"
    >
      <div className="analytics-ring-inner">{Math.round(safeValue)}</div>
    </div>
  );
}

export default function WorkbenchPanel({
  visibleWorkItems,
  operationsScore,
  activeAlertCount,
  t,
}: {
  visibleWorkItems: WorkItem[];
  operationsScore: number;
  activeAlertCount: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const scoreColor =
    operationsScore < 70
      ? "var(--status-danger)"
      : operationsScore < 88
        ? "var(--status-warning)"
        : "var(--status-success)";

  return (
    <section className="analytics-alerts-row">
      {/* Left: Work Items */}
      <div className="analytics-alerts-list">
        <div className="analytics-alerts-header">
          <ListChecks size={16} color="var(--primary)" />
          <h3>{t("dash_workbench_title")}</h3>
          <span className="analytics-alerts-count">{visibleWorkItems.length}</span>
        </div>
        <div className="analytics-alerts-items">
          {visibleWorkItems.map((item) => (
            <a
              key={item.id}
              href={item.href}
              className={`analytics-workitem analytics-workitem-${item.tone}`}
            >
              <div className="analytics-workitem-icon">
                {item.tone === "danger" ? (
                  <AlertTriangle size={15} />
                ) : item.tone === "warning" ? (
                  <AlertCircle size={15} />
                ) : (
                  <CheckCircle2 size={15} />
                )}
              </div>
              <div className="analytics-workitem-copy">
                <div className="analytics-workitem-headline">
                  <strong>{item.title}</strong>
                  {item.tone === "danger" && (
                    <span className="analytics-semantic-badge badge-danger">
                      <span className="live-pulse-dot" />
                      {item.priority || "P0"}
                    </span>
                  )}
                  {item.tone === "warning" && (
                    <span className="analytics-semantic-badge badge-warning">
                      {item.priority || "P1"}
                    </span>
                  )}
                </div>
                <span>{item.detail}</span>
              </div>
              <div className="analytics-workitem-action">
                {item.action}
                <ExternalLink size={12} />
              </div>
            </a>
          ))}
        </div>
      </div>

      {/* Right: Score + Alert Summary */}
      <div className="analytics-alerts-score">
        <div className="analytics-readiness-score">
          <ScoreRing value={operationsScore} color={scoreColor} />
          <div>
            <span>{t("dash_ops_score")}</span>
            <strong style={{ color: scoreColor }}>{Math.round(operationsScore)}</strong>
          </div>
        </div>
        <div className="analytics-readiness-list">
          <div
            style={{
              color: activeAlertCount > 0 ? "var(--status-danger)" : "var(--text-secondary)",
              fontWeight: activeAlertCount > 0 ? 700 : 500,
            }}
          >
            {activeAlertCount > 0 ? (
              <ShieldAlert size={15} color="var(--status-danger)" />
            ) : (
              <ShieldCheck size={15} color="var(--status-success)" />
            )}
            {t("dash_ops_alerts", { count: activeAlertCount })}
          </div>
        </div>
      </div>
    </section>
  );
}
