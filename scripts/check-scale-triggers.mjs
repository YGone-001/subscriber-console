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
  {
    key: 'knowledge_entries',
    label: 'knowledge regex search + list total count',
    collection: { db: 'xcloud_ops', name: 'app_knowledge_entries' },
    warning: 4000,
    hard: 5000,
    action: 'Evaluate a text index and relevance ranking, and review list aggregation before growing further.',
  },
  {
    key: 'knowledge_versions',
    label: 'knowledge version snapshot storage',
    collection: { db: 'xcloud_ops', name: 'app_knowledge_entry_versions' },
    warning: 80000,
    hard: 100000,
    action: 'Review per-entry version retention and keep snapshot bodies out of list/detail projections.',
  },
  {
    key: 'knowledge_files',
    label: 'knowledge attachment metadata and storage',
    collection: { db: 'xcloud_ops', name: 'app_knowledge_files' },
    warning: 40000,
    hard: 50000,
    action: 'Review attachment retention, content-addressed dedupe and streaming upload before growing further.',
  },
];

const client = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

const KNOWLEDGE_SEARCH_P95_MS = 200;
const KNOWLEDGE_FILE_BYTES_WARNING = 10 * 1024 ** 3;
const KNOWLEDGE_FILE_BYTES_HARD = 20 * 1024 ** 3;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

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

  const triggeredByCount = results.some((result) => result.status === 'triggered');

  // 4B baseline: measure the read-only MongoDB query path used by knowledge
  // search. This is not end-to-end HTTP latency; it tells us whether the regex
  // path itself is approaching the documented p95 trigger.
  const entriesCollection = databases.xcloud_ops.collection('app_knowledge_entries');
  const filesCollection = databases.xcloud_ops.collection('app_knowledge_files');
  let knowledgeSearch = { samples: 0, p50ms: null, p95ms: null, maxMs: null, status: 'no_data' };
  const sample = await entriesCollection.findOne(
    { status: { $ne: 'deleted' } },
    { projection: { title: 1, tags: 1 } },
  );
  const term = sample
    ? String((Array.isArray(sample.tags) && sample.tags[0]) || sample.title || '').trim().slice(0, 8)
    : '';
  if (term) {
    const regex = new RegExp(escapeRegExp(term), 'i');
    const filter = {
      status: { $ne: 'deleted' },
      $or: [
        { title: regex },
        { phenomenon: regex },
        { rootCause: regex },
        { solution: regex },
        { tags: regex },
        { protocol: regex },
      ],
    };
    const durations = [];
    for (let index = 0; index < 10; index += 1) {
      const startedAt = performance.now();
      await entriesCollection.find(filter).sort({ updatedAt: -1 }).limit(20).toArray();
      durations.push(performance.now() - startedAt);
    }
    const p95 = percentile(durations, 0.95) ?? 0;
    knowledgeSearch = {
      samples: durations.length,
      p50ms: percentile(durations, 0.5),
      p95ms: p95,
      maxMs: Math.max(...durations),
      status: p95 >= KNOWLEDGE_SEARCH_P95_MS ? 'triggered' : p95 >= 150 ? 'warning' : 'ok',
    };
  }

  const fileStats = await filesCollection
    .aggregate([{ $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$size' } } }])
    .toArray();
  const fileCount = Number(fileStats[0]?.count ?? 0);
  const fileBytes = Number(fileStats[0]?.bytes ?? 0);
  const knowledgeFiles = {
    count: fileCount,
    bytes: fileBytes,
    status: fileBytes >= KNOWLEDGE_FILE_BYTES_HARD
      ? 'triggered'
      : fileBytes >= KNOWLEDGE_FILE_BYTES_WARNING
        ? 'warning'
        : 'ok',
  };

  const triggered = triggeredByCount
    || knowledgeSearch.status === 'triggered'
    || knowledgeFiles.status === 'triggered';
  const report = {
    ok: !triggered,
    command: 'check:scale',
    checkedAt: new Date().toISOString(),
    databases: { xcloud: xcloudDbName, app: appDbName },
    results,
    knowledgeSearch,
    knowledgeFiles,
    thresholds: {
      searchP95Ms: KNOWLEDGE_SEARCH_P95_MS,
      fileBytesWarning: KNOWLEDGE_FILE_BYTES_WARNING,
      fileBytesHard: KNOWLEDGE_FILE_BYTES_HARD,
    },
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
    const ms = (value) => (value === null ? 'n/a' : `${value.toFixed(1)}ms`);
    console.log('\nKnowledge baseline (read-only):');
    console.log(`  search samples=${knowledgeSearch.samples} p50=${ms(knowledgeSearch.p50ms)} p95=${ms(knowledgeSearch.p95ms)} max=${ms(knowledgeSearch.maxMs)} status=${knowledgeSearch.status}`);
    console.log(`  files count=${knowledgeFiles.count} bytes=${knowledgeFiles.bytes} status=${knowledgeFiles.status}`);
    console.log(`  thresholds search_p95=${KNOWLEDGE_SEARCH_P95_MS}ms file_bytes_warning=${KNOWLEDGE_FILE_BYTES_WARNING} file_bytes_hard=${KNOWLEDGE_FILE_BYTES_HARD}`);
    console.log(`\ncapacity_trigger_result=${triggered ? 'TRIGGERED' : 'OK'}`);
  }
  if (triggered) process.exitCode = 1;
} catch (error) {
  console.error(`capacity trigger check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  await client.close();
}
