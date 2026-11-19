#!/usr/bin/env node
// Create only the two latest-evidence read indexes. Never run general bootstrap repairs.
import { MongoClient } from 'mongodb';
import { loadEnv } from './lib/load-env.mjs';
import { NF_HEALTH_READ_INDEX_SPECS } from './lib/nf-health-read-indexes.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply')) {
  console.error('Usage: node scripts/migrate-nf-health-read-indexes.mjs [--apply]');
  process.exit(2);
}
console.log(JSON.stringify({ indexes: NF_HEALTH_READ_INDEX_SPECS, documentWrites: false, ttlChanges: false }));
if (!args.includes('--apply')) {
  console.log('DRY_RUN: no database connection made');
} else {
  loadEnv(process.cwd());
  const database = process.env.MONGODB_APP_DB || 'xcloud_ops';
  if (database === (process.env.MONGODB_XCLOUD_DB || 'xcloud')) throw new Error('Ops and business databases must differ');
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    for (const spec of NF_HEALTH_READ_INDEX_SPECS) {
      await client.db(database).collection(spec.collection).createIndexes(spec.indexes, { maxTimeMS: 120000 });
      console.log(`READY ${database}.${spec.collection}`);
    }
    console.log('NF_HEALTH_READ_INDEXES_READY');
  } catch (error) {
    console.error(`Index creation failed (code ${error?.code || 'unavailable'}); no indexes were dropped`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
