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
  cycleStartAt: string | null;
  cycleResetAt: string | null;
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

/**
 * The `summary` block the balance list envelope already carries. It describes
 * the whole collection, not the current page, so the KPI strip can state totals
 * without a second request. Missing fields stay `null` rather than becoming 0.
 */
export type OcsBalanceSummaryViewModel = {
  totalSubscribers: number | null;
  totalDataAllocated: number | null;
  totalDataUsed: number | null;
  totalDataAvailable: number | null;
};

export const EMPTY_BALANCE_SUMMARY: OcsBalanceSummaryViewModel = {
  totalSubscribers: null,
  totalDataAllocated: null,
  totalDataUsed: null,
  totalDataAvailable: null,
};

export function toBalanceSummaryViewModel(payload: unknown): OcsBalanceSummaryViewModel {
  const summary = asRecord(asRecord(payload).summary);
  if (!summary) return { ...EMPTY_BALANCE_SUMMARY };
  return {
    totalSubscribers: field(summary, 'totalSubscribers', asNumber) ?? field(summary, 'total_subscribers', asNumber),
    totalDataAllocated: field(summary, 'totalDataAllocated', asNumber) ?? field(summary, 'total_data_allocated', asNumber),
    totalDataUsed: field(summary, 'totalDataUsed', asNumber) ?? field(summary, 'total_data_used', asNumber),
    totalDataAvailable: field(summary, 'totalDataAvailable', asNumber) ?? field(summary, 'total_data_available', asNumber),
  };
}

/*
 * `version`, `created_by` and `updated_by` are deliberately absent: the tariff
 * plan projection (`PlanSummary` in the Go repository) never emits them, so the
 * historical "version" and "updated by" table columns could only ever render the
 * fallback `v1` / an em dash. Projecting fields that do not exist is worse than
 * not projecting them at all.
 */
export type TariffPlanViewModel = {
  planId: string | null;
  name: string | null;
  description: string | null;
  status: string | null;
  quotaPerGrant: number | null;
  validityTime: number | null;
  volumeThreshold: number | null;
  rulesCount: number | null;
  subscriberCount: number | null;
  isDefault: boolean | null;
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
    cycleStartAt: field(record, 'cycle_start_at', asTimestamp) ?? field(record, 'cycleStartAt', asTimestamp),
    cycleResetAt: field(record, 'cycle_reset_at', asTimestamp) ?? field(record, 'cycleResetAt', asTimestamp),
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
    quotaPerGrant: field(record, 'quota_per_grant', asNumber) ?? field(record, 'quotaPerGrant', asNumber),
    validityTime: field(record, 'validity_time', asNumber) ?? field(record, 'validityTime', asNumber),
    volumeThreshold: field(record, 'volume_threshold', asNumber) ?? field(record, 'volumeThreshold', asNumber),
    rulesCount: field(record, 'rulesCount', asNumber) ?? field(record, 'rules_count', asNumber),
    subscriberCount: field(record, 'subscriberCount', asNumber) ?? field(record, 'subscriber_count', asNumber),
    isDefault: field(record, 'isDefault', asBoolean) ?? field(record, 'is_default', asBoolean),
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

/*
 * Governed adjustment trail.
 *
 * One record per BALANCE_ADJUST operation-log entry. The bucket and operation
 * stay as the API words (`data`/`voice`/`sms`, `credit`/`debit`) and are
 * localized at render time; the amount is unitless on purpose because its unit
 * depends on the bucket.
 */
export type OcsAdjustmentViewModel = {
  id: string | null;
  createdAt: string | null;
  actor: string | null;
  role: string | null;
  result: string | null;
  reason: string | null;
  bucket: string | null;
  operation: string | null;
  amount: number | null;
  ticketId: string | null;
  beforeVersion: number | null;
  afterVersion: number | null;
};

export type OcsAdjustmentListViewModel = OcsListResult<OcsAdjustmentViewModel> & {
  total: number | null;
  page: number | null;
  limit: number | null;
};

function toAdjustmentViewModel(payload: unknown): OcsAdjustmentViewModel | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    id: field(record, 'id', asIdString) ?? field(record, '_id', asIdString),
    createdAt: field(record, 'createdAt', asTimestamp) ?? field(record, 'created_at', asTimestamp),
    actor: field(record, 'actor', asText),
    role: field(record, 'role', asText),
    result: field(record, 'result', asText),
    reason: field(record, 'reason', asString),
    bucket: field(record, 'bucket', asText),
    operation: field(record, 'operation', asText),
    amount: field(record, 'amount', asNumber),
    ticketId: field(record, 'ticketId', asText),
    beforeVersion: field(record, 'beforeVersion', asNumber),
    afterVersion: field(record, 'afterVersion', asNumber),
  };
}

/** `{ok, imsi, total, records}` on the balance adjustment trail. */
export function toAdjustmentListViewModel(payload: unknown): OcsAdjustmentListViewModel {
  const list = unwrapList(payload, 'records', 'adjustments', 'items');
  const container = asRecord(payload);
  const total = field(container, 'total', asNumber);
  const page = field(container, 'page', asNumber);
  const limit = field(container, 'limit', asNumber);
  if (!list) return { records: [], readable: false, total, page, limit };
  const records: OcsAdjustmentViewModel[] = [];
  for (const entry of list) {
    const view = toAdjustmentViewModel(entry);
    if (view) records.push(view);
  }
  return { records, readable: true, total, page, limit };
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
