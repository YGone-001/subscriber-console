import { Document } from 'mongodb';
import { getMongoDb, mongoCollections, mongoDbName } from '@/lib/mongo';

type ExpectedIndex = {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  expireAfterSeconds?: number;
};

type CollectionHealth = {
  name: string;
  exists: boolean;
  documentCount: number | null;
  missingIndexes: string[];
};

export type MongoHealthReport = {
  ok: boolean;
  database: string;
  checkedAt: string;
  latencyMs: number;
  collections: CollectionHealth[];
  missingCollections: string[];
  missingIndexes: Array<{ collection: string; index: string }>;
};

const expectedIndexes: ExpectedIndex[] = [
  { collection: 'subscribers', name: 'uniq_imsi', key: { imsi: 1 }, unique: true },
  { collection: 'subscribers', name: 'profile_name', key: { 'webui_meta.profile_name': 1 } },
  { collection: 'subscribers', name: 'ocs_plmn', key: { 'ocs.traffic.plmn': 1 } },
  { collection: 'subscribers', name: 'ocs_rating_map', key: { 'ocs.rating.rates_map': 1 } },
  { collection: 'subscribers', name: 'updated_at_desc', key: { updated_at: -1 } },
  { collection: 'app_profiles', name: 'uniq_profile_name', key: { name: 1 }, unique: true },
  { collection: 'app_profiles', name: 'profile_updated_at_desc', key: { updated_at: -1 } },
  { collection: 'app_profile_versions', name: 'profile_versions_by_profile', key: { profileName: 1, savedAt: -1 } },
  { collection: 'app_profile_versions', name: 'uniq_profile_version_id', key: { versionId: 1 }, unique: true },
  { collection: 'app_ratings', name: 'uniq_rating_group_id', key: { rating_group_id: 1 }, unique: true },
  { collection: 'app_users', name: 'uniq_username', key: { username: 1 }, unique: true },
  { collection: 'app_audit_logs', name: 'audit_timestamp_desc', key: { timestamp: -1 } },
  { collection: 'app_audit_logs', name: 'audit_target_timestamp', key: { targetId: 1, timestamp: -1 } },
  { collection: 'app_audit_logs', name: 'audit_action_timestamp', key: { action: 1, timestamp: -1 } },
  { collection: 'app_alerts', name: 'alerts_timestamp_desc', key: { timestamp: -1 } },
  { collection: 'app_alerts', name: 'alerts_active_by_level', key: { is_acknowledged: 1, level: 1, timestamp: -1 } },
  { collection: 'app_alerts', name: 'alerts_imsi_timestamp', key: { imsi: 1, timestamp: -1 } },
  { collection: 'app_rate_limits', name: 'uniq_rate_limit_key', key: { key: 1 }, unique: true },
  { collection: 'app_rate_limits', name: 'ttl_rate_limit_reset_at', key: { reset_at: 1 }, expireAfterSeconds: 0 },
  { collection: 'app_metrics', name: 'uniq_metric_key', key: { key: 1 }, unique: true },
  { collection: 'app_metrics', name: 'metrics_updated_at_desc', key: { updated_at: -1 } },
];

const expectedCollections = Object.values(mongoCollections);

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
  const db = await getMongoDb();
  await db.command({ ping: 1 });

  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name)
  );
  const missingCollections = expectedCollections.filter((name) => !existingCollections.has(name));
  const collections: CollectionHealth[] = [];
  const missingIndexes: Array<{ collection: string; index: string }> = [];

  for (const name of expectedCollections) {
    if (!existingCollections.has(name)) {
      const collectionIndexes = expectedIndexes
        .filter((index) => index.collection === name)
        .map((index) => index.name);
      collectionIndexes.forEach((index) => missingIndexes.push({ collection: name, index }));
      collections.push({ name, exists: false, documentCount: null, missingIndexes: collectionIndexes });
      continue;
    }

    const collection = db.collection(name);
    const indexes = await collection.listIndexes().toArray();
    const collectionMissingIndexes = expectedIndexes
      .filter((expected) => expected.collection === name)
      .filter((expected) => !indexMatches(indexes.find((index) => index.name === expected.name), expected))
      .map((index) => index.name);

    collectionMissingIndexes.forEach((index) => missingIndexes.push({ collection: name, index }));
    collections.push({
      name,
      exists: true,
      documentCount: await collection.estimatedDocumentCount(),
      missingIndexes: collectionMissingIndexes,
    });
  }

  return {
    ok: missingCollections.length === 0 && missingIndexes.length === 0,
    database: mongoDbName(),
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    collections,
    missingCollections,
    missingIndexes,
  };
}
