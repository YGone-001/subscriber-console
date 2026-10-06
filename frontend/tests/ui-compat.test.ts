/*
 * React Router compatibility surface contract.
 *
 * The forward port replaces the historical App Router hooks with the helpers in
 * `src/lib/ui-compat`. These tests pin the behaviour the ported components rely
 * on: navigation semantics, raw (not re-decoded) dynamic parameters, local-only
 * destinations, and the absence of any retired framework import.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { AppLink } from '../src/lib/ui-compat/link';
import {
  buildLocalPath,
  createAppRouter,
  isLocalDestination,
  useAppParam,
  useAppParams,
  useAppPathname,
  useAppSearchParam,
  useAppSearchParams,
} from '../src/lib/ui-compat/router';

type ProbeSnapshot = {
  pathname: string;
  params: Record<string, string | undefined>;
  imsi: string | undefined;
  role: string | null;
  tags: string[];
};

let snapshot: ProbeSnapshot | null = null;

function Probe() {
  snapshot = {
    pathname: useAppPathname(),
    params: useAppParams(),
    imsi: useAppParam('imsi'),
    role: useAppSearchParam('role'),
    tags: useAppSearchParams().getAll('tag'),
  };
  return createElement('div', null, 'probe');
}

type NavigateCall = { to: string | number; options?: { replace?: boolean } };

function makeRouter() {
  const calls: NavigateCall[] = [];
  const assigned: string[] = [];
  const router = createAppRouter(
    (to, options) => { calls.push({ to, options }); },
    (url) => { assigned.push(url); },
  );
  return { router, calls, assigned };
}

function mount(entries: string[], initialIndex: number, routes: string[] = []) {
  const paths = routes.length ? routes : ['/'];
  const router = createMemoryRouter(
    paths.map((path) => ({ path, element: createElement(Probe) })),
    { initialEntries: entries, initialIndex },
  );
  renderToString(createElement(RouterProvider, { router }));
  return router;
}

test('push navigates forward and back walks history backwards', () => {
  const { router, calls, assigned } = makeRouter();

  router.push('/ocs/tariffs');
  assert.deepEqual(calls, [{ to: '/ocs/tariffs', options: { replace: false, state: undefined, relative: undefined } }]);

  router.back();
  assert.equal(calls[1].to, -1, 'back must ask the router for the previous entry');

  router.forward();
  assert.equal(calls[2].to, 1, 'forward must ask the router for the next entry');

  assert.deepEqual(assigned, [], 'internal navigation must never leave the SPA');
});

test('replace navigates without adding a history entry', () => {
  const { router, calls } = makeRouter();

  router.replace('/users');
  assert.equal(calls[0].to, '/users');
  assert.equal(calls[0].options?.replace, true, 'replace must set the replace flag');

  /* An explicit option still wins over the default for push. */
  router.push('/users', { replace: true });
  assert.equal(calls[1].options?.replace, true);
});

test('a non-local destination never reaches the router', () => {
  const { router, calls, assigned } = makeRouter();

  router.push('https://example.com/elsewhere');
  router.replace('mailto:ops@example.com');
  router.push('//example.com/protocol-relative');
  router.push('');

  assert.deepEqual(calls, [], 'external destinations must not be pushed into the router');
  assert.deepEqual(assigned, ['https://example.com/elsewhere', 'mailto:ops@example.com', '//example.com/protocol-relative']);
});

test('prefetch and refresh are inert compatibility no-ops', () => {
  const { router, calls, assigned } = makeRouter();
  router.prefetch('/users');
  router.refresh();
  assert.deepEqual(calls, []);
  assert.deepEqual(assigned, []);
});

test('dynamic parameters stay raw strings and are not decoded twice', () => {
  mount(['/ocs/balances/310150123456789'], 0, ['/ocs/balances/:imsi']);
  assert.equal(snapshot?.params.imsi, '310150123456789');
  assert.equal(typeof snapshot?.params.imsi, 'string', 'an all-digit identifier must stay a string');

  mount(['/ocs/balances/a%2520b'], 0, ['/ocs/balances/:imsi']);
  assert.equal(snapshot?.params.imsi, 'a%20b', 'a raw segment must be decoded exactly once');
});

test('search parameters keep their multi-value form', () => {
  mount(['/ocs/balances/1?role=admin&tag=a&tag=b'], 0, ['/ocs/balances/:imsi']);
  assert.equal(snapshot?.role, 'admin');
  assert.deepEqual(snapshot?.tags, ['a', 'b']);
  assert.equal(snapshot?.pathname, '/ocs/balances/1', 'pathname excludes the query string');
});

test('local destination detection covers internal, external and malformed values', () => {
  for (const value of ['/users', '/ocs/balances/1?x=1', '?page=2', '#section']) {
    assert.equal(isLocalDestination(value), true, `${value} must be local`);
  }
  for (const value of ['https://example.com', 'http://localhost:18888/api', '//example.com', 'mailto:ops@example.com', 'tel:+100', 'users', '']) {
    assert.equal(isLocalDestination(value), false, `${value} must not be local`);
  }
});

test('buildLocalPath substitutes and encodes every dynamic segment once', () => {
  assert.equal(buildLocalPath('/ocs/balances/:imsi', { imsi: '310150123456789' }), '/ocs/balances/310150123456789');
  assert.equal(buildLocalPath('/users/:username', { username: 'a b' }), '/users/a%20b');
  assert.equal(buildLocalPath('/users/:username', {}), '/users/:username', 'unresolved segments are left alone');
});

test('AppLink keeps external destinations as plain anchors and internal ones as router links', () => {
  const external = renderToString(createElement(AppLink, { to: 'https://example.com/docs' }, 'docs'));
  assert.match(external, /href="https:\/\/example\.com\/docs"/);

  const router = createMemoryRouter([{ path: '/users', element: createElement(AppLink, { href: '/users' }, 'users') }], { initialEntries: ['/users'] });
  const internal = renderToString(createElement(RouterProvider, { router }));
  assert.match(internal, /href="\/users"/, 'the historical href prop must still produce a router link');
});

test('no retired framework import remains in the frontend source', () => {
  const srcRoot = resolve(import.meta.dirname, '../src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const source = readFileSync(full, 'utf8');
      if (/(?:from|require\()\s*['"]next(?:\/|['"])/.test(source)) offenders.push(full);
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], `retired framework imports found: ${offenders.join(', ')}`);
});
