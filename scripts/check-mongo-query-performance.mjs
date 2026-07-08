import { MongoClient } from 'mongodb';
import nextEnv from '@next/env';

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
const dbName = process.env.MONGODB_DB || DEFAULT_MONGODB_DB;

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
  await db.command({ ping: 1 });

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
    timedExplain('subscribers.analytics.plmn_group', () =>
      db.collection('subscribers')
        .aggregate([
          { $group: { _id: '$ocs.traffic.plmn', count: { $sum: 1 }, totalTraffic: { $sum: '$ocs.traffic.traffic_total' } } },
          { $sort: { totalTraffic: -1 } },
          { $limit: 10 },
        ])
        .explain('executionStats')
    ),
    timedExplain('audit.recent.timestamp', () =>
      db.collection('app_audit_logs')
        .find({ timestamp: { $gte: since } })
        .sort({ timestamp: -1 })
        .limit(100)
        .explain('executionStats')
    ),
    timedExplain('audit.target.recent', () =>
      db.collection('app_audit_logs')
        .find({ targetId: '460020000000001' })
        .sort({ timestamp: -1 })
        .limit(50)
        .explain('executionStats')
    ),
    timedExplain('alerts.active.by_level', () =>
      db.collection('app_alerts')
        .find({ is_acknowledged: false, level: { $in: ['warning', 'critical'] } })
        .sort({ timestamp: -1 })
        .limit(100)
        .explain('executionStats')
    ),
    timedExplain('profiles.updated', () =>
      db.collection('app_profiles')
        .find({}, { projection: { name: 1, updated_at: 1 } })
        .sort({ updated_at: -1 })
        .limit(50)
        .explain('executionStats')
    ),
    timedExplain('ratings.by_id', () =>
      db.collection('app_ratings')
        .find({})
        .sort({ rating_group_id: 1 })
        .limit(50)
        .explain('executionStats')
    ),
  ];

  const results = await Promise.all(checks);
  const report = {
    ok: results.every((result) => result.status === 'OK'),
    database: dbName,
    checkedAt: new Date().toISOString(),
    slowThresholdMs: slowMs,
    imsiPrefix: prefix,
    results,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`MongoDB query performance report for "${dbName}"`);
    console.log(`IMSI prefix sample: ${prefix}; slow threshold: ${slowMs}ms`);
    for (const result of results) {
      const indexes = result.indexes.length > 0 ? result.indexes.join(',') : 'none';
      const stages = result.stages.length > 0 ? result.stages.join(',') : 'unknown';
      console.log(
        `${result.status.padEnd(15)} ${result.name.padEnd(34)} duration=${String(result.durationMs).padStart(4)}ms explain=${String(result.executionTimeMs ?? 'n/a').padStart(4)}ms docs=${String(result.documentsExamined ?? 'n/a').padStart(6)} keys=${String(result.keysExamined ?? 'n/a').padStart(6)} returned=${String(result.returned ?? 'n/a').padStart(5)} indexes=${indexes} stages=${stages}`
      );
    }
  }

  await client.close();
  if (!report.ok && !(allowCollscan && results.every((result) => result.status === 'OK' || result.status === 'COLLSCAN'))) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error('MongoDB query performance check failed:', error);
  await client.close().catch(() => {});
  process.exitCode = 1;
});
