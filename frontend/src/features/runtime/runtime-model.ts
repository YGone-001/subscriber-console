/*
 * Runtime discovery view model.
 *
 * Pure, dependency-free helpers so the presentation rules can be unit tested
 * without rendering. Integrity rules encoded here:
 *   - a component's status is never derived from a display filter;
 *   - an absent measurement is rendered as unavailable, never as zero;
 *   - a recognized-but-not-detected component is visually distinct from a
 *     verified running process;
 *   - grouping order is stable and category-driven.
 */
import type {
  RuntimeCategory,
  RuntimeComponent,
  RuntimeCounts,
  RuntimeStatus,
} from './runtime-types';

export const RUNTIME_CATEGORIES: RuntimeCategory[] = ['epc', '5gc', 'ims', 'charging', 'support'];

/** Statuses that represent accepted runtime evidence. */
const EVIDENCE_STATUSES: RuntimeStatus[] = ['running', 'stopped', 'unverified', 'stale'];

export type StatusFilter = '' | 'running' | 'stopped' | 'attention' | 'not_detected';

export function isEvidenceBacked(status: RuntimeStatus): boolean {
  return EVIDENCE_STATUSES.includes(status);
}

export function matchesTemplate(component: RuntimeComponent, template: string): boolean {
  if (!template || template === 'auto') return true;
  return component.templates.includes(template);
}

export function matchesStatus(component: RuntimeComponent, filter: StatusFilter): boolean {
  if (!filter) return true;
  switch (filter) {
    case 'running':
      return component.runtimeStatus === 'running';
    case 'stopped':
      return component.runtimeStatus === 'stopped';
    case 'attention':
      return ['unverified', 'permission_denied', 'unknown', 'stale'].includes(component.runtimeStatus);
    case 'not_detected':
      return component.runtimeStatus === 'not_detected' || component.runtimeStatus === 'not_configured';
    default:
      return true;
  }
}

export function matchesQuery(component: RuntimeComponent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    component.displayName,
    component.componentId,
    component.processName,
    component.domain,
    component.role,
    component.nfType ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

export type RuntimeFilter = {
  template: string;
  status: StatusFilter;
  query: string;
  category: '' | RuntimeCategory;
};

export function filterComponents(components: RuntimeComponent[], filter: RuntimeFilter): RuntimeComponent[] {
  return components.filter((component) => {
    if (!matchesTemplate(component, filter.template)) return false;
    if (!matchesStatus(component, filter.status)) return false;
    if (filter.category && component.category !== filter.category) return false;
    return matchesQuery(component, filter.query);
  });
}

export type RuntimeGroup = {
  category: RuntimeCategory;
  components: RuntimeComponent[];
  running: number;
  total: number;
};

export function groupByCategory(components: RuntimeComponent[]): RuntimeGroup[] {
  const groups: RuntimeGroup[] = [];
  for (const category of RUNTIME_CATEGORIES) {
    const members = components.filter((component) => component.category === category);
    if (members.length === 0) continue;
    groups.push({
      category,
      components: members,
      running: members.filter((component) => component.runtimeStatus === 'running').length,
      total: members.length,
    });
  }
  return groups;
}

export type RuntimeSummary = {
  total: number;
  running: number;
  stopped: number;
  attention: number;
  notDetected: number;
  expected: number;
  monitored: number;
  associated: number;
};

export function summarize(components: RuntimeComponent[]): RuntimeSummary {
  const summary: RuntimeSummary = {
    total: components.length,
    running: 0,
    stopped: 0,
    attention: 0,
    notDetected: 0,
    expected: 0,
    monitored: 0,
    associated: 0,
  };
  for (const component of components) {
    if (component.runtimeStatus === 'running') summary.running += 1;
    else if (component.runtimeStatus === 'stopped') summary.stopped += 1;
    else if (['unverified', 'permission_denied', 'unknown', 'stale'].includes(component.runtimeStatus)) summary.attention += 1;
    else summary.notDetected += 1;
    if (component.expectation === 'expected') summary.expected += 1;
    if (component.nfHealthAssociation.state === 'associated') summary.monitored += 1;
    if (component.inventoryAssociation.state === 'associated') summary.associated += 1;
  }
  return summary;
}

/** Snapshot counts come from the server; the client never recomputes totals. */
export function countsFromSnapshot(counts: RuntimeCounts): Array<{ key: string; value: number }> {
  return [
    { key: 'running', value: counts.running },
    { key: 'stopped', value: counts.stopped },
    { key: 'attention', value: counts.unverified + counts.permissionDenied + counts.unknown + counts.stale },
    { key: 'not_detected', value: counts.notDetected },
    { key: 'expected', value: counts.expected },
  ];
}

/** Formats a byte count. A missing measurement is rendered as unavailable. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[index]}`;
}

/** Formats a CPU percentage. A missing measurement is never rendered as zero. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

/**
 * Human-readable evidence label key. The value is a translation key so the
 * presentation layer stays localized; an unknown token is surfaced verbatim.
 */
export function statusLabelKey(status: RuntimeStatus): string {
  return `runtime_status_${status}`;
}

export function reasonLabelKey(reason: string): string {
  return reason ? `runtime_reason_${reason}` : 'runtime_reason_unknown';
}

/** Bootstrap action presentation. */
export function bootstrapActionLabelKey(action: string): string {
  return `runtime_action_${action}`;
}
