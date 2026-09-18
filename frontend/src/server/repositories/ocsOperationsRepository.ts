import { Document, Filter, Long } from 'mongodb';
import { getXcloudCollection, mongoCollections } from '@/lib/mongo';

function toNumber(val: unknown, fallback = 0): number {
  if (val === undefined || val === null) return fallback;
  if (Long.isLong(val)) return val.toNumber();
  if (typeof val === 'number') return Number.isNaN(val) ? fallback : val;
  if (typeof val === 'string') {
    const parsed = Number(val);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

function toIsoString(val: unknown): string | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return val;
  return undefined;
}

function asString(val: unknown, fallback = ''): string {
  if (val === undefined || val === null) return fallback;
  return String(val).trim();
}

export type OcsBalanceRecord = {
  id: string;
  imsi: string;
  plan_id: string;
  status: string;
  data_total: number;
  data_used: number;
  data_reserved: number;
  data_available: number;
  voice_total: number;
  voice_used: number;
  voice_reserved: number;
  voice_available: number;
  sms_total: number;
  sms_used: number;
  sms_available: number;
  money_balance: number;
  version: number;
  data_invariant_ok: boolean;
  voice_invariant_ok: boolean;
  sms_invariant_ok: boolean;
  invariant_ok: boolean;
  created_at?: string;
  updated_at?: string;
  cycle_start_at?: string;
  cycle_reset_at?: string;
};

export type OcsSessionRecord = {
  id: string;
  session_id: string;
  imsi: string;
  apn: string;
  state: 'active' | 'closing' | 'closed' | string;
  interface_type: 'gy' | 'ro' | string;
  cc_request_number: number;
  granted_total: number;
  used_total: number;
  rating_group?: number;
  service_identifier?: number;
  tariff_rule_id?: string;
  charging_type?: string;
  calling_party?: string;
  called_party?: string;
  service_context_id?: string;
  granted_seconds?: number;
  used_seconds?: number;
  cleanup_token?: string;
  cleanup_stage?: string;
  cleanup_updated_at?: string;
  close_reason?: string;
  started_at?: string;
  last_update_at?: string;
  closed_at?: string;
};

export type OcsUsageRecord = {
  id: string;
  session_id: string;
  imsi: string;
  apn: string;
  cc_request_type: 'UPDATE' | 'TERMINATION' | string;
  cc_request_number: number;
  input_octets: number;
  output_octets: number;
  total_octets: number;
  charging_type?: string;
  interface_type?: string;
  charged: boolean;
  result_code?: number;
  granted_octets?: number;
  granted_seconds?: number;
  used_seconds?: number;
  granted_events?: number;
  used_events?: number;
  service_context_id?: string;
  rating_group?: number;
  service_identifier?: number;
  tariff_rule_id?: string;
  created_at?: string;
};

export type OcsReservationRecord = {
  id: string;
  session_id: string;
  imsi: string;
  apn: string;
  charging_type: string;
  interface_type?: string;
  grant_cc_request_type: string;
  grant_cc_request_number: number;
  reserved_octets: number;
  used_octets: number;
  released_octets: number;
  overuse_octets: number;
  granted_octets: number;
  granted_seconds?: number;
  used_seconds?: number;
  result_code: number;
  state: 'active' | 'settled' | 'released' | 'closed' | 'orphaned' | string;
  rating_group?: number;
  service_identifier?: number;
  tariff_rule_id?: string;
  orphan_reason?: string;
  cleanup_token?: string;
  created_at?: string;
  updated_at?: string;
  settled_at?: string;
  closed_at?: string;
  orphaned_at?: string;
};

export function checkBalanceInvariant(balance: {
  data_total: number;
  data_used: number;
  data_reserved: number;
  data_available: number;
  voice_total: number;
  voice_used: number;
  voice_reserved: number;
  voice_available: number;
  sms_total: number;
  sms_used: number;
  sms_available: number;
}) {
  const data_invariant_ok = balance.data_total === (balance.data_used + balance.data_reserved + balance.data_available);
  const voice_invariant_ok = balance.voice_total === (balance.voice_used + balance.voice_reserved + balance.voice_available);
  const sms_invariant_ok = balance.sms_total === (balance.sms_used + balance.sms_available);
  const invariant_ok = data_invariant_ok && voice_invariant_ok && sms_invariant_ok;
  return {
    data_invariant_ok,
    voice_invariant_ok,
    sms_invariant_ok,
    invariant_ok,
  };
}

export async function listOcsBalances(options: {
  page?: number;
  limit?: number;
  imsi?: string;
  planId?: string;
  status?: string;
  invariantStatus?: 'all' | 'valid' | 'broken';
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}) {
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const skip = (page - 1) * limit;

  const balanceColl = await getXcloudCollection(mongoCollections.ocsBalances);
  const subscriberColl = await getXcloudCollection(mongoCollections.ocsSubscribers);

  const filter: Filter<Document> = {};
  if (options.imsi) {
    filter.imsi = { $regex: options.imsi.trim(), $options: 'i' };
  }
  if (options.planId) {
    filter.plan_id = options.planId.trim();
  }
  if (options.status) {
    filter.status = options.status.trim();
  }

  const totalCount = await balanceColl.countDocuments(filter);
  
  const sortMap: Record<string, string> = {
    imsi: 'imsi',
    data_total: 'data_total',
    data_used: 'data_used',
    data_available: 'data_available',
    data_reserved: 'data_reserved',
    updated_at: 'updated_at',
  };
  const sortKey = sortMap[options.sortField || 'updated_at'] || 'updated_at';
  const sortDir = options.sortOrder === 'asc' ? 1 : -1;

  const rawBalances = await balanceColl
    .find(filter)
    .sort({ [sortKey]: sortDir, _id: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const imsiList = rawBalances.map((b) => String(b.imsi));
  const subscribers = imsiList.length > 0
    ? await subscriberColl.find({ imsi: { $in: imsiList } }).toArray()
    : [];
  const subMap = new Map(subscribers.map((s) => [String(s.imsi), s]));

  const records: OcsBalanceRecord[] = rawBalances.map((doc) => {
    const imsi = String(doc.imsi);
    const sub = subMap.get(imsi);
    const data_total = toNumber(doc.data_total);
    const data_used = toNumber(doc.data_used);
    const data_reserved = toNumber(doc.data_reserved);
    const data_available = toNumber(doc.data_available);

    const voice_total = toNumber(doc.voice_total, 3600);
    const voice_used = toNumber(doc.voice_used, 0);
    const voice_reserved = toNumber(doc.voice_reserved, 0);
    const voice_available = toNumber(doc.voice_available, 3600);

    const sms_total = toNumber(doc.sms_total, 100);
    const sms_used = toNumber(doc.sms_used, 0);
    const sms_available = toNumber(doc.sms_available, 100);

    const invariants = checkBalanceInvariant({
      data_total,
      data_used,
      data_reserved,
      data_available,
      voice_total,
      voice_used,
      voice_reserved,
      voice_available,
      sms_total,
      sms_used,
      sms_available,
    });

    return {
      id: doc._id?.toString() || imsi,
      imsi,
      plan_id: asString(doc.plan_id || sub?.plan_id, 'plan_default_10gb'),
      status: asString(doc.status || sub?.status, 'active'),
      data_total,
      data_used,
      data_reserved,
      data_available,
      voice_total,
      voice_used,
      voice_reserved,
      voice_available,
      sms_total,
      sms_used,
      sms_available,
      money_balance: toNumber(doc.money_balance, 0),
      version: toNumber(doc.version, 1),
      ...invariants,
      created_at: toIsoString(doc.created_at || sub?.created_at),
      updated_at: toIsoString(doc.updated_at),
      cycle_start_at: toIsoString(doc.cycle_start_at),
      cycle_reset_at: toIsoString(doc.cycle_reset_at),
    };
  });

  const summaryAgg = await balanceColl.aggregate([
    {
      $group: {
        _id: null,
        totalDataAllocated: { $sum: '$data_total' },
        totalDataUsed: { $sum: '$data_used' },
        totalDataReserved: { $sum: '$data_reserved' },
        totalDataAvailable: { $sum: '$data_available' },
        totalSubscribers: { $sum: 1 },
      },
    },
  ]).toArray();

  const summary = summaryAgg[0] || {
    totalDataAllocated: 0,
    totalDataUsed: 0,
    totalDataReserved: 0,
    totalDataAvailable: 0,
    totalSubscribers: 0,
  };

  const filteredRecords = options.invariantStatus === 'valid'
    ? records.filter((r) => r.invariant_ok)
    : options.invariantStatus === 'broken'
    ? records.filter((r) => !r.invariant_ok)
    : records;

  return {
    records: filteredRecords,
    total: totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit) || 1,
    summary: {
      totalSubscribers: toNumber(summary.totalSubscribers, totalCount),
      totalDataAllocated: toNumber(summary.totalDataAllocated),
      totalDataUsed: toNumber(summary.totalDataUsed),
      totalDataReserved: toNumber(summary.totalDataReserved),
      totalDataAvailable: toNumber(summary.totalDataAvailable),
    },
  };
}

export async function listOcsSessions(options: {
  page?: number;
  limit?: number;
  imsi?: string;
  sessionId?: string;
  apn?: string;
  state?: string;
  interfaceType?: string;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}) {
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const skip = (page - 1) * limit;

  const sessionColl = await getXcloudCollection(mongoCollections.ocsSessions);

  const filter: Filter<Document> = {};
  if (options.imsi) {
    filter.imsi = { $regex: options.imsi.trim(), $options: 'i' };
  }
  if (options.sessionId) {
    filter.session_id = { $regex: options.sessionId.trim(), $options: 'i' };
  }
  if (options.apn) {
    filter.apn = options.apn.trim();
  }
  if (options.state && options.state !== 'all') {
    filter.state = options.state.trim();
  }
  if (options.interfaceType && options.interfaceType !== 'all') {
    filter.interface_type = options.interfaceType.trim();
  }

  const totalCount = await sessionColl.countDocuments(filter);

  const sortMap: Record<string, string> = {
    started_at: 'started_at',
    last_update_at: 'last_update_at',
    used_total: 'used_total',
    granted_total: 'granted_total',
    session_id: 'session_id',
    imsi: 'imsi',
  };
  const sortKey = sortMap[options.sortField || 'last_update_at'] || 'last_update_at';
  const sortDir = options.sortOrder === 'asc' ? 1 : -1;

  const rawSessions = await sessionColl
    .find(filter)
    .sort({ [sortKey]: sortDir, _id: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const records: OcsSessionRecord[] = rawSessions.map((doc) => ({
    id: doc._id?.toString() || String(doc.session_id),
    session_id: asString(doc.session_id),
    imsi: asString(doc.imsi),
    apn: asString(doc.apn, 'internet'),
    state: asString(doc.state, 'active'),
    interface_type: asString(doc.interface_type, 'gy'),
    cc_request_number: toNumber(doc.cc_request_number, 0),
    granted_total: toNumber(doc.granted_total, 0),
    used_total: toNumber(doc.used_total, 0),
    rating_group: doc.rating_group !== undefined ? toNumber(doc.rating_group) : undefined,
    service_identifier: doc.service_identifier !== undefined ? toNumber(doc.service_identifier) : undefined,
    tariff_rule_id: doc.tariff_rule_id ? asString(doc.tariff_rule_id) : undefined,
    charging_type: doc.charging_type ? asString(doc.charging_type) : undefined,
    calling_party: doc.calling_party ? asString(doc.calling_party) : undefined,
    called_party: doc.called_party ? asString(doc.called_party) : undefined,
    service_context_id: doc.service_context_id ? asString(doc.service_context_id) : undefined,
    granted_seconds: doc.granted_seconds !== undefined ? toNumber(doc.granted_seconds) : undefined,
    used_seconds: doc.used_seconds !== undefined ? toNumber(doc.used_seconds) : undefined,
    cleanup_token: doc.cleanup_token ? asString(doc.cleanup_token) : undefined,
    cleanup_stage: doc.cleanup_stage ? asString(doc.cleanup_stage) : undefined,
    cleanup_updated_at: toIsoString(doc.cleanup_updated_at),
    close_reason: doc.close_reason ? asString(doc.close_reason) : undefined,
    started_at: toIsoString(doc.started_at),
    last_update_at: toIsoString(doc.last_update_at),
    closed_at: toIsoString(doc.closed_at),
  }));

  const [activeCount, closingCount, closedCount, aggregateSums] = await Promise.all([
    sessionColl.countDocuments({ state: 'active' }),
    sessionColl.countDocuments({ state: 'closing' }),
    sessionColl.countDocuments({ state: 'closed' }),
    sessionColl.aggregate([
      {
        $group: {
          _id: null,
          totalGrantedOctets: { $sum: '$granted_total' },
          totalUsedOctets: { $sum: '$used_total' },
        },
      },
    ]).toArray(),
  ]);

  const sums = aggregateSums[0] || { totalGrantedOctets: 0, totalUsedOctets: 0 };

  return {
    records,
    total: totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit) || 1,
    summary: {
      activeSessions: activeCount,
      closingSessions: closingCount,
      closedSessions: closedCount,
      totalGrantedOctets: toNumber(sums.totalGrantedOctets),
      totalUsedOctets: toNumber(sums.totalUsedOctets),
    },
  };
}

export async function listOcsUsageRecords(options: {
  page?: number;
  limit?: number;
  imsi?: string;
  sessionId?: string;
  apn?: string;
  ccRequestType?: string;
  charged?: boolean;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}) {
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const skip = (page - 1) * limit;

  const usageColl = await getXcloudCollection(mongoCollections.ocsUsageRecords);

  const filter: Filter<Document> = {};
  if (options.imsi) {
    filter.imsi = { $regex: options.imsi.trim(), $options: 'i' };
  }
  if (options.sessionId) {
    filter.session_id = { $regex: options.sessionId.trim(), $options: 'i' };
  }
  if (options.apn) {
    filter.apn = options.apn.trim();
  }
  if (options.ccRequestType && options.ccRequestType !== 'all') {
    filter.cc_request_type = options.ccRequestType.trim();
  }
  if (typeof options.charged === 'boolean') {
    filter.charged = options.charged;
  }

  const totalCount = await usageColl.countDocuments(filter);

  const sortMap: Record<string, string> = {
    created_at: 'created_at',
    total_octets: 'total_octets',
    cc_request_number: 'cc_request_number',
  };
  const sortKey = sortMap[options.sortField || 'created_at'] || 'created_at';
  const sortDir = options.sortOrder === 'asc' ? 1 : -1;

  const rawRecords = await usageColl
    .find(filter)
    .sort({ [sortKey]: sortDir, _id: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const records: OcsUsageRecord[] = rawRecords.map((doc) => ({
    id: doc._id?.toString() || `${doc.session_id}_${doc.cc_request_type}_${doc.cc_request_number}`,
    session_id: asString(doc.session_id),
    imsi: asString(doc.imsi),
    apn: asString(doc.apn, 'internet'),
    cc_request_type: asString(doc.cc_request_type, 'UPDATE'),
    cc_request_number: toNumber(doc.cc_request_number, 0),
    input_octets: toNumber(doc.input_octets, 0),
    output_octets: toNumber(doc.output_octets, 0),
    total_octets: toNumber(doc.total_octets, 0),
    charging_type: doc.charging_type ? asString(doc.charging_type) : undefined,
    interface_type: doc.interface_type ? asString(doc.interface_type) : undefined,
    charged: Boolean(doc.charged),
    result_code: doc.result_code !== undefined ? toNumber(doc.result_code) : undefined,
    granted_octets: doc.granted_octets !== undefined ? toNumber(doc.granted_octets) : undefined,
    granted_seconds: doc.granted_seconds !== undefined ? toNumber(doc.granted_seconds) : undefined,
    used_seconds: doc.used_seconds !== undefined ? toNumber(doc.used_seconds) : undefined,
    granted_events: doc.granted_events !== undefined ? toNumber(doc.granted_events) : undefined,
    used_events: doc.used_events !== undefined ? toNumber(doc.used_events) : undefined,
    service_context_id: doc.service_context_id ? asString(doc.service_context_id) : undefined,
    rating_group: doc.rating_group !== undefined ? toNumber(doc.rating_group) : undefined,
    service_identifier: doc.service_identifier !== undefined ? toNumber(doc.service_identifier) : undefined,
    tariff_rule_id: doc.tariff_rule_id ? asString(doc.tariff_rule_id) : undefined,
    created_at: toIsoString(doc.created_at),
  }));

  const sums = await usageColl.aggregate([
    {
      $group: {
        _id: null,
        totalInputOctets: { $sum: '$input_octets' },
        totalOutputOctets: { $sum: '$output_octets' },
        totalOctets: { $sum: '$total_octets' },
        chargedCount: {
          $sum: { $cond: [{ $eq: ['$charged', true] }, 1, 0] },
        },
      },
    },
  ]).toArray();

  const aggregate = sums[0] || {
    totalInputOctets: 0,
    totalOutputOctets: 0,
    totalOctets: 0,
    chargedCount: 0,
  };

  return {
    records,
    total: totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit) || 1,
    summary: {
      totalRecords: totalCount,
      totalChargedRecords: toNumber(aggregate.chargedCount),
      totalInputOctets: toNumber(aggregate.totalInputOctets),
      totalOutputOctets: toNumber(aggregate.totalOutputOctets),
      totalOctets: toNumber(aggregate.totalOctets),
    },
  };
}

export async function listOcsReservations(options: {
  page?: number;
  limit?: number;
  imsi?: string;
  sessionId?: string;
  state?: string;
  chargingType?: string;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}) {
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
  const skip = (page - 1) * limit;

  const reservationColl = await getXcloudCollection(mongoCollections.ocsReservations);

  const filter: Filter<Document> = {};
  if (options.imsi) {
    filter.imsi = { $regex: options.imsi.trim(), $options: 'i' };
  }
  if (options.sessionId) {
    filter.session_id = { $regex: options.sessionId.trim(), $options: 'i' };
  }
  if (options.state && options.state !== 'all') {
    filter.state = options.state.trim();
  }
  if (options.chargingType && options.chargingType !== 'all') {
    filter.charging_type = options.chargingType.trim();
  }

  const totalCount = await reservationColl.countDocuments(filter);

  const sortMap: Record<string, string> = {
    created_at: 'created_at',
    updated_at: 'updated_at',
    reserved_octets: 'reserved_octets',
    used_octets: 'used_octets',
  };
  const sortKey = sortMap[options.sortField || 'created_at'] || 'created_at';
  const sortDir = options.sortOrder === 'asc' ? 1 : -1;

  const rawRecords = await reservationColl
    .find(filter)
    .sort({ [sortKey]: sortDir, _id: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const records: OcsReservationRecord[] = rawRecords.map((doc) => ({
    id: doc._id?.toString() || `${doc.session_id}_${doc.grant_cc_request_number}`,
    session_id: asString(doc.session_id),
    imsi: asString(doc.imsi),
    apn: asString(doc.apn, 'internet'),
    charging_type: asString(doc.charging_type, 'data_volume'),
    interface_type: doc.interface_type ? asString(doc.interface_type) : undefined,
    grant_cc_request_type: asString(doc.grant_cc_request_type, 'INITIAL'),
    grant_cc_request_number: toNumber(doc.grant_cc_request_number, 0),
    reserved_octets: toNumber(doc.reserved_octets, 0),
    used_octets: toNumber(doc.used_octets, 0),
    released_octets: toNumber(doc.released_octets, 0),
    overuse_octets: toNumber(doc.overuse_octets, 0),
    granted_octets: toNumber(doc.granted_octets, 0),
    granted_seconds: doc.granted_seconds !== undefined ? toNumber(doc.granted_seconds) : undefined,
    used_seconds: doc.used_seconds !== undefined ? toNumber(doc.used_seconds) : undefined,
    result_code: toNumber(doc.result_code, 2001),
    state: asString(doc.state, 'active'),
    rating_group: doc.rating_group !== undefined ? toNumber(doc.rating_group) : undefined,
    service_identifier: doc.service_identifier !== undefined ? toNumber(doc.service_identifier) : undefined,
    tariff_rule_id: doc.tariff_rule_id ? asString(doc.tariff_rule_id) : undefined,
    orphan_reason: doc.orphan_reason ? asString(doc.orphan_reason) : undefined,
    cleanup_token: doc.cleanup_token ? asString(doc.cleanup_token) : undefined,
    created_at: toIsoString(doc.created_at),
    updated_at: toIsoString(doc.updated_at),
    settled_at: toIsoString(doc.settled_at),
    closed_at: toIsoString(doc.closed_at),
    orphaned_at: toIsoString(doc.orphaned_at),
  }));

  const [activeCount, settledCount, orphanedCount, sums] = await Promise.all([
    reservationColl.countDocuments({ state: 'active' }),
    reservationColl.countDocuments({ state: 'settled' }),
    reservationColl.countDocuments({ state: 'orphaned' }),
    reservationColl.aggregate([
      {
        $group: {
          _id: null,
          totalReservedOctets: { $sum: '$reserved_octets' },
          totalReleasedOctets: { $sum: '$released_octets' },
        },
      },
    ]).toArray(),
  ]);

  const aggregate = sums[0] || {
    totalReservedOctets: 0,
    totalReleasedOctets: 0,
  };

  return {
    records,
    total: totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit) || 1,
    summary: {
      totalReservations: totalCount,
      activeReservations: activeCount,
      settledReservations: settledCount,
      orphanedReservations: orphanedCount,
      totalReservedOctets: toNumber(aggregate.totalReservedOctets),
      totalReleasedOctets: toNumber(aggregate.totalReleasedOctets),
    },
  };
}
