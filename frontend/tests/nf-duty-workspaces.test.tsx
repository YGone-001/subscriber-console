/*
 * NF Health and NF Alerts duty-workspace contracts.
 *
 * The duty surfaces show one representation at a time, read one bounded list
 * per view, and put the whole scan order in the server's hands. These tests
 * render the real pages and exercise the real URL/query helpers; nothing here
 * asserts on source strings.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { NfHealthPage } from '../src/features/nf-health/NfHealthPage';
import { NfAlertsPage } from '../src/features/nf-alerts/NfAlertsPage';
import { NfAlertEvidenceDrawer } from '../src/features/nf-alerts/NfAlertEvidenceDrawer';
import {
  DEFAULT_HEALTH_SORT,
  DEFAULT_HEALTH_VIEW,
  HEALTH_URL_KEYS,
  hasHealthFilters,
  healthInterfaceQuery,
  healthTargetQuery,
  healthView,
  readHealthFilters,
} from '../src/features/nf-health/nf-health-filters';
import {
  buildCreateTargetRequest,
  createEmptyTargetForm,
} from '../src/features/nf-health/nf-health-builders';
import { validateProbes } from '../src/features/nf-health/nf-health-validation';
import {
  alertListQuery,
  alertScope,
  alertSort,
  alertView,
  readAlertFilters,
} from '../src/features/nf-alerts/nf-alert-views';
import type { Alert } from '../src/features/nf-alerts/nf-alerts-types';
import { en } from '../src/lib/locales/en';
import { zh } from '../src/lib/locales/zh';

function renderRoute(path: string, element: React.ReactElement): string {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('a duty view must not call fetch during render');
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
            createElement(Routes, null, createElement(Route, { path: path.split('?')[0], element })),
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

const renderHealth = (path: string) => renderRoute(path, createElement(NfHealthPage));
const renderAlerts = (path: string) => renderRoute(path, createElement(NfAlertsPage));

/* ------------------------------------------------ health page views -- */

test('the health page opens on the card queue and never renders the audit table', () => {
  const markup = renderHealth('/nf-health');
  assert.ok(markup.includes('data-nf-health-panel="cards"'), 'the duty panel must render');
  assert.ok(markup.includes('aria-pressed="true"'), 'one view must be pressed');
  assert.ok(!markup.includes('data-nf-health-panel="table"'), 'the table panel must not render');
  assert.ok(!markup.includes('<table'), 'the audit table is a different view');
  assert.equal(
    markup.split('data-operations-refresh="page"').length - 1,
    1,
    'the page exposes exactly one refresh control',
  );
});

test('the table view replaces the card queue instead of stacking below it', () => {
  const markup = renderHealth('/nf-health?view=table');
  assert.ok(markup.includes('data-nf-health-panel="table"'), 'the table panel must render');
  assert.ok(!markup.includes('data-nf-health-panel="cards"'), 'the card queue must not render behind the table');
  assert.ok(markup.includes('nf_health_col_l3') === false, 'rendered labels, not keys');
});

test('an unknown health view falls back to the cards', () => {
  assert.equal(healthView('timeline'), DEFAULT_HEALTH_VIEW);
  assert.equal(healthView(undefined), DEFAULT_HEALTH_VIEW);
});

/* ---------------------------------------------- health filter contract -- */

test('a shared health link restores every filter and the order', () => {
  const filters = readHealthFilters({
    q: 'amf',
    enabled: 'true',
    domain: '5gc',
    state: 'degraded',
    layers: 'l2',
    sort: 'updated',
  });
  assert.deepEqual(filters, {
    q: 'amf',
    enabled: 'true',
    domain: '5gc',
    overall: 'degraded',
    layer: 'l2',
    sort: 'updated',
  });
  assert.equal(hasHealthFilters(filters), true);

  const query = healthTargetQuery(filters, 'cur-2', 20);
  assert.deepEqual(query, {
    q: 'amf',
    enabled: 'true',
    domain: '5gc',
    state: 'degraded',
    layers: 'l2',
    sort: 'updated',
    cursor: 'cur-2',
    limit: 20,
  });
});

test('the default health request asks the server for the risk order', () => {
  const filters = readHealthFilters({});
  assert.equal(filters.sort, DEFAULT_HEALTH_SORT);
  assert.equal(filters.sort, 'risk');
  const query = healthTargetQuery(filters, undefined, 20);
  assert.equal(query.sort, 'risk');
  assert.equal(query.state, undefined, 'no overall filter is invented');
  assert.equal(query.layers, undefined);
});

test('the legacy collection filter still works and bad values are dropped', () => {
  // Pre-view links used state=enabled|disabled for the collection filter.
  const legacy = readHealthFilters({ state: 'enabled' });
  assert.equal(legacy.enabled, 'true');
  assert.equal(legacy.overall, '');

  const invalid = readHealthFilters({ state: 'melted', layers: 'l9', sort: 'newest', enabled: 'maybe' });
  assert.equal(invalid.overall, '');
  assert.equal(invalid.layer, '');
  assert.equal(invalid.enabled, '');
  assert.equal(invalid.sort, 'risk', 'an invalid order falls back to the server-defined default');

  const query = healthTargetQuery(invalid, undefined, 20);
  assert.equal(query.state, undefined, 'a stale link must not become a 400');
  assert.equal(query.layers, undefined);
});

test('the health URL vocabulary is the one the page reads', () => {
  assert.deepEqual([...HEALTH_URL_KEYS], ['q', 'enabled', 'domain', 'state', 'layers', 'sort']);
});

/* -------------------------------------------- health interface matrix -- */

test('the interface matrix is a third view and never stacks on the other two', () => {
  assert.equal(healthView('interfaces'), 'interfaces');
  const markup = renderHealth('/nf-health?view=interfaces');
  assert.ok(markup.includes('data-nf-health-view="interfaces"'), 'the view control is present');
  assert.ok(!markup.includes('data-nf-health-panel="cards"'), 'the card queue must not render behind the matrix');
  assert.ok(!markup.includes('data-nf-health-panel="table"'), 'the audit table must not render behind the matrix');
});

test('the matrix query keeps the duty filters and drops list-only ones', () => {
  const filters = readHealthFilters({
    q: 'amf',
    domain: '5gc',
    state: 'unhealthy',
    layers: 'l2',
    sort: 'risk',
  });
  assert.deepEqual(healthInterfaceQuery(filters, 'cursor-1', 20), {
    q: 'amf',
    domain: '5gc',
    sort: 'risk',
    cursor: 'cursor-1',
    limit: 20,
  });
});

test('declared interface probes round-trip through the target form', () => {
  const form = createEmptyTargetForm(120);
  form.resourceId = 'resource-1';
  form.name = 'amf-01';
  form.metricsDestination = '127.0.0.1:9090';
  form.probes = [
    { family: 'sbi', destination: '127.0.0.1:9091', path: '/sbi' },
    { family: 'oam', destination: '', path: '/oam' },
  ];
  const request = buildCreateTargetRequest(form);
  assert.deepEqual(request.probes, [{ family: 'sbi', url: 'http://127.0.0.1:9091/sbi' }]);
});

test('probe validation rejects a duplicate family and a missing destination', () => {
  const valid = [{ family: 'sbi' as const, destination: '127.0.0.1:9091', path: '/sbi' }];
  assert.equal(validateProbes(valid, null), null);
  assert.equal(
    validateProbes([...valid, { family: 'sbi' as const, destination: '127.0.0.1:9092', path: '/sbi' }], null),
    'nf_health_validation_probe_duplicate',
  );
  assert.equal(
    validateProbes([{ family: 'oam' as const, destination: ' ', path: '/oam' }], null),
    'nf_health_validation_probe_destination_required',
  );
  assert.equal(validateProbes(valid, null, true), 'nf_health_validation_probes_process_only');
});

/* ------------------------------------------------ alert page views -- */

test('the alerts page opens on the open queue and hides rules', () => {
  const markup = renderAlerts('/nf-alerts');
  assert.ok(markup.includes('data-nf-alert-panel="open"'), 'the duty queue must render');
  assert.ok(!markup.includes('data-nf-alert-panel="rules"'), 'rules are a different view');
  assert.ok(markup.includes('aria-pressed="true"'), 'one view must be pressed');
  assert.equal(
    markup.split('data-operations-refresh="page"').length - 1,
    1,
    'the page exposes exactly one refresh control',
  );
});

test('history and rules replace the queue rather than stacking below it', () => {
  const history = renderAlerts('/nf-alerts?view=history');
  assert.ok(history.includes('data-nf-alert-panel="history"'));
  assert.ok(!history.includes('data-nf-alert-panel="open"'));

  const rules = renderAlerts('/nf-alerts?view=rules');
  assert.ok(rules.includes('data-nf-alert-panel="rules"'));
  assert.ok(!rules.includes('data-nf-alert-panel="open"'));
  assert.ok(!rules.includes('data-nf-alert-panel="history"'));
  assert.ok(rules.includes('nf_alerts_rules_caption') === false, 'rendered labels, not keys');
});

test('an unknown alert view falls back to the open queue', () => {
  assert.equal(alertView('closed'), 'open');
  assert.equal(alertView(undefined), 'open');
});

/* ----------------------------------------------- alert read contract -- */

test('each alert view asks for its own population and order', () => {
  const filters = readAlertFilters({ severity: 'critical' });

  assert.equal(alertScope('open'), 'open');
  assert.equal(alertScope('history'), 'history');
  assert.equal(alertScope('rules'), undefined, 'rules read a different collection');

  assert.equal(alertSort('open'), 'risk');
  assert.equal(alertSort('history'), 'updated');

  assert.deepEqual(alertListQuery('open', filters, undefined, 20), {
    scope: 'open',
    sort: 'risk',
    severity: 'critical',
    cursor: undefined,
    limit: 20,
  });
  assert.deepEqual(alertListQuery('history', filters, 'cur-1', 20), {
    scope: 'history',
    sort: 'updated',
    severity: 'critical',
    cursor: 'cur-1',
    limit: 20,
  });
  assert.deepEqual(alertListQuery('rules', filters, undefined, 20), {
    scope: undefined,
    sort: 'updated',
    severity: undefined,
    cursor: undefined,
    limit: 20,
  });
});

test('an unknown severity filter is dropped instead of forwarded', () => {
  const filters = readAlertFilters({ severity: 'emergency' });
  assert.equal(filters.severity, '');
  assert.equal(alertListQuery('open', filters, undefined, 20).severity, undefined);
});

/* ------------------------------------------------- evidence drawer -- */

function evidenceAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    alertId: 'alert-1',
    schemaVersion: 1,
    ruleId: 'rule-1',
    ruleName: 'AMF process unhealthy',
    targetId: 'target-1',
    targetName: 'amf-01',
    severity: 'critical',
    state: 'active',
    conditionType: 'state',
    condition: { scope: 'process', state: 'unhealthy' },
    triggerCount: 3,
    firstTriggeredAt: '2026-10-19T08:00:00Z',
    lastTriggeredAt: '2026-10-19T09:00:00Z',
    evidence: {
      runStatus: 'partial',
      sampleId: 'sample-9',
      collectedAt: '2026-10-19T08:59:00Z',
      overallState: 'unhealthy',
      layers: {
        process: { state: 'unhealthy', evidenceKind: 'process', measured: true },
        interface: { state: 'healthy', evidenceKind: 'http_metrics', measured: true },
        service: { state: 'not_configured', evidenceKind: 'none', measured: false },
      },
    },
    updatedAt: '2026-10-19T09:00:00Z',
    ...overrides,
  };
}

function renderDrawer(alert: Alert, canConfigure: boolean): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        I18nProvider,
        null,
        createElement(NfAlertEvidenceDrawer, {
          alert,
          canConfigure,
          busy: false,
          onClose: () => {},
          onAcknowledge: () => {},
          onResolve: () => {},
        }),
      ),
    ),
  );
}

test('the drawer shows the immutable snapshot and the lifecycle together', () => {
  const markup = renderDrawer(evidenceAlert(), true);
  assert.ok(markup.includes(en.nf_alerts_drawer_evidence), 'evidence section');
  assert.ok(markup.includes('sample-9'), 'sample identity');
  assert.ok(markup.includes(en.nf_alerts_evidence_immutable), 'the read-only boundary is stated');
  assert.ok(markup.includes(en.nf_alerts_lifecycle_last), 'lifecycle section');
  assert.ok(markup.includes('amf-01'), 'subject');
  assert.ok(markup.includes('/nf-health/target-1'), 'the subject links to the target');
});

test('the drawer offers acknowledge and resolve only where they apply', () => {
  // Action labels also appear as lifecycle values ("Acknowledged"), so the
  // assertion looks for the rendered button label, not a substring.
  const action = (markup: string, label: string) => markup.includes(`>${label}</button>`);

  const active = renderDrawer(evidenceAlert(), true);
  assert.ok(action(active, en.nf_alerts_acknowledge_action), 'active alerts can be acknowledged');
  assert.ok(action(active, en.nf_alerts_resolve_action), 'active alerts can be resolved');

  const acknowledged = renderDrawer(evidenceAlert({ state: 'acknowledged', acknowledgedAt: '2026-10-19T09:30:00Z' }), true);
  assert.ok(!action(acknowledged, en.nf_alerts_acknowledge_action), 'acknowledging twice is not an action');
  assert.ok(action(acknowledged, en.nf_alerts_resolve_action), 'an acknowledged alert can still be resolved');

  const resolved = renderDrawer(evidenceAlert({ state: 'resolved', resolvedAt: '2026-10-19T10:00:00Z', resolvedReason: 'recovery' }), true);
  assert.ok(!action(resolved, en.nf_alerts_resolve_action), 'a resolved alert has no action left');
  assert.ok(resolved.includes(en.nf_alerts_resolve_recovery), 'the resolve reason is named');

  const viewer = renderDrawer(evidenceAlert(), false);
  assert.ok(!action(viewer, en.nf_alerts_acknowledge_action), 'a read-only session gets no mutation control');
  assert.ok(!action(viewer, en.nf_alerts_resolve_action));
});

test('both locales define the duty vocabulary', () => {
  for (const key of [
    'nf_health_view_cards',
    'nf_health_view_table',
    'nf_health_filter_overall',
    'nf_health_filter_layers',
    'nf_health_sort_risk',
    'nf_health_sort_risk_note',
    'nf_alerts_view_open',
    'nf_alerts_view_history',
    'nf_alerts_view_rules',
    'nf_alerts_drawer_evidence',
    'nf_alerts_evidence_immutable',
    'nf_alerts_open_detail',
  ]) {
    assert.ok(key in en, `en locale must define ${key}`);
    assert.ok(key in zh, `zh locale must define ${key}`);
  }
});
