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
  buildRetireEdgeRequest,
  buildUpdateEdgeRequest,
} from '../src/features/topology/topology-builders';
import {
  RELATIONSHIP_PRESENTATION,
  DOMAIN_FILTER_BUCKETS,
  type Neighbor,
  type ResourceProjection,
  type TopologyEdge,
} from '../src/features/topology/topology-types';
import { en } from '../src/lib/locales/en';
import { zh } from '../src/lib/locales/zh';
import { buildActualTopology, groupForResource, nodeMatches } from '../src/features/topology/actual-topology-model';
import {
  classifyResource,
  nfRoleLabel,
  normalizeRoleToken,
} from '../src/features/topology/nf-classification';
import {
  edgeGeometry,
  placeEdgeLabels,
  pointOnGeometry,
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
  const empty = source.indexOf('layout.activeLinkCount === 0');
  const filteredEmpty = source.indexOf('layout.nodes.length === 0');
  assert.ok(unavailable >= 0, 'an unavailable read must have its own state');
  assert.ok(empty >= 0, 'a genuinely empty topology must have its own state');
  assert.ok(filteredEmpty > empty, 'a topology with only hidden support resources must have its own state');
  assert.ok(unavailable < empty, 'a failed read must never fall through to the empty state');
  assert.ok(source.includes("topology_actual_unavailable_title"));
  assert.ok(source.includes("topology_actual_empty_title"));
  assert.ok(source.includes("topology_actual_no_nf_title"));
  assert.ok(source.includes('data-action="toggle-support"'), 'support visibility must be an explicit control');
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
    'topology_search_matches', 'topology_search_no_match', 'topology_actual_empty_title',
    'topology_actual_empty_body', 'topology_actual_unavailable_title', 'topology_actual_unavailable_body',
    'topology_actual_support_show', 'topology_actual_support_hide', 'topology_actual_hidden_support',
    'topology_actual_no_nf_title', 'topology_actual_no_nf_body', 'topology_support_resource',
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

test('the topology page defaults to actual topology and still renders', () => {
  const markup = renderPage(createElement(TopologyPage));
  assert.ok(markup.includes('Topology'), 'the page title must render');
  assert.ok(markup.includes('data-topology-view="actual"'), 'the actual topology view must render');
  assert.ok(markup.includes('data-topology-view="architecture"'), 'the view switch must render');
  assert.ok(markup.includes('actual-topology-title'), 'the actual topology section must be rendered');
  // The relationship ledger and runtime tree are exclusive views, so neither
  // is rendered behind the default topology canvas.
  assert.ok(!markup.includes('topology-filter-from'), 'the ledger must not render on the architecture view');
  assert.ok(!markup.includes('data-testid="runtime-discovery"'), 'the runtime surface must not render behind the canvas');
});

test('the relationship ledger renders on its own view', () => {
  const markup = renderPage(createElement(TopologyPage), '/topology?view=relationships');
  assert.ok(markup.includes('topology-filter-from'), 'the from-resource filter must render');
  assert.ok(markup.includes('topology-filter-to'), 'the to-resource filter must render');
});

test('the reference architecture stays reachable without replacing the actual view', () => {
  const markup = renderPage(createElement(TopologyPage), '/topology?view=architecture');
  assert.ok(markup.includes('id="architecture-title"'), 'the reference canvas must render on its own view');
  assert.ok(!markup.includes('id="actual-topology-title"'), 'the actual canvas must not render behind it');
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
