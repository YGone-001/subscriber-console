import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateOcsBalanceIntent, OcsBalanceGovernanceError } from '../src/server/ocsBalanceGovernance.ts';

const approvalExecutionSource = readFileSync(
  new URL('../src/server/approvalExecution.ts', import.meta.url),
  'utf8'
);

test('validateOcsBalanceIntent accepts data, voice, and sms buckets', () => {
  const dataIntent = validateOcsBalanceIntent({ bucket: 'data', operation: 'credit', amount: 1000, reason: 'test credit' });
  assert.equal(dataIntent.bucket, 'data');
  assert.equal(dataIntent.operation, 'credit');
  assert.equal(dataIntent.amount, 1000);

  const voiceIntent = validateOcsBalanceIntent({ bucket: 'voice', operation: 'debit', amount: 60, reason: 'test voice debit' });
  assert.equal(voiceIntent.bucket, 'voice');
  assert.equal(voiceIntent.operation, 'debit');

  const smsIntent = validateOcsBalanceIntent({ bucket: 'sms', operation: 'credit', amount: 50, reason: 'test sms credit' });
  assert.equal(smsIntent.bucket, 'sms');
  assert.equal(smsIntent.operation, 'credit');
  assert.equal(smsIntent.amount, 50);

  // Invalid bucket
  assert.throws(
    () => validateOcsBalanceIntent({ bucket: 'unsupported', operation: 'credit', amount: 100, reason: 'invalid' }),
    (err) => err instanceof OcsBalanceGovernanceError && err.code === 'INVALID_OCS_BALANCE_BUCKET'
  );

  // Invalid operation
  assert.throws(
    () => validateOcsBalanceIntent({ bucket: 'data', operation: 'multiply', amount: 100, reason: 'invalid' }),
    (err) => err instanceof OcsBalanceGovernanceError && err.code === 'INVALID_OCS_BALANCE_OPERATION'
  );

  // Invalid amount <= 0
  assert.throws(
    () => validateOcsBalanceIntent({ bucket: 'data', operation: 'credit', amount: 0, reason: 'zero' }),
    (err) => err instanceof OcsBalanceGovernanceError && err.code === 'INVALID_OCS_BALANCE_AMOUNT'
  );

  // Missing reason
  assert.throws(
    () => validateOcsBalanceIntent({ bucket: 'data', operation: 'credit', amount: 100, reason: '' }),
    (err) => err instanceof OcsBalanceGovernanceError && err.code === 'OCS_BALANCE_REASON_REQUIRED'
  );
});

test('approvalExecution enforces canonical ocs-balance-adjustment-v1 schema and rejects unsupported schemas', () => {
  // Ensure schema check exists in TRAFFIC_ADJUSTMENT branch
  assert.match(approvalExecutionSource, /approval\.action === 'TRAFFIC_ADJUSTMENT'/);
  assert.match(approvalExecutionSource, /payload\.schema !== 'ocs-balance-adjustment-v1'/);
  assert.match(approvalExecutionSource, /UNSUPPORTED_APPROVAL_PAYLOAD_SCHEMA/);
  assert.match(approvalExecutionSource, /executeFrozenOcsBalanceAdjustment/);
  assert.match(approvalExecutionSource, /executeApproval\(approval, request\)/);
});

test('approvalExecution maps OcsBalanceGovernanceError properly with committed status', () => {
  assert.match(approvalExecutionSource, /if \(error instanceof OcsBalanceGovernanceError\)/);
  assert.match(approvalExecutionSource, /error\.committed \? 503 : 409/);
});
