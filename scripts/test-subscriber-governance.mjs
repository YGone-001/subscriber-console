import { MongoClient } from 'mongodb';
import nextEnv from '@next/env';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const startedAt = new Date();
const suffix = `subscriber_governance_test_${Date.now()}_${process.pid}`;
const xcloudDbName = `${process.env.MONGODB_XCLOUD_DB || process.env.MONGODB_DB || 'xcloud'}_${suffix}`;
const appDbName = `${process.env.MONGODB_APP_DB || 'xcloud_ops'}_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';
const checks = [];
const client = new MongoClient(uri, { maxPoolSize: 4, serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000) });

function assert(condition, message) { if (!condition) throw new Error(message); }
async function check(name, fn) { const started = Date.now(); await fn(); checks.push({ name, ok: true, durationMs: Date.now() - started }); }
function doc(imsi, access = 32, downlink = 50) { return { imsi, access_restriction_data: access, ambr: { downlink: { value: downlink, unit: 3 }, uplink: { value: 25, unit: 3 } }, security: { k: 'fixture-only', opc: 'fixture-only' } }; }
function update(imsi, expectedAccess, nextAccess) { return { updateOne: { filter: { imsi, access_restriction_data: expectedAccess }, update: { $set: { access_restriction_data: nextAccess } }, upsert: false } }; }

async function main() {
  await client.connect();
  const db = client.db(xcloudDbName);
  const appDb = client.db(appDbName);
  const subscribers = db.collection('subscribers');
  const approvals = appDb.collection('app_approvals');
  try {
    await check('mongo.ping', () => db.command({ ping: 1 }));
    await check('fixtures.isolated_indexes', async () => {
      await subscribers.createIndex({ imsi: 1 }, { unique: true, name: 'uniq_imsi' });
      await approvals.createIndex({ operationFingerprint: 1 }, { unique: true, partialFilterExpression: { action: 'SUBSCRIBER_BATCH_UPDATE', status: { $in: ['pending', 'approved', 'executing'] }, operationFingerprint: { $type: 'string' } }, name: 'uniq_active_subscriber_batch_fingerprint' });
    });
    await check('approval_creation_does_not_mutate_subscribers', async () => {
      await subscribers.insertMany([doc('460009000000001'), doc('460009000000002')]);
      await approvals.insertOne({ id: 'approval-create', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'pending', operationFingerprint: 'fixture-create', payload: { targets: ['460009000000001', '460009000000002'], after: { access_restriction_data: 0 } } });
      const values = await subscribers.find({ imsi: { $in: ['460009000000001', '460009000000002'] } }).toArray();
      assert(values.every((item) => item.access_restriction_data === 32), 'subscriber changed during approval creation');
      await approvals.updateOne({ id: 'approval-create' }, { $set: { status: 'approved' } });
      const approvedValues = await subscribers.find({ imsi: { $in: ['460009000000001', '460009000000002'] } }).toArray();
      assert(approvedValues.every((item) => item.access_restriction_data === 32), 'subscriber changed during approval decision');
    });
    await check('conditional_happy_path_and_verified_counts', async () => {
      const result = await subscribers.bulkWrite([update('460009000000001', 32, 0), update('460009000000002', 32, 0)], { ordered: true });
      assert(result.matchedCount === 2 && result.modifiedCount === 2, `expected 2/2 mutation, got ${result.matchedCount}/${result.modifiedCount}`);
      const values = await subscribers.find({ imsi: { $in: ['460009000000001', '460009000000002'] } }).toArray();
      assert(values.every((item) => item.access_restriction_data === 0), 'conditional mutation did not persist frozen after value');
    });
    await check('drift_and_partial_write_fail_closed', async () => {
      await subscribers.updateMany({ imsi: { $in: ['460009000000001', '460009000000002'] } }, { $set: { access_restriction_data: 32 } });
      await subscribers.updateOne({ imsi: '460009000000002' }, { $set: { access_restriction_data: 64 } });
      const result = await subscribers.bulkWrite([update('460009000000001', 32, 0), update('460009000000002', 32, 0)], { ordered: true });
      assert(result.matchedCount === 1 && result.modifiedCount === 1, `partial write must expose 1/1, got ${result.matchedCount}/${result.modifiedCount}`);
      const drifted = await subscribers.findOne({ imsi: '460009000000002' });
      assert(drifted?.access_restriction_data === 64, 'drifted subscriber was overwritten by stale update');
    });
    await check('race_prevents_stale_overwrite', async () => {
      const imsi = '460009000000003';
      await subscribers.insertOne(doc(imsi));
      await subscribers.updateOne({ imsi }, { $set: { access_restriction_data: 128 } });
      const result = await subscribers.updateOne({ imsi, access_restriction_data: 32 }, { $set: { access_restriction_data: 0 } });
      assert(result.matchedCount === 0 && result.modifiedCount === 0, 'conditional write matched after concurrent drift');
      assert((await subscribers.findOne({ imsi }))?.access_restriction_data === 128, 'race overwrote concurrent update');
    });
    await check('active_fingerprint_idempotency_index', async () => {
      await approvals.insertOne({ id: 'approval-fingerprint-a', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'pending', operationFingerprint: 'duplicate-fingerprint' });
      try { await approvals.insertOne({ id: 'approval-fingerprint-b', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'approved', operationFingerprint: 'duplicate-fingerprint' }); throw new Error('active duplicate fingerprint unexpectedly inserted'); }
      catch (error) { assert(error?.code === 11000, 'active fingerprint did not enforce duplicate key'); }
      await approvals.updateOne({ id: 'approval-fingerprint-a' }, { $set: { status: 'completed' } });
      await approvals.insertOne({ id: 'approval-fingerprint-c', action: 'SUBSCRIBER_BATCH_UPDATE', status: 'pending', operationFingerprint: 'duplicate-fingerprint' });
    });
    const report = { ok: true, command: 'mongo:test-subscriber-governance', databases: { xcloud: xcloudDbName, app: appDbName }, checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime(), checks, cleanup: 'dropped isolated databases' };
    console.log(JSON.stringify(report, null, 2));
    console.log(`Ops report written to ${await writeOpsReport('mongo-test-subscriber-governance', report, startedAt)}`);
  } finally { await db.dropDatabase(); await appDb.dropDatabase(); await client.close(); }
}

main().catch(async (error) => {
  const report = { ok: false, command: 'mongo:test-subscriber-governance', databases: { xcloud: xcloudDbName, app: appDbName }, checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime(), checks, error: errorSummary(error), cleanup: 'isolated databases will be removed when connection cleanup succeeds' };
  console.error('Subscriber governance MongoDB integration test failed:', error);
  console.error(`Ops report written to ${await writeOpsReport('mongo-test-subscriber-governance', report, startedAt)}`);
  process.exitCode = 1;
});
