import { MongoClient } from 'mongodb';
import nextEnv from '@next/env';
import { errorSummary, writeOpsReport } from './lib/ops-report.mjs';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/open5gs';
const DEFAULT_MONGODB_DB = 'open5gs';
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has('--json');
const allowCollscan = args.has('--allow-collscan');
const sampleImsiPrefixArg = process.argv.find((arg) => arg.startsWith('--imsi-prefix='));
const slowMsArg = process.argv.find((arg) => arg.startsWith('--slow-ms='));
const sampleImsiPrefix = sampleImsiPrefixArg?.split('=')[1] || process.env.MONGO_PERF_IMSI_PREFIX || '';
const slowMs = Number(slowMsArg?.split('=')[1] || process.env.MONGO_PERF_SLOW_MS || 250);
const mongoUri = process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
const dbName = process.env.MONGODB_OPEN5GS_DB || process.env.MONGODB_DB || DEFAULT_MONGODB_DB;
const appDbName = process.env.MONGODB_APP_DB || 'xcloud_ops';
const startedAt = new Date();

const client = new MongoClient(mongoUri, {
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

function valueAtPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function walkStages(value, stages = []) {
  if (!value || typeof value !== 'object') return stages;
  if (typeof value.stage === 'string') stages.push(value.stage);
  for (const item of Object.values(value)) {
    if (Array.isArray(item)) item.forEach((child) => walkStages(child, stages));
    else if (item && typeof item === 'object') walkStages(item, stages);
  }
  return stages;
}

function findExecutionStats(explain) {
  return explain?.executionStats
    || explain?.stages?.find((stage) => stage.$cursor)?.$cursor?.executionStats
    || explain?.queryPlanner?.winningPlan?.executionStats
    || null;
}

function findWinningPlan(explain) {
  return explain?.queryPlanner?.winningPlan
    || explain?.stages?.find((stage) => stage.$cursor)?.$cursor?.queryPlanner?.winningPlan
    || null;
}

function indexNamesFromPlan(plan) {
  const names = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.indexName === 'string') names.add(value.indexName);
    Object.values(value).forEach(walk);
  }
  walk(plan);
  return Array.from(names);
}

function summarizeExplain(explain) {
  const stats = findExecutionStats(explain);
  const plan = findWinningPlan(explain);
  const stages = Array.from(new Set(walkStages(plan || explain)));
  const indexes = indexNamesFromPlan(plan || explain);

  return {
    indexes,
    stages,
    documentsExamined: stats?.totalDocsExamined ?? valueAtPath(explain, 'executionStats.totalDocsExamined') ?? null,
    keysExamined: stats?.totalKeysExamined ?? valueAtPath(explain, 'executionStats.totalKeysExamined') ?? null,
    returned: stats?.nReturned ?? valueAtPath(explain, 'executionStats.nReturned') ?? null,
    executionTimeMs: stats?.executionTimeMillis ?? valueAtPath(explain, 'executionStats.executionTimeMillis') ?? null,
  };
}

function assess(result) {
  const stages = new Set(result.stages || []);
  const collectionScan = stages.has('COLLSCAN');
  const slow = result.durationMs > slowMs || (result.executionTimeMs !== null && result.executionTimeMs > slowMs);
  const highScan = result.documentsExamined !== null
    && result.returned !== null
    && result.returned > 0
    && result.documentsExamined > Math.max(1000, result.returned * 50);

  if (collectionScan) return 'COLLSCAN';
  if (slow) return 'SLOW';
  if (highScan) return 'HIGH_SCAN_RATIO';
  return 'OK';
}

function recommendationsFor(result) {
  if (result.status === 'OK') return [];
  if (result.status === 'COLLSCAN') {
    return [
      'Check whether this query is intentionally analytical and allowed to scan the collection.',
      'If this is user-facing, add a selective match stage or supporting index.',
      'For subscriber analytics, consider precomputed metrics when subscriber volume grows.',
    ];
  }
  if (result.status === 'SLOW') {
    return [
      'Review executionStats.executionTimeMillis and server load during the check.',
      'Confirm indexes are present with npm run mongo:init.',
      'Consider lowering returned document count or adding a more selective filter.',
    ];
  }
  if (result.status === 'HIGH_SCAN_RATIO') {
    return [
      'The query examines far more documents than it returns.',
      'Add or adjust a compound index matching the filter and sort order.',
    ];
  }
  return ['Review the query plan and add a supporting index if this is user-facing.'];
}

async function timedExplain(name, run) {
  const startedAt = Date.now();
  const explain = await run();
  const summary = summarizeExplain(explain);
  const result = {
    name,
    durationMs: Date.now() - startedAt,
    ...summary,
  };
  result.status = assess(result);
  return result;
}

async function samplePrefix(db) {
  if (sampleImsiPrefix) return sampleImsiPrefix;
  const row = await db.collection('subscribers').findOne({}, { projection: { imsi: 1 }, sort: { imsi: 1 } });
  return typeof row?.imsi === 'string' ? row.imsi.slice(0, 6) : '460020';
}

async function main() {
  await client.connect();
  const db = client.db(dbName);
  const appDb = client.db(appDbName);
  await Promise.all([db.command({ ping: 1 }), appDb.command({ ping: 1 })]);

  const prefix = await samplePrefix(db);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const checks = [
    timedExplain('subscribers.page.sort_imsi', () =>
      db.collection('subscribers')
        .find({}, { projection: { imsi: 1 } })
        .sort({ imsi: 1 })
        .limit(50)
        .explain('executionStats')
    ),
    timedExplain('subscribers.search.imsi_prefix', () =>
      db.collection('subscribers')
        .find({ imsi: { $regex: `^${prefix}` } }, { projection: { imsi: 1 } })
        .sort({ imsi: 1 })
        .limit(50)
        .explain('executionStats')
    ),
    timedExplain('subscribers.filter.profile', () =>
      db.collection('subscribers')
        .find({ 'webui_meta.profile_name': { $exists: true } }, { projection: { imsi: 1, 'webui_meta.profile_name': 1 } })
        .sort({ imsi: 1 })
        .limit(50)
        .explain('executionStats')
    ),
    timedExplain('ocs_balances.analytics.plmn_group', () =>
      db.collection('ocs_balances')
        .aggregate([
          { $project: { plmn: { $substr: ['$imsi', 0, 5] }, data_available: 1 } },
          { $group: { _id: '$plmn', count: { $sum: 1 }, totalTraffic: { $sum: '$data_available' } } },
          { $sort: { totalTraffic: -1 } },
          { $limit: 10 },
        ])
        .explain('executionStats')
    ),
    timedExplain('audit.recent.timestamp', () =>
      appDb.collection('app_audit_logs')
        .find({ timestamp: { $gte: since } })
        .sort({ timestamp: -1 })
        .limit(100)
        .explain('executionStats')
    ),
    timedExplain('audit.target.recent', () =>
      appDb.collection('app_audit_logs')
        .find({ targetId: '460020000000001' })
        .sort({ timestamp: -1 })
        .limit(50)
        .explain('executionStats')
    ),
    timedExplain('alerts.active.by_level', () =>
      appDb.collection('app_alerts')
        .find({ is_acknowledged: false, level: { $in: ['warning', 'critical'] } })
        .sort({ timestamp: -1 })
        .limit(100)
        .explain('executionStats')
    ),
    timedExplain('profiles.updated', () =>
      appDb.collection('app_profiles')
        .find({}, { projection: { name: 1, updated_at: 1 } })
        .sort({ updated_at: -1 })
        .limit(50)
        .explain('executionStats')
    ),
    timedExplain('ocs_tariff_plans.rules.by_rating_group', () =>
      db.collection('ocs_tariff_plans')
        .find({ 'rules.rating_group': { $exists: true } })
        .sort({ 'rules.rating_group': 1 })
        .limit(50)
        .explain('executionStats')
    ),
  ];

  const results = await Promise.all(checks);
  const reportOk = results.every((result) => result.status === 'OK')
    || (allowCollscan && results.every((result) => result.status === 'OK' || result.status === 'COLLSCAN'));
  const report = {
    ok: reportOk,
    command: 'mongo:perf',
    databases: { open5gs: dbName, app: appDbName },
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    slowThresholdMs: slowMs,
    allowCollscan,
    imsiPrefix: prefix,
    results: results.map((result) => ({
      ...result,
      recommendations: recommendationsFor(result),
    })),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`MongoDB query performance report for "${dbName}" and "${appDbName}"`);
    console.log(`IMSI prefix sample: ${prefix}; slow threshold: ${slowMs}ms`);
    for (const result of report.results) {
      const indexes = result.indexes.length > 0 ? result.indexes.join(',') : 'none';
      const stages = result.stages.length > 0 ? result.stages.join(',') : 'unknown';
      console.log(
        `${result.status.padEnd(15)} ${result.name.padEnd(34)} duration=${String(result.durationMs).padStart(4)}ms explain=${String(result.executionTimeMs ?? 'n/a').padStart(4)}ms docs=${String(result.documentsExamined ?? 'n/a').padStart(6)} keys=${String(result.keysExamined ?? 'n/a').padStart(6)} returned=${String(result.returned ?? 'n/a').padStart(5)} indexes=${indexes} stages=${stages}`
      );
    }
  }

  const outputPath = await writeOpsReport('mongo-perf', report, startedAt);
  console.log(`Ops report written to ${outputPath}`);

  await client.close();
  if (!report.ok && !(allowCollscan && report.results.every((result) => result.status === 'OK' || result.status === 'COLLSCAN'))) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const report = {
    ok: false,
    command: 'mongo:perf',
    databases: { open5gs: dbName, app: appDbName },
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    slowThresholdMs: slowMs,
    allowCollscan,
    error: errorSummary(error),
    recommendations: [
      'Confirm MONGODB_URI, MONGODB_DB, and MONGODB_APP_DB point to the intended databases.',
      'Run npm run mongo:init if query plans indicate missing indexes.',
      'Use -- --json when collecting machine-readable reports in automation.',
    ],
  };
  const outputPath = await writeOpsReport('mongo-perf', report, startedAt);
  console.error('MongoDB query performance check failed:', error);
  console.error(`Failure report written to ${outputPath}`);
  await client.close().catch(() => {});
  process.exitCode = 1;
});
