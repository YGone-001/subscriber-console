import { MongoClient } from 'mongodb';
import nextEnv from '@next/env';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/open5gs';
const args = new Set(process.argv.slice(2));
const deleteSource = args.has('--delete-source');
const dryRun = args.has('--dry-run');
const confirmArg = process.argv.find((arg) => arg.startsWith('--confirm-app-db='));
const confirmedAppDb = confirmArg?.split('=')[1];
const sourceArg = process.argv.find((arg) => arg.startsWith('--source-db='));
const confirmSourceArg = process.argv.find((arg) => arg.startsWith('--confirm-source-db='));
const confirmedSourceDb = confirmSourceArg?.split('=')[1];
const mongoUri = process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
const defaultSourceDbName = process.env.MONGODB_OPEN5GS_DB || process.env.MONGODB_DB || 'open5gs';
const sourceDbName = sourceArg?.split('=')[1] || process.env.MONGODB_APP_SOURCE_DB || defaultSourceDbName;
const appDbName = process.env.MONGODB_APP_DB || 'xcloud_ops';
const startedAt = new Date();

const appCollections = [
  'app_profiles',
  'app_profile_versions',
  'app_ratings',
  'app_users',
  'app_approvals',
  'app_audit_logs',
  'app_alerts',
  'app_rate_limits',
  'app_metrics',
];

const client = new MongoClient(mongoUri, {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

async function copyCollection(sourceDb, targetDb, collectionName) {
  const source = sourceDb.collection(collectionName);
  const target = targetDb.collection(collectionName);
  const sourceCount = await source.countDocuments({});
  const targetBeforeCount = await target.countDocuments({});

  if (dryRun) {
    return {
      collection: collectionName,
      sourceCount,
      targetBeforeCount,
      copied: 0,
      targetAfterCount: targetBeforeCount,
      sourceDropped: false,
    };
  }

  if (sourceCount === 0) {
    let sourceDropped = false;
    if (deleteSource) {
      if (confirmedSourceDb !== sourceDbName || confirmedAppDb !== appDbName) {
        throw new Error(`Refusing to delete source collections without --confirm-source-db=${sourceDbName} and --confirm-app-db=${appDbName}`);
      }
      await source.drop();
      sourceDropped = true;
    }

    return {
      collection: collectionName,
      sourceCount,
      targetBeforeCount,
      copied: 0,
      targetAfterCount: targetBeforeCount,
      sourceDropped,
    };
  }

  let copied = 0;
  const batch = [];
  const cursor = source.find({});

  async function flushBatch() {
    if (batch.length === 0) return;
    await target.bulkWrite(
      batch.map((doc) => ({
        replaceOne: {
          filter: { _id: doc._id },
          replacement: doc,
          upsert: true,
        },
      })),
      { ordered: false }
    );
    copied += batch.length;
    batch.length = 0;
  }

  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= 500) await flushBatch();
  }
  await flushBatch();

  const targetAfterCount = await target.countDocuments({});
  if (targetAfterCount < sourceCount) {
    throw new Error(
      `${collectionName} migration verification failed: source=${sourceCount}, target=${targetAfterCount}`
    );
  }

  let sourceDropped = false;
  if (deleteSource) {
    if (confirmedSourceDb !== sourceDbName || confirmedAppDb !== appDbName) {
      throw new Error(`Refusing to delete source collections without --confirm-source-db=${sourceDbName} and --confirm-app-db=${appDbName}`);
    }
    await source.drop();
    sourceDropped = true;
  }

  return {
    collection: collectionName,
    sourceCount,
    targetBeforeCount,
    copied,
    targetAfterCount,
    sourceDropped,
  };
}

async function main() {
  if (sourceDbName === appDbName) {
    throw new Error('The app collection source database must be different from MONGODB_APP_DB before migration.');
  }

  await client.connect();
  const sourceDb = client.db(sourceDbName);
  const appDb = client.db(appDbName);
  await Promise.all([sourceDb.command({ ping: 1 }), appDb.command({ ping: 1 })]);

  const existingSourceCollections = new Set(
    (await sourceDb.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name)
  );
  const collectionsToMigrate = appCollections.filter((collection) => existingSourceCollections.has(collection));
  const results = [];

  for (const collectionName of collectionsToMigrate) {
    results.push(await copyCollection(sourceDb, appDb, collectionName));
  }

  const report = {
    ok: true,
    command: 'mongo:migrate-app-db',
    dryRun,
    deleteSource,
    databases: { source: sourceDbName, target: appDbName },
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    migratedCollections: results,
    skippedCollections: appCollections.filter((collection) => !existingSourceCollections.has(collection)),
    untouchedSourceCollections: ['subscribers', 'account'],
  };
  const outputPath = await writeOpsReport('mongo-migrate-app-db', report, startedAt);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Ops report written to ${outputPath}`);
}

main()
  .catch(async (error) => {
    const report = {
      ok: false,
      command: 'mongo:migrate-app-db',
      dryRun,
      deleteSource,
      databases: { source: sourceDbName, target: appDbName },
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      error: errorSummary(error),
      recommendations: [
        'Confirm MONGODB_URI, MONGODB_DB, and MONGODB_APP_DB point to the intended databases.',
        'Run without --delete-source first if you want a copy-only verification pass.',
        `Use --delete-source --confirm-source-db=${sourceDbName} --confirm-app-db=${appDbName} only when you are ready to remove old app_* collections from the source database.`,
      ],
    };
    const outputPath = await writeOpsReport('mongo-migrate-app-db', report, startedAt);
    console.error('MongoDB app collection migration failed:', error);
    console.error(`Failure report written to ${outputPath}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close().catch(() => {});
  });
