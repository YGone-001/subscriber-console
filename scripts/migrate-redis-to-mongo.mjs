import net from 'node:net';
import { MongoClient, ObjectId, Long } from 'mongodb';
import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379/0';
const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/open5gs';
const DEFAULT_MONGODB_DB = 'open5gs';
const DEFAULT_PLMN = '45400';
const ZERO_128 = '00000000000000000000000000000000';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const overwrite = args.has('--overwrite');
const skipLogs = args.has('--skip-logs');

function parseRedisUrl(rawUrl) {
  const url = new URL(rawUrl || process.env.REDIS_URL || DEFAULT_REDIS_URL);
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.replace('/', '') || 0),
  };
}

function encodeCommand(argsForCommand) {
  return `*${argsForCommand.length}\r\n${argsForCommand
    .map((arg) => {
      const value = String(arg);
      return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
    })
    .join('')}`;
}

function parseLine(buffer, offset) {
  const end = buffer.indexOf('\r\n', offset);
  if (end === -1) return null;
  return { line: buffer.toString('utf8', offset, end), next: end + 2 };
}

function parseReply(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const marker = String.fromCharCode(buffer[offset]);
  const line = parseLine(buffer, offset + 1);
  if (!line) return null;

  if (marker === '+') return { value: line.line, next: line.next };
  if (marker === '-') throw new Error(`Redis error: ${line.line}`);
  if (marker === ':') return { value: Number(line.line), next: line.next };

  if (marker === '$') {
    const length = Number(line.line);
    if (length === -1) return { value: null, next: line.next };
    const end = line.next + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.toString('utf8', line.next, end), next: end + 2 };
  }

  if (marker === '*') {
    const length = Number(line.line);
    if (length === -1) return { value: null, next: line.next };
    const values = [];
    let cursor = line.next;
    for (let index = 0; index < length; index++) {
      const item = parseReply(buffer, cursor);
      if (!item) return null;
      values.push(item.value);
      cursor = item.next;
    }
    return { value: values, next: cursor };
  }

  throw new Error(`Unsupported Redis reply marker: ${marker}`);
}

class RedisRespClient {
  constructor(options) {
    this.options = options;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.options.host, port: this.options.port }, async () => {
        try {
          if (this.options.password) await this.command('AUTH', this.options.password);
          if (this.options.db) await this.command('SELECT', this.options.db);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      this.socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.flush();
      });
      this.socket.on('error', reject);
    });
  }

  command(...commandArgs) {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encodeCommand(commandArgs));
      this.flush();
    });
  }

  flush() {
    while (this.pending.length > 0) {
      let parsed;
      try {
        parsed = parseReply(this.buffer);
      } catch (error) {
        const pending = this.pending.shift();
        pending?.reject(error);
        continue;
      }
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.next);
      const pending = this.pending.shift();
      pending?.resolve(parsed.value);
    }
  }

  close() {
    this.socket?.end();
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeAmbr(value, fallback = defaultAmbr()) {
  const ambr = asRecord(value);
  const downlink = asRecord(ambr.downlink);
  const uplink = asRecord(ambr.uplink);
  return {
    downlink: {
      value: asNumber(downlink.value, fallback.downlink.value),
      unit: asNumber(downlink.unit, fallback.downlink.unit),
    },
    uplink: {
      value: asNumber(uplink.value, fallback.uplink.value),
      unit: asNumber(uplink.unit, fallback.uplink.unit),
    },
  };
}

function defaultAmbr() {
  return {
    downlink: { value: 1, unit: 3 },
    uplink: { value: 1, unit: 3 },
  };
}

function toOpen5gsArp(value, fallbackPriorityLevel) {
  const arp = asRecord(value);
  const preemptCap = asString(arp.preemptCap ?? arp.pre_emption_capability, '');
  const preemptVuln = asString(arp.preemptVuln ?? arp.pre_emption_vulnerability, '');
  return {
    priority_level: asNumber(arp.priorityLevel ?? arp.arpPriority ?? arp.priority_level, fallbackPriorityLevel),
    pre_emption_capability: preemptCap === 'PREEMPT' || preemptCap === '0' ? 0 : 1,
    pre_emption_vulnerability: preemptVuln === 'PREEMPTABLE' || preemptVuln === '0' ? 0 : 2,
  };
}

function toOpen5gsQos(value, fallbackIndex, fallbackPriorityLevel) {
  const qos = asRecord(value);
  return {
    index: asNumber(qos._5qi ?? qos.index, fallbackIndex),
    arp: toOpen5gsArp(qos.arp, fallbackPriorityLevel),
  };
}

function toOpen5gsPccRule(rule) {
  const source = asRecord(rule);
  const qos = source.qos ? asRecord(source.qos) : null;
  return {
    flow: asArray(source.flow).map((flow) => {
      const item = asRecord(flow);
      return {
        direction: asNumber(item.direction, 1),
        description: asString(item.description),
      };
    }),
    qos: qos
      ? {
          index: asNumber(qos._5qi ?? qos.index, 9),
          arp: toOpen5gsArp(qos.arp, 8),
          mbr: qos.mbr ? normalizeAmbr(qos.mbr) : undefined,
          gbr: qos.gbr ? normalizeAmbr(qos.gbr) : undefined,
        }
      : undefined,
  };
}

function toOpen5gsSession(session, index) {
  const source = asRecord(session);
  const name = asString(source.name, index === 0 ? 'internet' : 'ims');
  const isIms = name === 'ims';
  const output = {
    _id: new ObjectId(),
    name,
    type: asNumber(source.type, isIms ? 3 : 1),
    qos: toOpen5gsQos(source.qos, isIms ? 5 : 9, isIms ? 1 : 8),
    ambr: normalizeAmbr(source.ambr),
    pcc_rule: asArray(source.pcc_rule).map(toOpen5gsPccRule),
    lbo_roaming_allowed: Boolean(source.lbo_roaming_allowed),
  };
  const smfIpv4 = asString(source.pgwIpv4 ?? asRecord(source.smf).ipv4, '');
  const smfIpv6 = asString(source.pgwIpv6 ?? asRecord(source.smf).ipv6, '');
  if (smfIpv4 || smfIpv6) {
    output.smf = {};
    if (smfIpv4) output.smf.ipv4 = smfIpv4;
    if (smfIpv6) output.smf.ipv6 = smfIpv6;
  }
  return output;
}

function toOpen5gsSlice(slice) {
  const source = asRecord(slice);
  const sessions = asArray(source.session_list ?? source.session);
  return {
    _id: new ObjectId(),
    sst: asNumber(source.sst, 1),
    sd: asString(source.sd, '000001'),
    default_indicator: source.default_indicator !== undefined ? Boolean(source.default_indicator) : true,
    session: sessions.length > 0
      ? sessions.map(toOpen5gsSession)
      : [toOpen5gsSession({ name: 'internet', type: 3 }, 0)],
  };
}

function toOpen5gsSecurity(auth4G) {
  const auth = asRecord(auth4G);
  const op = auth.op !== undefined ? asString(auth.op) : null;
  const opc = auth.opc !== undefined ? asString(auth.opc) : ZERO_128;
  return {
    k: asString(auth.k, ZERO_128),
    op: op || null,
    opc: opc || null,
    amf: asString(auth.amf, '8000'),
    sqn: Long.fromNumber(asNumber(auth.sqn, 1)),
  };
}

function defaultOcs(imsi) {
  return {
    traffic: {
      traffic_total: 0,
      traffic_balance: 0,
      imsi,
      plmn: DEFAULT_PLMN,
    },
    imsi: {
      account_id: imsi,
      imsi,
      withhold: 0,
      withholding_residue: 0,
      withholding_time: 3600,
    },
    account: {
      account_id: imsi,
      balance: '0',
      currency: 'USD',
    },
    rating: {
      rates_map: {},
      imsi,
    },
  };
}

function buildSubscriberDocument(imsi, legacy) {
  const sub4G = asRecord(legacy.sub4G);
  const now = new Date();
  const defaults = defaultOcs(imsi);
  const ocsTraffic = asRecord(legacy.ocsTraffic);
  const ocsImsi = asRecord(legacy.ocsImsi);
  const ocsAccount = asRecord(legacy.ocsAccount);
  const ocsRating = asRecord(legacy.ocsImsiSet);

  return {
    __v: 0,
    schema_version: 1,
    imsi,
    msisdn: asArray(sub4G.msisdnList).map((item) => asString(asRecord(item).msisdn)).filter(Boolean),
    imeisv: [],
    mme_host: [],
    mm_realm: [],
    purge_flag: [],
    security: toOpen5gsSecurity(legacy.auth4G),
    ambr: normalizeAmbr(sub4G.ambr),
    slice: asArray(sub4G.sliceList).map(toOpen5gsSlice),
    access_restriction_data: asNumber(sub4G.access_restriction_data, 32),
    subscriber_status: 0,
    operator_determined_barring: 0,
    network_access_mode: asNumber(sub4G.network_access_mode, 0),
    subscribed_rau_tau_timer: 12,
    ocs: {
      traffic: { ...defaults.traffic, ...ocsTraffic, imsi },
      imsi: {
        ...defaults.imsi,
        ...ocsImsi,
        imsi,
        account_id: asString(ocsImsi.account_id, imsi),
      },
      account: {
        ...defaults.account,
        ...ocsAccount,
        account_id: asString(ocsAccount.account_id, imsi),
      },
      rating: { ...defaults.rating, ...ocsRating, imsi },
    },
    webui_meta: {
      profile_name: asString(sub4G.profile_name),
      created_at: now,
      updated_at: now,
    },
    created_at: now,
    updated_at: now,
  };
}

async function scanAll(redis, pattern) {
  let cursor = '0';
  const keys = [];
  do {
    const reply = await redis.command('SCAN', cursor, 'MATCH', pattern, 'COUNT', '1000');
    cursor = String(reply[0]);
    keys.push(...reply[1]);
  } while (cursor !== '0');
  return keys;
}

async function getManyJson(redis, keys) {
  const out = new Map();
  for (let index = 0; index < keys.length; index += 200) {
    const chunk = keys.slice(index, index + 200);
    if (chunk.length === 0) continue;
    const values = await redis.command('MGET', ...chunk);
    chunk.forEach((key, valueIndex) => out.set(key, parseJson(values[valueIndex])));
  }
  return out;
}

async function migrateSubscribers(redis, db) {
  const subKeys = await scanAll(redis, 'SUB_4G:*');
  const trafficKeys = await scanAll(redis, 'OCS:TRAFFIC:TRAFFIC_*');
  const imsis = new Set([
    ...subKeys.map((key) => key.slice('SUB_4G:'.length)),
    ...trafficKeys.map((key) => key.slice('OCS:TRAFFIC:TRAFFIC_'.length)),
  ]);
  const validImsis = Array.from(imsis).filter((imsi) => /^\d{15}$/.test(imsi));
  const keys = validImsis.flatMap((imsi) => [
    `SUB_4G:${imsi}`,
    `AUTH_4G:${imsi}`,
    `OCS:TRAFFIC:TRAFFIC_${imsi}`,
    `OCS:IMSI:IMSI_${imsi}`,
    `OCS:ACCOUNT:ACCOUNT_${imsi}`,
    `OCS:IMSI:IMSI_SET_${imsi}`,
  ]);
  const values = await getManyJson(redis, keys);
  const subscribers = db.collection('subscribers');
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const imsi of validImsis) {
    const doc = buildSubscriberDocument(imsi, {
      sub4G: values.get(`SUB_4G:${imsi}`),
      auth4G: values.get(`AUTH_4G:${imsi}`),
      ocsTraffic: values.get(`OCS:TRAFFIC:TRAFFIC_${imsi}`),
      ocsImsi: values.get(`OCS:IMSI:IMSI_${imsi}`),
      ocsAccount: values.get(`OCS:ACCOUNT:ACCOUNT_${imsi}`),
      ocsImsiSet: values.get(`OCS:IMSI:IMSI_SET_${imsi}`),
    });

    if (dryRun) {
      inserted++;
      continue;
    }

    const result = overwrite
      ? await subscribers.replaceOne({ imsi }, doc, { upsert: true })
      : await subscribers.updateOne({ imsi }, { $setOnInsert: doc }, { upsert: true });

    if (result.upsertedCount > 0) inserted++;
    else if (overwrite && result.matchedCount > 0) updated++;
    else skipped++;
  }

  return { inserted, updated, skipped, total: validImsis.length };
}

async function migrateProfiles(redis, db) {
  const keys = await scanAll(redis, 'PROFILE:*');
  const values = await getManyJson(redis, keys);
  const collection = db.collection('app_profiles');
  let count = 0;

  for (const key of keys) {
    const name = key.slice('PROFILE:'.length);
    const profile = values.get(key);
    if (!profile || name.startsWith('VERSION:')) continue;
    const doc = { ...profile, name };
    if (!dryRun) {
      await collection.updateOne({ name }, overwrite ? { $set: doc } : { $setOnInsert: doc }, { upsert: true });
    }
    count++;
  }

  return { total: count };
}

async function migrateProfileVersions(redis, db) {
  const keys = await scanAll(redis, 'PROFILE_VERSION:*');
  const collection = db.collection('app_profile_versions');
  let count = 0;

  for (const key of keys) {
    const profileName = key.slice('PROFILE_VERSION:'.length);
    const rawVersions = await redis.command('LRANGE', key, '0', '-1');
    for (const raw of rawVersions) {
      const parsed = parseJson(raw);
      if (!parsed?.versionId) continue;
      const doc = {
        ...parsed,
        profileName: parsed.profileName || profileName,
      };
      if (!dryRun) {
        await collection.updateOne(
          { versionId: doc.versionId },
          overwrite ? { $set: doc } : { $setOnInsert: doc },
          { upsert: true }
        );
      }
      count++;
    }
  }

  return { total: count };
}

async function migrateRatings(redis, db) {
  const keys = await scanAll(redis, 'OCS:RATES:RATES_*');
  const values = await getManyJson(redis, keys);
  const collection = db.collection('app_ratings');
  let count = 0;

  for (const key of keys) {
    const id = Number(key.slice('OCS:RATES:RATES_'.length));
    const rating = values.get(key);
    if (!Number.isFinite(id) || !rating) continue;
    const doc = {
      currency: asString(rating.currency, 'USD'),
      rates: String(rating.rates ?? '0'),
      rates_type: asNumber(rating.rates_type, 1),
      rating_group_id: id,
    };
    if (!dryRun) {
      await collection.updateOne(
        { rating_group_id: id },
        overwrite ? { $set: doc } : { $setOnInsert: doc },
        { upsert: true }
      );
    }
    count++;
  }

  return { total: count };
}

async function migrateUsers(redis, db) {
  const keys = await scanAll(redis, 'SYS_USER:*');
  const values = await getManyJson(redis, keys);
  const collection = db.collection('app_users');
  let count = 0;

  for (const key of keys) {
    const username = key.slice('SYS_USER:'.length);
    const user = values.get(key);
    if (!user) continue;
    const doc = { ...user, username };
    if (!dryRun) {
      await collection.updateOne(
        { username },
        overwrite ? { $set: doc } : { $setOnInsert: doc },
        { upsert: true }
      );
    }
    count++;
  }

  return { total: count };
}

async function migrateList(redis, db, key, collectionName) {
  const rawItems = await redis.command('LRANGE', key, '0', '-1');
  const collection = db.collection(collectionName);
  let count = 0;

  for (const raw of rawItems) {
    const doc = parseJson(raw);
    if (!doc?.id) continue;
    if (!dryRun) {
      await collection.updateOne(
        { id: doc.id },
        overwrite ? { $set: doc } : { $setOnInsert: doc },
        { upsert: true }
      );
    }
    count++;
  }

  return { total: count };
}

async function main() {
  const redisOptions = parseRedisUrl(process.env.REDIS_URL);
  const mongoUri = process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
  const mongoDbName = process.env.MONGODB_DB || DEFAULT_MONGODB_DB;
  const redis = new RedisRespClient(redisOptions);
  const mongo = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
  });

  console.log(`Connecting to source Redis at ${redisOptions.host}:${redisOptions.port}/${redisOptions.db}...`);
  await redis.connect();
  console.log(`Connecting to target MongoDB database "${mongoDbName}"...`);
  await mongo.connect();

  try {
    const db = mongo.db(mongoDbName);
    const results = {
      subscribers: await migrateSubscribers(redis, db),
      profiles: await migrateProfiles(redis, db),
      profileVersions: await migrateProfileVersions(redis, db),
      ratings: await migrateRatings(redis, db),
      users: await migrateUsers(redis, db),
    };

    if (!skipLogs) {
      results.auditLogs = await migrateList(redis, db, 'LOG:AUDIT', 'app_audit_logs');
      results.alerts = await migrateList(redis, db, 'LOG:ALERTS:LOCAL', 'app_alerts');
    }

    console.log(JSON.stringify({ dryRun, overwrite, skipLogs, results }, null, 2));
  } finally {
    redis.close();
    await mongo.close();
  }
}

main().catch((error) => {
  console.error('Redis to MongoDB migration failed:', error);
  process.exitCode = 1;
});
