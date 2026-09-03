import { Long, MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import nextEnv from '@next/env';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';
const xcloudDbName = process.env.MONGODB_XCLOUD_DB || 'xcloud';
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

async function seedOcsTariffPlan(xcloudDb, appDb) {
  const now = new Date();
  const tariffPlans = xcloudDb.collection('ocs_tariff_plans');
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
      database: xcloudDbName,
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
    database: xcloudDbName,
    collection: 'ocs_tariff_plans',
    action: 'sync_default_plan_rules',
    importedLegacyRatings: legacyRatings.length,
  });
}

async function provisionExistingOcsSubscribers(xcloudDb) {
  const now = new Date();
  const subscribers = xcloudDb.collection('subscribers');
  const ocsSubscribers = xcloudDb.collection('ocs_subscribers');
  const balances = xcloudDb.collection('ocs_balances');
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
    database: xcloudDbName,
    collections: ['ocs_subscribers', 'ocs_balances'],
    action: 'provision_missing_ocs_subscribers',
    subscribersScanned: scanned,
    ocsSubscribersInserted: ocsSubscriberInserted,
    balancesInserted: balanceInserted,
    voiceBalancesBackfilled: voiceBackfill.modifiedCount,
  });
}

/**
 * Drop existing indexes whose key pattern conflicts with the desired index.
 * This handles legacy indexes created with auto-generated names (e.g. "plan_id_1")
 * that collide when we try to create a named index on the same key.
 */
async function dropConflictingIndexes(collection, desiredIndexes) {
  const existing = await collection.listIndexes().toArray();
  for (const desired of desiredIndexes) {
    const desiredKey = JSON.stringify(desired.key);
    for (const existingIdx of existing) {
      if (existingIdx.name === '_id_') continue;
      if (JSON.stringify(existingIdx.key) === desiredKey && existingIdx.name !== desired.name) {
        await collection.dropIndex(existingIdx.name);
        maintenanceActions.push({
          database: collection.dbName,
          collection: collection.collectionName,
          action: 'drop_conflicting_index',
          droppedName: existingIdx.name,
          replacingWith: desired.name,
        });
      }
    }
  }
}

async function ensureIndexes() {
  await client.connect();
  const xcloudDb = client.db(xcloudDbName);
  const appDb = client.db(appDbName);

  // ── xcloud.subscribers ──
  createdIndexes.push(...(await xcloudDb.collection('subscribers').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_imsi' },
    { key: { msisdn: 1 }, name: 'subscriber_msisdn' },
  ])).map((name) => ({ database: xcloudDbName, collection: 'subscribers', name })));

  // ── xcloud.ocs_tariff_plans ──
  const tariffDesired = [
    { key: { plan_id: 1 }, unique: true, name: 'uniq_plan_id' },
    { key: { 'rules.rating_group': 1 }, name: 'rules_rating_group' },
  ];
  await dropConflictingIndexes(xcloudDb.collection('ocs_tariff_plans'), tariffDesired);
  createdIndexes.push(...(await xcloudDb.collection('ocs_tariff_plans').createIndexes(tariffDesired))
    .map((name) => ({ database: xcloudDbName, collection: 'ocs_tariff_plans', name })));

  // ── xcloud.ocs_subscribers ──
  const ocsSubDesired = [
    { key: { imsi: 1 }, unique: true, name: 'uniq_ocs_subscriber_imsi' },
    { key: { plan_id: 1 }, name: 'ocs_subscriber_plan_id' },
    { key: { msisdn: 1 }, name: 'ocs_subscriber_msisdn' },
  ];
  await dropConflictingIndexes(xcloudDb.collection('ocs_subscribers'), ocsSubDesired);
  createdIndexes.push(...(await xcloudDb.collection('ocs_subscribers').createIndexes(ocsSubDesired))
    .map((name) => ({ database: xcloudDbName, collection: 'ocs_subscribers', name })));

  // ── xcloud.ocs_balances ──
  const balanceDesired = [
    { key: { imsi: 1 }, unique: true, name: 'uniq_ocs_balance_imsi' },
    { key: { updated_at: -1 }, name: 'ocs_balance_updated_at_desc' },
  ];
  await dropConflictingIndexes(xcloudDb.collection('ocs_balances'), balanceDesired);
  createdIndexes.push(...(await xcloudDb.collection('ocs_balances').createIndexes(balanceDesired))
    .map((name) => ({ database: xcloudDbName, collection: 'ocs_balances', name })));

  // ── xcloud.ocs_sessions ──
  createdIndexes.push(...(await xcloudDb.collection('ocs_sessions').createIndexes([
    { key: { state: 1, last_update_at: -1 }, name: 'ocs_session_state_updated' },
  ])).map((name) => ({ database: xcloudDbName, collection: 'ocs_sessions', name })));

  // ── xcloud.ocs_usage_records ──
  createdIndexes.push(...(await xcloudDb.collection('ocs_usage_records').createIndexes([
    { key: { created_at: -1 }, name: 'ocs_usage_created_at_desc' },
  ])).map((name) => ({ database: xcloudDbName, collection: 'ocs_usage_records', name })));

  // ── xcloud_ops collections ──
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
    { key: { status: 1, createdAt: -1 }, name: 'users_status_created' },
    { key: { role: 1, status: 1 }, name: 'users_role_status' },
  ])).map((name) => ({ database: appDbName, collection: 'app_users', name })));

  createdIndexes.push(...(await appDb.collection('app_approvals').createIndexes([
    { key: { status: 1, createdAt: -1 }, name: 'approvals_status_created' },
    { key: { id: 1 }, unique: true, name: 'uniq_approval_id' },
    { key: { changeId: 1 }, unique: true, partialFilterExpression: { changeId: { $type: 'string' } }, name: 'uniq_approval_change_id' },
    { key: { riskLevel: 1, status: 1, createdAt: -1 }, name: 'approvals_risk_status_created' },
    { key: { requester: 1, createdAt: -1 }, name: 'approvals_requester_created' },
    { key: { reviewer: 1, createdAt: -1 }, name: 'approvals_reviewer_created' },
    { key: { 'operation.resourceType': 1, 'operation.resourceId': 1, createdAt: -1 }, name: 'approvals_resource_created' },
    { key: { operationFingerprint: 1 }, unique: true, partialFilterExpression: { action: { $in: ['SUBSCRIBER_UPDATE', 'SUBSCRIBER_DELETE', 'SUBSCRIBER_BATCH_CREATE', 'SUBSCRIBER_BATCH_UPDATE', 'SUBSCRIBER_IMPORT', 'SUBSCRIBER_IMPORT_OVERWRITE', 'SUBSCRIBER_BULK_DELETE'] }, status: { $in: ['pending', 'approved', 'executing'] }, operationFingerprint: { $type: 'string' } }, name: 'uniq_active_subscriber_governed_fingerprint' },
  ])).map((name) => ({ database: appDbName, collection: 'app_approvals', name })));

  createdIndexes.push(...(await appDb.collection('ocs_balance_adjustments').createIndexes([
    { key: { adjustmentId: 1 }, unique: true, name: 'uniq_ocs_balance_adjustment_id' },
    { key: { executionId: 1 }, unique: true, name: 'uniq_ocs_balance_execution_id' },
    { key: { approvalId: 1, completedAt: -1 }, name: 'ocs_balance_adjustment_approval_completed' },
    { key: { imsi: 1, claimedAt: -1 }, name: 'ocs_balance_adjustment_imsi_claimed' },
  ])).map((name) => ({ database: appDbName, collection: 'ocs_balance_adjustments', name })));

  createdIndexes.push(...(await appDb.collection('app_audit_logs').createIndexes([
    { key: { timestamp: -1 }, name: 'audit_timestamp_desc' },
    { key: { targetId: 1, timestamp: -1 }, name: 'audit_target_timestamp' },
    { key: { action: 1, timestamp: -1 }, name: 'audit_action_timestamp' },
    { key: { module: 1, timestamp: -1 }, name: 'audit_module_timestamp' },
    { key: { result: 1, timestamp: -1 }, name: 'audit_result_timestamp' },
    { key: { riskLevel: 1, timestamp: -1 }, name: 'audit_risk_timestamp' },
    { key: { actor: 1, timestamp: -1 }, name: 'audit_actor_timestamp' },
    { key: { 'actorContext.username': 1, timestamp: -1 }, name: 'audit_actor_username_timestamp' },
    { key: { 'resource.type': 1, 'resource.id': 1, timestamp: -1 }, name: 'audit_resource_timestamp' },
    { key: { 'request.requestId': 1 }, name: 'audit_request_id' },
    { key: { 'request.correlationId': 1 }, name: 'audit_request_correlation_id' },
    { key: { approvalId: 1, timestamp: -1 }, name: 'audit_approval_timestamp' },
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

async function seedRootAdminUser(appDb) {
  const users = appDb.collection('app_users');
  const existingAdmin = await users.findOne({ username: 'admin' });
  if (existingAdmin) {
    return;
  }

  const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
  if (!initialPassword) {
    console.log('[SECURITY] INITIAL_ADMIN_PASSWORD is not set. Admin bootstrap skipped.');
    return;
  }

  if (initialPassword.length < 8) {
    console.warn('[SECURITY] INITIAL_ADMIN_PASSWORD is too weak (must be at least 8 characters). Admin account NOT provisioned.');
    return;
  }

  const hash = await bcrypt.hash(initialPassword, 10);
  const now = new Date().toISOString();
  await users.updateOne(
    { username: 'admin' },
    {
      $setOnInsert: {
        username: 'admin',
        passwordHash: hash,
        role: 'root',
        status: 'active',
        createdAt: now,
        createdBy: 'system:bootstrap',
      },
    },
    { upsert: true }
  );

  maintenanceActions.push({
    database: appDbName,
    collection: 'app_users',
    action: 'bootstrap_root_admin',
    username: 'admin',
  });
}

  await seedOcsTariffPlan(xcloudDb, appDb);
  await provisionExistingOcsSubscribers(xcloudDb);
  await seedRootAdminUser(appDb);
}

ensureIndexes()
  .then(async () => {
    const report = {
      ok: true,
      command: 'mongo:init',
      databases: { xcloud: xcloudDbName, app: appDbName },
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
    console.log(`MongoDB indexes are ready for databases "${xcloudDbName}" and "${appDbName}".`);
    console.log(`Ops report written to ${outputPath}`);
  })
  .catch(async (error) => {
    const report = {
      ok: false,
      command: 'mongo:init',
      databases: { xcloud: xcloudDbName, app: appDbName },
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      indexes: createdIndexes,
      maintenanceActions,
      error: errorSummary(error),
      recommendations: [
        'Confirm MONGODB_URI, MONGODB_XCLOUD_DB, and MONGODB_APP_DB point to the intended databases.',
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
