/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/analytics/EmptyChartState.tsx
 * Adaptations: "use client" and the local analytics.css import dropped (the layer
 * is imported from app.css); Next.js Link replaced by react-router Link; @/ path
 * aliases rewritten to relative paths.
 */
import React from "react";

export default function EmptyChartState({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }) {
  return (
    <div className="analytics-empty-state">
      <div className="analytics-empty-visual">{icon}</div>
      <div className="analytics-empty-title">{title}</div>
      {action ? <div className="analytics-empty-action">{action}</div> : null}
    </div>
  );
}
