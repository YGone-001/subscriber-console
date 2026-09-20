import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient, Long } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const startedAt = Date.now();
const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_ocs_governance_test_${suffix}`;
const appDbName = `xcloud_ops_ocs_governance_test_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': new URL('../frontend/src/', import.meta.url).pathname } });
const {
  freezeOcsBalanceAdjustment,
  executeFrozenOcsBalanceAdjustment,
  OcsBalanceGovernanceError,
} = jiti('../frontend/src/server/ocsBalanceGovernance.ts');
const { getMongoClient } = jiti('../frontend/src/lib/mongo.ts');

const client = new MongoClient(uri, { serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000) });
const report = { ok: false, command: 'mongo:test-ocs-governance', databases: { xcloud: xcloudDbName, app: appDbName }, checks: [] };

async function check(name, fn) {
  const at = Date.now();
  await fn();
  report.checks.push({ name, ok: true, durationMs: Date.now() - at });
}

function balance(imsi, version = 10) {
  return {
    imsi,
    data_total: Long.fromNumber(1000), data_used: Long.fromNumber(300), data_reserved: Long.fromNumber(500), data_available: Long.fromNumber(200),
    voice_total: Long.ZERO, voice_used: Long.ZERO, voice_reserved: Long.ZERO, voice_available: Long.ZERO,
    version: Long.fromNumber(version), updated_at: new Date(),
  };
}

function numberValue(value) {
  return Long.isLong(value) ? value.toNumber() : Number(value);
}

try {
  await client.connect();
  const xcloud = client.db(xcloudDbName);
  const app = client.db(appDbName);
  await app.collection('ocs_balance_adjustments').createIndexes([
    { key: { adjustmentId: 1 }, unique: true, name: 'uniq_ocs_balance_adjustment_id' },
    { key: { executionId: 1 }, unique: true, name: 'uniq_ocs_balance_execution_id' },
  ]);

  await check('balance.stale_version_cas', async () => {
    const imsi = '460020000000701';
    await xcloud.collection('ocs_balances').insertOne(balance(imsi));
    const frozen = await freezeOcsBalanceAdjustment(imsi, { bucket: 'data', operation: 'credit', amount: 100, reason: 'stale test' });
    await xcloud.collection('ocs_balances').updateOne({ imsi }, { $inc: { version: Long.ONE }, $set: { data_available: Long.fromNumber(200) } });
    await assert.rejects(
      () => executeFrozenOcsBalanceAdjustment(frozen, { approvalId: `approval-${randomUUID()}`, executionId: `execution-${randomUUID()}`, actor: 'tester' }),
      (error) => error instanceof OcsBalanceGovernanceError && error.code === 'OCS_BALANCE_PRECONDITION_CHANGED'
    );
    const current = await xcloud.collection('ocs_balances').findOne({ imsi });
    assert.equal(numberValue(current.data_total), 1000);
    assert.equal(numberValue(current.version), 11);
  });

  await check('balance.debit_reservation_protection', async () => {
    const imsi = '460020000000702';
    await xcloud.collection('ocs_balances').insertOne(balance(imsi));
    await assert.rejects(
      () => freezeOcsBalanceAdjustment(imsi, { bucket: 'data', operation: 'debit', amount: 300, reason: 'must fail' }),
      (error) => error instanceof OcsBalanceGovernanceError && error.code === 'OCS_BALANCE_RESERVATION_CONFLICT'
    );
    const current = await xcloud.collection('ocs_balances').findOne({ imsi });
    assert.equal(numberValue(current.data_total), 1000);
    assert.equal(numberValue(current.data_reserved), 500);
  });

  await check('balance.idempotent_double_execution', async () => {
    const imsi = '460020000000703';
    await xcloud.collection('ocs_balances').insertOne(balance(imsi));
    const frozen = await freezeOcsBalanceAdjustment(imsi, { bucket: 'data', operation: 'credit', amount: 50, reason: 'exactly once' });
    const context = { approvalId: `approval-${randomUUID()}`, executionId: `execution-${randomUUID()}`, actor: 'tester' };
    const attempts = await Promise.allSettled([
      executeFrozenOcsBalanceAdjustment(frozen, context),
      executeFrozenOcsBalanceAdjustment(frozen, context),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled' && !attempt.value.idempotent).length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected' && attempt.reason?.code !== 'OCS_BALANCE_ADJUSTMENT_IN_PROGRESS').length, 0);
    const replay = await executeFrozenOcsBalanceAdjustment(frozen, context);
    assert.equal(replay.idempotent, true);
    const current = await xcloud.collection('ocs_balances').findOne({ imsi });
    assert.equal(numberValue(current.data_total), 1050);
    assert.equal(numberValue(current.data_available), 250);
    assert.equal(await app.collection('ocs_balance_adjustments').countDocuments({ adjustmentId: frozen.adjustmentId }), 1);
  });

  await check('balance.sms_adjustment', async () => {
    const imsi = '460020000000704';
    await xcloud.collection('ocs_balances').insertOne({
      imsi,
      sms_total: Long.fromNumber(100), sms_used: Long.fromNumber(20), sms_available: Long.fromNumber(80),
      version: Long.fromNumber(1), updated_at: new Date(),
    });
    // Credit 50 SMS
    const frozenCredit = await freezeOcsBalanceAdjustment(imsi, { bucket: 'sms', operation: 'credit', amount: 50, reason: 'sms credit test' });
    assert.equal(frozenCredit.before.reserved, 0);
    assert.equal(frozenCredit.before.total, 100);
    assert.equal(frozenCredit.before.available, 80);
    assert.equal(frozenCredit.expectedAfter.total, 150);
    assert.equal(frozenCredit.expectedAfter.available, 130);

    const creditResult = await executeFrozenOcsBalanceAdjustment(frozenCredit, {
      approvalId: `approval-${randomUUID()}`, executionId: `execution-${randomUUID()}`, actor: 'tester',
    });
    assert.equal(creditResult.after.total, 150);
    assert.equal(creditResult.after.available, 130);

    let current = await xcloud.collection('ocs_balances').findOne({ imsi });
    assert.equal(numberValue(current.sms_total), 150);
    assert.equal(numberValue(current.sms_available), 130);
    assert.equal(numberValue(current.version), 2);

    // Debit 30 SMS
    const frozenDebit = await freezeOcsBalanceAdjustment(imsi, { bucket: 'sms', operation: 'debit', amount: 30, reason: 'sms debit test' });
    assert.equal(frozenDebit.expectedAfter.total, 120);
    assert.equal(frozenDebit.expectedAfter.available, 100);

    const debitResult = await executeFrozenOcsBalanceAdjustment(frozenDebit, {
      approvalId: `approval-${randomUUID()}`, executionId: `execution-${randomUUID()}`, actor: 'tester',
    });
    assert.equal(debitResult.after.total, 120);
    assert.equal(debitResult.after.available, 100);

    current = await xcloud.collection('ocs_balances').findOne({ imsi });
    assert.equal(numberValue(current.sms_total), 120);
    assert.equal(numberValue(current.sms_available), 100);
    assert.equal(numberValue(current.version), 3);
  });

  await check('balance.cas_drift_field_change', async () => {
    const imsi = '460020000000705';
    await xcloud.collection('ocs_balances').insertOne(balance(imsi, 20));
    const frozen = await freezeOcsBalanceAdjustment(imsi, { bucket: 'data', operation: 'credit', amount: 100, reason: 'drift test' });

    // Live balance changed available/total without bumping version
    await xcloud.collection('ocs_balances').updateOne({ imsi }, { $set: { data_total: Long.fromNumber(1100), data_available: Long.fromNumber(300) } });
    await assert.rejects(
      () => executeFrozenOcsBalanceAdjustment(frozen, { approvalId: `approval-${randomUUID()}`, executionId: `execution-${randomUUID()}`, actor: 'tester' }),
      (error) => error instanceof OcsBalanceGovernanceError && error.code === 'OCS_BALANCE_PRECONDITION_CHANGED'
    );
  });

  await check('balance.broken_invariant_rejection', async () => {
    const imsi = '460020000000706';
    await xcloud.collection('ocs_balances').insertOne(balance(imsi, 30));
    const frozen = await freezeOcsBalanceAdjustment(imsi, { bucket: 'data', operation: 'credit', amount: 100, reason: 'invariant test' });

    // Corrupt document invariants in database
    await xcloud.collection('ocs_balances').updateOne({ imsi }, { $set: { data_total: Long.fromNumber(9999) } });
    await assert.rejects(
      () => executeFrozenOcsBalanceAdjustment(frozen, { approvalId: `approval-${randomUUID()}`, executionId: `execution-${randomUUID()}`, actor: 'tester' }),
      (error) => error instanceof OcsBalanceGovernanceError && error.code === 'OCS_BALANCE_INVARIANT_VIOLATION'
    );
  });

  report.ok = true;
  report.durationMs = Date.now() - startedAt;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  report.durationMs = Date.now() - startedAt;
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await client.db(xcloudDbName).dropDatabase().catch(() => {});
  await client.db(appDbName).dropDatabase().catch(() => {});
  await client.close().catch(() => {});
  const moduleClient = await getMongoClient().catch(() => null);
  await moduleClient?.close().catch(() => {});
}
