/*
 * OCS console presentation contracts.
 *
 * These cover the parts of the rework that are easy to regress and expensive to
 * notice: "missing is not zero", the pager count derived from the total rather
 * than trusted from the payload, the digit-only IMSI field, the tri-state
 * invariant badge, and the detail-page state semantics that replaced
 * "everything is not-found".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import OcsInvariantBadge from '../src/components/ocs/common/OcsInvariantBadge';
import OcsDetailState from '../src/components/ocs/common/OcsDetailState';
import {
  formatOcsBytes,
  formatOcsRuleQuota,
  formatOcsSeconds,
  pageCountFor,
  sanitizeImsiInput,
} from '../src/features/ocs/ocs-format';
import {
  toAdjustmentListViewModel,
  toBalanceListViewModel,
  toBalanceSummaryViewModel,
  toContractOperationsViewModel,
  toContractSummaryViewModel,
} from '../src/features/ocs/ocs-view-models';
import { attachmentFileName } from '../src/lib/api/download';
import { hasActiveOcsFilters } from '../src/features/ocs/use-ocs-query-state';
import { currentListLocation, resolveReturnTo, withReturnTo } from '../src/lib/return-to';

const testsDir = dirname(fileURLToPath(import.meta.url));

function render(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(I18nProvider, null, element));
}

test('a missing byte count renders as an em dash, never as zero', () => {
  assert.equal(formatOcsBytes(null), '\u2014');
  assert.equal(formatOcsBytes(undefined), '\u2014');
  assert.equal(formatOcsBytes(0), '0 B');
  assert.equal(formatOcsBytes(1024 ** 3), '1 GB');
});

test('a missing duration renders as an em dash, and seconds are humanized', () => {
  assert.equal(formatOcsSeconds(null), '\u2014');
  assert.equal(formatOcsSeconds(86400), '1d');
  assert.equal(formatOcsSeconds(3600), '1h');
});

test('the IMSI field keeps digits only, so it cannot reach the query as a pattern', () => {
  assert.equal(sanitizeImsiInput('310150123456789'), '310150123456789');
  assert.equal(sanitizeImsiInput('310-150 123'), '310150123');
  assert.equal(sanitizeImsiInput('.*'), '');
  assert.equal(sanitizeImsiInput('(123'), '123');
  assert.equal(sanitizeImsiInput('1234567890123456789012'), '123456789012345678');
});

test('the pager count is derived from the total, so an exact multiple adds no empty page', () => {
  assert.equal(pageCountFor(40, 20), 2);
  assert.equal(pageCountFor(41, 20), 3);
  assert.equal(pageCountFor(20, 20), 1);
  assert.equal(pageCountFor(0, 20), 1);
  assert.equal(pageCountFor(null, 20), 1);
  assert.equal(pageCountFor(1, 0), 1);
});

test('the balance summary is projected from the envelope and keeps missing fields missing', () => {
  const summary = toBalanceSummaryViewModel({
    ok: true,
    records: [],
    total: 3,
    summary: {
      totalSubscribers: 3,
      totalDataAllocated: 100,
      totalDataUsed: 40,
      totalDataAvailable: 60,
    },
  });
  assert.deepEqual(summary, {
    totalSubscribers: 3,
    totalDataAllocated: 100,
    totalDataUsed: 40,
    totalDataAvailable: 60,
  });

  const absent = toBalanceSummaryViewModel({ ok: true, records: [] });
  assert.deepEqual(absent, {
    totalSubscribers: null,
    totalDataAllocated: null,
    totalDataUsed: null,
    totalDataAvailable: null,
  });
});

test('a balance record without an available figure keeps it null instead of coercing to zero', () => {
  const records = toBalanceListViewModel({
    ok: true,
    records: [{ imsi: '310150123456789', status: 'active', data_total: 100 }],
  }).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].data.available, null);
  assert.equal(records[0].invariants.data, null);
});

test('a rating-rule quota is formatted in the unit the rule declares', () => {
  assert.equal(formatOcsRuleQuota(10485760, 'octets'), '10 MB');
  assert.equal(formatOcsRuleQuota(60, 'seconds'), '60s');
  assert.equal(formatOcsRuleQuota(1, 'events'), '1');
  assert.equal(formatOcsRuleQuota(0, 'octets'), '0 B');
  assert.equal(formatOcsRuleQuota(null, 'octets'), '\u2014');
  assert.equal(formatOcsRuleQuota(5, 'messages'), '5 messages', 'an unknown unit is shown verbatim');
});

test('the adjustment trail projects the operation log without inventing fields', () => {
  const trail = toAdjustmentListViewModel({
    ok: true,
    imsi: '310150123456789',
    total: 1,
    page: 1,
    limit: 20,
    records: [{
      id: 'adj-1',
      createdAt: '2026-10-01T08:00:00.000Z',
      action: 'BALANCE_ADJUST',
      actor: 'op1',
      role: 'operator',
      result: 'success',
      reason: 'goodwill credit',
      bucket: 'data',
      operation: 'credit',
      amount: 1073741824,
      ticketId: 'INC100234',
      beforeVersion: 3,
      afterVersion: 4,
    }],
  });

  assert.equal(trail.readable, true);
  assert.equal(trail.total, 1);
  assert.equal(trail.records.length, 1);
  const record = trail.records[0];
  assert.equal(record.actor, 'op1');
  assert.equal(record.bucket, 'data');
  assert.equal(record.amount, 1073741824);
  assert.equal(record.beforeVersion, 3);
  assert.equal(record.afterVersion, 4);

  const empty = toAdjustmentListViewModel({ ok: true, imsi: '310150123456789', total: 0, records: [] });
  assert.deepEqual(empty.records, []);
  assert.equal(empty.total, 0);

  const absent = toAdjustmentListViewModel({ ok: true, imsi: '310150123456789' });
  assert.equal(absent.records.length, 0);
  assert.equal(absent.total, null, 'an absent total stays null rather than counting zero rows');
});

test('an adjustment without a reported amount keeps it null', () => {
  const trail = toAdjustmentListViewModel({
    ok: true,
    total: 1,
    records: [{ id: 'adj-2', bucket: 'sms', operation: 'debit' }],
  });
  assert.equal(trail.records[0].amount, null);
  assert.equal(trail.records[0].bucket, 'sms');
});

test('the export filename prefers the server header and falls back to the documented pattern', () => {
  assert.equal(
    attachmentFileName('attachment; filename="tariff-plan-plan_1.json"', 'fallback.json'),
    'tariff-plan-plan_1.json',
  );
  assert.equal(attachmentFileName(null, 'fallback.json'), 'fallback.json');
  assert.equal(attachmentFileName('attachment', 'tariff-plan-x.json'), 'tariff-plan-x.json');
});

test('paging is navigation, not filtering, so it never lights up the clear-filter affordance', () => {
  const defaults = { q: '', status: '', page: '1', limit: '20' };
  assert.equal(hasActiveOcsFilters({ ...defaults, page: '4' }, defaults), false);
  assert.equal(hasActiveOcsFilters({ ...defaults, limit: '50' }, defaults), false);
  assert.equal(hasActiveOcsFilters({ ...defaults, q: '310' }, defaults), true);
  assert.equal(hasActiveOcsFilters({ ...defaults, status: 'active' }, defaults), true);
});

test('the invariant badge distinguishes pass, mismatch and unreported', () => {
  assert.match(render(createElement(OcsInvariantBadge, { value: true })), /ocs-invariant-ok/);
  assert.match(render(createElement(OcsInvariantBadge, { value: false })), /ocs-invariant-broken/);
  assert.match(render(createElement(OcsInvariantBadge, { value: null })), /ocs-invariant-unknown/);
});

test('detail states are announced by kind rather than collapsed into one empty panel', () => {
  const notFound = render(createElement(OcsDetailState, { kind: 'notFound' }));
  assert.match(notFound, /data-state="not-found"/);
  assert.match(notFound, /role="status"/);

  const forbidden = render(createElement(OcsDetailState, { kind: 'forbidden' }));
  assert.match(forbidden, /data-state="forbidden"/);
  assert.match(forbidden, /role="alert"/);

  const failure = render(createElement(OcsDetailState, { kind: 'error', detail: 'boom' }));
  assert.match(failure, /data-state="error"/);
  assert.match(failure, /role="alert"/);
  assert.match(failure, /boom/);

  const loading = render(createElement(OcsDetailState, { kind: 'loading' }));
  assert.match(loading, /role="status"/);
});

test('contract create carries provisioning fields and forbids a client-chosen lifecycle status', () => {
  const contracts = JSON.parse(readFileSync(resolve(testsDir, '../mutation-request-contract.json'), 'utf8')) as Array<{
    name: string;
    optionalBodyKeys: string[];
    forbiddenBodyKeys: string[];
  }>;
  const contract = contracts.find((entry) => entry.name === 'contract create');
  assert.ok(contract, 'the contract create request contract must exist');
  assert.ok(contract.optionalBodyKeys.includes('ocsTraffic'));
  assert.ok(contract.optionalBodyKeys.includes('reason'));
  assert.ok(contract.forbiddenBodyKeys.includes('status'), 'lifecycle status must not be a create field');
});

test('the contract provisioning dialog uses the insert-only governed request', () => {
  const dialog = readFileSync(
    resolve(testsDir, '../src/components/ocs/contracts/CreateContractDialog.tsx'),
    'utf8',
  );
  assert.match(dialog, /postJson[^\n]*\/api\/ocs\/subscribers/);
  assert.match(dialog, /plan_id: planId/);
  assert.match(dialog, /ocsTraffic/);
  assert.match(dialog, /reason: reason\.trim\(\)/);
  assert.match(dialog, /OCS_CONTRACT_RETAINED/);
  assert.match(dialog, /OCS_CONTRACT_EXISTS/);
  assert.doesNotMatch(dialog, /plan_default_10gb/, 'the dialog must not fall back to a default plan');
  assert.doesNotMatch(dialog, /status:\s*['"]/, 'the dialog must not submit a lifecycle status');
});

test('both contract entry points open the provisioning dialog', () => {
  const list = readFileSync(resolve(testsDir, '../src/components/ocs/contracts/OcsContractsPanel.tsx'), 'utf8');
  const detail = readFileSync(resolve(testsDir, '../src/features/subscribers/SubscriberDetailPage.tsx'), 'utf8');
  assert.match(list, /CreateContractDialog/);
  assert.match(list, /ocs_contract_create_action/);
  assert.match(detail, /CreateContractDialog/);
  assert.match(detail, /ocs_contract_create_action/);
});

test('the balance status filter includes retained terminated accounts', () => {
  const placeholder = readFileSync(
    resolve(testsDir, '../src/components/ocs/balances/OcsBalancePlaceholder.tsx'),
    'utf8',
  );
  assert.match(placeholder, /value: 'terminated'/);
});

test('the subscriber rating entry opens the concrete tariff plan, not the retired rating redirect', () => {
  const panel = readFileSync(
    resolve(testsDir, '../src/features/subscribers/components/subscriber/RatingRuleLinkPanel.tsx'),
    'utf8',
  );
  assert.match(panel, /\/ocs\/tariffs\/\$\{encodeURIComponent\(planId\)\}/);
  assert.doesNotMatch(panel, /href="\/rating"/);
});

test('the contract KPI strip reads the envelope summary instead of four status requests', () => {
  const panel = readFileSync(resolve(testsDir, '../src/components/ocs/contracts/OcsContractsPanel.tsx'), 'utf8');
  assert.match(panel, /toContractSummaryViewModel/);
  assert.doesNotMatch(panel, /allRead|activeRead|suspendedRead|terminatedRead/, 'the list must not fan out into per-status KPI reads');
});

test('the contract summary keeps missing counts missing', () => {
  assert.deepEqual(toContractSummaryViewModel({ summary: { total: 3, active: 2, suspended: 1, terminated: 0 } }), {
    total: 3,
    active: 2,
    suspended: 1,
    terminated: 0,
  });
  assert.equal(toContractSummaryViewModel({ records: [] }), null);
});

test('contract operations distinguish unavailable history from an empty history', () => {
  const empty = toContractOperationsViewModel({ operations: [], operationsComplete: true });
  assert.deepEqual(empty, { complete: true, records: [] });

  const unavailable = toContractOperationsViewModel({ operations: [], operationsComplete: false });
  assert.equal(unavailable.complete, false);

  const parsed = toContractOperationsViewModel({
    operationsComplete: true,
    operations: [{
      id: 'evt-1',
      timestamp: '2026-10-30T10:00:00.000Z',
      action: 'UPDATE',
      operation: 'CONTRACT_TERMINATE',
      actor: 'operator1',
      role: 'operator',
      reason: 'customer request',
      result: 'success',
      beforeStatus: 'active',
      afterStatus: 'terminated',
      beforePlanId: 'plan_a',
      afterPlanId: 'plan_a',
    }],
  });
  assert.equal(parsed.records[0].operation, 'CONTRACT_TERMINATE');
  assert.equal(parsed.records[0].afterStatus, 'terminated');
});

test('contracts can be filtered by MSISDN as well as IMSI', () => {
  const panel = readFileSync(resolve(testsDir, '../src/components/ocs/contracts/OcsContractsPanel.tsx'), 'utf8');
  assert.match(panel, /msisdn: state\.msisdn/);
  assert.match(panel, /ocs_search_msisdn/);
  const detail = readFileSync(resolve(testsDir, '../src/components/ocs/contracts/OcsContractDetail.tsx'), 'utf8');
  assert.match(detail, /ocs_contract_operations_title/);
  assert.match(detail, /ocs_contract_operations_unavailable/);
});

test('returnTo preserves list state but rejects external and foreign destinations', () => {
  const list = currentListLocation('/ocs/contracts', '?status=active&page=2');
  assert.equal(list, '/ocs/contracts?status=active&page=2');
  const href = withReturnTo('/ocs/contracts/460001234567890', list);
  const search = href.slice(href.indexOf('?'));
  assert.equal(resolveReturnTo(search, '/ocs/contracts', ['/ocs/contracts']), list);

  assert.equal(resolveReturnTo('?returnTo=https%3A%2F%2Fevil.example', '/ocs/contracts', ['/ocs/contracts']), '/ocs/contracts');
  assert.equal(resolveReturnTo('?returnTo=%2F%2Fevil.example', '/ocs/contracts', ['/ocs/contracts']), '/ocs/contracts');
  assert.equal(resolveReturnTo('?returnTo=%2Fsubscribers', '/ocs/contracts', ['/ocs/contracts']), '/ocs/contracts');
  assert.equal(resolveReturnTo('', '/ocs/contracts', ['/ocs/contracts']), '/ocs/contracts');
});

test('list links carry the filtered list URL and detail pages resolve it', () => {
  const pairs = [
    ['../src/components/ocs/contracts/OcsContractsPanel.tsx', '../src/components/ocs/contracts/OcsContractDetail.tsx'],
    ['../src/components/ocs/balances/OcsBalancePlaceholder.tsx', '../src/components/ocs/balances/OcsBalanceDetail.tsx'],
    ['../src/components/ocs/tariffs/OcsTariffGovernancePanel.tsx', '../src/components/ocs/tariffs/OcsTariffDetail.tsx'],
    ['../src/features/subscribers/SubscribersPage.tsx', '../src/features/subscribers/SubscriberDetailPage.tsx'],
    ['../src/features/profiles/ProfilesPage.tsx', '../src/features/profiles/ProfileDetailPage.tsx'],
  ];
  for (const [listFile, detailFile] of pairs) {
    const list = readFileSync(resolve(testsDir, listFile), 'utf8');
    const detail = readFileSync(resolve(testsDir, detailFile), 'utf8');
    assert.match(list, /withReturnTo/, `${listFile} must pass returnTo to detail links`);
    assert.match(detail, /resolveReturnTo/, `${detailFile} must resolve only its own list returnTo`);
  }

  for (const detailFile of [
    '../src/components/ocs/contracts/OcsContractDetail.tsx',
    '../src/components/ocs/balances/OcsBalanceDetail.tsx',
    '../src/components/ocs/tariffs/OcsTariffDetail.tsx',
  ]) {
    const detail = readFileSync(resolve(testsDir, detailFile), 'utf8');
    assert.match(detail, /to=\{backTo\.to\}/, `${detailFile} must use the resolved back target`);
  }
});

test('suspend, resume and terminate all require a confirmation with a reason', () => {
  const list = readFileSync(resolve(testsDir, '../src/components/ocs/contracts/OcsContractsPanel.tsx'), 'utf8');
  const detail = readFileSync(resolve(testsDir, '../src/components/ocs/contracts/OcsContractDetail.tsx'), 'utf8');
  for (const source of [list, detail]) {
    assert.match(source, /openLifecyclePrompt|setLifecyclePrompt/);
    assert.match(source, /reasonRequired/);
    assert.match(source, /reason: reason\.trim\(\)|reason \}/);
  }
  assert.doesNotMatch(list, /onClick=\{\(\) => void handleSuspend/);
  assert.doesNotMatch(list, /onClick=\{\(\) => void handleResume/);
});
