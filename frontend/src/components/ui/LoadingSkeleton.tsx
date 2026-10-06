/** Skeleton placeholders. They never contain fabricated content. */
import { useI18n } from '../../providers/I18nProvider';

export function SkeletonLine({ width }: { width?: string }) {
  return <div className="skeleton skeleton-line" style={width ? { width } : undefined} />;
}

export function SkeletonKpiStrip({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton-kpi-strip" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton-kpi" />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 2, height = 260 }: { count?: number; height?: number }) {
  return (
    <div className="card-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton-table" aria-hidden="true">
      <div className="skeleton skeleton-line-sm" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton skeleton-table-row" />
      ))}
    </div>
  );
}

export function SkeletonPage({ kpis = 4, cards = 2, rows = 6 }: { kpis?: number; cards?: number; rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="skeleton-page" role="status" aria-live="polite">
      <span className="sr-only">{t('loading')}</span>
      <div className="skeleton skeleton-page-header" />
      <SkeletonKpiStrip count={kpis} />
      <SkeletonCards count={cards} />
      <div className="skeleton skeleton-card">
        <SkeletonTable rows={rows} />
      </div>
    </div>
  );
}
