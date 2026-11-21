#!/usr/bin/env node
// Create only metric aggregate indexes. Never run general bootstrap repairs.
import { MongoClient } from 'mongodb';
import { loadEnv } from './lib/load-env.mjs';
import { NF_METRIC_AGGREGATE_INDEX_SPECS, NF_METRIC_AGGREGATE_SUPERSEDED_INDEXES } from './lib/nf-metric-aggregate-indexes.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply')) {
  console.error('Usage: node scripts/migrate-nf-metric-aggregate-indexes.mjs [--apply]');
  process.exit(2);
}
console.log(JSON.stringify({ indexes: NF_METRIC_AGGREGATE_INDEX_SPECS, droppedIndexes: NF_METRIC_AGGREGATE_SUPERSEDED_INDEXES, documentWrites: false, ttlChanges: false }));
if (!args.includes('--apply')) {
  console.log('DRY_RUN: no database connection made');
} else {
  loadEnv(process.cwd());
  const database = process.env.MONGODB_APP_DB || 'xcloud_ops';
  if (database === (process.env.MONGODB_XCLOUD_DB || 'xcloud')) throw new Error('Ops and business databases must differ');
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    for (const spec of NF_METRIC_AGGREGATE_INDEX_SPECS) {
      await client.db(database).collection(spec.collection).createIndexes(spec.indexes, { maxTimeMS: 120000 });
      console.log(`READY ${database}.${spec.collection}`);
    }
    // Drop only the named superseded index, and only once its replacement
    // exists: daily documents legitimately share a UTC midnight with an hourly
    // bucket, so the old unique key would reject them.
    for (const drop of NF_METRIC_AGGREGATE_SUPERSEDED_INDEXES) {
      const names = (await client.db(database).collection(drop.collection).indexes()).map(index => index.name);
      if (!names.includes(drop.replacedBy)) {
        console.log(`SKIP ${drop.name}: replacement ${drop.replacedBy} missing`);
        continue;
      }
      if (!names.includes(drop.name)) {
        console.log(`ABSENT ${drop.name}`);
        continue;
      }
      await client.db(database).collection(drop.collection).dropIndex(drop.name);
      console.log(`DROPPED ${database}.${drop.collection}.${drop.name}`);
    }
    console.log('NF_METRIC_AGGREGATE_INDEXES_READY');
  } catch (error) {
    console.error(`Index creation failed (code ${error?.code || 'unavailable'}); no other indexes were dropped`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
