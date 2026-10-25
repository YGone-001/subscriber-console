/*
 * Topology feature behaviour tests.
 *
 * These render the real production components server-side from fixtures and
 * assert operator-observable output, not source strings. `fetch` is replaced by
 * a throwing stub so the suite also proves the presentational surfaces never
 * reach for the network on their own.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { TopologyGraph } from '../src/features/topology/components/TopologyGraph';
import { ActualTopologyCanvas } from '../src/features/topology/components/ActualTopologyCanvas';
import { TopologyEdgeTable } from '../src/features/topology/components/TopologyEdgeTable';
import { TopologyEdgeForm } from '../src/features/topology/components/TopologyEdgeForm';
import { TopologyEdgeDetail } from '../src/features/topology/components/TopologyEdgeDetail';
import { TopologyPage } from '../src/features/topology/TopologyPage';
import { ResourceTopologyPage } from '../src/features/topology/ResourceTopologyPage';
import {
  buildCreateEdgeRequest,
  buildDeclaredDraftFromLink,
  buildRetireEdgeRequest,
  buildUpdateEdgeRequest,
} from '../src/features/topology/topology-builders';
import {
  RELATIONSHIP_PRESENTATION,
  DOMAIN_FILTER_BUCKETS,
  type InterfaceEntry,
  type Neighbor,
  type ResourceProjection,
  type TopologyEdge,
} from '../src/features/topology/topology-types';
import {
  edgeInterfaceNames,
  filterEdgesByInterface,
  interfaceCoverage,
  interfaceNamesInEdges,
  normalizeInterfaceNames,
  UNANNOTATED_INTERFACE_FILTER,
} from '../src/features/topology/interface-catalog';
import { en } from '../src/lib/locales/en';
import { zh } from '../src/lib/locales/zh';
import {
  ACTUAL_CANVAS_PADDING,
  ACTUAL_DOMAIN_MODE_OPTIONS,
  ACTUAL_GROUP_WIDTH,
  buildActualTopology,
  groupForResource,
  nodeMatches,
} from '../src/features/topology/actual-topology-model';
import {
  liveConfigCompleteness,
  liveDirectory,
  liveEdges,
  presentRuntimeStates,
} from '../src/features/topology/live-topology-model';
import type { LiveTopologyResponse } from '../src/features/topology/live-topology-types';
import {
  classifyResource,
  nfRoleLabel,
  normalizeRoleToken,
} from '../src/features/topology/nf-classification';
import {
  edgeGeometry,
  LABEL_DETAIL_MIN_ZOOM,
  placeEdgeLabels,
  pointOnGeometry,
  resolveLabelVisibility,
} from '../src/features/topology/actual-topology-labels';
import {
  projectNodeHealth,
  summarizeNodeHealth,
} from '../src/features/topology/actual-topology-health';

const SMF = '2f1a6a52-6c7f-4f8a-9f2b-0f7d4a1c8e33';
const PCF = '8c9d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const AMF = '3a4b5c6d-7e8f-4a1b-9c2d-3e4f5a6b7c8d';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function render(element: ReactElement): string {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('a topology presentational surface must not call fetch during render');
  }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(createElement(I18nProvider, null, element));
    assert.equal(calls, 0, 'rendering must not perform network access');
    return markup;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function renderPage(element: ReactElement, path = '/topology', pattern = '/topology'): string {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        AuthProvider,
        null,
        createElement(Routes, null, createElement(Route, { path: pattern, element })),
      ),
    ),
  );
}

function projection(resourceId: string, name: string, domain = '5gc'): ResourceProjection {
  return { resourceId, kind: 'network_function', name, displayName: name, domain, role: 'nf', lifecycleState: 'active' };
}

function roleProjection(resourceId: string, name: string, role: string): ResourceProjection {
  return { resourceId, kind: 'network_function', name, displayName: name, domain: '5gc', role, lifecycleState: 'active' };
}

function supportProjection(
  resourceId: string,
  name: string,
  kind = 'host',
  role = '',
): ResourceProjection {
  return { resourceId, kind, name, displayName: name, domain: 'platform', role, lifecycleState: 'active' };
}

function domainProjection(
  resourceId: string,
  name: string,
  role: string,
  domain: string,
): ResourceProjection {
  return { resourceId, kind: 'network_function', name, displayName: name, domain, role, lifecycleState: 'active' };
}

function edge(overrides: Partial<TopologyEdge> = {}): TopologyEdge {
  return {
    edgeId: '11111111-2222-4333-8444-555555555555',
    schemaVersion: 1,
    relationshipType: 'depends_on',
    fromResourceId: SMF,
    toResourceId: PCF,
    description: 'SMF depends on PCF',
    labels: { env: 'prod' },
    attributes: { priority: 1 },
    lifecycleState: 'active',
    source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
    revision: 1,
    createdAt: '2026-10-09T00:00:00Z',
    createdBy: 'operator1',
    updatedAt: '2026-10-09T00:00:00Z',
    updatedBy: 'operator1',
    ...overrides,
  };
}

const INTERFACE_CATALOG: InterfaceEntry[] = [
  {
    name: 'N4',
    category: 'reference_point',
    domains: ['5gc'],
    plane: 'control',
    scope: 'nf_nf',
    endpoints: [['smf', 'upf']],
    spec: '3GPP TS 23.501 4.2',
    description: 'SMF to UPF',
  },
  {
    name: 'N7',
    category: 'reference_point',
    domains: ['5gc'],
    plane: 'control',
    scope: 'nf_nf',
    endpoints: [['smf', 'pcf']],
    spec: '3GPP TS 23.501 4.2',
    description: 'SMF to PCF',
  },
  {
    name: 'N11',
    category: 'reference_point',
    domains: ['5gc'],
    plane: 'control',
    scope: 'nf_nf',
    endpoints: [['amf', 'smf']],
    spec: '3GPP TS 23.501 4.2',
    description: 'AMF to SMF',
  },
  {
    name: 'Nnrf',
    category: 'sbi',
    domains: ['5gc'],
    plane: 'control',
    scope: 'nf_nf',
    producerRole: 'nrf',
    spec: '3GPP TS 23.501 / TS 29.500',
    description: 'NRF service interface',
  },
  {
    name: 'S5',
    category: 'reference_point',
    domains: ['epc'],
    plane: 'both',
    scope: 'nf_nf',
    endpoints: [['sgwc', 'pgwc'], ['sgwu', 'pgwu']],
    spec: '3GPP TS 23.401 4.2',
    description: 'SGW to PGW',
  },
];

const root = projection(SMF, 'smf-01');

const neighbors: Neighbor[] = [
  { edge: edge(), direction: 'outbound', neighborResource: projection(PCF, 'pcf-01') },
  {
    edge: edge({ edgeId: '22222222-3333-4444-8555-666666666666', relationshipType: 'connects_to', fromResourceId: AMF, toResourceId: SMF }),
    direction: 'inbound',
    neighborResource: projection(AMF, 'amf-01'),
  },
];

const directory: Record<string, ResourceProjection> = {
  [SMF]: root,
  [PCF]: projection(PCF, 'pcf-01'),
  [AMF]: projection(AMF, 'amf-01'),
};

/* ------------------------------------------------------------------ graph -- */

test('the one-hop graph renders the root plus inbound and outbound neighbours', () => {
  const markup = render(createElement(TopologyGraph, { root, neighbors }));
  assert.ok(markup.includes('smf-01'), 'root resource name must render');
  assert.ok(markup.includes('pcf-01'), 'outbound neighbour must render');
  assert.ok(markup.includes('amf-01'), 'inbound neighbour must render');
  assert.ok(markup.includes('topology-arrow'), 'directed edges must be drawn with arrow markers');
  assert.ok(markup.includes('runs on') || markup.includes('depends on'), 'relationship labels must render');
  assert.ok(markup.includes('tabindex="0"'), 'nodes must be keyboard reachable');
  assert.ok(markup.includes('role="img"'), 'the graph must expose an accessible role');
});

test('the one-hop graph caps a dense neighbourhood and reports the overflow', () => {
  const many: Neighbor[] = Array.from({ length: 9 }, (_, index) => ({
    edge: edge({ edgeId: `33333333-4444-4555-8666-7777777777${index.toString().padStart(2, '0')}` }),
    direction: 'outbound' as const,
    neighborResource: projection(`44444444-5555-4666-8777-8888888888${index.toString().padStart(2, '0')}`, `nf-${index}`),
  }));
  const markup = render(createElement(TopologyGraph, { root, neighbors: many }));
  assert.ok(markup.includes('nf-0'), 'the first neighbours must render');
  assert.ok(!markup.includes('nf-8'), 'beyond the cap the node must not be rendered');
  assert.ok(markup.includes('more outbound'), 'the overflow must be reported explicitly');
});

test('the actual topology graph uses only declared active edges and reveals labels on focus', () => {
  const layout = buildActualTopology(
    [
      edge(),
      edge({ edgeId: 'retired-edge', lifecycleState: 'retired' }),
    ],
    directory,
  );
  assert.equal(layout.nodes.length, 2, 'only endpoints of an active relationship become nodes');
  assert.equal(layout.links.length, 1, 'retired relationships do not render as topology paths');
  const markup = render(createElement(ActualTopologyCanvas, {
    layout,
    selectedResourceId: SMF,
    search: '',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  }));
  assert.ok(markup.includes('smf-01') && markup.includes('pcf-01'), 'Inventory endpoint names must render');
  assert.ok(markup.includes('depends on'), 'a focused path reveals its relationship name');
  assert.ok(markup.includes('actual-topology-arrow'), 'declared edges retain direction');
  assert.ok(markup.includes('role="group"'), 'the interactive canvas must expose its node buttons');
  assert.ok(markup.includes('tabindex="0"'), 'nodes must be keyboard reachable');
});

test('actual topology groups resources by role in a deterministic left-to-right order', () => {
  const amf = roleProjection('aaaaaaaa-1111-4111-8111-111111111111', 'amf-01', 'amf');
  const smf = roleProjection('bbbbbbbb-2222-4222-8222-222222222222', 'smf-01', 'smf');
  const nrf = roleProjection('cccccccc-3333-4333-8333-333333333333', 'nrf-01', 'nrf');
  const upf = roleProjection('dddddddd-4444-4444-8444-444444444444', 'upf-01', 'upf');
  const roleDirectory: Record<string, ResourceProjection> = {
    [amf.resourceId]: amf,
    [smf.resourceId]: smf,
    [nrf.resourceId]: nrf,
    [upf.resourceId]: upf,
  };
  const layout = buildActualTopology([
    edge({ edgeId: 'e1', fromResourceId: amf.resourceId, toResourceId: smf.resourceId }),
    edge({ edgeId: 'e2', fromResourceId: smf.resourceId, toResourceId: nrf.resourceId }),
    edge({ edgeId: 'e3', fromResourceId: smf.resourceId, toResourceId: upf.resourceId }),
  ], roleDirectory);

  assert.deepEqual(layout.groups, ['access', 'session', 'discovery', 'user']);
  const byName = new Map(layout.nodes.map((node) => [node.name, node]));
  assert.equal(byName.get('amf-01')?.group, 'access');
  assert.equal(byName.get('smf-01')?.group, 'session');
  assert.equal(byName.get('nrf-01')?.group, 'discovery');
  assert.equal(byName.get('upf-01')?.group, 'user');
  assert.ok((byName.get('amf-01')?.x ?? 0) < (byName.get('smf-01')?.x ?? 0), 'access precedes session');
  assert.ok((byName.get('nrf-01')?.x ?? 0) < (byName.get('upf-01')?.x ?? 0), 'discovery precedes user plane');
  assert.equal(groupForResource(roleProjection('eeeeeeee-5555-4555-8555-555555555555', 'custom-01', 'custom')), 'other');
});

test('parallel relationships stay distinct and layout order does not depend on edge order', () => {
  const first = edge();
  const second = edge({ edgeId: '99999999-8888-4777-8666-555555555555', relationshipType: 'connects_to' });
  const forward = buildActualTopology([first, second], directory);
  const backward = buildActualTopology([second, first], directory);

  assert.deepEqual(forward.links.map((link) => link.parallelIndex), [0, 1]);
  assert.deepEqual(forward.links.map((link) => link.parallelCount), [2, 2]);
  assert.deepEqual(
    forward.nodes.map((node) => node.resourceId),
    backward.nodes.map((node) => node.resourceId),
    'node placement must not depend on relationship order',
  );
});

test('focused labels stay attached to their own edge curves and never stack', () => {
  const smf = roleProjection(SMF, 'smf-01', 'smf');
  const amf = roleProjection(AMF, 'amf-01', 'amf');
  const pcf = roleProjection(PCF, 'pcf-01', 'pcf');
  const upfId = 'dddddddd-4444-4444-8444-444444444444';
  const upf = roleProjection(upfId, 'upf-01', 'upf');
  const labelDirectory: Record<string, ResourceProjection> = {
    [smf.resourceId]: smf,
    [amf.resourceId]: amf,
    [pcf.resourceId]: pcf,
    [upf.resourceId]: upf,
  };
  const layout = buildActualTopology([
    edge({ edgeId: 'edge-1', fromResourceId: SMF, toResourceId: AMF, relationshipType: 'connects_to' }),
    edge({ edgeId: 'edge-2', fromResourceId: SMF, toResourceId: PCF, relationshipType: 'routes_to' }),
    edge({ edgeId: 'edge-3', fromResourceId: SMF, toResourceId: upfId, relationshipType: 'uses' }),
  ], labelDirectory);
  const labels = new Map([
    ['edge-1', 'connects to'],
    ['edge-2', 'routes to'],
    ['edge-3', 'uses'],
  ]);
  const placements = placeEdgeLabels(layout.links, labels, layout.nodes, layout.width, layout.height);
  assert.equal(placements.length, 3, 'every focused relationship keeps one label');

  for (const placement of placements) {
    const link = layout.links.find((candidate) => candidate.edgeId === placement.edgeId);
    assert.ok(link, 'a placement must reference a rendered edge');
    const point = pointOnGeometry(edgeGeometry(link), placement.t);
    assert.ok(Math.abs(point.x - placement.labelX) < 0.001, 'the label x must sit on its own curve');
    assert.ok(Math.abs(point.y - placement.labelY) < 0.001, 'the label y must sit on its own curve');
  }

  const anchors = new Set(placements.map((placement) => `${placement.labelX.toFixed(2)}:${placement.labelY.toFixed(2)}`));
  assert.equal(anchors.size, placements.length, 'same-source labels must not collapse onto one anchor');

  for (let index = 0; index < placements.length; index += 1) {
    for (let other = index + 1; other < placements.length; other += 1) {
      const left = placements[index];
      const right = placements[other];
      const stacked = Math.abs(left.labelX - right.labelX) < (left.width + right.width) / 2
        && Math.abs(left.labelY - right.labelY) < (left.height + right.height) / 2;
      assert.ok(!stacked, 'labels for distinct relationships must not stack');
    }
  }

  const reversed = placeEdgeLabels([...layout.links].reverse(), labels, layout.nodes, layout.width, layout.height);
  assert.deepEqual(reversed, placements, 'edge ordering must not move a label');
});

test('monitoring overlay separates confirmed absence from unresolved association', () => {
  const unresolvedId = 'eeeeeeee-5555-4555-8555-555555555555';
  const resourceIds = [AMF, SMF, PCF, unresolvedId];
  const target = (resourceId: string, overrides: Record<string, unknown> = {}) => ({
    targetId: `target-${resourceId}`,
    resourceId,
    name: resourceId,
    enabled: true,
    overallState: 'healthy',
    statusComplete: true,
    freshness: { state: 'fresh' },
    coverage: { l1Measured: true, l2Measured: false, l3Measured: false, l3Available: false },
    ...overrides,
  });
  const targets = [
    target(AMF),
    target(SMF, { enabled: false }),
    target(PCF, { statusComplete: false }),
  ];

  const resolvedThree = new Set([AMF, SMF, PCF]);
  const partial = projectNodeHealth(resourceIds, targets, resolvedThree);
  assert.equal(partial.get(AMF)?.state, 'healthy');
  assert.equal(partial.get(SMF)?.state, 'disabled');
  assert.equal(partial.get(PCF)?.state, 'unknown', 'a failed status projection never claims health');
  assert.equal(partial.get(unresolvedId)?.state, 'unresolved', 'a failed lookup is never reported as unmonitored');

  const complete = projectNodeHealth(resourceIds, targets, new Set(resourceIds));
  assert.equal(complete.get(unresolvedId)?.state, 'not_monitored', 'a successful lookup without a target is a confirmed absence');
  const counts = summarizeNodeHealth(complete);
  assert.equal(counts.monitored, 2, 'healthy and unknown targets are monitored; a disabled target is not');
  assert.equal(counts.disabled, 1);
  assert.equal(counts.notMonitored, 1);
  assert.equal(counts.unresolved, 0);

  const partialCounts = summarizeNodeHealth(partial);
  assert.equal(partialCounts.unresolved, 1);
  assert.equal(partialCounts.notMonitored, 0, 'unresolved identifiers must never inflate unmonitored totals');
});

test('the actual topology canvas announces monitoring state without inventing one', () => {
  const layout = buildActualTopology([edge()], directory);
  const health = new Map([
    [SMF, {
      state: 'degraded' as const,
      targetId: 'target-smf',
      overallState: 'degraded',
      freshness: 'fresh',
      statusComplete: true,
    }],
    [PCF, {
      state: 'unresolved' as const,
      targetId: '',
      overallState: '',
      freshness: '',
      statusComplete: true,
    }],
  ]);
  const markup = render(createElement(ActualTopologyCanvas, {
    layout,
    search: '',
    health,
    onSelectResource: () => {},
    onHoverEdge: () => {},
  }));
  assert.ok(markup.includes('data-health-state="degraded"'), 'a monitored node exposes its projected state');
  assert.ok(markup.includes('data-health-state="unresolved"'), 'an unresolved association stays distinct');
  assert.ok(markup.includes('Monitoring: Degraded'), 'the accessible node label carries the monitoring state');
  assert.ok(markup.includes('Monitoring: Association unresolved'), 'an unresolved association is announced as such');
  assert.ok(!markup.includes('Monitoring: Not monitored'), 'an unresolved association is never announced as unmonitored');
});

test('an unresolved endpoint remains an explicit diagnostic node', () => {
  const layout = buildActualTopology([edge()], { [SMF]: root });
  const unresolved = layout.nodes.find((node) => node.resourceId === PCF);
  assert.equal(unresolved?.resolved, false);

  const markup = render(createElement(ActualTopologyCanvas, {
    layout,
    search: '',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  }));
  assert.ok(markup.includes('Unresolved resource'), 'the node must state that Inventory did not resolve it');
  assert.ok(markup.includes('actualNodeUnresolved'), 'unresolved nodes must carry a distinct visual state');
  assert.ok(markup.includes(PCF), 'the identifier stays visible instead of a guessed name');
});

test('resource classification is kind-only and role aliases never change NF visibility', () => {
  assert.equal(classifyResource(projection(SMF, 'smf-01')), 'nf');
  assert.equal(classifyResource({ ...projection(SMF, 'smf-01'), kind: 'network_function_instance' }), 'nf');
  assert.equal(classifyResource(supportProjection('11111111-1111-4111-8111-111111111111', 'mme-01', 'network_element', 'mme')), 'support');
  assert.equal(classifyResource(supportProjection('22222222-2222-4222-8222-222222222222', 'host-01', 'host')), 'support');
  assert.equal(classifyResource({ ...projection(SMF, 'smf-01'), kind: '' }), 'unresolved');

  assert.equal(normalizeRoleToken('SGW-C'), 'sgwc');
  assert.equal(normalizeRoleToken('sgw_c'), 'sgwc');
  assert.equal(nfRoleLabel('sgwc'), 'SGW-C');
  assert.equal(nfRoleLabel('pgwu'), 'PGW-U');
  assert.equal(nfRoleLabel('p-cscf'), 'P-CSCF');
  assert.equal(nfRoleLabel('icscf'), 'I-CSCF');
  assert.equal(nfRoleLabel('scscf'), 'S-CSCF');
  assert.equal(nfRoleLabel('smsc'), 'SMSC');
  assert.equal(nfRoleLabel('custom-role'), 'CUSTOM-ROLE');
});

test('network functions and instances stay visible regardless of role token', () => {
  const mme = roleProjection('11111111-1111-4111-9111-111111111111', 'mme-01', 'mme');
  const custom = roleProjection('22222222-2222-4222-9222-222222222222', 'custom-01', 'custom');
  const instance = {
    ...roleProjection('33333333-3333-4333-9333-333333333333', 'smf-instance-01', 'smf'),
    kind: 'network_function_instance',
  };
  const layout = buildActualTopology([
    edge({ edgeId: 'mme-edge', fromResourceId: SMF, toResourceId: mme.resourceId }),
    edge({ edgeId: 'custom-edge', fromResourceId: SMF, toResourceId: custom.resourceId }),
    edge({ edgeId: 'instance-edge', fromResourceId: SMF, toResourceId: instance.resourceId }),
  ], {
    ...directory,
    [mme.resourceId]: mme,
    [custom.resourceId]: custom,
    [instance.resourceId]: instance,
  });

  assert.equal(layout.nodes.length, 4, 'every network_function/instance endpoint stays visible');
  assert.equal(layout.nodes.find((node) => node.resourceId === mme.resourceId)?.group, 'access');
  assert.equal(layout.nodes.find((node) => node.resourceId === custom.resourceId)?.group, 'other');
  assert.equal(layout.nodes.find((node) => node.resourceId === instance.resourceId)?.resourceClass, 'nf');
  assert.equal(layout.nodes.find((node) => node.resourceId === instance.resourceId)?.group, 'session');
});

test('the default topology view is kind-only and hides support resources with counts', () => {
  const hostId = '11111111-aaaa-4aaa-8aaa-111111111111';
  const elementId = '22222222-bbbb-4bbb-8bbb-222222222222';
  const host = supportProjection(hostId, 'host-01', 'host');
  const element = supportProjection(elementId, 'mme-element', 'network_element', 'mme');
  const supportDirectory: Record<string, ResourceProjection> = {
    ...directory,
    [hostId]: host,
    [elementId]: element,
  };
  const edges = [
    edge({ edgeId: 'nf-edge', fromResourceId: SMF, toResourceId: PCF }),
    edge({ edgeId: 'host-edge', fromResourceId: SMF, toResourceId: hostId }),
    edge({ edgeId: 'element-edge', fromResourceId: PCF, toResourceId: elementId }),
  ];

  const hidden = buildActualTopology(edges, supportDirectory);
  assert.equal(hidden.activeLinkCount, 3);
  assert.equal(hidden.nfResourceCount, 2);
  assert.equal(hidden.supportResourceCount, 2);
  assert.equal(hidden.supportLinkCount, 2);
  assert.equal(hidden.unresolvedResourceCount, 0);
  assert.deepEqual(hidden.nodes.map((node) => node.resourceId).sort(), [SMF, PCF].sort());
  assert.equal(hidden.links.length, 1, 'support relationships are hidden by default');
  assert.ok(!hidden.groups.includes('support'), 'a hidden support group must not consume a column');

  const onlySupportEdge = buildActualTopology([edges[1]], supportDirectory);
  assert.deepEqual(onlySupportEdge.nodes.map((node) => node.resourceId), [SMF], 'an NF stays visible even when every edge is filtered out');
  assert.equal(onlySupportEdge.links.length, 0);
  assert.equal(onlySupportEdge.supportLinkCount, 1);

  const supportOnlyLayout = buildActualTopology([
    edge({ edgeId: 'support-only', fromResourceId: hostId, toResourceId: elementId }),
  ], supportDirectory);
  assert.equal(supportOnlyLayout.activeLinkCount, 1);
  assert.equal(supportOnlyLayout.nodes.length, 0, 'a support-only topology renders the filtered empty state');
  assert.equal(supportOnlyLayout.supportResourceCount, 2);
  assert.equal(supportOnlyLayout.supportLinkCount, 1);

  const shown = buildActualTopology(edges, supportDirectory, { showSupport: true });
  assert.equal(shown.nodes.length, 4);
  assert.equal(shown.links.length, 3);
  const elementNode = shown.nodes.find((node) => node.resourceId === elementId);
  assert.equal(elementNode?.resourceClass, 'support');
  assert.equal(elementNode?.group, 'support', 'network_element is support, never grouped as an NF role');
  assert.ok(shown.groups.includes('support'));
});

test('unresolved endpoints remain visible when support resources are hidden', () => {
  const missingId = '33333333-cccc-4ccc-8ccc-333333333333';
  const layout = buildActualTopology(
    [edge({ edgeId: 'missing-edge', fromResourceId: SMF, toResourceId: missingId })],
    { [SMF]: root },
  );
  assert.equal(layout.unresolvedResourceCount, 1);
  assert.equal(layout.supportResourceCount, 0);
  assert.equal(layout.nodes.length, 2, 'an unresolved endpoint is a diagnostic, not a support resource');
  assert.equal(layout.links.length, 1);
  assert.equal(layout.nodes.find((node) => node.resourceId === missingId)?.resourceClass, 'unresolved');
});

test('IMS roles use compact tokens for grouping and standard labels for display', () => {
  const pcscf = { ...roleProjection('44444444-dddd-4ddd-8ddd-444444444444', 'pcscf-01', 'p-cscf'), domain: 'ims' };
  const icscf = { ...roleProjection('55555555-eeee-4eee-8eee-555555555555', 'icscf-01', 'icscf'), domain: 'ims' };
  const scscf = { ...roleProjection('66666666-ffff-4fff-8fff-666666666666', 'scscf-01', 'scscf'), domain: 'ims' };
  const smsc = { ...roleProjection('77777777-aaaa-4aaa-8aaa-777777777777', 'smsc-01', 'smsc'), domain: 'ims' };
  const imsDirectory: Record<string, ResourceProjection> = {
    [pcscf.resourceId]: pcscf,
    [icscf.resourceId]: icscf,
    [scscf.resourceId]: scscf,
    [smsc.resourceId]: smsc,
  };
  const layout = buildActualTopology([
    edge({ edgeId: 'ims-1', fromResourceId: pcscf.resourceId, toResourceId: icscf.resourceId }),
    edge({ edgeId: 'ims-2', fromResourceId: icscf.resourceId, toResourceId: scscf.resourceId }),
    edge({ edgeId: 'ims-3', fromResourceId: scscf.resourceId, toResourceId: smsc.resourceId }),
  ], imsDirectory);

  assert.ok(layout.groups.includes('ims'));
  for (const resource of [pcscf, icscf, scscf, smsc]) {
    assert.equal(layout.nodes.find((node) => node.resourceId === resource.resourceId)?.group, 'ims');
  }
  assert.equal(nfRoleLabel(pcscf.role), 'P-CSCF');
  assert.equal(nfRoleLabel(icscf.role), 'I-CSCF');
  assert.equal(nfRoleLabel(scscf.role), 'S-CSCF');
  assert.equal(nfRoleLabel(smsc.role), 'SMSC');
});

test('support resources render with a distinct class, group and label when shown', () => {
  const hostId = '88888888-bbbb-4bbb-8bbb-888888888888';
  const host = supportProjection(hostId, 'host-01', 'host');
  const layout = buildActualTopology(
    [edge({ edgeId: 'host-edge', fromResourceId: SMF, toResourceId: hostId })],
    { ...directory, [hostId]: host },
    { showSupport: true },
  );
  const markup = render(createElement(ActualTopologyCanvas, {
    layout,
    search: '',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  }));
  assert.ok(markup.includes('data-resource-class="support"'), 'support nodes must expose their class');
  assert.ok(markup.includes('data-group="support"'), 'support nodes must stay out of NF columns');
  assert.ok(markup.includes('Support resource'), 'support nodes must say what they are');
  assert.ok(markup.includes('actualNodeSupport'), 'support nodes must carry a distinct visual state');
});

test('domain views scope relationships and keep shared nodes as boundaries', () => {
  const amf = domainProjection('a0000001-1111-4111-8111-000000000001', 'amf-01', 'amf', '5gc');
  const smf = domainProjection('a0000002-1111-4111-8111-000000000002', 'smf-01', 'smf', '5gc');
  const pcf = domainProjection('a0000003-1111-4111-8111-000000000003', 'pcf-01', 'pcf', '5gc');
  const host = supportProjection('a0000004-1111-4111-8111-000000000004', 'host-01', 'host');
  const mme = domainProjection('a0000005-1111-4111-8111-000000000005', 'mme-01', 'mme', 'epc');
  const hss = domainProjection('a0000006-1111-4111-8111-000000000006', 'hss-01', 'hss', 'epc');
  const pcrf = domainProjection('a0000007-1111-4111-8111-000000000007', 'pcrf-01', 'pcrf', 'epc');
  const dra = domainProjection('a0000008-1111-4111-8111-000000000008', 'dra-01', 'dra', 'epc');
  const pcscf = domainProjection('a0000009-1111-4111-8111-000000000009', 'pcscf-01', 'pcscf', 'ims');
  const icscf = domainProjection('a000000a-1111-4111-8111-00000000000a', 'icscf-01', 'icscf', 'ims');
  const scscf = domainProjection('a000000b-1111-4111-8111-00000000000b', 'scscf-01', 'scscf', 'ims');
  const ocs = domainProjection('a000000c-1111-4111-8111-00000000000c', 'ocs-01', 'ocs', 'charging');
  const domainDirectory: Record<string, ResourceProjection> = {
    [amf.resourceId]: amf,
    [smf.resourceId]: smf,
    [pcf.resourceId]: pcf,
    [host.resourceId]: host,
    [mme.resourceId]: mme,
    [hss.resourceId]: hss,
    [pcrf.resourceId]: pcrf,
    [dra.resourceId]: dra,
    [pcscf.resourceId]: pcscf,
    [icscf.resourceId]: icscf,
    [scscf.resourceId]: scscf,
    [ocs.resourceId]: ocs,
  };
  const domainEdges = [
    edge({ edgeId: 'domain-1', fromResourceId: amf.resourceId, toResourceId: smf.resourceId }),
    edge({ edgeId: 'domain-2', fromResourceId: smf.resourceId, toResourceId: pcf.resourceId }),
    edge({ edgeId: 'domain-3', fromResourceId: amf.resourceId, toResourceId: mme.resourceId }),
    edge({ edgeId: 'domain-4', fromResourceId: mme.resourceId, toResourceId: hss.resourceId }),
    edge({ edgeId: 'domain-5', fromResourceId: hss.resourceId, toResourceId: icscf.resourceId }),
    edge({ edgeId: 'domain-6', fromResourceId: pcscf.resourceId, toResourceId: pcrf.resourceId }),
    edge({ edgeId: 'domain-7', fromResourceId: pcrf.resourceId, toResourceId: ocs.resourceId }),
    edge({ edgeId: 'domain-8', fromResourceId: icscf.resourceId, toResourceId: scscf.resourceId }),
    edge({ edgeId: 'domain-9', fromResourceId: mme.resourceId, toResourceId: dra.resourceId }),
    edge({ edgeId: 'domain-10', fromResourceId: smf.resourceId, toResourceId: host.resourceId }),
  ];

  const all = buildActualTopology(domainEdges, domainDirectory);
  assert.equal(all.activeLinkCount, 10);
  assert.equal(all.crossDomainLinkCount, 4, 'N26, Cx, Rx and Sy are cross-domain');
  assert.equal(all.proxyNodeCount, 1, 'DRA is a proxy node');
  assert.equal(all.supportResourceCount, 1);
  assert.equal(all.supportLinkCount, 1);
  assert.deepEqual(
    all.bands.filter((band) => band.kind === 'domain').map((band) => band.domain),
    ['5gc', 'epc', 'ims', 'charging'],
  );
  assert.ok(all.bands.find((band) => band.domain === 'epc')?.columns.some((column) => column.group === 'access'));
  assert.ok(all.bands.find((band) => band.domain === 'ims')?.columns.some((column) => column.group === 'ims'));
  const draNode = all.nodes.find((node) => node.resourceId === dra.resourceId);
  assert.equal(draNode?.proxy, true);
  assert.equal(draNode?.band, 'domain');

  const ims = buildActualTopology(domainEdges, domainDirectory, { domainMode: 'ims' });
  assert.equal(ims.selectedDomain, 'ims');
  assert.equal(ims.scopedLinkCount, 3);
  assert.equal(ims.nodes.length, 5);
  assert.equal(ims.links.length, 3);
  assert.equal(ims.boundaryNodeCount, 2, 'HSS and PCRF are shared boundary nodes');
  assert.equal(ims.boundaryLinkCount, 2);
  assert.equal(ims.crossDomainLinkCount, 2);
  assert.deepEqual(
    ims.nodes.filter((node) => node.boundary).map((node) => node.resourceId).sort(),
    [hss.resourceId, pcrf.resourceId].sort(),
  );
  assert.equal(ims.bands.find((band) => band.kind === 'boundary')?.labelKey, 'topology_domain_boundary');
  const imsMarkup = render(createElement(ActualTopologyCanvas, {
    layout: ims,
    search: '',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  }));
  assert.ok(imsMarkup.includes('data-boundary="true"'), 'boundary nodes must be explicit');
  assert.ok(imsMarkup.includes('Boundary'), 'the boundary band must be labelled');

  const imsHidden = buildActualTopology(domainEdges, domainDirectory, {
    domainMode: 'ims',
    showBoundary: false,
  });
  assert.equal(imsHidden.nodes.length, 3);
  assert.equal(imsHidden.links.length, 1);
  assert.equal(imsHidden.hiddenBoundaryNodeCount, 2);
  assert.equal(imsHidden.hiddenBoundaryLinkCount, 2);
  assert.equal(imsHidden.crossDomainLinkCount, 2);

  const fiveGc = buildActualTopology(domainEdges, domainDirectory, {
    domainMode: '5gc',
    showSupport: true,
  });
  assert.equal(fiveGc.supportResourceCount, 1);
  assert.ok(fiveGc.bands.some((band) => band.kind === 'support'));
  assert.equal(fiveGc.boundaryNodeCount, 1);
  assert.equal(fiveGc.crossDomainLinkCount, 1);
  assert.equal(fiveGc.nodes.length, 5);

  const crossDomain = buildActualTopology(domainEdges, domainDirectory, { domainMode: 'cross-domain' });
  assert.equal(crossDomain.scopedLinkCount, 4);
  assert.equal(crossDomain.crossDomainLinkCount, 4);
  assert.equal(crossDomain.links.length, 4);
  assert.equal(crossDomain.nodes.length, 7);
  assert.equal(crossDomain.supportResourceCount, 0);
  assert.equal(crossDomain.boundaryNodeCount, 0);
  const crossPairs = crossDomain.links.map((link) => (
    [link.fromResourceId, link.toResourceId].sort().join('|')
  ));
  assert.ok(!crossPairs.includes([amf.resourceId, smf.resourceId].sort().join('|')), 'same-domain edges are excluded');
  assert.ok(crossPairs.includes([amf.resourceId, mme.resourceId].sort().join('|')), 'cross-domain edges are retained');
});

test('unknown domains are unclassified and never counted as cross-domain', () => {
  const amf = domainProjection('b0000001-1111-4111-8111-000000000001', 'amf-01', 'amf', '5gc');
  const legacy = domainProjection('b0000002-1111-4111-8111-000000000002', 'legacy-01', 'custom', 'legacy');
  const unknownDirectory: Record<string, ResourceProjection> = {
    [amf.resourceId]: amf,
    [legacy.resourceId]: legacy,
  };
  const unknownEdge = edge({ edgeId: 'unknown-1', fromResourceId: amf.resourceId, toResourceId: legacy.resourceId });

  const all = buildActualTopology([unknownEdge], unknownDirectory);
  const legacyNode = all.nodes.find((node) => node.resourceId === legacy.resourceId);
  assert.equal(legacyNode?.band, 'unclassified');
  assert.equal(legacyNode?.domainBand, 'unclassified');
  assert.ok(all.bands.some((band) => band.kind === 'unclassified'));
  assert.equal(all.crossDomainLinkCount, 0, 'an unknown domain is not inferred as a cross-domain peer');

  const fiveGc = buildActualTopology([unknownEdge], unknownDirectory, { domainMode: '5gc' });
  const boundaryNode = fiveGc.nodes.find((node) => node.resourceId === legacy.resourceId);
  assert.equal(boundaryNode?.boundary, true);
  assert.equal(boundaryNode?.band, 'boundary');
  assert.equal(fiveGc.boundaryNodeCount, 1);
  assert.equal(fiveGc.crossDomainLinkCount, 0);
});

test('the all-domain graph stacks vertical lanes with per-lane counts', () => {
  const amf = domainProjection('c1000001-1111-4111-8111-000000000001', 'amf-01', 'amf', '5gc');
  const smf = domainProjection('c1000002-1111-4111-8111-000000000002', 'smf-01', 'smf', '5gc');
  const mme = domainProjection('c1000003-1111-4111-8111-000000000003', 'mme-01', 'mme', 'epc');
  const hss = domainProjection('c1000004-1111-4111-8111-000000000004', 'hss-01', 'hss', 'epc');
  const directory: Record<string, ResourceProjection> = {
    [amf.resourceId]: amf,
    [smf.resourceId]: smf,
    [mme.resourceId]: mme,
    [hss.resourceId]: hss,
  };
  const edges = [
    edge({ edgeId: 'lane-1', fromResourceId: amf.resourceId, toResourceId: smf.resourceId }),
    edge({ edgeId: 'lane-2', fromResourceId: mme.resourceId, toResourceId: hss.resourceId }),
    edge({ edgeId: 'lane-3', fromResourceId: smf.resourceId, toResourceId: mme.resourceId }),
  ];

  const all = buildActualTopology(edges, directory);
  const lanes = all.bands.filter((band) => band.kind === 'domain');
  assert.equal(lanes.length, 2, '5GC and EPC each become one lane');
  assert.equal(lanes[0].x, lanes[1].x, 'lanes share the left edge');
  assert.ok(lanes[1].y >= lanes[0].y + lanes[0].height, 'lanes stack vertically instead of concatenating right');
  assert.equal(lanes[0].nodeCount, 2);
  assert.equal(lanes[1].nodeCount, 2);
  assert.ok(
    all.width <= ACTUAL_CANVAS_PADDING * 2 + ACTUAL_GROUP_WIDTH * 2,
    'the canvas width is bounded by the widest lane, not the domain count',
  );
  assert.ok(all.height >= lanes[0].height + lanes[1].height, 'the canvas height accumulates the lanes');

  const single = buildActualTopology(edges, directory, { domainMode: '5gc' });
  assert.ok(single.bands.length >= 2, 'a focused domain keeps its boundary/support bands');
  assert.equal(new Set(single.bands.map((band) => band.y)).size, 1, 'a focused domain keeps one horizontal row');
  assert.equal(new Set(single.bands.map((band) => band.x)).size, single.bands.length, 'focused bands sit side by side');
});

test('lane abnormal counts reflect runtime problem states only', () => {
  const running = { ...domainProjection('c2000001-1111-4111-8111-000000000001', 'amf-01', 'amf', '5gc'), runtimeStatus: 'running' };
  const stopped = { ...domainProjection('c2000002-1111-4111-8111-000000000002', 'smf-01', 'smf', '5gc'), runtimeStatus: 'stopped' };
  const unknown = { ...domainProjection('c2000003-1111-4111-8111-000000000003', 'mme-01', 'mme', 'epc'), runtimeStatus: 'unknown' };
  const directory: Record<string, ResourceProjection> = {
    [running.resourceId]: running,
    [stopped.resourceId]: stopped,
    [unknown.resourceId]: unknown,
  };
  const layout = buildActualTopology([], directory, { resources: Object.values(directory) });
  const fiveGc = layout.bands.find((band) => band.domain === '5gc');
  const epc = layout.bands.find((band) => band.domain === 'epc');
  assert.equal(fiveGc?.nodeCount, 2);
  assert.equal(fiveGc?.abnormalCount, 1, 'a stopped runtime counts as abnormal');
  assert.equal(epc?.abnormalCount, 0, 'an unobserved runtime is not abnormal');
});

test('an empty domain view reports an empty layout without negative geometry', () => {
  const amf = domainProjection('c3000001-1111-4111-8111-000000000001', 'amf-01', 'amf', '5gc');
  const smf = domainProjection('c3000002-1111-4111-8111-000000000002', 'smf-01', 'smf', '5gc');
  const directory: Record<string, ResourceProjection> = { [amf.resourceId]: amf, [smf.resourceId]: smf };
  const edges = [edge({ edgeId: 'empty-1', fromResourceId: amf.resourceId, toResourceId: smf.resourceId })];

  const ims = buildActualTopology(edges, directory, { domainMode: 'ims' });
  assert.equal(ims.nodes.length, 0, 'no IMS resource means no IMS lane');
  assert.equal(ims.bands.length, 0);
  assert.ok(ims.width > 0 && ims.height > 0, 'an empty layout still has usable geometry');
});

test('a large multi-domain set stays deterministic and width-bounded', () => {
  const directory: Record<string, ResourceProjection> = {};
  const domains = ['5gc', 'epc', 'ims', 'charging'];
  for (let index = 0; index < 40; index += 1) {
    const resourceId = `c4000000-1111-4111-8111-${String(index).padStart(12, '0')}`;
    directory[resourceId] = {
      resourceId,
      kind: 'network_function',
      name: `nf-${index}`,
      displayName: `NF-${index}`,
      domain: domains[index % domains.length],
      role: 'amf',
      lifecycleState: 'active',
    };
  }
  const resources = Object.values(directory);
  const first = buildActualTopology([], directory, { resources });
  const second = buildActualTopology([], directory, { resources });
  assert.deepEqual(
    first.nodes.map((node) => [node.resourceId, node.x, node.y]),
    second.nodes.map((node) => [node.resourceId, node.x, node.y]),
    'the same dataset must always produce the same coordinates',
  );
  assert.equal(first.bands.length, 4, 'every populated domain becomes a lane');
  assert.ok(
    first.width <= ACTUAL_CANVAS_PADDING * 2 + ACTUAL_GROUP_WIDTH,
    'forty nodes across four domains must not widen the canvas',
  );
  assert.ok(first.height > first.bands.reduce((total, band) => total + band.height, 0), 'lanes stack with gaps');
});

test('lane headers expose counts and an optional focus control', () => {
  const amf = domainProjection('c5000001-1111-4111-8111-000000000001', 'amf-01', 'amf', '5gc');
  const mme = domainProjection('c5000002-1111-4111-8111-000000000002', 'mme-01', 'mme', 'epc');
  const directory: Record<string, ResourceProjection> = { [amf.resourceId]: amf, [mme.resourceId]: mme };
  const edges = [edge({ edgeId: 'lane-focus', fromResourceId: amf.resourceId, toResourceId: mme.resourceId })];
  const layout = buildActualTopology(edges, directory);
  const props = { layout, search: '', onSelectResource: () => {}, onHoverEdge: () => {} };

  const focusable = render(createElement(ActualTopologyCanvas, { ...props, onFocusDomain: () => {} }));
  assert.ok(focusable.includes('data-lane-focus="5gc"'), 'a domain lane offers a focus entry');
  assert.ok(focusable.includes('1 nodes') || focusable.includes('1 个节点'), 'the lane states its node count');

  const staticMarkup = render(createElement(ActualTopologyCanvas, props));
  assert.ok(!staticMarkup.includes('data-lane-focus'), 'without a handler the lane header stays decorative');
  assert.ok(staticMarkup.includes('data-band="domain"'), 'the lane label keeps its band marker');
});

test('proxy nodes keep both declared edges and never create a stitched direct link', () => {
  const amf = domainProjection('c0000001-1111-4111-8111-000000000001', 'amf-01', 'amf', '5gc');
  const scp = domainProjection('c0000002-1111-4111-8111-000000000002', 'scp-01', 'scp', '5gc');
  const smf = domainProjection('c0000003-1111-4111-8111-000000000003', 'smf-01', 'smf', '5gc');
  const layout = buildActualTopology([
    edge({ edgeId: 'proxy-1', fromResourceId: amf.resourceId, toResourceId: scp.resourceId }),
    edge({ edgeId: 'proxy-2', fromResourceId: scp.resourceId, toResourceId: smf.resourceId }),
  ], {
    [amf.resourceId]: amf,
    [scp.resourceId]: scp,
    [smf.resourceId]: smf,
  });
  assert.equal(layout.links.length, 2);
  assert.equal(layout.proxyNodeCount, 1);
  assert.equal(layout.nodes.find((node) => node.resourceId === scp.resourceId)?.proxy, true);
  const pairs = layout.links.map((link) => [link.fromResourceId, link.toResourceId].sort().join('|'));
  assert.ok(!pairs.includes([amf.resourceId, smf.resourceId].sort().join('|')), 'two proxy edges must not collapse into a direct link');

  const markup = render(createElement(ActualTopologyCanvas, {
    layout,
    search: '',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  }));
  assert.ok(markup.includes('data-proxy="true"'), 'a proxy node must be explicit');
  assert.ok(markup.includes('Proxy'), 'the proxy node must carry a proxy label');
});

test('the actual view exposes domain and boundary controls', () => {
  const source = read('../src/features/topology/ActualTopologyView.tsx');
  assert.deepEqual(
    ACTUAL_DOMAIN_MODE_OPTIONS.map((option) => option.value),
    ['all', '5gc', 'epc', 'ims', 'charging', 'cross-domain'],
  );
  assert.ok(source.includes('data-domain-mode'));
  assert.ok(source.includes('data-action="toggle-boundary"'));
  assert.ok(source.includes('ACTUAL_DOMAIN_MODE_OPTIONS'));
  assert.ok(source.includes('topology_actual_domain_empty_title'));
  assert.ok(source.includes('topology_actual_proxy_via'));
  assert.ok(source.includes('data-cross-domain-count'));
  assert.ok(source.includes('data-boundary-count'));

  const canvas = read('../src/features/topology/components/ActualTopologyCanvas.tsx');
  assert.ok(canvas.includes('layout.bands.map'));
  assert.ok(canvas.includes('data-band='));
  assert.ok(canvas.includes('data-proxy='));
});

test('relationship labels stay hidden until a path is focused or hovered', () => {
  const layout = buildActualTopology([edge()], directory);
  const props = {
    layout,
    search: '',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  };
  const quiet = render(createElement(ActualTopologyCanvas, props));
  assert.ok(!quiet.includes('depends on'), 'a quiet graph must not paint every interface name');
  assert.ok(quiet.includes('data-group-label="other"'));
  assert.ok(quiet.includes('Other resources'), 'group headers must use localized copy');

  const focused = render(createElement(ActualTopologyCanvas, { ...props, selectedResourceId: SMF }));
  assert.ok(focused.includes('depends on'), 'focus reveals the relationship name');

  const hovered = render(createElement(ActualTopologyCanvas, { ...props, hoveredEdgeId: edge().edgeId }));
  assert.ok(hovered.includes('depends on'), 'hover reveals the relationship name');
});

test('interface labels follow hover, focus and the detail zoom threshold', () => {
  const annotated = edge({ edgeId: 'density-annotated', interfaceNames: ['N7'] });
  const fallback = edge({ edgeId: 'density-fallback', fromResourceId: AMF, toResourceId: PCF });
  const layout = buildActualTopology([annotated, fallback], directory);
  const props = {
    layout,
    search: '',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  };

  const quiet = render(createElement(ActualTopologyCanvas, props));
  assert.ok(quiet.includes('data-visible-label-count="0"'));
  assert.ok(quiet.includes('data-hidden-label-count="2"'), 'the quiet canvas reports every hidden label');

  const all = render(createElement(ActualTopologyCanvas, { ...props, showAllInterfaceNames: true }));
  assert.ok(all.includes('data-visible-label-count="1"'), 'show-all reveals annotated labels only');

  const zoomedOut = render(createElement(ActualTopologyCanvas, {
    ...props,
    showAllInterfaceNames: true,
    zoom: LABEL_DETAIL_MIN_ZOOM - 0.01,
  }));
  assert.ok(zoomedOut.includes('data-visible-label-count="0"'), 'show-all is suppressed below the detail zoom');
  assert.ok(!zoomedOut.includes('data-edge-label'), 'no label paints below the threshold without a focus');

  const selected = render(createElement(ActualTopologyCanvas, {
    ...props,
    zoom: LABEL_DETAIL_MIN_ZOOM - 0.01,
    selectedResourceId: PCF,
  }));
  assert.ok(selected.includes('N7'), 'selection keeps the focused path readable at low zoom');

  const focused = render(createElement(ActualTopologyCanvas, { ...props, focusedResourceId: PCF }));
  assert.ok(focused.includes('N7'), 'keyboard focus reveals the same labels as selection');

  const hoveredNode = render(createElement(ActualTopologyCanvas, { ...props, hoveredResourceId: SMF }));
  assert.ok(hoveredNode.includes('N7'), 'hovering a node reveals labels without selecting it');

  const visibility = resolveLabelVisibility(layout.links, { showAllInterfaceNames: true, zoom: 0.6 });
  assert.equal(visibility.showAll, false);
  assert.equal(visibility.hiddenCount, 2);
});

test('search dims non-matching resources without hiding them', () => {
  const layout = buildActualTopology([
    edge(),
    edge({ edgeId: 'search-edge', fromResourceId: AMF, toResourceId: PCF }),
  ], directory);
  assert.ok(nodeMatches(roleProjection(AMF, 'amf-01', 'amf'), 'AMF'));
  assert.ok(!nodeMatches(roleProjection(AMF, 'amf-01', 'amf'), 'upf'));

  const markup = render(createElement(ActualTopologyCanvas, {
    layout,
    search: 'amf',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  }));
  assert.ok(markup.includes('amf-01') && markup.includes('smf-01'), 'matching and non-matching nodes both stay in the DOM');
  assert.ok(markup.includes('actualNodeMatch'), 'the matching node must be visually identified');
  assert.ok(markup.includes('actualDimmed'), 'non-matching nodes lose visual weight instead of disappearing');
});

test('the actual view sizes from the layout and exposes fit, zoom, reset and fullscreen', () => {
  const source = read('../src/features/topology/ActualTopologyView.tsx');
  for (const action of ['zoom-out', 'zoom-in', 'fit', 'reset', 'fullscreen']) {
    assert.ok(source.includes(`data-action="${action}"`), `${action} must be an explicit control`);
  }
  assert.ok(source.includes('layout.width * zoom'), 'the canvas must use an explicit scale, not fill any width');
  assert.ok(!source.includes('`${zoom * 100}%`'), 'percentage width stretching would resize the nodes with the viewport');
});

test('the actual view separates an unavailable read from empty and filtered states', () => {
  const source = read('../src/features/topology/ActualTopologyView.tsx');
  const unavailable = source.indexOf("coverage === 'unavailable'");
  const empty = source.indexOf('!loading && edges.length === 0');
  const filteredEmpty = source.indexOf('layout.nodes.length === 0');
  assert.ok(unavailable >= 0, 'an unavailable read must have its own state');
  assert.ok(empty >= 0, 'a genuinely empty topology must have its own state');
  assert.ok(filteredEmpty > empty, 'a topology with only hidden support resources or a filter must have its own state');
  assert.ok(unavailable < empty, 'a failed read must never fall through to the empty state');
  assert.ok(source.includes("topology_actual_unavailable_title"));
  assert.ok(source.includes("topology_actual_no_nf_title"));
  assert.ok(source.includes("topology_interface_empty_title"));
  assert.ok(source.includes("topology_actual_empty_declared_title"), 'an empty declared source must state its own meaning');
  assert.ok(source.includes('onShowRuntime'), 'an empty declared source must offer the runtime source explicitly');
  assert.ok(
    !source.includes('<LiveTopologyView'),
    'the declared source must never silently fall through to runtime evidence',
  );
  assert.ok(source.includes('data-action="toggle-support"'), 'support visibility must be an explicit control');
  assert.ok(source.includes('data-interface-filter'), 'the interface filter must be explicit');
  assert.ok(source.includes('data-interface-coverage'), 'the annotated coverage must be visible');
  assert.ok(source.includes('data-action="toggle-interface-labels"'), 'all interface labels must be an explicit toggle');
});

test('live topology maps runtime identities and configured links without inventing evidence', () => {
  const data: LiveTopologyResponse = {
    generatedAt: '2026-10-23T00:00:00Z',
    host: { hostId: 'host-1', hostName: 'agent-139' },
    runtime: {
      total: 2, running: 1, stopped: 1, unverified: 0, permissionDenied: 0,
      unknown: 0, stale: 0, notDetected: 0, expected: 1,
    },
    config: { manifestConfigured: true, sourceCount: 2, availableSources: 2, complete: true },
    nodes: [
      {
        componentId: 'smf', displayName: 'SMF', processName: 'open5gs-smfd',
        role: 'smf', nfType: 'SMF', domain: '5gc', runtimeStatus: 'running',
      },
      {
        componentId: 'upf', displayName: 'UPF', processName: 'open5gs-upfd',
        role: 'upf', nfType: 'UPF', domain: '5gc', runtimeStatus: 'stopped',
      },
    ],
    edges: [{
      edgeId: 'live-edge-1',
      fromComponentId: 'smf',
      toComponentId: 'upf',
      relationshipType: 'connects_to',
      interfaceNames: ['N4'],
      protocol: 'pfcp',
      evidence: 'configured',
      state: 'active',
      fromEndpoint: { protocol: 'pfcp', address: '10.0.0.1', port: 8805 },
      toEndpoint: { protocol: 'pfcp', address: '10.0.0.2', port: 8805 },
      sourceFiles: ['/etc/open5gs/smf.yaml'],
    }],
    summary: { nodeCount: 2, edgeCount: 1, configuredEdgeCount: 1, unresolvedPeerCount: 0 },
  };

  const directory = liveDirectory(data);
  assert.equal(directory.smf.runtimeStatus, 'running');
  assert.equal(directory.smf.lifecycleState, 'unknown', 'a runtime identity is not an Inventory lifecycle claim');
  assert.equal(liveDirectory(undefined).smf, undefined, 'a missing payload never fabricates a node');

  const links = liveEdges(data);
  assert.equal(links.length, 1);
  assert.equal(links[0].source?.kind, 'configured');
  assert.equal(links[0].source?.authority, 'configured');
  assert.deepEqual(links[0].interfaceNames, ['N4']);
  assert.equal(links[0].protocol, 'pfcp');

  const layout = buildActualTopology(links, directory, {
    domainMode: 'all',
    resources: Object.values(directory),
  });
  assert.equal(layout.nodes.length, 2, 'runtime nodes render even when a component has no configured link');
  assert.equal(layout.links.length, 1);
  assert.equal(layout.nodes.find((node) => node.resourceId === 'upf')?.runtimeStatus, 'stopped');

  const markup = render(
    createElement(ActualTopologyCanvas, {
      layout,
      search: '',
      showAllInterfaceNames: true,
      onSelectResource: () => {},
      onHoverEdge: () => {},
    }),
  );
  assert.ok(markup.includes('data-runtime-status="running"'));
  assert.ok(markup.includes('data-runtime-status="stopped"'));
  assert.ok(markup.includes('Runtime: running'), 'the canvas must expose runtime status as text, not only colour');
  assert.ok(markup.includes('data-evidence="configured"'), 'configured links must be distinguishable from declared edges');
  assert.ok(markup.includes('N4'), 'interface names label the configured link');
});

test('the runtime summary only carries states present in the payload', () => {
  const states = presentRuntimeStates({
    total: 6, running: 4, stopped: 1, unverified: 0, permissionDenied: 1,
    unknown: 0, stale: 1, notDetected: 1, expected: 5,
  });
  assert.deepEqual(states, [
    { state: 'running', count: 4 },
    { state: 'stopped', count: 1 },
    { state: 'permission_denied', count: 1 },
    { state: 'stale', count: 1 },
    { state: 'not_detected', count: 1 },
  ], 'only present states render, in a stable order');
  assert.ok(!states.some((entry) => entry.count === 0), 'a zero count must not become a summary row');

  assert.deepEqual(
    presentRuntimeStates({
      total: 0, running: 0, stopped: 0, unverified: 0, permissionDenied: 0,
      unknown: 0, stale: 0, notDetected: 0, expected: 0,
    }),
    [],
    'an empty snapshot has no state summary at all',
  );
});

test('runtime completeness distinguishes an unavailable, partial and complete config read', () => {
  assert.equal(
    liveConfigCompleteness({ manifestConfigured: false, sourceCount: 0, availableSources: 0, complete: false }),
    'unavailable',
    'a missing manifest means configured evidence is unavailable',
  );
  assert.equal(
    liveConfigCompleteness({ manifestConfigured: true, sourceCount: 3, availableSources: 2, complete: false }),
    'partial',
  );
  assert.equal(
    liveConfigCompleteness({ manifestConfigured: true, sourceCount: 2, availableSources: 2, complete: true }),
    'complete',
  );
});

test('a node whose role equals its name renders one identity line', () => {
  const runtimeNode: ResourceProjection = {
    resourceId: 'amf',
    kind: 'network_function',
    name: 'AMF',
    displayName: 'AMF',
    domain: '5gc',
    role: 'amf',
    lifecycleState: 'unknown',
    runtimeStatus: 'running',
  };
  const runtimeLayout = buildActualTopology([], { amf: runtimeNode }, {
    domainMode: 'all',
    resources: [runtimeNode],
  });
  const runtimeMarkup = render(
    createElement(ActualTopologyCanvas, {
      layout: runtimeLayout,
      search: '',
      onSelectResource: () => {},
      onHoverEdge: () => {},
    }),
  );
  assert.ok(runtimeMarkup.includes('data-role-deduped="true"'), 'AMF / AMF must collapse to one visible identity');
  assert.ok(
    runtimeMarkup.includes('aria-label="AMF, 5GC / Runtime: running"'),
    'the accessible name must not repeat the role either',
  );

  const declaredNode: ResourceProjection = {
    ...runtimeNode,
    resourceId: 'amf-01',
    name: 'amf-01',
    displayName: 'AMF-01',
    lifecycleState: 'active',
    runtimeStatus: undefined,
  };
  const declaredLayout = buildActualTopology([], { 'amf-01': declaredNode }, {
    domainMode: 'all',
    resources: [declaredNode],
  });
  const declaredMarkup = render(
    createElement(ActualTopologyCanvas, {
      layout: declaredLayout,
      search: '',
      onSelectResource: () => {},
      onHoverEdge: () => {},
    }),
  );
  assert.ok(!declaredMarkup.includes('data-role-deduped="true"'), 'a distinct resource name keeps its role eyebrow');
});

test('the runtime view copy does not claim connectivity, traffic or health', () => {
  assert.equal(en.topology_live_title, 'Runtime and configured topology');
  assert.equal(zh.topology_live_title, '运行与配置拓扑');
  assert.match(en.topology_live_subtitle, /does not prove real connectivity, observed traffic or service health/);
  assert.match(zh.topology_live_subtitle, /不证明真实连通、实测流量或服务健康/);
  assert.match(en.topology_live_config_complete, /read completely/);
  assert.match(zh.topology_live_config_complete, /已完整读取/);
});

/* -------------------------------------------------------------- interfaces -- */

test('interface helpers never invent names and scope the view filters', () => {
  assert.deepEqual(edgeInterfaceNames({ interfaceNames: ['N7'] }), ['N7']);
  assert.deepEqual(edgeInterfaceNames({ interfaceNames: 'N7' }), []);
  assert.deepEqual(edgeInterfaceNames(undefined), []);

  const edges = [
    edge({ edgeId: 'iface-a', interfaceNames: ['N7'] }),
    edge({ edgeId: 'iface-b', interfaceNames: ['N4', 'N11'] }),
    edge({ edgeId: 'iface-c' }),
  ];
  assert.deepEqual(interfaceCoverage(edges), { annotated: 2, total: 3 });
  assert.deepEqual(
    filterEdgesByInterface(edges, 'N7').map((item) => item.edgeId),
    ['iface-a'],
  );
  assert.deepEqual(
    filterEdgesByInterface(edges, UNANNOTATED_INTERFACE_FILTER).map((item) => item.edgeId),
    ['iface-c'],
  );
  assert.ok(interfaceNamesInEdges(edges).includes('N11'));
  assert.deepEqual(normalizeInterfaceNames([' N7 ', 'N7', '']), ['N7']);
  assert.equal(normalizeInterfaceNames(undefined), undefined);
  assert.throws(
    () => normalizeInterfaceNames(['N4', 'N7', 'N11', 'N15', 'N22', 'N26', 'N35', 'N36', 'Nnrf']),
    /At most 8/,
  );
});

test('the production builders preserve the interface-name contract', () => {
  const create = buildCreateEdgeRequest({
    relationshipType: 'depends_on',
    fromResourceId: SMF,
    toResourceId: PCF,
    interfaceNames: [' N7 ', 'N7', 'N11'],
  });
  assert.deepEqual(create.interfaceNames, ['N7', 'N11']);

  const update = buildUpdateEdgeRequest(2, { interfaceNames: ['N4'] });
  assert.deepEqual(update.edge.interfaceNames, ['N4']);
  const preserve = buildUpdateEdgeRequest(2, {});
  assert.equal('interfaceNames' in preserve.edge, false, 'an omitted update preserves the server value');
  const clear = buildUpdateEdgeRequest(2, { interfaceNames: [] });
  assert.deepEqual(clear.edge.interfaceNames, []);
});

test('the create form offers only controlled catalog interfaces and suggested endpoints', () => {
  const markup = render(createElement(TopologyEdgeForm, {
    mode: 'create',
    relationshipTypes: ['depends_on'],
    interfaceCatalog: INTERFACE_CATALOG,
    submitting: false,
    serverError: null,
    onCancel: () => {},
  }));
  assert.ok(markup.includes('data-interface-selector="true"'));
  assert.ok(markup.includes('data-interface-name="N7"'));
  assert.ok(markup.includes('data-interface-name="Nnrf"'));
  assert.ok(markup.includes('data-interface-group="reference_point:5gc"'));
  assert.ok(markup.includes('data-interface-group="sbi:5gc"'));
  assert.ok(markup.includes('Suggested endpoints: SMF / PCF'));
  assert.ok(markup.includes('Producer: NRF'));
  assert.ok(markup.includes('0 of 8 selected'));
});

test('the edit form shows current interface names as controlled selections', () => {
  const markup = render(createElement(TopologyEdgeForm, {
    mode: 'edit',
    relationshipTypes: ['depends_on'],
    interfaceCatalog: INTERFACE_CATALOG,
    initialEdge: edge({ interfaceNames: ['N7'] }),
    submitting: false,
    serverError: null,
    onCancel: () => {},
  }));
  assert.ok(markup.includes('data-selected-interface="N7"'));
  assert.ok(markup.includes('data-interface-name="N7"'));
  assert.ok(markup.includes('1 of 8 selected'));
});

test('canvas labels prefer interface names and distinguish the relationship fallback', () => {
  const annotated = edge({ edgeId: 'interface-label', interfaceNames: ['N7'] });
  const fallback = edge({ edgeId: 'relationship-label', fromResourceId: AMF, toResourceId: PCF });
  const multi = edge({ edgeId: 'multi-label', interfaceNames: ['N7', 'N15'] });
  const layout = buildActualTopology([annotated, fallback], directory);
  const props = {
    layout,
    search: '',
    onSelectResource: () => {},
    onHoverEdge: () => {},
  };

  const quiet = render(createElement(ActualTopologyCanvas, props));
  assert.ok(!quiet.includes('data-edge-label'), 'a quiet graph reveals no label');

  const focused = render(createElement(ActualTopologyCanvas, { ...props, selectedResourceId: PCF }));
  assert.ok(focused.includes('N7'), 'the annotated edge reveals its interface name');
  assert.ok(focused.includes('depends on'), 'the unannotated edge falls back to its relationship type');
  assert.ok(focused.includes('data-label-kind="interface"'));
  assert.ok(focused.includes('data-label-kind="relationship"'));

  const allLabels = render(createElement(ActualTopologyCanvas, { ...props, showAllInterfaceNames: true }));
  assert.ok(allLabels.includes('N7'), 'the show-all control reveals annotated interface names');
  assert.ok(!allLabels.includes('depends on'), 'the show-all control does not reveal unannotated relationship labels');

  const multiLayout = buildActualTopology([multi], directory);
  const multiMarkup = render(createElement(ActualTopologyCanvas, {
    ...props,
    layout: multiLayout,
    selectedResourceId: SMF,
  }));
  assert.ok(multiMarkup.includes('N7 / N15'), 'multiple interface names are joined with a slash');
});

test('the relationship table and detail show annotated and unannotated interfaces', () => {
  const annotated = edge({ edgeId: 'table-annotated', interfaceNames: ['N7', 'N15'] });
  const plain = edge({ edgeId: 'table-plain' });
  const table = render(createElement(TopologyEdgeTable, {
    edges: [annotated, plain],
    directory,
    caption: 'Topology relationships',
    canConfigure: false,
  }));
  assert.ok(table.includes('data-interface-names="N7 N15"'));
  assert.ok(table.includes('Unannotated'));

  const detail = render(createElement(TopologyEdgeDetail, {
    edge: annotated,
    directory,
    canConfigure: false,
  }));
  assert.ok(detail.includes('data-interface-names="N7 N15"'));
  const plainDetail = render(createElement(TopologyEdgeDetail, {
    edge: plain,
    directory,
    canConfigure: false,
  }));
  assert.ok(plainDetail.includes('Unannotated'));
});

/* ------------------------------------------------------------------ table -- */

test('the relationship table renders endpoints, direction, lifecycle and full identifiers', () => {
  const markup = render(createElement(TopologyEdgeTable, {
    edges: neighbors.map((n) => n.edge),
    directory,
    caption: 'Topology relationships',
    rootResourceId: SMF,
    canConfigure: false,
  }));
  assert.ok(markup.includes(SMF) && markup.includes(PCF), 'complete UUIDs must be present without truncation');
  assert.ok(markup.includes('pcf-01') && markup.includes('amf-01'), 'readable resource names must render');
  assert.ok(markup.includes('Outbound') && markup.includes('Inbound'), 'direction must be explicit');
  assert.ok(markup.includes('Declared'), 'the declared (not observed) state must be labelled');
  assert.ok(!markup.includes('Edit'), 'a read-only role must not see mutation controls');
  assert.ok(!markup.includes('Retire'), 'a read-only role must not see retire controls');
});

test('the relationship table exposes mutation controls only to authorised roles', () => {
  const markup = render(createElement(TopologyEdgeTable, {
    edges: [edge()],
    directory,
    caption: 'Topology relationships',
    canConfigure: true,
    onEdit: () => {},
    onRetire: () => {},
  }));
  assert.ok(markup.includes('Edit'), 'an authorised role must see edit');
  assert.ok(markup.includes('Retire'), 'an authorised role must see retire');
});

test('retired relationships render without mutation controls and with a terminal label', () => {
  const markup = render(createElement(TopologyEdgeTable, {
    edges: [edge({ lifecycleState: 'retired', revision: 4 })],
    directory,
    caption: 'Topology relationships',
    canConfigure: true,
    onEdit: () => {},
    onRetire: () => {},
  }));
  assert.ok(markup.includes('Retired'), 'a retired edge must be labelled retired');
  assert.ok(!markup.includes('Retire</button>'), 'a retired edge must not offer retire again');
});

/* ----------------------------------------------------------------- detail -- */

test('the relationship detail distinguishes declared topology state from observed health', () => {
  const markup = render(createElement(TopologyEdgeDetail, {
    edge: edge(),
    directory,
    canConfigure: true,
  }));
  assert.ok(markdownSafe(markup).includes('does not prove live interface connectivity'), 'the declared-state notice must render');
  assert.ok(markup.includes('manual') && markup.includes('authoritative'), 'server-owned provenance must render');
  assert.ok(markup.includes('priority'), 'attributes must render');
});

function markdownSafe(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

/* ------------------------------------------------------------------- form -- */

test('the create form renders both resource selectors and the relationship selector', () => {
  const markup = render(createElement(TopologyEdgeForm, {
    mode: 'create',
    relationshipTypes: ['depends_on', 'connects_to'],
    submitting: false,
    serverError: null,
    onCancel: () => {},
  }));
  assert.ok(markup.includes('topology-from-resource'), 'the source selector must render');
  assert.ok(markup.includes('topology-to-resource'), 'the target selector must render');
  assert.ok(markup.includes('topology-relationship'), 'the relationship selector must render');
  assert.ok(markup.includes('depends on'), 'canonical relationship labels must render');
});

test('the edit form shows relationship identity read-only and edits only metadata', () => {
  const markup = render(createElement(TopologyEdgeForm, {
    mode: 'edit',
    relationshipTypes: ['depends_on'],
    initialEdge: edge(),
    submitting: false,
    serverError: null,
    onCancel: () => {},
  }));
  assert.ok(markup.includes(SMF) && markup.includes(PCF), 'identity must be displayed');
  assert.ok(!markup.includes('topology-from-resource'), 'identity must not be editable in edit mode');
  assert.ok(markup.includes('topology-description'), 'mutable metadata must be editable');
});

test('a stale-revision server error is surfaced to the operator', () => {
  const markup = render(createElement(TopologyEdgeForm, {
    mode: 'edit',
    relationshipTypes: ['depends_on'],
    initialEdge: edge(),
    submitting: false,
    serverError: 'This relationship changed since it was loaded.',
    onCancel: () => {},
  }));
  assert.ok(markup.includes('changed since it was loaded'), 'the server error must be visible');
});

/* --------------------------------------------------------------- builders -- */

test('a configured link only becomes a declared draft when both endpoints resolve', () => {
  const draft = buildDeclaredDraftFromLink({
    relationshipType: 'connects_to',
    interfaceNames: ['N4'],
    fromResourceId: SMF,
    toResourceId: PCF,
    description: 'Declared from configured NF evidence',
  });
  assert.deepEqual(draft, {
    relationshipType: 'connects_to',
    fromResourceId: SMF,
    toResourceId: PCF,
    interfaceNames: ['N4'],
    description: 'Declared from configured NF evidence',
  });
  assert.equal(
    buildDeclaredDraftFromLink({ relationshipType: 'connects_to', interfaceNames: [], fromResourceId: SMF, description: 'x' }),
    null,
    'a link without an Inventory association must not invent an endpoint',
  );
  assert.equal(
    buildDeclaredDraftFromLink({ relationshipType: '', interfaceNames: [], fromResourceId: SMF, toResourceId: PCF, description: 'x' }),
    null,
  );
});

test('the create builder rejects self edges, unknown identifiers and server-owned fields', () => {
  assert.throws(() => buildCreateEdgeRequest({ relationshipType: 'depends_on', fromResourceId: SMF, toResourceId: SMF }), /itself/);
  assert.throws(() => buildCreateEdgeRequest({ relationshipType: 'depends_on', fromResourceId: 'nope', toResourceId: PCF }), /source resource/);
  assert.throws(() => buildCreateEdgeRequest({ relationshipType: 'depends_on', fromResourceId: SMF, toResourceId: PCF, revision: 3 } as never), /server-owned/);

  const ok = buildCreateEdgeRequest({
    relationshipType: 'depends_on',
    fromResourceId: SMF,
    toResourceId: PCF,
    description: '  SMF depends on PCF  ',
  });
  assert.equal(ok.relationshipType, 'depends_on');
  assert.equal(ok.description, 'SMF depends on PCF');
  assert.ok(!('edgeId' in ok) && !('revision' in ok) && !('source' in ok), 'the builder must never emit server-owned fields');
});

test('the update builder supports empty metadata replacement', () => {
  const req = buildUpdateEdgeRequest(2, {});
  assert.equal(req.expectedRevision, 2);
  assert.deepEqual(req.edge, { description: '', labels: {}, attributes: {} });
  assert.throws(() => buildUpdateEdgeRequest(0, {}), /positive integer/);
});

test('the retire builder requires a bounded non-empty reason', () => {
  assert.equal(buildRetireEdgeRequest(3, '  no longer applicable  ').reason, 'no longer applicable');
  assert.throws(() => buildRetireEdgeRequest(3, '   '), /reason is required/);
  assert.throws(() => buildRetireEdgeRequest(3, 'x'.repeat(513)), /512/);
});

/* ------------------------------------------------------------------ i18n -- */

test('topology locale keys exist in English and Chinese and are distinct', () => {
  const keys = [
    'nav_topology', 'topology_title', 'topology_create_relationship', 'topology_declared_notice',
    'topology_rel_depends_on', 'topology_state_retired', 'topology_stale_revision_body',
    'topology_view_actual', 'topology_actual_node_count', 'topology_actual_coverage_hint',
    'topology_actual_partial_notice',
    'topology_search_matches', 'topology_search_no_match',
    'topology_actual_unavailable_title', 'topology_actual_unavailable_body',
    'topology_actual_support_show', 'topology_actual_support_hide', 'topology_actual_hidden_support',
    'topology_actual_no_nf_title', 'topology_actual_no_nf_body', 'topology_support_resource',
    'topology_actual_empty_declared_title', 'topology_actual_empty_declared_body',
    'topology_actual_open_runtime',
    'topology_primary_view_label', 'topology_primary_graph', 'topology_primary_ledger',
    'topology_source_label', 'topology_source_declared', 'topology_source_runtime',
    'topology_source_reference', 'topology_source_evidence_declared',
    'topology_source_evidence_runtime', 'topology_source_evidence_reference',
    'topology_source_notes', 'topology_source_note_declared', 'topology_source_note_runtime',
    'topology_source_note_reference', 'topology_runtime_scope_label',
    'topology_runtime_scope_config', 'topology_runtime_scope_hierarchy',
    'topology_inspector_label', 'topology_close_inspector',
    'topology_runtime_label',
    'topology_live_title', 'topology_live_subtitle', 'topology_live_runtime_total',
    'topology_live_search_placeholder',
    'topology_live_configured_edges', 'topology_live_config_complete',
    'topology_live_config_incomplete', 'topology_live_config_unconfigured',
    'topology_live_unresolved_peers', 'topology_live_selected', 'topology_live_process',
    'topology_live_detail_empty',
    'topology_live_type_domain', 'topology_live_listeners', 'topology_live_no_listeners',
    'topology_live_open_inventory', 'topology_live_edges_title', 'topology_live_no_edges',
    'topology_live_unresolved_title', 'topology_live_open_architecture',
    'topology_live_error_title', 'topology_live_error_body', 'topology_live_endpoint',
    'topology_live_evidence', 'topology_live_state', 'topology_live_sources',
    'topology_live_state_active', 'topology_live_state_partial', 'topology_live_state_inactive',
    'topology_live_state_unknown', 'topology_live_evidence_configured',
    'topology_actual_boundary_count', 'topology_actual_cross_domain_count',
    'topology_actual_boundary_show', 'topology_actual_boundary_hide', 'topology_actual_hidden_boundary',
    'topology_actual_domain_empty_title', 'topology_actual_domain_empty_body',
    'topology_actual_boundary_label', 'topology_actual_proxy_label', 'topology_actual_proxy_via',
    'topology_open_ledger', 'topology_zoom_in', 'topology_zoom_out', 'topology_fit_view',
    'topology_reset_view', 'topology_fullscreen', 'topology_exit_fullscreen', 'topology_clear_focus',
    'topology_canvas_controls',
  ];
  for (const key of keys) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en must define ${key}`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh must define ${key}`);
    assert.notEqual(en[key], zh[key], `${key} must be localized in both languages`);
  }
  for (const group of ['access', 'session', 'discovery', 'data', 'policy', 'ims', 'user', 'other', 'support']) {
    const key = `topology_group_${group}`;
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en must define ${key}`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh must define ${key}`);
    assert.notEqual(en[key], zh[key], `${key} must be localized in both languages`);
  }
  for (const key of [
    'topology_domain_all', 'topology_domain_epc', 'topology_domain_5gc', 'topology_domain_ims',
    'topology_domain_charging', 'topology_domain_cross', 'topology_domain_unclassified',
    'topology_domain_boundary',
    'topology_lane_count', 'topology_lane_abnormal', 'topology_lane_focus',
  ]) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en must define ${key}`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh must define ${key}`);
  }
  for (const key of [
    'topology_interfaces', 'topology_interface_title', 'topology_interface_hint',
    'topology_interface_search', 'topology_interface_selected',
    'topology_interface_category_reference_point', 'topology_interface_category_sbi',
    'topology_interface_plane_control', 'topology_interface_plane_user', 'topology_interface_plane_both',
    'topology_interface_producer', 'topology_interface_endpoints', 'topology_interface_variable_endpoints',
    'topology_interface_unannotated', 'topology_interface_catalog_unavailable',
    'topology_interface_no_match', 'topology_interface_limit', 'topology_interface_remove',
    'topology_interface_coverage', 'topology_interface_filter', 'topology_interface_filter_all',
    'topology_interface_show_all', 'topology_interface_hide_all',
    'topology_interface_empty_title', 'topology_interface_empty_body',
    'topology_interface_clear_filter',
  ]) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en must define ${key}`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh must define ${key}`);
    assert.notEqual(en[key], zh[key], `${key} must be localized in both languages`);
  }
  assert.ok(/[\u4e00-\u9fff]/.test(zh.topology_title), 'the Chinese title must contain Chinese characters');
  assert.match(en.topology_actual_unavailable_body, /not evidence that no relationship exists/);
  assert.match(zh.topology_actual_unavailable_body, /空图不代表不存在关系/);
});

test('the relationship presentation covers exactly the nine canonical types', () => {
  assert.equal(Object.keys(RELATIONSHIP_PRESENTATION).length, 9);
  for (const value of ['contains', 'runs_on', 'depends_on', 'connects_to', 'routes_to', 'registers_with', 'serves', 'uses', 'exposes']) {
    assert.ok(RELATIONSHIP_PRESENTATION[value], `${value} must have a presentation entry`);
  }
  assert.ok(DOMAIN_FILTER_BUCKETS.length >= 4, 'domain presentation buckets must exist');
});

/* ------------------------------------------------------------------ pages -- */

test('the topology page defaults to the runtime graph and still renders', () => {
  const markup = renderPage(createElement(TopologyPage));
  assert.ok(markup.includes('Topology'), 'the page title must render');
  assert.ok(markup.includes('data-topology-view="actual"'), 'the graph view must render');
  assert.ok(markup.includes('data-topology-view="ledger"'), 'the primary view switch must render');
  assert.ok(markup.includes('data-topology-source-bar="runtime"'), 'the runtime source must be selected');
  assert.ok(markup.includes('data-runtime-scope="config"'), 'the configured runtime projection must be rendered');
  // The relationship ledger and declared canvas are explicit, non-default views.
  assert.ok(!markup.includes('topology-filter-from'), 'the ledger must not render behind the graph');
  assert.ok(!markup.includes('id="actual-topology-title"'), 'the declared canvas must not render behind the graph');
  assert.ok(!markup.includes('data-testid="runtime-discovery"'), 'the runtime surface must not render behind the canvas');
});

test('the relationship ledger renders on its own view', () => {
  const markup = renderPage(createElement(TopologyPage), '/topology?view=relationships');
  assert.ok(markup.includes('topology-filter-from'), 'the from-resource filter must render');
  assert.ok(markup.includes('topology-filter-to'), 'the to-resource filter must render');
});

test('the reference architecture stays reachable without replacing the graph', () => {
  const markup = renderPage(createElement(TopologyPage), '/topology?view=architecture');
  assert.ok(markup.includes('id="architecture-title"'), 'the reference canvas must render on its own source');
  assert.ok(markup.includes('data-topology-source-bar="reference"'), 'the source switch must name the evidence');
  assert.ok(!markup.includes('id="actual-topology-title"'), 'the declared graph must not render behind it');
});

test('the resource topology page renders a loading state for a resource, never fabricated data', () => {
  const markup = renderPage(
    createElement(ResourceTopologyPage),
    `/topology/${SMF}`,
    '/topology/:resourceId',
  );
  assert.ok(markup.includes('Loading'), 'the initial state must be a loading state');
  assert.ok(!markup.includes('Declared'), 'no relationship may be fabricated before the API responds');
});
