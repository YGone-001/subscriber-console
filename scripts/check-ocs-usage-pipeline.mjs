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
const ocsBaseUrl = (process.env.OCS_METRICS_URL || 'http://127.0.0.17:9090').replace(/\/+$/, '');

// OCS writes created_at as an ISO string, while legacy fixtures store a BSON
// Date. Always normalize before sorting or filtering; a raw sort compares BSON
// type first and can hide current string records behind old Date records.
const dateExpr = {
  $convert: { input: '$created_at', to: 'date', onError: null, onNull: null },
};

const numberValue = (value) => (Long.isLong(value) ? value.toNumber() : Number(value ?? 0));

async function fetchText(path, timeoutMs = 5000) {
  const response = await fetch(`${ocsBaseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  return { status: response.status, text };
}

async function inspectUsageForIMSI(imsi) {
  if (!imsi) return;
  try {
    const usage = await fetchText(`/usage-info?imsi=${encodeURIComponent(imsi)}`, 10000);
    let payload = null;
    try {
      payload = JSON.parse(usage.text);
    } catch {
      // Keep the status only when the endpoint is not JSON.
    }
    const records = Array.isArray(payload?.usage_info)
      ? payload.usage_info
      : Array.isArray(payload?.usage_records)
        ? payload.usage_records
        : [];
    const latestCreatedAt = records.reduce(
      (latest, record) => (record.created_at && record.created_at > latest ? record.created_at : latest),
      '',
    );
    console.log(`ocs_usage_info_imsi=${imsi} status=${usage.status} records=${records.length} latest_on_page=${latestCreatedAt || '(none)'} pager=${payload?.pager ? JSON.stringify(payload.pager) : '(none)'}`);
  } catch (error) {
    console.log(`ocs_usage_info_imsi=${imsi} status=unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function inspectOcsHttp() {
  console.log(`ocs_metrics_url=${ocsBaseUrl}`);
  try {
    const info = await fetchText('/ocs-info');
    console.log(`ocs_info_status=${info.status}`);
    console.log(`ocs_info_body=${info.text.slice(0, 300).replace(/\s+/g, ' ')}`);
  } catch (error) {
    console.log(`ocs_info_status=unavailable (${error instanceof Error ? error.message : String(error)})`);
  }

  for (const interfaceType of ['gy', 'ro']) {
    try {
      const usage = await fetchText(`/usage-info?interface_type=${interfaceType}`, 10000);
      let payload = null;
      try {
        payload = JSON.parse(usage.text);
      } catch {
        // Keep the status and a short body excerpt if the endpoint is not JSON.
      }
      const records = Array.isArray(payload?.usage_records)
        ? payload.usage_records
        : Array.isArray(payload?.usage_info)
          ? payload.usage_info
          : [];
      console.log(`ocs_usage_info_${interfaceType}_status=${usage.status}`);
      console.log(`ocs_usage_info_${interfaceType}_keys=${payload && typeof payload === 'object' ? Object.keys(payload).join(',') : '(non-json)'}`);
      console.log(`ocs_usage_info_${interfaceType}_pager=${payload?.pager ? JSON.stringify(payload.pager) : '(none)'}`);
      console.log(`ocs_usage_info_${interfaceType}_records=${records.length}`);
      if (records[0]) {
        const latestCreatedAt = records.reduce(
          (latest, record) => (record.created_at && record.created_at > latest ? record.created_at : latest),
          '',
        );
        console.log(`ocs_usage_info_${interfaceType}_latest_on_page=${latestCreatedAt || '(none)'}`);
        console.log(`ocs_usage_info_${interfaceType}_sample=${JSON.stringify(records[0]).slice(0, 800)}`);
      } else {
        console.log(`ocs_usage_info_${interfaceType}_sample=(empty)`);
      }
    } catch (error) {
      console.log(`ocs_usage_info_${interfaceType}_status=unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  try {
    const metrics = await fetchText('/metrics');
    const lines = metrics.text
      .split('\n')
      .filter((line) => /usage|ccr/i.test(line) && !line.startsWith('#'))
      .slice(0, 30);
    console.log(`ocs_metrics_status=${metrics.status}`);
    console.log(`ocs_metrics_usage_lines=${lines.length}`);
    for (const line of lines) console.log(`ocs_metric ${line}`);
  } catch (error) {
    console.log(`ocs_metrics_status=unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
}

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

let exitCode = 0;
try {
  await inspectOcsHttp();
  await client.connect();
  const db = client.db(dbName);
  const usage = db.collection('ocs_usage_records');
  const sessions = db.collection('ocs_sessions');

  const [total, latestRows, recent, createdTypes, activeRows, topRows] = await Promise.all([
    usage.countDocuments({}),
    usage.aggregate([
      { $match: { $expr: { $ne: [dateExpr, null] } } },
      { $addFields: { _usage_at: dateExpr } },
      { $sort: { _usage_at: -1 } },
      { $limit: 1 },
      { $project: { _usage_at: 1 } },
    ]).toArray(),
    usage.countDocuments({ $expr: { $gte: [dateExpr, since] } }),
    usage.aggregate([
      { $group: { _id: { $type: '$created_at' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
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

  const latest = latestRows[0]?._usage_at;
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
  console.log(`usage_records_created_at_types=${createdTypes.map((row) => `${row._id ?? 'null'}:${row.count}`).join(',') || '(none)'}`);
  console.log(`usage_records_latest=${latestIso || '(none)'}`);
  console.log(`usage_records_last_${windowHours}h=${recent}`);
  console.log(`active_sessions=${activeSessions}`);
  console.log(`active_used_octets=${activeUsed}`);
  console.log(`active_top=${topText || '(none)'}`);
  for (const row of topRows.slice(0, 3)) {
    await inspectUsageForIMSI(String(row._id ?? ''));
  }
  console.log('ocs_log_hint=grep -iE "usage|insert|error|duplicate" /usr/local/src/open5gs/install/var/log/open5gs/ocs.log | tail -50');

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
