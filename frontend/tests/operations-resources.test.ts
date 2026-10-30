/*
 * UX-2 contract tests: operations resource projection.
 *
 * Reference: docs/analyze/cnms-port-assessment-2026-10-18.md sections 5.1, 6.1
 * and the UX-2 row of section 8.
 *
 * The projection replaces the two-stage browser join (Inventory page + an
 * unrelated NF Health target page). These tests pin the parts that make that
 * replacement safe: the bounded request, the total adapter (unresolved is never
 * unmonitored) and the per-dimension completeness projection.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  adaptCompleteness,
  adaptOperationsResource,
  adaptOperationsResources,
  operationsResourcesPath,
  OPERATIONS_RESOURCE_LIMIT,
  type OperationsResourceDto,
  type OperationsResourcesResponse,
} from '../src/features/operations/operations-resources';
import { unmanagedComponents } from '../src/features/inventory/NetworkElementView';
import type { RuntimeComponent } from '../src/features/runtime/runtime-types';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function dto(overrides: Partial<OperationsResourceDto> = {}): OperationsResourceDto {
  return {
    resourceId: 'r-1',
    name: 'smf-01',
    domain: '5gc',
    kind: 'network_function',
    role: 'smf',
    lifecycleState: 'active',
    isNetworkFunction: true,
    association: 'confirmed',
    runtimeBinding: { state: 'bound', unit: 'smfd.service' },
    monitoring: {
      targetId: 't-1',
      enabled: true,
      nfType: 'SMF',
      overallState: 'healthy',
      statusComplete: true,
      coverage: { l1Measured: true, l2Measured: true, l3Measured: false, l3Available: false },
      freshness: { state: 'fresh', ageSeconds: 12, policySeconds: 300 },
      latestSampleAt: '2026-10-19T11:58:00Z',
      lastRunStatus: 'success',
      lastRunAt: '2026-10-19T11:58:00Z',
      resourceMetrics: [
        { key: 'process_cpu_seconds_total', value: 120, unit: 's', type: 'counter', collectedAt: '2026-10-19T11:58:00Z', category: 'resource' },
        { key: 'process_resident_memory_bytes', value: 1048576, unit: 'By', type: 'gauge', collectedAt: '2026-10-19T11:58:00Z', category: 'resource' },
      ],
    },
    ...overrides,
  };
}

function response(resources: OperationsResourceDto[], overrides: Partial<OperationsResourcesResponse> = {}): OperationsResourcesResponse {
  return {
    generatedAt: '2026-10-19T12:00:00Z',
    completeness: { inventory: 'complete', monitoring: 'complete', telemetry: 'complete', overall: 'complete' },
    page: { limit: OPERATIONS_RESOURCE_LIMIT, hasMore: false, nextCursor: null },
    resources,
    ...overrides,
  };
}

/* ------------------------------------------------------------- request -- */

test('the projection request is bounded and only carries declared filters', () => {
  const path = operationsResourcesPath({});
  assert.ok(path.startsWith('/api/operations/resources?'));
  assert.ok(path.includes(`limit=${OPERATIONS_RESOURCE_LIMIT}`));
  assert.ok(!path.includes('q='), 'an empty query must not be sent');

  const filtered = operationsResourcesPath({
    q: 'smf',
    domain: '5gc',
    kind: 'network_function',
    monitoring: 'monitored',
    roles: ['smf', 'pcf'],
    cursor: 'abc',
  });
  assert.ok(filtered.includes('q=smf'));
  assert.ok(filtered.includes('domain=5gc'));
  assert.ok(filtered.includes('kind=network_function'));
  assert.ok(filtered.includes('monitoring=monitored'));
  assert.ok(filtered.includes('roles=smf%2Cpcf'), 'roles are sent as one bounded list');
  assert.ok(filtered.includes('cursor=abc'));
});

/* ------------------------------------------------------------- adapter -- */

test('a confirmed resource keeps its monitoring projection', () => {
  const item = adaptOperationsResource(dto());
  assert.equal(item.association, 'confirmed');
  assert.equal(item.nfType, 'SMF');
  assert.equal(item.typeLabel, 'SMF');
  assert.equal(item.isNetworkFunction, true);
  assert.equal(item.monitoring?.targetId, 't-1');
  assert.equal(item.monitoring?.coverage.l1Measured, true);
  assert.equal(item.monitoring?.freshnessState, 'fresh');
  assert.equal(item.runtimeBinding?.state, 'bound');
});

test('an unresolved association is never rendered as unmonitored', () => {
  const item = adaptOperationsResource(dto({ association: 'unresolved', monitoring: undefined }));
  assert.equal(item.association, 'unresolved');
  assert.equal(item.monitoring, null);
  assert.notEqual(item.association, 'absent');
});

test('a resolved absence stays distinct from an unresolved association', () => {
  const item = adaptOperationsResource(dto({ association: 'absent', monitoring: undefined }));
  assert.equal(item.association, 'absent');
  assert.equal(item.monitoring, null);
});

test('the adapter never invents an NF type from the resource name', () => {
  const item = adaptOperationsResource(dto({
    name: 'SMF',
    role: '',
    monitoring: undefined,
    association: 'absent',
  }));
  assert.equal(item.nfType, '');
  assert.equal(item.typeLabel, '-');
});

test('retired lifecycle is projected explicitly', () => {
  const item = adaptOperationsResource(dto({ lifecycleState: 'retired', association: 'absent', monitoring: undefined }));
  assert.equal(item.retired, true);
});

/* --------------------------------------------------------- completeness -- */

test('completeness is reported per dimension and combined honestly', () => {
  const complete = adaptCompleteness(
    { inventory: 'complete', monitoring: 'complete', telemetry: 'complete', overall: 'complete' },
    'complete',
  );
  assert.equal(complete.overall, 'complete');

  const partial = adaptCompleteness(
    { inventory: 'partial', monitoring: 'complete', telemetry: 'complete', overall: 'complete' },
    'complete',
  );
  assert.equal(partial.inventory, 'partial');
  assert.equal(partial.overall, 'partial');

  const unavailable = adaptCompleteness(
    { inventory: 'complete', monitoring: 'unavailable', telemetry: 'unavailable', overall: 'unavailable' },
    'partial',
  );
  assert.equal(unavailable.overall, 'unavailable');

  const failed = adaptCompleteness(undefined, 'complete', true);
  assert.equal(failed.overall, 'unavailable');
  assert.equal(failed.inventory, 'unavailable');
});

test('a missing server dimension is partial, never complete', () => {
  const report = adaptCompleteness(undefined, 'complete');
  assert.equal(report.inventory, 'partial');
  assert.equal(report.overall, 'partial');
});

/* ------------------------------------------------------- 60-row fixture -- */

test('a 60-resource population is consumed one bounded page at a time', () => {
  const page = Array.from({ length: OPERATIONS_RESOURCE_LIMIT }, (_, index) =>
    dto({ resourceId: `r-${index}`, name: `nf-${index}` }));
  const first = response(page, {
    completeness: { inventory: 'partial', monitoring: 'complete', telemetry: 'complete', overall: 'partial' },
    page: { limit: OPERATIONS_RESOURCE_LIMIT, hasMore: true, nextCursor: 'cursor-2' },
  });

  const items = adaptOperationsResources(first);
  assert.equal(items.length, OPERATIONS_RESOURCE_LIMIT);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.page.nextCursor, 'cursor-2');

  const report = adaptCompleteness(first.completeness, 'complete');
  assert.equal(report.inventory, 'partial', 'the first page is not the population');
  assert.equal(report.overall, 'partial');
});

test('an unavailable page projects to zero items, not to fabricated rows', () => {
  assert.deepEqual(adaptOperationsResources(undefined), []);
});

/* ------------------------------------------------------ unmanaged filter -- */

function component(overrides: Partial<RuntimeComponent>): RuntimeComponent {
  return {
    componentId: 'c-1',
    displayName: 'SMF',
    processName: 'smfd',
    nfType: 'SMF',
    category: 'cn',
    verified: true,
    runtimeStatus: 'running',
    evidence: 'verified',
    inventoryAssociation: { state: 'absent' },
    nfHealthAssociation: { state: 'absent' },
    ...overrides,
  } as RuntimeComponent;
}

test('unmanaged processes are verified, running and unassociated only', () => {
  const components = [
    component({ componentId: 'c-1' }),
    component({ componentId: 'c-2', inventoryAssociation: { state: 'associated', id: 'r-1' } }),
    component({ componentId: 'c-3', verified: false }),
    component({ componentId: 'c-4', runtimeStatus: 'stopped' }),
  ];
  const unmanaged = unmanagedComponents(components);
  assert.deepEqual(unmanaged.map((item) => item.componentId), ['c-1']);
});

/* ------------------------------------------------------ source contract -- */

test('the inventory route declares the projection endpoint', () => {
  const contract = JSON.parse(read('../read-contract.json')) as Array<{ route: string; readEndpoints: string[] }>;
  const inventory = contract.find((entry) => entry.route === '/inventory');
  assert.ok(inventory, 'the inventory route must exist in the read contract');
  assert.ok(inventory.readEndpoints.includes('GET /api/operations/resources'));
});

test('the network-element view no longer assembles the join in the browser', () => {
  const source = read('../src/features/inventory/NetworkElementView.tsx');
  assert.ok(
    !source.includes('/api/nf-health/targets?resourceIds='),
    'the two-stage resource/target assembly must be gone',
  );
  assert.ok(source.includes('operationsResourcesPath('), 'the view must read the projection');
  assert.ok(source.includes('/api/operations/summary?sections=inventory,health'), 'KPIs must come from the summary');
});

test('the card wall and the table are mutually exclusive', () => {
  const source = read('../src/features/inventory/NetworkElementView.tsx');
  assert.match(source, /presentation === 'cards' \? \(/, 'cards must be a separate branch');
  const cardsIndex = source.indexOf("presentation === 'cards' ? (");
  const tableIndex = source.indexOf('<table className={styles.neTable}>');
  assert.ok(tableIndex > cardsIndex, 'the table must live in the non-cards branch');
  assert.ok(!source.includes('<NetworkElementCards items={visibleItems} />\n            </div>'), 'cards are never stacked under the table');
});

test('the tree node count is scoped instead of bare', () => {
  const source = read('../src/features/inventory/NetworkElementView.tsx');
  assert.ok(source.includes("t('ops_tree_loaded'"), 'tree nodes must report loaded counts');
  assert.ok(!/treeResourceIds\(node\)\.length\}<\/span>/.test(source), 'a bare count must not be rendered');
});

test('filter changes clear the tree node in the same URL write without erasing a shared node on mount', () => {
  const source = read('../src/features/inventory/NetworkElementView.tsx');
  assert.ok(source.includes('useRef<string | null>(null)'), 'the first URL render must establish, not clear, query state');
  assert.ok(source.includes('if (queryKeyRef.current === null)'), 'a shared node must survive the initial mount');
  assert.ok(source.includes('url.setFilters({ [key]: value, node: null })'), 'a filter transition must clear the node atomically');
});

test('the detail drawer preserves unresolved association semantics', () => {
  const source = read('../src/features/inventory/ResourceDetailDrawer.tsx');
  assert.ok(source.includes("resource.association === 'unresolved'"));
  assert.ok(source.includes("t('ops_association_unresolved')"));
});
