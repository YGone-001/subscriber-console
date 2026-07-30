"use client";

import React from "react";
import { GitBranch, Rocket, RotateCcw } from "lucide-react";
import { ChangeTask } from "./types";

export default function ChangeQueuePanel({ changeQueue, t }: { changeQueue: ChangeTask[]; t: (key: string, params?: Record<string, string | number>) => string; }) {
  return (
    <section className="analytics-change-queue">
      <div className="analytics-change-header">
        <div>
          <h3>
            <GitBranch size={18} />
            {t("dash_change_title")}
          </h3>
          <p>{t("dash_change_subtitle")}</p>
        </div>
        <span>{t("dash_change_count", { count: changeQueue.length })}</span>
      </div>
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
    </section>
  );
}
