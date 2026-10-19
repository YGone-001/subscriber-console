/*
 * Contract tests for the discovery workflow rearrangement.
 *
 * Reference: docs/analyze/cnms-port-assessment-2026-10-18.md section 6.3 and
 * the discovery workflow row of section 8.
 *
 * The three views are exclusive: the candidate queue, the source table and the
 * scan history never render at the same time. The funnel columns are
 * independent, the monitoring association is never guessed, and runtime
 * onboarding requires an explicit component selection.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { DiscoveryPage } from '../src/features/discovery/DiscoveryPage';
import { DiscoveryCandidatesView } from '../src/features/discovery/DiscoveryCandidatesView';
import { CandidateDetailDrawer } from '../src/features/discovery/CandidateDetailDrawer';
import {
  monitoringBadgeClass,
  monitoringLabel,
  observationLabel,
} from '../src/features/discovery/discovery-view-model';
import type { NfObservation } from '../src/features/discovery/discovery-types';
import type { RuntimeComponent } from '../src/features/runtime/runtime-types';
import { en } from '../src/lib/locales/en';
import { zh } from '../src/lib/locales/zh';
import {
  applyOperationsPatch,
  OPERATIONS_CURSOR_PARAM,
  OPERATIONS_VIEW_PARAM,
  readOperationsParams,
  resolveOperationsView,
} from '../src/features/operations/operations-url-state';
import {
  canAdvance,
  firstScroll,
  nextScroll,
  pageIndexFor,
  previousScroll,
} from '../src/features/discovery/discovery-pager';
import { fetchDiscoveryCandidates } from '../src/features/discovery/discovery-api';
import { discoveryKpisFromSummary } from '../src/features/operations/operations-summary';
import type { PageInfo } from '../src/features/discovery/discovery-types';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function renderDiscovery(path: string): string {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('a discovery view must not call fetch during render');
  }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(
            AuthProvider,
            null,
            createElement(Routes, null, createElement(Route, { path: '/discovery', element: createElement(DiscoveryPage) })),
          ),
        ),
      ),
    );
    assert.equal(calls, 0, 'rendering must not perform network access');
    return markup;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* --------------------------------------------------------------- views -- */

test('the discovery page defaults to the candidate queue', () => {
  const markup = renderDiscovery('/discovery');
  assert.ok(markup.includes('data-discovery-view="candidates"'), 'the view switch must render');
  assert.ok(markup.includes('aria-pressed="true"'), 'the default view must be pressed');
  assert.ok(markup.includes('data-discovery-source-selector="true"'), 'the bounded source selector must render');
});

test('the queue is not rendered behind the sources or runs views', () => {
  for (const view of ['sources', 'runs']) {
    const markup = renderDiscovery(`/discovery?view=${view}`);
    assert.ok(markup.includes(`aria-label="discovery-${view}-view"`), `${view} must render`);
    assert.ok(
      !markup.includes('aria-label="discovery-candidates-view"'),
      `the candidate queue must not render behind the ${view} view`,
    );
  }
});

test('the sources view owns the name search and the runs view owns its filters', () => {
  const sources = renderDiscovery('/discovery?view=sources');
  assert.ok(sources.includes('role="search"'), 'the source name search belongs to the sources view');
  assert.ok(!sources.includes('data-discovery-source-selector="true"'), 'the queue selector belongs to the candidates view');

  const runs = renderDiscovery('/discovery?view=runs');
  assert.ok(runs.includes('discovery-runs-source'), 'the runs source filter must render');
  assert.ok(!runs.includes('role="search"'), 'the name search must not leak into the runs view');
});

test('every discovery view keeps one tab strip and one refresh control', () => {
  for (const view of ['candidates', 'sources', 'runs']) {
    const markup = renderDiscovery(`/discovery?view=${view}`);
    assert.equal(
      markup.split('data-operations-refresh="page"').length - 1,
      1,
      `${view} must expose exactly one refresh control`,
    );
    assert.equal(
      markup.split('data-operations-nav="workbench"').length - 1,
      1,
      `${view} must expose exactly one tab strip`,
    );
  }
});

/* --------------------------------------------------------- KPI source -- */

test('the discovery KPIs come from the full-collection summary, never page arrays', () => {
  const source = read('../src/features/discovery/DiscoveryPage.tsx');
  assert.ok(source.includes('discoveryKpisFromSummary'), 'the KPI strip must read the summary projection');
  assert.ok(!/candidates\.length|sources\.length/.test(source), 'a page-scoped count must never feed a KPI');
  assert.ok(source.includes("fetchOperationsSummary(['discovery'])"), 'the summary section must be requested');
});

test('the URL carries view, filters, source selector and cursor', () => {
  const source = read('../src/features/discovery/DiscoveryPage.tsx');
  for (const key of ['q', 'sourceId', 'state', 'nfType', 'runStatus']) {
    assert.ok(source.includes(`'${key}'`), `the URL contract must carry ${key}`);
  }
  assert.ok(source.includes('DISCOVERY_VIEWS'), 'the view vocabulary must be explicit');
});

/* ------------------------------------------------------ funnel states -- */

function candidate(overrides: Partial<NfObservation>): NfObservation {
  return {
    candidateId: 'c1',
    schemaVersion: 1,
    sourceId: 's1',
    adapterType: 'nrf',
    externalNfInstanceId: 'ext-1',
    nfType: 'AMF',
    nfStatus: 'REGISTERED',
    observedEndpoints: [],
    observedServices: [],
    firstSeenAt: '2026-10-01T08:00:00Z',
    lastSeenAt: '2026-10-02T08:00:00Z',
    observationState: 'seen',
    linkedResourceId: null,
    revision: 1,
    ...overrides,
  };
}

const styleStub = new Proxy({} as Record<string, string>, {
  get: (_target, prop) => (typeof prop === 'string' ? prop : ''),
});

test('the funnel monitoring states stay independent and honest', () => {
  const linkedMonitored = candidate({
    linkedResourceId: 'r1',
    monitoringAssociation: { state: 'monitored', targetId: 't1' },
  });
  const linkedUnmonitored = candidate({
    linkedResourceId: 'r1',
    monitoringAssociation: { state: 'unmonitored' },
  });
  const linkedUnresolved = candidate({
    linkedResourceId: 'r1',
    monitoringAssociation: { state: 'unresolved' },
  });
  const linkedProjectionMissing = candidate({ linkedResourceId: 'r1' });
  const unlinked = candidate({ linkedResourceId: null });

  assert.equal(monitoringLabel(linkedMonitored, (key) => en[key as keyof typeof en] ?? key), en.discovery_monitored);
  assert.equal(monitoringLabel(linkedUnmonitored, (key) => en[key as keyof typeof en] ?? key), en.discovery_unmonitored);
  assert.equal(monitoringLabel(linkedUnresolved, (key) => en[key as keyof typeof en] ?? key), en.discovery_monitoring_unresolved);
  assert.equal(monitoringLabel(linkedProjectionMissing, (key) => en[key as keyof typeof en] ?? key), en.discovery_monitoring_unresolved);
  assert.equal(monitoringLabel(unlinked, (key) => en[key as keyof typeof en] ?? key), en.discovery_monitoring_na);

  // unresolved must never borrow the unmonitored tone.
  assert.notEqual(
    monitoringBadgeClass(linkedUnresolved, styleStub as never),
    monitoringBadgeClass(linkedUnmonitored, styleStub as never),
  );
  assert.equal(
    monitoringBadgeClass(linkedProjectionMissing, styleStub as never),
    monitoringBadgeClass(linkedUnresolved, styleStub as never),
  );
});

test('observation state labels stay distinct from registry status', () => {
  const t = (key: string) => en[key as keyof typeof en] ?? key;
  assert.equal(observationLabel('seen', t), en.discovery_state_seen);
  assert.equal(observationLabel('missing', t), en.discovery_state_missing);
  assert.equal(observationLabel('stale', t), en.discovery_state_stale);
});

test('both locales define the funnel vocabulary', () => {
  for (const key of [
    'discovery_view_candidates',
    'discovery_col_observed',
    'discovery_col_linked',
    'discovery_col_monitored',
    'discovery_monitored',
    'discovery_unmonitored',
    'discovery_monitoring_unresolved',
    'discovery_runtime_onboarding_note',
    'discovery_runtime_onboarding_ambiguous',
    'discovery_pager_runs',
  ]) {
    assert.ok(key in en, `en locale must define ${key}`);
    assert.ok(key in zh, `zh locale must define ${key}`);
  }
});

/* ------------------------------------------------------------- drawer -- */

function renderDrawer(
  target: NfObservation,
  components: RuntimeComponent[],
  options: { runtimeUnavailable?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        I18nProvider,
        null,
        createElement(CandidateDetailDrawer, {
          candidate: target,
          runtimeComponents: components,
          runtimeUnavailable: options.runtimeUnavailable ?? false,
          canConfigure: true,
          busy: false,
          linkError: null,
          onClose: () => {},
          onLink: () => {},
          onUnlink: () => {},
          onBootstrap: () => {},
        }),
      ),
    ),
  );
}

function runtimeComponent(overrides: Partial<RuntimeComponent>): RuntimeComponent {
  return {
    componentId: 'comp-1',
    displayName: 'AMF',
    processName: 'amfd',
    matchMethod: 'comm',
    category: '5gc',
    domain: '5gc',
    role: 'nf',
    nfType: 'AMF',
    cnmsCompatible: false,
    templates: ['auto'],
    runtimeStatus: 'running',
    statusReason: '',
    evidence: 'verified',
    verified: true,
    primaryPid: 42,
    workerCount: 1,
    workers: [],
    workersTruncated: false,
    unverifiedWorkers: 0,
    cpuPercent: null,
    cpuAvailable: false,
    cpuBasis: '',
    memoryRssBytes: null,
    memoryVmsBytes: null,
    memoryPercent: null,
    memoryAvailable: false,
    memoryBasis: '',
    lastScannedAt: '2026-10-02T08:00:00Z',
    expectation: 'expected',
    monitoring: { state: 'supported' },
    inventoryAssociation: { state: 'absent' },
    nfHealthAssociation: { state: 'absent' },
    ...overrides,
  };
}

test('the drawer shows the monitoring association only for linked candidates', () => {
  const unlinked = renderDrawer(candidate({ linkedResourceId: null }), []);
  assert.ok(unlinked.includes(en.discovery_monitoring_requires_link), 'an unlinked candidate must not claim a monitoring state');

  const monitored = renderDrawer(
    candidate({ linkedResourceId: 'r1', monitoringAssociation: { state: 'monitored', targetId: 't1' } }),
    [],
  );
  assert.ok(monitored.includes(en.discovery_monitored), 'a monitored association must be visible');
  assert.ok(monitored.includes('/nf-health/t1'), 'the target entry must link to the health route');

  const unresolved = renderDrawer(
    candidate({ linkedResourceId: 'r1', monitoringAssociation: { state: 'unresolved' } }),
    [],
  );
  assert.ok(unresolved.includes(en.discovery_monitoring_unresolved_note), 'unresolved must stay distinct');

  const projectionMissing = renderDrawer(candidate({ linkedResourceId: 'r1' }), []);
  assert.ok(
    projectionMissing.includes(en.discovery_monitoring_unresolved_note),
    'a missing projection must never be presented as proven unmonitored',
  );
  assert.ok(
    !projectionMissing.includes(`>${en.discovery_unmonitored}<`),
    'only the explicit unmonitored state may use the unmonitored label',
  );
});

test('the drawer offers link and unlink by association, never both', () => {
  const unlinked = renderDrawer(candidate({ linkedResourceId: null }), []);
  assert.ok(unlinked.includes('candidate-link-resource'), 'the link field must render for an unlinked candidate');
  assert.ok(!unlinked.includes(en.discovery_unlink_action), 'unlink must not render for an unlinked candidate');

  const linked = renderDrawer(candidate({ linkedResourceId: 'r1' }), []);
  assert.ok(linked.includes(en.discovery_unlink_action), 'unlink must render for a linked candidate');
  assert.ok(!linked.includes('candidate-link-resource'), 'the link field must not render for a linked candidate');
});

test('one unambiguous runtime match is preselected, several matches require a choice', () => {
  const single = renderDrawer(candidate({ nfType: 'AMF' }), [runtimeComponent({})]);
  assert.ok(single.includes('type="checkbox"'), 'the component picker must render');
  assert.ok(single.includes('checked'), 'the single unambiguous component may be preselected');
  assert.ok(!single.includes(en.discovery_runtime_onboarding_ambiguous), 'one match is not ambiguous');

  const multiple = renderDrawer(candidate({ nfType: 'AMF' }), [
    runtimeComponent({ componentId: 'comp-1' }),
    runtimeComponent({ componentId: 'comp-2', displayName: 'AMF-2', processName: 'amfd-2' }),
  ]);
  assert.ok(
    multiple.includes(en.discovery_runtime_onboarding_ambiguous.replace('{count}', '2')),
    'several matches must demand an explicit choice',
  );
  assert.ok(!multiple.includes('checked'), 'no component may be silently preselected when several match');
});

test('components the server marks monitoring-not-supported are never selectable', () => {
  const markup = renderDrawer(candidate({ nfType: 'AMF' }), [
    runtimeComponent({ monitoring: { state: 'not_supported', reason: 'no_exporter' } }),
  ]);
  assert.ok(markup.includes('disabled'), 'an unsupported component must render as disabled');
  assert.ok(markup.includes(en.discovery_runtime_onboarding_not_supported), 'the server reason must be visible');
  assert.ok(markup.includes('no_exporter'), 'the raw reason must be quoted');
});

test('runtime unavailability disables onboarding without touching the queue data', () => {
  const markup = renderDrawer(candidate({ nfType: 'AMF' }), [], { runtimeUnavailable: true });
  assert.ok(markup.includes(en.discovery_runtime_onboarding_unavailable), 'the unavailable note must render');
  assert.ok(markup.includes('candidate-link-resource'), 'candidate actions remain available');
  assert.ok(markup.includes(en.discovery_detail_identity), 'candidate identity remains available');
});

/* -------------------------------------------------- queue view render -- */

/* ================================================================
 * Behavioural URL and cursor contract.
 *
 * These tests exercise the real helpers the page is built on: a reading of the
 * query string that a reload or a shared link produces, the same patch function
 * the hook calls on every filter or cursor change, and the same cursor scroll
 * the pager derives from a page envelope. No source-string assertions.
 * ================================================================ */

const DISCOVERY_VIEWS = ['candidates', 'sources', 'runs'] as const;
const URL_KEYS = ['q', 'sourceId', 'state', 'nfType', 'runStatus'];

/* The allow list the hook builds: page filter keys plus view and cursor. */
const DISCOVERY_ALLOW_LIST = [
  ...URL_KEYS,
  OPERATIONS_VIEW_PARAM,
  OPERATIONS_CURSOR_PARAM,
];

function searchOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

test('a shared link restores view, every filter and the cursor', () => {
  const parsed = readOperationsParams(
    '?view=runs&q=lab&sourceId=8a1c2b30-0001&state=stale&nfType=AMF&runStatus=partial&cursor=cur-2',
    DISCOVERY_ALLOW_LIST,
  );
  assert.deepEqual(parsed, {
    view: 'runs',
    q: 'lab',
    sourceId: '8a1c2b30-0001',
    state: 'stale',
    nfType: 'AMF',
    runStatus: 'partial',
    cursor: 'cur-2',
  });
  assert.equal(resolveOperationsView(parsed.view, DISCOVERY_VIEWS, 'candidates'), 'runs');
});

test('an unknown or malformed view degrades to the default candidates queue', () => {
  assert.equal(resolveOperationsView('history', DISCOVERY_VIEWS, 'candidates'), 'candidates');
  assert.equal(resolveOperationsView(null, DISCOVERY_VIEWS, 'candidates'), 'candidates');
  /* A control character is rejected rather than forwarded to a loader. */
  assert.equal(resolveOperationsView('runs\u0000', DISCOVERY_VIEWS, 'candidates'), 'candidates');
});

/* A tiny history stack: each successful patch is one entry, exactly what
 * useSearchParams pushes. Back and forward only re-read an entry. */
function browserHistory(start = '') {
  let params = searchOf(start);
  const entries = [params.toString()];
  let index = 0;
  return {
    navigate(patch: Record<string, string | null>) {
      const result = applyOperationsPatch(params, patch, DISCOVERY_ALLOW_LIST);
      if (!result.changed) return;
      params = searchOf(result.search);
      entries.splice(index + 1);
      entries.push(params.toString());
      index = entries.length - 1;
    },
    back() {
      if (index === 0) return;
      index -= 1;
      params = searchOf(entries[index]);
    },
    forward() {
      if (index >= entries.length - 1) return;
      index += 1;
      params = searchOf(entries[index]);
    },
    read() {
      return readOperationsParams(params.toString(), DISCOVERY_ALLOW_LIST);
    },
    entries() {
      return entries;
    },
  };
}

test('back and forward restore the previous filter set and cursor', () => {
  const session = browserHistory('?view=candidates');
  session.navigate({ sourceId: 'src-1' });
  session.navigate({ cursor: 'cur-1' });

  assert.equal(session.read().sourceId, 'src-1', 'the filter survives the page change');
  assert.equal(session.read().cursor, 'cur-1', 'the cursor is addressable');

  session.back();
  assert.equal(session.read().sourceId, 'src-1', 'back keeps the filter set');
  assert.equal(session.read().cursor, undefined, 'back leaves the cursor page');

  session.back();
  assert.equal(session.read().sourceId, undefined, 'a second back clears the filter');

  session.forward();
  assert.equal(session.read().sourceId, 'src-1', 'forward restores the filter set');
  session.forward();
  assert.equal(session.read().cursor, 'cur-1', 'forward restores the cursor page');
});

test('changing a filter drops the cursor in the same write', () => {
  const result = applyOperationsPatch('?view=candidates&sourceId=src-1&cursor=cur-1', {
    state: 'missing',
  }, DISCOVERY_ALLOW_LIST);

  assert.equal(result.cursorReset, true, 'a filter change must invalidate the cursor');
  const next = readOperationsParams(result.search, DISCOVERY_ALLOW_LIST);
  assert.equal(next.state, 'missing');
  assert.equal(next.sourceId, 'src-1', 'unrelated filters survive');
  assert.equal(next.cursor, undefined, 'page N of a discarded filter set is never requested');
});

test('switching view keeps filters but never keeps the cursor', () => {
  const result = applyOperationsPatch('?sourceId=src-1&cursor=cur-1', {
    view: 'sources',
  }, DISCOVERY_ALLOW_LIST);

  assert.equal(result.cursorReset, true);
  const next = readOperationsParams(result.search, DISCOVERY_ALLOW_LIST);
  assert.equal(next.view, 'sources');
  assert.equal(next.sourceId, 'src-1');
  assert.equal(next.cursor, undefined);
});

test('a cursor-only change does not reset itself', () => {
  const result = applyOperationsPatch('?view=candidates&sourceId=src-1', {
    cursor: 'cur-2',
  }, DISCOVERY_ALLOW_LIST);

  assert.equal(result.cursorReset, false);
  assert.equal(readOperationsParams(result.search, DISCOVERY_ALLOW_LIST).cursor, 'cur-2');
});

/* ------------------------------------------------ cursor paging -- */

/* 60 observed candidates behind a 20-row page: three reachable pages. */
const SIXTY = Array.from({ length: 60 }, (_unused, index) => index + 1);
const PAGE_SIZE = 20;
const PAGES: PageInfo[] = [0, 1, 2].map((page) => {
  const start = page * PAGE_SIZE;
  const hasMore = start + PAGE_SIZE < SIXTY.length;
  return {
    limit: PAGE_SIZE,
    nextCursor: hasMore ? 'cur-' + (start + PAGE_SIZE) : null,
    hasMore,
  };
});

test('every page of a 60-candidate queue is reachable by cursor', () => {
  let scroll = firstScroll();
  const visited: Array<{ page: number; cursor: string | undefined }> = [];

  for (;;) {
    const page = PAGES[scroll.history.length];
    assert.ok(page, 'the walk must never request a page beyond the last one');
    const rows = SIXTY.slice(scroll.history.length * PAGE_SIZE, scroll.history.length * PAGE_SIZE + PAGE_SIZE);
    assert.equal(rows.length, PAGE_SIZE, 'each page is a full bounded page until the last');
    visited.push({ page: pageIndexFor(scroll.history), cursor: scroll.cursor });

    const next = nextScroll(scroll.history, page);
    if (!next) break;
    scroll = next;
  }

  assert.deepEqual(visited, [
    { page: 1, cursor: undefined },
    { page: 2, cursor: 'cur-20' },
    { page: 3, cursor: 'cur-40' },
  ], 'no page is skipped and no phantom page is requested');
  assert.equal(canAdvance(PAGES[2]), false, 'the last page cannot advance');
});

test('previous and first walk back to the same cursors', () => {
  const atThird = { history: ['cur-20', 'cur-40'], cursor: 'cur-40' };
  assert.equal(pageIndexFor(atThird.history), 3);

  const atSecond = previousScroll(atThird.history);
  assert.deepEqual(atSecond, { history: ['cur-20'], cursor: 'cur-20' }, 'previous lands on page 2');

  const atFirst = previousScroll(atSecond.history);
  assert.deepEqual(atFirst, { history: [], cursor: undefined }, 'previous from page 2 requests page 1');

  const alreadyFirst = previousScroll([]);
  assert.deepEqual(alreadyFirst, { history: [], cursor: undefined }, 'previous on page 1 is a no-op');

  assert.deepEqual(firstScroll(), { history: [], cursor: undefined }, 'first always clears the scroll');
});

test('each cursor produces the exact request path the loader sends', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(
      JSON.stringify({ candidates: [], page: { limit: PAGE_SIZE, nextCursor: null, hasMore: false } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    await fetchDiscoveryCandidates({ limit: PAGE_SIZE });
    await fetchDiscoveryCandidates({ limit: PAGE_SIZE, cursor: 'cur-20' });
    await fetchDiscoveryCandidates({ limit: PAGE_SIZE, cursor: 'cur-40', sourceId: 'src-1', observationState: 'seen' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requested, [
    '/api/discovery/candidates?limit=20',
    '/api/discovery/candidates?cursor=cur-20&limit=20',
    '/api/discovery/candidates?sourceId=src-1&observationState=seen&cursor=cur-40&limit=20',
  ], 'the cursor is the only page selector; no offset is ever sent');
});

test('KPIs are indifferent to which page is displayed', () => {
  const fullCollection = discoveryKpisFromSummary({
    completeness: 'complete',
    scope: 'full_collection',
    sources: 4,
    candidates: { seen: 41, missing: 12, stale: 7, linked: 33, unlinked: 27 },
  });

  assert.deepEqual(fullCollection, { sources: 4, seen: 41, missing: 12, linked: 33 });

  /* The projection takes only the summary section, so a 20-row page cannot
   * influence it. An unavailable section yields explicit nulls. */
  const unavailable = discoveryKpisFromSummary(undefined);
  assert.deepEqual(unavailable, { sources: null, seen: null, missing: null, linked: null });
  const partial = discoveryKpisFromSummary({
    completeness: 'unavailable',
    scope: 'full_collection',
    candidates: { seen: 41, missing: 12, stale: 7, linked: 33, unlinked: 27 },
  });
  assert.deepEqual(partial, { sources: null, seen: null, missing: null, linked: null });
});

test('the candidates view renders its toolbar and bounded pager chrome', () => {
  const markup = renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(DiscoveryCandidatesView, {
        filters: { sourceId: '', state: '', nfType: '' },
        onFilterChange: () => {},
        onClearFilters: () => {},
        hasFilters: false,
        cursor: undefined,
        onCursorChange: () => {},
        onOpenCandidate: () => {},
        reloadToken: 0,
      }),
    ),
  );
  assert.ok(markup.includes('data-discovery-view="candidates"'), 'the view container must render');
  assert.ok(markup.includes('data-discovery-source-selector="true"'), 'the source selector must render');
  assert.ok(markup.includes(en.discovery_source_selector_all), 'the all-sources option must render');
  assert.ok(markup.includes(en.discovery_funnel_note), 'the funnel boundary note must render');
});
