/**
 * Controlled Single-Writer Cutover Routing Table
 *
 * Maps METHOD + canonical PATH → authoritative owner.
 * Only the owner executes the mutation; the other backend is bypassed.
 *
 * Rollback: change owner from 'go' to 'node'.
 * No DB schema change, no data migration, no code history rewrite required.
 *
 * Canonical path uses Go-style {param} placeholders.
 * Incoming requests use actual values (e.g., /api/profiles/MyProfile/versions/abc/restore).
 */

export interface CutoverRoute {
  readonly method: string;
  /** Canonical path with {param} placeholders (Go mux style) */
  readonly path: string;
  /** Authoritative writer for this method+path */
  readonly owner: 'node' | 'go';
}

/**
 * Phase 4.4 pilot routes.
 *
 * ORDER MATTERS: Pilot A must be stable before Pilot B is enabled.
 * To rollback any route, change owner to 'node'.
 * To add routes, append — do not replace existing entries.
 */
export const CUTOVER_TABLE: readonly CutoverRoute[] = [
  // ── Pilot A: Profile Restore ──────────────────────────────────
  { method: 'POST', path: '/api/profiles/{name}/versions/{versionId}/restore', owner: 'go' },

  // ── Pilot B: Subscriber Profile Apply ─────────────────────────
  { method: 'POST', path: '/api/subscribers/{imsi}/profile', owner: 'go' },

  // ── Phase 4.5: Profile CRUD ──────────────────────────────────
  { method: 'POST', path: '/api/profiles', owner: 'go' },
  { method: 'PUT', path: '/api/profiles/{name}', owner: 'go' },
  { method: 'DELETE', path: '/api/profiles/{name}', owner: 'go' },

  // ── Phase 4.6: Subscriber CRUD ──────────────────────────────
  { method: 'POST', path: '/api/subscribers', owner: 'go' },
  { method: 'PUT', path: '/api/subscribers/{imsi}', owner: 'go' },
  { method: 'DELETE', path: '/api/subscribers/{imsi}', owner: 'go' },

  // ── Phase 4.7: Subscriber Batch ────────────────────────────
  { method: 'POST', path: '/api/subscribers/batch', owner: 'go' },
  { method: 'POST', path: '/api/subscribers/batch-update', owner: 'go' },
  { method: 'POST', path: '/api/subscribers/import', owner: 'go' },
  { method: 'POST', path: '/api/subscribers/bulk-delete', owner: 'go' },

  // ── Tariff Plan Governance ─────────────────────────────────
  { method: 'POST', path: '/api/tariff-plans', owner: 'go' },
  { method: 'PUT', path: '/api/tariff-plans/{planId}', owner: 'go' },
  { method: 'DELETE', path: '/api/tariff-plans/{planId}', owner: 'go' },
  { method: 'POST', path: '/api/tariff-plans/{planId}/clone', owner: 'go' },
  { method: 'POST', path: '/api/tariff-plans/{planId}/enable', owner: 'go' },
  { method: 'POST', path: '/api/tariff-plans/{planId}/disable', owner: 'go' },

  // ── OCS Subscriber Contract Governance ──────────────────────
  { method: 'GET', path: '/api/ocs/subscribers', owner: 'go' },
  { method: 'POST', path: '/api/ocs/subscribers', owner: 'go' },
  { method: 'POST', path: '/api/ocs/subscribers/{imsi}/suspend', owner: 'go' },
  { method: 'POST', path: '/api/ocs/subscribers/{imsi}/resume', owner: 'go' },
  { method: 'PATCH', path: '/api/ocs/subscribers/{imsi}', owner: 'go' },
  { method: 'DELETE', path: '/api/ocs/subscribers/{imsi}', owner: 'go' },

  // ── OCS Balance Governance ──────────────────────────────────
  { method: 'POST', path: '/api/ocs/balances/{imsi}/adjust', owner: 'go' },
  { method: 'POST', path: '/api/ocs/balances/{imsi}/reset', owner: 'go' },

  // ── User Management ──────────────────────────────────────────
  { method: 'GET', path: '/api/users', owner: 'go' },
  { method: 'POST', path: '/api/users', owner: 'go' },
  { method: 'GET', path: '/api/users/{username}', owner: 'go' },
  { method: 'PATCH', path: '/api/users/{username}', owner: 'go' },
  { method: 'POST', path: '/api/users/{username}/disable', owner: 'go' },
  { method: 'POST', path: '/api/users/{username}/password-reset', owner: 'go' },

  // ── Authentication (Phase 6.3-B) ─────────────────────────────
  { method: 'POST', path: '/api/auth/login', owner: 'go' },
  { method: 'POST', path: '/api/auth/logout', owner: 'go' },
  { method: 'GET', path: '/api/auth/me', owner: 'go' },
  { method: 'GET', path: '/api/auth/permissions', owner: 'go' },

  // -- Phase 7.5: Platform Services production ownership ----------
  // Alert domain
  { method: 'GET', path: '/api/alerts', owner: 'go' },
  { method: 'POST', path: '/api/alerts/acknowledge', owner: 'go' },
  { method: 'POST', path: '/api/alerts/workflow', owner: 'go' },
  // Notification streaming
  { method: 'GET', path: '/api/notifications/stream', owner: 'go' },
  // Platform / system health
  { method: 'GET', path: '/api/system/health', owner: 'go' },
  { method: 'GET', path: '/api/system/mongo/health', owner: 'go' },
  // System integrity
  { method: 'GET', path: '/api/system/audit/status', owner: 'go' },
  { method: 'POST', path: '/api/system/audit/scan', owner: 'go' },
  { method: 'POST', path: '/api/system/audit/heal', owner: 'go' },
  { method: 'POST', path: '/api/system/audit/batch-heal', owner: 'go' },
  // Analytics
  { method: 'POST', path: '/api/analytics/init', owner: 'go' },

  // -- Phase 8.2: Canonical residual production cutover -----------
  // 33 frozen canonical residual operations (Go shadows since Phase 8.1).
  // Analytics
  { method: 'GET', path: '/api/analytics/metrics', owner: 'go' },
  { method: 'GET', path: '/api/analytics/sparkline', owner: 'go' },
  // OCS management read surfaces (charging plane stays frozen)
  { method: 'GET', path: '/api/ocs/balances', owner: 'go' },
  { method: 'GET', path: '/api/ocs/reservations', owner: 'go' },
  { method: 'GET', path: '/api/ocs/sessions', owner: 'go' },
  { method: 'GET', path: '/api/ocs/usage', owner: 'go' },
  // Profiles
  { method: 'GET', path: '/api/profiles', owner: 'go' },
  { method: 'GET', path: '/api/profiles/{name}', owner: 'go' },
  { method: 'GET', path: '/api/profiles/{name}/stats', owner: 'go' },
  { method: 'GET', path: '/api/profiles/{name}/versions', owner: 'go' },
  // Ratings
  { method: 'GET', path: '/api/ratings', owner: 'go' },
  { method: 'POST', path: '/api/ratings', owner: 'go' },
  { method: 'GET', path: '/api/ratings/{id}', owner: 'go' },
  { method: 'PUT', path: '/api/ratings/{id}', owner: 'go' },
  { method: 'DELETE', path: '/api/ratings/{id}', owner: 'go' },
  // Search / subscribers
  { method: 'GET', path: '/api/search', owner: 'go' },
  { method: 'GET', path: '/api/subscribers', owner: 'go' },
  { method: 'GET', path: '/api/subscribers/{imsi}', owner: 'go' },
  { method: 'POST', path: '/api/subscribers/batch/precheck', owner: 'go' },
  { method: 'POST', path: '/api/subscribers/policy', owner: 'go' },
  { method: 'POST', path: '/api/subscribers/{imsi}/traffic-adjustments', owner: 'go' },
  // Tariff plans
  { method: 'GET', path: '/api/tariff-plans', owner: 'go' },
  { method: 'GET', path: '/api/tariff-plans/{planId}', owner: 'go' },
  { method: 'GET', path: '/api/tariff-plans/{planId}/export', owner: 'go' },
  { method: 'GET', path: '/api/tariff-plans/{planId}/migrate', owner: 'go' },
  { method: 'POST', path: '/api/tariff-plans/{planId}/migrate', owner: 'go' },
  { method: 'GET', path: '/api/tariff-plans/{planId}/rules', owner: 'go' },
  { method: 'POST', path: '/api/tariff-plans/{planId}/rules', owner: 'go' },
  { method: 'PUT', path: '/api/tariff-plans/{planId}/rules/{ruleId}', owner: 'go' },
  { method: 'PATCH', path: '/api/tariff-plans/{planId}/rules/{ruleId}', owner: 'go' },
  { method: 'DELETE', path: '/api/tariff-plans/{planId}/rules/{ruleId}', owner: 'go' },
  { method: 'GET', path: '/api/tariff-plans/{planId}/subscribers', owner: 'go' },
  { method: 'POST', path: '/api/tariff-plans/import', owner: 'go' },

  // -- Phase 8.2: Legacy read compatibility aliases ---------------
  // Read-only compatibility surfaces; MUTATION methods stay retired.
  { method: 'GET', path: '/api/auth/users', owner: 'go' },
  { method: 'GET', path: '/api/auth/users/{username}', owner: 'go' },

  // -- Phase 8.2: Go-native unrouted read residue resolution ------
  // Tariff operations read: frontend caller exists (rating console).
  { method: 'GET', path: '/api/tariff-plans/{planId}/operations', owner: 'go' },
  // OCS balance detail read: kept as a public Go API (no Node counterpart).
  { method: 'GET', path: '/api/ocs/balances/{imsi}', owner: 'go' },
] as const;

/**
 * Convert a canonical Go-style path pattern to a regex.
 * Replaces {param} with a named capture group [^/]+.
 * Returns null if the pattern is invalid.
 */
function patternToRegex(pattern: string): RegExp | null {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withParams = escaped.replace(/\\{(\w+)\\}/g, '[^/]+');
  try {
    return new RegExp(`^${withParams}$`);
  } catch {
    return null;
  }
}

/**
 * Match an incoming request against the cutover table.
 * Returns the owner ('node' | 'go') or 'node' if no match.
 *
 * Matching is done by HTTP method + path pattern.
 * The table is scanned top-to-bottom; first match wins.
 */
export function resolveRouteOwner(method: string, pathname: string): 'node' | 'go' {
  for (const route of CUTOVER_TABLE) {
    if (route.method !== method) continue;
    const regex = patternToRegex(route.path);
    if (regex && regex.test(pathname)) {
      return route.owner;
    }
  }
  return 'node';
}
