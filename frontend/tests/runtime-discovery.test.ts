/*
 * Runtime discovery behaviour tests.
 *
 * The view-model assertions cover the integrity rules that matter to an
 * operator: a display filter never changes a status, an absent measurement is
 * never rendered as zero, and a recognised component is distinguishable from a
 * verified running process.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { RuntimeDiscoveryEmbedded, RuntimeDiscoveryPanel } from '../src/features/runtime/RuntimeDiscovery';
import {
  RUNTIME_CATEGORIES,
  filterComponents,
  formatBytes,
  formatPercent,
  groupByCategory,
  isEvidenceBacked,
  matchesStatus,
  matchesTemplate,
  reasonLabelKey,
  statusLabelKey,
  summarize,
} from '../src/features/runtime/runtime-model';
import type { RuntimeComponent } from '../src/features/runtime/runtime-types';

function component(overrides: Partial<RuntimeComponent>): RuntimeComponent {
  return {
    componentId: 'amf',
    displayName: 'AMF',
    processName: 'amfd',
    matchMethod: 'exact_process_name',
    category: '5gc',
    domain: '5gc',
    role: 'amf',
    nfType: 'AMF',
    cnmsCompatible: true,
    templates: ['auto', '5g'],
    runtimeStatus: 'running',
    statusReason: 'verified_process_running',
    evidence: 'verified',
    verified: true,
    primaryPid: 1201,
    workerCount: 1,
    workers: [{ pid: 1201, exeName: 'amfd' }],
    workersTruncated: false,
    unverifiedWorkers: 0,
    cpuPercent: 2.5,
    cpuAvailable: true,
    cpuBasis: 'interval_delta_verified_group',
    memoryRssBytes: 1048576,
    memoryVmsBytes: 2097152,
    memoryPercent: 0.5,
    memoryAvailable: true,
    memoryBasis: 'verified_group_aggregate',
    lastScannedAt: '2026-01-01T00:00:00Z',
    expectation: 'expected',
    monitoring: { state: 'supported' },
    inventoryAssociation: { state: 'associated', id: 'res-1' },
    nfHealthAssociation: { state: 'absent' },
    ...overrides,
  };
}

test('a display filter never changes a runtime status', () => {
  const running = component({});
  const notDetected = component({
    componentId: 'pgwc',
    displayName: 'PGW-C',
    processName: 'pgwcd',
    category: 'epc',
    domain: 'epc',
    role: 'pgwc',
    nfType: 'PGW-C',
    runtimeStatus: 'not_detected',
    statusReason: 'never_observed',
    evidence: 'none',
    verified: false,
    primaryPid: 0,
    workerCount: 0,
    workers: [],
    cpuPercent: null,
    cpuAvailable: false,
    memoryRssBytes: null,
    memoryVmsBytes: null,
    memoryPercent: null,
    memoryAvailable: false,
    expectation: 'not_expected',
    inventoryAssociation: { state: 'absent' },
    templates: ['auto', '4g'],
  });

  const filtered = filterComponents([running, notDetected], {
    template: 'auto',
    status: 'running',
    query: '',
    category: '',
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].runtimeStatus, 'running');
  // The hidden component keeps its own status: filtering is presentation only.
  assert.equal(notDetected.runtimeStatus, 'not_detected');
});

test('status filters map onto the documented vocabulary', () => {
  assert.ok(matchesStatus(component({ runtimeStatus: 'running' }), 'running'));
  assert.ok(matchesStatus(component({ runtimeStatus: 'stopped' }), 'stopped'));
  assert.ok(matchesStatus(component({ runtimeStatus: 'unverified' }), 'attention'));
  assert.ok(matchesStatus(component({ runtimeStatus: 'permission_denied' }), 'attention'));
  assert.ok(matchesStatus(component({ runtimeStatus: 'stale' }), 'attention'));
  assert.ok(matchesStatus(component({ runtimeStatus: 'not_detected' }), 'not_detected'));
  assert.ok(!matchesStatus(component({ runtimeStatus: 'not_detected' }), 'running'));
  assert.ok(matchesStatus(component({ runtimeStatus: 'running' }), ''));
});

test('template membership follows the server profile', () => {
  const imsHss = component({
    componentId: 'imsHss',
    displayName: 'IMS HSS',
    processName: 'java',
    category: 'ims',
    domain: 'ims',
    role: 'hss',
    templates: ['auto', '5g', '4g', 'ims'],
    monitoring: { state: 'not_supported', reason: 'ambiguous_java_identity_and_domain_role_contract' },
  });
  assert.ok(matchesTemplate(imsHss, 'ims'));
  assert.ok(matchesTemplate(imsHss, '4g'));
  assert.ok(matchesTemplate(imsHss, 'auto'));
  assert.ok(!matchesTemplate(component({}), 'ims'));
});

test('grouping is stable and category driven', () => {
  const groups = groupByCategory([
    component({ componentId: 'ocs', displayName: 'OCS', processName: 'ocsd', category: 'charging', domain: 'charging' }),
    component({ componentId: 'dra', displayName: 'DRA', processName: 'drad', category: 'support', domain: 'shared', runtimeStatus: 'running' }),
    component({}),
  ]);
  assert.deepEqual(groups.map((group) => group.category), ['5gc', 'charging', 'support']);
  assert.deepEqual(RUNTIME_CATEGORIES, ['epc', '5gc', 'ims', 'charging', 'support']);
});

test('summary counts evidence-backed states separately', () => {
  const summary = summarize([
    component({}),
    component({ componentId: 'smf', displayName: 'SMF', processName: 'smfd', runtimeStatus: 'stopped', verified: false }),
    component({ componentId: 'upf', displayName: 'UPF', processName: 'upfd', runtimeStatus: 'unverified', verified: false }),
    component({ componentId: 'pgwc', displayName: 'PGW-C', processName: 'pgwcd', runtimeStatus: 'not_detected', verified: false }),
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.running, 1);
  assert.equal(summary.stopped, 1);
  assert.equal(summary.attention, 1);
  assert.equal(summary.notDetected, 1);
  assert.equal(summary.monitored, 0);
  assert.equal(summary.associated, 4);
});

test('an absent measurement is never rendered as zero', () => {
  assert.equal(formatBytes(null), '');
  assert.equal(formatBytes(undefined), '');
  assert.equal(formatPercent(null), '');
  assert.equal(formatPercent(undefined), '');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatPercent(12.4), '12%');
});

test('evidence-backed statuses are exactly the accepted observations', () => {
  assert.ok(isEvidenceBacked('running'));
  assert.ok(isEvidenceBacked('stopped'));
  assert.ok(isEvidenceBacked('unverified'));
  assert.ok(isEvidenceBacked('stale'));
  assert.ok(!isEvidenceBacked('not_detected'));
  assert.ok(!isEvidenceBacked('not_configured'));
  assert.ok(!isEvidenceBacked('permission_denied'));
});

test('label keys are derived, never hard-coded labels', () => {
  assert.equal(statusLabelKey('permission_denied'), 'runtime_status_permission_denied');
  assert.equal(reasonLabelKey('scan_incomplete'), 'runtime_reason_scan_incomplete');
  assert.equal(reasonLabelKey(''), 'runtime_reason_unknown');
});

test('the runtime surface renders its localized shell without network access', () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        I18nProvider,
        null,
        createElement(AuthProvider, null, createElement(RuntimeDiscoveryPanel)),
      ),
    ),
  );
  assert.ok(html.includes('data-testid="runtime-discovery"'), 'runtime surface must render');
  assert.ok(html.includes('Local runtime observation'), 'the surface must carry its localized title');
});

test('the embedded runtime surface leaves the panel title to its parent', () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        I18nProvider,
        null,
        createElement(AuthProvider, null, createElement(RuntimeDiscoveryEmbedded)),
      ),
    ),
  );
  assert.ok(html.includes('data-testid="runtime-discovery-embedded"'), 'embedded surface must render');
  assert.ok(!html.includes('Local runtime observation'), 'embedded surface must not repeat the panel title');
});
