/*
 * Topology URL contract.
 *
 * The graph keeps the legacy `actual` view value and adds a `source` dimension;
 * the ledger is the second primary view. Legacy links must keep working, and an
 * invalid hand-edited value must degrade to a usable default instead of an
 * empty workspace.
 */
import assert from 'node:assert/strict';
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
  assert.deepEqual(resolveTopologyViewState(''), state('actual', 'runtime', 'config'));
});

test('an explicit legacy view keeps its original destination', () => {
  assert.deepEqual(resolveTopologyViewState('?view=actual'), state('actual', 'declared', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=architecture'), state('actual', 'reference', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=relationships'), state('ledger', 'declared', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=runtime'), state('actual', 'runtime', 'hierarchy'));
  assert.deepEqual(resolveTopologyViewState('?view=ledger'), state('ledger', 'declared', 'config'));
});

test('an explicit source is more specific than a legacy view alias', () => {
  assert.deepEqual(
    resolveTopologyViewState('?view=architecture&source=runtime'),
    state('actual', 'runtime', 'config'),
  );
  assert.deepEqual(
    resolveTopologyViewState('?source=reference'),
    state('actual', 'reference', 'config'),
  );
});

test('a runtime scope only applies to the runtime source', () => {
  assert.deepEqual(
    resolveTopologyViewState('?view=actual&source=runtime&scope=hierarchy'),
    state('actual', 'runtime', 'hierarchy'),
  );
  assert.deepEqual(
    resolveTopologyViewState('?view=actual&source=runtime&scope=config'),
    state('actual', 'runtime', 'config'),
  );
  assert.deepEqual(
    resolveTopologyViewState('?view=actual&source=declared&scope=hierarchy'),
    state('actual', 'declared', 'config'),
  );
});

test('unknown values fall back without producing an unusable page', () => {
  assert.deepEqual(resolveTopologyViewState('?view=bogus&source=bogus&scope=bogus'), state('actual', 'declared', 'config'));
  assert.deepEqual(resolveTopologyViewState('?view=%00&source=%00'), state('actual', 'declared', 'config'));
});

/* ------------------------------------------------------------ canonical -- */

test('an untouched page keeps a clean address', () => {
  const result = canonicalizeTopologyViewSearch('');
  assert.equal(result.changed, false);
  assert.equal(result.search, '');
});

test('legacy values are rewritten to the canonical source', () => {
  assert.equal(
    canonicalizeTopologyViewSearch('?view=architecture').search,
    '?view=actual&source=reference',
  );
  assert.equal(
    canonicalizeTopologyViewSearch('?view=runtime').search,
    '?view=actual&source=runtime&scope=hierarchy',
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

test('the ledger drops graph-only parameters', () => {
  assert.equal(
    canonicalizeTopologyViewSearch('?view=ledger&source=runtime&scope=hierarchy').search,
    '?view=ledger',
  );
});

test('an already canonical URL is not rewritten', () => {
  const result = canonicalizeTopologyViewSearch('?view=actual&source=declared');
  assert.equal(result.changed, false);
  assert.equal(result.search, '?view=actual&source=declared');
});

/* ---------------------------------------------------------------- patch -- */

test('the state patch writes the primary view and source', () => {
  assert.deepEqual(
    topologyViewStatePatch(state('actual', 'reference', 'config')),
    { view: 'actual', source: 'reference', scope: null },
  );
  assert.deepEqual(
    topologyViewStatePatch(state('actual', 'runtime', 'hierarchy')),
    { view: 'actual', source: 'runtime', scope: 'hierarchy' },
  );
  assert.deepEqual(
    topologyViewStatePatch(state('ledger', 'declared', 'config')),
    { view: 'ledger', source: null, scope: null },
  );
});
