"use client";

import React from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, ExternalLink, Globe, ListChecks, ShieldCheck, Users, Zap } from "lucide-react";
import { WorkItem } from "./types";
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
  operationsScore,
  activeAlertCount,
  subscriberCount,
  plmnCount,
  topImsi,
  t,
}: {
  visibleWorkItems: WorkItem[];
  operationsScore: number;
  activeAlertCount: number;
  subscriberCount: number;
  plmnCount: number;
  topImsi: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <section className="analytics-workbench">
      <div className="analytics-workbench-main">
        <div className="analytics-workbench-title">
          <ListChecks size={19} color="var(--primary)" />
          <div>
            <h3>{t("dash_workbench_title")}</h3>
            <p>{t("dash_workbench_subtitle")}</p>
          </div>
        </div>

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
          <div><ShieldCheck size={15} /> {t("dash_ops_alerts", { count: activeAlertCount })}</div>
          <div><Users size={15} /> {t("dash_ops_subscribers", { count: subscriberCount })}</div>
          <div><Globe size={15} /> {t("dash_ops_plmn", { count: plmnCount })}</div>
          <div><Zap size={15} /> {t("dash_ops_top_imsi", { imsi: topImsi })}</div>
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
