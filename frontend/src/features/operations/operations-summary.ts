import { getJson } from '../../lib/api/read-client';

// Types mirroring backend/internal/operationsview/model.go. The JSON field
// names are the contract: verify against model.go before changing them.

export type SummarySectionName = 'inventory' | 'discovery' | 'health' | 'alerts' | 'topology';

export type SummaryCompleteness = 'complete' | 'unavailable';

export const SUMMARY_SCOPE_FULL_COLLECTION = 'full_collection';

export interface InventorySectionCounts {
  total: number;
  byKind: Record<string, number>;
  byLifecycleState: Record<string, number>;
  byDomain: Record<string, number>;
}

export interface DiscoveryCandidateSummary {
  seen: number;
  missing: number;
  stale: number;
  linked: number;
  unlinked: number;
}

export interface HealthTargetStateSummary {
  configured: number;
  enabled: number;
  failed: number;
  freshnessByState: Record<string, number>;
  overallByState: Record<string, number>;
  layersByState: Record<string, Record<string, number>>;
}

export interface NfAlertSummary {
  totalRules: number;
  enabledRules: number;
  alertsByState: Record<string, number>;
  openBySeverity: Record<string, number>;
}

export interface InventorySummarySection {
  completeness: SummaryCompleteness;
  scope: string;
  error?: string;
  counts?: InventorySectionCounts;
}

export interface DiscoverySummarySection {
  completeness: SummaryCompleteness;
  scope: string;
  error?: string;
  sources?: number;
  candidates?: DiscoveryCandidateSummary;
}

export interface HealthSummarySection {
  completeness: SummaryCompleteness;
  scope: string;
  error?: string;
  targets?: HealthTargetStateSummary;
}

export interface AlertsSummarySection {
  completeness: SummaryCompleteness;
  scope: string;
  error?: string;
  alerts?: NfAlertSummary;
}

export interface OperationsSummaryResponse {
  generatedAt: string;
  sections: string[];
  inventory?: InventorySummarySection;
  discovery?: DiscoverySummarySection;
  health?: HealthSummarySection;
  alerts?: AlertsSummarySection;
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    searchParams.set(key, value);
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

// fetchOperationsSummary reads the platform-wide section statistics. Sections
// not requested are neither queried nor returned by the backend.
export async function fetchOperationsSummary(
  sections: SummarySectionName[],
): Promise<OperationsSummaryResponse> {
  return getJson<OperationsSummaryResponse>(
    withQuery('/api/operations/summary', {
      sections: sections.length > 0 ? sections.join(',') : undefined,
    }),
  );
}

// KPI projections below are pure functions so tests can assert that page KPIs
// come from the summary section (full collection) instead of the current page
// array (see docs/analysis/cnms-port-assessment-2026-10-18.md UX-0).

export interface DiscoveryKpis {
  sources: number | null;
  seen: number | null;
  missing: number | null;
  linked: number | null;
}

// discoveryKpisFromSummary returns null-valued KPIs when the section is
// unavailable so the UI can render an explicit unavailable label instead of
// silently counting the current page.
export function discoveryKpisFromSummary(
  section: DiscoverySummarySection | undefined,
): DiscoveryKpis {
  if (!section || section.completeness !== 'complete') {
    return { sources: null, seen: null, missing: null, linked: null };
  }
  const candidates = section.candidates;
  return {
    sources: typeof section.sources === 'number' ? section.sources : null,
    seen: candidates ? candidates.seen : null,
    missing: candidates ? candidates.missing : null,
    linked: candidates ? candidates.linked : null,
  };
}

export interface HealthKpis {
  configured: number | null;
  fresh: number | null;
  failed: number | null;
  staleUnknown: number | null;
}

// healthKpisFromSummary keeps the page KPI semantics (configured / fresh /
// failed / stale-or-unknown) but sourced from the full target population.
// staleUnknown covers freshness states other than fresh for targets that have
// not failed their latest collection attempt.
export function healthKpisFromSummary(
  section: HealthSummarySection | undefined,
): HealthKpis {
  if (!section || section.completeness !== 'complete' || !section.targets) {
    return { configured: null, fresh: null, failed: null, staleUnknown: null };
  }
  const targets = section.targets;
  const fresh = targets.freshnessByState?.fresh ?? 0;
  const failed = targets.failed ?? 0;
  const staleUnknown = Math.max(targets.configured - fresh - failed, 0);
  return {
    configured: targets.configured,
    fresh,
    failed,
    staleUnknown,
  };
}

export interface AlertsKpis {
  rules: number | null;
  active: number | null;
  acknowledged: number | null;
  criticalOpen: number | null;
}

// alertsKpisFromSummary sources the alert queue KPIs from the full alert
// population. criticalOpen counts open (active + acknowledged) critical
// alerts, matching the backend openBySeverity projection.
export function alertsKpisFromSummary(
  section: AlertsSummarySection | undefined,
): AlertsKpis {
  if (!section || section.completeness !== 'complete' || !section.alerts) {
    return { rules: null, active: null, acknowledged: null, criticalOpen: null };
  }
  const alerts = section.alerts;
  return {
    rules: alerts.totalRules,
    active: alerts.alertsByState?.active ?? 0,
    acknowledged: alerts.alertsByState?.acknowledged ?? 0,
    criticalOpen: alerts.openBySeverity?.critical ?? 0,
  };
}

// isSectionComplete reports whether a section may be presented as a complete
// platform-wide count. Unknown sections are never complete.
export function isSectionComplete(
  completeness: SummaryCompleteness | undefined,
): boolean {
  return completeness === 'complete';
}
