import { Long, MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import { loadEnv } from './lib/load-env.mjs';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

loadEnv(process.cwd());

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

// listIndexesSafe returns the index list for a collection that may not exist
// yet. A missing namespace simply has no indexes.
async function listIndexesSafe(collection) {
  try {
    return await collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') {
      return [];
    }
    throw error;
  }
}

// applyPartialUniqueTargetIndexes applies the NF Health target uniqueness
// policy: a candidate-scoped and a resource-scoped partial unique index so
// absent identifiers never collide. When the initializer meets the legacy
// full candidate index, it is rebuilt only after validating that every stored
// target carries a string candidateId (the invariant the pre-phase API
// enforced). Any violation fails closed instead of silently degrading
// uniqueness or dropping documents.
async function applyPartialUniqueTargetIndexes(appDb) {
  const targets = appDb.collection('app_nf_health_targets');
  const desired = [
    {
      key: { candidateId: 1 },
      unique: true,
      partialFilterExpression: { candidateId: { $type: 'string' } },
      name: 'uniq_nf_health_target_candidate',
    },
    {
      key: { resourceId: 1 },
      unique: true,
      partialFilterExpression: { resourceId: { $type: 'string' } },
      name: 'uniq_nf_health_target_resource',
    },
  ];
  const existing = await listIndexesSafe(targets);
  for (const spec of desired) {
    const found = existing.find((index) => index.name === spec.name);
    if (!found) continue;
    const sameShape =
      JSON.stringify(found.key) === JSON.stringify(spec.key) &&
      Boolean(found.unique) === Boolean(spec.unique) &&
      JSON.stringify(found.partialFilterExpression ?? null) === JSON.stringify(spec.partialFilterExpression ?? null);
    if (sameShape) continue;
    const invalidCount = await targets.countDocuments({
      $or: [
        { candidateId: { $exists: false } },
        { candidateId: { $not: { $type: 'string' } } },
        { candidateId: '' },
      ],
    });
    if (invalidCount > 0) {
      throw new Error(
        `NF_HEALTH_TARGET_INDEX_INCOMPATIBLE: ${invalidCount} stored target(s) lack a string candidateId; ` +
          'resolve legacy target identity before applying the partial unique index policy',
      );
    }
    await targets.dropIndex(spec.name);
    maintenanceActions.push({
      database: appDbName,
      collection: 'app_nf_health_targets',
      action: 'rebuild_partial_unique_index',
      index: spec.name,
    });
  }
  createdIndexes.push(
    ...(await targets.createIndexes(desired)).map((name) => ({ database: appDbName, collection: 'app_nf_health_targets', name })),
  );
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
  let existing;
  try {
    existing = await collection.listIndexes().toArray();
  } catch (error) {
    // A fresh database has no namespace yet. createIndexes below creates it.
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return;
    throw error;
  }
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

  createdIndexes.push(...(await appDb.collection('ocs_balance_adjustments').createIndexes([
    { key: { adjustmentId: 1 }, unique: true, name: 'uniq_ocs_balance_adjustment_id' },
    { key: { executionId: 1 }, unique: true, name: 'uniq_ocs_balance_execution_id' },
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

  createdIndexes.push(...(await appDb.collection('app_inventory_resources').createIndexes([
    { key: { kind: 1, domain: 1, lifecycleState: 1, updatedAt: -1 }, name: 'inventory_kind_domain_lifecycle_updated' },
    { key: { nameNormalized: 1, updatedAt: -1 }, name: 'inventory_name_normalized_updated' },
    { key: { updatedAt: -1, _id: 1 }, name: 'inventory_updated_id' },
    {
      key: { 'source.system': 1, 'source.externalId': 1 },
      unique: true,
      partialFilterExpression: {
        'source.externalId': { $exists: true, $type: 'string', $gt: '' },
      },
      name: 'uniq_inventory_source_external_id',
    },
  ])).map((name) => ({ database: appDbName, collection: 'app_inventory_resources', name })));

  // ── xcloud_ops.app_topology_edges ──
  // Topology owns EDGES only. The partial unique index enforces at most one
  // active relationship per directed tuple while still allowing the same tuple
  // to be recreated as a new edge after retirement.
  createdIndexes.push(...(await appDb.collection('app_topology_edges').createIndexes([
    {
      key: { fromResourceId: 1, toResourceId: 1, relationshipType: 1 },
      unique: true,
      partialFilterExpression: { lifecycleState: 'active' },
      name: 'uniq_topology_active_edge',
    },
    {
      key: { fromResourceId: 1, relationshipType: 1, lifecycleState: 1, updatedAt: -1 },
      name: 'topology_from_type_state_updated',
    },
    {
      key: { toResourceId: 1, relationshipType: 1, lifecycleState: 1, updatedAt: -1 },
      name: 'topology_to_type_state_updated',
    },
    { key: { updatedAt: -1, _id: 1 }, name: 'topology_updated_id' },
  ])).map((name) => ({ database: appDbName, collection: 'app_topology_edges', name })));

  // ── xcloud_ops.app_discovery_sources ──
  // Discovery source configuration. Uniqueness is on the server-generated id.
  createdIndexes.push(...(await appDb.collection('app_discovery_sources').createIndexes([
    { key: { updatedAt: -1, _id: 1 }, name: 'discovery_sources_updated_id' },
    { key: { name: 1 }, name: 'discovery_sources_name' },
    { key: { adapterType: 1, enabled: 1 }, name: 'discovery_sources_adapter_enabled' },
  ])).map((name) => ({ database: appDbName, collection: 'app_discovery_sources', name })));

  // ── xcloud_ops.app_discovery_runs ──
  // Bounded discovery execution history. No TTL: scan evidence is retained
  // under the documented application retention policy, not silently dropped.
  createdIndexes.push(...(await appDb.collection('app_discovery_runs').createIndexes([
    { key: { sourceId: 1, startedAt: -1 }, name: 'discovery_runs_source_started' },
    { key: { status: 1, startedAt: -1 }, name: 'discovery_runs_status_started' },
    { key: { startedAt: -1, _id: 1 }, name: 'discovery_runs_started_id' },
  ])).map((name) => ({ database: appDbName, collection: 'app_discovery_runs', name })));

  // ── xcloud_ops.app_nf_observations ──
  // Candidate identity is stable across repeated successful discoveries and is
  // unique per (sourceId, externalNfInstanceId). Candidate identity is never
  // TTL-deleted.
  createdIndexes.push(...(await appDb.collection('app_nf_observations').createIndexes([
    {
      key: { sourceId: 1, externalNfInstanceId: 1 },
      unique: true,
      name: 'uniq_nf_observation_source_instance',
    },
    { key: { sourceId: 1, nfType: 1, nfStatus: 1, lastSeenAt: -1 }, name: 'nf_obs_source_type_status_seen' },
    { key: { sourceId: 1, observationState: 1, lastSeenAt: -1 }, name: 'nf_obs_source_state_seen' },
    { key: { linkedResourceId: 1 }, name: 'nf_obs_linked_resource' },
    { key: { lastSeenAt: -1, _id: 1 }, name: 'nf_obs_lastseen_id' },
  ])).map((name) => ({ database: appDbName, collection: 'app_nf_observations', name })));

  // ── xcloud_ops.app_nf_health_targets ──
  // Operator-authored monitoring configuration. Identity separation is
  // authoritative:
  //   - resourceId references the canonical Inventory resource (may be absent
  //     for legacy candidate-only targets);
  //   - candidateId references an optional Discovery observation and is never
  //     fabricated by NF Health.
  // Both unique indexes are partial so absent identifiers never collide:
  // multiple Inventory-only targets coexist without a candidateId, and
  // multiple candidate references never collide on a missing resourceId.
  await applyPartialUniqueTargetIndexes(appDb);
  createdIndexes.push(...(await appDb.collection('app_nf_health_targets').createIndexes([
    { key: { updatedAt: -1, _id: 1 }, name: 'nf_health_targets_updated_id' },
    { key: { enabled: 1, collectionMode: 1, lastAttemptAt: 1 }, name: 'nf_health_targets_schedule' },
    { key: { name: 1 }, name: 'nf_health_targets_name' },
    { key: { domain: 1, nfType: 1, updatedAt: -1 }, name: 'nf_health_targets_domain_type' },
  ])).map((name) => ({ database: appDbName, collection: 'app_nf_health_targets', name })));

  // ── xcloud_ops.app_nf_health_runs ──
  // Collection execution outcomes. No TTL: run history is retained so operators
  // can explain collection failures and configuration changes.
  createdIndexes.push(...(await appDb.collection('app_nf_health_runs').createIndexes([
    { key: { targetId: 1, startedAt: -1 }, name: 'nf_health_runs_target_started' },
    { key: { status: 1, startedAt: -1 }, name: 'nf_health_runs_status_started' },
    { key: { startedAt: -1, _id: 1 }, name: 'nf_health_runs_started_id' },
  ])).map((name) => ({ database: appDbName, collection: 'app_nf_health_runs', name })));

  // ── xcloud_ops.app_nf_health_samples ──
  // Bounded time-series measurement evidence. TTL expires samples only; target
  // identities, runs and audit records are never TTL-deleted.
  createdIndexes.push(...(await appDb.collection('app_nf_health_samples').createIndexes([
    { key: { targetId: 1, collectedAt: -1 }, name: 'nf_health_samples_target_collected' },
    { key: { collectedAt: -1, _id: 1 }, name: 'nf_health_samples_collected_id' },
    {
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
      name: 'nf_health_samples_ttl',
    },
  ])).map((name) => ({ database: appDbName, collection: 'app_nf_health_samples', name })));

  // ── xcloud_ops.app_nf_health_bindings ──
  // Bootstrap-installed local process bindings. `_id` is the canonical
  // Inventory resource id, so at most one binding exists per resource. The
  // unique bindingKey prevents two resources from claiming the same
  // (host, process identity, NF type) on one host.
  createdIndexes.push(...(await appDb.collection('app_nf_health_bindings').createIndexes([
    { key: { bindingKey: 1 }, unique: true, name: 'uniq_nf_health_binding_key' },
    { key: { hostId: 1, processName: 1 }, name: 'nf_health_bindings_host_process' },
  ])).map((name) => ({ database: appDbName, collection: 'app_nf_health_bindings', name })));

  // ── xcloud_ops.app_runtime_component_state ──
  // Bounded observation memory: one document per (host, component). It is
  // what lets a complete scan after a restart distinguish a previously
  // observed service from one that was never installed.
  createdIndexes.push(...(await appDb.collection('app_runtime_component_state').createIndexes([
    { key: { hostId: 1, componentId: 1 }, unique: true, name: 'uniq_runtime_component_state' },
  ])).map((name) => ({ database: appDbName, collection: 'app_runtime_component_state', name })));

  // ── xcloud_ops.app_nf_alert_rules ──
  // Operator-authored alert rules evaluated after each recorded NF Health
  // collection. Rules are pure observers of measurement evidence. No TTL:
  // rule history is retained under the documented retention policy.
  createdIndexes.push(...(await appDb.collection('app_nf_alert_rules').createIndexes([
    { key: { updatedAt: -1, _id: 1 }, name: 'nf_alert_rules_updated_id' },
    { key: { enabled: 1, updatedAt: -1 }, name: 'nf_alert_rules_enabled_updated' },
    { key: { targetId: 1 }, name: 'nf_alert_rules_target' },
    { key: { resourceId: 1 }, name: 'nf_alert_rules_resource' },
  ])).map((name) => ({ database: appDbName, collection: 'app_nf_alert_rules', name })));

  // ── xcloud_ops.app_nf_alerts ──
  // Alert instances produced by rule evaluation. At most one open
  // (active/acknowledged) instance exists per (ruleId, targetId); the
  // partial unique index enforces it at the storage layer. No TTL: alert
  // history is retained so operators can explain past incidents.
  createdIndexes.push(...(await appDb.collection('app_nf_alerts').createIndexes([
    {
      key: { ruleId: 1, targetId: 1 },
      unique: true,
      partialFilterExpression: { state: { $in: ['active', 'acknowledged'] } },
      name: 'uniq_nf_alert_open_instance',
    },
    { key: { state: 1, severity: 1, updatedAt: -1 }, name: 'nf_alerts_state_severity_updated' },
    { key: { targetId: 1, updatedAt: -1 }, name: 'nf_alerts_target_updated' },
    { key: { ruleId: 1, updatedAt: -1 }, name: 'nf_alerts_rule_updated' },
    { key: { updatedAt: -1, _id: 1 }, name: 'nf_alerts_updated_id' },
  ])).map((name) => ({ database: appDbName, collection: 'app_nf_alerts', name })));

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
