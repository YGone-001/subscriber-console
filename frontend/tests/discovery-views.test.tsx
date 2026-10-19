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
