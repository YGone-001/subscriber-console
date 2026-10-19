/*
 * UX-1 contract tests: shared page frame, single refresh entry, URL state.
 *
 * Reference: docs/analyze/cnms-port-assessment-2026-10-18.md section 4.1 and the
 * UX-1 row of section 8.
 *
 * Three groups:
 *   1. the pure URL contract (allow-list, sanitising, cursor reset);
 *   2. the refresh registry (register / replace / unregister / isolated run);
 *   3. source and render assertions that the five operations pages share one
 *      frame, one refresh entry and one tab strip.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import {
  applyOperationsPatch,
  OPERATIONS_CURSOR_PARAM,
  OPERATIONS_VIEW_PARAM,
  readOperationsParams,
  resolveOperationsView,
  sanitizeOperationsValue,
} from '../src/features/operations/operations-url-state';
import { useOperationsUrlState } from '../src/features/operations/use-operations-url-state';
import { createOperationsRefreshRegistry } from '../src/features/operations/operations-refresh';
import { TopologyPage } from '../src/features/topology/TopologyPage';
import { InventoryPage } from '../src/features/inventory/InventoryPage';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const FILTER_KEYS = ['q', 'state', OPERATIONS_VIEW_PARAM, OPERATIONS_CURSOR_PARAM] as const;

function UrlStateProbe() {
  const state = useOperationsUrlState({ keys: ['q', 'state'] });
  return createElement('output', {
    'data-q': state.filters.q ?? '',
    'data-state': state.filters.state ?? '',
    'data-cursor': state.cursor ?? '',
  });
}

/* ------------------------------------------------------------ URL contract -- */

test('an empty patch serialises to an empty search and reports no change', () => {
  const result = applyOperationsPatch('', {}, FILTER_KEYS);
  assert.equal(result.search, '');
  assert.equal(result.changed, false);
  assert.equal(result.cursorReset, false);
});

test('only allow-listed keys survive a patch', () => {
  const result = applyOperationsPatch(
    '?q=smf&state=seen&view=list&cursor=abc&injected=1',
    {},
    FILTER_KEYS,
  );
  assert.equal(result.search, '?q=smf&state=seen&view=list&cursor=abc');
  assert.ok(!result.search.includes('injected'));
});

test('a filter change drops the cursor in the same write', () => {
  const result = applyOperationsPatch('?q=smf&cursor=page-2', { q: 'amf' }, FILTER_KEYS);
  assert.equal(result.cursorReset, true);
  assert.equal(result.search, '?q=amf');
  assert.ok(!result.search.includes(OPERATIONS_CURSOR_PARAM));
});

test('a cursor change preserves every filter and never resets itself', () => {
  const result = applyOperationsPatch('?q=smf&state=seen&cursor=page-1', { cursor: 'page-2' }, FILTER_KEYS);
  assert.equal(result.cursorReset, false);
  assert.equal(result.search, '?q=smf&state=seen&cursor=page-2');
});

test('clearing a filter also drops the cursor', () => {
  const result = applyOperationsPatch('?q=smf&cursor=page-3', { q: null }, FILTER_KEYS);
  assert.equal(result.cursorReset, true);
  assert.equal(result.search, '');
});

test('a no-op patch does not create a history entry', () => {
  const result = applyOperationsPatch('?q=smf', { q: 'smf' }, FILTER_KEYS);
  assert.equal(result.changed, false);
  assert.equal(result.search, '?q=smf');
});

test('empty, over-long and control-character values are rejected', () => {
  assert.equal(sanitizeOperationsValue('   '), '');
  assert.equal(sanitizeOperationsValue(null), '');
  assert.equal(sanitizeOperationsValue('a'.repeat(257)), '');
  assert.equal(sanitizeOperationsValue('smf\namf'), '');
  assert.equal(sanitizeOperationsValue('  smf  '), 'smf');
});

test('a malformed value in the URL degrades to the default instead of reaching the API', () => {
  const parsed = readOperationsParams('?q=%00&state=seen', ['q', 'state']);
  assert.equal(parsed.q, undefined);
  assert.equal(parsed.state, 'seen');
});

test('normalization removes an invalid filter and its stale cursor before a page can consume them', () => {
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/nf-health?q=%00&state=enabled&cursor=page-2&foreign=value'] },
      createElement(UrlStateProbe),
    ),
  );
  assert.match(markup, /data-q=""/);
  assert.match(markup, /data-state="enabled"/);
  assert.match(markup, /data-cursor=""/);
});

test('an unknown view falls back to the page default', () => {
  assert.equal(resolveOperationsView('bogus', ['network', 'list', 'runtime'], 'network'), 'network');
  assert.equal(resolveOperationsView(null, ['network', 'list', 'runtime'], 'network'), 'network');
  assert.equal(resolveOperationsView('runtime', ['network', 'list', 'runtime'], 'network'), 'runtime');
  assert.equal(resolveOperationsView('anything', undefined, 'list'), 'list');
});

/* ------------------------------------------------------- refresh registry -- */

test('the registry runs every registered loader', async () => {
  const registry = createOperationsRefreshRegistry();
  const calls: string[] = [];
  registry.register('page', () => {
    calls.push('page');
  });
  registry.register('canvas', async () => {
    calls.push('canvas');
  });
  await registry.run();
  assert.deepEqual(calls.sort(), ['canvas', 'page']);
});

test('re-registering a key replaces the previous loader instead of duplicating it', async () => {
  const registry = createOperationsRefreshRegistry();
  const calls: string[] = [];
  registry.register('canvas', () => {
    calls.push('first');
  });
  registry.register('canvas', () => {
    calls.push('second');
  });
  assert.equal(registry.size(), 1);
  await registry.run();
  assert.deepEqual(calls, ['second']);
});

test('unregistering a section removes its loader', async () => {
  const registry = createOperationsRefreshRegistry();
  const calls: string[] = [];
  const unregister = registry.register('canvas', () => {
    calls.push('canvas');
  });
  unregister();
  assert.equal(registry.size(), 0);
  await registry.run();
  assert.deepEqual(calls, []);
});

test('one failing loader never blocks or rejects the others', async () => {
  const registry = createOperationsRefreshRegistry();
  const calls: string[] = [];
  registry.register('broken-sync', () => {
    throw new Error('sync failure');
  });
  registry.register('broken-async', async () => {
    throw new Error('async failure');
  });
  registry.register('healthy', () => {
    calls.push('healthy');
  });
  await registry.run();
  assert.deepEqual(calls, ['healthy']);
});

test('pending state is observable while loaders are in flight', async () => {
  const registry = createOperationsRefreshRegistry();
  let release: (() => void) | undefined;
  registry.register('slow', () => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const seen: boolean[] = [];
  registry.subscribe(() => seen.push(registry.isPending()));
  const running = registry.run();
  assert.equal(registry.isPending(), true);
  await Promise.resolve();
  release?.();
  await running;
  assert.equal(registry.isPending(), false);
  assert.ok(seen.includes(true), 'subscribers must observe the in-flight state');
});

test('running an empty registry is a no-op', async () => {
  const registry = createOperationsRefreshRegistry();
  await registry.run();
  assert.equal(registry.isPending(), false);
});

/* ------------------------------------------------------- page composition -- */

const OPERATIONS_PAGES = [
  'src/features/inventory/InventoryPage.tsx',
  'src/features/topology/TopologyPage.tsx',
  'src/features/discovery/DiscoveryPage.tsx',
  'src/features/nf-health/NfHealthPage.tsx',
  'src/features/nf-alerts/NfAlertsPage.tsx',
];

test('every operations page renders inside the shared frame', () => {
  for (const page of OPERATIONS_PAGES) {
    const source = read(`../${page}`);
    assert.match(source, /OperationsPageFrame/, `${page} must use the shared frame`);
    assert.ok(!source.includes('PageHeader'), `${page} must not draw its own page header`);
    assert.ok(!source.includes('<OperationsNav'), `${page} must not duplicate the tab strip`);
  }
});

test('every operations page exposes exactly one refresh entry', () => {
  for (const page of OPERATIONS_PAGES) {
    const source = read(`../${page}`);
    assert.ok(!source.includes('RefreshCw'), `${page} must not draw its own refresh icon`);
    assert.match(source, /onRefresh=/, `${page} must register its loader with the frame`);
  }
});

test('sections register their loaders instead of drawing a second refresh button', () => {
  const sections = [
    'src/features/operations/NetworkElementView.tsx',
    'src/features/topology/ArchitectureView.tsx',
    'src/features/runtime/RuntimeDiscovery.tsx',
  ];
  for (const section of sections) {
    const source = read(`../${section}`);
    assert.match(source, /useRegisterOperationsRefresh\(/, `${section} must register a loader`);
  }
  assert.ok(
    !read('../src/features/operations/NetworkElementView.tsx').includes('RefreshCw'),
    'the network-element view must not keep its own refresh icon',
  );
  assert.ok(
    !read('../src/features/topology/ArchitectureView.tsx').includes('RefreshCw'),
    'the architecture canvas must not keep its own refresh icon',
  );
});

test('the runtime discovery panel keeps its control only outside a page frame', () => {
  const source = read('../src/features/runtime/RuntimeDiscovery.tsx');
  assert.match(source, /\{variant === 'panel' \? \(/, 'the refresh control must be panel-only');
  assert.match(source, /onClick=\{refresh\}/);
});

test('the inventory view switch is URL state, not component-only state', () => {
  const source = read('../src/features/inventory/InventoryPage.tsx');
  assert.ok(
    !source.includes('new URLSearchParams(window.location.search)'),
    'the view must not be read once from window.location at mount',
  );
  assert.match(source, /useOperationsUrlState\(\{/);
  assert.match(source, /views: INVENTORY_VIEWS/);
});

test('a rendered operations page exposes one tab strip and one refresh control', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('page rendering must not perform network access');
  }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ['/topology?state=retired'] },
          createElement(
            AuthProvider,
            null,
            createElement(Routes, null, createElement(Route, { path: '/topology', element: createElement(TopologyPage) })),
          ),
        ),
      ),
    );
    const refreshControls = markup.split('data-operations-refresh="page"').length - 1;
    assert.equal(refreshControls, 1, 'exactly one page-level refresh control may render');
    assert.equal(markup.split('data-operations-nav="workbench"').length - 1, 1, 'exactly one tab strip may render');
    assert.ok(markup.includes('Topology'), 'the page title must render');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a rendered inventory page honours the view from the URL', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('page rendering must not perform network access');
  }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ['/inventory?view=assets'] },
          createElement(
            AuthProvider,
            null,
            createElement(Routes, null, createElement(Route, { path: '/inventory', element: createElement(InventoryPage) })),
          ),
        ),
      ),
    );
    assert.ok(markup.includes('aria-pressed="true"'), 'the active view switch must be pressed');
    assert.ok(markup.includes('data-view-mode="assets"'), 'the ledger view switch must render');
    assert.ok(markup.includes('type="search"'), 'the ledger workspace must render for view=assets');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
