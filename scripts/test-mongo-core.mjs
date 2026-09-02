import { MongoClient, ObjectId, Long } from 'mongodb';
import nextEnv from '@next/env';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/xcloud';
const DEFAULT_MONGODB_DB = 'xcloud';
const args = new Set(process.argv.slice(2));
const keepDb = args.has('--keep-db');
const allowConfiguredDb = args.has('--allow-configured-db');
const mongoUri = process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
const configuredOpen5gsDbName = process.env.MONGODB_XCLOUD_DB || process.env.MONGODB_DB || DEFAULT_MONGODB_DB;
const configuredAppDbName = process.env.MONGODB_APP_DB || 'xcloud_ops';
const explicitTestDb = process.env.MONGODB_TEST_DB;
const explicitTestAppDb = process.env.MONGODB_TEST_APP_DB;
const dbName = explicitTestDb || `${configuredOpen5gsDbName}_core_test_${Date.now()}_${process.pid}`;
const appDbName = explicitTestAppDb || `${configuredAppDbName}_core_test_${Date.now()}_${process.pid}`;
const startedAt = new Date();
const checks = [];

const client = new MongoClient(mongoUri, {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

const expectedIndexes = {
  subscribers: ['uniq_imsi'],
  ocs_tariff_plans: ['uniq_plan_id', 'rules_rating_group'],
  ocs_subscribers: ['uniq_ocs_subscriber_imsi', 'ocs_subscriber_plan_id'],
  ocs_balances: ['uniq_ocs_balance_imsi', 'ocs_balance_updated_at_desc'],
  app_profiles: ['uniq_profile_name', 'profile_updated_at_desc'],
  app_profile_versions: ['profile_versions_by_profile', 'uniq_profile_version_id'],
  app_users: ['uniq_username'],
  app_approvals: ['approvals_status_created', 'uniq_approval_id'],
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

function numericValue(value) {
  if (Long.isLong(value)) return value.toNumber();
  return Number(value);
}

function epcRealm(imsi) {
  const mcc = imsi.slice(0, 3) || '417';
  const mnc = (imsi.slice(3, 5) || '1').padStart(3, '0');
  return {
    mme_host: `mme.epc.mnc${mnc}.mcc${mcc}.3gppnetwork.org`,
    mme_realm: `epc.mnc${mnc}.mcc${mcc}.3gppnetwork.org`,
  };
}

function subscriberDoc(imsi) {
  const realm = epcRealm(imsi);

  return {
    __v: 0,
    schema_version: 1,
    imsi,
    msisdn: [],
    imeisv: '8672710677532401',
    security: {
      k: '00000000000000000000000000000000',
      op: null,
      opc: '00000000000000000000000000000000',
      amf: '8000',
      sqn: 1719756,
    },
    ambr: {
      downlink: { value: 1, unit: 3 },
      uplink: { value: 1, unit: 3 },
    },
    slice: [
      {
        _id: new ObjectId(),
        sst: 1,
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
          },
        ],
      },
    ],
    access_restriction_data: 32,
    subscriber_status: 0,
    network_access_mode: 0,
    subscribed_rau_tau_timer: 12,
    mme_host: realm.mme_host,
    mme_realm: realm.mme_realm,
    mme_timestamp: Date.now() * 1000,
    purge_flag: false,
  };
}

async function ensureIndexes(db, appDb) {
  await db.collection('subscribers').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_imsi' },
  ]);

  await db.collection('ocs_tariff_plans').createIndexes([
    { key: { plan_id: 1 }, unique: true, name: 'uniq_plan_id' },
    { key: { 'rules.rating_group': 1 }, name: 'rules_rating_group' },
  ]);

  await db.collection('ocs_subscribers').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_ocs_subscriber_imsi' },
    { key: { plan_id: 1 }, name: 'ocs_subscriber_plan_id' },
  ]);

  await db.collection('ocs_balances').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_ocs_balance_imsi' },
    { key: { updated_at: -1 }, name: 'ocs_balance_updated_at_desc' },
  ]);

  await appDb.collection('app_profiles').createIndexes([
    { key: { name: 1 }, unique: true, name: 'uniq_profile_name' },
    { key: { updated_at: -1 }, name: 'profile_updated_at_desc' },
  ]);

  await appDb.collection('app_profile_versions').createIndexes([
    { key: { profileName: 1, savedAt: -1 }, name: 'profile_versions_by_profile' },
    { key: { versionId: 1 }, unique: true, name: 'uniq_profile_version_id' },
  ]);

  await appDb.collection('app_users').createIndexes([
    { key: { username: 1 }, unique: true, name: 'uniq_username' },
  ]);

  await appDb.collection('app_approvals').createIndexes([
    { key: { status: 1, createdAt: -1 }, name: 'approvals_status_created' },
    { key: { id: 1 }, unique: true, name: 'uniq_approval_id' },
  ]);

  await appDb.collection('app_audit_logs').createIndexes([
    { key: { timestamp: -1 }, name: 'audit_timestamp_desc' },
    { key: { targetId: 1, timestamp: -1 }, name: 'audit_target_timestamp' },
    { key: { action: 1, timestamp: -1 }, name: 'audit_action_timestamp' },
  ]);

  await appDb.collection('app_alerts').createIndexes([
    { key: { timestamp: -1 }, name: 'alerts_timestamp_desc' },
    { key: { is_acknowledged: 1, level: 1, timestamp: -1 }, name: 'alerts_active_by_level' },
    { key: { imsi: 1, timestamp: -1 }, name: 'alerts_imsi_timestamp' },
  ]);

  await appDb.collection('app_rate_limits').createIndexes([
    { key: { key: 1 }, unique: true, name: 'uniq_rate_limit_key' },
    { key: { reset_at: 1 }, expireAfterSeconds: 0, name: 'ttl_rate_limit_reset_at' },
  ]);

  await appDb.collection('app_metrics').createIndexes([
    { key: { key: 1 }, unique: true, name: 'uniq_metric_key' },
    { key: { updated_at: -1 }, name: 'metrics_updated_at_desc' },
  ]);
}

async function verifyIndexes(db, appDb) {
  for (const [collectionName, indexNames] of Object.entries(expectedIndexes)) {
    const targetDb = collectionName === 'subscribers' || collectionName.startsWith('ocs_') ? db : appDb;
    const indexes = await targetDb.collection(collectionName).listIndexes().toArray();
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
  assert(inserted?.security?.k && inserted?.security?.opc, 'subscriber authentication fields must exist');
  assert(inserted?.mme_realm && inserted?.mme_host, 'subscriber must include EPC MME realm fields');
  assert(!('ocs' in inserted), 'HSS subscriber must not embed OCS data');
  assert(!('webui_meta' in inserted), 'HSS subscriber must not embed Web UI metadata');

  try {
    await subscribers.insertOne(subscriberDoc(imsi));
    throw new Error('duplicate subscriber insert unexpectedly succeeded');
  } catch (error) {
    assertDuplicateKey(error, 'duplicate subscriber insert');
  }

  await subscribers.updateOne({ imsi }, { $set: { access_restriction_data: 0 } });
  const updated = await subscribers.findOne({ imsi });
  assert(updated?.access_restriction_data === 0, 'subscriber update should persist HSS access restriction');

  const batchOps = [2, 3, 4].map((suffix) => ({
    replaceOne: {
      filter: { imsi: `46002000000000${suffix}` },
      replacement: subscriberDoc(`46002000000000${suffix}`),
      upsert: true,
    },
  }));
  await subscribers.bulkWrite(batchOps, { ordered: false });
  assert(await subscribers.countDocuments({ imsi: /^46002000000000[234]$/ }) === 3, 'batch subscriber upsert count mismatch');
}

async function testProfilesAndOcsTariffs(db, appDb) {
  const now = new Date();
  const profiles = appDb.collection('app_profiles');
  const versions = appDb.collection('app_profile_versions');
  const tariffPlans = db.collection('ocs_tariff_plans');

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

  await tariffPlans.insertOne({
    plan_id: 'plan_default_10gb',
    status: 'active',
    quota_per_grant: Long.fromNumber(10485760),
    validity_time: 300,
    volume_threshold: Long.fromNumber(8388608),
    rules: [{
      rule_id: 'internet_rg1001_si1',
      apn: 'internet',
      rating_group: Long.fromNumber(1001),
      service_identifier: Long.fromNumber(1),
      charging_type: 'data_volume',
      unit: 'bytes',
      quota_per_grant: Long.fromNumber(10485760),
      validity_time: 300,
      volume_threshold: Long.fromNumber(8388608),
      priority: 100,
      status: 'active',
      currency: 'USD',
      rates: '0.01',
      rates_type: 2,
    }, {
      rule_id: 'ims_default',
      apn: 'ims',
      rating_group: Long.ZERO,
      service_identifier: Long.ZERO,
      charging_type: 'free',
      unit: 'bytes',
      quota_per_grant: Long.ZERO,
      validity_time: 0,
      volume_threshold: Long.ZERO,
      priority: 200,
      status: 'active',
    }, {
      rule_id: 'voice_rg3001_si1',
      apn: 'ims',
      rating_group: Long.fromNumber(3001),
      service_identifier: Long.fromNumber(1),
      charging_type: 'voice_time',
      unit: 'seconds',
      quota_per_grant: Long.fromNumber(60),
      validity_time: 300,
      volume_threshold: Long.ZERO,
      priority: 90,
      status: 'active',
    }],
    created_at: now,
    updated_at: now,
  });
  try {
    await tariffPlans.insertOne({ plan_id: 'plan_default_10gb', status: 'active', rules: [] });
    throw new Error('duplicate tariff plan insert unexpectedly succeeded');
  } catch (error) {
    assertDuplicateKey(error, 'duplicate tariff plan insert');
  }
}

async function testOcsProvisioning(db) {
  const now = new Date();
  const imsi = '460020000000001';
  const ocsSubscribers = db.collection('ocs_subscribers');
  const balances = db.collection('ocs_balances');

  await ocsSubscribers.insertOne({ imsi, msisdn: '', status: 'active', plan_id: 'plan_default_10gb', created_at: now, updated_at: now });
  try {
    await ocsSubscribers.insertOne({ imsi, status: 'active', plan_id: 'plan_default_10gb' });
    throw new Error('duplicate OCS subscriber insert unexpectedly succeeded');
  } catch (error) {
    assertDuplicateKey(error, 'duplicate OCS subscriber insert');
  }

  await balances.insertOne({
    imsi,
    data_total: Long.fromNumber(10737418240),
    data_used: Long.fromNumber(0),
    data_reserved: Long.fromNumber(0),
    data_available: Long.fromNumber(10737418240),
    voice_total: Long.fromNumber(3600),
    voice_used: Long.fromNumber(0),
    voice_reserved: Long.fromNumber(0),
    voice_available: Long.fromNumber(3600),
    version: Long.fromNumber(1),
    updated_at: now,
  });
  const balance = await balances.findOne({ imsi });
  const total = numericValue(balance.data_total);
  const used = numericValue(balance.data_used);
  const reserved = numericValue(balance.data_reserved);
  const available = numericValue(balance.data_available);
  const voiceTotal = numericValue(balance.voice_total);
  const voiceUsed = numericValue(balance.voice_used);
  const voiceReserved = numericValue(balance.voice_reserved);
  const voiceAvailable = numericValue(balance.voice_available);
  assert(total === used + reserved + available, 'OCS balance invariant mismatch');
  assert(voiceTotal === voiceUsed + voiceReserved + voiceAvailable, 'OCS voice balance invariant mismatch');
}

async function testUsersAuditAlertsAndRuntimeCollections(appDb) {
  const now = new Date();
  const users = appDb.collection('app_users');
  const auditLogs = appDb.collection('app_audit_logs');
  const alerts = appDb.collection('app_alerts');
  const rateLimits = appDb.collection('app_rate_limits');
  const metrics = appDb.collection('app_metrics');

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
  if ((dbName === configuredOpen5gsDbName || appDbName === configuredAppDbName) && !allowConfiguredDb) {
    throw new Error(
      `Refusing to run against configured databases "${configuredOpen5gsDbName}" or "${configuredAppDbName}". Set MONGODB_TEST_DB/MONGODB_TEST_APP_DB or pass --allow-configured-db intentionally.`
    );
  }

  console.log(`Connecting to MongoDB and using test databases "${dbName}" and "${appDbName}"...`);
  await client.connect();
  const db = client.db(dbName);
  const appDb = client.db(appDbName);
  const runStartedAt = Date.now();

  try {
    await runCheck('mongo.ping', () => db.command({ ping: 1 }));
    await runCheck('mongo.app_ping', () => appDb.command({ ping: 1 }));
    await runCheck('indexes.ensure', () => ensureIndexes(db, appDb));
    await runCheck('indexes.verify', () => verifyIndexes(db, appDb));
    await runCheck('subscribers.crud_and_batch', () => testSubscribers(db));
    await runCheck('profiles.ocs_tariffs', () => testProfilesAndOcsTariffs(db, appDb));
    await runCheck('ocs.provisioning', () => testOcsProvisioning(db));
    await runCheck('users.audit.alerts.runtime', () => testUsersAuditAlertsAndRuntimeCollections(appDb));

    const report = {
      ok: true,
      command: 'mongo:test-core',
      databases: { xcloud: dbName, app: appDbName },
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
      await appDb.dropDatabase();
    }
    await client.close();
  }
}

main().catch(async (error) => {
  const report = {
    ok: false,
    command: 'mongo:test-core',
    databases: { xcloud: dbName, app: appDbName },
    kept: keepDb,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    checks,
    error: errorSummary(error),
    recommendations: [
      'Confirm MongoDB is reachable from this host.',
      'Run npm run mongo:init before retrying if index verification failed.',
      'Use MONGODB_TEST_DB and MONGODB_TEST_APP_DB to force disposable database names.',
      'Avoid --allow-configured-db unless you intentionally want to run against the configured database.',
    ],
  };
  const outputPath = await writeOpsReport('mongo-test-core', report, startedAt);
  console.error('MongoDB core integration test failed:', error);
  console.error(`Failure report written to ${outputPath}`);
  process.exitCode = 1;
});
