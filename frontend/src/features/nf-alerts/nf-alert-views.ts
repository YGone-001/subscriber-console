/*
 * NF Alerts view contract: the three exclusive views and their read shape.
 *
 * The page no longer renders the duty queue, the resolved history and the rule
 * management at the same time. Each view owns one bounded list, one loading
 * state and one error boundary, and every view state lives in the URL.
 *
 * The scan order is server-defined: the open queue asks for the risk order, the
 * history asks for recency. Neither is a client-side sort over one page.
 */
import type { AlertListQueryParams } from './nf-alerts-types';

export const ALERT_VIEWS = ['open', 'history', 'rules'] as const;
export type AlertView = (typeof ALERT_VIEWS)[number];
export const DEFAULT_ALERT_VIEW: AlertView = 'open';

export const ALERT_URL_KEYS = ['severity', 'q', 'enabled'] as const;

export const ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type AlertSeverityFilter = (typeof ALERT_SEVERITIES)[number] | '';

export type AlertFilterSource = Record<string, string | undefined>;

export type AlertFilters = {
  severity: AlertSeverityFilter;
  q: string;
  enabled: string;
};

function pick(options: readonly string[], value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return options.includes(trimmed) ? trimmed : '';
}

/** Resolves the visible view, defaulting to the open duty queue. */
export function alertView(value: string | undefined): AlertView {
  return (pick(ALERT_VIEWS, value) || DEFAULT_ALERT_VIEW) as AlertView;
}

/** Reads the URL into the filter model; unknown values are dropped. */
export function readAlertFilters(source: AlertFilterSource): AlertFilters {
  return {
    severity: pick(ALERT_SEVERITIES, source.severity) as AlertSeverityFilter,
    q: (source.q ?? '').trim(),
    enabled: pick(['true', 'false'], source.enabled),
  };
}

/**
 * Which alert population a view reads.
 *
 * Rules is not an alert view: it reads a different collection, so it asks for
 * no alert scope at all.
 */
export function alertScope(view: AlertView): 'open' | 'history' | undefined {
  if (view === 'open') return 'open';
  if (view === 'history') return 'history';
  return undefined;
}

/** The server-defined ordering each view asks for. */
export function alertSort(view: AlertView): 'risk' | 'updated' {
  return view === 'open' ? 'risk' : 'updated';
}

/** Builds the bounded alert query for one view. */
export function alertListQuery(
  view: AlertView,
  filters: AlertFilters,
  cursor: string | undefined,
  limit: number,
): AlertListQueryParams {
  return {
    scope: alertScope(view),
    sort: alertSort(view),
    severity: view === 'rules' ? undefined : filters.severity || undefined,
    cursor,
    limit,
  };
}
