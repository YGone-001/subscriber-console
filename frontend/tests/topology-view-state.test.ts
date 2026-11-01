/*
 * Topology URL contract.
 *
 * Three modes: `graph` (evidence layer declared|runtime), `ledger` and
 * `architecture`. The static 3GPP skeleton is a mode, not a third evidence
 * source. Legacy links must keep working, and an invalid hand-edited value must
 * degrade to a usable default instead of an empty workspace.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLiveViewState, withLiveViewParam } from '../src/features/topology/live-topology-url';
import test from 'node:test';
import {
  canonicalizeTopologyViewSearch,
  resolveTopologyViewState,
  topologyViewStatePatch,
  type TopologyViewState,
} from '../src/features/topology/topology-view-state';

const state = (
  primary: TopologyViewState['primary'],
  source: TopologyViewState['source'],
  runtimeScope: TopologyViewState['runtimeScope'],
): TopologyViewState => ({ primary, source, runtimeScope });

/* --------------------------------------------------------------- resolve -- */

test('an empty query resolves to the runtime graph, the only populated default', () => {
  assert.deepEqual(resolveTopologyViewState(''), state('graph', 'runtime', 'config'));
});

test('an explicit legacy view keeps its original destination', () => {
  assert.deepEqual(resolveTopologyViewState('?view=actual'), state('graph', 'declared', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=graph'), state('graph', 'runtime', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=architecture'), state('architecture', 'runtime', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=relationships'), state('ledger', 'runtime', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=runtime'), state('graph', 'runtime', 'hierarchy'));
  assert.deepEqual(resolveTopologyViewState('?view=ledger'), state('ledger', 'runtime', 'config'));
});

test('a legacy reference source is an architecture link, not a third evidence layer', () => {
  assert.deepEqual(resolveTopologyViewState('?source=reference'), state('architecture', 'runtime', 'config'));
  assert.deepEqual(
    resolveTopologyViewState('?view=architecture&source=runtime'),
    state('architecture', 'runtime', 'config'),
  );
});

test('an explicit source is more specific than a legacy view alias inside the graph', () => {
  assert.deepEqual(
    resolveTopologyViewState('?view=actual&source=runtime'),
    state('graph', 'runtime', 'config'),
  );
});

test('a runtime scope only applies to the runtime source', () => {
  assert.deepEqual(
    resolveTopologyViewState('?view=graph&source=runtime&scope=hierarchy'),
    state('graph', 'runtime', 'hierarchy'),
  );
  assert.deepEqual(
    resolveTopologyViewState('?view=graph&source=runtime&scope=config'),
    state('graph', 'runtime', 'config'),
  );
  assert.deepEqual(
    resolveTopologyViewState('?view=graph&source=declared&scope=hierarchy'),
    state('graph', 'declared', 'config'),
  );
});

test('unknown values fall back to the populated graph default', () => {
  assert.deepEqual(resolveTopologyViewState('?view=bogus&source=bogus&scope=bogus'), state('graph', 'runtime', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=%00&source=%00'), state('graph', 'runtime', 'config'));
});

/* ------------------------------------------------------------ canonical -- */

test('an untouched page keeps a clean address', () => {
  const result = canonicalizeTopologyViewSearch('');
  assert.equal(result.changed, false);
  assert.equal(result.search, '');
});

test('legacy values are rewritten to the canonical mode', () => {
  assert.equal(
    canonicalizeTopologyViewSearch('?view=architecture').search,
    '?view=architecture',
  );
  assert.equal(
    canonicalizeTopologyViewSearch('?view=actual').search,
    '?view=graph&source=declared',
  );
  assert.equal(
    canonicalizeTopologyViewSearch('?source=reference').search,
    '?view=architecture',
  );
  assert.equal(
    canonicalizeTopologyViewSearch('?view=runtime').search,
    '?view=graph&source=runtime&scope=hierarchy',
  );
  assert.equal(
    canonicalizeTopologyViewSearch('?view=relationships').search,
    '?view=ledger',
  );
});

test('canonicalization preserves ledger filters and the cursor', () => {
  const result = canonicalizeTopologyViewSearch(
    '?view=relationships&state=retired&relationship=depends_on&from=abc&cursor=page-2',
  );
  assert.equal(result.changed, true);
  assert.equal(
    result.search,
    '?view=ledger&state=retired&relationship=depends_on&from=abc&cursor=page-2',
  );
});

test('the ledger and the architecture modes drop graph-only parameters', () => {
  assert.equal(
    canonicalizeTopologyViewSearch('?view=ledger&source=runtime&scope=hierarchy').search,
    '?view=ledger',
  );
  assert.equal(
    canonicalizeTopologyViewSearch('?view=architecture&source=runtime&scope=hierarchy').search,
    '?view=architecture',
  );
});

test('an already canonical URL is not rewritten', () => {
  const result = canonicalizeTopologyViewSearch('?view=graph&source=declared');
  assert.equal(result.changed, false);
  assert.equal(result.search, '?view=graph&source=declared');
});

/* ---------------------------------------------------------------- patch -- */

test('the state patch writes the mode and the evidence layer', () => {
  assert.deepEqual(
    topologyViewStatePatch(state('architecture', 'runtime', 'config')),
    { view: 'architecture', source: null, scope: null },
  );
  assert.deepEqual(
    topologyViewStatePatch(state('graph', 'runtime', 'hierarchy')),
    { view: 'graph', source: 'runtime', scope: 'hierarchy' },
  );
  assert.deepEqual(
    topologyViewStatePatch(state('graph', 'declared', 'config')),
    { view: 'graph', source: 'declared', scope: null },
  );
  assert.deepEqual(
    topologyViewStatePatch(state('ledger', 'runtime', 'config')),
    { view: 'ledger', source: null, scope: null },
  );
});

/* --------------------------------------------------- one-hop URL contract -- */

test('the one-hop view keeps its filters, cursor and selection in the URL', () => {
  const source = readFileSync(new URL('../src/features/topology/ResourceTopologyPage.tsx', import.meta.url), 'utf8');

  assert.ok(
    source.includes("keys: ['direction', 'relationship', 'state', 'domain', 'selected']"),
    'every one-hop filter and the selected relationship must be part of the URL contract',
  );
  assert.ok(source.includes('url.setFilter('), 'filter changes must go through the shared contract');
  assert.ok(source.includes('url.setCursor('), 'paging must go through the URL cursor');
  assert.ok(
    source.includes('void load(cursor)'),
    'the read must be driven by the URL cursor so a shared link restores the same page',
  );
  assert.ok(
    !source.includes('useState<DirectionFilter>'),
    'no duplicate copy of the filter state may remain in component memory',
  );
});
/* ------------------------------------------------- live canvas URL state -- */

test('the live canvas reads its own keys without touching the page filters', () => {
  const params = new URLSearchParams('view=graph&source=runtime&state=retired&q=smf&domain=epc&focus=upf&edge=edge-1');
  assert.deepEqual(readLiveViewState(params), {
    search: 'smf',
    domain: 'epc',
    focus: 'upf',
    edge: 'edge-1',
  });
});

test('an unknown domain degrades to all and a default key leaves the address bar', () => {
  assert.equal(readLiveViewState(new URLSearchParams('domain=cross-domain')).domain, 'cross-domain');
  assert.equal(readLiveViewState(new URLSearchParams('domain=not-a-domain')).domain, 'all');

  const cleared = withLiveViewParam(new URLSearchParams('view=graph&state=retired&domain=epc'), 'domain', 'all');
  assert.equal(cleared.get('domain'), null, 'the default must not occupy the URL');
  assert.equal(cleared.get('view'), 'graph', 'the page contract stays untouched');
  assert.equal(cleared.get('state'), 'retired', 'the page contract stays untouched');

  assert.equal(withLiveViewParam(new URLSearchParams(), 'focus', 'upf').get('focus'), 'upf');
  assert.equal(withLiveViewParam(new URLSearchParams('focus=upf'), 'focus', '').get('focus'), null);
});

test('the live canvas keeps no local copy of its view state', () => {
  const source = readFileSync(new URL('../src/features/topology/LiveTopologyView.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('useLiveTopologyViewState()'), 'the canvas must read its view state from the URL');
  assert.ok(!source.includes("useState('')"), 'the search must not keep a second copy');
  assert.ok(
    !source.includes("useState<TopologyDomainMode>('all')"),
    'the domain must not keep a second copy',
  );
});