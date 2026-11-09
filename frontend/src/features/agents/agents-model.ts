import type { AgentMetrics, AgentMetadata, AgentObservation } from './agents-api';

export function percent(value: number | null | undefined): string | null {
  return value == null || !Number.isFinite(value) ? null : `${value.toFixed(1)}%`;
}
export function bytes(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}
export function usedPercent(total: number | null | undefined, available: number | null | undefined): string | null {
  if (total == null || available == null || total <= 0 || available < 0 || available > total) return null;
  return percent(100 * (total - available) / total);
}
export function metricCells(m?: AgentMetrics) {
  return {
    cpu: percent(m?.cpuPercent),
    memory: usedPercent(m?.memoryTotalBytes, m?.memoryAvailableBytes),
    disk: usedPercent(m?.diskTotalBytes, m?.diskAvailableBytes),
  };
}
export function metadataFromForm(form: FormData): AgentMetadata {
  const value = (key: string) => String(form.get(key) ?? '').trim();
  return {
    name: value('name'),
    scope: {
      networkKey: value('networkKey'),
      operatorName: value('operatorName'),
      siteResourceId: value('siteResourceId'),
      hostResourceId: value('hostResourceId'),
      plmns: value('plmns') ? value('plmns').split(/[\s,]+/) : [],
    },
  };
}
export function visibleComponentState(observation: AgentObservation, freshness: string, status: string): string {
  if (freshness !== 'fresh') return 'stale';
  if (!observation.scanComplete && status === 'stopped') return 'unknown';
  return status;
}
