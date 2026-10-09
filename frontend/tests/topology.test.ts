/*
 * Topology feature behaviour tests.
 *
 * These render the real production components server-side from fixtures and
 * assert operator-observable output, not source strings. `fetch` is replaced by
 * a throwing stub so the suite also proves the presentational surfaces never
 * reach for the network on their own.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/providers/I18nProvider';
import { AuthProvider } from '../src/providers/AuthProvider';
import { TopologyGraph } from '../src/features/topology/components/TopologyGraph';
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

const SMF = '2f1a6a52-6c7f-4f8a-9f2b-0f7d4a1c8e33';
const PCF = '8c9d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const AMF = '3a4b5c6d-7e8f-4a1b-9c2d-3e4f5a6b7c8d';

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
  ];
  for (const key of keys) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en must define ${key}`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh must define ${key}`);
    assert.notEqual(en[key], zh[key], `${key} must be localized in both languages`);
  }
  assert.ok(/[\u4e00-\u9fff]/.test(zh.topology_title), 'the Chinese title must contain Chinese characters');
});

test('the relationship presentation covers exactly the nine canonical types', () => {
  assert.equal(Object.keys(RELATIONSHIP_PRESENTATION).length, 9);
  for (const value of ['contains', 'runs_on', 'depends_on', 'connects_to', 'routes_to', 'registers_with', 'serves', 'uses', 'exposes']) {
    assert.ok(RELATIONSHIP_PRESENTATION[value], `${value} must have a presentation entry`);
  }
  assert.ok(DOMAIN_FILTER_BUCKETS.length >= 4, 'domain presentation buckets must exist');
});

/* ------------------------------------------------------------------ pages -- */

test('the topology list page renders inside the shell providers without network access', () => {
  const markup = renderPage(createElement(TopologyPage));
  assert.ok(markup.includes('Topology'), 'the page title must render');
  assert.ok(markup.includes('topology-filter-from'), 'the from-resource filter must render');
  assert.ok(markup.includes('topology-filter-to'), 'the to-resource filter must render');
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
