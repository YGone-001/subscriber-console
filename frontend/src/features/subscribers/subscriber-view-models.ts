/*
 * Subscriber response to view-model adapters.
 *
 * Live Go contracts:
 *
 *   GET /api/subscribers?page&limit&q
 *     -> { subscribers: ["<imsi>", ...], total, page, limit }
 *   GET /api/subscribers?detail=true&page&limit&q
 *     -> { subscribers: [{ imsi, status, ard, plmn, profile, policy, policyName,
 *          policyStatus, traffic: { total, used, balance },
 *          sms: { total, used, balance }, lastActive }],
 *          total, page, limit,
 *          summary: { total, active, restricted, lowTraffic } }
 *   GET /api/subscribers/{imsi} -> the raw 4G profile document
 *
 * The `traffic` and `sms` buckets are objects. Reading them as scalars is what
 * produced "[object Object]" cells, so they are adapted field-by-field here.
 */
import {
  asNumber,
  asRecord,
  asString,
  asText,
  asTimestamp,
  field,
  percentOf,
  unwrapList,
  unwrapSummary,
  type UnknownRecord,
} from '../../lib/api/envelope';

export type SubscriberBucketViewModel = {
  total: number | null;
  used: number | null;
  balance: number | null;
  /** Used as a share of total, 0-100, or null when it cannot be derived. */
  percent: number | null;
};

export type SubscriberRowViewModel = {
  imsi: string | null;
  status: string | null;
  ard: number | null;
  plmn: string | null;
  profile: string | null;
  policy: string | null;
  policyName: string | null;
  policyStatus: string | null;
  traffic: SubscriberBucketViewModel;
  sms: SubscriberBucketViewModel;
  lastActive: string | null;
};

export type SubscriberSummaryViewModel = {
  total: number | null;
  active: number | null;
  restricted: number | null;
  lowTraffic: number | null;
};

export type SubscriberListViewModel = {
  rows: SubscriberRowViewModel[];
  /** The raw identifiers, for the identifier-only list form. */
  imsis: string[];
  total: number | null;
  page: number | null;
  limit: number | null;
  summary: SubscriberSummaryViewModel | null;
  /** False only when the payload could not be read at all. */
  readable: boolean;
};

const EMPTY_BUCKET: SubscriberBucketViewModel = { total: null, used: null, balance: null, percent: null };

export function toSubscriberBucketViewModel(value: unknown): SubscriberBucketViewModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_BUCKET };
  const record = value as UnknownRecord;
  const total = field(record, 'total', asNumber);
  const used = field(record, 'used', asNumber);
  const balance = field(record, 'balance', asNumber);
  return { total, used, balance, percent: percentOf(used, total) };
}

export function toSubscriberRowViewModel(value: unknown): SubscriberRowViewModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as UnknownRecord;
  const imsi = field(record, 'imsi', asText);
  if (imsi === null) return null;
  return {
    imsi,
    status: field(record, 'status', asText),
    ard: field(record, 'ard', asNumber),
    plmn: field(record, 'plmn', asText),
    /* Descriptive strings are kept losslessly: the API reports "" for
     * "no profile assigned", and the display layer turns "" into a placeholder. */
    profile: field(record, 'profile', asString),
    policy: field(record, 'policy', asString),
    policyName: field(record, 'policyName', asString),
    policyStatus: field(record, 'policyStatus', asString),
    traffic: toSubscriberBucketViewModel(record.traffic),
    sms: toSubscriberBucketViewModel(record.sms),
    lastActive: field(record, 'lastActive', asTimestamp),
  };
}

/**
 * Adapt both subscriber list forms.
 *
 * The identifier-only form returns strings; the detail form returns records.
 * Both are accepted so a page can switch between them without a second adapter.
 */
export function toSubscriberListViewModel(payload: unknown): SubscriberListViewModel {
  const list = unwrapList(payload, 'subscribers', 'records', 'items');
  const summarySource = unwrapSummary(payload, 'summary');
  const container = asRecord(payload);

  const rows: SubscriberRowViewModel[] = [];
  const imsis: string[] = [];
  if (list) {
    for (const entry of list) {
      if (typeof entry === 'string') {
        if (entry !== '') imsis.push(entry);
        continue;
      }
      const row = toSubscriberRowViewModel(entry);
      if (row) {
        rows.push(row);
        if (row.imsi) imsis.push(row.imsi);
      }
    }
  }

  return {
    rows,
    imsis,
    total: field(container, 'total', asNumber),
    page: field(container, 'page', asNumber),
    limit: field(container, 'limit', asNumber) ?? field(container, 'pageSize', asNumber),
    summary: summarySource ? {
      total: field(summarySource, 'total', asNumber),
      active: field(summarySource, 'active', asNumber),
      restricted: field(summarySource, 'restricted', asNumber),
      lowTraffic: field(summarySource, 'lowTraffic', asNumber),
    } : null,
    readable: list !== null,
  };
}

export type SubscriberDetailViewModel = {
  imsi: string | null;
  msisdns: string[];
  profileName: string | null;
  allowedVisitedPlmns: string | null;
  networkAccessMode: number | null;
  accessRestrictionData: number | null;
  sliceCount: number;
  sessionCount: number;
  pccRuleCount: number;
  raw: UnknownRecord;
};

/** Adapt the raw `/api/subscribers/{imsi}` 4G profile document. */
export function toSubscriberDetailViewModel(payload: unknown, fallbackImsi: string | null = null): SubscriberDetailViewModel | null {
  const envelope = asRecord(payload);
  const sub4G = asRecord(envelope.sub4G);
  const record = Object.keys(sub4G).length ? sub4G : envelope;
  if (Object.keys(record).length === 0) return null;

  const msisdnList = Array.isArray(record.msisdnList) ? record.msisdnList : [];
  const msisdns: string[] = [];
  for (const entry of msisdnList) {
    const value = asRecord(entry).msisdn;
    if (typeof value === 'string' && value !== '') msisdns.push(value);
  }

  const slices = Array.isArray(record.sliceList) ? record.sliceList : [];
  let sessionCount = 0;
  let pccRuleCount = 0;
  for (const slice of slices) {
    const sliceRecord = asRecord(slice);
    const sessions = Array.isArray(sliceRecord.session_list) ? sliceRecord.session_list : [];
    sessionCount += sessions.length;
    for (const session of sessions) {
      const rules = asRecord(session).pcc_rule;
      if (Array.isArray(rules)) pccRuleCount += rules.length;
    }
  }

  return {
    imsi: asText(record.imsi) ?? fallbackImsi,
    msisdns,
    profileName: field(record, 'profile_name', asString),
    allowedVisitedPlmns: field(record, 'allowedVisitedPlmns', asText),
    networkAccessMode: field(record, 'network_access_mode', asNumber),
    accessRestrictionData: field(record, 'access_restriction_data', asNumber),
    sliceCount: slices.length,
    sessionCount,
    pccRuleCount,
    raw: record,
  };
}
