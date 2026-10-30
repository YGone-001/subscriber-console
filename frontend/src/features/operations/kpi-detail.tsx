/*
 * Shared detail line for full-collection KPI cards.
 *
 * A KPI that the summary could not supply is stated as unavailable; it is never
 * rendered as zero and never replaced by a page-scoped count.
 */
import type { ReactNode } from 'react';

export function scopeKpiDetail(
  value: number | null,
  t: (key: string) => string,
): ReactNode {
  if (value === null) return t('ops_kpi_unavailable');
  return <span title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>;
}
