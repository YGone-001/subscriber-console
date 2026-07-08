import { MongoClient } from 'mongodb';
import nextEnv from '@next/env';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/open5gs';
const dbName = process.env.MONGODB_DB || 'open5gs';
const startedAt = new Date();
const createdIndexes = [];

const client = new MongoClient(uri, {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

async function ensureIndexes() {
  await client.connect();
  const db = client.db(dbName);

  createdIndexes.push(...(await db.collection('subscribers').createIndexes([
    { key: { imsi: 1 }, unique: true, name: 'uniq_imsi' },
    { key: { 'webui_meta.profile_name': 1 }, name: 'profile_name' },
    { key: { 'ocs.traffic.plmn': 1 }, name: 'ocs_plmn' },
    { key: { 'ocs.rating.rates_map': 1 }, name: 'ocs_rating_map' },
    { key: { updated_at: -1 }, name: 'updated_at_desc' },
  ])).map((name) => ({ collection: 'subscribers', name })));

  createdIndexes.push(...(await db.collection('app_profiles').createIndexes([
    { key: { name: 1 }, unique: true, name: 'uniq_profile_name' },
    { key: { updated_at: -1 }, name: 'profile_updated_at_desc' },
  ])).map((name) => ({ collection: 'app_profiles', name })));

  createdIndexes.push(...(await db.collection('app_profile_versions').createIndexes([
    { key: { profileName: 1, savedAt: -1 }, name: 'profile_versions_by_profile' },
    { key: { versionId: 1 }, unique: true, name: 'uniq_profile_version_id' },
  ])).map((name) => ({ collection: 'app_profile_versions', name })));

  createdIndexes.push(...(await db.collection('app_ratings').createIndexes([
    { key: { rating_group_id: 1 }, unique: true, name: 'uniq_rating_group_id' },
  ])).map((name) => ({ collection: 'app_ratings', name })));

  createdIndexes.push(...(await db.collection('app_users').createIndexes([
    { key: { username: 1 }, unique: true, name: 'uniq_username' },
  ])).map((name) => ({ collection: 'app_users', name })));

  createdIndexes.push(...(await db.collection('app_audit_logs').createIndexes([
    { key: { timestamp: -1 }, name: 'audit_timestamp_desc' },
    { key: { targetId: 1, timestamp: -1 }, name: 'audit_target_timestamp' },
    { key: { action: 1, timestamp: -1 }, name: 'audit_action_timestamp' },
  ])).map((name) => ({ collection: 'app_audit_logs', name })));

  createdIndexes.push(...(await db.collection('app_alerts').createIndexes([
    { key: { timestamp: -1 }, name: 'alerts_timestamp_desc' },
    { key: { is_acknowledged: 1, level: 1, timestamp: -1 }, name: 'alerts_active_by_level' },
    { key: { imsi: 1, timestamp: -1 }, name: 'alerts_imsi_timestamp' },
  ])).map((name) => ({ collection: 'app_alerts', name })));

  createdIndexes.push(...(await db.collection('app_rate_limits').createIndexes([
    { key: { key: 1 }, unique: true, name: 'uniq_rate_limit_key' },
    { key: { reset_at: 1 }, expireAfterSeconds: 0, name: 'ttl_rate_limit_reset_at' },
  ])).map((name) => ({ collection: 'app_rate_limits', name })));

  createdIndexes.push(...(await db.collection('app_metrics').createIndexes([
    { key: { key: 1 }, unique: true, name: 'uniq_metric_key' },
    { key: { updated_at: -1 }, name: 'metrics_updated_at_desc' },
  ])).map((name) => ({ collection: 'app_metrics', name })));
}

ensureIndexes()
  .then(async () => {
    const report = {
      ok: true,
      command: 'mongo:init',
      database: dbName,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      indexes: createdIndexes,
      summary: {
        collectionsTouched: new Set(createdIndexes.map((index) => index.collection)).size,
        indexesEnsured: createdIndexes.length,
      },
    };
    const outputPath = await writeOpsReport('mongo-init', report, startedAt);
    console.log(`MongoDB indexes are ready for database "${dbName}".`);
    console.log(`Ops report written to ${outputPath}`);
  })
  .catch(async (error) => {
    const report = {
      ok: false,
      command: 'mongo:init',
      database: dbName,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      indexes: createdIndexes,
      error: errorSummary(error),
      recommendations: [
        'Confirm MONGODB_URI and MONGODB_DB point to the intended database.',
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
