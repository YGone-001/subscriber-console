function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type BatchCreatePayload = {
  startImsi: string;
  count: number;
  trafficTotal?: unknown;
  trafficBalance?: unknown;
  smsTotal?: unknown;
  smsBalance?: unknown;
  profileName?: string;
  planId?: string;
  strategy: 'skip' | 'overwrite';
};

export type TrafficAdjustmentMode = 'recharge' | 'set_available' | 'set_total' | 'reset';

export type TrafficAdjustmentPayload = {
  mode: TrafficAdjustmentMode;
  amount?: number;
  value?: number;
  reason?: string;
};

export type PolicyChangePayload = {
  imsiList: string[];
  planId: string;
  status: 'active' | 'suspended';
  resetBalances: boolean;
};

const HEX_32 = /^[0-9a-fA-F]{32}$/;
const HEX_4 = /^[0-9a-fA-F]{4}$/;
const HEX_1_TO_6 = /^[0-9a-fA-F]{1,6}$/;
const SESSION_NAME = /^[A-Za-z0-9_.-]{1,63}$/;

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function finiteNumber(value: unknown): number | null {
  if (isBlank(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateOptionalNonNegativeNumber(value: unknown, field: string): string | null {
  if (isBlank(value)) return null;
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < 0) return `${field} must be a non-negative number`;
  return null;
}

function parseNonNegativeInteger(value: unknown, field: string): ValidationResult<number> {
  const parsed = finiteNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, error: `${field} must be a non-negative integer` };
  }
  return { ok: true, value: parsed };
}

function validateOptionalInteger(value: unknown, field: string, min: number, max: number): string | null {
  if (isBlank(value)) return null;
  const parsed = finiteNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `${field} must be an integer between ${min} and ${max}`;
  }
  return null;
}

function validateAmbr(value: unknown, field: string): string | null {
  if (isBlank(value)) return null;
  const ambr = asRecord(value);

  for (const direction of ['downlink', 'uplink'] as const) {
    const bitrate = asRecord(ambr[direction]);
    const valueError = validateOptionalNonNegativeNumber(bitrate.value, `${field}.${direction}.value`);
    if (valueError) return valueError;
    const unitError = validateOptionalInteger(bitrate.unit, `${field}.${direction}.unit`, 0, 4);
    if (unitError) return unitError;
  }

  return null;
}

function validateSlices(sliceList: unknown): string | null {
  if (isBlank(sliceList)) return null;
  if (!Array.isArray(sliceList)) return 'sub4G.sliceList must be an array';
  if (sliceList.length > 16) return 'sub4G.sliceList cannot contain more than 16 slices';

  for (const [sliceIndex, rawSlice] of sliceList.entries()) {
    const slice = asRecord(rawSlice);
    const sstError = validateOptionalInteger(slice.sst, `sub4G.sliceList[${sliceIndex}].sst`, 1, 255);
    if (sstError) return sstError;

    if (!isBlank(slice.sd) && !HEX_1_TO_6.test(String(slice.sd))) {
      return `sub4G.sliceList[${sliceIndex}].sd must be 1 to 6 hexadecimal characters`;
    }

    const sessions = slice.session_list;
    if (isBlank(sessions)) continue;
    if (!Array.isArray(sessions)) return `sub4G.sliceList[${sliceIndex}].session_list must be an array`;
    if (sessions.length > 32) return `sub4G.sliceList[${sliceIndex}].session_list cannot contain more than 32 sessions`;

    for (const [sessionIndex, rawSession] of sessions.entries()) {
      const session = asRecord(rawSession);
      if (!isBlank(session.name) && !SESSION_NAME.test(String(session.name))) {
        return `session ${sliceIndex + 1}.${sessionIndex + 1} name contains invalid characters`;
      }

      const typeError = validateOptionalInteger(session.type, `session ${sliceIndex + 1}.${sessionIndex + 1}.type`, 1, 5);
      if (typeError) return typeError;

      const qos = asRecord(session.qos);
      const qiError = validateOptionalInteger(qos._5qi ?? qos.index, `session ${sliceIndex + 1}.${sessionIndex + 1}.qos`, 1, 255);
      if (qiError) return qiError;

      const arp = asRecord(qos.arp);
      const priorityError = validateOptionalInteger(
        arp.priorityLevel ?? arp.arpPriority ?? arp.priority_level,
        `session ${sliceIndex + 1}.${sessionIndex + 1}.arp.priority`,
        1,
        15
      );
      if (priorityError) return priorityError;

      const ambrError = validateAmbr(session.ambr, `session ${sliceIndex + 1}.${sessionIndex + 1}.ambr`);
      if (ambrError) return ambrError;
    }
  }

  return null;
}

export function isValidImsi(value: unknown): value is string {
  return typeof value === 'string' && /^\d{15}$/.test(value);
}

export function validateImsi(value: unknown, field = 'IMSI'): ValidationResult<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: `${field} is required` };
  }
  if (!isValidImsi(value)) {
    return { ok: false, error: `${field} must be exactly 15 digits` };
  }
  return { ok: true, value };
}

export function validateBatchCount(value: unknown): ValidationResult<number> {
  const count = finiteNumber(value);
  if (count === null || !Number.isInteger(count) || count < 1 || count > 1000) {
    return { ok: false, error: 'Count must be an integer between 1 and 1000' };
  }
  return { ok: true, value: count };
}

export function validateBatchCreatePayload(body: unknown): ValidationResult<BatchCreatePayload> {
  const payload = asRecord(body);
  const imsi = validateImsi(payload.startImsi, 'startImsi');
  if (!imsi.ok) return imsi;

  const count = validateBatchCount(payload.count);
  if (!count.ok) return count;

  for (const field of ['trafficTotal', 'trafficBalance', 'smsTotal', 'smsBalance']) {
    const error = validateOptionalNonNegativeNumber(payload[field], field);
    if (error) return { ok: false, error };
  }
  if (!isBlank(payload.planId) && !/^[A-Za-z0-9_.-]{1,64}$/.test(String(payload.planId).trim())) {
    return { ok: false, error: 'planId contains invalid characters' };
  }

  return {
    ok: true,
    value: {
      ...payload,
      startImsi: imsi.value,
      count: count.value,
      profileName: isBlank(payload.profileName) ? undefined : String(payload.profileName),
      planId: isBlank(payload.planId) ? undefined : String(payload.planId).trim(),
      strategy: payload.strategy === 'skip' ? 'skip' : 'overwrite',
    },
  };
}

export function validateSubscriberUpdatePayload(body: unknown): ValidationResult<Record<string, unknown>> {
  const payload = asRecord(body);
  const sub4G = asRecord(payload.sub4G);
  const auth4G = asRecord(payload.auth4G);
  const ocsTraffic = asRecord(payload.ocsTraffic);

  if (payload.auth4G !== undefined) {
    if (!isBlank(auth4G.k) && !HEX_32.test(String(auth4G.k))) return { ok: false, error: 'auth4G.k must be 32 hexadecimal characters' };
    if (!isBlank(auth4G.op) && !HEX_32.test(String(auth4G.op))) return { ok: false, error: 'auth4G.op must be 32 hexadecimal characters' };
    if (!isBlank(auth4G.opc) && !HEX_32.test(String(auth4G.opc))) return { ok: false, error: 'auth4G.opc must be 32 hexadecimal characters' };
    if (!isBlank(auth4G.amf) && !HEX_4.test(String(auth4G.amf))) return { ok: false, error: 'auth4G.amf must be 4 hexadecimal characters' };

    const sqnError = validateOptionalInteger(auth4G.sqn, 'auth4G.sqn', 0, Number.MAX_SAFE_INTEGER);
    if (sqnError) return { ok: false, error: sqnError };
  }

  if (payload.sub4G !== undefined) {
    const ardError = validateOptionalInteger(sub4G.access_restriction_data, 'sub4G.access_restriction_data', 0, 255);
    if (ardError) return { ok: false, error: ardError };
    const namError = validateOptionalInteger(sub4G.network_access_mode, 'sub4G.network_access_mode', 0, 2);
    if (namError) return { ok: false, error: namError };
    const ambrError = validateAmbr(sub4G.ambr, 'sub4G.ambr');
    if (ambrError) return { ok: false, error: ambrError };

    if (!isBlank(sub4G.msisdnList)) {
      if (!Array.isArray(sub4G.msisdnList)) return { ok: false, error: 'sub4G.msisdnList must be an array' };
      for (const [index, rawMsisdn] of sub4G.msisdnList.entries()) {
        const msisdn = asRecord(rawMsisdn).msisdn;
        if (!isBlank(msisdn) && !/^\d+$/.test(String(msisdn))) {
          return { ok: false, error: `sub4G.msisdnList[${index}].msisdn must contain digits only` };
        }
      }
    }

    const sliceError = validateSlices(sub4G.sliceList);
    if (sliceError) return { ok: false, error: sliceError };
  }

  if (payload.ocsTraffic !== undefined) {
    if (!isBlank(ocsTraffic.plmn) && !/^\d{5,6}$/.test(String(ocsTraffic.plmn))) {
      return { ok: false, error: 'ocsTraffic.plmn must be 5 or 6 digits' };
    }
    for (const field of ['traffic_total', 'traffic_balance', 'voice_total', 'voice_balance', 'sms_total', 'sms_balance']) {
      const error = validateOptionalNonNegativeNumber(ocsTraffic[field], `ocsTraffic.${field}`);
      if (error) return { ok: false, error };
    }
  }

  return { ok: true, value: payload };
}

export function validateTrafficAdjustmentPayload(body: unknown): ValidationResult<TrafficAdjustmentPayload> {
  const payload = asRecord(body);
  const rawMode = String(payload.mode || '');

  if (!['recharge', 'set_available', 'set_total', 'reset'].includes(rawMode)) {
    return { ok: false, error: 'mode must be one of recharge, set_available, set_total, reset' };
  }
  const mode = rawMode as TrafficAdjustmentMode;

  const reason = isBlank(payload.reason) ? undefined : String(payload.reason).trim();
  if (reason !== undefined && (reason.length === 0 || reason.length > 200)) {
    return { ok: false, error: 'reason must be between 1 and 200 characters' };
  }

  if (mode === 'recharge') {
    const amount = parseNonNegativeInteger(payload.amount, 'amount');
    if (!amount.ok) return amount;
    if (amount.value <= 0) return { ok: false, error: 'amount must be greater than 0' };
    return { ok: true, value: { mode, amount: amount.value, reason } };
  }

  if (mode === 'set_available' || mode === 'set_total') {
    const value = parseNonNegativeInteger(payload.value, 'value');
    if (!value.ok) return value;
    return { ok: true, value: { mode, value: value.value, reason } };
  }

  return { ok: true, value: { mode, reason } };
}

export function validatePolicyChangePayload(body: unknown): ValidationResult<PolicyChangePayload> {
  const payload = asRecord(body);
  const imsiList = validateImsiList(payload.imsiList);
  if (!imsiList.ok) return imsiList;
  if (imsiList.value.length === 0) return { ok: false, error: 'imsiList cannot be empty' };

  const planId = isBlank(payload.planId) ? 'plan_default_10gb' : String(payload.planId).trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(planId)) {
    return { ok: false, error: 'planId contains invalid characters' };
  }

  const status = String(payload.status || 'active');
  if (status !== 'active' && status !== 'suspended') {
    return { ok: false, error: 'status must be active or suspended' };
  }

  return {
    ok: true,
    value: {
      imsiList: imsiList.value,
      planId,
      status,
      resetBalances: payload.resetBalances === true,
    },
  };
}

export function validateImsiList(value: unknown): ValidationResult<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: 'imsiList array is required' };
  if (value.length > 5000) return { ok: false, error: 'imsiList cannot contain more than 5000 entries' };
  const imsis = value.map((item) => String(item).trim()).filter(Boolean);
  const invalid = imsis.find((imsi) => !isValidImsi(imsi));
  if (invalid) return { ok: false, error: `Invalid IMSI in list: ${invalid}` };
  return { ok: true, value: imsis };
}

export function validateImportRecords(value: unknown): ValidationResult<Record<string, unknown>[]> {
  if (!Array.isArray(value)) return { ok: false, error: 'records array is required' };
  if (value.length > 5000) return { ok: false, error: 'records cannot contain more than 5000 entries' };
  return { ok: true, value: value.map((item) => asRecord(item)) };
}
