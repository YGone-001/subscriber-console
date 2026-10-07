/**
 * Framework-neutral request builders for subscriber mutations.
 * Strictly implements the authoritative Go HTTP contracts.
 */

export interface BatchPrecheckPayload {
  startImsi: string;
  count: number;
}

export interface BatchCreatePayload {
  startImsi: string;
  count: number;
  profileName?: string;
  planId?: string;
  strategy?: 'skip' | 'overwrite';
  trafficTotal?: number;
  trafficBalance?: number;
  smsTotal?: number;
  smsBalance?: number;
}

export interface BatchUpdatePatch {
  accessRestrictionData?: number;
  ambr?: {
    downlink?: { value: number; unit: number };
    uplink?: { value: number; unit: number };
  };
}

export interface BatchUpdatePayload {
  imsis: string[];
  patch: BatchUpdatePatch;
  reason: string;
  ticketId?: string;
  maintenanceWindow?: {
    start: string;
    end: string;
    timeZone?: string;
  };
}

export interface BulkDeletePayload {
  imsiList: string[];
}

export interface ImportRecord {
  imsi: string;
  access_restriction_data?: number;
  traffic_total?: number;
  traffic_balance?: number;
  sms_total?: number;
  sms_balance?: number;
  plan_id?: string;
}

export const ALLOWED_IMPORT_RECORD_KEYS = new Set([
  'imsi',
  'access_restriction_data',
  'traffic_total',
  'traffic_balance',
  'sms_total',
  'sms_balance',
  'plan_id',
]);

export const SENSITIVE_IMPORT_KEYS = new Set([
  'k',
  'op',
  'opc',
  'amf',
  'sqn',
]);

export function validateAndNormalizeImportRecord(raw: unknown): ImportRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Import record must be a JSON object');
  }
  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (SENSITIVE_IMPORT_KEYS.has(key)) {
      const val = record[key];
      if (typeof val === 'string' && val.trim() !== '') {
        throw new Error(`Sensitive credential field "${key}" is not supported in subscriber import`);
      }
    }
  }

  for (const key of Object.keys(record)) {
    if (!ALLOWED_IMPORT_RECORD_KEYS.has(key)) {
      throw new Error(
        `Unsupported import field: "${key}". Supported fields: ${Array.from(ALLOWED_IMPORT_RECORD_KEYS).join(', ')}`,
      );
    }
  }

  const imsi = String(record.imsi ?? '').trim();
  if (!imsi) {
    throw new Error('Import record missing required field: "imsi"');
  }
  if (!/^\d{15}$/.test(imsi)) {
    throw new Error(`Invalid IMSI "${imsi}": must be exactly 15 digits`);
  }

  const normalized: ImportRecord = { imsi };

  if (record.access_restriction_data !== undefined) {
    const val = Number(record.access_restriction_data);
    if (!Number.isInteger(val) || val < 0 || val > 255) {
      throw new Error('access_restriction_data must be an integer between 0 and 255');
    }
    normalized.access_restriction_data = val;
  }

  const numericFields = ['traffic_total', 'traffic_balance', 'sms_total', 'sms_balance'] as const;
  for (const field of numericFields) {
    if (record[field] !== undefined) {
      const val = Number(record[field]);
      if (!Number.isSafeInteger(val) || val < 0) {
        throw new Error(`${field} must be a non-negative integer`);
      }
      normalized[field] = val;
    }
  }

  if (record.plan_id !== undefined) {
    const val = String(record.plan_id).trim();
    if (!val) {
      throw new Error('plan_id cannot be empty when provided');
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(val)) {
      throw new Error(`Invalid plan_id "${val}": must be 1-64 alphanumeric/dash/underscore/dot characters`);
    }
    normalized.plan_id = val;
  }

  return normalized;
}

export interface ImportPrecheckPayload {
  imsiList: string[];
}

export interface ImportExecutionPayload {
  records: ImportRecord[];
  overwrite: boolean;
}

/*
 * Authentication material supplied at subscriber creation.
 *
 * Exactly one of op / opc must be present. This is a CREATE-time shape only: ordinary subscriber
 * editing must not emit auth4G, because the service refuses to change authentication material on
 * a record that already exists.
 */
export interface CreateAuth4G {
  k: string;
  op?: string;
  opc?: string;
  amf: string;
  sqn: number;
}

export interface SubscriberCreatePayload {
  imsi: string;
  planId?: string;
  msisdn?: string;
  auth4G?: CreateAuth4G;
}

export interface SubscriberUpdatePayload {
  sub4G?: {
    access_restriction_data?: number;
    network_access_mode?: number;
    ambr?: {
      downlink?: { value: number; unit: number };
      uplink?: { value: number; unit: number };
    };
    msisdnList?: Array<{ msisdn: string }>;
    sliceList?: unknown[];
  };
  auth4G?: {
    k?: string;
    op?: string;
    opc?: string;
    amf?: string;
    sqn?: number;
  };
  ocsTraffic?: {
    plmn?: string;
    traffic_total?: number;
    traffic_balance?: number;
    voice_total?: number;
    voice_balance?: number;
    sms_total?: number;
    sms_balance?: number;
  };
}

export interface ProfileApplyPayload {
  profileName: string;
}

export interface TrafficAdjustmentPayload {
  bucket?: 'data' | 'voice' | 'sms';
  amount?: number;
  reason?: string;
}

export function buildBatchPrecheckRequest(startImsi: string, count: number): BatchPrecheckPayload {
  const trimmedImsi = String(startImsi || '').trim();
  const numericCount = Number(count);
  if (!trimmedImsi) {
    throw new Error('startImsi is required');
  }
  if (!Number.isSafeInteger(numericCount) || numericCount < 1) {
    throw new Error('count must be an integer greater than or equal to 1');
  }
  return {
    startImsi: trimmedImsi,
    count: numericCount,
  };
}

export function buildBatchCreateRequest(
  startImsi: string,
  count: number,
  options?: {
    profileName?: string;
    planId?: string;
    strategy?: 'skip' | 'overwrite';
    trafficTotal?: number;
    trafficBalance?: number;
    smsTotal?: number;
    smsBalance?: number;
  },
): BatchCreatePayload {
  const trimmedImsi = String(startImsi || '').trim();
  const numericCount = Number(count);
  if (!trimmedImsi) {
    throw new Error('startImsi is required');
  }
  if (!Number.isSafeInteger(numericCount) || numericCount < 1) {
    throw new Error('count must be an integer greater than or equal to 1');
  }
  const payload: BatchCreatePayload = {
    startImsi: trimmedImsi,
    count: numericCount,
  };
  if (options?.profileName?.trim()) {
    payload.profileName = options.profileName.trim();
  }
  if (options?.planId?.trim()) {
    payload.planId = options.planId.trim();
  }
  if (options?.strategy) {
    payload.strategy = options.strategy;
  }
  if (typeof options?.trafficTotal === 'number') {
    payload.trafficTotal = options.trafficTotal;
  }
  if (typeof options?.trafficBalance === 'number') {
    payload.trafficBalance = options.trafficBalance;
  }
  if (typeof options?.smsTotal === 'number') {
    payload.smsTotal = options.smsTotal;
  }
  if (typeof options?.smsBalance === 'number') {
    payload.smsBalance = options.smsBalance;
  }
  return payload;
}

export function buildBatchUpdateRequest(
  imsis: string[],
  patch: BatchUpdatePatch,
  reason: string,
  options?: { ticketId?: string },
): BatchUpdatePayload {
  const validImsis = (Array.isArray(imsis) ? imsis : []).map((i) => String(i).trim()).filter(Boolean);
  if (validImsis.length === 0) {
    throw new Error('imsis must contain at least one valid IMSI');
  }
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason || trimmedReason.length < 3) {
    throw new Error('reason must contain at least 3 characters');
  }
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    throw new Error('patch object must not be empty');
  }
  const payload: BatchUpdatePayload = {
    imsis: validImsis,
    patch,
    reason: trimmedReason,
  };
  if (options?.ticketId?.trim()) {
    payload.ticketId = options.ticketId.trim();
  }
  return payload;
}

export function buildBulkDeleteRequest(imsiList: string[]): BulkDeletePayload {
  const validImsis = (Array.isArray(imsiList) ? imsiList : []).map((i) => String(i).trim()).filter(Boolean);
  if (validImsis.length === 0) {
    throw new Error('imsiList must contain at least one valid IMSI');
  }
  return {
    imsiList: validImsis,
  };
}

export function buildImportPrecheckRequest(imsiList: string[]): ImportPrecheckPayload {
  const validImsis = (Array.isArray(imsiList) ? imsiList : []).map((i) => String(i).trim()).filter(Boolean);
  if (validImsis.length === 0) {
    throw new Error('imsiList must contain at least one valid IMSI');
  }
  return {
    imsiList: validImsis,
  };
}

export function buildImportRequest(records: ImportRecord[], overwrite = false): ImportExecutionPayload {
  if (overwrite) {
    throw new Error('Subscriber import overwrite is not supported');
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('records must contain at least one record');
  }
  const seenImsis = new Set<string>();
  const normalizedRecords: ImportRecord[] = [];
  for (const raw of records) {
    const record = validateAndNormalizeImportRecord(raw);
    if (seenImsis.has(record.imsi)) {
      throw new Error(`Duplicate IMSI in import records: ${record.imsi}`);
    }
    seenImsis.add(record.imsi);
    normalizedRecords.push(record);
  }
  return {
    records: normalizedRecords,
    overwrite: false,
  };
}

/* 32 hex characters: K, OP and OPc. */
const HEX_32 = /^[0-9a-fA-F]{32}$/;
/* 4 hex characters: AMF. */
const HEX_4 = /^[0-9a-fA-F]{4}$/;
/*
 * SQN upper bound, matching the server's validation exactly. Without the ceiling the form would
 * accept a value the service rejects with 400, turning a local mistake into a round trip.
 */
const MAX_AUTH_SQN = 9007199254740991;

/*
 * Normalizes a hexadecimal field for transport: trimmed, uppercased, validated.
 *
 * Case is the only transformation - the hexadecimal content itself is never altered, so an
 * operator's value cannot be silently rewritten. The backend re-validates and remains
 * authoritative; this exists so the form reports the problem against the right field instead of
 * round-tripping to a server error.
 */
function normalizeCreateHex(value: string, pattern: RegExp, label: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  if (!pattern.test(trimmed)) {
    throw new Error(`${label} has an invalid format`);
  }
  return trimmed.toUpperCase();
}

export function buildSubscriberCreateRequest(
  imsi: string,
  options?: { planId?: string; msisdn?: string; auth4G?: { k?: string; op?: string; opc?: string; amf?: string; sqn?: number } },
): SubscriberCreatePayload {
  const trimmedImsi = String(imsi || '').trim();
  if (!trimmedImsi) {
    throw new Error('imsi is required');
  }
  const payload: SubscriberCreatePayload = {
    imsi: trimmedImsi,
  };
  if (options?.planId?.trim()) {
    payload.planId = options.planId.trim();
  }
  if (options?.msisdn?.trim()) {
    payload.msisdn = options.msisdn.trim();
  }

  const raw = options?.auth4G;
  if (raw) {
    const hasOp = Boolean(String(raw.op ?? '').trim());
    const hasOpc = Boolean(String(raw.opc ?? '').trim());
    if (hasOp && hasOpc) {
      throw new Error('auth4G must supply exactly one of op or opc, not both');
    }
    if (!hasOp && !hasOpc) {
      throw new Error('auth4G must supply exactly one of op or opc');
    }
    if (
      raw.sqn === undefined ||
      raw.sqn === null ||
      !Number.isInteger(raw.sqn) ||
      raw.sqn < 0 ||
      raw.sqn > MAX_AUTH_SQN
    ) {
      throw new Error(`auth4G.sqn must be an integer between 0 and ${MAX_AUTH_SQN}`);
    }

    const auth: CreateAuth4G = {
      k: normalizeCreateHex(String(raw.k ?? ''), HEX_32, 'K'),
      amf: normalizeCreateHex(String(raw.amf ?? ''), HEX_4, 'AMF'),
      sqn: raw.sqn,
    };
    if (hasOp) {
      auth.op = normalizeCreateHex(String(raw.op), HEX_32, 'OP');
    } else {
      auth.opc = normalizeCreateHex(String(raw.opc), HEX_32, 'OPc');
    }
    payload.auth4G = auth;
  }

  return payload;
}

export function buildSubscriberUpdateRequest(options: {
  msisdn?: string;
  accessRestrictionData?: number;
  ambr?: { downlink?: { value: number; unit: number }; uplink?: { value: number; unit: number } };
}): SubscriberUpdatePayload {
  const sub4G: NonNullable<SubscriberUpdatePayload['sub4G']> = {};
  if (options.msisdn !== undefined) {
    const trimmed = options.msisdn.trim();
    if (trimmed.length > 0) {
      sub4G.msisdnList = [{ msisdn: trimmed }];
    } else {
      sub4G.msisdnList = [];
    }
  }
  if (typeof options.accessRestrictionData === 'number') {
    sub4G.access_restriction_data = options.accessRestrictionData;
  }
  if (options.ambr) {
    sub4G.ambr = options.ambr;
  }
  return {
    sub4G,
  };
}

export function buildProfileApplyRequest(profileName: string): ProfileApplyPayload {
  const trimmed = String(profileName || '').trim();
  if (!trimmed) {
    throw new Error('profileName is required');
  }
  return {
    profileName: trimmed,
  };
}

export function buildTrafficAdjustRequest(options: {
  bucket?: 'data' | 'voice' | 'sms';
  amount?: number;
  reason?: string;
}): TrafficAdjustmentPayload {
  return {
    bucket: options.bucket || 'data',
    amount: options.amount ?? 100,
    reason: options.reason?.trim() || 'Manual adjustment',
  };
}
