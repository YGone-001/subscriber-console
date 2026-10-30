#!/usr/bin/env node
/**
 * Read-only capacity trigger check.
 *
 * The subscriber list, template counters and OCS lists intentionally keep their
 * current implementations until the documented scale triggers are reached. This
 * script reports the current collection sizes against those triggers; it never
 * writes, indexes or migrates anything.
 *
 * Usage:
 *   npm run check:scale
 *   node scripts/check-scale-triggers.mjs --json
 *
 * Exit codes: 0 = below warning / warning only, 1 = hard trigger reached.
 */
import { MongoClient } from 'mongodb';
import { loadEnv } from './lib/load-env.mjs';

loadEnv(process.cwd());

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has('--json');
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const xcloudDbName = process.env.MONGODB_XCLOUD_DB || 'xcloud';
const appDbName = process.env.MONGODB_APP_DB || 'xcloud_ops';

const TRIGGERS = [
  {
    key: 'subscribers',
    label: 'subscriber list fetch-all + in-memory facets',
    collection: { db: 'xcloud', name: 'subscribers' },
    warning: 10000,
    hard: 20000,
    action: 'Implement server-side aggregation and keyset pagination before growing further.',
  },
  {
    key: 'contracts',
    label: 'contract list summary aggregation',
    collection: { db: 'xcloud', name: 'ocs_subscribers' },
    warning: 100000,
    hard: 200000,
    action: 'Cache the lifecycle summary or move it to a maintained counter.',
  },
  {
    key: 'balances',
    label: 'balance list aggregation with contract lookup',
    collection: { db: 'xcloud', name: 'ocs_balances' },
    warning: 100000,
    hard: 200000,
    action: 'Review the aggregation plan and add a contract status index before scaling.',
  },
  {
    key: 'profiles',
    label: 'template list counters and bulk actions',
    collection: { db: 'xcloud_ops', name: 'app_profiles' },
    warning: 500,
    hard: 1000,
    action: 'Move bulk export/archive to a bounded server operation and materialize subscriber counts.',
  },
];

const client = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

function statusFor(value, trigger) {
  if (value >= trigger.hard) return 'triggered';
  if (value >= trigger.warning) return 'warning';
  return 'ok';
}

try {
  await client.connect();
  const databases = {
    xcloud: client.db(xcloudDbName),
    xcloud_ops: client.db(appDbName),
  };
  const results = [];
  for (const trigger of TRIGGERS) {
    const count = await databases[trigger.collection.db].collection(trigger.collection.name).countDocuments();
    results.push({
      key: trigger.key,
      label: trigger.label,
      collection: `${trigger.collection.db}.${trigger.collection.name}`,
      count,
      warning: trigger.warning,
      hard: trigger.hard,
      status: statusFor(count, trigger),
      action: trigger.action,
    });
  }

  const triggered = results.some((result) => result.status === 'triggered');
  const report = {
    ok: !triggered,
    command: 'check:scale',
    checkedAt: new Date().toISOString(),
    databases: { xcloud: xcloudDbName, app: appDbName },
    results,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Capacity triggers (read-only):');
    for (const result of results) {
      console.log(
        `  ${result.status.toUpperCase().padEnd(9)} ${result.collection.padEnd(28)} count=${String(result.count).padStart(8)} warning=${result.warning} hard=${result.hard}`,
      );
      if (result.status !== 'ok') console.log(`             -> ${result.action}`);
    }
    console.log(`\ncapacity_trigger_result=${triggered ? 'TRIGGERED' : 'OK'}`);
  }
  if (triggered) process.exitCode = 1;
} catch (error) {
  console.error(`capacity trigger check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  await client.close();
}
