import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SUBSCRIBER_LIST_QUERY,
  applySubscriberListPatch,
  buildSubscriberListApiUrl,
  isSubscriberListQueryEqual,
  parseSubscriberListQuery,
  serializeSubscriberListQuery,
  subscriberSelectionScopeKey,
  type SubscriberListQuery,
} from '../src/features/subscribers/subscriber-list-query';

const query = (overrides: Partial<SubscriberListQuery> = {}): SubscriberListQuery => ({
  ...DEFAULT_SUBSCRIBER_LIST_QUERY,
  ...overrides,
  filters: {
    ...DEFAULT_SUBSCRIBER_LIST_QUERY.filters,
    ...(overrides.filters ?? {}),
  },
});

test('subscriber list query: default state is canonical and stable', () => {
  assert.deepEqual(parseSubscriberListQuery(''), query());
  assert.equal(serializeSubscriberListQuery(query()), '');
  assert.deepEqual(parseSubscriberListQuery('?page=1&size=10&sort=imsi&order=asc'), query());
  assert.equal(serializeSubscriberListQuery(parseSubscriberListQuery('?page=1&size=10')), '');
});

test('subscriber list query: valid deep link parses every list control', () => {
  const parsed = parseSubscriberListQuery(
    '?page=3&size=20&sort=usage&order=desc&access=active&contract=suspended'
      + '&provisioning=missing_balance&plan=plan_42&balance=low&profile=tpl-a',
  );
  assert.equal(parsed.page, 3);
  assert.equal(parsed.size, 20);
  assert.equal(parsed.sort, 'usage');
  assert.equal(parsed.order, 'desc');
  assert.deepEqual(parsed.filters, {
    access: 'active',
    contract: 'suspended',
    provisioning: 'missing_balance',
    planId: 'plan_42',
    balance: 'low',
  });
  assert.equal(parsed.profile, 'tpl-a');
});

test('subscriber list query: invalid values degrade to the documented defaults', () => {
  const parsed = parseSubscriberListQuery(
    '?page=-4&size=999&sort=secret&order=sideways&access=root&contract=expired'
      + '&provisioning=almost&plan=%00evil&balance=platinum&profile=%00bad',
  );
  assert.equal(parsed.page, 1);
  assert.equal(parsed.size, 10);
  assert.equal(parsed.sort, 'imsi');
  assert.equal(parsed.order, 'asc');
  assert.deepEqual(parsed.filters, {
    access: 'all',
    contract: 'all',
    provisioning: 'all',
    planId: '',
    balance: 'all',
  });
  assert.equal(parsed.profile, '');
});

test('subscriber list query: zero, negative, fractional and oversized pages are rejected', () => {
  for (const page of ['0', '-1', '1.5', 'abc', '1000001', '%20']) {
    assert.equal(parseSubscriberListQuery(`?page=${page}`).page, 1, `page ${page}`);
  }
  assert.equal(parseSubscriberListQuery('?page=1000000').page, 1000000);
});

test('subscriber list query: oversized and control-bearing text is dropped', () => {
  assert.equal(parseSubscriberListQuery(`?profile=${'a'.repeat(201)}`).profile, '');
  assert.equal(parseSubscriberListQuery('?profile=has%00nul').profile, '');
  assert.equal(parseSubscriberListQuery(`?plan=${'p'.repeat(129)}`).filters.planId, '');
  assert.equal(parseSubscriberListQuery('?plan=has%20space').filters.planId, '');
});

test('subscriber list query: serialization is canonical and round-trips', () => {
  const state = query({
    page: 4,
    size: 50,
    sort: 'lastActive',
    order: 'desc',
    profile: 'tpl a',
    filters: { access: 'restricted', balance: 'available', planId: 'plan-1' },
  });
  const search = serializeSubscriberListQuery(state);
  assert.equal(
    search,
    '?page=4&size=50&sort=lastActive&order=desc&access=restricted&plan=plan-1&balance=available&profile=tpl+a',
  );
  assert.deepEqual(parseSubscriberListQuery(search), state);
  assert.equal(serializeSubscriberListQuery(parseSubscriberListQuery(search)), search);
  assert.equal(isSubscriberListQueryEqual(parseSubscriberListQuery(search), state), true);
});

test('subscriber list query: filter change resets pagination in one transition', () => {
  const current = query({ page: 6 });
  const next = applySubscriberListPatch(current, { filters: { access: 'active' } });
  assert.equal(next.page, 1);
  assert.equal(next.filters.access, 'active');
  assert.equal(serializeSubscriberListQuery(next), '?access=active');
});

test('subscriber list query: sort and page-size changes reset pagination', () => {
  const sortNext = applySubscriberListPatch(query({ page: 5 }), { sort: 'usage', order: 'desc' });
  assert.equal(sortNext.page, 1);
  assert.equal(sortNext.sort, 'usage');
  assert.equal(sortNext.order, 'desc');

  const sizeNext = applySubscriberListPatch(query({ page: 5, size: 10 }), { size: 50 });
  assert.equal(sizeNext.page, 1);
  assert.equal(sizeNext.size, 50);
});

test('subscriber list query: page change preserves filters, sort and size', () => {
  const current = query({
    page: 1,
    size: 20,
    sort: 'usage',
    order: 'desc',
    filters: { access: 'active', balance: 'low' },
    profile: 'tpl-a',
  });
  const next = applySubscriberListPatch(current, { page: 3 });
  assert.equal(next.page, 3);
  assert.equal(next.size, 20);
  assert.equal(next.sort, 'usage');
  assert.equal(next.order, 'desc');
  assert.equal(next.filters.access, 'active');
  assert.equal(next.filters.balance, 'low');
  assert.equal(next.profile, 'tpl-a');
});

test('subscriber list query: profile drill-down is preserved and can be cleared', () => {
  const withProfile = applySubscriberListPatch(query({ page: 2 }), { profile: 'tpl-a' });
  assert.equal(withProfile.profile, 'tpl-a');
  assert.equal(withProfile.page, 1);
  const cleared = applySubscriberListPatch(withProfile, { profile: null });
  assert.equal(cleared.profile, '');
  assert.equal(serializeSubscriberListQuery(cleared), '');
});

test('subscriber list query: repeated equivalent updates are no-ops', () => {
  const state = query({ filters: { access: 'active' }, size: 20 });
  const again = applySubscriberListPatch(state, {
    size: 20,
    filters: { access: 'active' },
    sort: 'imsi',
    order: 'asc',
  });
  assert.equal(isSubscriberListQueryEqual(state, again), true);
});

test('subscriber list API: only canonical values reach the request', () => {
  const parsed = parseSubscriberListQuery(
    '?page=2&size=20&sort=usage&order=desc&access=active&contract=active'
      + '&provisioning=complete&plan=plan-1&balance=normal&profile=tpl-a&q=460020000000001',
  );
  const url = buildSubscriberListApiUrl(parsed);
  const request = new URL(url, 'http://127.0.0.1');
  assert.equal(request.pathname, '/api/subscribers');
  assert.equal(request.searchParams.get('detail'), 'true');
  assert.equal(request.searchParams.get('page'), '2');
  assert.equal(request.searchParams.get('limit'), '20');
  assert.equal(request.searchParams.get('sortField'), 'usage');
  assert.equal(request.searchParams.get('sortDirection'), 'desc');
  assert.equal(request.searchParams.get('status'), 'active');
  assert.equal(request.searchParams.get('contractStatus'), 'active');
  assert.equal(request.searchParams.get('provisioning'), 'complete');
  assert.equal(request.searchParams.get('planId'), 'plan-1');
  assert.equal(request.searchParams.get('balanceStatus'), 'normal');
  assert.equal(request.searchParams.get('profile'), 'tpl-a');
  assert.equal(request.searchParams.get('q'), null, 'URL search terms never enter the API query');
});

test('subscriber list API: invalid search drafts are never sent', () => {
  for (const draft of ['abc', '4600-2', 'x'.repeat(16)]) {
    const request = new URL(buildSubscriberListApiUrl(query(), draft), 'http://127.0.0.1');
    assert.equal(request.searchParams.get('q'), null, `draft ${draft}`);
  }
  const valid = new URL(buildSubscriberListApiUrl(query(), '460020000000001'), 'http://127.0.0.1');
  assert.equal(valid.searchParams.get('q'), '460020000000001');
});

test('subscriber selection: scope tracks filter, sort, size, profile and search drafts', () => {
  const base = query({ page: 2 });
  const sameQueryOtherPage = query({ page: 7 });
  assert.equal(
    subscriberSelectionScopeKey(base, ''),
    subscriberSelectionScopeKey(sameQueryOtherPage, ''),
    'pagination preserves selection',
  );
  assert.notEqual(
    subscriberSelectionScopeKey(base, ''),
    subscriberSelectionScopeKey(applySubscriberListPatch(base, { filters: { contract: 'active' } }), ''),
  );
  assert.notEqual(
    subscriberSelectionScopeKey(base, ''),
    subscriberSelectionScopeKey(applySubscriberListPatch(base, { sort: 'usage', order: 'desc' }), ''),
  );
  assert.notEqual(
    subscriberSelectionScopeKey(base, ''),
    subscriberSelectionScopeKey(applySubscriberListPatch(base, { size: 50 }), ''),
  );
  assert.notEqual(
    subscriberSelectionScopeKey(base, ''),
    subscriberSelectionScopeKey(applySubscriberListPatch(base, { profile: 'tpl-a' }), ''),
  );
  assert.notEqual(
    subscriberSelectionScopeKey(base, ''),
    subscriberSelectionScopeKey(base, '4600'),
    'typing invalidates selection immediately',
  );
});