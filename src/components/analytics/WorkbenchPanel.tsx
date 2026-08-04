"use client";

import React, { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  ListChecks,
  Rocket,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { ChangeTask, WorkItem } from "./types";
import { normalizeRingValue } from "./utils";

function MiniRing({ value, color }: { value: number; color: string }) {
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
  changeQueue,
  operationsScore,
  activeAlertCount,
  t,
}: {
  visibleWorkItems: WorkItem[];
  changeQueue: ChangeTask[];
  operationsScore: number;
  activeAlertCount: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [activeSubTab, setActiveSubTab] = useState<"tasks" | "changes">("tasks");

  return (
    <section className="analytics-workbench">
      <div className="analytics-workbench-main">
        <div className="analytics-workbench-title">
          <div className="analytics-workbench-heading">
            <ListChecks size={19} color="var(--primary)" />
            <div>
              <h3>{t("dash_workbench_title")}</h3>
              <p>{t("dash_workbench_subtitle")}</p>
            </div>
          </div>

          <div className="analytics-subtabs-nav" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeSubTab === "tasks"}
              className={`analytics-subtab-btn ${activeSubTab === "tasks" ? "active" : ""}`}
              onClick={() => setActiveSubTab("tasks")}
            >
              <ListChecks size={14} />
              <span>{t("dash_workbench_tab_tasks")}</span>
              <span className="analytics-subtab-badge">{visibleWorkItems.length}</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeSubTab === "changes"}
              className={`analytics-subtab-btn ${activeSubTab === "changes" ? "active" : ""}`}
              onClick={() => setActiveSubTab("changes")}
            >
              <GitBranch size={14} />
              <span>{t("dash_workbench_tab_changes")}</span>
              <span className="analytics-subtab-badge">{changeQueue.length}</span>
            </button>
          </div>
        </div>

        {activeSubTab === "tasks" ? (
          <div className="analytics-workqueue">
            {visibleWorkItems.map((item) => (
              <a key={item.id} href={item.href} className={`analytics-workitem analytics-workitem-${item.tone}`}>
                <div className="analytics-workitem-icon">
                  {item.tone === "danger" ? <AlertTriangle size={17} /> : item.tone === "warning" ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
                </div>
                <div className="analytics-workitem-copy">
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
                <div className="analytics-workitem-action">
                  {item.action}
                  <ExternalLink size={13} />
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div className="analytics-change-grid">
            {changeQueue.map((task) => (
              <article className={`analytics-change-card analytics-change-${task.tone}`} key={task.id}>
                <div className="analytics-change-top">
                  <span className="analytics-change-id">{task.id}</span>
                  <span className="analytics-change-phase">{task.phase}</span>
                </div>
                <div className="analytics-change-title">{task.title}</div>
                <div className="analytics-change-scope">{task.scope}</div>
                <div className="analytics-change-meta">
                  <span>{task.owner}</span>
                  <span>{t("dash_change_canary", { percent: task.canary })}</span>
                </div>
                <div className="analytics-change-progress" aria-hidden="true">
                  <span style={{ width: `${task.canary}%` }} />
                </div>
                <div className="analytics-change-actions">
                  <a href={task.href}>
                    <Rocket size={13} />
                    {t("dash_change_open")}
                  </a>
                  <a href={task.rollbackHref}>
                    <RotateCcw size={13} />
                    {t("dash_change_rollback")}
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="analytics-readiness">
        <div className="analytics-readiness-score">
          <MiniRing value={operationsScore} color={operationsScore < 70 ? "#e74a3b" : operationsScore < 88 ? "#f6c23e" : "#1cc88a"} />
          <div>
            <span>{t("dash_ops_score")}</span>
            <strong>{Math.round(operationsScore)}</strong>
          </div>
        </div>
        <div className="analytics-readiness-list">
          <div>
            {activeAlertCount > 0 ? (
              <ShieldAlert size={15} color="var(--danger)" />
            ) : (
              <ShieldCheck size={15} color="var(--success)" />
            )}
            {t("dash_ops_alerts", { count: activeAlertCount })}
          </div>
        </div>
        <div className="analytics-quicklinks">
          <a href="/subscribers">{t("dash_quick_subscribers")}</a>
          <a href="/rating">{t("dash_quick_rating")}</a>
          <a href="/audit-logs">{t("dash_quick_audit")}</a>
        </div>
      </div>
    </section>
  );
}
