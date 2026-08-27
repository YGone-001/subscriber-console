import { Document } from 'mongodb';
import { getAppDb, getOpen5gsDb, mongoCollections, mongoDbNames } from '@/lib/mongo';

type DatabaseRole = 'open5gs' | 'app';

type ExpectedIndex = {
  database: DatabaseRole;
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  expireAfterSeconds?: number;
};

type CollectionHealth = {
  database: string;
  name: string;
  exists: boolean;
  documentCount: number | null;
  missingIndexes: string[];
};

export type MongoHealthReport = {
  ok: boolean;
  database: string;
  databases: {
    open5gs: string;
    app: string;
  };
  checkedAt: string;
  latencyMs: number;
  collections: CollectionHealth[];
  missingCollections: string[];
  missingIndexes: Array<{ collection: string; index: string }>;
};

const expectedIndexes: ExpectedIndex[] = [
  { database: 'open5gs', collection: 'subscribers', name: 'uniq_imsi', key: { imsi: 1 }, unique: true },
  { database: 'open5gs', collection: 'ocs_tariff_plans', name: 'uniq_plan_id', key: { plan_id: 1 }, unique: true },
  { database: 'open5gs', collection: 'ocs_tariff_plans', name: 'rules_rating_group', key: { 'rules.rating_group': 1 } },
  { database: 'open5gs', collection: 'ocs_subscribers', name: 'uniq_ocs_subscriber_imsi', key: { imsi: 1 }, unique: true },
  { database: 'open5gs', collection: 'ocs_subscribers', name: 'ocs_subscriber_plan_id', key: { plan_id: 1 } },
  { database: 'open5gs', collection: 'ocs_balances', name: 'uniq_ocs_balance_imsi', key: { imsi: 1 }, unique: true },
  { database: 'open5gs', collection: 'ocs_balances', name: 'ocs_balance_updated_at_desc', key: { updated_at: -1 } },
  { database: 'app', collection: 'app_profiles', name: 'uniq_profile_name', key: { name: 1 }, unique: true },
  { database: 'app', collection: 'app_profiles', name: 'profile_updated_at_desc', key: { updated_at: -1 } },
  { database: 'app', collection: 'app_profile_versions', name: 'profile_versions_by_profile', key: { profileName: 1, savedAt: -1 } },
  { database: 'app', collection: 'app_profile_versions', name: 'uniq_profile_version_id', key: { versionId: 1 }, unique: true },
  { database: 'app', collection: 'app_users', name: 'uniq_username', key: { username: 1 }, unique: true },
  { database: 'app', collection: 'app_approvals', name: 'approvals_status_created', key: { status: 1, createdAt: -1 } },
  { database: 'app', collection: 'app_approvals', name: 'uniq_approval_id', key: { id: 1 }, unique: true },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_timestamp_desc', key: { timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_target_timestamp', key: { targetId: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_action_timestamp', key: { action: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_module_timestamp', key: { module: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_result_timestamp', key: { result: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_risk_timestamp', key: { riskLevel: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_actor_timestamp', key: { actor: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_actor_username_timestamp', key: { 'actorContext.username': 1, timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_resource_timestamp', key: { 'resource.type': 1, 'resource.id': 1, timestamp: -1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_request_id', key: { 'request.requestId': 1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_request_correlation_id', key: { 'request.correlationId': 1 } },
  { database: 'app', collection: 'app_audit_logs', name: 'audit_approval_timestamp', key: { approvalId: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_alerts', name: 'alerts_timestamp_desc', key: { timestamp: -1 } },
  { database: 'app', collection: 'app_alerts', name: 'alerts_active_by_level', key: { is_acknowledged: 1, level: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_alerts', name: 'alerts_imsi_timestamp', key: { imsi: 1, timestamp: -1 } },
  { database: 'app', collection: 'app_rate_limits', name: 'uniq_rate_limit_key', key: { key: 1 }, unique: true },
  { database: 'app', collection: 'app_rate_limits', name: 'ttl_rate_limit_reset_at', key: { reset_at: 1 }, expireAfterSeconds: 0 },
  { database: 'app', collection: 'app_metrics', name: 'uniq_metric_key', key: { key: 1 }, unique: true },
  { database: 'app', collection: 'app_metrics', name: 'metrics_updated_at_desc', key: { updated_at: -1 } },
];

const expectedCollections: Array<{ database: DatabaseRole; collection: string }> = [
  { database: 'open5gs', collection: mongoCollections.subscribers },
  { database: 'open5gs', collection: mongoCollections.ocsTariffPlans },
  { database: 'open5gs', collection: mongoCollections.ocsSubscribers },
  { database: 'open5gs', collection: mongoCollections.ocsBalances },
  { database: 'app', collection: mongoCollections.profiles },
  { database: 'app', collection: mongoCollections.profileVersions },
  { database: 'app', collection: mongoCollections.users },
  { database: 'app', collection: mongoCollections.approvals },
  { database: 'app', collection: mongoCollections.auditLogs },
  { database: 'app', collection: mongoCollections.alerts },
  { database: 'app', collection: mongoCollections.rateLimits },
  { database: 'app', collection: mongoCollections.metrics },
];

function sameKey(actual: Document | undefined, expected: Record<string, 1 | -1>): boolean {
  return JSON.stringify(actual || {}) === JSON.stringify(expected);
}

function indexMatches(actual: Document | undefined, expected: ExpectedIndex): boolean {
  if (!actual) return false;
  if (!sameKey(actual.key, expected.key)) return false;
  if (expected.unique !== undefined && Boolean(actual.unique) !== expected.unique) return false;
  if (expected.expireAfterSeconds !== undefined && actual.expireAfterSeconds !== expected.expireAfterSeconds) return false;
  return true;
}

export async function getMongoHealthReport(): Promise<MongoHealthReport> {
  const startedAt = Date.now();
  const [open5gsDb, appDb] = await Promise.all([getOpen5gsDb(), getAppDb()]);
  await Promise.all([open5gsDb.command({ ping: 1 }), appDb.command({ ping: 1 })]);
  const databases = mongoDbNames();
  const dbByRole = {
    open5gs: open5gsDb,
    app: appDb,
  };

  const existingCollectionsByRole = {
    open5gs: new Set(
      (await open5gsDb.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name)
    ),
    app: new Set(
      (await appDb.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name)
    ),
  };
  const missingCollections = expectedCollections
    .filter(({ database, collection }) => !existingCollectionsByRole[database].has(collection))
    .map(({ database, collection }) => `${databases[database]}.${collection}`);
  const collections: CollectionHealth[] = [];
  const missingIndexes: Array<{ collection: string; index: string }> = [];

  for (const { database, collection: name } of expectedCollections) {
    const db = dbByRole[database];
    const displayName = `${databases[database]}.${name}`;

    if (!existingCollectionsByRole[database].has(name)) {
      const collectionIndexes = expectedIndexes
        .filter((index) => index.database === database && index.collection === name)
        .map((index) => index.name);
      collectionIndexes.forEach((index) => missingIndexes.push({ collection: displayName, index }));
      collections.push({ database: databases[database], name, exists: false, documentCount: null, missingIndexes: collectionIndexes });
      continue;
    }

    const collection = db.collection(name);
    const indexes = await collection.listIndexes().toArray();
    const collectionMissingIndexes = expectedIndexes
      .filter((expected) => expected.database === database && expected.collection === name)
      .filter((expected) => !indexMatches(indexes.find((index) => index.name === expected.name), expected))
      .map((index) => index.name);

    collectionMissingIndexes.forEach((index) => missingIndexes.push({ collection: displayName, index }));
    collections.push({
      database: databases[database],
      name,
      exists: true,
      documentCount: await collection.estimatedDocumentCount(),
      missingIndexes: collectionMissingIndexes,
    });
  }

  return {
    ok: missingCollections.length === 0 && missingIndexes.length === 0,
    database: `${databases.open5gs} / ${databases.app}`,
    databases,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    collections,
    missingCollections,
    missingIndexes,
  };
}
