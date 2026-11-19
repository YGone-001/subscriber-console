/*
 * Route-level lazy loading contract.
 *
 * The router no longer imports page modules eagerly: every canonical business
 * route resolves to a `route.lazy` loader, and only the shell, the
 * authentication boundary and the login surface stay in the initial bundle.
 *
 * These assertions run against the real route table (`appRoutes`) with React
 * Router's own matcher, so they describe behaviour rather than source text:
 *
 *   H1  route inventory parity: every canonical pattern resolves, nothing is
 *       dropped, renamed or shadowed, and static paths beat dynamic siblings.
 *   H4  authentication: the shell route is still the AuthGate boundary and the
 *       authenticated 404 stays inside it.
 *   H5  failure surface: a failed page module renders inside the shell.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidElement } from 'react';
import { resolve } from 'node:path';
import test from 'node:test';
import { matchRoutes, type RouteObject } from 'react-router-dom';
import { AuthGate } from '../src/auth/AuthGate';
import { APP_ROUTES } from '../src/lib/navigation';
import { COMPATIBILITY_REDIRECTS } from '../src/router/redirects';
import { appRoutes, ROUTE_LAZY_PAGES } from '../src/router/routes';

type ContractEntry = { route: string; dynamicParameters: string[] };

const spaRoot = resolve(import.meta.dirname, '..');
const contract = JSON.parse(readFileSync(resolve(spaRoot, 'route-contract.json'), 'utf8')) as ContractEntry[];

/** Representative identifier per dynamic parameter name. */
const SAMPLE_VALUES: Record<string, string> = {
  imsi: '460001234567890',
  username: 'operator-one',
  name: 'default-profile',
  resourceId: '3f1a5c7e-1111-4222-8333-944455556666',
  planId: 'plan-gold',
  sourceId: 'source-001',
  targetId: 'target-001',
  agentId: 'agent-001',
  investigationId: 'investigation-001',
  entryId: 'entry-001',
};

function concretePath(pattern: string): string {
  return pattern.replace(/:([^/]+)/g, (_match, name: string) => SAMPLE_VALUES[name] ?? 'sample');
}

function leafOf(url: string) {
  const matches = matchRoutes(appRoutes, url);
  assert.ok(matches && matches.length > 0, `no route matched ${url}`);
  return matches[matches.length - 1];
}

/** The shell route is the one that mounts the authentication boundary. */
function shellRoute(): RouteObject {
  const route = appRoutes.find((candidate) => isValidElement(candidate.element) && candidate.element.type === AuthGate);
  assert.ok(route, 'the route table must mount the application shell behind AuthGate');
  return route;
}

test('every canonical route pattern resolves to its own route entry', () => {
  assert.equal(contract.length, new Set(APP_ROUTES.map(route => route.route)).size, 'the route contract preserves every declared pattern');

  for (const entry of contract) {
    const url = concretePath(entry.route);
    const leaf = leafOf(url);
    assert.equal(leaf.route.path, entry.route, `${url} must resolve to ${entry.route}`);
  }
});

test('the route table and the navigation authority declare the same inventory', () => {
  const declared = new Set(APP_ROUTES.map((route) => route.route));
  const table = new Set<string>();

  for (const entry of contract) {
    assert.ok(declared.has(entry.route), `${entry.route} is in the contract but not in APP_ROUTES`);
    const leaf = leafOf(concretePath(entry.route));
    table.add(leaf.route.path ?? '');
  }

  assert.deepEqual([...table].sort(), [...declared].sort(), 'the route table must expose exactly the APP_ROUTES inventory');
});

test('every business route is lazy and carries no eager element', () => {
  for (const entry of contract) {
    if (entry.route === '/login') continue;
    if (COMPATIBILITY_REDIRECTS[entry.route]) continue;

    const loader = ROUTE_LAZY_PAGES[entry.route];
    assert.equal(typeof loader, 'function', `${entry.route} must be served by a lazy loader`);

    const leaf = leafOf(concretePath(entry.route));
    assert.equal(typeof leaf.route.lazy, 'function', `${entry.route} must resolve through route.lazy`);
    assert.equal(leaf.route.element, undefined, `${entry.route} must not also declare an eager element`);
  }
});

test('no lazy loader is registered for a non-canonical route', () => {
  const canonical = new Set(contract.map((entry) => entry.route));
  for (const routePath of Object.keys(ROUTE_LAZY_PAGES)) {
    assert.ok(canonical.has(routePath), `lazy loader registered for unknown route: ${routePath}`);
  }
});

test('the login surface stays eager so it never waits on a page module', () => {
  const login = appRoutes.find((route) => route.path === '/login');
  assert.ok(login, 'the login route must exist');
  assert.ok(isValidElement(login.element), 'the login route must render an element directly');
  assert.equal(login.lazy, undefined, 'the login route must not be lazy');
});

test('compatibility aliases redirect instead of loading a page module', () => {
  for (const [alias, target] of Object.entries(COMPATIBILITY_REDIRECTS)) {
    const leaf = leafOf(alias);
    assert.equal(leaf.route.path, alias, `${alias} must resolve to its alias entry`);
    assert.equal(leaf.route.lazy, undefined, `${alias} must not load a page module`);
    assert.ok(isValidElement(leaf.route.element), `${alias} must render a redirect element`);
    const props = (leaf.route.element as { props: { to?: string; replace?: boolean } }).props;
    assert.equal(props.to, target, `${alias} must redirect to ${target}`);
    assert.equal(props.replace, true, `${alias} must replace the history entry`);
  }
});

test('static paths win over dynamic siblings', () => {
  const cases: Array<[string, string]> = [
    ['/users/create', '/users/create'],
    ['/users/operator-one', '/users/:username'],
    ['/knowledge/new', '/knowledge/new'],
    ['/knowledge/entry-001', '/knowledge/:entryId'],
    ['/knowledge/entry-001/edit', '/knowledge/:entryId/edit'],
    ['/inventory/create', '/inventory/create'],
    ['/inventory/assets', '/inventory/assets'],
    ['/inventory/runtime', '/inventory/runtime'],
    ['/inventory/groups', '/inventory/groups'],
    ['/inventory/3f1a5c7e-1111-4222-8333-944455556666', '/inventory/:resourceId'],
    ['/subscribers/new', '/subscribers/new'],
    ['/subscribers/460001234567890', '/subscribers/:imsi'],
    ['/ocs/balances', '/ocs/balances'],
    ['/ocs/balances/460001234567890', '/ocs/balances/:imsi'],
  ];

  for (const [url, expected] of cases) {
    assert.equal(leafOf(url).route.path, expected, `${url} must resolve to ${expected}`);
  }
});

test('the authenticated 404 stays inside the shell and the top-level fallback is preserved', () => {
  const shell = shellRoute();
  assert.ok(shell.children && shell.children.length > 0, 'the shell route must declare children');

  const unknown = matchRoutes(appRoutes, '/no-such-page');
  assert.ok(unknown && unknown.length >= 2, 'an unknown path must match the shell plus a wildcard child');
  assert.equal(unknown[unknown.length - 1].route.path, '*', 'the unknown path must terminate at the wildcard route');

  const topLevelWildcard = appRoutes.find((route) => route.path === '*' && isValidElement(route.element));
  assert.ok(topLevelWildcard, 'the unauthenticated fallback wildcard must stay at the top level');
});

test('cold boot and page-load failures have a bounded, accessible surface', () => {
  const shell = shellRoute();
  assert.ok(shell.hydrateFallbackElement, 'the shell must render a fallback while the first route module loads');

  const login = appRoutes.find((route) => route.path === '/login');
  assert.ok(login?.hydrateFallbackElement, 'the login route must render a fallback during cold boot');

  const inner = shell.children?.[0];
  assert.ok(inner, 'the shell must wrap its business routes');
  assert.ok(isValidElement(inner.errorElement), 'a failed page module must render an error element inside the shell');
});

test('a lazy loader resolves to a component module', async () => {
  const loader = ROUTE_LAZY_PAGES['/system-health'];
  assert.ok(loader, '/system-health must be lazy');
  const resolved = await loader();
  assert.equal(typeof resolved.Component, 'function', 'the lazy module must expose a Component');
});
