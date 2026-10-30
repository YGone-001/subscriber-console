#!/usr/bin/env node
/**
 * Index-only MongoDB migration for the business collections.
 *
 * Unlike scripts/init-mongo-indexes.mjs this script never provisions OCS rows,
 * backfills balances or performs any business write. It compares the declared
 * business index spec with the live collections and, when asked, creates or
 * replaces only indexes.
 *
 * Usage:
 *   node scripts/migrate-mongo-indexes.mjs             # dry-run (default)
 *   node scripts/migrate-mongo-indexes.mjs --apply     # create missing indexes
 *   node scripts/migrate-mongo-indexes.mjs --json
 *
 * Exit codes: 0 ready/applied, 1 conflict or apply failure, 2 connection error.
 */
import { MongoClient } from 'mongodb';
import { loadEnv } from './lib/load-env.mjs';
import { BUSINESS_INDEX_SPECS } from './lib/mongo-business-indexes.mjs';

loadEnv(process.cwd());

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const jsonOutput = args.has('--json');
const replaceConflicting = args.has('--replace-conflicting');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';
const xcloudDbName = process.env.MONGODB_XCLOUD_DB || 'xcloud';
const appDbName = process.env.MONGODB_APP_DB || 'xcloud_ops';

const client = new MongoClient(uri, {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

function databaseNameFor(name) {
  if (name === 'xcloud') return xcloudDbName;
  if (name === 'xcloud_ops') return appDbName;
  throw new Error(`Unknown database alias: ${name}`);
}

function canonicalKey(key) {
  return Object.keys(key || {})
    .sort()
    .map((field) => `${field}:${key[field]}`)
    .join(',');
}

function canonicalShape(index) {
  return JSON.stringify({
    key: canonicalKey(index.key),
    unique: Boolean(index.unique),
    partialFilterExpression: index.partialFilterExpression ?? null,
    expireAfterSeconds: index.expireAfterSeconds ?? null,
    sparse: Boolean(index.sparse),
  });
}

async function listIndexesSafe(collection) {
  try {
    return await collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}

async function duplicateSample(collection, key) {
  const group = {};
  for (const field of Object.keys(key)) group[field] = `$${field}`;
  return collection
    .aggregate([
      { $group: { _id: group, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 3 },
    ])
    .toArray();
}

function printHuman(plan) {
  console.log(`${apply ? 'Index migration apply' : 'Index migration plan (dry-run)'}:`);
  for (const entry of plan) {
    const shape = `${canonicalKey(entry.key)}${entry.unique ? ' unique' : ''}`;
    console.log(`  ${entry.action.toUpperCase().padEnd(10)} ${entry.collection}.${entry.name} key=${shape}`);
    if (entry.existingName && entry.existingName !== entry.name) {
      console.log(`             existing equivalent index: ${entry.existingName}`);
    }
    if (entry.duplicates) {
      console.log(`             duplicate sample: ${JSON.stringify(entry.duplicates)}`);
    }
    if (entry.error) console.log(`             error: ${entry.error}`);
  }
}

try {
  await client.connect();
  const databases = new Map([
    ['xcloud', client.db(xcloudDbName)],
    ['xcloud_ops', client.db(appDbName)],
  ]);
  const databasesByName = new Map([
    [xcloudDbName, databases.get('xcloud')],
    [appDbName, databases.get('xcloud_ops')],
  ]);

  const plan = [];
  for (const spec of BUSINESS_INDEX_SPECS) {
    const db = databases.get(spec.database);
    const collection = db.collection(spec.collection);
    const existing = await listIndexesSafe(collection);

    for (const desired of spec.indexes) {
      const byName = existing.find((index) => index.name === desired.name);
      const byKey = existing.find(
        (index) => index.name !== '_id_' && canonicalKey(index.key) === canonicalKey(desired.key),
      );

      const entry = {
        database: databaseNameFor(spec.database),
        collection: spec.collection,
        name: desired.name,
        key: desired.key,
        unique: Boolean(desired.unique),
        action: 'create',
        existingName: byKey?.name ?? null,
        desired,
      };

      if (byName) {
        entry.action = canonicalShape(byName) === canonicalShape(desired) ? 'exists' : 'conflict';
        if (entry.action === 'conflict') {
          entry.error = 'an index with this name exists with a different shape';
        }
      } else if (byKey) {
        if (canonicalShape(byKey) === canonicalShape(desired)) {
          entry.action = replaceConflicting ? 'replace' : 'equivalent';
          entry.existingName = byKey.name;
        } else {
          entry.action = 'conflict';
          entry.error = `a different index already owns key ${canonicalKey(desired.key)} (${byKey.name})`;
        }
      }

      if (desired.unique && (entry.action === 'create' || entry.action === 'replace')) {
        const duplicates = await duplicateSample(collection, desired.key);
        if (duplicates.length > 0) {
          entry.action = 'conflict';
          entry.duplicates = duplicates;
          entry.error = 'duplicate key values exist; unique index not created';
        }
      }
      plan.push(entry);
    }
  }

  const conflicts = plan.filter((entry) => entry.action === 'conflict');
  const actions = plan.filter((entry) => ['create', 'replace'].includes(entry.action));

  if (apply && conflicts.length === 0) {
    for (const entry of actions) {
      const collection = databasesByName.get(entry.database).collection(entry.collection);
      try {
        if (entry.action === 'replace' && entry.existingName) {
          await collection.dropIndex(entry.existingName);
        }
        await collection.createIndexes([entry.desired]);
        entry.action = 'applied';
      } catch (error) {
        entry.action = 'failed';
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const failed = plan.filter((entry) => entry.action === 'failed');
  const report = {
    ok: conflicts.length === 0 && failed.length === 0,
    command: 'migrate-mongo-indexes',
    applied: apply,
    replaceConflicting,
    databases: { xcloud: xcloudDbName, app: appDbName },
    actions: plan,
    conflicts: conflicts.length,
    failures: failed.length,
  };

  if (jsonOutput) console.log(JSON.stringify(report, null, 2));
  else printHuman(plan);

  if (conflicts.length > 0) {
    console.error(`index_migration_result=CONFLICT conflicts=${conflicts.length}`);
    process.exitCode = 1;
  } else if (failed.length > 0) {
    console.error(`index_migration_result=FAILED failures=${failed.length}`);
    process.exitCode = 1;
  } else {
    console.log(`index_migration_result=${apply ? 'APPLIED' : 'READY'} actions=${actions.length}`);
  }
} catch (error) {
  console.error(`index migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  await client.close();
}
