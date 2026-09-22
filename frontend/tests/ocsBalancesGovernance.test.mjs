import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const placeholderSource = readFileSync(
  new URL('../src/components/ocs/balances/OcsBalancePlaceholder.tsx', import.meta.url),
  'utf8'
);
const modalSource = readFileSync(
  new URL('../src/components/ocs/balances/AdjustBalanceModal.tsx', import.meta.url),
  'utf8'
);
const zhLocale = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');
const enLocale = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');

test('OcsBalancePlaceholder exists and implements Governed Balance Console', () => {
  assert.equal(existsSync(new URL('../src/components/ocs/balances/OcsBalancePlaceholder.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/ocs/balances/AdjustBalanceModal.tsx', import.meta.url)), true);

  // Header and title
  assert.match(placeholderSource, /ocs_balances_title/);

  // KPI cards
  assert.match(placeholderSource, /ocs_balance_total_accounts/);
  assert.match(placeholderSource, /ocs_balance_active_accounts/);
  assert.doesNotMatch(placeholderSource, /ocs_balance_pending_adjustments/);

  // Table columns & Actions
  assert.match(placeholderSource, /ocs_col_data_available/);
  assert.match(placeholderSource, /ocs_col_voice_avail/);
  assert.match(placeholderSource, /ocs_col_sms_avail/);
  assert.match(placeholderSource, /ocs_balance_adjust/);

  // NEVER show reset button
  assert.doesNotMatch(placeholderSource, /reset/i);
  assert.doesNotMatch(placeholderSource, /BALANCE_RESET/);
  assert.doesNotMatch(modalSource, /reset/i);
});

test('OcsBalancePlaceholder satisfies canonical toolbar CSS contract and state handling', () => {
  // Canonical classes
  assert.match(placeholderSource, /ocs-controls-bar/);
  assert.match(placeholderSource, /ocs-search-group/);
  assert.match(placeholderSource, /ocs-filters-group/);
  assert.match(placeholderSource, /ocs-select/);

  // State handling
  assert.match(placeholderSource, /loading\s*\?/);
  assert.match(placeholderSource, /ocs-loading/);
  assert.match(placeholderSource, /error\s*\?/);
  assert.match(placeholderSource, /ocs-error-cell/);
  assert.match(placeholderSource, /error\s*\?\s*"—"\s*:\s*total/);
  assert.match(placeholderSource, /records\.length === 0/);
});

test('AdjustBalanceModal implements governed balance adjustment fields and flows', () => {
  // Fields: bucket, operation, amount, reason, ticketId
  assert.match(modalSource, /bucket/);
  assert.match(modalSource, /operation/);
  assert.match(modalSource, /amount/);
  assert.match(modalSource, /reason/);
  assert.match(modalSource, /ticketId/);

  // Supported buckets: data, voice, sms
  assert.match(modalSource, /value="data"/);
  assert.match(modalSource, /value="voice"/);
  assert.match(modalSource, /value="sms"/);

  // Supported operations: credit, debit
  assert.match(modalSource, /value="credit"/);
  assert.match(modalSource, /value="debit"/);

  // API endpoint
  assert.match(modalSource, /\/api\/ocs\/balances\/.*\/adjust/);

  // Direct execution: no approval redirect
  assert.doesNotMatch(modalSource, /\/approvals\?id=/);

  // CAS precondition conflict handling
  assert.match(modalSource, /BALANCE_PRECONDITION_CHANGED/);
});

test('Balance governance localization keys are complete in zh and en', () => {
  assert.match(zhLocale, /ocs_balances_title:\s*"余额治理"/);
  assert.match(enLocale, /ocs_balances_title:\s*"Balance Governance"/);

  assert.match(zhLocale, /ocs_balance_total_accounts:\s*"总余额账户"/);
  assert.match(enLocale, /ocs_balance_total_accounts:\s*"Total Balance Accounts"/);

  assert.match(zhLocale, /ocs_balance_active_accounts:\s*"活跃账户"/);
  assert.match(enLocale, /ocs_balance_active_accounts:\s*"Active Accounts"/);

  assert.match(zhLocale, /ocs_balance_adjust:\s*"调整余额"/);
  assert.match(enLocale, /ocs_balance_adjust:\s*"Adjust Balance"/);

  assert.match(zhLocale, /ocs_balance_cutover_pending:\s*"余额写入割接尚未完成，当前处于只读模式"/);
  assert.match(enLocale, /ocs_balance_cutover_pending:\s*"Balance write cutover pending; currently in read-only shadow mode"/);

  assert.match(zhLocale, /ocs_balance_backend_unreachable/);
  assert.match(enLocale, /ocs_balance_backend_unreachable/);
});

test('OcsBalancePlaceholder operational cutover enables Adjust Balance with role gating', () => {
  // Uses auth and capabilityDecision
  assert.match(placeholderSource, /useAuth/);
  assert.match(placeholderSource, /capabilityDecision\(.*"balance_adjust"\)/);

  // Button is gated on canAdjust, opens modal on click
  assert.match(placeholderSource, /disabled=\{!canAdjust\}/);
  assert.match(placeholderSource, /onClick=\{.*setAdjustTarget\(r\)\}/);

  // Still NEVER show reset button in UI
  assert.doesNotMatch(placeholderSource, /reset/i);
  assert.doesNotMatch(placeholderSource, /BALANCE_RESET/);
});

test('AdjustBalanceModal handles direct-operation errors (CAS 409 and Go 502)', () => {
  // CAS 409 conflict
  assert.match(modalSource, /BALANCE_PRECONDITION_CHANGED/);

  // Go backend unreachable 502
  assert.match(modalSource, /GO_BACKEND_UNREACHABLE/);
  assert.match(modalSource, /ocs_balance_backend_unreachable/);
});
