/*
 * Architecture projection and operational navigation tests.
 *
 * These exercise the pure projection model against fixtures built through the
 * real join path (buildOperationalResources), then render the canvas and the
 * navigation server-side and assert operator-observable output. `fetch` is
 * replaced by a throwing stub so the suite also proves the presentational
 * surfaces never reach for the network on their own.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { OperationsNav } from '../src/features/operations/OperationsNav';
import { ArchitectureCanvas, placeLinkLabel } from '../src/features/topology/components/ArchitectureCanvas';
import {
  bindingLabelKey,
  filterArchitecture,
  normalizeToken,
  resolveArchitecture,
  stateLabelKey,
} from '../src/features/topology/architecture-model';
import {
  ARCHITECTURE_LINKS,
  ARCHITECTURE_NODES,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
} from '../src/features/topology/reference-architecture';
import {
  buildOperationalResources,
  type OperationalResource,
} from '../src/features/operations/operational-model';
import { en } from '../src/lib/locales/en';
import { zh } from '../src/lib/locales/zh';

const AMF = '11111111-1111-4111-8111-111111111111';
const SMF = '22222222-2222-4222-8222-222222222222';
const HSS_EPC = '33333333-3333-4333-8333-333333333333';
const HSS_IMS = '44444444-4444-4444-8444-444444444444';

type RawResource = Record<string, unknown>;

function resource(overrides: RawResource = {}): RawResource {
  return {
    _id: AMF,
    kind: 'network_function',
    name: 'amf-01',
    domain: '5gc',
    role: 'amf',
    lifecycleState: 'active',
    ...overrides,
  };
}

function target(overrides: RawResource = {}): RawResource {
  return {
    resourceId: AMF,
    targetId: 'target-amf',
    enabled: true,
    overallState: 'healthy',
    statusComplete: true,
    coverage: { l1Measured: true, l2Measured: false, l3Measured: false, l3Available: true },
    freshness: { state: 'fresh', ageSeconds: 12, policySeconds: 300, reason: 'within policy' },
    layers: {
      process: { state: 'healthy', measured: true, evidenceKind: 'process' },
      interface: { state: 'not_configured', measured: false, evidenceKind: 'none' },
      service: { state: 'unknown', measured: false, evidenceKind: 'none' },
    },
    resourceMetrics: [
      {
        key: 'process_resident_memory_bytes',
        value: 536870912,
        unit: 'bytes',
        type: 'gauge',
        collectedAt: '2026-10-18T00:00:00Z',
      },
      {
        key: 'process_cpu_seconds_total',
        value: 4210,
        unit: 'seconds',
        type: 'counter',
        collectedAt: '2026-10-18T00:00:00Z',
      },
    ],
    ...overrides,
  };
}

function items(resources: RawResource[], targets: RawResource[] = []): OperationalResource[] {
  return buildOperationalResources(resources, targets, true).items;
}

/* ------------------------------------------------------------- reference -- */

test('the reference skeleton is internally consistent', () => {
  assert.equal(ARCHITECTURE_NODES.length, 20, 'the reference architecture defines twenty roles');
  const roles = new Set(ARCHITECTURE_NODES.map((node) => node.role));
  assert.equal(roles.size, 20, 'role keys must be unique');

  for (const link of ARCHITECTURE_LINKS) {
    assert.ok(roles.has(link.source), `link source ${link.source} must be a known role`);
    assert.ok(roles.has(link.target), `link target ${link.target} must be a known role`);
    assert.notEqual(link.source, link.target, 'a reference point cannot loop onto itself');
    assert.ok(link.interfaceLabel.length > 0, 'every reference point must carry a label');
  }
  assert.ok(ARCHITECTURE_LINKS.length >= 30, 'the skeleton must cover the main reference points');
});

test('every node sits inside the canvas and no two nodes overlap', () => {
  for (const node of ARCHITECTURE_NODES) {
    assert.ok(node.x >= 0 && node.x + NODE_WIDTH <= CANVAS_WIDTH, `${node.role} must fit horizontally`);
    assert.ok(node.y >= 0 && node.y + NODE_HEIGHT <= CANVAS_HEIGHT, `${node.role} must fit vertically`);
  }
  for (let i = 0; i < ARCHITECTURE_NODES.length; i += 1) {
    for (let j = i + 1; j < ARCHITECTURE_NODES.length; j += 1) {
      const left = ARCHITECTURE_NODES[i];
      const right = ARCHITECTURE_NODES[j];
      const overlap = Math.abs(left.x - right.x) < NODE_WIDTH && Math.abs(left.y - right.y) < NODE_HEIGHT;
      assert.equal(overlap, false, `${left.role} and ${right.role} must not overlap`);
    }
  }
});

/* ---------------------------------------------------------------- binding -- */

test('an explicit Inventory role binds a role token', () => {
  const projection = resolveArchitecture({ resources: items([resource({ role: 'SGW-C', name: 'sgwc-node', domain: 'epc' })]) });
  const sgwc = projection.nodes.find((node) => node.role === 'sgw-c');
  assert.ok(sgwc);
  assert.equal(sgwc.binding, 'bound');
  assert.equal(sgwc.resourceName, 'sgwc-node');
  assert.equal(sgwc.bindingSource, 'inventory');
});

test('a normalized resource-name prefix binds when no role is set', () => {
  const projection = resolveArchitecture({ resources: items([resource({ role: '', name: 'AMF-01' })]) });
  const amf = projection.nodes.find((node) => node.role === 'amf');
  assert.equal(amf?.binding, 'bound');
  assert.equal(amf?.resourceName, 'AMF-01');
});

test('an equal-ranked duplicate is reported as ambiguous, not silently chosen', () => {
  const projection = resolveArchitecture({
    resources: items([
      resource({ _id: AMF, name: 'smf-01', role: '', domain: '5gc' }),
      resource({ _id: SMF, name: 'smf-02', role: '', domain: '5gc' }),
    ]),
  });
  const smf = projection.nodes.find((node) => node.role === 'smf');
  assert.equal(smf?.binding, 'ambiguous');
  assert.equal(smf?.candidateCount, 2);
  assert.ok(smf?.resourceId, 'the deterministic first candidate is still rendered');
});

test('the expected Inventory domain breaks a name tie', () => {
  const projection = resolveArchitecture({
    resources: items([
      resource({ _id: HSS_IMS, name: 'hss-ims', role: '', domain: 'ims' }),
      resource({ _id: HSS_EPC, name: 'hss-epc', role: '', domain: 'epc' }),
    ]),
  });
  const hss = projection.nodes.find((node) => node.role === 'hss');
  assert.equal(hss?.binding, 'bound');
  assert.equal(hss?.resourceId, HSS_EPC);
});

test('retired and non-network-function resources never bind', () => {
  const projection = resolveArchitecture({
    resources: items([
      resource({ _id: AMF, name: 'amf-01', role: 'amf', lifecycleState: 'retired' }),
      resource({ _id: SMF, name: 'smf-host', role: 'smf', kind: 'host' }),
    ]),
  });
  assert.equal(projection.nodes.find((node) => node.role === 'amf')?.binding, 'unbound');
  assert.equal(projection.nodes.find((node) => node.role === 'smf')?.binding, 'unbound');
});

test('an authoritative runtime association outranks name matching', () => {
  const components = [{
    componentId: 'amfd',
    processName: 'amfd',
    nfType: 'AMF',
    role: 'amf',
    runtimeStatus: 'running',
    verified: true,
    inventoryAssociation: { state: 'associated', id: SMF },
  }];
  const projection = resolveArchitecture({
    resources: items([
      resource({ _id: AMF, name: 'amf-01' }),
      resource({ _id: SMF, name: 'canonical-amf', role: '', domain: '5gc' }),
    ]),
    runtimeComponents: components,
  });
  const amf = projection.nodes.find((node) => node.role === 'amf');
  assert.equal(amf?.resourceId, SMF, 'the server-resolved association wins');
  assert.equal(amf?.bindingSource, 'runtime');
});

test('a role with no resource is unregistered, never stopped', () => {
  const projection = resolveArchitecture({ resources: items([]) });
  const amf = projection.nodes.find((node) => node.role === 'amf');
  assert.equal(amf?.binding, 'unbound');
  assert.equal(amf?.tone, 'unregistered');
  assert.equal(amf?.observed, null);
  assert.equal(stateLabelKey(amf!.tone), 'arch_state_unregistered');
});

test('a verified running process without a resource is observed, not healthy', () => {
  const projection = resolveArchitecture({
    resources: items([]),
    runtimeComponents: [{
      componentId: 'amfd',
      processName: 'amfd',
      nfType: 'AMF',
      role: 'amf',
      runtimeStatus: 'running',
      verified: true,
      inventoryAssociation: { state: 'absent' },
    }],
  });
  const amf = projection.nodes.find((node) => node.role === 'amf');
  assert.equal(amf?.tone, 'observed');
  assert.equal(amf?.observed?.processName, 'amfd');
  assert.equal(amf?.targetId, null, 'an observed process is not a monitoring target');
  assert.equal(projection.summary.observedUnmanaged, 1);
});

test('an unverified process never counts as observed', () => {
  const projection = resolveArchitecture({
    resources: items([]),
    runtimeComponents: [{
      componentId: 'amfd',
      processName: 'amfd',
      role: 'amf',
      runtimeStatus: 'running',
      verified: false,
      inventoryAssociation: { state: 'absent' },
    }],
  });
  assert.equal(projection.nodes.find((node) => node.role === 'amf')?.tone, 'unregistered');
});

/* ------------------------------------------------------------ state tones -- */

test('monitoring state maps onto distinct tones and never collapses unresolved', () => {
  const cases: Array<[RawResource | null, string]> = [
    [null, 'unmonitored'],
    [target({ overallState: 'healthy' }), 'healthy'],
    [target({ overallState: 'degraded' }), 'degraded'],
    [target({ overallState: 'unhealthy' }), 'unhealthy'],
    [target({ overallState: 'stale' }), 'stale'],
    [target({ overallState: 'not_configured' }), 'unknown'],
    [target({ overallState: '' }), 'unknown'],
  ];
  for (const [targetDoc, expected] of cases) {
    const projection = resolveArchitecture({
      resources: items([resource()], targetDoc ? [targetDoc] : []),
    });
    assert.equal(projection.nodes.find((node) => node.role === 'amf')?.tone, expected);
  }
});

test('an unresolved association lookup is reported as unresolved', () => {
  const unresolved = buildOperationalResources([resource()], [], false).items;
  const projection = resolveArchitecture({ resources: unresolved });
  const amf = projection.nodes.find((node) => node.role === 'amf');
  assert.equal(amf?.tone, 'unresolved');
  assert.equal(stateLabelKey(amf!.tone), 'ops_state_unresolved');
  assert.equal(projection.summary.unresolved, 1);
});

test('coverage and metrics are projected from the monitoring target', () => {
  const projection = resolveArchitecture({ resources: items([resource()], [target()]) });
  const amf = projection.nodes.find((node) => node.role === 'amf');
  assert.deepEqual(amf?.coverage, { l1: true, l2: false, l3: false });
  assert.equal(amf?.memory?.value, 536870912);
  assert.equal(amf?.cpu?.type, 'counter', 'cumulative CPU time is never presented as a percentage');
  assert.equal(amf?.freshness, 'fresh');
  assert.equal(amf?.targetId, 'target-amf');
});

/* ------------------------------------------------------------------ links -- */

test('a reference point is declared only when a connectivity relationship exists', () => {
  const projection = resolveArchitecture({
    resources: items([resource(), resource({ _id: SMF, name: 'smf-01', role: 'smf' })]),
    edges: [{ relationshipType: 'connects_to', fromResourceId: AMF, toResourceId: SMF, lifecycleState: 'active' }],
  });
  const n11 = projection.links.find((link) => link.source === 'amf' && link.target === 'smf');
  assert.equal(n11?.declared, true);
  assert.equal(n11?.endpointsBound, true);
  assert.equal(n11?.interfaceLabel, 'N11');

  const n4 = projection.links.find((link) => link.source === 'smf' && link.target === 'upf');
  assert.equal(n4?.declared, false, 'an unbound endpoint can never be a declared relationship');
});

test('containment, hosting and retired edges never declare connectivity', () => {
  const projection = resolveArchitecture({
    resources: items([resource(), resource({ _id: SMF, name: 'smf-01', role: 'smf' })]),
    edges: [
      { relationshipType: 'contains', fromResourceId: AMF, toResourceId: SMF, lifecycleState: 'active' },
      { relationshipType: 'runs_on', fromResourceId: AMF, toResourceId: SMF, lifecycleState: 'active' },
      { relationshipType: 'connects_to', fromResourceId: AMF, toResourceId: SMF, lifecycleState: 'retired' },
    ],
  });
  const n11 = projection.links.find((link) => link.source === 'amf' && link.target === 'smf');
  assert.equal(n11?.declared, false);
});

test('a declared relationship is symmetric for the reference point', () => {
  const projection = resolveArchitecture({
    resources: items([resource(), resource({ _id: SMF, name: 'smf-01', role: 'smf' })]),
    edges: [{ relationshipType: 'depends_on', fromResourceId: SMF, toResourceId: AMF, lifecycleState: 'active' }],
  });
  const n11 = projection.links.find((link) => link.source === 'amf' && link.target === 'smf');
  assert.equal(n11?.declared, true, 'the reference point does not depend on edge direction');
});

test('every reference point label finds an anchor that avoids the node boxes', () => {
  const projection = resolveArchitecture({ resources: items([]) });
  const centre = (role: string) => {
    const node = projection.nodes.find((entry) => entry.role === role)!;
    return { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 };
  };
  for (const link of projection.links) {
    const anchor = placeLinkLabel(centre(link.source), centre(link.target), projection.nodes);
    for (const node of projection.nodes) {
      const overlaps = anchor.x >= node.x
        && anchor.x <= node.x + NODE_WIDTH
        && anchor.y >= node.y
        && anchor.y <= node.y + NODE_HEIGHT;
      assert.equal(overlaps, false, `${link.key} label must not sit on ${node.role}`);
    }
  }
});

/* ------------------------------------------------------------- view filter -- */
test('architecture views filter roles and drop dangling links', () => {
  const projection = resolveArchitecture({ resources: items([]) });
  const epc = filterArchitecture(projection, 'epc');
  assert.equal(epc.nodes.length, 9);
  assert.equal(epc.hiddenCount, 11);
  for (const link of epc.links) {
    assert.ok(epc.nodes.some((node) => node.role === link.source));
    assert.ok(epc.nodes.some((node) => node.role === link.target));
  }

  const sa = filterArchitecture(projection, '5gc-sa');
  assert.equal(sa.nodes.length, 11);
  assert.ok(!sa.nodes.some((node) => node.role === 'mme'));

  const all = filterArchitecture(projection, 'all');
  assert.equal(all.nodes.length, 20);
  assert.equal(all.hiddenCount, 0);
});

test('the summary counts bound, unbound and observed roles separately', () => {
  const projection = resolveArchitecture({
    resources: items([resource()], [target({ overallState: 'degraded' })]),
  });
  assert.equal(projection.summary.total, 20);
  assert.equal(projection.summary.bound, 1);
  assert.equal(projection.summary.unbound, 19);
  assert.equal(projection.summary.monitored, 1);
  assert.equal(projection.summary.degraded, 1);
});

test('token normalization folds punctuation and case', () => {
  assert.equal(normalizeToken('SGW-C'), 'sgwc');
  assert.equal(normalizeToken('sgw_c'), 'sgwc');
  assert.equal(normalizeToken(''), '');
  assert.equal(bindingLabelKey('ambiguous'), 'arch_binding_ambiguous');
});

/* ----------------------------------------------------------------- render -- */

function render(element: ReactElement): string {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('an operational presentational surface must not call fetch during render');
  }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(createElement(I18nProvider, null, element));
    assert.equal(calls, 0, 'rendering must not perform network access');
    return markup;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('the canvas renders role labels, states and keyboard-reachable nodes', () => {
  const projection = resolveArchitecture({
    resources: items([resource()], [target()]),
  });
  const markup = render(createElement(ArchitectureCanvas, {
    nodes: projection.nodes,
    links: projection.links,
  }));
  assert.ok(markup.includes('AMF'), 'the role label must render');
  assert.ok(markup.includes('N11'), 'the reference point label must render');
  assert.ok(markup.includes('role="img"'), 'the canvas must expose an accessible role');
  assert.ok(markup.includes('tabindex="0"'), 'nodes must be keyboard reachable');
  assert.ok(markup.includes('role="button"'), 'nodes must be operable');
  assert.ok(markup.includes('Healthy') || markup.includes('healthy'), 'the measured state must be labelled');
  assert.ok(markup.includes('Not registered'), 'unregistered roles must say so');
});

test('the operational navigation renders the four canonical destinations', () => {
  const markup = render(createElement(
    MemoryRouter,
    { initialEntries: ['/topology'] },
    createElement(OperationsNav),
  ));
  for (const href of ['/inventory', '/topology', '/discovery', '/nf-health']) {
    assert.ok(markup.includes(`href="${href}"`), `${href} must be reachable from the workbench`);
  }
  assert.ok(markup.includes('Operational sections'), 'the navigation must carry an accessible name');
});

/* ------------------------------------------------------------------- i18n -- */

test('architecture locale keys exist in both languages and are distinct', () => {
  const keys = [
    'ops_nav_label', 'ops_presentation_cards', 'ops_unmanaged_title',
    'arch_title', 'arch_note', 'arch_canvas_aria', 'arch_canvas_desc',
    'arch_view_all', 'arch_view_epc', 'arch_view_5gc_sa', 'arch_view_5gc_nsa',
    'arch_hidden_note', 'arch_summary_bound',
    'arch_domain_cp', 'arch_domain_sp', 'arch_domain_up', 'arch_domain_dm', 'arch_domain_legacy',
    'arch_state_unregistered', 'arch_state_observed', 'arch_state_unmonitored',
    'arch_binding_bound', 'arch_binding_ambiguous', 'arch_binding_unbound',
    'arch_detail_hint', 'arch_detail_unbound_body', 'arch_detail_observed_body',
    'arch_detail_ambiguous_body', 'arch_coverage_note',
  ];
  const optional = new Set(['arch_view_epc', 'arch_view_5gc_sa', 'arch_view_5gc_nsa']);
  for (const key of keys) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en must define ${key}`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh must define ${key}`);
    // Architecture view names are protocol acronyms and are intentionally shared.
    if (optional.has(key)) continue;
    assert.notEqual(en[key], zh[key], `${key} must be localized in both languages`);
  }
  assert.ok(/[\u4e00-\u9fff]/.test(zh.arch_title), 'the Chinese title must contain Chinese characters');
});
