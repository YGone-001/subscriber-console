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
