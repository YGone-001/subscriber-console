#!/usr/bin/env node
/*
 * Read-only OCS usage pipeline diagnostic.
 *
 * Compares the per-request usage-record authority (ocs_usage_records) with the
 * live session authority (ocs_sessions). A live session population with stale
 * usage records means the charging engine is updating sessions/balances but is
 * not persisting CCR-U/CCR-T detail into the collection the business-analysis
 * page aggregates.
 *
 * Usage:
 *   node scripts/check-ocs-usage-pipeline.mjs
 *   OCS_USAGE_WINDOW_HOURS=24 node scripts/check-ocs-usage-pipeline.mjs
 */
import { MongoClient, Long } from 'mongodb';
import { loadEnv } from './lib/load-env.mjs';

loadEnv(process.cwd());

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';
const dbName = process.env.MONGODB_XCLOUD_DB || 'xcloud';
const windowHours = Number(process.env.OCS_USAGE_WINDOW_HOURS || 24);
const since = new Date(Date.now() - Math.max(1, windowHours) * 3600 * 1000);

const numberValue = (value) => (Long.isLong(value) ? value.toNumber() : Number(value ?? 0));

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

let exitCode = 0;
try {
  await client.connect();
  const db = client.db(dbName);
  const usage = db.collection('ocs_usage_records');
  const sessions = db.collection('ocs_sessions');

  const [total, latestRows, recent, activeRows, topRows] = await Promise.all([
    usage.countDocuments({}),
    usage.find({ created_at: { $exists: true } }).sort({ created_at: -1 }).limit(1).toArray(),
    usage.countDocuments({ created_at: { $gte: since } }),
    sessions.aggregate([
      { $match: { state: 'active' } },
      { $group: { _id: null, sessions: { $sum: 1 }, used: { $sum: '$used_total' } } },
    ]).toArray(),
    sessions.aggregate([
      { $match: { state: 'active' } },
      { $group: { _id: '$imsi', used: { $sum: '$used_total' } } },
      { $sort: { used: -1 } },
      { $limit: 5 },
    ]).toArray(),
  ]);

  const latest = latestRows[0]?.created_at;
  const latestIso = latest instanceof Date ? latest.toISOString() : (latest ? String(latest) : '');
  const active = activeRows[0] ?? { sessions: 0, used: 0 };
  const activeSessions = numberValue(active.sessions);
  const activeUsed = numberValue(active.used);
  const topText = topRows.length === 0
    ? ''
    : topRows.map((row) => `${row._id || '(empty)'}:${numberValue(row.used)}`).join(',');

  console.log('OCS usage pipeline check');
  console.log(`database=${dbName}`);
  console.log(`usage_records_total=${total}`);
  console.log(`usage_records_latest=${latestIso || '(none)'}`);
  console.log(`usage_records_last_${windowHours}h=${recent}`);
  console.log(`active_sessions=${activeSessions}`);
  console.log(`active_used_octets=${activeUsed}`);
  console.log(`active_top=${topText || '(none)'}`);

  if (recent === 0) {
    exitCode = 1;
    console.log('diagnosis=NO_RECENT_USAGE_RECORDS');
    if (activeSessions > 0 && activeUsed > 0) {
      console.log('hint=Live sessions carry used_total, but the charging engine is not persisting CCR-U/T detail into ocs_usage_records.');
    } else {
      console.log('hint=No live active-session usage and no recent usage records were found.');
    }
  } else {
    console.log('diagnosis=OK');
  }
} catch (error) {
  exitCode = 2;
  console.error(`OCS usage pipeline check failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close().catch(() => {});
}

process.exit(exitCode);
