/*
 * Single source for the canonical SPA route set.
 *
 * The navigation module is the routing authority: the router builds its page
 * table from `APP_ROUTES`, and `frontend/route-contract.json` is the checked-in
 * snapshot every contract gate reads. Before this module the snapshot's length
 * was asserted as a literal in a dozen separate scripts, so adding one route
 * meant editing a dozen numbers and forgetting one turned the whole pipeline red.
 *
 * The expectation is therefore derived, not restated: the contract must equal the
 * route set the navigation authority declares. A route that is added, removed,
 * renamed or substituted fails here once, and the diff of the navigation source
 * is what a reviewer actually reads.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const NAVIGATION_SOURCE_PATH = resolve(ROOT, 'frontend/src/lib/navigation.ts');
export const ROUTE_CONTRACT_PATH = resolve(ROOT, 'frontend/route-contract.json');

/*
 * `APP_ROUTES` entries carry the route pattern in a quoted `route:` field. The
 * pattern is deliberately anchored to the lowercase key so `targetRoute:` never
 * matches; a declaration written with double quotes deliberately fails here
 * rather than silently shrinking the expected set.
 */
const ROUTE_DECLARATION = /\broute:\s*'([^']+)'/g;

/** Route patterns declared by the navigation authority, in declaration order. */
export function readNavigationRoutes(sourceText = readFileSync(NAVIGATION_SOURCE_PATH, 'utf8')) {
  const routes = [];
  let match;
  while ((match = ROUTE_DECLARATION.exec(sourceText)) !== null) routes.push(match[1]);
  return routes;
}

function declaredParameters(pattern) {
  return (pattern.match(/:[^/]+/g) ?? []).map((parameter) => parameter.slice(1)).sort();
}

/**
 * Prove the checked-in SPA route contract is exactly the route set the
 * navigation authority declares, and that each entry lists the parameters its
 * pattern carries. Returns the route count so a gate can report it.
 */
export function assertSpaRouteContract(contract, options = {}) {
  assert.ok(Array.isArray(contract), 'the SPA route contract must be an array');

  const navigation = options.navigation ?? readNavigationRoutes();
  assert.ok(navigation.length > 0, 'the navigation authority declared no routes');

  const contractRoutes = contract.map((entry) => entry.route);
  assert.equal(
    new Set(contractRoutes).size,
    contractRoutes.length,
    `the SPA route contract repeats a route: ${contractRoutes.join(', ')}`,
  );

  assert.deepEqual(
    [...contractRoutes].sort(),
    [...navigation].sort(),
    'the SPA route contract must mirror the navigation authority exactly',
  );

  for (const entry of contract) {
    const declared = Array.isArray(entry.dynamicParameters) ? [...entry.dynamicParameters] : [];
    assert.deepEqual(
      declared.sort(),
      declaredParameters(entry.route),
      `route parameters are out of sync with the pattern: ${entry.route}`,
    );
  }

  return contractRoutes.length;
}
