import { MongoClient, ObjectId, Long } from 'mongodb';
import nextEnv from '@next/env';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/open5gs';
const DEFAULT_MONGODB_DB = 'open5gs';
const args = new Set(process.argv.slice(2));
const keepDb = args.has('--keep-db');
const allowConfiguredDb = args.has('--allow-configured-db');
const mongoUri = process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
const configuredDbName = process.env.MONGODB_DB || DEFAULT_MONGODB_DB;
const explicitTestDb = process.env.MONGODB_TEST_DB;
const dbName = explicitTestDb || `${configuredDbName}_core_test_${Date.now()}_${process.pid}`;
const startedAt = new Date();
const checks = [];

const client = new MongoClient(mongoUri, {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

const expectedIndexes = {
  subscribers: ['uniq_imsi', 'profile_name', 'ocs_plmn', 'ocs_rating_map', 'updated_at_desc'],
  app_profiles: ['uniq_profile_name', 'profile_updated_at_desc'],
  app_profile_versions: ['profile_versions_by_profile', 'uniq_profile_version_id'],
  app_ratings: ['uniq_rating_group_id'],
  app_users: ['uniq_username'],
  app_audit_logs: ['audit_timestamp_desc', 'audit_target_timestamp', 'audit_action_timestamp'],
  app_alerts: ['alerts_timestamp_desc', 'alerts_active_by_level', 'alerts_imsi_timestamp'],
  app_rate_limits: ['uniq_rate_limit_key', 'ttl_rate_limit_reset_at'],
  app_metrics: ['uniq_metric_key', 'metrics_updated_at_desc'],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCheck(name, fn) {
  const started = Date.now();
  await fn();
  checks.push({ name, ok: true, durationMs: Date.now() - started });
}

function assertDuplicateKey(error, label) {
  assert(error?.code === 11000, `${label} should fail with duplicate-key error`);
}

function subscriberDoc(imsi, profileName = 'default') {
  const now = new Date();

  return {
    __v: 0,
    schema_version: 1,
    imsi,
    msisdn: [`86${imsi.slice(-11)}`],
    imeisv: [],
    mme_host: [],
    mm_realm: [],
    purge_flag: [],
    security: {
      k: '00000000000000000000000000000000',
      op: null,
      opc: '00000000000000000000000000000000',
      amf: '8000',
      sqn: Long.fromNumber(1),
    },
    ambr: {
      downlink: { value: 1, unit: 3 },
      uplink: { value: 1, unit: 3 },
    },
    slice: [
      {
        _id: new ObjectId(),
        sst: 1,
        sd: '000001',
        default_indicator: true,
        session: [
          {
            _id: new ObjectId(),
            name: 'internet',
            type: 3,
            qos: {
              index: 9,
              arp: {
                priority_level: 8,
                pre_emption_capability: 1,
                pre_emption_vulnerability: 2,
              },
            },
            ambr: {
              downlink: { value: 1, unit: 3 },
              uplink: { value: 1, unit: 3 },
            },
            pcc_rule: [],
            lbo_roaming_allowed: false,
          },
        ],
      },
    ],
    access_restriction_data: 32,
    subscriber_status: 0,
    operator_determined_barring: 0,
    network_access_mode: 0,
    subscribed_rau_tau_timer: 12,
    ocs: {
      traffic: {
        traffic_total: 10737418240,
        traffic_balance: 10737418240,
        imsi,
        plmn: '45400',
      },
      imsi: {
        account_id: imsi,
        imsi,
        withhold: 100,
        withholding_residue: 0,
        withholding_time: 3600,
      },
      account: {
        account_id: imsi,
        balance: '10000',
        currency: 'USD',
      },
      rating: {
        rates_map: { 45400: 1001 },
        imsi,
      },
    },
    webui_meta: {
      profile_name: profileName,
      created_at: now,
      updated_at: now,
    },
    created_at: now,
    updated_at: now,
  };
}

async function ensureIndexes(db) {
  await db.collection('subscribers').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_imsi' },
    { key: { 'webui_meta.profile_name': 1 }, name: 'profile_name' },
    { key: { 'ocs.traffic.plmn': 1 }, name: 'ocs_plmn' },
    { key: { 'ocs.rating.rates_map': 1 }, name: 'ocs_rating_map' },
    { key: { updated_at: -1 }, name: 'updated_at_desc' },
  ]);

  await db.collection('app_profiles').createIndexes([
    { key: { name: 1 }, unique: true, name: 'uniq_profile_name' },
    { key: { updated_at: -1 }, name: 'profile_updated_at_desc' },
  ]);

  await db.collection('app_profile_versions').createIndexes([
    { key: { profileName: 1, savedAt: -1 }, name: 'profile_versions_by_profile' },
    { key: { versionId: 1 }, unique: true, name: 'uniq_profile_version_id' },
  ]);

  await db.collection('app_ratings').createIndexes([
    { key: { rating_group_id: 1 }, unique: true, name: 'uniq_rating_group_id' },
  ]);

  await db.collection('app_users').createIndexes([
    { key: { username: 1 }, unique: true, name: 'uniq_username' },
  ]);

  await db.collection('app_audit_logs').createIndexes([
    { key: { timestamp: -1 }, name: 'audit_timestamp_desc' },
    { key: { targetId: 1, timestamp: -1 }, name: 'audit_target_timestamp' },
    { key: { action: 1, timestamp: -1 }, name: 'audit_action_timestamp' },
  ]);

  await db.collection('app_alerts').createIndexes([
    { key: { timestamp: -1 }, name: 'alerts_timestamp_desc' },
    { key: { is_acknowledged: 1, level: 1, timestamp: -1 }, name: 'alerts_active_by_level' },
    { key: { imsi: 1, timestamp: -1 }, name: 'alerts_imsi_timestamp' },
  ]);

  await db.collection('app_rate_limits').createIndexes([
    { key: { key: 1 }, unique: true, name: 'uniq_rate_limit_key' },
    { key: { reset_at: 1 }, expireAfterSeconds: 0, name: 'ttl_rate_limit_reset_at' },
  ]);

  await db.collection('app_metrics').createIndexes([
    { key: { key: 1 }, unique: true, name: 'uniq_metric_key' },
    { key: { updated_at: -1 }, name: 'metrics_updated_at_desc' },
  ]);
}

async function verifyIndexes(db) {
  for (const [collectionName, indexNames] of Object.entries(expectedIndexes)) {
    const indexes = await db.collection(collectionName).listIndexes().toArray();
    const actualNames = new Set(indexes.map((index) => index.name));
    for (const indexName of indexNames) {
      assert(actualNames.has(indexName), `${collectionName} missing index ${indexName}`);
    }
  }
}

async function testSubscribers(db) {
  const subscribers = db.collection('subscribers');
  const imsi = '460020000000001';

  await subscribers.insertOne(subscriberDoc(imsi));
  const inserted = await subscribers.findOne({ imsi });
  assert(inserted?.mm_realm && !('mme_realm' in inserted), 'subscriber must use mm_realm and not mme_realm');
  assert(
    Long.isLong(inserted.security.sqn) || typeof inserted.security.sqn === 'number',
    'subscriber security.sqn must round-trip as a BSON Long-compatible numeric value'
  );

  try {
    await subscribers.insertOne(subscriberDoc(imsi));
    throw new Error('duplicate subscriber insert unexpectedly succeeded');
  } catch (error) {
    assertDuplicateKey(error, 'duplicate subscriber insert');
  }

  await subscribers.updateOne({ imsi }, { $set: { 'ocs.account.balance': '9000', updated_at: new Date() } });
  const updated = await subscribers.findOne({ imsi });
  assert(updated?.ocs?.account?.balance === '9000', 'subscriber update should persist OCS account balance');

  const batchOps = [2, 3, 4].map((suffix) => ({
    replaceOne: {
      filter: { imsi: `46002000000000${suffix}` },
      replacement: subscriberDoc(`46002000000000${suffix}`, 'batch'),
      upsert: true,
    },
  }));
  await subscribers.bulkWrite(batchOps, { ordered: false });
  assert(await subscribers.countDocuments({ 'webui_meta.profile_name': 'batch' }) === 3, 'batch subscriber upsert count mismatch');
}

async function testProfilesAndRatings(db) {
  const now = new Date();
  const profiles = db.collection('app_profiles');
  const versions = db.collection('app_profile_versions');
  const ratings = db.collection('app_ratings');

  await profiles.insertOne({ name: 'default', title: 'Default', updated_at: now, sliceList: [] });
  try {
    await profiles.insertOne({ name: 'default', title: 'Duplicate', updated_at: now });
    throw new Error('duplicate profile insert unexpectedly succeeded');
  } catch (error) {
    assertDuplicateKey(error, 'duplicate profile insert');
  }

  await versions.insertOne({
    versionId: 'profile-default-v1',
    profileName: 'default',
    savedAt: now,
    action: 'CREATE',
    profile: { name: 'default' },
  });
  assert(await versions.countDocuments({ profileName: 'default' }) === 1, 'profile version should be queryable by profileName');

  await ratings.insertOne({ rating_group_id: 1001, currency: 'USD', rates: '0.01', rates_type: 2 });
  try {
    await ratings.insertOne({ rating_group_id: 1001, currency: 'USD', rates: '0.02', rates_type: 2 });
    throw new Error('duplicate rating insert unexpectedly succeeded');
  } catch (error) {
    assertDuplicateKey(error, 'duplicate rating insert');
  }
}

async function testUsersAuditAlertsAndRuntimeCollections(db) {
  const now = new Date();
  const users = db.collection('app_users');
  const auditLogs = db.collection('app_audit_logs');
  const alerts = db.collection('app_alerts');
  const rateLimits = db.collection('app_rate_limits');
  const metrics = db.collection('app_metrics');

  await users.insertOne({ username: 'admin', role: 'root', passwordHash: 'hash', created_at: now, updated_at: now });
  try {
    await users.insertOne({ username: 'admin', role: 'viewer', passwordHash: 'hash', created_at: now, updated_at: now });
    throw new Error('duplicate user insert unexpectedly succeeded');
  } catch (error) {
    assertDuplicateKey(error, 'duplicate user insert');
  }

  await auditLogs.insertOne({
    id: 'audit-1',
    timestamp: now,
    action: 'CREATE',
    targetId: '460020000000001',
    operator: 'integration-test',
  });
  assert(await auditLogs.countDocuments({ targetId: '460020000000001' }) === 1, 'audit log target query mismatch');

  await alerts.insertOne({
    id: 'alert-1',
    timestamp: now,
    level: 'warning',
    imsi: '460020000000001',
    is_acknowledged: false,
  });
  assert(await alerts.countDocuments({ is_acknowledged: false, level: 'warning' }) === 1, 'alert active query mismatch');

  await rateLimits.updateOne(
    { key: 'integration-test' },
    { $inc: { count: 1 }, $set: { reset_at: new Date(Date.now() + 60000) } },
    { upsert: true }
  );
  assert(await rateLimits.countDocuments({ key: 'integration-test' }) === 1, 'rate limit upsert mismatch');

  await metrics.updateOne(
    { key: 'subscriber-total' },
    { $set: { value: 4, updated_at: now } },
    { upsert: true }
  );
  assert(await metrics.countDocuments({ key: 'subscriber-total' }) === 1, 'metric upsert mismatch');
}

async function main() {
  if (dbName === configuredDbName && !allowConfiguredDb) {
    throw new Error(
      `Refusing to run against configured database "${configuredDbName}". Set MONGODB_TEST_DB or pass --allow-configured-db intentionally.`
    );
  }

  console.log(`Connecting to MongoDB and using test database "${dbName}"...`);
  await client.connect();
  const db = client.db(dbName);
  const runStartedAt = Date.now();

  try {
    await runCheck('mongo.ping', () => db.command({ ping: 1 }));
    await runCheck('indexes.ensure', () => ensureIndexes(db));
    await runCheck('indexes.verify', () => verifyIndexes(db));
    await runCheck('subscribers.crud_and_batch', () => testSubscribers(db));
    await runCheck('profiles.ratings', () => testProfilesAndRatings(db));
    await runCheck('users.audit.alerts.runtime', () => testUsersAuditAlertsAndRuntimeCollections(db));

    const report = {
      ok: true,
      command: 'mongo:test-core',
      database: dbName,
      kept: keepDb,
      durationMs: Date.now() - runStartedAt,
      checkedAt: new Date().toISOString(),
      collections: Object.keys(expectedIndexes).length,
      checks,
      cleanup: keepDb ? 'kept' : 'dropped',
    };
    const outputPath = await writeOpsReport('mongo-test-core', report, startedAt);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Ops report written to ${outputPath}`);
  } finally {
    if (!keepDb) {
      await db.dropDatabase();
    }
    await client.close();
  }
}

main().catch(async (error) => {
  const report = {
    ok: false,
    command: 'mongo:test-core',
    database: dbName,
    kept: keepDb,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    checks,
    error: errorSummary(error),
    recommendations: [
      'Confirm MongoDB is reachable from this host.',
      'Run npm run mongo:init before retrying if index verification failed.',
      'Use MONGODB_TEST_DB to force a disposable database name.',
      'Avoid --allow-configured-db unless you intentionally want to run against the configured database.',
    ],
  };
  const outputPath = await writeOpsReport('mongo-test-core', report, startedAt);
  console.error('MongoDB core integration test failed:', error);
  console.error(`Failure report written to ${outputPath}`);
  process.exitCode = 1;
});
