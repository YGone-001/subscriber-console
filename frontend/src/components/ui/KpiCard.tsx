import type { ReactNode } from 'react';

export type KpiTone = 'neutral' | 'success' | 'warning' | 'danger';

export type KpiCardProps = {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: string;
  icon?: ReactNode;
  tone?: KpiTone;
};

/**
 * Restored KPI card. Values are supplied by the caller from current read
 * contracts; this component never fabricates data.
 */
export function KpiCard({ label, value, unit, hint, icon, tone = 'neutral' }: KpiCardProps) {
  const toneClass = tone === 'neutral' ? '' : ` accent-${tone}`;
  return (
    <article className={`kpi-card${toneClass}`}>
      <div className="kpi-card-head">
        <span>{label}</span>
        {icon ? <span className="kpi-card-icon" aria-hidden="true">{icon}</span> : null}
      </div>
      <div className="kpi-card-value">
        {value}
        {unit ? <span className="kpi-card-unit">{unit}</span> : null}
      </div>
      {hint ? <div className="kpi-card-foot">{hint}</div> : null}
    </article>
  );
}

export function KpiStrip({ children }: { children: ReactNode }) {
  return <div className="kpi-strip">{children}</div>;
}
