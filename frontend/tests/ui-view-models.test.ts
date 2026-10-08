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
  assert.equal(detail.subscriberCount, null, 'a missing count stays null rather than 0');
});
