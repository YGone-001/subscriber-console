/*
 * Response-to-view-model adapter contract.
 *
 * Fixtures are the payloads captured from the live Go service, so a change to
 * the contract surfaces here rather than as an empty cell in production. The
 * cases that matter are the ones that previously rendered wrong: an envelope
 * that was never unwrapped, a field that exists as zero, a field that is
 * missing entirely, and a field that is present but unusable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asIdString,
  displayText,
  isFailureEnvelope,
  percentOf,
  pick,
  unwrapList,
  unwrapRecord,
} from '../src/lib/api/envelope';
import {
  bucketUsagePercent,
  toBalanceListViewModel,
  toBalanceViewModel,
  toContractListViewModel,
  toTariffDetailViewModel,
  toTariffListViewModel,
} from '../src/features/ocs/ocs-view-models';
import {
  toUserDetailViewModel,
  toUserListViewModel,
  toUserRoleViewModel,
} from '../src/features/users/user-view-models';
import {
  toProfileDetailViewModel,
  toProfileListViewModel,
  toProfileStatsViewModel,
  toProfileVersionsViewModel,
} from '../src/features/profiles/profile-view-models';
import {
  toSubscriberDetailViewModel,
  toSubscriberListViewModel,
} from '../src/features/subscribers/subscriber-view-models';

/* ------------------------------------------------------------ envelopes -- */

test('unwrapRecord reads a named envelope, a bare record and a failure envelope', () => {
  assert.deepEqual(unwrapRecord({ plan: { plan_id: 'p1' } }, 'plan'), { plan_id: 'p1' });
  assert.deepEqual(unwrapRecord({ plan_id: 'p1' }, 'plan'), { plan_id: 'p1' });
  assert.equal(unwrapRecord({ ok: false, error: 'Not found' }, 'plan'), null);
  assert.equal(unwrapRecord({ plan: null }, 'plan'), null, 'a present but null envelope key is not data');
  assert.equal(unwrapRecord('not an object', 'plan'), null);
});

test('unwrapList keeps an empty array distinct from an unreadable payload', () => {
  assert.deepEqual(unwrapList({ records: [] }, 'records'), []);
  assert.deepEqual(unwrapList({ subscribers: ['a'] }, 'subscribers'), ['a']);
  assert.equal(unwrapList({ ok: false }, 'records'), null);
  assert.equal(unwrapList({ nothing: 1 }, 'records'), null);
});

test('pick separates absent, null and real zero', () => {
  const record = { zero: 0, empty: '', nil: null, bad: 'abc' };
  assert.equal(pick(record, 'absent', (v) => v), undefined, 'absent key must stay undefined');
  assert.equal(pick(record, 'zero', (v) => v), 0, 'zero must survive');
  assert.equal(pick(record, 'empty', (v) => v), '', 'empty string must survive');
  assert.equal(pick(record, 'nil', (v) => v), null, 'explicit null must stay null');
  assert.equal(pick(record, 'bad', () => null), null);
});

test('asIdString never leaks an object identifier form', () => {
  assert.equal(asIdString('6aacfca52bb6e37e6b08346a'), '6aacfca52bb6e37e6b08346a');
  assert.equal(asIdString({ $oid: '6aacfca52bb6e37e6b08346a' }), '6aacfca52bb6e37e6b08346a');
  assert.equal(asIdString({}), null);
  assert.equal(asIdString(''), null);
  assert.equal(asIdString(12345), null, 'a numeric identifier must not be coerced');
});

test('displayText and percentOf preserve zero and reject unusable input', () => {
  assert.equal(displayText(0), '0');
  assert.equal(displayText(''), '-');
  assert.equal(displayText(null), '-');
  assert.equal(displayText({}), '-');
  assert.equal(percentOf(0, 100), 0);
  assert.equal(percentOf(150, 100), 100);
  assert.equal(percentOf(1, 0), null);
  assert.equal(percentOf(null, 100), null);
});

test('isFailureEnvelope only matches an explicit ok:false', () => {
  assert.equal(isFailureEnvelope({ ok: false }), true);
  assert.equal(isFailureEnvelope({ ok: true }), false);
  assert.equal(isFailureEnvelope({}), false);
  assert.equal(isFailureEnvelope(null), false);
});

/* ------------------------------------------------------------------ OCS -- */

const BALANCE_DETAIL = { ok: true, balance: {
  id: '6aacfca52bb6e37e6b08346a', imsi: '417010000000001', plan_id: 'default_plan', status: 'active',
  data_total: 11576329040, data_used: 0, data_reserved: 0, data_available: 11576329040,
  voice_total: 3600, voice_used: 0, voice_reserved: 0, voice_available: 3600,
  sms_total: 100, sms_used: 0, sms_available: 100, money_balance: 0, version: 10,
  data_invariant_ok: true, voice_invariant_ok: true, sms_invariant_ok: true, invariant_ok: true,
  created_at: '2026-09-18T08:56:05Z', updated_at: '2026-09-20T15:28:17.120Z',
} };

test('the balance detail envelope is unwrapped rather than rendered as a raw record', () => {
  const view = toBalanceViewModel(BALANCE_DETAIL);
  assert.ok(view, '{ok, balance} must unwrap');
  assert.equal(view.imsi, '417010000000001');
  assert.equal(view.planId, 'default_plan');
  assert.equal(view.data.total, 11576329040);
  assert.equal(view.data.used, 0, 'a zero usage value must not become null');
  assert.equal(view.data.available, 11576329040);
  assert.equal(view.moneyBalance, 0);
  assert.equal(view.version, 10);
  assert.equal(view.invariants.all, true);
  assert.equal(view.createdAt, '2026-09-18T08:56:05Z');
  assert.equal(bucketUsagePercent(view.data), 0, 'zero used of a real total is 0%, not null');
  assert.equal(bucketUsagePercent(view.voice), 0);
});

test('a balance with no bucket fields reports null buckets instead of zeros', () => {
  const view = toBalanceViewModel({ ok: true, balance: { imsi: '417010000000002' } });
  assert.ok(view);
  assert.equal(view.data.total, null);
  assert.equal(view.data.used, null);
  assert.equal(bucketUsagePercent(view.data), null);
  assert.equal(view.imsi, '417010000000002');
});

test('a balance payload with an unusable field yields null for that field only', () => {
  const view = toBalanceViewModel({ ok: true, balance: { imsi: '417010000000003', version: 'not-a-number', status: 'active' } });
  assert.ok(view);
  assert.equal(view.version, null);
  assert.equal(view.status, 'active');
});

test('the balance list envelope is unwrapped and skips unusable rows', () => {
  const result = toBalanceListViewModel({ ok: true, records: [
    { imsi: '417010000000001', data_total: 100, data_used: 25 },
    null,
    { imsi: '417010000000002', data_total: 0, data_used: 0 },
  ] });
  assert.equal(result.readable, true);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].data.used, 25);
  assert.equal(result.records[1].data.total, 0);
});

test('an empty balance list is readable and empty, an unreadable one is not', () => {
  assert.deepEqual(toBalanceListViewModel({ ok: true, records: [] }), { records: [], readable: true });
  assert.deepEqual(toBalanceListViewModel({ ok: false, error: 'nope' }), { records: [], readable: false });
});

test('the contract list envelope is unwrapped', () => {
  const result = toContractListViewModel({ ok: true, records: [
    { id: '6aacfca52bb6e37e6b08347b', imsi: '417010000000010', msisdn: '919000010', status: 'active', plan_id: 'default_plan' },
  ] });
  assert.equal(result.readable, true);
  assert.equal(result.records[0].msisdn, '919000010');
  assert.equal(result.records[0].planId, 'default_plan');
});

test('the tariff list and detail envelopes are unwrapped', () => {
  const list = toTariffListViewModel({ plans: [
    { plan_id: 'default_plan', name: 'Default 4G/5G Tariff Plan', status: 'active', quota_per_grant: 10485760,
      validity_time: 300, volume_threshold: 8388608, rulesCount: 5, subscriberCount: 10, isDefault: false },
  ] });
  assert.equal(list.readable, true);
  assert.equal(list.records[0].planId, 'default_plan');
  assert.equal(list.records[0].subscriberCount, 10);
  assert.equal(list.records[0].isDefault, false, 'a real false must not collapse to null');

  const detail = toTariffDetailViewModel({ plan: { plan_id: 'plan_default_10gb', name: 'Default 10GB Data Plan', isDefault: true } });
  assert.ok(detail, '{plan} must unwrap');
  assert.equal(detail.planId, 'plan_default_10gb');
  assert.equal(detail.isDefault, true);
  assert.equal(detail.subscriberCount, null, 'a missing count stays null rather than becoming 0');
});

/* ---------------------------------------------------------------- users -- */

const USER_LIST = {
  items: [{ username: 'admin', role: 'root', status: 'active', createdAt: '2026-09-18T17:00:19.018Z',
    createdBy: 'system:bootstrap', updatedAt: '2026-10-05T14:05:28.952Z', locked: false,
    security: { sessionVersion: 1, failedLoginAttempts: 0, passwordChangedAt: '2026-09-18T18:01:16.353Z',
      lastLoginAt: '2026-10-06T04:22:16.435Z', lastLoginIp: 'unknown' } }],
  pagination: { page: 1, pageSize: 2, total: 1, totalPages: 1 },
  stats: { total: 1, active: 1, administrators: 1, locked: 0 },
  assignableRoles: ['admin', 'operator', 'viewer'],
};

test('legacy roles are mapped to the canonical three-role model', () => {
  assert.deepEqual(toUserRoleViewModel('root'), { raw: 'root', canonical: 'admin', isLegacy: true });
  assert.deepEqual(toUserRoleViewModel('ops_admin'), { raw: 'ops_admin', canonical: 'operator', isLegacy: true });
  assert.deepEqual(toUserRoleViewModel('auditor'), { raw: 'auditor', canonical: 'viewer', isLegacy: true });
  assert.deepEqual(toUserRoleViewModel('operator'), { raw: 'operator', canonical: 'operator', isLegacy: false });
  assert.deepEqual(toUserRoleViewModel('unknown_role'), { raw: 'unknown_role', canonical: null, isLegacy: false });
  assert.deepEqual(toUserRoleViewModel(null), { raw: null, canonical: null, isLegacy: false });
});

test('the users list envelope exposes items, pagination, stats and assignable roles', () => {
  const view = toUserListViewModel(USER_LIST);
  assert.equal(view.readable, true);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].username, 'admin');
  assert.equal(view.items[0].role.canonical, 'admin', 'the raw root role must present as admin');
  assert.equal(view.items[0].locked, false, 'a real false must survive');
  assert.equal(view.items[0].failedLoginAttempts, 0, 'a real zero must survive');
  assert.equal(view.items[0].lastLoginAt, '2026-10-06T04:22:16.435Z');
  assert.equal(view.pagination?.totalPages, 1);
  assert.equal(view.stats?.locked, 0);
  assert.deepEqual(view.assignableRoles, ['admin', 'operator', 'viewer']);
});

test('a users list without stats or pagination reports null rather than zeros', () => {
  const view = toUserListViewModel({ items: [] });
  assert.equal(view.readable, true);
  assert.deepEqual(view.items, []);
  assert.equal(view.pagination, null);
  assert.equal(view.stats, null);
  assert.deepEqual(view.assignableRoles, []);
});

test('the user detail envelope surfaces normalizedRole, permissions and actions', () => {
  const view = toUserDetailViewModel({
    user: USER_LIST.items[0],
    normalizedRole: 'admin',
    permissions: ['users.read', 'users.create'],
    actions: ['edit', 'disable'],
    assignableRoles: ['admin', 'operator', 'viewer'],
    activity: [{ id: 'a1', action: 'login', at: '2026-10-06T04:22:32.621Z', actor: 'admin', detail: 'signed in' }],
  });
  assert.ok(view);
  assert.equal(view.normalizedRole, 'admin');
  assert.equal(view.user?.role.raw, 'root');
  assert.equal(view.user?.role.canonical, 'admin');
  assert.deepEqual(view.permissions, ['users.read', 'users.create']);
  assert.deepEqual(view.actions, ['edit', 'disable']);
  assert.equal(view.activity.length, 1);
  assert.equal(view.activity[0].action, 'login');
});

test('an empty user detail payload yields null instead of an empty view', () => {
  assert.equal(toUserDetailViewModel({ ok: false, error: 'Not found' }), null);
  assert.equal(toUserDetailViewModel(null), null);
});

/* ------------------------------------------------------------- profiles -- */

test('an empty profile list still exposes the populated summary', () => {
  const view = toProfileListViewModel({ profiles: [], summary: {
    totalProfiles: 0, totalGovernedSubscribers: 0, activeSubscribers: 0,
    suspendedSubscribers: 0, restrictedSubscribers: 0, unassignedProfiles: 0,
  } });
  assert.equal(view.readable, true);
  assert.deepEqual(view.profiles, []);
  assert.equal(view.summary?.totalProfiles, 0, 'a real zero summary must survive');
  assert.equal(view.summary?.unassignedProfiles, 0);
});

test('a profile list without a summary reports null summary, not zeros', () => {
  const view = toProfileListViewModel({ profiles: [{ name: 'p1', title: 'Profile 1' }] });
  assert.equal(view.summary, null);
  assert.equal(view.profiles[0].name, 'p1');
  assert.equal(view.profiles[0].version, null);
});

test('profile detail, stats and versions unwrap their own envelopes', () => {
  const detail = toProfileDetailViewModel({ profile: { name: 'p1', title: 'Profile 1', version: 3 } });
  assert.equal(detail?.version, 3);

  const stats = toProfileStatsViewModel({ stats: { subscriberCount: 4, sliceCount: 2, pccRuleCount: 0 } });
  assert.equal(stats?.subscriberCount, 4);
  assert.equal(stats?.pccRuleCount, 0, 'a real zero rule count must survive');

  const versions = toProfileVersionsViewModel({ versions: [{ versionId: 'v1', version: 1, createdAt: '2026-09-18T08:56:05Z' }] });
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionId, 'v1');
  assert.deepEqual(toProfileVersionsViewModel({ ok: false }), []);
});

/* ---------------------------------------------------------- subscribers -- */

test('the identifier-only subscriber list is adapted without inventing rows', () => {
  const view = toSubscriberListViewModel({ subscribers: ['417010000000001', '417010000000002'], total: 12, page: 1, limit: 50 });
  assert.equal(view.readable, true);
  assert.deepEqual(view.imsis, ['417010000000001', '417010000000002']);
  assert.deepEqual(view.rows, []);
  assert.equal(view.total, 12);
  assert.equal(view.limit, 50);
  assert.equal(view.summary, null);
});

test('the detailed subscriber list adapts the traffic and sms buckets', () => {
  const view = toSubscriberListViewModel({
    subscribers: [{ imsi: '417010000000001', status: 'Active', ard: 32, plmn: '41701', profile: '', policy: 'default_plan',
      policyName: 'Default 4G/5G Tariff Plan', policyStatus: 'active',
      traffic: { total: 11576329040, used: 0, balance: 11576329040 },
      sms: { total: 100, used: 0, balance: 100 },
      lastActive: '2026-09-18T08:56:05.000Z' }],
    total: 12, page: 1, limit: 2,
    summary: { total: 12, active: 12, restricted: 0, lowTraffic: 2 },
  });
  assert.equal(view.rows.length, 1);
  const row = view.rows[0];
  assert.equal(row.imsi, '417010000000001');
  assert.equal(row.traffic.total, 11576329040);
  assert.equal(row.traffic.used, 0);
  assert.equal(row.traffic.percent, 0, 'zero used of a real total is 0%, not null');
  assert.equal(row.sms.balance, 100);
  assert.equal(row.policyName, 'Default 4G/5G Tariff Plan');
  assert.equal(row.profile, '', 'an empty profile string must survive as an empty string');
  assert.equal(view.summary?.lowTraffic, 2);
  assert.equal(view.summary?.restricted, 0);
});

test('a subscriber row without a traffic bucket reports nulls instead of zeros', () => {
  const view = toSubscriberListViewModel({ subscribers: [{ imsi: '417010000000009', status: 'Active' }] });
  assert.equal(view.rows[0].traffic.total, null);
  assert.equal(view.rows[0].traffic.percent, null);
});

test('an unusable subscriber payload is unreadable, not an empty page', () => {
  const view = toSubscriberListViewModel({ ok: false, error: 'Forbidden' });
  assert.equal(view.readable, false);
  assert.deepEqual(view.rows, []);
});

test('the raw subscriber document is adapted into slice, session and rule counts', () => {
  const detail = toSubscriberDetailViewModel({
    sub4G: {
      profile_name: '', allowedVisitedPlmns: 'all', network_access_mode: 0, access_restriction_data: 32,
      msisdnList: [{ msisdn: '919000001' }],
      sliceList: [{ sd: '000001', session_list: [{ name: 'internet', pcc_rule: [] }, { name: 'ims', pcc_rule: [{ _id: 'r1' }] }] }],
    },
  }, '417010000000001');
  assert.ok(detail);
  assert.equal(detail.imsi, '417010000000001');
  assert.deepEqual(detail.msisdns, ['919000001']);
  assert.equal(detail.sliceCount, 1);
  assert.equal(detail.sessionCount, 2);
  assert.equal(detail.pccRuleCount, 1);
  assert.equal(detail.accessRestrictionData, 32);
  assert.equal(detail.networkAccessMode, 0, 'a real zero access mode must survive');
});

test('an empty subscriber document yields null', () => {
  assert.equal(toSubscriberDetailViewModel({}, null), null);
  assert.equal(toSubscriberDetailViewModel(null, null), null);
});
