/*
 * UI parity scope - THE single definition of what the coverage metric measures.
 *
 * Two scripts score coverage and they must never disagree:
 *   - `scripts/test-ui-parity-contract.mjs`  (the gate)
 *   - `scripts/analyse-parity-ceiling.mjs`   (the diagnostic)
 * Both import this module. The manifest generator imports it too, and asserts that
 * its own `exclude` dispositions match this list exactly, so the three cannot drift.
 *
 * ---------------------------------------------------------------------------
 * THE METRIC
 *
 * `reachable_coverage` is the declared acceptance metric:
 *
 *     reachable_vocabulary = class tokens used by reference files NOT excluded here
 *     missing_reachable    = of those, the ones the current checkout does not use
 *     reachable_coverage   = (reachable_vocabulary - missing_reachable) / reachable_vocabulary
 *
 * The absolute metric over the whole historical vocabulary is reported for diagnosis
 * only. It can never reach 100% because the excluded files below are intentionally not
 * ported, so it must not decide pass or fail.
 *
 * ---------------------------------------------------------------------------
 * RULES FOR EDITING THIS FILE
 *
 * 1. Paths are exact repository-relative paths or path prefixes. Fuzzy substring
 *    matching is forbidden: it silently swallows files nobody reviewed.
 * 2. Every entry carries one of the four reasons below. There is no fifth reason.
 * 3. Adding or removing an entry changes SCOPE_REVISION, and the gate fails until a
 *    human updates SCOPE_REVISION together with SCOPE_REVIEW. Widening the scope to
 *    raise coverage is therefore impossible without a deliberate, reviewable edit.
 * 4. A class may never be added to the current checkout purely to move the metric:
 *    no unreachable DOM, no hidden-only elements, no unused class names. The gate
 *    checks that every counted class comes from a source file reachable from the app
 *    entry point.
 */

/** The only permitted reasons for excluding a reference file. */
export const EXCLUSION_REASONS = Object.freeze({
  /** The historical surface was deliberately retired by the brief. */
  RETIRED: 'retired',
  /** Charging-plane rating console; outside the operator console boundary. */
  CHARGING_PLANE: 'charging-plane',
  /** The current checkout already owns this runtime concern; nothing is copied. */
  CURRENT_RUNTIME_REPLACED: 'current-runtime-replaced',
  /** The referenced operation has no authoritative contract here and is denied. */
  UNSUPPORTED_CONTRACT: 'unsupported-contract',
});

const { RETIRED, CHARGING_PLANE, CURRENT_RUNTIME_REPLACED, UNSUPPORTED_CONTRACT } = EXCLUSION_REASONS;

/*
 * Paths are relative to `frontend/src` in the reference checkout. An entry is either
 * an exact file path or a directory prefix ending in `/`.
 */
export const EXCLUSIONS = Object.freeze([
  /* ---- retired surfaces --------------------------------------------------- */
  { path: 'components/DataHub.tsx', reason: RETIRED, note: 'Retired data hub surface; the current console has no data-hub entry point.' },
  { path: 'components/SubscriberTraceModal.tsx', reason: RETIRED, note: 'Retired signalling trace surface.' },
  { path: 'components/VisualDiffViewer.tsx', reason: RETIRED, note: 'Retired visual diff surface; the profile version panel keeps only the restore action.' },
  { path: 'components/governance/', reason: RETIRED, note: 'Retired governance console components.' },
  { path: 'lib/diffEngine.ts', reason: RETIRED, note: 'Engine behind the retired diff viewer.' },
  { path: 'lib/governance/', reason: RETIRED, note: 'Retired governance display helpers; the equivalent formatter is inlined where needed.' },
  { path: 'lib/soundEffects.ts', reason: RETIRED, note: 'Historical notification sound engine; the sound preference is now presentation-local.' },

  /* ---- charging plane ----------------------------------------------------- */
  { path: 'components/rating/', reason: CHARGING_PLANE, note: 'Rating console component set, including its hooks, types and stylesheet.' },
  { path: 'components/RatingManagementPage.tsx', reason: CHARGING_PLANE, note: 'Rating console entry component.' },

  /* ---- current runtime owns this ------------------------------------------ */
  { path: 'components/I18nProvider.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'The current providers/I18nProvider owns locale state and the dictionary.' },
  { path: 'components/ThemeProvider.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'The current providers/ThemeProvider owns theme state.' },
  { path: 'components/SWRProvider.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'The current read client owns caching.' },
  { path: 'components/NotificationProvider.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'The current providers/NotificationProvider owns the notification stream.' },
  { path: 'components/GlobalErrorBoundary.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'The current App shell owns error boundaries.' },
  { path: 'components/ToastContainer.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'The current shell owns transient notices.' },
  { path: 'components/ocs/OcsBalancesPanel.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'Superseded: the /ocs/balances route renders OcsBalancePlaceholder.' },
  { path: 'components/ocs/OcsSessionsPanel.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'No OCS sessions route exists in the current console.' },
  { path: 'components/ocs/OcsTariffsPanel.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'Superseded: the /ocs/tariffs route renders OcsTariffGovernancePanel.' },
  { path: 'components/ocs/OcsUsagePanel.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'No OCS usage route exists in the current console.' },
  { path: 'components/ocs/OcsSubscribersPanel.tsx', reason: CURRENT_RUNTIME_REPLACED, note: 'Superseded by the contract panel the /ocs/contracts route renders.' },
  { path: 'proxy.ts', reason: CURRENT_RUNTIME_REPLACED, note: 'Historical Node API proxy; the Go service owns the production API surface.' },
  { path: 'hooks/useAuth.ts', reason: CURRENT_RUNTIME_REPLACED, note: 'The current providers/AuthProvider owns session authority.' },
  { path: 'hooks/usePermissions.ts', reason: CURRENT_RUNTIME_REPLACED, note: 'The current lib/permissions owns capability decisions.' },
  { path: 'lib/api/', reason: CURRENT_RUNTIME_REPLACED, note: 'The current read and mutation clients own the API boundary.' },
  { path: 'lib/navigationPrefetch.ts', reason: CURRENT_RUNTIME_REPLACED, note: 'Prefetching is owned by the current router.' },
  { path: 'lib/navigationRoutes.ts', reason: CURRENT_RUNTIME_REPLACED, note: 'The current lib/navigation owns the route table and sidebar authority.' },

  /* ---- no authoritative contract ----------------------------------------- */
  { path: 'components/BulkPolicyModal.tsx', reason: UNSUPPORTED_CONTRACT, note: 'Its mutation is on the project absolute denylist, so the surface must not be ported.' },
]);

/*
 * ---------------------------------------------------------------------------
 * HISTORICAL ENTRY POINTS
 *
 * The denominator of the coverage metric is the class vocabulary reachable from the
 * historical application's OWN entry points, walked through its OWN import graph.
 * This is what makes the measurement symmetric with the current side.
 *
 * Only routes that still have a comparable route in the current console are entries.
 * Redirect-only pages are NOT entries: the historical application never rendered them
 * either, so anything reachable only through them is an orphan inside the historical
 * graph and must fall out of the denominator on its own - it is not a hand-written
 * exclusion.
 *
 * Adding or removing an entry here is a scope change: update SCOPE_REVIEW with it.
 */
export const HISTORICAL_ENTRY_POINTS = Object.freeze([
  { route: 'login', path: 'app/login/page.tsx' },
  { route: 'dashboard-shell', path: 'app/(dashboard)/layout.tsx' },
  { route: 'dashboard', path: 'app/(dashboard)/page.tsx' },
  { route: 'subscribers', path: 'app/(dashboard)/subscribers/page.tsx' },
  { route: 'profile', path: 'app/(dashboard)/profile/page.tsx' },
  { route: 'ocs-tariffs', path: 'app/(dashboard)/ocs/tariffs/page.tsx' },
  { route: 'ocs-tariff-detail', path: 'app/(dashboard)/ocs/tariffs/[planId]/page.tsx' },
  { route: 'ocs-contracts', path: 'app/(dashboard)/ocs/contracts/page.tsx' },
  { route: 'ocs-contract-detail', path: 'app/(dashboard)/ocs/contracts/[imsi]/page.tsx' },
  { route: 'ocs-balances', path: 'app/(dashboard)/ocs/balances/page.tsx' },
  { route: 'ocs-balance-detail', path: 'app/(dashboard)/ocs/balances/[imsi]/page.tsx' },
  { route: 'users', path: 'app/(dashboard)/users/page.tsx' },
  { route: 'user-create', path: 'app/(dashboard)/users/create/page.tsx' },
  { route: 'user-detail', path: 'app/(dashboard)/users/[username]/page.tsx' },
  { route: 'system-health', path: 'app/(dashboard)/system-health/page.tsx' },
]);

/*
 * Historical pages that only redirect. Recorded explicitly so the decision is
 * reviewable, and so a reader can see they were considered rather than forgotten.
 * They are NOT entries; nothing is subtracted for them beyond that.
 */
export const REDIRECT_ONLY_ROUTES = Object.freeze([
  'app/(dashboard)/ocs/page.tsx',
  'app/(dashboard)/ocs/dashboard/page.tsx',
  'app/(dashboard)/ocs/sessions/page.tsx',
  'app/(dashboard)/ocs/subscribers/page.tsx',
  'app/(dashboard)/ocs/usage/page.tsx',
  'app/(dashboard)/roles/page.tsx',
  'app/(dashboard)/rating/page.tsx',
  'app/(dashboard)/rating/plans/page.tsx',
  'app/(dashboard)/rating/rules/page.tsx',
]);

/** Current-side entry points. */
export const CURRENT_ENTRY_POINTS = Object.freeze([
  'frontend/src/main.tsx',
  'frontend/src/app/App.tsx',
  'frontend/src/router/router.tsx',
]);

/*
 * ---------------------------------------------------------------------------
 * TOKEN-SCOPED CONTRACT EXCLUSIONS
 *
 * A class token that the historical application could render but the CURRENT contract
 * cannot supply must not be added as dead code to raise coverage. It is excluded
 * precisely - one file, one token - with a reason, and the exclusion is part of the
 * scope digest so it cannot be widened silently.
 *
 * There is no global token exclusion. Each excluded token is bound to exactly one
 * historical source file; the same word appearing anywhere else still counts.
 */
export const TOKEN_EXCLUSIONS = Object.freeze([
  {
    source: 'app/(dashboard)/components/NotificationCenter.tsx',
    token: 'success',
    reason: UNSUPPORTED_CONTRACT,
    note: 'The historical notification centre rendered `notif-type-icon success`; the current alert authority only issues CRITICAL, WARNING and INFO, and the notification provider maps success to info. There is no SUCCESS alert contract, so the branch cannot be reached and must not be added for coverage.',
  },
  {
    source: 'components/analytics/WorkbenchPanel.tsx',
    token: 'analytics-ring',
    reason: UNSUPPORTED_CONTRACT,
    note: 'The historical workbench encoded the operations score as a conic-gradient ring. The current design renders the same score directly as a numeric readout because an angle adds no information and the anti-drift gate prohibits decorative conic-gradient gauges. Reintroducing this class would require unreachable markup and an invalid styling pattern.',
  },
  {
    source: 'components/analytics/WorkbenchPanel.tsx',
    token: 'analytics-ring-inner',
    reason: UNSUPPORTED_CONTRACT,
    note: 'This inner element only existed inside the retired analytics-ring gauge. The current numeric readout exposes the same operations score without a redundant nested gauge, so this exact historical token cannot be rendered by the current contract.',
  },
]);

/** True when this exact token is excluded for this exact source file. */
export function isTokenExcluded(relativePath, token) {
  const candidate = normalized(relativePath);
  return TOKEN_EXCLUSIONS.some((entry) => entry.source === candidate && entry.token === token);
}

/**\n * Manual-review lock.
 *
 * SCOPE_REVISION is a digest of EXCLUSIONS. The gate recomputes it and fails when it
 * does not match, which forces whoever changes the scope to also record who reviewed
 * it and why. Update both fields in the same commit as any scope edit.
 */
export const SCOPE_REVIEW = Object.freeze({
  revision: 'e7c46951',
  reviewedAt: '2026-10-08',
  reviewedBy: 'forward-port review',
  rationale: 'Frozen scope: retired surfaces, the charging plane, runtime concerns the current checkout already owns, and the token-level contract differences documented beside their exact historical sources. Coverage is measured symmetrically: both sides are walked through their own import graph from their own entry points. Scope changes require an explicit digest update and a human review.',
});

/**
 * Declared acceptance target for reachable coverage.
 *
 * This is the goal the port is working towards and is reported on every run.
 */
export const ACCEPTANCE_TARGET = 0.9;

/**
 * Regression floor and missing-class ceiling for the current branch.
 *
 * Both are the measured result of the SYMMETRIC reachability graph: the historical
 * vocabulary is collected from the historical route entry points through the
 * historical import graph, and the current vocabulary from the current entry points
 * through the current import graph. Surfaces the historical application never
 * rendered therefore fall out of the denominator by construction rather than by a
 * hand-written exclusion.
 *
 * Final syntax-aware measurement: the comparable reachable vocabulary is 893 classes with ZERO
 * missing, so the floor is 1.0 and the ceiling is 0.
 *
 * The token exclusions below are reviewed contract differences, not dead code:
 *
 *   components/ocs/contracts/OcsContractsPanel.tsx -> `ocs-feedback-`
 *       A genuine tokeniser artefact. `className={`ocs-feedback-${feedback.type}`}`
 *       only ever produces `ocs-feedback-success` / `ocs-feedback-error` at runtime,
 *       and both are explicitly covered in the current markup. The extractor is now
 *       syntax-aware: a token touching an interpolation boundary is incomplete and is
 *       dropped, while the two real classes are still detected.
 *
 *   app/(dashboard)/components/NotificationCenter.tsx -> `success`
 *       NOT an artefact. The historical centre rendered `notif-type-icon success`,
 *       but the current alert authority only issues CRITICAL, WARNING and INFO and the
 *       notification provider maps success to info. There is no SUCCESS contract, so
 *       this is a token-scoped contract exclusion (see TOKEN_EXCLUSIONS), not dead code
 *       to be added.
 *
 *   components/analytics/WorkbenchPanel.tsx -> `analytics-ring`, `analytics-ring-inner`
 *       The historical score ring encoded the same number once as a conic-gradient angle and
 *       once as text. The current workbench retains the numeric score and deliberately drops
 *       the redundant ring. The anti-drift gate forbids adding the ring styling back, so these
 *       two exact historical tokens are token-scoped unsupported-contract exclusions.
 */
export const REACHABLE_REGRESSION_FLOOR = 1;
/** Hard ceiling on missing reachable classes. */
export const MAX_MISSING_REACHABLE = 0;

const normalized = (value) => value.replace(/\\/g, '/').replace(/^\.\//, '');

/** Exact path or directory-prefix match. Never substring matching. */
export function isExcluded(relativePath) {
  const candidate = normalized(relativePath);
  return EXCLUSIONS.some((entry) => (
    entry.path.endsWith('/') ? candidate.startsWith(entry.path) : candidate === entry.path
  ));
}

/** Digest of the exclusion list, used as the manual-review lock. */
export function computeScopeDigest() {
  const payload = [
    ...EXCLUSIONS.map((entry) => `${entry.path}\t${entry.reason}`),
    ...HISTORICAL_ENTRY_POINTS.map((entry) => `entry\t${entry.route}\t${entry.path}`),
    ...REDIRECT_ONLY_ROUTES.map((entry) => `redirect\t${entry}`),
    ...TOKEN_EXCLUSIONS.map((entry) => `token\t${entry.source}\t${entry.token}\t${entry.reason}`),
  ].join('\n');
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Validates the scope itself. Returns a list of problems; empty means healthy.
 * The gate calls this so a malformed scope fails loudly rather than silently
 * widening or narrowing the metric.
 */
export function validateScope() {
  const problems = [];
  const allowed = new Set(Object.values(EXCLUSION_REASONS));
  const seen = new Set();

  for (const entry of EXCLUSIONS) {
    if (!entry.path || typeof entry.path !== 'string') {
      problems.push('exclusion entry without a path');
      continue;
    }
    if (entry.path !== normalized(entry.path)) problems.push(`path is not normalised: ${entry.path}`);
    if (entry.path.includes('*') || entry.path.includes('..')) problems.push(`fuzzy or escaping path: ${entry.path}`);
    if (!allowed.has(entry.reason)) problems.push(`unknown reason "${entry.reason}" for ${entry.path}`);
    if (!entry.note || !entry.note.trim()) problems.push(`missing note for ${entry.path}`);
    if (seen.has(entry.path)) problems.push(`duplicate exclusion: ${entry.path}`);
    seen.add(entry.path);
  }

  for (const entry of TOKEN_EXCLUSIONS) {
    if (!entry.source || !entry.token) problems.push('token exclusion without source or token');
    if (entry.source !== normalized(entry.source)) problems.push(`token exclusion source is not normalised: ${entry.source}`);
    if (!allowed.has(entry.reason)) problems.push(`unknown reason "${entry.reason}" for token ${entry.token}`);
    if (!entry.note || !entry.note.trim()) problems.push(`missing note for token ${entry.token}`);
    /* A token exclusion must never be a bare word that could swallow unrelated uses. */
    if (!/^[a-z][a-z0-9-]*$/.test(entry.token)) problems.push(`token exclusion is not a single class token: ${entry.token}`);
  }

  const digest = computeScopeDigest();
  if (digest !== SCOPE_REVIEW.revision) {
    problems.push(`scope changed without review: digest=${digest} declared=${SCOPE_REVIEW.revision} (update SCOPE_REVIEW)`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(SCOPE_REVIEW.reviewedAt)) problems.push('SCOPE_REVIEW.reviewedAt is not a date');

  return problems;
}
