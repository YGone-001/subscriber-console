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
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': new URL('../src/', import.meta.url).pathname } });
const {
  freezeOcsBalanceAdjustment,
  executeFrozenOcsBalanceAdjustment,
  OcsBalanceGovernanceError,
} = jiti('../src/server/ocsBalanceGovernance.ts');
const { getMongoClient } = jiti('../src/lib/mongo.ts');

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
