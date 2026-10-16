/*
 * Operational view-model tests.
 *
 * These assert the honesty rules of the operational projection: canonical
 * identity joins, no duplicate counting, no fabricated health, correct CPU and
 * memory semantics, and a hierarchy built only from declared containment.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResolvedNFTypes,
  buildOperationalResources,
  buildResourceTree,
  combineCompleteness,
  cpuView,
  formatBytes,
  groupByDomain,
  layerLabel,
  memoryView,
  NETWORK_FUNCTION_KINDS,
  normalizeDomain,
  summarizeOperational,
  treeResourceIds,
  type CompletenessReport,
  type TopologyCoverage,
} from '../src/features/operations/operational-model';

const COMPLETE: CompletenessReport = combineCompleteness({
  inventory: 'complete',
  monitoring: 'complete',
  telemetry: 'complete',
  topology: 'complete',
});

const completeness = (
  inventory: CompletenessReport['inventory'] = 'complete',
  monitoring: CompletenessReport['monitoring'] = 'complete',
  telemetry: CompletenessReport['telemetry'] = 'complete',
  topology: CompletenessReport['topology'] = 'complete',
): CompletenessReport => combineCompleteness({ inventory, monitoring, telemetry, topology });

const resource = (
  resourceId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  _id: resourceId,
  name: `nf-${resourceId.slice(-4)}`,
  domain: '5gc',
  kind: 'network_function_instance',
  role: 'amf',
  lifecycleState: 'active',
  revision: 1,
  ...overrides,
});

const target = (resourceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  targetId: `target-${resourceId.slice(-4)}`,
  resourceId,
  enabled: true,
  nfType: 'AMF',
  overallState: 'unknown',
  statusComplete: true,
  coverage: { l1Measured: true, l2Measured: true, l3Measured: true, l3Available: true },
  freshness: { state: 'fresh', ageSeconds: 12, policySeconds: 180 },
  layers: {
    process: { state: 'healthy', measured: true },
    interface: { state: 'healthy', measured: true },
    service: { state: 'unknown', measured: true, reason: 'activity_observed' },
  },
  latestSampleAt: '2026-10-16T04:00:00Z',
  lastRunStatus: 'success',
  resourceMetrics: [
    { key: 'process_cpu_seconds_total', value: 128.5, unit: 'seconds', type: 'counter' },
    { key: 'process_resident_memory_bytes', value: 1048576, unit: 'bytes', type: 'gauge' },
  ],
  ...overrides,
});

/** Builds the operational items the tree consumes (canonical resourceId join). */
const operationalItems = (resources: Record<string, unknown>[]) =>
  buildOperationalResources(resources, []).items;

test('operations: canonical domains are normalized without recategorizing charging', () => {
  assert.equal(normalizeDomain('epc'), 'epc');
  assert.equal(normalizeDomain('5GC'), '5gc');
  assert.equal(normalizeDomain('ims'), 'ims');
  assert.equal(normalizeDomain('charging'), 'charging');
  assert.equal(normalizeDomain('platform'), 'unknown');
  assert.equal(normalizeDomain(undefined), 'unknown');
});

test('operations: resources join monitoring by canonical resourceId only', () => {
  const resources = [resource('aaaaaaaa-0001-4a01-8c01-000000000001')];
  const targets = [target('aaaaaaaa-0001-4a01-8c01-000000000001'), target('bbbbbbbb-0002-4b02-8b02-000000000002')];
  const { items } = buildOperationalResources(resources, targets);
  assert.equal(items.length, 1);
  assert.ok(items[0].monitoring, 'the matching target must attach');
  assert.equal(items[0].monitoring?.targetId, 'target-0001');
  // A target for an unknown resource never creates a resource entry.
  assert.equal(items.filter((item) => item.resourceId.startsWith('bbbb')).length, 0);
});

test('operations: a resource without monitoring stays a valid managed resource', () => {
  const resources = [resource('aaaaaaaa-0003-4a03-8c03-000000000003')];
  const { items } = buildOperationalResources(resources, [], true);
  assert.equal(items[0].monitoring, null);
  const summary = summarizeOperational(items, COMPLETE);
  assert.equal(summary.registered, 1);
  assert.equal(summary.monitored, 0);
  assert.equal(summary.unmonitored, 1);
  // Unmonitored is not "stopped": nothing claims an unhealthy state.
  assert.equal(summary.unhealthy, 0);
  assert.equal(summary.degraded, 0);
});

test('operations: duplicate targets for one resource never double-count the NF', () => {
  const resources = [resource('aaaaaaaa-0004-4a04-8c04-000000000004')];
  const targets = [
    target('aaaaaaaa-0004-4a04-8c04-000000000004', { enabled: false, targetId: 'target-disabled' }),
    target('aaaaaaaa-0004-4a04-8c04-000000000004', { enabled: true, targetId: 'target-enabled' }),
  ];
  const { items, duplicateTargetResources } = buildOperationalResources(resources, targets);
  assert.equal(items.length, 1, 'one entry per Inventory resource');
  assert.equal(items[0].monitoring?.targetId, 'target-enabled', 'the enabled target wins');
  assert.deepEqual(duplicateTargetResources, ['aaaaaaaa-0004-4a04-8c04-000000000004']);
  const summary = summarizeOperational(items, COMPLETE);
  assert.equal(summary.monitored, 1);
});

test('operations: retired resources are excluded from operational counts', () => {
  const resources = [
    resource('aaaaaaaa-0005-4a05-8c05-000000000005'),
    resource('aaaaaaaa-0006-4a06-8c06-000000000006', { lifecycleState: 'retired' }),
  ];
  const { items } = buildOperationalResources(resources, []);
  const summary = summarizeOperational(items, COMPLETE);
  assert.equal(summary.registered, 1, 'retired resources are not operational population');
  assert.equal(items.filter((item) => item.retired).length, 1, 'retired resources stay visible in the list');
});

test('operations: multiple instances are never collapsed into one NF', () => {
  const resources = [
    resource('aaaaaaaa-0007-4a07-8c07-000000000007', { name: 'pcscf-01' }),
    resource('aaaaaaaa-0008-4a08-8c08-000000000008', { name: 'pcscf-02', domain: 'ims', role: 'pcscf' }),
    resource('aaaaaaaa-0009-4a09-8c09-000000000009', { kind: 'network_function', name: 'pcscf-logical', domain: 'ims', role: 'pcscf' }),
  ];
  const { items } = buildOperationalResources(resources, []);
  assert.equal(items.length, 3, 'logical NF and both instances stay separate');
  const summary = summarizeOperational(items, COMPLETE);
  assert.equal(summary.registered, 3);
});

test('operations: domain grouping uses canonical domains and reports absent ones', () => {
  const resources = [
    resource('aaaaaaaa-000a-4a0a-8c0a-00000000000a'),
    resource('aaaaaaaa-000b-4a0b-8c0b-00000000000b', { domain: 'epc', role: 'mme' }),
    resource('aaaaaaaa-000c-4a0c-8c0c-00000000000c', { domain: 'charging', role: 'ocs' }),
    resource('aaaaaaaa-000d-4a0d-8c0d-00000000000d', { domain: 'platform', role: '' }),
  ];
  const { items } = buildOperationalResources(resources, []);
  const groups = groupByDomain(items, false, true);
  const domains = groups.map((group) => group.domain);
  assert.deepEqual(domains, ['epc', '5gc', 'charging', 'unknown']);
  assert.equal(groups.find((group) => group.domain === 'unknown')?.resources.length, 1);
});

test('operations: activity-only service evidence never becomes healthy', () => {
  const resources = [resource('aaaaaaaa-000e-4a0e-8c0e-00000000000e')];
  const targets = [target('aaaaaaaa-000e-4a0e-8c0e-00000000000e')];
  const { items } = buildOperationalResources(resources, targets);
  const summary = summarizeOperational(items, COMPLETE);
  assert.equal(summary.healthy, 0, 'unknown overall state is not counted healthy');
  assert.equal(summary.unknown, 1);
  assert.equal(items[0].monitoring?.service?.reason, 'activity_observed');
  // Layer coverage is reported truthfully, independent of health.
  assert.equal(layerLabel(items[0].monitoring!.coverage, 'l1'), 'measured');
  assert.equal(layerLabel(items[0].monitoring!.coverage, 'l3'), 'measured');
});

test('operations: stale and unknown freshness are counted separately from fresh', () => {
  const resources = [
    resource('aaaaaaaa-000f-4a0f-8c0f-00000000000f'),
    resource('aaaaaaaa-0010-4a10-8c10-000000000010'),
    resource('aaaaaaaa-0011-4a11-8c11-000000000011'),
  ];
  const targets = [
    target('aaaaaaaa-000f-4a0f-8c0f-00000000000f'),
    target('aaaaaaaa-0010-4a10-8c10-000000000010', { freshness: { state: 'stale', ageSeconds: 900, policySeconds: 180 } }),
    target('aaaaaaaa-0011-4a11-8c11-000000000011', { freshness: { state: 'unknown', reason: 'no_accepted_measurement' } }),
  ];
  const { items } = buildOperationalResources(resources, targets);
  const summary = summarizeOperational(items, COMPLETE);
  // Freshness and overall state are orthogonal dimensions: each resource is
  // counted once per dimension, never conflated.
  assert.equal(summary.fresh, 1);
  assert.equal(summary.stale, 1);
  assert.equal(summary.freshnessUnknown, 1);
  assert.equal(summary.monitored, 3);
  // All three carry activity-only service evidence, so no positive claim exists.
  assert.equal(summary.unknown, 3);
  assert.equal(summary.healthy, 0);
});

test('operations: disabled targets and failed runs are surfaced without claiming health', () => {
  const resources = [
    resource('aaaaaaaa-0012-4a12-8c12-000000000012'),
    resource('aaaaaaaa-0013-4a13-8c13-000000000013'),
  ];
  const targets = [
    target('aaaaaaaa-0012-4a12-8c12-000000000012', { enabled: false }),
    target('aaaaaaaa-0013-4a13-8c13-000000000013', { lastRunStatus: 'failed' }),
  ];
  const { items } = buildOperationalResources(resources, targets);
  const summary = summarizeOperational(items, COMPLETE);
  assert.equal(summary.disabledTargets, 1);
  assert.equal(summary.failedLastRun, 1);
  assert.equal(summary.degraded, 0);
  assert.equal(summary.unhealthy, 0);
});

test('operations: partial data is reported as partial, never as a platform total', () => {
  const resources = [resource('aaaaaaaa-0014-4a14-8c14-000000000014')];
  const { items } = buildOperationalResources(resources, []);
  assert.equal(summarizeOperational(items, completeness('partial')).completeness.overall, 'partial');
  assert.equal(
    summarizeOperational(items, completeness('complete', 'unavailable')).completeness.overall,
    'unavailable',
    'an unavailable source dominates the combined completeness',
  );
  assert.equal(summarizeOperational(items, COMPLETE).completeness.overall, 'complete');
  const summary = summarizeOperational(items, COMPLETE);
  assert.ok(summary.denominators.population.includes('non-retired'));
});

test('operations: CPU stays a cumulative counter and is never a percentage', () => {
  const { items } = buildOperationalResources([resource('aaaaaaaa-0015-4a15-8c15-000000000015')], [
    target('aaaaaaaa-0015-4a15-8c15-000000000015'),
  ]);
  const cpu = cpuView(items[0].monitoring);
  assert.ok(cpu);
  assert.equal(cpu?.cumulative, true);
  assert.equal(cpu?.unit, 'seconds');
  // No percentage field exists on the view model at all.
  assert.equal(Object.prototype.hasOwnProperty.call(cpu, 'percent'), false);
});

test('operations: memory is bytes and stale values are marked historical', () => {
  const freshResources = [resource('aaaaaaaa-0016-4a16-8c16-000000000016')];
  const freshTargets = [target('aaaaaaaa-0016-4a16-8c16-000000000016')];
  const fresh = buildOperationalResources(freshResources, freshTargets).items[0];
  assert.equal(memoryView(fresh.monitoring)?.fresh, true);

  const stale = buildOperationalResources(freshResources, [
    target('aaaaaaaa-0016-4a16-8c16-000000000016', { freshness: { state: 'stale', ageSeconds: 900, policySeconds: 180 } }),
  ]).items[0];
  assert.equal(memoryView(stale.monitoring)?.fresh, false, 'a stale metric is historical evidence');
  assert.equal(formatBytes(1048576), '1.0 MiB');
  assert.equal(formatBytes(0), '0 B');
});

test('operations: a missing metric is unavailable, never zero', () => {
  const { items } = buildOperationalResources([resource('aaaaaaaa-0017-4a17-8c17-000000000017')], []);
  assert.equal(cpuView(items[0].monitoring), null);
  assert.equal(memoryView(items[0].monitoring), null);
});

test('operations: NF type comes from the server-derived target, never a process name', () => {
  const resources = [resource('aaaaaaaa-0018-4a18-8c18-000000000018', { role: 'pcscf' })];
  const targets = [target('aaaaaaaa-0018-4a18-8c18-000000000018', { nfType: 'P-CSCF' })];
  const joined = buildOperationalResources(resources, targets).items;
  assert.equal(joined[0].typeLabel, 'pcscf', 'without a target the explicit role is shown');
  const enriched = applyResolvedNFTypes(joined, targets);
  assert.equal(enriched[0].nfType, 'P-CSCF');
  assert.equal(enriched[0].typeLabel, 'P-CSCF');
});

test('operations: hierarchy uses declared contains edges only', () => {
  const resources = [
    resource('host-0001', { kind: 'host', name: 'host-1' }),
    resource('nfi-0001', { kind: 'network_function_instance', name: 'amf-1' }),
    resource('nfi-0002', { kind: 'network_function_instance', name: 'amf-2' }),
  ];
  const edges = [
    { relationshipType: 'contains', fromResourceId: 'host-0001', toResourceId: 'nfi-0001', lifecycleState: 'active' },
    // depends_on must never define containment.
    { relationshipType: 'depends_on', fromResourceId: 'host-0001', toResourceId: 'nfi-0002', lifecycleState: 'active' },
  ];
  const tree = buildResourceTree(operationalItems(resources), edges);
  assert.equal(tree.mode, 'declared');
  assert.equal(tree.nodes.length, 2, 'the host and the non-contained instance stay roots');
  const host = tree.nodes.find((node) => node.id === 'host-0001');
  assert.ok(host);
  assert.deepEqual(host?.children.map((child) => child.id), ['nfi-0001']);
  assert.deepEqual(treeResourceIds(host!).sort(), ['host-0001', 'nfi-0001']);
});

test('operations: cycles are broken and orphans stay visible', () => {
  const resources = [
    resource('a-0001', { kind: 'site', name: 'site-a' }),
    resource('b-0001', { kind: 'site', name: 'site-b' }),
    resource('c-0001', { kind: 'network_function', name: 'nf-c' }),
  ];
  const edges = [
    { relationshipType: 'contains', fromResourceId: 'a-0001', toResourceId: 'b-0001', lifecycleState: 'active' },
    { relationshipType: 'contains', fromResourceId: 'b-0001', toResourceId: 'a-0001', lifecycleState: 'active' },
    { relationshipType: 'contains', fromResourceId: 'missing-parent', toResourceId: 'c-0001', lifecycleState: 'active' },
  ];
  const tree = buildResourceTree(operationalItems(resources), edges);
  const ids = tree.nodes.map((node) => node.id);
  assert.ok(ids.includes('a-0001'), 'the cycle root stays present');
  assert.ok(ids.includes('c-0001'), 'an orphan whose parent is unknown stays visible');
  const total = tree.nodes.reduce((sum, node) => sum + treeResourceIds(node).length, 0);
  assert.equal(total, 3, 'every resource appears exactly once');
});

test('operations: no containment falls back to a labelled virtual domain grouping', () => {
  const resources = [
    resource('aaaaaaaa-0019-4a19-8c19-000000000019'),
    resource('aaaaaaaa-001a-4a1a-8c1a-00000000001a', { domain: 'ims', role: 'pcscf' }),
  ];
  const tree = buildResourceTree(operationalItems(resources), [], 'complete');
  assert.equal(tree.mode, 'virtual_no_containment');
  assert.ok(tree.nodes.every((node) => node.virtual));
  assert.deepEqual(tree.nodes.map((node) => node.id).sort(), ['virtual:5gc', 'virtual:ims']);
});

test('operations: retired edges and retired resources are ignored for containment', () => {
  const resources = [
    resource('host-0002', { kind: 'host', name: 'host-2' }),
    resource('nfi-0003', { kind: 'network_function_instance', name: 'amf-3' }),
  ];
  const tree = buildResourceTree(operationalItems(resources), [
    { relationshipType: 'contains', fromResourceId: 'host-0002', toResourceId: 'nfi-0003', lifecycleState: 'retired' },
  ], 'complete');
  assert.equal(tree.mode, 'virtual_no_containment', 'a retired edge must not establish containment');
});

// ---------------------------------------------------------------------------
// Correction A/C — authoritative association and NF population.
// ---------------------------------------------------------------------------

test('operations: unresolved associations are never reported as unmonitored', () => {
  const resources = [
    resource('aaaaaaaa-0100-4a00-8c00-000000000100'),
    resource('aaaaaaaa-0101-4a01-8c01-000000000101'),
  ];
  // The authoritative lookup failed: absence is not established for either.
  const unresolved = buildOperationalResources(resources, [], false);
  const unresolvedSummary = summarizeOperational(unresolved.items, completeness('complete', 'unavailable'));
  assert.equal(unresolvedSummary.unresolved, 2);
  assert.equal(unresolvedSummary.unmonitored, 0, 'unresolved must never become unmonitored');
  assert.equal(unresolvedSummary.monitored, 0);
  assert.equal(unresolved.items[0].association, 'unresolved');

  // The authoritative lookup succeeded and returned nothing: absence is proven.
  const absent = buildOperationalResources(resources, [], true);
  const absentSummary = summarizeOperational(absent.items, COMPLETE);
  assert.equal(absentSummary.unmonitored, 2);
  assert.equal(absentSummary.unresolved, 0);
  assert.equal(absent.items[0].association, 'absent');
});

test('operations: a target on another page is not needed to prove association', () => {
  // The batch lookup returns exactly the associations for the requested ids.
  const resources = [
    resource('aaaaaaaa-0102-4a02-8c02-000000000102'),
    resource('aaaaaaaa-0103-4a03-8c03-000000000103'),
  ];
  const targets = [target('aaaaaaaa-0102-4a02-8c02-000000000102')];
  const { items } = buildOperationalResources(resources, targets, true);
  const summary = summarizeOperational(items, COMPLETE);
  assert.equal(summary.monitored, 1);
  assert.equal(summary.unmonitored, 1, 'the resource without a returned target is a confirmed absence');
  assert.equal(summary.unresolved, 0);
});

test('operations: only network-function kinds enter the NF population', () => {
  const resources = [
    resource('aaaaaaaa-0104-4a04-8c04-000000000104', { kind: 'region', role: '' }),
    resource('aaaaaaaa-0105-4a05-8c05-000000000105', { kind: 'site', role: '' }),
    resource('aaaaaaaa-0106-4a06-8c06-000000000106', { kind: 'host', role: '' }),
    resource('aaaaaaaa-0107-4a07-8c07-000000000107', { kind: 'interface', role: '' }),
    resource('aaaaaaaa-0108-4a08-8c08-000000000108', { kind: 'network_function', role: 'amf' }),
    resource('aaaaaaaa-0109-4a09-8c09-000000000109', { kind: 'network_function_instance', role: 'amf' }),
    resource('aaaaaaaa-010a-4a0a-8c0a-00000000010a', { kind: 'network_function_instance', role: 'amf' }),
  ];
  const { items } = buildOperationalResources(resources, [], true);
  const summary = summarizeOperational(items, COMPLETE);
  assert.equal(summary.registered, 3, 'only network_function and network_function_instance are NFs');
  assert.equal(summary.logicalFunctions, 1);
  assert.equal(summary.instances, 2);
  assert.equal(summary.nonNfResources, 4, 'region, site, host and interface are reported separately');
  assert.deepEqual([...NETWORK_FUNCTION_KINDS], ['network_function', 'network_function_instance']);
});

// ---------------------------------------------------------------------------
// Correction B — per-source completeness.
// ---------------------------------------------------------------------------

test('operations: completeness is tracked per source and never collapsed', () => {
  const combined = completeness('partial', 'complete', 'complete', 'partial');
  assert.equal(combined.overall, 'partial');
  const unavailable = completeness('complete', 'unavailable', 'complete', 'complete');
  assert.equal(unavailable.overall, 'unavailable', 'an unavailable source dominates');
  const all = COMPLETE;
  assert.equal(all.overall, 'complete');
  // Each dimension stays independently readable.
  assert.equal(combined.inventory, 'partial');
  assert.equal(combined.topology, 'partial');
  assert.equal(combined.monitoring, 'complete');
});

test('operations: a failed telemetry projection is reported, not hidden', () => {
  const resources = [resource('aaaaaaaa-010b-4a0b-8c0b-00000000010b')];
  const targets = [target('aaaaaaaa-010b-4a0b-8c0b-00000000010b', { statusComplete: false })];
  const { items } = buildOperationalResources(resources, targets, true);
  const summary = summarizeOperational(items, completeness('complete', 'complete', 'partial'));
  assert.equal(summary.telemetryUnavailable, 1);
  assert.equal(summary.monitored, 1, 'the association itself is confirmed');
  assert.equal(summary.completeness.overall, 'partial');
});

// ---------------------------------------------------------------------------
// Correction D — topology completeness drives the hierarchy mode.
// ---------------------------------------------------------------------------

test('operations: topology coverage selects the correct hierarchy mode', () => {
  const resources = [resource('aaaaaaaa-010c-4a0c-8c0c-00000000010c')];
  const items = operationalItems(resources);
  const cases: Array<{ coverage: TopologyCoverage; mode: string }> = [
    { coverage: 'complete', mode: 'virtual_no_containment' },
    { coverage: 'partial', mode: 'virtual_partial' },
    { coverage: 'unavailable', mode: 'virtual_unavailable' },
  ];
  for (const entry of cases) {
    const tree = buildResourceTree(items, [], entry.coverage);
    assert.equal(tree.mode, entry.mode, `coverage ${entry.coverage} must map to ${entry.mode}`);
    assert.ok(tree.nodes.every((node) => node.virtual), 'virtual nodes never claim containment');
  }
  // A declared edge always wins over the virtual modes.
  const declared = buildResourceTree(
    operationalItems([
      resource('parent-0001', { kind: 'host' }),
      resource('child-0001', { kind: 'network_function_instance' }),
    ]),
    [{ relationshipType: 'contains', fromResourceId: 'parent-0001', toResourceId: 'child-0001', lifecycleState: 'active' }],
    'partial',
  );
  assert.equal(declared.mode, 'declared');
});
