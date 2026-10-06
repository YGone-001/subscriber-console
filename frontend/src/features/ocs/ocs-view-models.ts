/*
 * OCS response to view-model adapters.
 *
 * Every ported OCS component reads through these adapters instead of touching
 * the raw envelope. The live Go contracts are:
 *
 *   GET /api/tariff-plans                      -> { plans: [...] }
 *   GET /api/tariff-plans/{planId}             -> { plan: {...} }
 *   GET /api/ocs/balances                      -> { ok, records: [...] }
 *   GET /api/ocs/balances/{imsi}               -> { ok, balance: {...} }
 *   GET /api/ocs/subscribers                   -> { ok, records: [...] }
 *
 * The historical pages read the payload directly, which is why `{plan}` and
 * `{ok, balance}` rendered as empty records.
 */
import {
  asBoolean,
  asIdString,
  asNumber,
  asRecord,
  asString,
  asText,
  asTimestamp,
  field,
  isFailureEnvelope,
  percentOf,
  unwrapList,
  unwrapRecord,
  type UnknownRecord,
} from '../../lib/api/envelope';

export type OcsBucket = {
  total: number | null;
  used: number | null;
  reserved: number | null;
  available: number | null;
};

export type OcsInvariants = {
  data: boolean | null;
  voice: boolean | null;
  sms: boolean | null;
  all: boolean | null;
};

export type OcsBalanceViewModel = {
  id: string | null;
  imsi: string | null;
  planId: string | null;
  status: string | null;
  data: OcsBucket;
  voice: OcsBucket;
  sms: OcsBucket;
  moneyBalance: number | null;
  version: number | null;
  invariants: OcsInvariants;
  createdAt: string | null;
  updatedAt: string | null;
};

export type OcsContractViewModel = {
  id: string | null;
  imsi: string | null;
  msisdn: string | null;
  status: string | null;
  planId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type OcsPageViewModel = {
  total: number | null;
  page: number | null;
  limit: number | null;
  totalPages: number | null;
};

export type TariffPlanViewModel = {
  planId: string | null;
  name: string | null;
  description: string | null;
  status: string | null;
  version: number | null;
  quotaPerGrant: number | null;
  validityTime: number | null;
  volumeThreshold: number | null;
  rulesCount: number | null;
  subscriberCount: number | null;
  isDefault: boolean | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type OcsListResult<T> = {
  records: T[];
  /** False only when the payload could not be read at all. */
  readable: boolean;
};

const EMPTY_BUCKET: OcsBucket = { total: null, used: null, reserved: null, available: null };

function toBucket(source: UnknownRecord, prefix: 'data' | 'voice' | 'sms'): OcsBucket {
  const nested = source[prefix];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as UnknownRecord;
    return {
      total: field(record, 'total', asNumber),
      used: field(record, 'used', asNumber),
      reserved: field(record, 'reserved', asNumber),
      available: field(record, 'available', asNumber),
    };
  }
  /* Flat form: data_total / data_used / data_reserved / data_available. */
  const flat: OcsBucket = {
    total: field(source, `${prefix}_total`, asNumber),
    used: field(source, `${prefix}_used`, asNumber),
    reserved: field(source, `${prefix}_reserved`, asNumber),
    available: field(source, `${prefix}_available`, asNumber),
  };
  const hasAny = Object.values(flat).some((value) => value !== null);
  return hasAny ? flat : { ...EMPTY_BUCKET };
}

export function toBalanceViewModel(payload: unknown): OcsBalanceViewModel | null {
  const record = unwrapRecord(payload, 'balance', 'record', 'data');
  if (!record) return null;
  return {
    id: field(record, 'id', asIdString) ?? field(record, '_id', asIdString),
    imsi: field(record, 'imsi', asText),
    planId: field(record, 'plan_id', asText) ?? field(record, 'planId', asText),
    status: field(record, 'status', asText),
    data: toBucket(record, 'data'),
    voice: toBucket(record, 'voice'),
    sms: toBucket(record, 'sms'),
    moneyBalance: field(record, 'money_balance', asNumber) ?? field(record, 'moneyBalance', asNumber),
    version: field(record, 'version', asNumber),
    invariants: {
      data: field(record, 'data_invariant_ok', asBoolean),
      voice: field(record, 'voice_invariant_ok', asBoolean),
      sms: field(record, 'sms_invariant_ok', asBoolean),
      all: field(record, 'invariant_ok', asBoolean),
    },
    createdAt: field(record, 'created_at', asTimestamp) ?? field(record, 'createdAt', asTimestamp),
    updatedAt: field(record, 'updated_at', asTimestamp) ?? field(record, 'updatedAt', asTimestamp),
  };
}

/** `{ok, records}` on the balance list. */
export function toBalanceListViewModel(payload: unknown): OcsListResult<OcsBalanceViewModel> {
  const list = unwrapList(payload, 'records', 'balances', 'items');
  if (!list) return { records: [], readable: false };
  const records: OcsBalanceViewModel[] = [];
  for (const entry of list) {
    const view = toBalanceViewModel(entry);
    if (view) records.push(view);
  }
  return { records, readable: true };
}

export function toContractViewModel(payload: unknown): OcsContractViewModel | null {
  const record = unwrapRecord(payload, 'contract', 'record', 'subscriber', 'data');
  if (!record) return null;
  return {
    id: field(record, 'id', asIdString) ?? field(record, '_id', asIdString),
    imsi: field(record, 'imsi', asText),
    msisdn: field(record, 'msisdn', asText),
    status: field(record, 'status', asText),
    planId: field(record, 'plan_id', asText) ?? field(record, 'planId', asText),
    createdAt: field(record, 'created_at', asTimestamp) ?? field(record, 'createdAt', asTimestamp),
    updatedAt: field(record, 'updated_at', asTimestamp) ?? field(record, 'updatedAt', asTimestamp),
  };
}

/** The pagination block the OCS list envelopes carry alongside `records`. */
export function toOcsPageViewModel(payload: unknown): OcsPageViewModel {
  const container = asRecord(payload);
  return {
    total: field(container, 'total', asNumber),
    page: field(container, 'page', asNumber),
    limit: field(container, 'limit', asNumber),
    totalPages: field(container, 'totalPages', asNumber),
  };
}

/** `{ok, records, total, page, limit, totalPages}` on the OCS subscriber (contract) list. */
export function toContractListViewModel(payload: unknown): OcsListResult<OcsContractViewModel> & OcsPageViewModel {
  const list = unwrapList(payload, 'records', 'subscribers', 'items');
  const page = toOcsPageViewModel(payload);
  if (!list) return { records: [], readable: false, ...page };
  const records: OcsContractViewModel[] = [];
  for (const entry of list) {
    const view = toContractViewModel(entry);
    if (view) records.push(view);
  }
  return { records, readable: true, ...page };
}

export function toTariffPlanViewModel(payload: unknown): TariffPlanViewModel | null {
  const record = unwrapRecord(payload, 'plan', 'record', 'data');
  if (!record) return null;
  return {
    planId: field(record, 'plan_id', asText) ?? field(record, 'planId', asText),
    name: field(record, 'name', asText),
    description: field(record, 'description', asString),
    status: field(record, 'status', asText),
    version: field(record, 'version', asNumber),
    quotaPerGrant: field(record, 'quota_per_grant', asNumber) ?? field(record, 'quotaPerGrant', asNumber),
    validityTime: field(record, 'validity_time', asNumber) ?? field(record, 'validityTime', asNumber),
    volumeThreshold: field(record, 'volume_threshold', asNumber) ?? field(record, 'volumeThreshold', asNumber),
    rulesCount: field(record, 'rulesCount', asNumber) ?? field(record, 'rules_count', asNumber),
    subscriberCount: field(record, 'subscriberCount', asNumber) ?? field(record, 'subscriber_count', asNumber),
    isDefault: field(record, 'isDefault', asBoolean) ?? field(record, 'is_default', asBoolean),
    createdBy: field(record, 'created_by', asText) ?? field(record, 'createdBy', asText),
    updatedBy: field(record, 'updated_by', asText) ?? field(record, 'updatedBy', asText),
    createdAt: field(record, 'created_at', asTimestamp) ?? field(record, 'createdAt', asTimestamp),
    updatedAt: field(record, 'updated_at', asTimestamp) ?? field(record, 'updatedAt', asTimestamp),
  };
}

/** `{plans}` on the tariff list. */
export function toTariffListViewModel(payload: unknown): OcsListResult<TariffPlanViewModel> {
  const list = unwrapList(payload, 'plans', 'records', 'items');
  if (!list) return { records: [], readable: false };
  const records: TariffPlanViewModel[] = [];
  for (const entry of list) {
    const view = toTariffPlanViewModel(entry);
    if (view) records.push(view);
  }
  return { records, readable: true };
}

/** `{plan}` on the tariff detail, or a bare plan object. */
export function toTariffDetailViewModel(payload: unknown): TariffPlanViewModel | null {
  return toTariffPlanViewModel(payload);
}

/** Bucket consumption as a 0-100 percentage, or null when it cannot be derived. */
export function bucketUsagePercent(bucket: OcsBucket): number | null {
  const total = bucket.total ?? (bucket.used !== null && bucket.available !== null ? bucket.used + bucket.available : null);
  return percentOf(bucket.used, total);
}

/** True when the payload was an explicit failure envelope rather than data. */
export function isOcsFailure(payload: unknown): boolean {
  return isFailureEnvelope(payload);
}
