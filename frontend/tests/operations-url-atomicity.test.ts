/*
 * Same-turn URL patch coordination - pure contract.
 *
 * The browser acceptance proves the behaviour end to end. These tests pin the two
 * pieces that make it work, without a router: the pending-search store's scoping
 * rules, and the composition of a second patch on top of the first one's result.
 *
 * The composition test mirrors exactly what the hooks do: read the pending search
 * (falling back to the committed one), apply the patch, record the result. If that
 * chain were wrong, no amount of router behaviour could save it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPendingSearch,
  readPendingSearch,
  writePendingSearch,
} from '../src/features/operations/url-patch-coordinator';
import {
  applyOperationsPatch,
  operationsSearchToParams,
  sanitizeOperationsValue,
} from '../src/features/operations/operations-url-state';

const KEYS = ['view', 'cursor', 'state', 'relationship', 'from', 'to'] as const;

/* What a writer does: compose against the newest logical search. */
function compose(committedSearch: string, locationKey: string, pathname: string, patch: Record<string, string | null>) {
  const base = readPendingSearch(locationKey, pathname) ?? committedSearch;
  const result = applyOperationsPatch(operationsSearchToParams(base), patch, KEYS);
  if (result.changed) writePendingSearch(locationKey, pathname, result.search);
  return result;
}

test('a pending search is scoped to the location that produced it', () => {
  clearPendingSearch();
  writePendingSearch('key-1', '/topology', 'view=ledger&relationship=depends_on');

  assert.equal(
    readPendingSearch('key-1', '/topology'),
    'view=ledger&relationship=depends_on',
    'the same location reads the pending search',
  );
  assert.equal(readPendingSearch('key-2', '/topology'), null, 'a new navigation ignores it');
  assert.equal(readPendingSearch('key-1', '/inventory'), null, 'a different route ignores it');

  clearPendingSearch();
  assert.equal(readPendingSearch('key-1', '/topology'), null, 'clearing drops it');
});

test('the newest write replaces the pending search', () => {
  clearPendingSearch();
  writePendingSearch('key-1', '/topology', 'view=ledger&relationship=depends_on');
  writePendingSearch('key-1', '/topology', 'view=ledger&state=retired');
  assert.equal(
    readPendingSearch('key-1', '/topology'),
    'view=ledger&state=retired',
    'the store holds one pending value, not a history',
  );
  clearPendingSearch();
});

test('two patches in one turn compose instead of overwriting', () => {
  clearPendingSearch();
  const committed = '?view=ledger';

  const first = compose(committed, 'key-1', '/topology', { relationship: 'connects_to' });
  const second = compose(committed, 'key-1', '/topology', { state: 'retired' });

  assert.equal(first.changed, true);
  assert.equal(second.changed, true);

  const final = operationsSearchToParams(readPendingSearch('key-1', '/topology') ?? '');
  assert.equal(final.get('relationship'), 'connects_to', 'the first patch survived');
  assert.equal(final.get('state'), 'retired', 'the second patch applied');
  assert.equal(final.get('view'), 'ledger', 'the untouched key is preserved');
  clearPendingSearch();
});

test('a removal in one turn is not restored by the next patch', () => {
  clearPendingSearch();
  const committed = '?view=ledger&relationship=depends_on&state=retired';

  /* The reported defect: remove the relationship, then select the active
   * lifecycle. The second patch must not read the pre-removal snapshot.
   *
   * The toolbar maps the default lifecycle to an empty value before it reaches
   * the contract, so the intent is expressed as a removal here too. */
  compose(committed, 'key-1', '/topology', { relationship: null });
  compose(committed, 'key-1', '/topology', { state: null });

  const final = operationsSearchToParams(readPendingSearch('key-1', '/topology') ?? '');
  assert.equal(final.get('relationship'), null, 'the removed key stays removed');
  assert.equal(final.get('state'), null, 'the active lifecycle occupies no key');
  assert.equal(final.get('view'), 'ledger', 'the view survives');
  clearPendingSearch();
});

test('a composed non-cursor patch invalidates the cursor exactly once', () => {
  clearPendingSearch();
  const committed = '?view=ledger&cursor=page-2';

  const first = compose(committed, 'key-1', '/topology', { relationship: 'uses' });
  assert.equal(first.cursorReset, true, 'the first patch resets the cursor');
  const second = compose(committed, 'key-1', '/topology', { state: 'retired' });
  assert.equal(second.cursorReset, true);

  const final = operationsSearchToParams(readPendingSearch('key-1', '/topology') ?? '');
  assert.equal(final.get('cursor'), null, 'no cursor survives the transaction');
  clearPendingSearch();
});

test('an equivalent patch reports no change so no history entry is added', () => {
  clearPendingSearch();
  const committed = '?view=ledger&relationship=uses';

  const result = compose(committed, 'key-1', '/topology', { relationship: 'uses' });
  assert.equal(result.changed, false, 'a no-op patch is not a navigation');
  assert.equal(readPendingSearch('key-1', '/topology'), null, 'and it records nothing');
  clearPendingSearch();
});

test('a second patch composes on a pending patch even when it is a no-op alone', () => {
  clearPendingSearch();
  const committed = '?view=ledger';

  compose(committed, 'key-1', '/topology', { relationship: 'uses' });
  const second = compose(committed, 'key-1', '/topology', { state: 'retired' });
  assert.equal(second.changed, true, 'the second patch changes the composed search');

  const final = operationsSearchToParams(readPendingSearch('key-1', '/topology') ?? '');
  assert.equal(final.get('relationship'), 'uses');
  assert.equal(final.get('state'), 'retired');
  clearPendingSearch();
});

test('sanitization still governs what a composed patch can write', () => {
  assert.equal(sanitizeOperationsValue('   '), '', 'whitespace is not a value');
  assert.equal(sanitizeOperationsValue('a\u0000b'), '', 'control characters are rejected');
  assert.equal(sanitizeOperationsValue('x'.repeat(257)), '', 'an over-long value is rejected');
  assert.equal(sanitizeOperationsValue(' uses '), 'uses', 'a trimmed value is kept');

  clearPendingSearch();
  const result = compose('?view=ledger', 'key-1', '/topology', { relationship: '   ' });
  assert.equal(result.changed, false, 'a whitespace-only patch is a no-op');
  clearPendingSearch();
});
