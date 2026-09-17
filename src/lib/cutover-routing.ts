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
