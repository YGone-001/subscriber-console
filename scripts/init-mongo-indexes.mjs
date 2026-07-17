import { Long, MongoClient } from 'mongodb';
import nextEnv from '@next/env';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/open5gs';
const open5gsDbName = process.env.MONGODB_OPEN5GS_DB || process.env.MONGODB_DB || 'open5gs';
const appDbName = process.env.MONGODB_APP_DB || 'xcloud_ops';
const startedAt = new Date();
const createdIndexes = [];
const maintenanceActions = [];
const DEFAULT_OCS_PLAN_ID = 'plan_default_10gb';
const DEFAULT_QUOTA_PER_GRANT = 10 * 1024 * 1024;
const DEFAULT_VOLUME_THRESHOLD = 8 * 1024 * 1024;
const DEFAULT_VALIDITY_TIME = 300;
const DEFAULT_TOTAL_BALANCE = 10 * 1024 * 1024 * 1024;
const DEFAULT_VOICE_TOTAL = 60 * 60;
const DEFAULT_VOICE_QUOTA_PER_GRANT = 60;

const client = new MongoClient(uri, {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

async function dedupeRateLimits(appDb) {
  const rateLimits = appDb.collection('app_rate_limits');
  const duplicateGroups = await rateLimits.aggregate([
    { $sort: { key: 1, reset_at: -1, updated_at: -1, _id: -1 } },
    { $group: { _id: '$key', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  const duplicateIds = duplicateGroups.flatMap((group) => group.ids.slice(1));
  if (duplicateIds.length === 0) return;

  const result = await rateLimits.deleteMany({ _id: { $in: duplicateIds } });
  maintenanceActions.push({
    database: appDbName,
    collection: 'app_rate_limits',
    action: 'dedupe_before_unique_index',
    duplicateGroups: duplicateGroups.length,
    deletedDocuments: result.deletedCount,
  });
}

function asString(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function defaultInternetRule() {
  return {
    rule_id: 'internet_rg1001_si1',
    apn: 'internet',
    rating_group: Long.fromNumber(1001),
    service_identifier: Long.fromNumber(1),
    charging_type: 'data_volume',
    unit: 'bytes',
    quota_per_grant: Long.fromNumber(DEFAULT_QUOTA_PER_GRANT),
    validity_time: DEFAULT_VALIDITY_TIME,
    volume_threshold: Long.fromNumber(DEFAULT_VOLUME_THRESHOLD),
    priority: 100,
    status: 'active',
  };
}

function defaultImsRule() {
  return {
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
  };
}

function defaultVoiceRule() {
  return {
    rule_id: 'voice_rg3001_si1',
    apn: 'ims',
    rating_group: Long.fromNumber(3001),
    service_identifier: Long.fromNumber(1),
    charging_type: 'voice_time',
    unit: 'seconds',
    quota_per_grant: Long.fromNumber(DEFAULT_VOICE_QUOTA_PER_GRANT),
    validity_time: DEFAULT_VALIDITY_TIME,
    volume_threshold: Long.ZERO,
    priority: 90,
    status: 'active',
  };
}

function tariffRuleFromRating(rating) {
  const ratingGroupId = Number(rating.rating_group_id);
  const apn = asString(rating.apn, 'internet');
  const serviceIdentifier = Number(rating.service_identifier ?? 1);

  return {
    rule_id: `${apn}_rg${ratingGroupId}_si${serviceIdentifier}`,
    apn,
    rating_group: Long.fromNumber(ratingGroupId),
    service_identifier: Long.fromNumber(serviceIdentifier),
    charging_type: asString(rating.charging_type, 'data_volume'),
    unit: asString(rating.unit, rating.charging_type === 'voice_time' ? 'seconds' : 'bytes'),
    quota_per_grant: Long.fromNumber(Number(rating.quota_per_grant ?? DEFAULT_QUOTA_PER_GRANT)),
    validity_time: Number(rating.validity_time ?? DEFAULT_VALIDITY_TIME),
    volume_threshold: Long.fromNumber(Number(rating.volume_threshold ?? DEFAULT_VOLUME_THRESHOLD)),
    priority: Number(rating.priority ?? 100),
    status: asString(rating.status, 'active'),
    currency: asString(rating.currency, 'USD'),
    rates: asString(rating.rates, '0'),
    rates_type: Number(rating.rates_type) || 2,
  };
}

async function seedOcsTariffPlan(open5gsDb, appDb) {
  const now = new Date();
  const tariffPlans = open5gsDb.collection('ocs_tariff_plans');
  const legacyRatings = await appDb.collection('app_ratings')
    .find({ rating_group_id: { $exists: true } })
    .sort({ rating_group_id: 1 })
    .toArray();
  const existing = await tariffPlans.findOne({ plan_id: DEFAULT_OCS_PLAN_ID });
  const rules = [...(existing?.rules || [])];
  const existingGroups = new Set(rules.map((rule) => Number(Long.isLong(rule.rating_group) ? rule.rating_group.toNumber() : rule.rating_group)));
  let changed = false;

  if (!rules.some((rule) => rule.rule_id === 'internet_rg1001_si1')) {
    rules.unshift(defaultInternetRule());
    changed = true;
  }

  if (!rules.some((rule) => rule.rule_id === 'ims_default')) {
    rules.push(defaultImsRule());
    changed = true;
  }

  if (!rules.some((rule) => rule.rule_id === 'voice_rg3001_si1')) {
    rules.push(defaultVoiceRule());
    changed = true;
  }

  for (const rating of legacyRatings) {
    const ratingGroupId = Number(rating.rating_group_id);
    if (!Number.isFinite(ratingGroupId) || existingGroups.has(ratingGroupId)) continue;
    rules.push(tariffRuleFromRating(rating));
    existingGroups.add(ratingGroupId);
    changed = true;
  }

  if (!existing) {
    await tariffPlans.insertOne({
      plan_id: DEFAULT_OCS_PLAN_ID,
      name: 'Default 10GB Data Plan',
      status: 'active',
      unit: 'bytes',
      quota_per_grant: Long.fromNumber(DEFAULT_QUOTA_PER_GRANT),
      validity_time: DEFAULT_VALIDITY_TIME,
      volume_threshold: Long.fromNumber(DEFAULT_VOLUME_THRESHOLD),
      rules,
      created_at: now,
      updated_at: now,
    });
    maintenanceActions.push({
      database: open5gsDbName,
      collection: 'ocs_tariff_plans',
      action: 'seed_default_plan',
      importedLegacyRatings: Math.max(0, legacyRatings.length),
    });
    return;
  }

  if (!changed) return;

  await tariffPlans.updateOne(
    { plan_id: DEFAULT_OCS_PLAN_ID },
    {
      $set: {
        status: existing.status || 'active',
        quota_per_grant: existing.quota_per_grant || Long.fromNumber(DEFAULT_QUOTA_PER_GRANT),
        validity_time: existing.validity_time || DEFAULT_VALIDITY_TIME,
        volume_threshold: existing.volume_threshold || Long.fromNumber(DEFAULT_VOLUME_THRESHOLD),
        rules,
        updated_at: now,
      },
    }
  );
  maintenanceActions.push({
    database: open5gsDbName,
    collection: 'ocs_tariff_plans',
    action: 'sync_default_plan_rules',
    importedLegacyRatings: legacyRatings.length,
  });
}

async function provisionExistingOcsSubscribers(open5gsDb) {
  const now = new Date();
  const subscribers = open5gsDb.collection('subscribers');
  const ocsSubscribers = open5gsDb.collection('ocs_subscribers');
  const balances = open5gsDb.collection('ocs_balances');
  const cursor = subscribers.find(
    { imsi: { $type: 'string' } },
    { projection: { imsi: 1, msisdn: 1 } }
  );
  let scanned = 0;
  let ocsSubscriberInserted = 0;
  let balanceInserted = 0;
  let subscriberOps = [];
  let balanceOps = [];

  async function flush() {
    if (subscriberOps.length === 0) return;
    const [subscriberResult, balanceResult] = await Promise.all([
      ocsSubscribers.bulkWrite(subscriberOps, { ordered: false }),
      balances.bulkWrite(balanceOps, { ordered: false }),
    ]);
    ocsSubscriberInserted += subscriberResult.upsertedCount || 0;
    balanceInserted += balanceResult.upsertedCount || 0;
    subscriberOps = [];
    balanceOps = [];
  }

  for await (const subscriber of cursor) {
    scanned++;
    const imsi = String(subscriber.imsi);
    const msisdn = Array.isArray(subscriber.msisdn) ? asString(subscriber.msisdn[0]) : asString(subscriber.msisdn);

    subscriberOps.push({
      updateOne: {
        filter: { imsi },
        update: {
          $setOnInsert: {
            imsi,
            msisdn,
            status: 'active',
            plan_id: DEFAULT_OCS_PLAN_ID,
            created_at: now,
            updated_at: now,
          },
        },
        upsert: true,
      },
    });
    balanceOps.push({
      updateOne: {
        filter: { imsi },
        update: {
          $setOnInsert: {
            imsi,
            data_total: Long.fromNumber(DEFAULT_TOTAL_BALANCE),
            data_used: Long.ZERO,
            data_reserved: Long.ZERO,
            data_available: Long.fromNumber(DEFAULT_TOTAL_BALANCE),
            voice_total: Long.fromNumber(DEFAULT_VOICE_TOTAL),
            voice_used: Long.ZERO,
            voice_reserved: Long.ZERO,
            voice_available: Long.fromNumber(DEFAULT_VOICE_TOTAL),
            version: Long.fromNumber(1),
            updated_at: now,
          },
        },
        upsert: true,
      },
    });

    if (subscriberOps.length >= 500) await flush();
  }

  await flush();
  const voiceBackfill = await balances.updateMany(
    {
      $or: [
        { voice_total: { $exists: false } },
        { voice_used: { $exists: false } },
        { voice_reserved: { $exists: false } },
        { voice_available: { $exists: false } },
      ],
    },
    [{
      $set: {
        voice_total: { $ifNull: ['$voice_total', Long.fromNumber(DEFAULT_VOICE_TOTAL)] },
        voice_used: { $ifNull: ['$voice_used', Long.ZERO] },
        voice_reserved: { $ifNull: ['$voice_reserved', Long.ZERO] },
        voice_available: { $ifNull: ['$voice_available', Long.fromNumber(DEFAULT_VOICE_TOTAL)] },
        updated_at: now,
      },
    }]
  );
  maintenanceActions.push({
    database: open5gsDbName,
    collections: ['ocs_subscribers', 'ocs_balances'],
    action: 'provision_missing_ocs_subscribers',
    subscribersScanned: scanned,
    ocsSubscribersInserted: ocsSubscriberInserted,
    balancesInserted: balanceInserted,
    voiceBalancesBackfilled: voiceBackfill.modifiedCount,
  });
}

async function ensureIndexes() {
  await client.connect();
  const open5gsDb = client.db(open5gsDbName);
  const appDb = client.db(appDbName);

  createdIndexes.push(...(await open5gsDb.collection('subscribers').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_imsi' },
  ])).map((name) => ({ database: open5gsDbName, collection: 'subscribers', name })));

  createdIndexes.push(...(await open5gsDb.collection('ocs_tariff_plans').createIndexes([
    { key: { plan_id: 1 }, unique: true, name: 'uniq_plan_id' },
    { key: { 'rules.rating_group': 1 }, name: 'rules_rating_group' },
  ])).map((name) => ({ database: open5gsDbName, collection: 'ocs_tariff_plans', name })));

  createdIndexes.push(...(await open5gsDb.collection('ocs_subscribers').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_ocs_subscriber_imsi' },
    { key: { plan_id: 1 }, name: 'ocs_subscriber_plan_id' },
  ])).map((name) => ({ database: open5gsDbName, collection: 'ocs_subscribers', name })));

  createdIndexes.push(...(await open5gsDb.collection('ocs_balances').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_ocs_balance_imsi' },
    { key: { updated_at: -1 }, name: 'ocs_balance_updated_at_desc' },
  ])).map((name) => ({ database: open5gsDbName, collection: 'ocs_balances', name })));

  createdIndexes.push(...(await appDb.collection('app_profiles').createIndexes([
    { key: { name: 1 }, unique: true, name: 'uniq_profile_name' },
    { key: { updated_at: -1 }, name: 'profile_updated_at_desc' },
  ])).map((name) => ({ database: appDbName, collection: 'app_profiles', name })));

  createdIndexes.push(...(await appDb.collection('app_profile_versions').createIndexes([
    { key: { profileName: 1, savedAt: -1 }, name: 'profile_versions_by_profile' },
    { key: { versionId: 1 }, unique: true, name: 'uniq_profile_version_id' },
  ])).map((name) => ({ database: appDbName, collection: 'app_profile_versions', name })));

  createdIndexes.push(...(await appDb.collection('app_users').createIndexes([
    { key: { username: 1 }, unique: true, name: 'uniq_username' },
  ])).map((name) => ({ database: appDbName, collection: 'app_users', name })));

  createdIndexes.push(...(await appDb.collection('app_audit_logs').createIndexes([
    { key: { timestamp: -1 }, name: 'audit_timestamp_desc' },
    { key: { targetId: 1, timestamp: -1 }, name: 'audit_target_timestamp' },
    { key: { action: 1, timestamp: -1 }, name: 'audit_action_timestamp' },
  ])).map((name) => ({ database: appDbName, collection: 'app_audit_logs', name })));

  createdIndexes.push(...(await appDb.collection('app_alerts').createIndexes([
    { key: { timestamp: -1 }, name: 'alerts_timestamp_desc' },
    { key: { is_acknowledged: 1, level: 1, timestamp: -1 }, name: 'alerts_active_by_level' },
    { key: { imsi: 1, timestamp: -1 }, name: 'alerts_imsi_timestamp' },
  ])).map((name) => ({ database: appDbName, collection: 'app_alerts', name })));

  await dedupeRateLimits(appDb);
  createdIndexes.push(...(await appDb.collection('app_rate_limits').createIndexes([
    { key: { key: 1 }, unique: true, name: 'uniq_rate_limit_key' },
    { key: { reset_at: 1 }, expireAfterSeconds: 0, name: 'ttl_rate_limit_reset_at' },
  ])).map((name) => ({ database: appDbName, collection: 'app_rate_limits', name })));

  createdIndexes.push(...(await appDb.collection('app_metrics').createIndexes([
    { key: { key: 1 }, unique: true, name: 'uniq_metric_key' },
    { key: { updated_at: -1 }, name: 'metrics_updated_at_desc' },
  ])).map((name) => ({ database: appDbName, collection: 'app_metrics', name })));

  await seedOcsTariffPlan(open5gsDb, appDb);
  await provisionExistingOcsSubscribers(open5gsDb);
}

ensureIndexes()
  .then(async () => {
    const report = {
      ok: true,
      command: 'mongo:init',
      databases: { open5gs: open5gsDbName, app: appDbName },
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      indexes: createdIndexes,
      maintenanceActions,
      summary: {
        collectionsTouched: new Set(createdIndexes.map((index) => `${index.database}.${index.collection}`)).size,
        indexesEnsured: createdIndexes.length,
      },
    };
    const outputPath = await writeOpsReport('mongo-init', report, startedAt);
    console.log(`MongoDB indexes are ready for databases "${open5gsDbName}" and "${appDbName}".`);
    console.log(`Ops report written to ${outputPath}`);
  })
  .catch(async (error) => {
    const report = {
      ok: false,
      command: 'mongo:init',
      databases: { open5gs: open5gsDbName, app: appDbName },
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      indexes: createdIndexes,
      maintenanceActions,
      error: errorSummary(error),
      recommendations: [
        'Confirm MONGODB_URI, MONGODB_DB, and MONGODB_APP_DB point to the intended databases.',
        'Check MongoDB connectivity and credentials from the application host.',
        'Rerun npm run mongo:init after connectivity or permission issues are fixed.',
      ],
    };
    const outputPath = await writeOpsReport('mongo-init', report, startedAt);
    console.error('Failed to initialize MongoDB indexes:', error);
    console.error(`Failure report written to ${outputPath}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
